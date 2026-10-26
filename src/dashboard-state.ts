import type { Artifact, JournalEvent, TaskRecord } from './types.ts';
import { agentIds, boardSnapshot } from './board-types.ts';
import { currentRevision, revisionOf, maxIntelUpdates, backupTestExample } from './intel-updates.ts';

/** Deliberately excludes model contexts, socket capabilities, auth storage, and runtime tokens. */
export function dashboardState(events: JournalEvent[], runtime: {
  runId?: string; busy: boolean; error: string | null; closing: boolean;
  agents: { agent: string; pid?: number; port: number; alive: boolean }[];
}) {
  const board = boardSnapshot(events);
  const config = events.find(event => event.kind === 'run.started')?.data as Record<string, unknown>;
  const artifacts = events.filter(event => event.kind === 'artifact').map(event => event.data as Artifact);
  const revision = currentRevision(events);
  const latestTasks = new Map<string, TaskRecord>();
  for (const event of events) if (event.kind === 'task') latestTasks.set((event.data as TaskRecord).id, event.data as TaskRecord);
  const tasks = [...latestTasks.values()];
  const assessments = Array.from({ length: revision }, (_, index) => {
    const number = index + 1;
    const outputs = artifacts.filter(item => revisionOf(item) === number);
    const report = outputs.find(item => item.kind === 'report');
    const analysis = outputs.find(item => item.kind === 'analysis');
    const review = outputs.find(item => item.kind === 'review');
    const event = events.find(item => item.kind === 'intel.revision' && (item.data as { revision: number }).revision === number);
    const state = number < revision ? 'superseded' : report && board.settled ? 'complete' : 'pending';
    return { revision: number, state, receivedAt: event?.at ?? events[0]?.at, analysis, review, report,
      affectedClaims: (event?.data as { changedClaims?: string[] })?.changedClaims ?? [],
      tasks: tasks.filter(task => revisionOf(task) === number).map(task => ({ id: task.id, owner: task.owner, status: task.status })) };
  });
  const agents = agentIds.map(agent => {
    const state = board.agents.find(item => item.agent === agent);
    const peer = runtime.agents.find(item => item.agent === agent);
    const turn = events.findLast(event => event.kind === 'board.turn' && (event.data as any).agent === agent)?.data as any;
    const pendingTurn = turn && !events.some(event => event.kind === 'board.applied' && (event.data as any).turnId === turn.id);
    const task = tasks.find(item => item.owner === agent && item.status === 'running');
    const helper = board.subagents.find(item => item.parent === agent && item.status === 'pending');
    const phase = runtime.closing || !peer?.alive ? 'stopped' : runtime.error && pendingTurn ? 'blocked'
      : helper ? 'waiting for helper' : task ? 'working' : pendingTurn && runtime.busy ? 'thinking' : 'waiting';
    return { agent, phase, pid: peer?.pid, port: peer?.port, status: state?.status ?? 'Discovering subjects.',
      subscriptions: state?.subscriptions ?? [], knownEvidence: state?.knownRefs.length ?? 0,
      revision: state?.seenRevision ?? 1, helpers: board.subagents.filter(item => item.parent === agent) };
  });
  const timeline: { seq: number; at: string; type: string; actor: string; subject?: string; text: string }[] = [];
  for (const event of events) {
    const item = event.data as any;
    let activity: Omit<typeof timeline[number], 'seq' | 'at'> | undefined;
    if (event.kind === 'board.update') activity = { type: 'publication', actor: item.author, subject: item.topicId, text: item.text };
    if (event.kind === 'board.direct') activity = { type: 'direct message', actor: item.from, subject: item.topicId, text: 'To ' + item.to + ': ' + item.text };
    if (event.kind === 'board.decision') activity = { type: 'decision', actor: item.agent, text: item.decision.status + ' ' + item.decision.reason };
    if (event.kind === 'intel.revision') activity = { type: 'new intelligence', actor: 'operator', text: 'Revision ' + item.revision + ' requested; affected claims: ' + item.changedClaims.join(', ') };
    if (event.kind === 'subagent.requested') activity = { type: 'helper requested', actor: item.parent, text: item.name + ': ' + item.task };
    if (['subagent.completed', 'subagent.failed'].includes(event.kind)) activity = { type: event.kind.endsWith('completed') ? 'helper completed' : 'helper failed',
      actor: board.subagents.find(child => child.id === item.id)?.parent ?? 'helper', text: item.id + (item.error ? ': ' + item.error : '') };
    if (event.kind === 'result.accepted') activity = { type: 'work completed', actor: tasks.find(task => task.id === item.taskId)?.owner ?? 'worker', text: item.summary };
    if (['attempt.failed', 'board.attempt.failed'].includes(event.kind)) activity = { type: 'error', actor: item.agent ?? tasks.find(task => task.id === item.taskId)?.owner ?? 'supervisor', text: item.error };
    if (activity) timeline.push({ seq: event.seq, at: event.at, ...activity });
  }
  return {
    runId: runtime.runId, scenario: String(config?.scenario ?? 'inventory'), worker: String(config?.workerLabel ?? 'unknown'),
    busy: runtime.busy, error: runtime.error, closing: runtime.closing, settled: board.settled, revision,
    lastSequence: events.at(-1)?.seq ?? 0, agents, assessments, example: backupTestExample,
    topics: board.topics.map(topic => ({ ...topic, subscribers: agents.filter(agent => agent.subscriptions.some(sub => sub.topicId === topic.id)).map(agent => agent.agent),
      publications: board.updates.filter(post => post.topicId === topic.id) })),
    messages: board.directMessages, helpers: board.subagents,
    sources: artifacts.filter(item => ['fixture', 'intel-source', 'intel-update'].includes(item.kind)),
    timeline: timeline.slice(-120).reverse(),
    counts: { decisions: board.decisions.length, work: events.filter(event => event.kind === 'result.accepted').length,
      messages: board.directMessages.length, helpers: board.subagents.length,
      updates: artifacts.filter(item => item.kind === 'intel-update').length, maxUpdates: maxIntelUpdates },
  };
}
