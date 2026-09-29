import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Kernel } from '../src/kernel.ts';
import { createPiWorker, createPiBoardDecider, discoverPi } from '../src/pi.ts';
import { scriptedBoardDecider } from '../src/board-policy.ts';
import type { BoardDecider } from '../src/board-types.ts';
import { MemoryJournal, SqliteJournal } from '../src/store.ts';
import { runTopology } from '../src/topologies.ts';
import type { JournalEvent, Topology, Worker } from '../src/types.ts';
import { evaluateReport, scriptedWorker } from '../src/workers.ts';

test('a failed attempt-start journal write does not leave an active worker lock', async () => {
  class FailingJournal extends MemoryJournal {
    failNextAppend = false;
    override append(runId: string, changes: { kind: string; data: unknown }[]): JournalEvent[] {
      if (this.failNextAppend) {
        this.failNextAppend = false;
        throw new Error('simulated journal outage');
      }
      return super.append(runId, changes);
    }
  }
  const journal = new FailingJournal();
  let calls = 0;
  const kernel = new Kernel({ journal, worker: async request => { calls++; return scriptedWorker(request); } });
  kernel.ensureTask('analysis', 'analyst');
  journal.failNextAppend = true;
  await assert.rejects(kernel.execute('analyze', 'analysis', 'analyst', [kernel.fixture]), /journal outage/);
  assert.equal(calls, 0);
  assert.equal(kernel.task('analysis').status, 'queued');
  assert.equal(kernel.report().metrics.workerCalls, 0);
  const output = await kernel.execute('analyze', 'analysis', 'analyst', [kernel.fixture]);
  assert.equal(output.kind, 'analysis');
  assert.equal(calls, 1);
  assert.equal(kernel.task('analysis').status, 'completed');
});

test('rejected responses count consumed tokens and failed-attempt elapsed time', async () => {
  let calls = 0;
  const worker: Worker = async request => {
    const result = await scriptedWorker(request);
    result.usage = { input: 100, output: 50 };
    if (++calls === 1) {
      await delay(15);
      result.data = { discrepancies: [] };
    }
    return result;
  };
  const kernel = new Kernel({ worker, workerLabel: 'measured-fixture' });
  kernel.ensureTask('analysis', 'analyst');
  await kernel.execute('analyze', 'analysis', 'analyst', [kernel.fixture]);
  const metrics = kernel.report().metrics;
  assert.equal(metrics.workerCalls, 2);
  assert.equal(metrics.failedAttempts, 1);
  assert.equal(metrics.inputTokens, 200);
  assert.equal(metrics.outputTokens, 100);
  assert.equal(metrics.attemptsWithoutUsage, 0);
  const allElapsed = kernel.events.filter(event => ['attempt.failed', 'result.accepted'].includes(event.kind))
    .reduce((sum, event) => sum + (event.data as { elapsedMs: number }).elapsedMs, 0);
  assert.equal(metrics.workerElapsedMs, Math.round(allElapsed));
  assert.ok(metrics.workerElapsedMs >= 10);
  assert.equal(kernel.artifacts.filter(artifact => artifact.kind === 'analysis').length, 1);
});

test('reopening an interrupted final attempt records failure and preserves the consumed budget', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-comm-interrupted-'));
  const path = join(directory, 'run.sqlite');
  let journal: SqliteJournal | undefined;
  try {
    journal = new SqliteJournal(path);
    const original = new Kernel({ journal, runId: 'interrupted', maxAttempts: 1 });
    const task = original.ensureTask('analysis', 'analyst');
    // Simulate the durable boundary immediately before a process is interrupted.
    journal.append(original.runId, [
      { kind: 'task', data: { ...task, status: 'running', attempt: 1, stateVersion: 1 } },
      { kind: 'attempt.started', data: { taskId: task.id, stage: 'analyze', attempt: 1 } },
    ]);
    journal.close();
    journal = new SqliteJournal(path);
    let calls = 0;
    const resumed = new Kernel({ journal, runId: 'interrupted', worker: async request => { calls++; return scriptedWorker(request); } });
    assert.equal(resumed.task('analysis').status, 'failed');
    assert.equal(resumed.task('analysis').attempt, 1);
    assert.equal(resumed.report().metrics.failedAttempts, 1);
    assert.equal(resumed.report().metrics.interruptedAttempts, 1);
    await assert.rejects(resumed.execute('analyze', 'analysis', 'analyst', [resumed.fixture]), /Attempt budget exhausted/);
    assert.equal(calls, 0);
    const eventCount = resumed.events.length;
    journal.close();
    journal = new SqliteJournal(path);
    const reopenedAgain = new Kernel({ journal, runId: 'interrupted' });
    assert.equal(reopenedAgain.events.length, eventCount);
    assert.equal(reopenedAgain.report().metrics.interruptedAttempts, 1);
  } finally {
    journal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an interrupted attempt can use its remaining retry without erasing history', async () => {
  const journal = new MemoryJournal();
  const original = new Kernel({ journal, runId: 'remaining-retry', maxAttempts: 2 });
  const task = original.ensureTask('analysis', 'analyst');
  journal.append(original.runId, [
    { kind: 'task', data: { ...task, status: 'running', attempt: 1, stateVersion: 1 } },
    { kind: 'attempt.started', data: { taskId: task.id, stage: 'analyze', attempt: 1 } },
  ]);
  const resumed = new Kernel({ journal, runId: 'remaining-retry' });
  await resumed.execute('analyze', 'analysis', 'analyst', [resumed.fixture]);
  assert.equal(resumed.task('analysis').status, 'completed');
  assert.equal(resumed.task('analysis').attempt, 2);
  assert.equal(resumed.report().metrics.workerCalls, 2);
  assert.equal(resumed.report().metrics.failedAttempts, 1);
  assert.equal(resumed.report().metrics.interruptedAttempts, 1);
});

