import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { Kernel } from '../src/kernel.ts';
import { MemoryJournal } from '../src/store.ts';
import { runTopology } from '../src/topologies.ts';
import { TopicBoard, validateDecision } from '../src/board.ts';
import { scriptedBoardDecider } from '../src/board-policy.ts';
import type { BoardContext, BoardDecision, BoardDecider, BoardUpdate } from '../src/board-types.ts';

const waitDecision = (subscriptions: BoardDecision['subscriptions'] = []): BoardDecision => ({
  subscriptions, status: 'Observing.', reason: 'I choose to wait.', createTopics: [], publish: [], work: null,
});

test('agents discover new subjects and receive bodies only after choosing a subscription', async () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  const requests: BoardContext[] = [];
  const decide: BoardDecider = request => {
    requests.push(structuredClone(request.context));
    return scriptedBoardDecider(request);
  };
  await runTopology(kernel, { decide });
  assert.equal(kernel.report().success, true);
  assert.equal(kernel.events.some(event => event.kind === 'delivery'), false);
  for (const first of ['analyst', 'reviewer', 'reporter']) {
    const context = requests.find(request => request.agent === first)!;
    assert.equal(context.inbox.length, 0);
    assert.equal(context.evidence.length, 0);
    assert.ok(context.catalog.some(topic => topic.id === 'announcements'));
  }
  assert.ok(requests.every(context => context.inbox.every(update => context.subscriptions.some(sub => sub.topicId === update.topicId))));
  assert.ok(requests.every(context => context.inbox.every(update => update.topicId !== 'announcements')));
  assert.ok(requests.some(context => context.agent === 'reviewer' && context.availableWork === 'review'));
  assert.ok(kernel.report().board!.decisions.some(turn => turn.agent === 'reviewer' && turn.decision.subscriptions.some(sub => sub.topicId === 'inventory-findings')));
});

test('an agent may refuse every subject; the broker never forces a next-stage assignment', async () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  await assert.rejects(runTopology(kernel, { decide: async () => ({ data: waitDecision(), summary: 'Wait.' }) }), /Agents are idle/);
  assert.equal(kernel.report().metrics.workerCalls, 0);
  assert.equal(kernel.tasks.length, 0);
  assert.equal(kernel.report().metrics.decisionCalls, 3);
});

test('an agent can select an arbitrary subject and publish progress without performing a stage', async () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  const seen: BoardContext[] = [];
  const decide: BoardDecider = async ({ context }) => {
    seen.push(context);
    const decision = waitDecision(context.agent === 'reviewer' ? [{ topicId: 'announcements', reason: 'I choose to follow this subject.' }] : []);
    if (context.agent === 'reviewer' && context.inbox.length) {
      decision.createTopics = [{ id: 'reviewer-notes', title: 'Reviewer notes', description: 'My current observations.' }];
      decision.publish = [{ topicId: 'reviewer-notes', text: 'I read the announcement and am deciding what to investigate in the supplied records.', evidenceRefs: [] }];
    }
    return { data: decision, summary: decision.reason };
  };
  await assert.rejects(runTopology(kernel, { decide }), /Agents are idle/);
  assert.ok(seen.some(context => context.agent === 'reviewer' && context.inbox.some(post => post.id === 'seed-announcement')));
  assert.equal(kernel.report().board!.updates.find(update => update.author === 'reviewer')!.topicId, 'reviewer-notes');
  assert.equal(kernel.report().metrics.workerCalls, 0);
});

