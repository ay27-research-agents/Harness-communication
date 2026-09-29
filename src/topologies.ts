import { Kernel } from './kernel.ts';
import type { Artifact, Stage, WorkerId } from './types.ts';
import { TopicBoard } from './board.ts';
import type { BoardOptions } from './board.ts';

const workers: Record<Stage, WorkerId> = {
  analyze: 'analyst', review: 'reviewer', report: 'reporter',
};
const taskIds: Record<Stage, string> = {
  analyze: 'analysis', review: 'review', report: 'report',
};
const objectives: Record<Stage, string> = {
  analyze: 'Compare the supplied offline expected and observed inventory.',
  review: 'Check the structured inventory findings against the supplied fixture.',
  report: 'Summarize the reviewed inventory discrepancies with evidence references.',
};

function storedOutput(kernel: Kernel, taskId: string, stage: Stage): Artifact | undefined {
  const artifactId = kernel.task(taskId).outputs[stage];
  if (!artifactId) return undefined;
  const artifact = kernel.artifacts.find(candidate => candidate.id === artifactId);
  if (!artifact) throw new Error(`Missing stored ${stage} artifact ${artifactId}`);
  return artifact;
}

function refs(artifacts: Artifact[]): string[] { return artifacts.map(artifact => artifact.id); }

async function coordinator(kernel: Kernel): Promise<void> {
  const inputs = [kernel.fixture];
  for (const stage of ['analyze', 'review', 'report'] as const) {
    const owner = workers[stage];
    const taskId = taskIds[stage];
    kernel.ensureTask(taskId, owner, objectives[stage]);
    const assignment = kernel.send('coordinator', owner, 'task.assigned', taskId, refs(inputs),
      { stage }, { dedupeKey: `coordinator:${stage}:assignment` });
    const output = await kernel.execute(stage, taskId, owner, inputs, true);
    kernel.send(owner, 'coordinator', 'task.result', taskId, [output.id], { stage }, {
      dedupeKey: `coordinator:${stage}:result`, correlationId: assignment.messageId,
      causationId: assignment.messageId,
    });
    inputs.push(output);
  }
}

async function routed(kernel: Kernel): Promise<void> {
  // The graph has eight messages and three worker calls; no worker can extend the route.
  const fixture = kernel.fixture;
  kernel.ensureTask('analysis', 'analyst', objectives.analyze);
  const start = kernel.send('router', 'analyst', 'task.assigned', 'analysis', [fixture.id],
    { stage: 'analyze' }, { dedupeKey: 'routed:analysis:assignment' });
  const analysis = await kernel.execute('analyze', 'analysis', 'analyst', [fixture], true);
  const request = kernel.send('analyst', 'router', 'subtask.requested', 'analysis', [analysis.id],
    { recipient: 'reviewer', intent: 'verify_findings', hop: 1 }, {
      dedupeKey: 'routed:review:request', causationId: start.messageId, correlationId: start.messageId,
    });
  kernel.ensureTask('review', 'reviewer', objectives.review);
  const reviewAssignment = kernel.send('router', 'reviewer', 'task.assigned', 'review',
    [fixture.id, analysis.id], { stage: 'review', parentTaskId: 'analysis', hop: 2 }, {
      dedupeKey: 'routed:review:assignment', causationId: request.messageId, correlationId: start.messageId,
    });
  const review = await kernel.execute('review', 'review', 'reviewer', [fixture, analysis], true);
  const reply = kernel.send('reviewer', 'router', 'conversation.reply', 'review', [review.id],
    { recipient: 'analyst', intent: 'review_result', hop: 3 }, {
      dedupeKey: 'routed:review:reply', causationId: reviewAssignment.messageId, correlationId: start.messageId,
    });
  const delivered = kernel.send('router', 'analyst', 'conversation.reply', 'analysis', [review.id],
    { originalSender: 'reviewer', originalMessageId: reply.messageId, hop: 4 }, {
      dedupeKey: 'routed:review:forward', causationId: reply.messageId, correlationId: start.messageId,
    });
  const reportRequest = kernel.send('analyst', 'router', 'subtask.requested', 'analysis', [analysis.id, review.id],
    { recipient: 'reporter', intent: 'summarize_reviewed_findings', hop: 5 }, {
      dedupeKey: 'routed:report:request', causationId: delivered.messageId, correlationId: start.messageId,
    });
  kernel.ensureTask('report', 'reporter', objectives.report);
  const reportAssignment = kernel.send('router', 'reporter', 'task.assigned', 'report',
    [fixture.id, analysis.id, review.id], { stage: 'report', parentTaskId: 'analysis', hop: 6 }, {
      dedupeKey: 'routed:report:assignment', causationId: reportRequest.messageId, correlationId: start.messageId,
    });
  const report = await kernel.execute('report', 'report', 'reporter', [fixture, analysis, review], true);
  kernel.send('reporter', 'router', 'task.result', 'report', [report.id], { hop: 7 }, {
    dedupeKey: 'routed:report:result', causationId: reportAssignment.messageId, correlationId: start.messageId,
  });
}

