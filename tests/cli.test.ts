import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { Kernel } from '../src/kernel.ts';
import { SqliteJournal } from '../src/store.ts';

type Capture = {
  logs: unknown[][];
  tables: unknown[][];
  errors: unknown[][];
  exitCode: typeof process.exitCode;
  error?: unknown;
};

/** Invoke the real CLI without subprocesses, keeping output and exit state local to each test. */
async function invoke(args: string[]): Promise<Capture> {
  const original = { log: console.log, table: console.table, error: console.error, exitCode: process.exitCode };
  const captured: Capture = { logs: [], tables: [], errors: [], exitCode: undefined };
  console.log = (...items: unknown[]) => { captured.logs.push(items); };
  console.table = (...items: unknown[]) => { captured.tables.push(items); };
  console.error = (...items: unknown[]) => { captured.errors.push(items); };
  process.exitCode = undefined;
  try { await main(args); }
  catch (error) { captured.error = error; }
  finally {
    captured.exitCode = process.exitCode;
    console.log = original.log;
    console.table = original.table;
    console.error = original.error;
    process.exitCode = original.exitCode;
  }
  return captured;
}

function jsonOutput(captured: Capture): any {
  assert.equal(captured.error, undefined);
  assert.equal(captured.errors.length, 0);
  assert.equal(captured.logs.length, 1);
  return JSON.parse(String(captured.logs[0]![0]));
}

async function temporaryDatabase(action: (db: string, directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'pi-comm-cli-'));
  try { await action(join(directory, 'lab.sqlite'), directory); }
  finally {
    // Recursive cleanup is restricted to the unique directory this helper created.
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('pi-comm-cli-'));
    rmSync(target, { recursive: true, force: true });
  }
}

function readDatabase(db: string) {
  const journal = new SqliteJournal(db);
  try { return journal.runIds().map(runId => ({ runId, events: journal.read(runId) })); }
  finally { journal.close(); }
}

test('CLI help does not create a journal; doctor reports missing installations without credentials', async () => {
  await temporaryDatabase(async (db, directory) => {
    const help = await invoke(['help', '--db', db]);
    assert.equal(help.error, undefined);
    assert.match(String(help.logs[0]![0]), /compare.*pi-faux/);
    assert.equal(help.exitCode, undefined);
    assert.equal(existsSync(db), false);
    const previousPath = process.env.PI_PACKAGE_PATH;
    try {
      process.env.PI_PACKAGE_PATH = join(directory, 'not-installed');
      const doctor = await invoke(['doctor', '--db', db]);
      const info = jsonOutput(doctor);
      assert.equal(info.node, process.version);
      assert.equal(info.pi, null);
      assert.equal(doctor.exitCode, 1);
      assert.equal(existsSync(db), false);
    } finally {
      if (previousPath === undefined) delete process.env.PI_PACKAGE_PATH;
      else process.env.PI_PACKAGE_PATH = previousPath;
    }
  });
});

test('CLI compare persists four completed runs and list reports their identities', async () => {
  await temporaryDatabase(async db => {
    const comparison = await invoke(['compare', '--db', db, '--duplicates', '--json']);
    const reports = jsonOutput(comparison);
    assert.equal(comparison.exitCode, undefined);
    assert.deepEqual(reports.map((report: any) => report.topology), ['coordinator', 'pubsub', 'routed', 'handoff']);
    assert.ok(reports.every((report: any) => report.success && report.metrics.workerCalls === 3));
    const pubsub = reports.find((report: any) => report.topology === 'pubsub');
    assert.ok(pubsub.metrics.duplicatesSuppressed > 0);
    assert.equal(pubsub.metrics.duplicatesSuppressed, pubsub.metrics.messages);
    const listed = jsonOutput(await invoke(['list', '--db', db, '--json']));
    assert.deepEqual(listed.map((run: any) => run.runId), reports.map((report: any) => report.runId));
    assert.ok(listed.every((run: any) => run.completed));
    const table = await invoke(['list', '--db', db]);
    assert.equal(table.error, undefined);
    assert.equal((table.tables[0]![0] as unknown[]).length, 4);
    assert.equal(readDatabase(db).length, 4);
  });
});

