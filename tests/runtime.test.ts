import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime, runtimeCommand, descriptorPath, readRuntime } from '../src/runtime.ts';
import { callRpc } from '../src/socket.ts';
import { SqliteJournal } from '../src/store.ts';
import type { BoardContext, DirectMessage } from '../src/board-types.ts';
import { main } from '../src/cli.ts';
import { discoverPi } from '../src/pi.ts';
import { runSubagentProcess } from '../src/subagent-process.ts';
import type { ChildProcess } from 'node:child_process';

test('three separate agent processes exchange socket messages, wake from idle, and resume durably', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-runtime-test-'));
  const db = join(directory, 'lab.sqlite');
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime({ db });
    await runtime.idle();
    const initial = await runtimeCommand(db, 'status');
    assert.equal(initial.error, null);
    assert.equal(initial.busy, false);
    assert.equal(new Set(initial.agents.map((agent: any) => agent.pid)).size, 3);
    assert.ok(initial.agents.every((agent: any) => agent.alive && agent.pid !== process.pid));
    assert.equal(initial.directMessages, 2);
    assert.equal(initial.socketReceipts, 2);
    assert.throws(() => new SqliteJournal(db), /in use by supervisor/i);
    await assert.rejects(startRuntime({ db }), /already running/);
    const descriptor = readRuntime(db)!;
    await assert.rejects(callRpc(descriptor.port, 'wrong', 'status'), /Unauthorized/);
    await assert.rejects(runtimeCommand(db, 'post', { runId: 'wrong-run', topic: 'inventory', text: 'x' }), /does not match/);
    const first = await runtimeCommand(db, 'export');
    assert.equal(first.report.success, true);
    const receipts = first.events.filter((event: any) => event.kind === 'board.direct.received');
    assert.ok(receipts.every((event: any) => event.data.mode === 'socket' && event.data.senderPid !== event.data.receiverPid && event.data.senderPid !== process.pid));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await runtimeCommand(db, 'status')).decisions, initial.decisions, 'idle performs no model calls');

    // Exercise the public CLI while the database is locked by serve.
    const logged: unknown[] = [];
    const oldLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args); };
    try { await main(['post', runtime.runId, '--db', db, '--topic', 'inventory', '--text', 'New supplied-inventory observation.', '--json']); }
    finally { console.log = oldLog; }
    assert.ok(logged.length);
    await runtime.idle();
    assert.equal((await runtimeCommand(db, 'status')).decisions, initial.decisions + 1);
    const dm = await runtimeCommand(db, 'dm', { to: 'reporter', text: 'Operator private question.' }) as DirectMessage;
    await runtime.idle();
    const after = await runtimeCommand(db, 'export');
    const turns = after.events.filter((event: any) => event.kind === 'board.turn').map((event: any) => event.data.context as BoardContext);
    assert.deepEqual(turns.filter((context: BoardContext) => context.directInbox?.some(item => item.id === dm.id)).map((context: BoardContext) => context.agent), ['reporter']);
    assert.match(readFileSync(join(directory, 'boards', runtime.runId, 'agents', 'reporter', 'messages.md'), 'utf8'), /Operator private question/);
    const total = (await runtimeCommand(db, 'status')).decisions;
    const runId = runtime.runId;
    await runtime.close();
    assert.equal(existsSync(descriptorPath(db)), false);
    runtime = await startRuntime({ db, runId });
    await runtime.idle();
    assert.equal((await runtimeCommand(db, 'status')).decisions, total);
    assert.equal((await runtimeCommand(db, 'inspect')).success, true);
    await runtimeCommand(db, 'stop');
    await runtime.closed;
    assert.equal(existsSync(descriptorPath(db)), false);
  } finally {
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid startup releases database ownership and does not publish a service descriptor', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-startup-test-'));
  const db = join(directory, 'lab.sqlite');
  try {
    await assert.rejects(startRuntime({ db, runId: 'missing' }), /Unknown run/);
    assert.equal(existsSync(descriptorPath(db)), false);
    new SqliteJournal(db).close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('stopping during an active decision closes peers and preserves the remaining retry', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-shutdown-test-'));
  const db = join(directory, 'lab.sqlite');
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime({ db });
    const runId = runtime.runId;
    await runtime.close();
    runtime = await startRuntime({ db, runId });
    await runtime.idle();
    assert.equal((await runtimeCommand(db, 'status')).error, null);
    assert.equal((await runtimeCommand(db, 'inspect')).success, true);
  } finally {
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('socket workers run the actual installed Pi SDK with offline decisions and responses', { timeout: 180000 }, async context => {
  const pi = await discoverPi();
  if (!pi) { context.skip('Pi SDK is not installed'); return; }
  const directory = mkdtempSync(join(tmpdir(), 'harness-pi-socket-test-'));
  const db = join(directory, 'lab.sqlite');
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime({ db, subagentDemo: true, worker: { mode: 'pi-faux', packagePath: pi.packagePath } });
    await runtime.idle();
    const status = await runtimeCommand(db, 'status');
    assert.equal(status.error, null);
    assert.equal(status.socketReceipts, 2);
    const report = await runtimeCommand(db, 'inspect');
    assert.equal(report.worker, 'pi-faux');
    assert.equal(report.success, true);
    assert.equal(report.metrics.workerCalls, 3);
    assert.equal(report.metrics.subagentCalls, 1);
    assert.equal(report.metrics.subagentsCompleted, 1);
    assert.deepEqual(status.activeSubagentPids, []);
  } finally {
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent-created helper uses its own process, exits, and is not respawned after restart', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-subagent-runtime-'));
  const db = join(directory, 'lab.sqlite');
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime({ db, subagentDemo: true });
    await runtime.idle();
    const status = runtime.status();
    assert.equal(status.error, null);
    assert.equal(status.subagents.length, 1);
    assert.equal(status.subagents[0].parent, 'reviewer');
    assert.equal(status.subagents[0].status, 'completed');
    assert.deepEqual(status.activeSubagentPids, []);
    const exported = await runtimeCommand(db, 'export');
    const start = exported.events.find((event: any) => event.kind === 'subagent.process.started').data;
    assert.ok(start.pid && start.pid !== process.pid);
    assert.ok(status.agents.every(agent => agent.pid !== start.pid));
    assert.ok(exported.events.some((event: any) => event.kind === 'subagent.process.stopped' && event.data.pid === start.pid));
    assert.equal(exported.report.success, true);
    const runId = runtime.runId;
    assert.match(readFileSync(join(directory, 'boards', runId, 'subagents', status.subagents[0].id + '.md'), 'utf8'), /Advisory only/);
    await runtime.close();
    runtime = await startRuntime({ db, runId });
    await runtime.idle();
    const resumed = await runtimeCommand(db, 'export');
    assert.equal(resumed.events.filter((event: any) => event.kind === 'subagent.process.started').length, 1);
    assert.equal(resumed.report.success, true);
  } finally {
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cancelling helper startup terminates its process and releases the runtime slot', { timeout: 15000 }, async () => {
  const controller = new AbortController();
  const active = new Set<ChildProcess>();
  const events: { kind: string; data: any }[] = [];
  const pending = runSubagentProcess({ mode: 'scripted' }, {
    context: { id: 'sub-cancel', parent: 'analyst', depth: 1, name: 'checker', task: 'Inspect', evidenceRefs: [], evidence: [] },
    signal: controller.signal,
  }, active, (kind, data) => { events.push({ kind, data }); });
  controller.abort();
  await assert.rejects(pending, /cancel|exited/i);
  assert.equal(active.size, 0);
  assert.equal(events.filter(event => event.kind === 'subagent.process.stopped').length, 1);
});
