import type { Fixture, InventoryRow } from "./fixtures.ts";
import type { Artifact, Stage, Worker, WorkResult } from "./types.ts";

type Discrepancy = {
  asset: string;
  missing: string[];
  unexpected: string[];
  evidenceRefs: string[];
};
type Analysis = { discrepancies: Discrepancy[] };
type Review = { approved: boolean; issues: string[]; analysisRef: string };
type Report = { text: string; discrepancyCount: number; evidenceRefs: string[] };

function fail(message: string): never {
  throw new Error(`Validation failed: ${message}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: string[], name: string): void {
  if (!sameStrings(Object.keys(value), expected)) fail(`${name} has unexpected or missing fields`);
}

function nonemptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail(`${name} must be a nonempty string`);
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  for (const item of value) nonemptyString(item, `${name} item`);
  if (new Set(value).size !== value.length) fail(`${name} must not contain duplicates`);
  return value as string[];
}

function sameStrings(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const sortedExpected = [...expected].sort();
  return [...actual].sort().every((value, index) => value === sortedExpected[index]);
}

function inventoryRows(value: unknown, name: string): InventoryRow[] {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  const assets = new Set<string>();
  return value.map((item, index) => {
    const row = record(item, `${name}[${index}]`);
    keys(row, ["asset", "services"], `${name}[${index}]`);
    nonemptyString(row.asset, `${name}[${index}].asset`);
    if (assets.has(row.asset)) fail(`${name} contains duplicate asset ${row.asset}`);
    assets.add(row.asset);
    return { asset: row.asset, services: strings(row.services, `${name}[${index}].services`) };
  });
}

function fixtureData(value: unknown): Fixture {
  const fixture = record(value, "fixture");
  keys(fixture, ["name", "expected", "observed"], "fixture");
  nonemptyString(fixture.name, "fixture.name");
  return {
    name: fixture.name,
    expected: inventoryRows(fixture.expected, "fixture.expected"),
    observed: inventoryRows(fixture.observed, "fixture.observed"),
  };
}

function oneArtifact(inputs: Artifact[], kind: string): Artifact {
  const matches = inputs.filter((artifact) => artifact.kind === kind);
  if (matches.length !== 1) fail(`exactly one ${kind} artifact is required`);
  const artifact = matches[0]!;
  nonemptyString(artifact.id, `${kind} artifact.id`);
  return artifact;
}

function comparison(fixture: Fixture, fixtureId: string): Analysis {
  const expected = new Map(fixture.expected.map((row) => [row.asset, new Set(row.services)]));
  const observed = new Map(fixture.observed.map((row) => [row.asset, new Set(row.services)]));
  const assets = [...new Set([...expected.keys(), ...observed.keys()])].sort();
  const discrepancies: Discrepancy[] = [];
  for (const asset of assets) {
    const wanted = expected.get(asset) ?? new Set<string>();
    const found = observed.get(asset) ?? new Set<string>();
    const missing = [...wanted].filter((service) => !found.has(service)).sort();
    const unexpected = [...found].filter((service) => !wanted.has(service)).sort();
    if (missing.length || unexpected.length) {
      discrepancies.push({ asset, missing, unexpected, evidenceRefs: [fixtureId] });
    }
  }
  return { discrepancies };
}

function validatedAnalysis(value: unknown, inputs: Artifact[]): Analysis {
  const fixture = oneArtifact(inputs, "fixture");
  const truth = comparison(fixtureData(fixture.data), fixture.id);
  const analysis = record(value, "analysis");
  keys(analysis, ["discrepancies"], "analysis");
  if (!Array.isArray(analysis.discrepancies)) fail("analysis.discrepancies must be an array");
  const assets = new Set<string>();
  const discrepancies = analysis.discrepancies.map((item, index) => {
    const entry = record(item, `discrepancies[${index}]`);
    keys(entry, ["asset", "missing", "unexpected", "evidenceRefs"], `discrepancies[${index}]`);
    nonemptyString(entry.asset, "discrepancy.asset");
    if (assets.has(entry.asset)) fail(`duplicate discrepancy for ${entry.asset}`);
    assets.add(entry.asset);
    const missing = strings(entry.missing, "discrepancy.missing");
    const unexpected = strings(entry.unexpected, "discrepancy.unexpected");
    const evidenceRefs = strings(entry.evidenceRefs, "discrepancy.evidenceRefs");
    if (!sameStrings(evidenceRefs, [fixture.id])) fail("discrepancy evidence must reference the fixture");
    const expected = truth.discrepancies.find((candidate) => candidate.asset === entry.asset);
    if (!expected || !sameStrings(missing, expected.missing) || !sameStrings(unexpected, expected.unexpected)) {
      fail(`unsupported discrepancy for ${entry.asset}`);
    }
    return { asset: entry.asset, missing, unexpected, evidenceRefs };
  });
  if (discrepancies.length !== truth.discrepancies.length) fail("analysis omits a fixture discrepancy");
  return { discrepancies };
}

function validatedReview(value: unknown, inputs: Artifact[]): Review {
  const analysis = oneArtifact(inputs, "analysis");
  validatedAnalysis(analysis.data, inputs);
  const review = record(value, "review");
  keys(review, ["approved", "issues", "analysisRef"], "review");
  if (typeof review.approved !== "boolean") fail("review.approved must be a boolean");
  const issues = strings(review.issues, "review.issues");
  if (review.analysisRef !== analysis.id) fail("review.analysisRef must reference the analysis");
  if (review.approved && issues.length) fail("approved review cannot contain issues");
  if (!review.approved && !issues.length) fail("rejected review must explain an issue");
  return { approved: review.approved, issues, analysisRef: analysis.id };
}

function validatedReport(value: unknown, inputs: Artifact[]): Report {
  const fixture = oneArtifact(inputs, "fixture");
  const analysis = oneArtifact(inputs, "analysis");
  const review = oneArtifact(inputs, "review");
  const approved = validatedReview(review.data, inputs);
  if (!approved.approved) fail("report requires an approved review");
  const findings = validatedAnalysis(analysis.data, inputs);
  const report = record(value, "report");
  keys(report, ["text", "discrepancyCount", "evidenceRefs"], "report");
  nonemptyString(report.text, "report.text");
  if (report.discrepancyCount !== findings.discrepancies.length) fail("report discrepancyCount does not match evidence");
  const evidenceRefs = strings(report.evidenceRefs, "report.evidenceRefs");
  if (!sameStrings(evidenceRefs, [fixture.id, analysis.id, review.id])) fail("report must reference fixture, analysis, and review evidence");
  return { text: report.text, discrepancyCount: findings.discrepancies.length, evidenceRefs };
}

/** Check the structured result against the actual input evidence before accepting it. */
export function validateResult(stage: Stage, result: WorkResult, inputs: Artifact[]): void {
  const envelope = record(result, "work result");
  nonemptyString(envelope.summary, "work result.summary");
  if (envelope.usage !== undefined) {
    const usage = record(envelope.usage, "work result.usage");
    for (const field of ["input", "output"]) {
      if (typeof usage[field] !== "number" || !Number.isSafeInteger(usage[field]) || (usage[field] as number) < 0) {
        fail(`usage.${field} must be a nonnegative integer`);
      }
    }
  }
  if (stage === "analyze") validatedAnalysis(envelope.data, inputs);
  else if (stage === "review") validatedReview(envelope.data, inputs);
  else if (stage === "report") validatedReport(envelope.data, inputs);
  else fail(`unknown worker stage ${String(stage)}`);
}

/** A reproducible, entirely local worker used to isolate protocol behavior from model behavior. */
export const scriptedWorker: Worker = async ({ stage, context, signal }) => {
  signal?.throwIfAborted();
  const fixture = oneArtifact(context.inputs, "fixture");
  const compared = comparison(fixtureData(fixture.data), fixture.id);
  let result: WorkResult;
  if (stage === "analyze") {
    result = { data: compared, summary: `Found ${compared.discrepancies.length} inventory discrepancies.` };
  } else if (stage === "review") {
    const analysis = oneArtifact(context.inputs, "analysis");
    validatedAnalysis(analysis.data, context.inputs);
    result = {
      data: { approved: true, issues: [], analysisRef: analysis.id },
      summary: "Verified all structured findings against the supplied inventory.",
    };
  } else if (stage === "report") {
    const analysis = oneArtifact(context.inputs, "analysis");
    const review = oneArtifact(context.inputs, "review");
    const lines = compared.discrepancies.map((entry) =>
      `${entry.asset}: missing [${entry.missing.join(", ")}]; unexpected [${entry.unexpected.join(", ")}].`);
    result = {
      data: {
        text: lines.length ? lines.join("\n") : "The observed inventory matches the expected inventory.",
        discrepancyCount: compared.discrepancies.length,
        evidenceRefs: [fixture.id, analysis.id, review.id],
      },
      summary: `Reported ${compared.discrepancies.length} verified inventory discrepancies.`,
    };
  } else {
    fail(`unknown worker stage ${String(stage)}`);
  }
  validateResult(stage, result, context.inputs);
  return result;
};

/** Structured evidence validation only; free-form report prose is not semantically scored. */
export function evaluateReport(artifacts: Artifact[]): { success: boolean; issues: string[] } {
  try {
    const report = oneArtifact(artifacts, "report");
    validatedReport(report.data, artifacts);
    return { success: true, issues: [] };
  } catch (error) {
    return { success: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}
