import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel.ts';
import { MemoryJournal, SqliteJournal } from '../src/store.ts';
import { scriptedWorker } from '../src/workers.ts';
import { runTopology } from '../src/topologies.ts';
import type { Journal, Worker } from '../src/types.ts';

test('SQLite reconstructs completed state after close/reopen without repeating effects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-comm-test-'));
  let journal: Journal | undefined;
  try {
    journal = new SqliteJournal(join(dir, 'run.sqlite'));
    const first = new Kernel({ journal, runId: 'durable', topology: 'handoff' });
    await runTopology(first);
    const before = first.report();
    const count = first.events.length;
    journal.close();
    journal = new SqliteJournal(join(dir, 'run.sqlite'));
    const resumed = new Kernel({ journal, runId: 'durable', topology: 'handoff' });
    await runTopology(resumed);
    assert.deepEqual(resumed.report(), before);
    assert.equal(resumed.events.length, count);
    assert.deepEqual(journal.runIds(), ['durable']);
  } finally {
    journal?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retries a failed fixture computation once and counts attempts', async () => {
  let calls = 0;
  const worker: Worker = async request => {
    if (++calls === 1) throw new Error('simulated interruption');
    return scriptedWorker(request);
  };
  const kernel = new Kernel({ worker });
  await runTopology(kernel);
  assert.equal(kernel.report().success, true);
  assert.equal(kernel.report().metrics.workerCalls, 4);
  assert.equal(kernel.report().metrics.failedAttempts, 1);
});

test('persistent attempts cannot exceed the budget after supervisor restart', async () => {
  const journal = new MemoryJournal();
  let calls = 0;
  const worker: Worker = async () => { calls++; throw new Error('offline'); };
  const options = { journal, runId: 'retry-budget', worker, maxAttempts: 2 };
  const original = new Kernel(options);
  await assert.rejects(runTopology(original), /offline/);
  assert.equal(calls, 2);
  const resumed = new Kernel(options);
  await assert.rejects(runTopology(resumed), /budget exhausted/);
  assert.equal(calls, 2);
});

test('deadline ends noncooperative work and late output cannot mutate task state', async () => {
  let resolveWorker: (value: any) => void = () => {};
  const kernel = new Kernel({ maxAttempts: 1, timeoutMs: 10, worker: () => new Promise(resolve => { resolveWorker = resolve; }) });
  kernel.ensureTask('analysis', 'analyst');
  await assert.rejects(kernel.execute('analyze', 'analysis', 'analyst', [kernel.fixture]), /deadline/);
  assert.equal(kernel.task('analysis').status, 'failed');
  resolveWorker({ data: {}, summary: 'late' });
  await Promise.resolve();
  assert.equal(kernel.artifacts.filter(item => item.kind === 'analysis').length, 0);
});

test('cancellation is durable and rejects a late worker result', async () => {
  let entered: () => void = () => {};
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const kernel = new Kernel({ worker: async () => { entered(); return new Promise(() => {}); } });
  kernel.ensureTask('analysis', 'analyst');
  const pending = kernel.execute('analyze', 'analysis', 'analyst', [kernel.fixture]);
  await ready;
  kernel.cancel('analysis');
  await assert.rejects(pending, /cancelled/);
  assert.equal(kernel.task('analysis').status, 'cancelled');
  assert.equal(kernel.report().metrics.workerCalls, 1);
});

test('malformed or invented analysis cannot become an accepted artifact', async () => {
  const kernel = new Kernel({ maxAttempts: 1, worker: async () => ({ summary: 'invented', data: { discrepancies: [] } }) });
  await assert.rejects(runTopology(kernel), /omits a fixture discrepancy/);
  assert.equal(kernel.artifacts.filter(item => item.kind === 'analysis').length, 0);
  assert.equal(kernel.report().success, false);
});

test('foreign artifact references are rejected and forged contents are replaced with originals', async () => {
  const kernel = new Kernel();
  kernel.ensureTask('analysis', 'analyst');
  await assert.rejects(kernel.execute('analyze', 'analysis', 'analyst', [{ ...kernel.fixture, id: 'foreign' }]), /Unknown artifact/);
  const output = await kernel.execute('analyze', 'analysis', 'analyst', [{ ...kernel.fixture, data: { invented: true } }]);
  assert.equal((output.data as { discrepancies: unknown[] }).discrepancies.length, 2);
});