function transfer(
  kernel: Kernel, id: string, from: WorkerId, to: WorkerId, artifacts: Artifact[],
): void {
  const task = kernel.task('workflow');
  if (task.owner !== from && task.owner !== to) {
    throw new Error(`Cannot resume handoff ${id} from current owner ${task.owner}`);
  }
  const request = kernel.send(from, 'controller', 'handoff.requested', 'workflow', refs(artifacts),
    { to }, { dedupeKey: `${id}:request` });
  let handoff = kernel.handoff(id) ?? kernel.offerHandoff(id, 'workflow', to, refs(artifacts));
  const offer = kernel.send('controller', to, 'handoff.offered', 'workflow', [handoff.packageRef],
    { handoffId: id, from, to, expectedEpoch: handoff.expectedEpoch }, {
      dedupeKey: `${id}:offer`, causationId: request.messageId, correlationId: request.messageId,
    });
  if (handoff.status === 'offered') {
    kernel.send(to, 'controller', 'handoff.accepted', 'workflow', [handoff.packageRef],
      { handoffId: id }, {
        dedupeKey: `${id}:accept`, causationId: offer.messageId, correlationId: request.messageId,
      });
    kernel.acceptHandoff(id, to);
    handoff = kernel.handoff(id)!;
  }
  if (handoff.status === 'accepted') kernel.commitHandoff(id);
  if (kernel.handoff(id)?.status !== 'committed' || kernel.task('workflow').owner !== to) {
    throw new Error(`Handoff ${id} did not commit to ${to}`);
  }
  kernel.send('controller', to, 'handoff.committed', 'workflow', [handoff.packageRef],
    { handoffId: id, owner: to }, {
      dedupeKey: `${id}:committed`, causationId: offer.messageId, correlationId: request.messageId,
    });
}

async function handoff(kernel: Kernel): Promise<void> {
  kernel.ensureTask('workflow', 'analyst', 'Compare, review, and report the supplied offline inventory.');
  const fixture = kernel.fixture;
  let analysis = storedOutput(kernel, 'workflow', 'analyze');
  if (!analysis) {
    kernel.send('controller', 'analyst', 'task.assigned', 'workflow', [fixture.id],
      { stage: 'analyze' }, { dedupeKey: 'handoff:initial-assignment' });
    analysis = await kernel.execute('analyze', 'workflow', 'analyst', [fixture], false);
  }
  kernel.send('analyst', 'controller', 'stage.completed', 'workflow', [analysis.id],
    { stage: 'analyze' }, { dedupeKey: 'handoff:analysis:result' });

  let review = storedOutput(kernel, 'workflow', 'review');
  if (!review) {
    transfer(kernel, 'handoff:analysis-to-review', 'analyst', 'reviewer', [fixture, analysis]);
    review = await kernel.execute('review', 'workflow', 'reviewer', [fixture, analysis], false);
  }
  kernel.send('reviewer', 'controller', 'stage.completed', 'workflow', [review.id],
    { stage: 'review' }, { dedupeKey: 'handoff:review:result' });

  let report = storedOutput(kernel, 'workflow', 'report');
  if (!report) {
    transfer(kernel, 'handoff:review-to-report', 'reviewer', 'reporter', [fixture, analysis, review]);
    report = await kernel.execute('report', 'workflow', 'reporter', [fixture, analysis, review], true);
  }
  kernel.send('reporter', 'controller', 'task.result', 'workflow', [report.id],
    { stage: 'report' }, { dedupeKey: 'handoff:report:result' });
}

/** Run a communication experiment over the same supplied inventory. */
export async function runTopology(kernel: Kernel, boardOptions: BoardOptions = {}): Promise<void> {
  const completed = `topology:${kernel.topology}:complete`;
  if (kernel.topology === 'pubsub' && kernel.pubsubVersion === 2) {
    await new TopicBoard(kernel, boardOptions).run();
    kernel.receipt(completed);
    return;
  }
  if (kernel.hasReceipt(completed)) return;
  if (kernel.topology === 'coordinator') await coordinator(kernel);
  else if (kernel.topology === 'pubsub') throw new Error('This unfinished run uses the retired fixed pub/sub protocol. Start a new pubsub run.');
  else if (kernel.topology === 'routed') await routed(kernel);
  else if (kernel.topology === 'handoff') await handoff(kernel);
  else throw new Error(`Unknown topology ${String(kernel.topology)}`);
  kernel.receipt(completed);
}
