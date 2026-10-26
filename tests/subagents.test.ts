import assert from 'node:assert/strict';
import test from 'node:test';
import { Kernel } from '../src/kernel.ts';
import { TopicBoard, validateDecision } from '../src/board.ts';
import { scriptedBoardDecider } from '../src/board-policy.ts';
import { scriptedSubagentWorker, runSubagentTask, validateSubagentFinding } from '../src/subagents.ts';
import { MemoryJournal } from '../src/store.ts';
import type { BoardContext, BoardDecision } from '../src/board-types.ts';
import type { SubagentContext, SubagentTask } from '../src/subagent-types.ts';

const taskFor = (kernel: Kernel): SubagentTask => ({
  name: 'checker', task: 'Inspect selected evidence.', evidenceRefs: [kernel.fixture.id], id: 'sub-test', parent: 'analyst', depth: 1,
});

test('parent chooses one helper; selected context stays isolated and advisory result wakes only parent', async () => {
  const kernel = new Kernel({ topology: 'pubsub', subagentDemo: true });
  const seen: BoardContext[] = [];
  const children: SubagentContext[] = [];
  const board = new TopicBoard(kernel, {
    decide: request => { seen.push(request.context); return scriptedBoardDecider(request); },
    subagentWorker: request => { children.push(request.context); return scriptedSubagentWorker(request); },
  });
  await board.run();
  assert.equal(kernel.report().success, true);
  assert.equal(children.length, 1);
  assert.equal(children[0].parent, 'reviewer');
  assert.equal(children[0].depth, 1);
  assert.deepEqual(children[0].evidence.map(item => item.kind), ['fixture', 'analysis']);
  assert.deepEqual(Object.keys(children[0]).sort(), ['depth', 'evidence', 'evidenceRefs', 'id', 'name', 'parent', 'task'].sort());
  assert.ok(seen.some(context => context.agent === 'reviewer' && context.subagents?.[0]?.status === 'completed'));
  assert.ok(seen.filter(context => context.agent !== 'reviewer').every(context => context.subagents?.length === 0));
  assert.equal(kernel.report().metrics.subagentCalls, 1);
  assert.equal(kernel.report().metrics.workerCalls, 3, 'helper cannot replace authoritative review');
  const before = kernel.events.length;
  await board.run();
  assert.equal(kernel.events.length, before);
  assert.ok(kernel.hasReceipt('subagent:reviewer:' + children[0].id));
});

test('invalid delegation rejects hidden evidence, unknown permissions, repeated spawning and simultaneous work', async () => {
  const kernel = new Kernel({ topology: 'pubsub', subagentDemo: true });
  let initial!: BoardContext, after!: BoardContext;
  const board = new TopicBoard(kernel, { decide: async request => {
    initial ??= request.context;
    if (request.context.subagents?.length) after = request.context;
    return scriptedBoardDecider(request);
  } });
  await board.run();
  const wait = { subscriptions: [], status: 'Wait', reason: 'Observe', createTopics: [], publish: [], work: null } satisfies BoardDecision;
  const spawn = { name: 'checker', task: 'Check', evidenceRefs: [] };
  assert.throws(() => validateDecision({ ...wait, spawnSubagents: [{ ...spawn, evidenceRefs: [kernel.fixture.id] }] }, initial), /unavailable evidence/);
  assert.throws(() => validateDecision({ ...wait, spawnSubagents: [{ ...spawn, tools: ['shell'] }] }, initial), /unknown fields/);
  assert.throws(() => validateDecision({ ...wait, spawnSubagents: [{ ...spawn, name: '../escape' }] }, initial), /slug/);
  assert.throws(() => validateDecision({ ...wait, spawnSubagents: [spawn] }, after), /budget/);
  assert.throws(() => validateDecision({ ...wait, work: 'analyze', spawnSubagents: [spawn] }, { ...initial, availableWork: 'analyze' }), /Delegate first/);
});

test('one-level and lifetime limits cannot be exceeded; failed helpers do not free capacity', async () => {
  const kernel = new Kernel({ topology: 'pubsub', subagentLimit: 1, maxAttempts: 1 });
  await runSubagentTask(kernel, taskFor(kernel), async () => { throw new Error('Helper failure'); });
  assert.equal(kernel.report().metrics.subagentsFailed, 1);
  await assert.rejects(runSubagentTask(kernel, { ...taskFor(kernel), id: 'sub-second', parent: 'reviewer' }, scriptedSubagentWorker), /budget/);
  const other = new Kernel({ topology: 'pubsub' });
  await assert.rejects(runSubagentTask(other, { ...taskFor(other), parent: 'sub-parent' as any, depth: 2 as any }, scriptedSubagentWorker), /cannot create/);
});

