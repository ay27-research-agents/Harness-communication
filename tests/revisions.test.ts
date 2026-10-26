import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kernel } from '../src/kernel.ts';
import { TopicBoard } from '../src/board.ts';
import { MemoryJournal } from '../src/store.ts';
import { scriptedWorker } from '../src/workers.ts';
import { scriptedBoardDecider } from '../src/board-policy.ts';
import { backupTestExample, revisionOf, validateIntelUpdate } from '../src/intel-updates.ts';
import { dashboardState } from '../src/dashboard-state.ts';
import type { BoardContext, BoardDecision } from '../src/board-types.ts';

const output = (kernel: Kernel, kind: string): any => kernel.currentArtifacts.find(item => item.kind === kind)?.data;
const claim = (kernel: Kernel, id: string) => output(kernel, 'analysis').claims.find((item: any) => item.id === id).status;
async function ready() {
  const kernel = new Kernel({ topology: 'pubsub', scenario: 'intel', subagentLimit: 0 });
  const board = new TopicBoard(kernel); await board.run(); return { kernel, board };
}
test('new source invalidates completion, revises the affected conclusion, and preserves all earlier outputs', async () => {
  const { kernel, board } = await ready();
  const original = structuredClone(kernel.artifacts.filter(item => ['analysis', 'review', 'report'].includes(item.kind)));
  assert.equal(claim(kernel, 'backup-ready'), 'unresolved');
  const receipt = board.inject(backupTestExample);
  assert.equal(receipt.revision, 2);
  assert.equal(kernel.report().success, false, 'old completed assessment cannot pass as current');
  assert.equal(kernel.currentArtifacts.some(item => item.kind === 'report'), false);
  await board.run();
  assert.equal(kernel.report().success, true);
  assert.equal(claim(kernel, 'backup-ready'), 'confirmed');
  assert.equal(output(kernel, 'report').recommendation, 'hold');
  assert.deepEqual(output(kernel, 'report').unresolvedQuestions, []);
  for (const artifact of original) assert.deepEqual(kernel.artifacts.find(item => item.id === artifact.id), artifact);
  assert.equal(kernel.artifacts.filter(item => item.kind === 'report').length, 2);
  for (const event of kernel.events.filter(item => item.kind === 'board.turn')) {
    const context = (event.data as { context: BoardContext }).context;
    for (const own of context.ownWork) {
      assert.equal(Object.hasOwn(own, 'data'), false, 'result bodies must not be duplicated in the decision prompt');
      assert.ok(context.evidence.some(item => item.id === own.id && item.data));
    }
  }
  assert.equal(kernel.report().metrics.workerCalls, 6);
  const latest = kernel.events.filter(item => item.kind === 'context' && (item.data as any).context.assessment.revision === 2);
  assert.equal(latest.length, 3);
  assert.ok(latest.every(item => (item.data as any).context.inputs.some((input: any) => input.id === receipt.artifactRef)));
  assert.ok(latest.every(item => (item.data as any).context.inputs.filter((input: any) => ['analysis', 'review', 'report'].includes(input.kind)).every((input: any) => input.revision === 2)));
});
test('source delivery remains scoped to subscriptions; unseen new evidence cannot unlock work', async () => {
  const { kernel, board } = await ready();
  board.post('restricted-source', 'New subject for a source.', { id: 'restricted-source', title: 'Restricted source', description: 'Additional documents.' });
  const added = board.inject(backupTestExample, 'restricted-source');
  const contexts: BoardContext[] = [];
  const blocked = new TopicBoard(kernel, { allowIdle: true, decide: async request => {
    contexts.push(request.context);
    const response = await scriptedBoardDecider(request);
    const decision = response.data as BoardDecision;
    decision.subscriptions = decision.subscriptions.filter(item => item.topicId !== 'restricted-source');
    return response;
  } });
  await blocked.run();
  assert.equal(kernel.report().success, false);
  assert.ok(contexts.every(context => !context.evidence.some(item => item.id === added.artifactRef) && context.availableWork === null));
  // Explicitly share the original source reference through a normal subscribed subject.
  kernel.record('board.update', { id: 'forward-new-source', topicId: 'intel-brief', author: 'user',
    text: 'The source is now shared on the intelligence brief.', evidenceRefs: [added.artifactRef], createdAt: new Date().toISOString() });
  await board.run();
  assert.equal(kernel.report().success, true);
});
test('late old observations and unverified claims do not override current direct evidence; ties remain unresolved', async () => {
  const { kernel, board } = await ready();
  board.inject(backupTestExample); await board.run();
  board.inject({ ...backupTestExample, sourceId: 'late-old-test', observedAt: '2026-10-08T09:00:00Z', recordedAt: '2026-10-08T12:00:00Z',
    claims: [{ id: 'backup-ready', status: 'refuted' }] });
  await board.run(); assert.equal(claim(kernel, 'backup-ready'), 'confirmed');
  board.inject({ ...backupTestExample, sourceId: 'new-rumor', reliability: 'unverified', observedAt: '2026-10-08T12:10:00Z', recordedAt: '2026-10-08T12:20:00Z',
    claims: [{ id: 'backup-ready', status: 'refuted' }] });
  await board.run(); assert.equal(claim(kernel, 'backup-ready'), 'confirmed');
  board.inject({ ...backupTestExample, sourceId: 'conflicting-witness', claims: [{ id: 'backup-ready', status: 'refuted' }] });
  await board.run();
  assert.equal(kernel.report().success, true);
  assert.equal(claim(kernel, 'backup-ready'), 'unresolved');
  assert.deepEqual(output(kernel, 'report').unresolvedQuestions, ['backup-ready']);
  assert.throws(() => board.inject({ ...backupTestExample, sourceId: 'over-budget' }), /budget exhausted/);
});
test('new intelligence arriving during a model stage cannot make its old result current', async () => {
  let kernel: Kernel, board: TopicBoard, injected = false;
  kernel = new Kernel({ topology: 'pubsub', scenario: 'intel', subagentLimit: 0, worker: async request => {
    if (request.stage === 'analyze' && !injected) {
      injected = true;
      board.inject(backupTestExample);
    }
    return scriptedWorker(request);
  } });
  board = new TopicBoard(kernel);
  await board.run();
  assert.equal(kernel.report().success, true);
  const old = kernel.artifacts.find(item => item.kind === 'analysis' && revisionOf(item) === 1)!;
  assert.equal((old.data as any).claims.find((item: any) => item.id === 'backup-ready').status, 'unresolved');
  assert.equal(claim(kernel, 'backup-ready'), 'confirmed');
  assert.equal(kernel.currentArtifacts.some(item => item.id === old.id), false);
  assert.ok(kernel.currentTasks.every(task => task.revision === 2));
});
test('intelligence commit is idempotent, conflict checked, durable, and completed revisions replay without calls', async () => {
  const journal = new MemoryJournal();
  const kernel = new Kernel({ journal, topology: 'pubsub', scenario: 'intel', subagentLimit: 0 });
  const board = new TopicBoard(kernel); await board.run();
  const added = board.inject(backupTestExample);
  const count = kernel.events.length;
  assert.equal(board.inject(backupTestExample).duplicate, true);
  assert.equal(kernel.events.length, count);
  assert.throws(() => board.inject({ ...backupTestExample, title: 'Different document under same ID' }), /Conflicting/);
  const resumed = new Kernel({ journal, runId: kernel.runId });
  await new TopicBoard(resumed).run();
  assert.equal(resumed.revision, added.revision); assert.equal(resumed.report().success, true);
  const complete = resumed.events.length;
  await new TopicBoard(new Kernel({ journal, runId: kernel.runId })).run();
  assert.equal(resumed.events.length, complete);
});
test('malformed or oversized sources fail before any journal changes and ordinary notes do not revise evidence', async () => {
  const { kernel, board } = await ready();
  const before = kernel.events.length;
  for (const change of [
    { sourceId: '../escape' }, { sourceId: 'con' }, { observedAt: '2026-02-30T09:00:00Z' },
    { observedAt: '2026-10-09T09:00:00Z' }, { reliability: 'trust-me' }, { observations: 'x'.repeat(2001) },
    { claims: [{ id: 'unknown', status: 'confirmed' }] }, { extra: true },
  ]) assert.throws(() => board.inject({ ...backupTestExample, ...change }), /Intelligence source/);
  assert.equal(kernel.events.length, before);
  assert.throws(() => board.inject({ ...backupTestExample, sourceId: 'current-log' }), /Conflicting/);
  assert.throws(() => board.inject(backupTestExample, 'missing-topic'), /Unknown intelligence subject/);
  board.post('intel-brief', 'The backup is ready! This is only a note.');
  await board.run();
  assert.equal(kernel.revision, 1); assert.equal(claim(kernel, 'backup-ready'), 'unresolved');
  assert.deepEqual(validateIntelUpdate(JSON.parse(JSON.stringify(backupTestExample))), backupTestExample);
});
test('dashboard projects pending and superseded assessments without leaking prompts or capabilities', async () => {
  const { kernel, board } = await ready();
  const snapshot = () => dashboardState(kernel.events, { runId: kernel.runId, busy: false, error: null, closing: false,
    agents: ['analyst', 'reviewer', 'reporter'].map(agent => ({ agent, alive: true, port: 1, pid: 100 })) });
  assert.equal(snapshot().assessments[0]!.state, 'complete');
  board.inject(backupTestExample);
  assert.equal(snapshot().assessments[0]!.state, 'superseded');
  assert.equal(snapshot().assessments[1]!.state, 'pending');
  assert.equal(snapshot().assessments[1]!.report, undefined);
  await board.run();
  const state = snapshot();
  assert.equal(state.assessments[1]!.state, 'complete');
  assert.ok(state.agents.every(agent => agent.phase === 'waiting'));
  assert.ok(state.timeline.some(event => event.type === 'new intelligence'));
  assert.equal(Object.hasOwn(state, 'events'), false);
  assert.equal(Object.hasOwn(state, 'token'), false);
});
