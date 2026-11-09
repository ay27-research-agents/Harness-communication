import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { startRuntime, runtimeCommand } from '../src/runtime.ts';

test('authenticated operator controls restrict subjects and cancel durably', {timeout:120000}, async () => {
  const directory = mkdtempSync(join(tmpdir(),'operation-controls-'));
  const db = join(directory,'run.sqlite');
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime({db,scenario:'intel',worker:{mode:'scripted'},requireApproval:true});
    await runtime.idle();
    assert.equal((await runtimeCommand(db,'inspect')).success,false);
    for (const [taskId,to,stage] of [['analysis','analyst','analyze'],['review','reviewer','review'],['report','reporter','report']]) {
      await runtimeCommand(db,'authorize',{taskId,to,stage,metadata:{expiresAt:new Date(Date.now()+60000).toISOString()}});
    }
    await runtimeCommand(db,'resume');
    await runtime.idle();
    assert.equal((await runtimeCommand(db,'inspect')).success,true);
    await runtimeCommand(db,'access',{topic:'intel-brief',readers:['analyst'],writers:['analyst']});
    await assert.rejects(runtimeCommand(db,'dm',{to:'reviewer',topic:'intel-brief',text:'Denied'}),/denied/);
    const message = await runtimeCommand(db,'dm',{to:'analyst',text:'Check evidence',metadata:{messageType:'question'}});
    assert.equal(message.messageType,'question');
    const result = await runtimeCommand(db,'cancel',{text:'Exercise stopped'});
    assert.equal(result.cancelled,true);
    const exported = await runtimeCommand(db,'export');
    assert.ok(exported.events.some((event:any) => event.kind === 'operation.cancellation-acknowledged'));
    await assert.rejects(runtimeCommand(db,'dm',{to:'analyst',text:'After cancellation'}),/cancelled/);
  } finally {
    await runtime?.close();
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    rmSync(directory,{recursive:true,force:true});
  }
});