test('CLI run, inspect, export, and completed resume preserve the durable evidence', async () => {
  await temporaryDatabase(async (db, directory) => {
    const run = jsonOutput(await invoke(['run', 'handoff', '--db', db, '--json']))[0];
    assert.equal(run.success, true);
    assert.equal(run.tasks.length, 1);
    assert.equal(run.tasks[0].owner, 'reporter');
    const before = readDatabase(db);
    const inspected = jsonOutput(await invoke(['inspect', run.runId, '--db', db, '--json']));
    assert.deepEqual(inspected, run);
    const readable = await invoke(['inspect', run.runId, '--db', db]);
    assert.equal(readable.error, undefined);
    assert.equal(readable.tables.length, 1);
    assert.match(String(readable.logs[0]![0]), /catalog.*metrics/);
    const output = join(directory, 'exports', 'run.json');
    const exported = await invoke(['export', run.runId, '--db', db, '--output', output]);
    assert.equal(exported.error, undefined);
    const saved = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(saved.report, run);
    assert.deepEqual(saved.events, before[0]!.events);
    const resumed = jsonOutput(await invoke(['resume', run.runId, '--db', db, '--json']));
    assert.deepEqual(resumed, [run]);
    assert.deepEqual(readDatabase(db), before);
  });
});

test('CLI inspect/export do not recover an interrupted attempt; resume uses the remaining retry', async () => {
  await temporaryDatabase(async (db, directory) => {
    const journal = new SqliteJournal(db);
    try {
      const kernel = new Kernel({ journal, runId: 'interrupted-cli', maxAttempts: 2 });
      const task = kernel.ensureTask('analysis', 'analyst');
      journal.append(kernel.runId, [
        { kind: 'task', data: { ...task, status: 'running', attempt: 1, stateVersion: 1 } },
        { kind: 'attempt.started', data: { taskId: task.id, stage: 'analyze', attempt: 1 } },
      ]);
    } finally { journal.close(); }
    const before = readDatabase(db);
    const inspected = jsonOutput(await invoke(['inspect', 'interrupted-cli', '--db', db, '--json']));
    assert.equal(inspected.success, false);
    assert.equal(inspected.tasks[0].status, 'running');
    const output = join(directory, 'interrupted.json');
    assert.equal((await invoke(['export', 'interrupted-cli', '--db', db, '--output', output])).error, undefined);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).events, before[0]!.events);
    assert.deepEqual(readDatabase(db), before);
    const resumed = jsonOutput(await invoke(['resume', 'interrupted-cli', '--db', db, '--json']))[0];
    assert.equal(resumed.success, true);
    assert.equal(resumed.metrics.workerCalls, 4);
    assert.equal(resumed.metrics.interruptedAttempts, 1);
    assert.equal(resumed.tasks.find((task: any) => task.id === 'analysis').attempt, 2);
  });
});

test('CLI unknown run lookups do not create experiments or exports', async () => {
  await temporaryDatabase(async (db, directory) => {
    for (const command of ['inspect', 'resume', 'export']) {
      const output = join(directory, 'should-not-exist.json');
      const captured = await invoke([command, 'unknown-run', '--db', db, '--output', output]);
      assert.match(String(captured.error), /Unknown run: unknown-run/);
      assert.equal(existsSync(output), false);
      assert.deepEqual(readDatabase(db), []);
    }
  });
});

test('CLI rejects invalid topology/options and live inference without a provider before creating a run', async () => {
  await temporaryDatabase(async db => {
    for (const args of [
      ['run', 'invalid'], ['run'], ['unknown'], ['inspect'],
      ['run', 'coordinator', '--timeout', 'abc'],
      ['run', 'coordinator', '--fail-once', 'invalid'],
    ]) {
      const captured = await invoke([...args, '--db', db]);
      assert.ok(captured.error instanceof Error);
      assert.equal(existsSync(db), false);
    }
    const live = await invoke(['run', 'coordinator', '--worker', 'pi', '--model', 'example', '--db', db]);
    assert.match(String(live.error), /requires --provider and --model/);
    assert.deepEqual(readDatabase(db), []);
    const invalidWorker = await invoke(['run', 'coordinator', '--worker', 'invalid', '--db', db]);
    assert.match(String(invalidWorker.error), /Worker must be/);
    assert.deepEqual(readDatabase(db), []);
  });
});