test('unsubscribe suppresses delivery; resubscribe catches up exactly once using its retained cursor', async () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  await runTopology(kernel);
  const board = new TopicBoard(kernel);
  const first = board.post('inventory', 'First follow-up.');
  let dropInventory = true;
  const received: string[] = [];
  const decide: BoardDecider = async request => {
    const response = await scriptedBoardDecider(request);
    const decision = response.data as BoardDecision;
    if (request.context.agent === 'analyst') {
      received.push(...request.context.inbox.map(update => update.id));
      if (dropInventory) decision.subscriptions = decision.subscriptions.filter(sub => sub.topicId !== 'inventory');
    }
    return response;
  };
  await runTopology(kernel, { decide });
  const second = board.post('inventory', 'Second follow-up while unsubscribed.');
  await runTopology(kernel, { decide });
  assert.equal(received.includes(second.id), false);
  dropInventory = false;
  board.post('new-topic', 'A new subject causes catalog discovery.', { id: 'new-topic', title: 'New topic', description: 'An unrelated new topic.' });
  await runTopology(kernel, { decide });
  assert.equal(received.filter(id => id === first.id).length, 1);
  assert.equal(received.filter(id => id === second.id).length, 1);
});

test('topic and evidence validation reject path injection, hidden evidence and unavailable work', async () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  let context: BoardContext | undefined;
  await assert.rejects(runTopology(kernel, { decide: async request => { context ??= request.context; return { data: waitDecision(), summary: 'Wait.' }; } }), /Agents are idle/);
  assert.throws(() => validateDecision({ ...waitDecision(), createTopics: [{ id: '../outside', title: 'x', description: 'x' }] }, context!), /Topic ID/);
  assert.throws(() => validateDecision({ ...waitDecision(), work: 'analyze' }, context!), /unavailable/);
  assert.throws(() => validateDecision({ ...waitDecision(), publish: [{ topicId: 'inventory', text: 'Claim', evidenceRefs: [kernel.fixture.id] }] }, context!), /unavailable evidence/);
  assert.throws(() => validateDecision({ ...waitDecision(), subscriptions: [{ topicId: 'missing', reason: 'x' }] }, context!), /unknown topic/);
});

test('an accepted decision survives a restart without asking the agent a second time', async () => {
  const journal = new MemoryJournal();
  const kernel = new Kernel({ topology: 'pubsub', journal, runId: 'decision-replay' });
  const append = journal.append.bind(journal);
  let decisions = 0;
  const decide: BoardDecider = request => { decisions++; return scriptedBoardDecider(request); };
  journal.append = (...args) => {
    const result = append(...args);
    if (args[1].some(change => change.kind === 'board.decision')) throw new Error('Restart after decision commit');
    return result;
  };
  await assert.rejects(runTopology(kernel, { decide }), /Restart after decision/);
  assert.equal(decisions, 1);
  journal.append = append;
  const resumed = new Kernel({ topology: 'pubsub', journal, runId: kernel.runId });
  await runTopology(resumed, { decide });
  assert.equal(decisions, resumed.report().metrics.decisionCalls);
  assert.equal(resumed.report().metrics.decisionFailures, 0);
  assert.equal(resumed.report().success, true);
});

test('interrupted decision attempts consume the persisted retry budget', async () => {
  const journal = new MemoryJournal();
  const kernel = new Kernel({ topology: 'pubsub', journal, runId: 'decision-interrupted', maxAttempts: 1 });
  const append = journal.append.bind(journal);
  journal.append = (...args) => {
    const result = append(...args);
    if (args[1].some(change => change.kind === 'board.attempt.started')) throw new Error('Interrupted before response');
    return result;
  };
  await assert.rejects(runTopology(kernel), /Interrupted/);
  journal.append = append;
  const resumed = new Kernel({ topology: 'pubsub', journal, runId: kernel.runId });
  await assert.rejects(runTopology(resumed), /Decision attempt budget exhausted/);
  assert.equal(resumed.report().metrics.decisionCalls, 1);
  assert.equal(resumed.report().metrics.decisionFailures, 1);
});

