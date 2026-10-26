import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel.ts';
import { MemoryJournal } from '../src/store.ts';
import { TopicBoard, validateDecision } from '../src/board.ts';
import { scriptedBoardDecider } from '../src/board-policy.ts';
import { evaluateIntelReport, intelInputs, intelSourceOwners, sourceId, validateIntelResult } from '../src/intel.ts';
import type { BoardContext, BoardDecision } from '../src/board-types.ts';
import type { Artifact, WorkerId } from '../src/types.ts';

async function completed(options: ConstructorParameters<typeof Kernel>[0] = {}) {
  const kernel = new Kernel({ topology: 'pubsub', scenario: 'intel', ...options });
  await new TopicBoard(kernel).run();
  assert.equal(kernel.report().success, true);
  return kernel;
}
function data(kernel: Kernel, kind: string): any { return structuredClone(kernel.artifacts.find(item => item.kind === kind)!.data); }

test('intel baseline reconciles contradictions, preserves uncertainty, shares subjects, messages, and delegates', async () => {
  const kernel = await completed();
  const report = kernel.report();
  assert.deepEqual(data(kernel, 'analysis').claims.map((item: any) => [item.id, item.status]),
    [['atlas-primary', 'refuted'], ['protected-dependency', 'confirmed'], ['backup-ready', 'unresolved']]);
  assert.equal(data(kernel, 'report').recommendation, 'hold');
  assert.deepEqual(data(kernel, 'report').protectedDependencies, ['medical-telemetry']);
  assert.deepEqual(data(kernel, 'report').unresolvedQuestions, ['backup-ready']);
  assert.equal(report.metrics.workerCalls, 3);
  assert.equal(report.metrics.subagentsCompleted, 1);
  assert.equal(report.metrics.directMessages, 2);
  assert.equal(report.metrics.directProcessed, 2);
  assert.ok(report.metrics.maxDecisionContextChars <= 24000);
  assert.ok(report.board!.updates.some(item => item.topicId === 'route-history' && item.author === 'reviewer'));
  assert.ok(report.board!.agents.every(item => !item.subscriptions.some(sub => sub.topicId === 'announcements')));
  const helper = report.board!.subagents[0]!;
  assert.equal(helper.parent, 'reviewer');
  assert.equal(helper.evidenceRefs.length, 3);
  assert.ok(!helper.evidenceRefs.includes(kernel.artifacts.find(item => sourceId(item) === 'rules-manifest')!.id));
  const contexts = kernel.events.filter(item => item.kind === 'board.turn').map(item => (item.data as { context: BoardContext }).context);
  assert.ok(contexts.filter(context => context.subagents?.length).every(context => context.agent === 'reviewer'));
});

test('intel knowledge is confined to initial grants, own work, and actually delivered references', async () => {
  const kernel = await completed();
  const known = new Map<WorkerId, Set<string>>();
  for (const agent of ['analyst', 'reviewer', 'reporter'] as const) {
    const assignment = kernel.events.find(item => item.kind === 'board.assignment' && (item.data as any).agent === agent)!.data as { evidenceRefs: string[] };
    assert.deepEqual(assignment.evidenceRefs, [kernel.fixture.id,
      ...kernel.artifacts.filter(item => intelSourceOwners[sourceId(item) ?? ''] === agent).map(item => item.id)]);
    assert.ok(assignment.evidenceRefs.length < 5, 'no initial agent has all four sources');
    known.set(agent, new Set(assignment.evidenceRefs));
  }
  for (const event of kernel.events.filter(item => item.kind === 'board.turn')) {
    const context = (event.data as { context: BoardContext }).context;
    const allowed = known.get(context.agent)!;
    for (const item of context.ownWork) allowed.add(item.id);
    for (const ref of [...context.inbox.flatMap(item => item.evidenceRefs), ...context.directInbox!.flatMap(item => item.evidenceRefs)]) allowed.add(ref);
    assert.deepEqual(new Set(context.evidence.map(item => item.id)), allowed, 'no automatic evidence leakage');
    assert.ok(!context.inbox.some(item => item.topicId === 'announcements'));
    if (context.availableWork) assert.ok(intelInputs(context.availableWork, context.evidence));
  }
  const first = (kernel.events.find(item => item.kind === 'board.turn')!.data as { context: BoardContext }).context;
  assert.equal(first.availableWork, null);
  assert.deepEqual(first.evidence.map(sourceId).filter(Boolean), ['archive-map', 'backup-tip']);
  const bad: BoardDecision = { subscriptions: [], status: 'Waiting', reason: 'test', createTopics: [],
    publish: [{ topicId: 'intel-brief', text: 'Leaked source', evidenceRefs: [kernel.artifacts.find(item => sourceId(item) === 'current-log')!.id] }], work: null };
  assert.throws(() => validateDecision(bad, first), /unavailable evidence/);
});

test('intel cannot finish if peers withhold their original sources', async () => {
  const kernel = new Kernel({ topology: 'pubsub', scenario: 'intel' });
  const board = new TopicBoard(kernel, { decide: async request => {
    const result = await scriptedBoardDecider(request);
    const decision = result.data as BoardDecision;
    decision.publish = []; decision.directMessages = []; decision.createTopics = [];
    decision.subscriptions = request.context.catalog.filter(item => item.id === 'intel-brief').map(item => ({ topicId: item.id, reason: 'Read only the brief.' }));
    return result;
  } });
  await assert.rejects(board.run(), /idle without a published/);
  assert.equal(kernel.report().metrics.workerCalls, 0);
  assert.equal(kernel.report().success, false);
});