test('CLI records injected failure, sets failure exit status, and preserves exhausted retry limits', async () => {
  await temporaryDatabase(async db => {
    const failed = await invoke(['run', 'coordinator', '--db', db, '--fail-once', 'analyze', '--max-attempts', '1', '--json']);
    assert.equal(failed.error, undefined);
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.errors.length, 1);
    assert.match(String(failed.errors[0]![0]), /Injected fixture-worker failure/);
    const report = JSON.parse(String(failed.logs[0]![0]))[0];
    assert.equal(report.success, false);
    assert.equal(report.metrics.failedAttempts, 1);
    assert.equal(report.metrics.workerCalls, 1);
    const resumed = await invoke(['resume', report.runId, '--db', db, '--json']);
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.exitCode, 1);
    assert.match(String(resumed.errors[0]![0]), /Attempt budget exhausted/);
    const after = JSON.parse(String(resumed.logs[0]![0]))[0];
    assert.equal(after.metrics.workerCalls, 1);
    const listed = jsonOutput(await invoke(['list', '--db', db, '--json']));
    assert.equal(listed[0].completed, false);
  });
});

test('CLI one-time failure can recover within the configured budget', async () => {
  await temporaryDatabase(async db => {
    const captured = await invoke(['run', 'pubsub', '--db', db, '--fail-once', 'review', '--json']);
    const report = jsonOutput(captured)[0];
    assert.equal(captured.exitCode, undefined);
    assert.equal(report.success, true);
    assert.equal(report.metrics.failedAttempts, 1);
    assert.equal(report.metrics.workerCalls, 4);
  });
});

test('CLI board and post expose readable files and resume delivers a new subject only to its followers', async () => {
  await temporaryDatabase(async (db, directory) => {
    const run = jsonOutput(await invoke(['run', 'pubsub', '--db', db, '--json']))[0];
    assert.equal(run.success, true);
    const before = readDatabase(db);
    const board = jsonOutput(await invoke(['board', run.runId, '--db', db, '--json']));
    assert.equal(board.settled, true);
    assert.match(String((await invoke(['board', run.runId, '--db', db])).logs[0]![0]), /SUBJECTS/);
    assert.deepEqual(readDatabase(db), before, 'Board inspection must be read-only');
    const post = jsonOutput(await invoke(['post', run.runId, '--db', db, '--topic', 'follow-up', '--title', 'Follow-up',
      '--description', 'Unreviewed inventory findings for discussion.', '--text', 'Please read this follow-up note.', '--json']));
    assert.equal(post.author, 'user');
    assert.equal(jsonOutput(await invoke(['list', '--db', db, '--json']))[0].completed, false);
    const resumed = jsonOutput(await invoke(['resume', run.runId, '--db', db, '--json']))[0];
    assert.equal(resumed.success, true);
    assert.equal(resumed.metrics.workerCalls, 3);
    assert.ok(resumed.metrics.decisionCalls > run.metrics.decisionCalls);
    const deliveries = readDatabase(db)[0]!.events.filter(event => event.kind === 'board.delivery' && (event.data as { updateId: string }).updateId === post.id);
    assert.deepEqual(deliveries.map(event => (event.data as { to: string }).to), ['reviewer']);
    assert.match(readFileSync(join(directory, 'boards', run.runId, 'topics', 'follow-up.md'), 'utf8'), /Please read this/);
    assert.match(readFileSync(join(directory, 'boards', run.runId, 'agents', 'reviewer', 'decisions.md'), 'utf8'), /follow-up/);
    const invalid = await invoke(['post', run.runId, '--db', db, '--topic', '../outside', '--title', 'x', '--description', 'x', '--text', 'x']);
    assert.match(String(invalid.error), /Topic ID/);
  });
});