test('only permitted routes can transmit and all referenced evidence must exist', () => {
  const kernel = new Kernel();
  kernel.ensureTask('analysis', 'analyst');
  assert.throws(() => kernel.send('analyst', 'reviewer', 'question', 'analysis', []), /Route forbidden/);
  assert.throws(() => kernel.send('coordinator', 'analyst', 'task.assigned', 'analysis', ['missing']), /Unknown artifact/);
  const first = kernel.send('coordinator', 'analyst', 'task.assigned', 'analysis', [kernel.fixture.id], {}, { dedupeKey: 'same' });
  const second = kernel.send('coordinator', 'analyst', 'task.assigned', 'analysis', [kernel.fixture.id], {}, { dedupeKey: 'same' });
  assert.deepEqual(second, first);
  assert.equal(kernel.report().metrics.messages, 1);
});

test('handoff blocks old owner before acceptance and commits ownership exactly once', async () => {
  const kernel = new Kernel({ topology: 'handoff' });
  kernel.ensureTask('workflow', 'analyst');
  const analysis = await kernel.execute('analyze', 'workflow', 'analyst', [kernel.fixture], false);
  const offered = kernel.offerHandoff('h1', 'workflow', 'reviewer', [analysis.id, kernel.fixture.id]);
  assert.equal(kernel.task('workflow').owner, 'analyst');
  assert.throws(() => kernel.commitHandoff('h1'), /accepted/);
  assert.throws(() => kernel.acceptHandoff('h1', 'reporter'), /Invalid handoff acceptance/);
  await assert.rejects(kernel.execute('review', 'workflow', 'reviewer', [kernel.fixture, analysis], false), /Ownership mismatch/);
  kernel.acceptHandoff('h1', 'reviewer');
  kernel.commitHandoff('h1');
  kernel.commitHandoff('h1');
  assert.equal(kernel.task('workflow').owner, 'reviewer');
  assert.equal(kernel.task('workflow').ownershipEpoch, offered.expectedEpoch + 1);
  assert.equal(kernel.report().metrics.handoffs, 1);
});

test('handoff cancellation retains old owner and cancelled tasks cannot transfer', async () => {
  const kernel = new Kernel({ topology: 'handoff' });
  kernel.ensureTask('workflow', 'analyst');
  const output = await kernel.execute('analyze', 'workflow', 'analyst', [kernel.fixture], false);
  kernel.offerHandoff('h1', 'workflow', 'reviewer', [output.id]);
  kernel.abortHandoff('h1');
  assert.equal(kernel.task('workflow').owner, 'analyst');
  assert.throws(() => kernel.acceptHandoff('h1', 'reviewer'), /no longer offered/);
  kernel.offerHandoff('h2', 'workflow', 'reviewer', [output.id]);
  kernel.acceptHandoff('h2', 'reviewer');
  kernel.cancel('workflow');
  assert.throws(() => kernel.commitHandoff('h2'), /Stale/);
});

test('active task rejects concurrent execution', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const kernel = new Kernel({ worker: async request => { await gate; return scriptedWorker(request); } });
  kernel.ensureTask('analysis', 'analyst');
  const first = kernel.execute('analyze', 'analysis', 'analyst', [kernel.fixture]);
  await assert.rejects(kernel.execute('analyze', 'analysis', 'analyst', [kernel.fixture]), /already executing/);
  release();
  await first;
});

test('context budget is enforced without dropping required evidence', async () => {
  const kernel = new Kernel({ maxContextChars: 1000 });
  await assert.rejects(runTopology(kernel), /context budget/);
  assert.equal(kernel.report().metrics.workerCalls, 0);
});

test('resume rejects a changed worker or topology', () => {
  const journal = new MemoryJournal();
  new Kernel({ journal, runId: 'config' });
  assert.throws(() => new Kernel({ journal, runId: 'config', workerLabel: 'different' }), /configuration mismatch/);
  assert.throws(() => new Kernel({ journal, runId: 'config', topology: 'routed' }), /configuration mismatch/);
});

test('corrupt artifact data is detected when reopening', () => {
  const journal = new MemoryJournal();
  const kernel = new Kernel({ journal, runId: 'hash-check' });
  journal.append('hash-check', [{ kind: 'artifact', data: { ...kernel.fixture, data: 'tampered' } }]);
  assert.throws(() => new Kernel({ journal, runId: 'hash-check' }), /integrity/);
});

test('reads cannot mutate the journal', () => {
  const journal = new MemoryJournal();
  const kernel = new Kernel({ journal });
  const data = kernel.fixture;
  data.data = 'modified';
  assert.notEqual(kernel.fixture.data, 'modified');
});