test('a second live SQLite supervisor is rejected and normal close releases ownership', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-comm-supervisor-'));
  const path = join(directory, 'run.sqlite');
  let first: SqliteJournal | undefined;
  let reopened: SqliteJournal | undefined;
  try {
    first = new SqliteJournal(path);
    first.append('lock-test', [{ kind: 'before', data: { value: 1 } }]);
    assert.throws(() => new SqliteJournal(path), /in use by supervisor process/);
    first.append('lock-test', [{ kind: 'after', data: { value: 2 } }]);
    first.close();
    first.close();
    reopened = new SqliteJournal(path);
    assert.deepEqual(reopened.read('lock-test').map(event => event.kind), ['before', 'after']);
    reopened.append('lock-test', [{ kind: 'reopened', data: {} }]);
  } finally {
    first?.close();
    reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a supervisor with a replaced ownership token cannot append or release another owner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-comm-fence-'));
  const path = join(directory, 'run.sqlite');
  let journal: SqliteJournal | undefined;
  let database: DatabaseSync | undefined;
  try {
    journal = new SqliteJournal(path);
    database = new DatabaseSync(path);
    database.prepare('UPDATE supervisor SET token=? WHERE id=1').run('replacement-owner');
    assert.throws(() => journal!.append('fenced', [{ kind: 'invalid', data: {} }]), /no longer owns database/);
    assert.equal(journal.read('fenced').length, 0);
    journal.close();
    assert.equal(database.prepare('SELECT token FROM supervisor WHERE id=1').get()?.token, 'replacement-owner');
  } finally {
    journal?.close();
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const installation = await discoverPi();
const offlineSdk = { skip: installation?.scope !== '@earendil-works' ? 'Installed Pi SDK unavailable' : false };
for (const topology of ['coordinator', 'pubsub', 'routed', 'handoff'] as Topology[]) {
  test(`actual Pi Agent completes the ${topology} fixture graph offline`, offlineSdk, async () => {
    // Load SDK modules before starting measured worker deadlines. Cold module
    // loading on Windows can be substantially slower than the fixture itself.
    await createPiWorker({
      packagePath: installation!.packagePath, provider: 'faux', model: 'fixture',
      fixtureResponses: [{ data: {}, summary: 'SDK initialization only.' }],
    });
    const worker: Worker = async request => {
      // Scripted responses isolate Pi's real Agent lifecycle from model/network variability.
      const expected = await scriptedWorker(request);
      const pi = await createPiWorker({
        packagePath: installation!.packagePath, provider: 'faux', model: 'fixture', fixtureResponses: [expected],
      });
      return pi(request);
    };
    const kernel = new Kernel({ topology, worker, workerLabel: 'pi-faux', duplicateDelivery: topology === 'pubsub' });
    const decide: BoardDecider = async request => {
      const response = await scriptedBoardDecider(request);
      const pi = await createPiBoardDecider({ packagePath: installation!.packagePath, provider: 'faux', model: 'fixture', fixtureResponses: [response] });
      return pi(request);
    };
    await runTopology(kernel, { decide });
    const report = kernel.report();
    assert.equal(report.success, true, report.issues.join('; '));
    assert.deepEqual(evaluateReport(report.artifacts), { success: true, issues: [] });
    assert.equal(report.metrics.workerCalls, 3);
    assert.equal(report.metrics.failedAttempts, 0);
    assert.equal(report.metrics.attemptsWithoutUsage, 0);
    assert.ok(report.tasks.every(task => task.status === 'completed'));
    const result = report.artifacts.find(artifact => artifact.kind === 'report')!;
    assert.equal((result.data as { discrepancyCount: number }).discrepancyCount, 2);
    const eventCount = kernel.events.length;
    await runTopology(kernel);
    assert.equal(kernel.events.length, eventCount);
  });
}
