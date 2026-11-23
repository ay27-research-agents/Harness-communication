import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, totalmem, platform, arch, release } from 'node:os';
import type { JournalEvent, WorkResult } from './types.ts';

export interface CallTelemetry {
  callId:string; startedAt:string; finishedAt:string; elapsedMs:number;
  provider:string; model:string; systemPrompt:string; prompt:string;
  rawResponse:unknown[]; rawUsage:any[]; usageSource:string;
  timeToFirstTokenMs:null; adapterVersion:string;
}
const count = (v:unknown):v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
/** Pi counters: input excludes cache counters. Cache values remain optional. */
export function collectUsage(raw:any[]):WorkResult['usage'] {
  if (!raw.length || raw.some(u => !u || !count(u.input) || !count(u.output) ||
      ['cacheRead','cacheWrite'].some(k => u[k] !== undefined && !count(u[k])))) return undefined;
  const total = {input:0, output:0} as NonNullable<WorkResult['usage']>;
  for (const u of raw) { total.input += u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0); total.output += u.output; }
  for (const k of ['cacheRead','cacheWrite'] as const) if(raw.every(u => count(u[k]))) total[k] = raw.reduce((s,u) => s+u[k],0);
  return total;
}
function sourceHashes() {
  const root = new URL('.', import.meta.url); const result:Record<string,string> = {};
  const walk = (dir:URL, prefix='') => { for(const item of readdirSync(dir,{withFileTypes:true})) {
    const name=prefix+item.name, url=new URL(item.name+(item.isDirectory()?'/':''),dir);
    if(item.isDirectory()) walk(url,name+'/');
    else result[name]=createHash('sha256').update(readFileSync(url)).digest('hex');
  }}; walk(root); return result;
}
export function researchManifest(settings:Record<string,unknown>) {
  return {schemaVersion:1, capturedAt:new Date().toISOString(), settings,
    sourceHashes:sourceHashes(), environment:{node:process.version, platform:platform(), release:release(), arch:arch(), cpu:cpus()[0]?.model ?? null, logicalCpus:cpus().length, memoryBytes:totalmem(), gpu:null},
    generation:{maxOutputTokens:4096, thinkingLevel:'off', temperature:null, seed:null, unspecified:'provider defaults'},
    limitations:['Calls represent harness adapter invocations; SDK-internal HTTP retries are not separately counted.', 'Timeouts can lose final provider usage: null means unavailable, never zero.', 'Prompt exposure is recorded only when captured adapter telemetry establishes the submitted prompt.', 'Time to first token, queue time, wire bytes, TLS handshake duration and remote server hardware are unavailable.', 'Local environment is the harness host, not necessarily the inference host.'],
    definitions:{inputTokens:'Pi input + cacheRead + cacheWrite; cache columns are subsets, do not add again', elapsedMs:'Monotonic duration; trial excludes shared worker setup', processed:'Recipient turn applied, not proof of comprehension or trust', timestamps:'UTC journal append timestamps, not cross-host wire timing', contentBytes:'UTF-8 message body only, not socket or TLS overhead', totals:'Observed subtotals; incomplete usage invalidates complete-total comparisons'},
  };
}
const specs:Record<string,{activity:string;key:string;response:string;success:string;failure:string}> = {
  'attempt.started':{activity:'work',key:'taskId',response:'worker.response',success:'result.accepted',failure:'attempt.failed'},
  'board.attempt.started':{activity:'decision',key:'turnId',response:'board.response',success:'board.decision',failure:'board.attempt.failed'},
  'subagent.attempt.started':{activity:'helper',key:'id',response:'subagent.response',success:'subagent.completed',failure:'subagent.attempt.failed'},
};
export function researchTables(events:JournalEvent[]) {
  const messages:any[]=[], calls:any[]=[], messageEvents:any[]=[], transcripts:any[]=[];
  for(const event of events) if(event.kind==='delivery') {
    const d=(event.data as any).envelope;
    if(d) {
      messages.push({runId:event.runId,messageId:d.messageId,channel:'envelope',author:d.sender,recipient:d.recipient,subject:null,origin:'agent',createdAt:event.at,journalAt:event.at,text:JSON.stringify(d.payload),contentBytes:Buffer.byteLength(JSON.stringify(d.payload),'utf8'),evidenceRefs:d.artifactRefs,replyTo:d.correlationId??null});
      messageEvents.push({runId:event.runId,messageId:d.messageId,event:'envelope-delivered',at:event.at,eventId:event.id,recipient:d.recipient});
    }
  }
  for(const event of events) if(['board.direct','board.update'].includes(event.kind)) {
    const d=event.data as any;
    messages.push({runId:event.runId,messageId:d.id,channel:event.kind==='board.direct'?'direct':'subject', author:d.from??d.author, recipient:d.to??null, subject:d.topicId??null, origin:['user','system'].includes(d.from??d.author)?d.from??d.author:'agent', createdAt:d.createdAt??event.at, journalAt:event.at, text:d.text, contentBytes:Buffer.byteLength(d.text??'','utf8'), evidenceRefs:d.evidenceRefs??[], replyTo:d.replyTo??null});
    messageEvents.push({runId:event.runId,messageId:d.id,event:'created',at:event.at,eventId:event.id,recipient:d.to??null});
  }
  for(const event of events) {
    const spec=specs[event.kind]; if(!spec)continue;
    const d=event.data as any, scope=events.filter(e=>e.runId===event.runId);
    const match=(e:JournalEvent)=> (e.data as any)[spec.key]===d[spec.key] && (e.data as any).attempt===d.attempt && e.seq>=event.seq;
    const response=scope.find(e=>e.kind===spec.response&&match(e));
    const outcome=scope.find(e=>[spec.success,spec.failure].includes(e.kind)&&match(e));
    const r=response?.data as any, o=outcome?.data as any, t=r?.telemetry as CallTelemetry|undefined;
    const turn=scope.find(e=>e.kind==='board.turn'&&(e.data as any).id===d.turnId)?.data as any;
    const task=scope.filter(e=>e.seq<=event.seq).findLast(e=>e.kind==='task'&&(e.data as any).id===d.taskId)?.data as any;
    const agent=d.agent??(spec.activity==='helper'?d.id:turn?.agent??task?.owner??'unknown');
    const worker=(scope.find(e=>e.kind==='run.started')?.data as any)?.workerLabel;
    const noModel=worker==='scripted';
    const callId=t?.callId??event.id;
    calls.push({runId:event.runId,callId,activity:spec.activity,agent,parentAgent:d.parent??null,taskId:d[spec.key],attempt:d.attempt,
      startedAt:t?.startedAt??event.at,finishedAt:t?.finishedAt??outcome?.at??null, adapterInvocationMs:t?.elapsedMs??null,attemptElapsedMs:o?.elapsedMs??null,timeToFirstTokenMs:null,queueMs:null,
      outcome:outcome?.kind===spec.success?'accepted':outcome?'failed':'incomplete',error:o?.error??null,provider:t?.provider??null,model:t?.model??null,
      inputTokens:r?.usage?.input??(noModel?0:null),outputTokens:r?.usage?.output??(noModel?0:null),cacheRead:r?.usage?.cacheRead??null,cacheWrite:r?.usage?.cacheWrite??null,
      usageSource:noModel?'no-model':r?.usage?(t?.usageSource??'worker-reported'):'unavailable',usageComplete:noModel||Boolean(r?.usage), transcriptAvailable:Boolean(t), modelInvocationObserved:Boolean(t)});
    if(t)transcripts.push({runId:event.runId,...t});
    if(turn && spec.activity==='decision') for(const message of [...turn.context.inbox,...(turn.context.directInbox??[])]) {
      const exposed=Boolean(t?.prompt.includes(JSON.stringify(message.id)));
      messageEvents.push({runId:event.runId,messageId:message.id,event:exposed?'included-in-model-request':'context-prepared-exposure-unconfirmed',at:t?.startedAt??event.at,eventId:event.id,callId,recipient:agent,communicationSecurity:message.communicationSecurity??null});
    }
  }
  for(const event of events) {
    const d=event.data as any;
    if(event.kind.startsWith('board.direct.send.')) messageEvents.push({runId:event.runId,messageId:d.id,event:event.kind.slice('board.direct.'.length),at:event.at,eventId:event.id,recipient:d.to,attemptId:d.attemptId,elapsedMs:d.elapsedMs??null,error:d.error??null});
    if(event.kind==='board.direct.received')messageEvents.push({runId:event.runId,messageId:d.id,event:d.status??'received',at:event.at,eventId:event.id,recipient:d.to,transport:d.mode??null});
    if(event.kind==='receipt'&&/^(direct|board):/.test(d.key??'')) {
      const [channel,recipient,...id]=d.key.split(':');
      messageEvents.push({runId:event.runId,messageId:id.join(':'),event:'recipient-turn-applied',at:event.at,eventId:event.id,recipient,channel});
    }
  }
  for(const message of messages) {
    message.contentTokens=null;
    message.originatingCallId = calls.find(c=>c.runId===message.runId && c.activity==='decision' && c.outcome==='accepted' && (message.messageId.startsWith(c.taskId+'-post-')||message.messageId.startsWith(c.taskId+'-dm-')))?.callId??null;
  }
  for(const transcript of transcripts) for(const message of messages.filter(m=>m.runId===transcript.runId && m.channel==='envelope')) {
    if(transcript.prompt.includes(JSON.stringify(message.messageId))) {
      const call=calls.find(c=>c.callId===transcript.callId)!;
      messageEvents.push({runId:message.runId,messageId:message.messageId,event:'included-in-model-request',at:transcript.startedAt,callId:call.callId,recipient:call.agent,communicationSecurity:null});
    }
  }
  return {calls,messages,messageEvents,transcripts};
}
function csv(rows:any[], fallback:string[]) {
  const keys=[...new Set([...fallback,...rows.flatMap(r=>Object.keys(r))])];
  const cell=(v:any)=> '"'+(v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v)).replaceAll('"','""')+'"';
  return [keys,...rows.map(r=>keys.map(k=>r[k]))].map(row=>row.map(cell).join(',')).join('\n')+'\n';
}
export function exportResearch(directory:string, events:JournalEvent[], manifest:any) {
  mkdirSync(directory,{recursive:true}); const tables=researchTables(events);
  const write=(name:string,value:string)=>writeFileSync(join(directory,name),value);
  write('calls.csv',csv(tables.calls,['runId','callId']));
  write('messages.csv',csv(tables.messages,['runId','messageId']));
  write('message-events.csv',csv(tables.messageEvents,['runId','messageId','event']));
  const trials=manifest.trials ?? [...new Set(events.map(e=>e.runId))].map(runId=>({runId,success:null,elapsedMs:null,usageComplete:tables.calls.filter(c=>c.runId===runId).every(c=>c.usageComplete)}));
  write('trials.csv',csv(trials,['runId','configuration','trial','success','elapsedMs','usageComplete']));
  write('events.jsonl',events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  write('transcripts.jsonl',tables.transcripts.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const files=['calls.csv','messages.csv','message-events.csv','trials.csv','events.jsonl','transcripts.jsonl'];
  const bundleHashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(join(directory,file))).digest('hex')]));
  write('manifest.json',JSON.stringify({...manifest,bundleHashes,runConfigurations:events.filter(e=>e.kind==='run.started').map(e=>({runId:e.runId,...e.data as any}))},null,2)+'\n');
}
