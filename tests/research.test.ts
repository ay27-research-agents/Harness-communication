import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectUsage,researchTables} from '../src/research.ts';
import {MemoryJournal} from '../src/store.ts';
import {Kernel} from '../src/kernel.ts';
import {TopicBoard} from '../src/board.ts';
import {runBenchmark,summarize} from '../src/benchmark.ts';

test('missing token counters stay unavailable; cached tokens counted exactly once',()=>{
  assert.equal(collectUsage([]),undefined);
  assert.equal(collectUsage([undefined]),undefined);
  assert.equal(collectUsage([{input:10}]),undefined);
  assert.equal(collectUsage([{input:-1,output:2}]),undefined);
  assert.equal(collectUsage([{input:10,output:2},null]),undefined);
  assert.deepEqual(collectUsage([{input:10,output:2,cacheRead:4,cacheWrite:1}]),{input:15,output:2,cacheRead:4,cacheWrite:1});
  assert.deepEqual(collectUsage([{input:0,output:0}]),{input:0,output:0});
});
test('one publication exposes twice across retries without counting two publications; run IDs isolate joins',()=>{
  const journal=new MemoryJournal();
  const telemetry={callId:'one',startedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:00:01Z',elapsedMs:1000,prompt:'{"id":"post-1"}',systemPrompt:'',rawResponse:[],rawUsage:[],usageSource:'provider-reported',provider:'test',model:'test'};
  journal.append('run-a',[
    {kind:'board.update',data:{id:'post-1',topicId:'subject',author:'analyst',text:'café',evidenceRefs:[]}},
    {kind:'board.turn',data:{id:'turn',agent:'reviewer',context:{inbox:[{id:'post-1'}],directInbox:[]}}},
    {kind:'board.attempt.started',data:{turnId:'turn',attempt:1}},
    {kind:'board.response',data:{turnId:'turn',attempt:1,usage:{input:10,output:3},telemetry}},
    {kind:'board.attempt.failed',data:{turnId:'turn',attempt:1,error:'bad JSON',elapsedMs:1001}},
    {kind:'board.attempt.started',data:{turnId:'turn',attempt:2}},
    {kind:'board.response',data:{turnId:'turn',attempt:2,usage:null,telemetry:{...telemetry,callId:'two'}}},
    {kind:'board.decision',data:{turnId:'turn',attempt:2,elapsedMs:1100}},
    {kind:'receipt',data:{key:'board:reviewer:post-1'}},
  ]);
  journal.append('run-b',[{kind:'board.turn',data:{id:'turn',agent:'reporter',context:{inbox:[],directInbox:[]}}},{kind:'board.attempt.started',data:{turnId:'turn',attempt:1}}]);
  const tables=researchTables([...journal.read('run-a'),...journal.read('run-b')]);
  assert.equal(tables.messages.length,1);
  assert.equal(tables.messages[0].contentBytes,5);
  assert.equal(tables.messageEvents.filter(e=>e.event==='included-in-model-request').length,2);
  assert.equal(tables.calls[0].inputTokens,10);
  assert.equal(tables.calls[0].outcome,'failed');
  assert.equal(tables.calls[1].inputTokens,null);
  assert.equal(tables.calls[2].inputTokens,null);
  assert.equal(tables.calls[2].agent,'reporter');
});
test('failed decision usage is journaled and included before retry; missing usage invalidates aggregate comparison',async()=>{
  const kernel=new Kernel({topology:'pubsub',scenario:'intel',workerLabel:'pi:test/model',maxAttempts:1});
  const board=new TopicBoard(kernel,{decide:async()=>({data:null,summary:'failed',usage:{input:11,output:7},inferenceError:'Invalid JSON'})});
  await assert.rejects(board.run(),/Invalid JSON/);
  const calls=researchTables(kernel.events).calls;
  assert.equal(calls[0].outcome,'failed');
  assert.equal(calls[0].inputTokens,11);
  assert.equal(kernel.report().usage.total.output,7);
  const report=kernel.report();report.usage.complete=false;
  const summary=summarize([{configuration:'x',trial:1,runId:kernel.runId,success:false,elapsedMs:1,error:'bad',report}]);
  assert.equal(summary[0].meanTokens,null);
  assert.equal(summary[0].observedTokens,18);
});
test('benchmark writes auditable tables and source fingerprints',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'research-test-'));
  try {
    const result=await runBenchmark({directory:dir,worker:{mode:'scripted'},repeats:1,configurations:[{name:'combined',features:{helpers:false}}]});
    for(const file of ['calls.csv','messages.csv','message-events.csv','trials.csv','events.jsonl','transcripts.jsonl'])assert.ok(readFileSync(join(result.directory,file),'utf8').length);
    const manifest=JSON.parse(readFileSync(join(result.directory,'manifest.json'),'utf8'));
    assert.ok(manifest.sourceHashes['pi.ts']);
    assert.equal(manifest.settings.transport,'inline');
    assert.equal(manifest.trials[0].runId,result.rows[0].runId);
    const events=readFileSync(join(result.directory,'events.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
    const tables=researchTables(events);
    assert.equal(tables.messages.filter(m=>m.channel==='subject').length,result.rows[0].report.metrics.publications);
    assert.equal(tables.messages.filter(m=>m.channel==='direct').length,result.rows[0].report.metrics.directMessages);
    assert.equal(tables.messageEvents.filter(e=>e.event==='included-in-model-request').length,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
