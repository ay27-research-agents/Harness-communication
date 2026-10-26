import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kernel } from '../src/kernel.ts';
import { TopicBoard, validateDecision } from '../src/board.ts';
import { scriptedBoardDecider } from '../src/board-policy.ts';
import type { BoardContext, BoardDecision } from '../src/board-types.ts';
import { scriptedWorker } from '../src/workers.ts';

test('a private inbox wakes only its recipient and does not require a topic subscription', async () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  const seen: BoardContext[] = [];
  const board = new TopicBoard(kernel, { decide: request => {
    seen.push(request.context);
    return scriptedBoardDecider(request);
  } });
  await board.run();
  seen.length = 0;
  const message = board.direct('reporter', 'Private observation about the finished report.');
  await board.run();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agent, 'reporter');
  assert.equal(seen[0].directInbox?.[0].id, message.id);
  assert.equal(kernel.hasReceipt('direct:reporter:' + message.id), true);
  await board.run();
  assert.equal(seen.length, 1);
  assert.throws(() => board.direct('stranger' as any, 'x'), /Unknown/);
  assert.throws(() => board.direct('analyst', 'x', 'missing'), /Unknown/);
});

test('private actions reject unknown peers, self sends, invented evidence, and forged replies', async () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  let context: BoardContext | undefined;
  const board = new TopicBoard(kernel, { decide: request => { context ??= request.context; return scriptedBoardDecider(request); } });
  await board.run();
  const decision = (await scriptedBoardDecider({ context: context! })).data as BoardDecision;
  const base = { to: 'reviewer', text: 'x', evidenceRefs: [] };
  for (const message of [{ ...base, to: 'nobody' }, { ...base, to: 'analyst' }, { ...base, evidenceRefs: [kernel.fixture.id] }, { ...base, replyTo: 'invented' }]) {
    assert.throws(() => validateDecision({ ...decision, directMessages: [message] }, context!));
  }
});

test('committed outbox recovers from delivery failure without repeating the decision or processing twice', async () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  let failed = false, calls = 0;
  const decide = async (request: Parameters<typeof scriptedBoardDecider>[0]) => { calls++; return scriptedBoardDecider(request); };
  let board = new TopicBoard(kernel, { decide, sendDirect: async () => { failed = true; throw new Error('Disconnected peer'); } });
  await assert.rejects(board.run(), /Disconnected peer/);
  assert.equal(failed, true);
  assert.equal(board.snapshot.directMessages.length, 1);
  const committedTurns = kernel.events.filter(event => event.kind === 'board.decision').length;
  assert.equal(committedTurns, calls);
  board = new TopicBoard(kernel, { decide, sendDirect: async message => {
    board.receiveDirect(message, { mode: 'socket' });
    board.receiveDirect(message, { mode: 'socket' }); // Retry after ambiguous acknowledgement.
  } });
  await board.run();
  assert.equal(kernel.report().success, true);
  assert.equal(board.snapshot.directMessages.length, 2);
  assert.equal(kernel.events.filter(event => event.kind === 'board.direct.received').length, 2);
  assert.equal(calls, kernel.events.filter(event => event.kind === 'board.decision').length);
  const contexts = kernel.events.filter(event => event.kind === 'board.turn').map(event => (event.data as any).context as BoardContext);
  for (const message of board.snapshot.directMessages) {
    const readers = contexts.filter(context => context.directInbox?.some(item => item.id === message.id));
    assert.deepEqual(readers.map(context => context.agent), [message.to]);
  }
  assert.ok(board.snapshot.updates.some(post => post.author === 'reviewer' && post.topicId === 'inventory-findings'));
});

test('supervisor shutdown stops retries and late decisions without exhausting the remaining budget', async () => {
  const controller = new AbortController();
  const kernel = new Kernel({ topology: 'pubsub' });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const board = new TopicBoard(kernel, { signal: controller.signal, decide: async () => {
    started();
    return new Promise(() => {}); // Deliberately ignores cancellation.
  } });
  const pending = board.run();
  await entered;
  controller.abort();
  await assert.rejects(pending, /Supervisor stopped/);
  assert.equal(kernel.events.filter(event => event.kind === 'board.attempt.started').length, 1);
  await new TopicBoard(kernel).run();
  assert.equal(kernel.report().success, true);
});

test('shutdown during inventory work preserves one remaining retry for recovery', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const kernel = new Kernel({ topology: 'pubsub', signal: controller.signal, worker: async () => {
    started();
    return new Promise(() => {});
  } });
  const pending = new TopicBoard(kernel, { signal: controller.signal }).run();
  await entered;
  controller.abort();
  await assert.rejects(pending, /Supervisor stopped/);
  assert.equal(kernel.report().metrics.workerCalls, 1);
  const recovered = new Kernel({ journal: kernel.journal, runId: kernel.runId, worker: scriptedWorker });
  await new TopicBoard(recovered).run();
  assert.equal(recovered.report().success, true);
  assert.equal(recovered.report().metrics.workerCalls, 4);
});
