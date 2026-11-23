import { exportResearch, researchManifest } from './research.ts';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Kernel } from './kernel.ts';
import { TopicBoard } from './board.ts';
import { SqliteJournal } from './store.ts';
import { makeWorker } from './experiments.ts';
import { features, type Features } from './features.ts';
export const presets = [
  { name: 'subjects-only', features: features({ directMessages: false, helpers: false }) },
  { name: 'direct-only', features: features({ sharedSubjects: false, helpers: false }) },
  { name: 'combined', features: features({ helpers: false }) },
  { name: 'combined-helpers', features: features() },
];
export type BenchmarkRow = { configuration: string; trial: number; runId: string; success: boolean; elapsedMs: number; startupMs?: number; error: string | null; report: ReturnType<Kernel['report']> };
export function summarize(rows: BenchmarkRow[]) {
  return [...new Set(rows.map(r => r.configuration))].map(configuration => {
    const group = rows.filter(r => r.configuration === configuration), successes = group.filter(r => r.success).length;
    const tokens = group.map(r => r.report.usage.total.input + r.report.usage.total.output);
    const times = group.map(r => r.elapsedMs).sort((a,b) => a-b);
    return { configuration, runs: group.length, successes, successRate: successes / group.length,
      meanTokens: group.every(r => r.report.usage.complete) ? tokens.reduce((a,b) => a+b,0) / group.length : null,
      observedTokens: tokens.reduce((a,b) => a+b,0),
      tokensPerSuccess: successes && group.every(r => r.report.usage.complete) ? tokens.reduce((a,b) => a+b,0) / successes : null,
      medianMs: times.length % 2 ? times[Math.floor(times.length/2)] : (times[times.length/2-1]! + times[times.length/2]!) / 2,
      missingUsage: group.reduce((sum,r) => sum + r.report.usage.total.missingUsage,0) };
  });
}
export async function runBenchmark(options: {
  transport?: 'inline'|'socket';
  maxConcurrentAgents?: number;
  worker: Parameters<typeof makeWorker>[0]; directory: string; repeats?: number; scenario?: 'intel' | 'inventory';
  configurations?: { name: string; features: Partial<Features> }[];
  signal?: AbortSignal; onProgress?: (result: any) => void;
}) {
  const transport = options.transport ?? 'inline';
  if(!['inline','socket'].includes(transport))throw new Error('Transport must be inline or socket');
  const socketEvents: import('./types.ts').JournalEvent[] = [];
  const maxConcurrentAgents = options.maxConcurrentAgents ?? 1;
  if (!Number.isInteger(maxConcurrentAgents) || maxConcurrentAgents < 1 || maxConcurrentAgents > 3) throw new Error('maxConcurrentAgents must be 1..3');
  const repeats = options.repeats ?? 3;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('Repeats must be 1..20');
  const configurations = options.configurations ?? presets;
  if (!configurations.length || configurations.length > 5 || new Set(configurations.map(c => c.name)).size !== configurations.length) throw new Error('Choose 1..5 distinct configurations');
  const settings = configurations.map(c => ({ name: c.name, features: features(c.features) }));
  if (settings.some(c => !/^[a-z][a-z0-9-]{0,63}$/.test(c.name))) throw new Error('Invalid configuration name');
  const scenario = options.scenario ?? 'intel';
  if (!['intel','inventory'].includes(scenario)) throw new Error('Unknown benchmark scenario');
  const setupStart = performance.now();
  const spec = await makeWorker(options.worker);
  const setupMs = performance.now()-setupStart;
  const id = randomUUID(), directory = resolve(options.directory, id);
  mkdirSync(directory, { recursive: true });
  const journal = new SqliteJournal(join(directory, 'runs.sqlite'));
  const rows: BenchmarkRow[] = [];
  let benchmarkStatus:'running'|'complete'|'failed'|'cancelled' = 'running';
  let benchmarkError:string|null = null;
  const manifest = researchManifest({scenario, worker:spec.label, transport, maxConcurrentAgents, repeats, settings, setupMs, timeoutMs:options.worker.timeoutMs ?? 120000});
  const snapshot = () => ({ id, directory, scenario, worker: spec.label, transport, maxConcurrentAgents, repeats, settings, rows, status:benchmarkStatus, error:benchmarkError, summary: summarize(rows) });
  const save = () => {
    const result = snapshot();
    writeFileSync(join(directory, 'results.tmp'), JSON.stringify(result, null, 2));
    renameSync(join(directory, 'results.tmp'), join(directory, 'results.json'));
    const csv = [['maxConcurrentAgents','configuration','trial','runId','success','elapsedMs','inputTokens','outputTokens','cacheRead','cacheWrite','missingUsage','measurement'], ...rows.map(r => [maxConcurrentAgents,r.configuration,r.trial,r.runId,r.success,r.elapsedMs,r.report.usage.total.input,r.report.usage.total.output,r.report.usage.total.cacheRead,r.report.usage.total.cacheWrite,r.report.usage.total.missingUsage,r.report.usage.measurement])];
    writeFileSync(join(directory, 'results.csv'), csv.map(row => row.map(value => '"' + String(value).replaceAll('"','""') + '"').join(',')).join('\n') + '\n');
    exportResearch(directory, [...socketEvents,...journal.runIds().flatMap(id => journal.read(id))], { ...manifest, status:benchmarkStatus, error:benchmarkError, trials: rows.map(({report,...row}) => ({...row, transport, usageComplete:report.usage.complete, inputTokens:report.usage.complete?report.usage.total.input:null, outputTokens:report.usage.complete?report.usage.total.output:null, observedInputTokens:report.usage.total.input, observedOutputTokens:report.usage.total.output, missingUsage:report.usage.total.missingUsage, measurement:report.usage.measurement, directMessages:report.metrics.directMessages, publications:report.metrics.publications, directDeliveries:report.metrics.directDeliveries, directProcessed:report.metrics.directProcessed})) });
    options.onProgress?.(result);
  };
  try {
    save();
    // Rotate ordering across repetitions to reduce systematic first-run effects.
    for (let trial=1; trial<=repeats; trial++) for (let index=0; index<settings.length; index++) {
      options.signal?.throwIfAborted();
      const config = settings[(index + trial - 1) % settings.length]!;
      if(transport === 'socket') {
        const {startRuntime,runtimeCommand} = await import('./runtime.ts');
        const db=join(directory,config.name+'-'+trial+'.sqlite');
        const start=performance.now();
        let runtime:Awaited<ReturnType<typeof startRuntime>>|undefined;
        const abort=()=>{void runtimeCommand(db,'cancel',{text:'Benchmark cancelled'}).catch(()=>{});};
        try {
          runtime=await startRuntime({db,worker:options.worker,scenario,maxConcurrentAgents,features:config.features,subagentLimit:config.features.helpers?3:0,timeoutMs:options.worker.timeoutMs??120000});
          const startupMs=performance.now()-start;
          options.signal?.addEventListener('abort',abort,{once:true});
          if(options.signal?.aborted)abort();
          await runtime.idle();
          const elapsedMs=performance.now()-start, snapshot=runtime.researchSnapshot();
          socketEvents.push(...snapshot.events);
          const error=runtime.status().error ?? (options.signal?.aborted?'Benchmark cancelled':null);
          rows.push({configuration:config.name,trial,runId:runtime.runId,success:snapshot.report.success&&!error,elapsedMs,error,report:snapshot.report,startupMs});
          save();
        } catch(error) {
          writeFileSync(join(directory,'infrastructure-failure.json'),JSON.stringify({configuration:config.name,trial,error:error instanceof Error?error.message:String(error),elapsedMs:performance.now()-start}));
          throw error;
        } finally {options.signal?.removeEventListener('abort',abort);await runtime?.close();}
        continue;
      }
      const kernel = new Kernel({ maxConcurrentAgents, journal, topology: 'pubsub', scenario, worker: spec.worker, workerLabel: spec.label,
        authMode: options.worker.authMode, features: config.features, subagentLimit: config.features.helpers ? 3 : 0,
        timeoutMs: options.worker.timeoutMs ?? 120000, signal: options.signal });
      kernel.record('benchmark.trial', { benchmarkId: id, configuration: config.name, trial, transport: 'inline' });
      const start = performance.now(); let error: string | null = null;
      try { await new TopicBoard(kernel, { decide: spec.decide, subagentWorker: spec.subagent, allowIdle: true, signal: options.signal }).run(); }
      catch (e) { error = e instanceof Error ? e.message : String(e); }
      const elapsedMs = Math.round(performance.now()-start), report = kernel.report();
      rows.push({ configuration: config.name, trial, runId: kernel.runId, success: report.success && !error, elapsedMs, error, report });
      save();
    }
    benchmarkStatus='complete';
    save();
    return snapshot();
  } catch(error) {
    benchmarkStatus=options.signal?.aborted?'cancelled':'failed';
    benchmarkError=error instanceof Error?error.message:String(error);
    save();
    throw error;
  } finally { journal.close(); }
}

