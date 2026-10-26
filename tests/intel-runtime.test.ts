import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime, runtimeCommand, descriptorPath } from '../src/runtime.ts';
import { discoverPi } from '../src/pi.ts';
import type { BoardContext } from '../src/board-types.ts';

for (const mode of ['scripted', 'pi-faux'] as const) {
  test('intel socket runtime: ' + mode + ' exchanges evidence, returns a helper, wakes, and resumes', { timeout: 180000 }, async t => {
    if (mode === 'pi-faux' && (await discoverPi())?.scope !== '@earendil-works') { t.skip('Compatible Pi SDK unavailable'); return; }
    const directory = mkdtempSync(join(tmpdir(), 'harness-intel-runtime-'));
    const db = join(directory, 'lab.sqlite');
    let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
    try {
      runtime = await startRuntime({ db, scenario: 'intel', worker: { mode }, timeoutMs: 120000 });
      await runtime.idle();
      const status = await runtimeCommand(db, 'status');
      assert.equal(status.error, null);
      assert.equal(status.scenario, 'intel');
      assert.equal(new Set(status.agents.map((item: any) => item.pid)).size, 3);
      assert.equal(status.directMessages, 2);
      assert.equal(status.socketReceipts, 2);
      assert.deepEqual(status.activeSubagentPids, []);
      const initial = await runtimeCommand(db, 'export');
      assert.equal(initial.report.success, true, JSON.stringify(initial.report.issues));
      assert.equal(initial.report.metrics.subagentsCompleted, 1);
      const receipt = initial.events.filter((event: any) => event.kind === 'board.direct.received');
      assert.ok(receipt.every((event: any) => event.data.mode === 'socket' && event.data.senderPid !== event.data.receiverPid));
      assert.ok(initial.events.some((event: any) => event.kind === 'subagent.process.started'));
      assert.ok(initial.events.some((event: any) => event.kind === 'subagent.process.stopped'));
      if (mode === 'pi-faux') assert.equal(initial.report.metrics.attemptsWithoutUsage, 0);
      await assert.rejects(runtimeCommand(db, 'resume', { scenario: 'inventory' }), /mismatch: scenario/);
      // A direct note wakes only its recipient; the scripted policy does not invent new evidence.
      const message = await runtimeCommand(db, 'dm', { to: 'reporter', text: 'Please retain the unresolved backup question. This note is not a new measurement.' });
      await runtime.idle();
      const after = await runtimeCommand(db, 'export');
      const readers = after.events.filter((event: any) => event.kind === 'board.turn')
        .map((event: any) => event.data.context as BoardContext)
        .filter((context: BoardContext) => context.directInbox?.some(item => item.id === message.id)).map((context: BoardContext) => context.agent);
      assert.deepEqual(readers, ['reporter']);
      assert.equal(after.report.metrics.decisionCalls, initial.report.metrics.decisionCalls + 1);
      assert.equal(after.report.metrics.workerCalls, 3);
      assert.equal(after.report.success, true);
      const runId = runtime.runId;
      await runtime.close();
      assert.equal(existsSync(descriptorPath(db)), false);
      runtime = await startRuntime({ db, runId });
      await runtime.idle();
      const resumed = await runtimeCommand(db, 'inspect');
      assert.equal(resumed.scenario, 'intel');
      assert.equal(resumed.worker, mode);
      assert.equal(resumed.success, true);
      assert.equal(resumed.metrics.decisionCalls, after.report.metrics.decisionCalls);
      await runtime.close();
      runtime = undefined;
      await assert.rejects(startRuntime({ db, runId, scenario: 'inventory' }), /mismatch: scenario/);
      assert.equal(existsSync(descriptorPath(db)), false);
    } finally { await runtime?.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
