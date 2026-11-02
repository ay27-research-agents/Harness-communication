import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kernel } from '../src/kernel.ts';
import { TopicBoard } from '../src/board.ts';
import { scriptedBoardDecider } from '../src/board-policy.ts';
import { scriptedWorker } from '../src/workers.ts';
import { scriptedSubagentWorker } from '../src/subagents.ts';
import { MemoryJournal } from '../src/store.ts';
import { backupTestExample } from '../src/intel-updates.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startRuntime, runtimeCommand } from '../src/runtime.ts';

test('concurrent socket agents complete, deliver once, and resume with their saved limit', {timeout:120000}, async () => {
  const directory = mkdtempSync(join(tmpdir(),'harness-concurrency-'));
  const db = join(directory,'lab.sqlite');
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime({db,scenario:'intel',maxConcurrentAgents:3,worker:{mode:'scripted'}});
    await runtime.idle();
    const exported = await runtimeCommand(db,'export');
    assert.equal(exported.report.success,true);
    assert.equal(exported.report.maxConcurrentAgents,3);
    const receipts = exported.events.filter((e:any) => e.kind === 'board.direct.received').map((e:any) => e.data.id);
    assert.ok(receipts.length > 0);
    assert.equal(new Set(receipts).size,receipts.length);
    await assert.rejects(runtimeCommand(db,'resume',{maxConcurrentAgents:2}),/mismatch/);
    const runId = runtime.runId;
    await runtime.close();
    runtime = await startRuntime({db,runId});
    await runtime.idle();
    assert.equal((await runtimeCommand(db,'inspect')).maxConcurrentAgents,3);
    assert.equal((await runtimeCommand(db,'inspect')).metrics.decisionCalls,exported.report.metrics.decisionCalls);
  } finally {
    await runtime?.close();
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    rmSync(directory,{recursive:true,force:true});
  }
});

const delay = () => new Promise(resolve => setTimeout(resolve, 8));
for (const limit of [1,2,3]) test('agent concurrency is bounded across decisions, work and helpers: ' + limit, async () => {
  let active = 0, peak = 0;
  const agents = new Set<string>();
  const wrap = async (agent:string, action:()=>Promise<any>) => {
    assert.equal(agents.has(agent), false, 'one request per agent');
    agents.add(agent); active++; peak = Math.max(peak, active);
    assert.ok(active <= limit);
    try { await delay(); return await action(); } finally { active--; agents.delete(agent); }
  };
  const kernel = new Kernel({topology:'pubsub',scenario:'intel',maxConcurrentAgents:limit,
    worker: request => wrap(({analyze:'analyst',review:'reviewer',report:'reporter'})[request.stage], () => scriptedWorker(request)) });
  const board = new TopicBoard(kernel, {
    decide: request => wrap(request.context.agent, () => scriptedBoardDecider(request)),
    subagentWorker: request => wrap('helper', () => scriptedSubagentWorker(request))
  });
  await board.run();
  assert.equal(kernel.report().success, true);
  assert.equal(peak, limit, 'independent model requests actually overlap');
  assert.equal(active, 0);
  const calls = kernel.report().metrics.decisionCalls;
  await board.run(); assert.equal(kernel.report().metrics.decisionCalls, calls);
  board.inject(backupTestExample); await board.run();
  assert.equal(kernel.report().success, true);
  assert.equal(kernel.revision, 2);
});

test('concurrency validates, persists, and defaults historical runs to one', () => {
  const journal = new MemoryJournal();
  const kernel = new Kernel({journal,topology:'pubsub',maxConcurrentAgents:2});
  assert.equal(new Kernel({journal,runId:kernel.runId}).maxConcurrentAgents,2);
  assert.throws(() => new Kernel({journal,runId:kernel.runId,maxConcurrentAgents:3}), /mismatch/);
  for (const value of [0,4,1.5,NaN]) assert.throws(() => new Kernel({maxConcurrentAgents:value}),/1..3/);
  const historical = new MemoryJournal();
  historical.append(kernel.runId, kernel.events.map(event => {
    const data = structuredClone(event.data) as any;
    if (event.kind === 'run.started') delete data.maxConcurrentAgents;
    return {kind:event.kind,data};
  }));
  assert.equal(new Kernel({journal:historical,runId:kernel.runId}).maxConcurrentAgents,1);
});

test('scheduler drains in-flight requests after a failure before returning', async () => {
  let active = 0;
  const kernel = new Kernel({topology:'pubsub',scenario:'intel',maxConcurrentAgents:3,maxAttempts:1});
  const board = new TopicBoard(kernel, {decide: async request => {
    active++;
    try {
      if (request.context.agent === 'analyst') throw new Error('injected failure');
      await delay(); return await scriptedBoardDecider(request);
    } finally { active--; }
  }});
  await assert.rejects(board.run());
  assert.equal(active,0);
  const length = kernel.events.length; await delay(); assert.equal(kernel.events.length,length);
});
