import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { request } from 'node:http';
import { startDashboard } from '../src/dashboard.ts';
import { startRuntime, runtimeCommand, descriptorPath } from '../src/runtime.ts';
import { backupTestExample } from '../src/intel-updates.ts';
import { discoverPi } from '../src/pi.ts';

test('dashboard is local, authenticated, rejects cross-origin mutation, and serves only fixed assets', async () => {
  const calls: unknown[] = [];
  const dashboard = await startDashboard({ snapshot: () => ({ marker: '<script>unsafe</script>' }), act: (action, data) => { calls.push({ action, data }); return { ok: true }; } });
  const url = new URL(dashboard.url), authorization = 'Bearer ' + url.hash.slice(1);
  try {
    const page = await fetch(url.origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const script = await (await fetch(url.origin + '/app.js')).text();
    assert.ok(!/innerHTML|eval\(/.test(script), 'untrusted evidence is rendered as text');
    assert.equal((await fetch(url.origin + '/api/state')).status, 401);
    assert.equal((await fetch(url.origin + '/api/state', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(url.origin + '/api/state', { headers: { Authorization: authorization } })).status, 200);
    assert.equal((await fetch(url.origin + '/api/inject', { method: 'POST', headers: { Authorization: authorization, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url.origin + '/api/inject', { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const headers = { Authorization: authorization, Origin: url.origin, 'Content-Type': 'application/json' };
    assert.equal((await fetch(url.origin + '/api/inject', { method: 'POST', headers, body: 'invalid json' })).status, 400);
    assert.equal((await fetch(url.origin + '/api/inject', { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(33000) }) })).status, 413);
    const chunked = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url.origin + '/api/inject', { method: 'POST', headers }, response => {
        response.resume(); resolve(response.statusCode);
      });
      req.on('error', reject);
      req.write('x'.repeat(20000));
      req.end('x'.repeat(20000));
    });
    assert.equal(chunked, 413, 'streamed bodies also receive a clean bounded rejection');
    assert.equal((await fetch(url.origin + '/api/stop', { method: 'POST', headers, body: '{}' })).status, 404);
    assert.equal((await fetch(url.origin + '/api/post', { method: 'POST', headers, body: '{"text":"hello"}' })).status, 200);
    assert.equal(calls.length, 1);
    assert.equal((await fetch(url.origin + '/src/runtime.ts', { headers })).status, 404);
  } finally { await dashboard.close(); }
});

for (const mode of ['scripted', 'pi-faux'] as const) test('dashboard and CLI socket controls revise and resume intel through ' + mode, { timeout: 180000 }, async t => {
  if (mode === 'pi-faux' && (await discoverPi())?.scope !== '@earendil-works') { t.skip('Compatible Pi SDK unavailable'); return; }
  const directory = mkdtempSync(join(tmpdir(), 'harness-dashboard-test-')), db = join(directory, 'lab.sqlite');
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime({ db, scenario: 'intel', dashboard: true, worker: { mode }, timeoutMs: 120000 });
    await runtime.idle();
    const url = new URL(runtime.dashboardUrl!), headers = { Authorization: 'Bearer ' + url.hash.slice(1), Origin: url.origin, 'Content-Type': 'application/json' };
    const before = await runtimeCommand(db, 'inspect');
    for (let n = 0; n < 3; n++) assert.equal((await fetch(url.origin + '/api/state', { headers })).status, 200);
    assert.equal((await runtimeCommand(db, 'inspect')).metrics.decisionCalls, before.metrics.decisionCalls, 'dashboard polling does not wake models');
    const response = await fetch(url.origin + '/api/inject', { method: 'POST', headers, body: JSON.stringify({ source: backupTestExample }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).revision, 2);
    await runtime.idle();
    const revised = await runtimeCommand(db, 'inspect');
    assert.equal(revised.assessmentRevision, 2); assert.equal(revised.success, true);
    assert.equal(revised.metrics.workerCalls, 6);
    const state: any = await (await fetch(url.origin + '/api/state', { headers })).json();
    assert.equal(state.assessments[0].state, 'superseded');
    assert.equal(state.assessments[1].state, 'complete');
    assert.equal(state.assessments[1].analysis.data.claims.find((item: any) => item.id === 'backup-ready').status, 'confirmed');
    assert.equal(state.assessments[1].report.data.recommendation, 'hold');
    const status = await runtimeCommand(db, 'status');
    const history = join(status.boardDirectory, 'assessments');
    assert.ok(existsSync(join(history, 'revision-1/report.json')));
    assert.ok(existsSync(join(history, 'revision-2/report.json')));
    assert.equal(JSON.parse(readFileSync(join(history, 'index.json'), 'utf8')).currentRevision, 2);
    const duplicate = await runtimeCommand(db, 'inject', { source: backupTestExample });
    assert.equal(duplicate.duplicate, true);
    await runtime.idle();
    assert.equal((await runtimeCommand(db, 'inspect')).metrics.workerCalls, 6);
    const message = await fetch(url.origin + '/api/dm', { method: 'POST', headers, body: JSON.stringify({ to: 'reviewer', text: 'What changed in revision two?' }) });
    assert.equal(message.status, 200); await runtime.idle();
    const after = await runtimeCommand(db, 'inspect');
    const runId = runtime.runId;
    await runtime.close();
    assert.equal(existsSync(descriptorPath(db)), false);
    runtime = await startRuntime({ db, runId, dashboard: true });
    await runtime.idle();
    const resumed = await runtimeCommand(db, 'inspect');
    assert.equal(resumed.success, true); assert.equal(resumed.assessmentRevision, 2);
    assert.equal(resumed.metrics.decisionCalls, after.metrics.decisionCalls);
  } finally {
    await runtime?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('harness-dashboard-test-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