test('a timed-out decision cannot publish a late response', async () => {
  const kernel = new Kernel({ topology: 'pubsub', timeoutMs: 5, maxAttempts: 1 });
  let respond!: (value: { data: BoardDecision; summary: string }) => void;
  await assert.rejects(runTopology(kernel, { decide: () => new Promise(resolve => { respond = resolve; }) }), /deadline exceeded/);
  const count = kernel.events.length;
  respond({ data: { ...waitDecision(), publish: [{ topicId: 'announcements', text: 'Late', evidenceRefs: [] }] }, summary: 'Late' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(kernel.events.length, count);
  assert.equal(kernel.report().board!.updates.length, 2);
});

test('rejected decisions preserve actual usage and exhaust attempts without publishing', async () => {
  const kernel = new Kernel({ topology: 'pubsub', maxAttempts: 2 });
  await assert.rejects(runTopology(kernel, { decide: async () => ({ data: {}, summary: 'Invalid', usage: { input: 7, output: 3 } }) }), /missing or unknown/);
  assert.equal(kernel.report().metrics.decisionCalls, 2);
  assert.equal(kernel.report().metrics.inputTokens, 14);
  assert.equal(kernel.report().metrics.outputTokens, 6);
  assert.equal(kernel.report().board!.updates.length, 2);
});

test('readable files preserve update history and regenerate snapshots on replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-board-files-'));
  try {
    const kernel = new Kernel({ topology: 'pubsub' });
    await runTopology(kernel, { directory });
    const board = kernel.report().board!;
    const updates = readdirSync(join(directory, 'updates'));
    assert.equal(updates.length, board.updates.length);
    assert.match(readFileSync(join(directory, 'agents', 'reviewer', 'decisions.md'), 'utf8'), /inventory-findings/);
    assert.ok(JSON.parse(readFileSync(join(directory, 'agents', 'reviewer', 'subscriptions.json'), 'utf8')).some((sub: { topicId: string }) => sub.topicId === 'inventory-findings'));
    const before = kernel.events.length;
    rmSync(join(directory, 'board.json'));
    await runTopology(kernel, { directory });
    assert.equal(kernel.events.length, before);
    assert.equal(JSON.parse(readFileSync(join(directory, 'board.json'), 'utf8')).settled, true);
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('pi-board-files-'));
    rmSync(target, { recursive: true, force: true });
  }
});

test('a conversation feedback loop stops at the persisted turn budget', async () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  const decide: BoardDecider = async ({ context }) => {
    const decision = waitDecision([{ topicId: 'announcements', reason: 'Following discussion.' }]);
    if (context.inbox.length) decision.publish = [{ topicId: 'announcements', text: 'Another observation.', evidenceRefs: [] }];
    return { data: decision, summary: 'Discussion.' };
  };
  await assert.rejects(runTopology(kernel, { decide }), /budget exhausted/);
  const calls = kernel.report().metrics.decisionCalls;
  assert.ok(calls <= 48);
  await assert.rejects(runTopology(kernel, { decide }), /budget exhausted/);
  assert.equal(kernel.report().metrics.decisionCalls, calls);
});

test('historical pubsub runs stay readable and incomplete old runs cannot silently change protocols', async () => {
  const original = new Kernel({ topology: 'pubsub', runId: 'old-protocol' });
  const events = original.events.map(event => ({ kind: event.kind, data: structuredClone(event.data) }));
  delete (events.find(event => event.kind === 'run.started')!.data as Record<string, unknown>).pubsubVersion;
  const journal = new MemoryJournal();
  journal.append(original.runId, events);
  const old = new Kernel({ journal, runId: original.runId });
  assert.equal(old.pubsubVersion, 1);
  await assert.rejects(runTopology(old), /retired fixed pub\/sub protocol/);
  old.receipt('topology:pubsub:complete');
  const count = old.events.length;
  await runTopology(old);
  assert.equal(old.events.length, count);
});

test('new posts wake only followers; their bodies never appear in other agents contexts', async () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  await runTopology(kernel);
  const update: BoardUpdate = new TopicBoard(kernel).post('inventory-findings', 'A note intended for subscribers.');
  const received: string[] = [];
  await runTopology(kernel, { decide: async request => {
    if (request.context.inbox.some(post => post.id === update.id)) received.push(request.context.agent);
    return scriptedBoardDecider(request);
  } });
  assert.deepEqual(received, ['reviewer']);
  assert.equal(kernel.report().metrics.workerCalls, 3, 'completed inventory skills are not rerun on notes');
});
