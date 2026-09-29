import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPiWorker, discoverPi } from '../src/pi.ts';
import type { WorkRequest, WorkResult } from '../src/types.ts';

const installation = await discoverPi();
const offlineSdk = { skip: installation?.scope !== '@earendil-works' ? 'Installed Pi SDK unavailable' : false };

function request(stage: WorkRequest['stage'] = 'analyze'): WorkRequest {
  return {
    stage,
    context: {
      taskId: 'fixture-task', objective: 'Compare synthetic service inventories.',
      stateVersion: 0, ownershipEpoch: 0, inputs: [], recentMessages: [],
      outputContract: 'Return data and summary for the requested inventory stage.', maxChars: 16_000,
    },
  };
}

async function faux(responses: WorkResult[], extra: { timeoutMs?: number } = {}) {
  return createPiWorker({
    packagePath: installation!.packagePath, provider: 'faux', model: 'fixture',
    fixtureResponses: responses, ...extra,
  });
}

test('an explicit missing SDK path fails with installation guidance', async () => {
  await assert.rejects(createPiWorker({
    provider: 'faux', model: 'fixture', packagePath: join(tmpdir(), randomUUID(), 'missing'),
  }), /Pi installation not found.*PI_PACKAGE_PATH/);
});

test('actual Pi Agent and faux provider return bounded structured output offline', offlineSdk, async () => {
  const expected = { data: { discrepancies: [] }, summary: 'Inventories agree.' };
  const worker = await faux([expected]);
  const result = await worker(request());
  assert.deepEqual(result.data, expected.data);
  assert.equal(result.summary, expected.summary);
  assert.ok(Number.isFinite(result.usage!.input));
  assert.ok(Number.isFinite(result.usage!.output));
});

test('each actual Pi Agent request settles and subsequent stages use their own response', offlineSdk, async () => {
  const worker = await faux([
    { data: { discrepancies: [] }, summary: 'Analysis complete.' },
    { data: { approved: true, issues: [], analysisRef: 'analysis-1' }, summary: 'Review complete.' },
  ]);
  assert.equal((await worker(request('analyze'))).summary, 'Analysis complete.');
  assert.equal((await worker(request('review'))).summary, 'Review complete.');
});

test('model-reported usage is replaced with actual SDK usage', offlineSdk, async () => {
  const worker = await faux([{ data: {}, summary: 'Done.', usage: { input: -999, output: -999 } }]);
  const result = await worker(request());
  assert.ok(result.usage!.input >= 0);
  assert.ok(result.usage!.output >= 0);
});

test('actual SDK text still must satisfy the response schema', offlineSdk, async () => {
  const missingData = await faux([{ data: undefined, summary: 'Missing required data.' }]);
  await assert.rejects(missingData(request()), /containing data and summary/);
  const oversizedSummary = await faux([{ data: {}, summary: 'x'.repeat(2_001) }]);
  await assert.rejects(oversizedSummary(request()), /at most 2,000/);
});

test('pre-cancelled requests never consume a faux model response', offlineSdk, async () => {
  const worker = await faux([{ data: {}, summary: 'Still available.' }]);
  const cancelled = request();
  cancelled.signal = AbortSignal.abort();
  await assert.rejects(worker(cancelled), /abort/i);
  assert.equal((await worker(request())).summary, 'Still available.');
});

test('unbounded fixture context is rejected before a model request', offlineSdk, async () => {
  const worker = await faux([{ data: {}, summary: 'Still available.' }]);
  const large = request();
  large.context.objective = 'x'.repeat(65_537);
  await assert.rejects(worker(large), /context exceeds/);
  assert.equal((await worker(request())).summary, 'Still available.');
});

test('invalid provider, model and timeout produce clear errors', offlineSdk, async () => {
  const packagePath = installation!.packagePath;
  await assert.rejects(createPiWorker({ packagePath, provider: 'unknown-fixture-provider', model: 'unknown' }), /Unknown Pi provider/);
  await assert.rejects(createPiWorker({ packagePath, provider: 'openai', model: 'unknown-fixture-model' }), /absent from the installed built-in catalog/);
  await assert.rejects(createPiWorker({ packagePath, provider: 'faux', model: 'fixture', timeoutMs: 0 }), /timeoutMs/);
});

test('faux mode requires explicit offline fixture responses', offlineSdk, async () => {
  await assert.rejects(createPiWorker({ packagePath: installation!.packagePath, provider: 'faux', model: 'fixture' }), /fixtureResponses/);
});
