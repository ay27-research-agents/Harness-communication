import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kernel } from '../src/kernel.ts';
import { TopicBoard, validateDecision } from '../src/board.ts';
import { features } from '../src/features.ts';
import { backupTestExample } from '../src/intel-updates.ts';
import { MemoryJournal } from '../src/store.ts';
import { usageReport } from '../src/usage.ts';
import { presets, runBenchmark } from '../src/benchmark.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

for (const preset of presets) test('feature configuration completes with permitted channels: ' + preset.name, async () => {
  const kernel = new Kernel({ topology: 'pubsub', scenario: 'intel', features: preset.features });
  await new TopicBoard(kernel).run();
  assert.equal(kernel.report().success, true);
  const board = kernel.report().board!;
  if (!preset.features.directMessages) assert.equal(board.directMessages.length, 0);
  if (!preset.features.sharedSubjects) {
    assert.equal(board.topics.length, 2);
    assert.equal(board.updates.filter(p => ['analyst','reviewer','reporter'].includes(p.author)).length, 0);
    assert.ok(board.directMessages.length > 0);
  }
  if (!preset.features.helpers) assert.equal(board.subagents.length, 0);
});

test('disabled features reject actions and resume cannot silently change them', async () => {
  const journal = new MemoryJournal();
  const kernel = new Kernel({ journal, topology:'pubsub', scenario:'intel', features: { directMessages:false,sharedSubjects:false,helpers:false,newIntelligence:false } });
  const board = new TopicBoard(kernel, {allowIdle:true}); await board.run();
  assert.equal(kernel.report().success,false);
  assert.throws(() => board.direct('analyst','hello'), /disabled/);
  assert.throws(() => board.post('intel-brief','hello'), /disabled/);
  assert.throws(() => board.inject(backupTestExample), /disabled/);
  assert.throws(() => new Kernel({journal,runId:kernel.runId,features:{directMessages:true}}), /mismatch: features/);
  const context = (kernel.events.find(e => e.kind === 'board.turn')!.data as any).context;
  assert.equal(context.evidence.length,3);
  const decision = {subscriptions:[],createTopics:[],publish:[],work:null,status:'waiting',reason:'test'};
  assert.throws(() => validateDecision({...decision,directMessages:[{to:'reviewer',text:'hello',evidenceRefs:[]}]},context),/disabled/);
  assert.throws(() => validateDecision({...decision,createTopics:[{id:'extra',title:'extra',description:'extra'}]},context),/disabled/);
  assert.throws(() => features({unknown:true}),/Unknown/);
  assert.throws(() => features({toString:true}),/Unknown/);
});

test('direct-only agents receive added intelligence privately and reassess', async () => {
  const kernel = new Kernel({ topology:'pubsub', scenario:'intel', features:{sharedSubjects:false,helpers:false} });
  const board = new TopicBoard(kernel); await board.run();
  const added = board.inject(backupTestExample);
  assert.equal(kernel.report().success, false);
  await board.run();
  assert.equal(kernel.report().success, true);
  assert.equal(kernel.report().assessmentRevision, 2);
  assert.ok(kernel.report().board!.directMessages.some(message => message.evidenceRefs.includes(added.artifactRef)));
  const analysis = kernel.currentArtifacts.find(item => item.kind === 'analysis')!.data as any;
  assert.equal(analysis.claims.find((item:any) => item.id === 'backup-ready').status, 'confirmed');
});

test('usage separates activity and cache totals and flags missing responses', () => {
  const journal = new MemoryJournal();
  journal.append('usage', [
    {kind:'task',data:{id:'analysis',owner:'analyst'}},
    {kind:'attempt.started',data:{taskId:'analysis',attempt:1}},
    {kind:'worker.response',data:{taskId:'analysis',attempt:1,usage:{input:100,output:20,cacheRead:30,cacheWrite:5}}},
    {kind:'board.turn',data:{id:'reviewer-1',agent:'reviewer'}},
    {kind:'board.attempt.started',data:{turnId:'reviewer-1',attempt:1}},
    {kind:'task',data:{id:'analysis',owner:'reporter'}},
    {kind:'attempt.started',data:{taskId:'analysis',attempt:2}},
    {kind:'worker.response',data:{taskId:'analysis',attempt:2,usage:{input:0,output:7}}},
  ]);
  const result = usageReport(journal.read('usage'),'pi:example/model');
  assert.equal(result.total.input,100);
  assert.equal(result.total.cacheRead,30);
  assert.equal(result.total.missingUsage,1);
  assert.equal(result.byAgent.analyst!.output,20);
  assert.equal(result.byAgent.reporter!.output,7);
  assert.equal(result.byActivity.decision!.missingUsage,1);
  assert.equal(result.complete,false);
});

test('benchmark persists settings, incomplete trials and CSV without fabricating success', async () => {
  const directory = mkdtempSync(join(tmpdir(),'harness-benchmark-'));
  try {
    const result = await runBenchmark({directory, worker:{mode:'scripted'},repeats:1, configurations:[{name:'isolated', features:{directMessages:false,sharedSubjects:false,helpers:false}}]});
    assert.equal(result.rows.length,1);
    assert.equal(result.rows[0]!.success,false);
    assert.equal(result.summary[0]!.tokensPerSuccess,null);
    assert.equal(result.rows[0]!.report.usage.measurement,'no-model');
    assert.match(readFileSync(join(result.directory,'results.csv'),'utf8'),/isolated/);
    assert.equal(JSON.parse(readFileSync(join(result.directory,'results.json'),'utf8')).settings[0].features.sharedSubjects,false);
  } finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    rmSync(directory,{recursive:true,force:true});
  }
});