test('subagent outputs cannot spawn, cite unseen evidence, or return oversized findings', () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  const context = { ...taskFor(kernel), evidence: [kernel.fixture] };
  const result = { findings: 'Observation.', evidenceRefs: [kernel.fixture.id], limitations: [] };
  assert.throws(() => validateSubagentFinding({ ...result, spawnSubagents: [{}] }, context), /cannot request actions/);
  assert.throws(() => validateSubagentFinding({ ...result, evidenceRefs: ['hidden'] }, context), /unavailable/);
  assert.throws(() => validateSubagentFinding({ ...result, findings: 'x'.repeat(4001) }, context), /findings/);
});

test('committed helper result survives an acknowledgement failure without duplicate invocation', async () => {
  class Journal extends MemoryJournal {
    override append(runId: string, changes: Parameters<MemoryJournal['append']>[1]) {
      const events = super.append(runId, changes);
      if (changes.some(item => item.kind === 'subagent.completed')) throw new Error('Acknowledgement lost');
      return events;
    }
  }
  const kernel = new Kernel({ topology: 'pubsub', journal: new Journal() });
  let calls = 0;
  const worker = async (request: Parameters<typeof scriptedSubagentWorker>[0]) => { calls++; return scriptedSubagentWorker(request); };
  await assert.rejects(runSubagentTask(kernel, taskFor(kernel), worker), /Acknowledgement/);
  await runSubagentTask(kernel, taskFor(kernel), worker);
  assert.equal(calls, 1);
  assert.equal(kernel.report().metrics.subagentsCompleted, 1);
});

test('timeout rejects late helper output and accounts for rejected model usage', async () => {
  const kernel = new Kernel({ topology: 'pubsub', timeoutMs: 5, maxAttempts: 1 });
  let resolve!: (value: any) => void;
  await runSubagentTask(kernel, taskFor(kernel), () => new Promise(done => { resolve = done; }));
  resolve({ data: { findings: 'Late', evidenceRefs: [], limitations: [] }, summary: 'Late' });
  await new Promise(done => setImmediate(done));
  assert.equal(kernel.report().metrics.subagentsCompleted, 0);
  assert.equal(kernel.report().metrics.subagentsFailed, 1);
  const rejected = new Kernel({ topology: 'pubsub', maxAttempts: 1 });
  await runSubagentTask(rejected, taskFor(rejected), async () => ({ data: { spawnSubagents: [{}] }, summary: 'Invalid', usage: { input: 10, output: 3 } }));
  assert.equal(rejected.report().metrics.inputTokens, 10);
  assert.equal(rejected.report().metrics.outputTokens, 3);
});

test('interrupted helpers retain attempts and complete on the remaining retry', async () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  const task = taskFor(kernel);
  kernel.record('subagent.requested', task);
  kernel.record('subagent.attempt.started', { id: task.id, attempt: 1 });
  await runSubagentTask(kernel, task, scriptedSubagentWorker);
  assert.equal(kernel.report().metrics.subagentCalls, 2);
  assert.equal(kernel.report().metrics.subagentsCompleted, 1);
  assert.equal(kernel.report().metrics.subagentFailures, 1);
});

test('shutdown prevents retries; recovery retains the pending helper', async () => {
  const kernel = new Kernel({ topology: 'pubsub' });
  const stop = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = runSubagentTask(kernel, taskFor(kernel), async () => { started(); return new Promise(() => {}); }, stop.signal);
  await ready;
  stop.abort();
  await assert.rejects(pending, /Supervisor stopped/);
  assert.equal(kernel.report().metrics.subagentCalls, 1);
  await runSubagentTask(kernel, taskFor(kernel), scriptedSubagentWorker);
  assert.equal(kernel.report().metrics.subagentsCompleted, 1);
});

test('existing board runs keep delegation disabled and cannot silently change budgets', async () => {
  const original = new Kernel({ topology: 'pubsub' });
  const events = original.events.map(event => ({ kind: event.kind, data: structuredClone(event.data) }));
  const config = events.find(event => event.kind === 'run.started')!.data as any;
  delete config.subagentLimit; delete config.subagentDemo;
  const journal = new MemoryJournal(); journal.append(original.runId, events);
  const old = new Kernel({ journal, runId: original.runId });
  assert.equal(old.subagentLimit, 0);
  await new TopicBoard(old).run();
  assert.throws(() => new Kernel({ journal, runId: old.runId, subagentLimit: 3 }), /mismatch/);
  assert.throws(() => new Kernel({ topology: 'pubsub', subagentLimit: 4 }), /0..3/);
});
