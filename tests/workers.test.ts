import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleFixture } from "../src/fixtures.ts";
import type { Artifact, ContextPackage, Stage, WorkResult } from "../src/types.ts";
import { evaluateReport, scriptedWorker, validateResult } from "../src/workers.ts";

function artifact(kind: string, data: unknown): Artifact {
  return {
    id: `artifact-${kind}`, kind, data, producer: "test", taskId: "task-test", hash: "test-hash",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function context(inputs: Artifact[]): ContextPackage {
  return {
    taskId: "task-test", objective: "Compare supplied offline inventories", stateVersion: 1,
    ownershipEpoch: 1, inputs, recentMessages: [], outputContract: "test", maxChars: 10000,
  };
}

async function pipeline(fixture = sampleFixture): Promise<Artifact[]> {
  const inputs = [artifact("fixture", fixture)];
  for (const [stage, kind] of [["analyze", "analysis"], ["review", "review"], ["report", "report"]] as const) {
    const result = await scriptedWorker({ stage, context: context(inputs) });
    validateResult(stage, result, inputs);
    inputs.push(artifact(kind, result.data));
  }
  return inputs;
}

test("scripted workers produce reproducible grounded findings and report", async () => {
  const artifacts = await pipeline();
  assert.deepEqual(artifacts[1]!.data, { discrepancies: [
    { asset: "catalog", missing: ["metrics"], unexpected: [], evidenceRefs: ["artifact-fixture"] },
    { asset: "reporting", missing: [], unexpected: ["debug"], evidenceRefs: ["artifact-fixture"] },
  ] });
  assert.deepEqual(evaluateReport(artifacts), { success: true, issues: [] });
  assert.deepEqual(await pipeline(), artifacts);
});

test("matching inventories produce a valid report with no discrepancies", async () => {
  const artifacts = await pipeline({ name: "matching", expected: sampleFixture.expected, observed: sampleFixture.expected });
  assert.deepEqual(artifacts[1]!.data, { discrepancies: [] });
  assert.deepEqual(evaluateReport(artifacts), { success: true, issues: [] });
});

test("assets present on only one side are included in the comparison", async () => {
  const artifacts = await pipeline({
    name: "added-and-removed", expected: [{ asset: "removed", services: ["api"] }],
    observed: [{ asset: "added", services: ["worker"] }],
  });
  assert.deepEqual(artifacts[1]!.data, { discrepancies: [
    { asset: "added", missing: [], unexpected: ["worker"], evidenceRefs: ["artifact-fixture"] },
    { asset: "removed", missing: ["api"], unexpected: [], evidenceRefs: ["artifact-fixture"] },
  ] });
});

test("analysis rejects malformed schemas, fabricated or omitted findings, and bad evidence", async () => {
  const inputs = [artifact("fixture", sampleFixture)];
  const result = await scriptedWorker({ stage: "analyze", context: context(inputs) });
  const cases: unknown[] = [null, [], {}, { discrepancies: "none" }, { discrepancies: [] }];
  for (const data of cases) assert.throws(() => validateResult("analyze", { ...result, data }, inputs), /Validation failed/);
  for (const mutate of [
    (data: any) => { data.discrepancies[0].missing = ["fabricated"]; },
    (data: any) => { data.discrepancies[0].evidenceRefs = []; },
    (data: any) => { data.discrepancies[0].evidenceRefs = ["wrong-artifact"]; },
    (data: any) => { data.discrepancies[0].extra = true; },
    (data: any) => { data.discrepancies.push(data.discrepancies[0]); },
  ]) {
    const candidate = structuredClone(result);
    mutate(candidate.data);
    assert.throws(() => validateResult("analyze", candidate, inputs), /Validation failed/);
  }
});

test("fixture validation rejects duplicate assets and malformed service lists", async () => {
  for (const fixture of [
    { ...sampleFixture, expected: [sampleFixture.expected[0], sampleFixture.expected[0]] },
    { ...sampleFixture, observed: [{ asset: "catalog", services: ["api", "api"] }] },
    { ...sampleFixture, observed: [{ asset: "catalog", services: "api" }] },
  ]) {
    await assert.rejects(scriptedWorker({ stage: "analyze", context: context([artifact("fixture", fixture)]) }), /Validation failed/);
  }
});

test("review rejects wrong evidence and approval accompanied by unresolved issues", async () => {
  const artifacts = await pipeline();
  const inputs = artifacts.slice(0, 2);
  for (const data of [
    { approved: true, issues: [], analysisRef: "wrong" },
    { approved: true, issues: ["unresolved"], analysisRef: "artifact-analysis" },
    { approved: "true", issues: [], analysisRef: "artifact-analysis" },
    { approved: false, issues: [], analysisRef: "artifact-analysis" },
  ]) assert.throws(() => validateResult("review", { data, summary: "review" }, inputs), /Validation failed/);
});

test("report requires approved review, correct count, and complete evidence references", async () => {
  const artifacts = await pipeline();
  const inputs = artifacts.slice(0, 3);
  const result = { data: artifacts[3]!.data, summary: "report" };
  for (const mutate of [
    (data: any) => { data.discrepancyCount = 900; },
    (data: any) => { data.evidenceRefs = ["artifact-analysis"]; },
    (data: any) => { data.text = ""; },
  ]) {
    const candidate = structuredClone(result);
    mutate(candidate.data);
    assert.throws(() => validateResult("report", candidate, inputs), /Validation failed/);
  }
  const rejected = structuredClone(inputs);
  rejected[2]!.data = { approved: false, issues: ["Manual review required"], analysisRef: "artifact-analysis" };
  assert.throws(() => validateResult("report", result, rejected), /approved review/);
});

test("evaluator rechecks upstream findings instead of trusting an approved review", async () => {
  const artifacts = await pipeline();
  (artifacts[1]!.data as any).discrepancies[0].missing = ["fabricated"];
  assert.equal(evaluateReport(artifacts).success, false);
  assert.match(evaluateReport(artifacts).issues[0]!, /unsupported discrepancy/);
  assert.equal(evaluateReport(artifacts.filter((entry) => entry.kind !== "review")).success, false);
});

test("aborted work cannot produce a result", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scriptedWorker({
    stage: "analyze", context: context([artifact("fixture", sampleFixture)]), signal: controller.signal,
  }), { name: "AbortError" });
});

test("invalid work result envelope and unknown stages are rejected", () => {
  const inputs = [artifact("fixture", sampleFixture)];
  assert.throws(() => validateResult("analyze", null as unknown as WorkResult, inputs), /must be an object/);
  assert.throws(() => validateResult("analyze", { data: {}, summary: "" }, inputs), /nonempty string/);
  assert.throws(() => validateResult("analyze", { data: {}, summary: "test", usage: { input: -1, output: 0 } }, inputs), /nonnegative integer/);
  assert.throws(() => validateResult("unknown" as Stage, { data: {}, summary: "test" }, inputs), /unknown worker stage/);
});