test('intel succeeds with helpers disabled and resumes without more work or helper calls', async () => {
  const journal = new MemoryJournal();
  const kernel = await completed({ journal, subagentLimit: 0 });
  assert.equal(kernel.report().metrics.subagentCalls, 0);
  const before = kernel.events.length;
  const reopened = new Kernel({ journal, runId: kernel.runId });
  assert.equal(reopened.scenario, 'intel');
  await new TopicBoard(reopened).run();
  assert.equal(reopened.events.length, before);
  assert.equal(reopened.report().success, true);
  assert.throws(() => new Kernel({ journal, runId: kernel.runId, scenario: 'inventory' }), /mismatch: scenario/);
});

test('intel is opt-in, restricted to pubsub, and cannot replace a saved inventory fixture', async () => {
  for (const topology of ['coordinator', 'routed', 'handoff'] as const) {
    assert.throws(() => new Kernel({ topology, scenario: 'intel' }), /requires topic-board/);
  }
  assert.throws(() => new Kernel({ topology: 'pubsub', scenario: 'unknown' as any }), /Unknown scenario/);
  const journal = new MemoryJournal();
  const inventory = new Kernel({ journal, topology: 'pubsub' });
  assert.equal(inventory.scenario, 'inventory');
  assert.throws(() => new Kernel({ journal, runId: inventory.runId, scenario: 'intel' }), /mismatch: scenario/);
});

test('intel rejects unsupported certainty, missing contrary evidence, and invented references', async () => {
  const kernel = await completed();
  for (const status of ['confirmed', 'refuted']) {
    const analysis = data(kernel, 'analysis');
    analysis.claims.find((item: any) => item.id === 'backup-ready').status = status;
    assert.throws(() => validateIntelResult('analyze', { data: analysis, summary: 'bad certainty' }, kernel.artifacts), /unsupported status/);
  }
  const missing = data(kernel, 'analysis');
  missing.claims[0].evidenceRefs = [kernel.artifacts.find(item => sourceId(item) === 'current-log')!.id];
  assert.throws(() => validateIntelResult('analyze', { data: missing, summary: 'missed contradiction' }, kernel.artifacts), /missing or unavailable evidence/);
  const invented = data(kernel, 'analysis');
  invented.claims[2].evidenceRefs.push('invented-scan');
  assert.throws(() => validateIntelResult('analyze', { data: invented, summary: 'invented source' }, kernel.artifacts), /unavailable evidence/);
  const stale = data(kernel, 'analysis'); stale.supersededSourceRefs = [];
  assert.throws(() => validateIntelResult('analyze', { data: stale, summary: 'stale source' }, kernel.artifacts), /superseded route diagram/);
});

test('intel report rejects unsafe-to-fixture conclusions, lost uncertainty, or missing citations', async () => {
  const kernel = await completed();
  for (const [field, value] of [['recommendation', 'proceed'], ['protectedDependencies', []], ['unresolvedQuestions', []], ['evidenceRefs', []]] as const) {
    const report = data(kernel, 'report'); report[field] = value;
    assert.throws(() => validateIntelResult('report', { data: report, summary: 'unsupported assessment' }, kernel.artifacts), /Intel validation/);
    const tampered = kernel.artifacts.map(item => item.kind === 'report' ? { ...item, data: report } : item);
    assert.equal(evaluateIntelReport(tampered).success, false, 'independent evaluator rechecks accepted artifacts');
  }
  const review = data(kernel, 'review'); review.checkedSourceRefs.pop();
  assert.throws(() => validateIntelResult('review', { data: review, summary: 'incomplete review' }, kernel.artifacts), /all four original sources/);
});

test('intel evaluator rejects missing, duplicate, and altered source documents and a disapproved review', async () => {
  const kernel = await completed();
  const sources = kernel.artifacts.filter(item => item.kind === 'intel-source');
  for (const source of sources) assert.equal(evaluateIntelReport(kernel.artifacts.filter(item => item.id !== source.id)).success, false);
  assert.equal(evaluateIntelReport([...kernel.artifacts, sources[0]!]).success, false);
  const tampered: Artifact[] = structuredClone(kernel.artifacts);
  (tampered.find(item => sourceId(item) === 'current-log')!.data as any).observations = 'Everything is ready.';
  assert.equal(evaluateIntelReport(tampered).success, false);
  const disapproved = kernel.artifacts.map(item => item.kind === 'review'
    ? { ...item, data: { ...(item.data as any), approved: false, issues: ['Unresolved review objection'] } } : item);
  assert.equal(evaluateIntelReport(disapproved).success, false);
});

test('intel readable workspace shows original sources, assignments, specialist, and final assessment', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-intel-files-'));
  try {
    const kernel = new Kernel({ topology: 'pubsub', scenario: 'intel' });
    await new TopicBoard(kernel, { directory }).run();
    assert.equal(kernel.report().success, true);
    assert.equal(JSON.parse(readFileSync(join(directory, 'assignments.json'), 'utf8')).length, 3);
    assert.match(readFileSync(join(directory, 'README.md'), 'utf8'), /operator audit view/);
    assert.match(readFileSync(join(directory, 'agents/reviewer/status.md'), 'utf8'), /LANTERN/);
    assert.equal(JSON.parse(readFileSync(join(directory, 'evidence/report.json'), 'utf8')).data.recommendation, 'hold');
    for (const id of Object.keys(intelSourceOwners)) assert.ok(existsSync(join(directory, 'evidence/sources', id + '.json')));
    assert.match(readFileSync(join(directory, 'topics/route-history.md'), 'utf8'), /reviewer/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
