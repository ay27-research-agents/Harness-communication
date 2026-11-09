import { features } from './features.ts';
import { runBenchmark } from './benchmark.ts';
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Kernel } from './kernel.ts';
import { SqliteJournal } from './store.ts';
import { runTopology } from './topologies.ts';
import { discoverPi, listPiLoginModels } from './pi.ts';
import { makeWorker } from './experiments.ts';
import type { WorkerMode } from './experiments.ts';
import type { Scenario, Stage, Topology, WorkerId } from './types.ts';
import { TopicBoard, formatBoard } from './board.ts';
import { boardSnapshot } from './board-types.ts';
import { readRuntime, runtimeCommand, startRuntime } from './runtime.ts';
import { revisionOf, validateIntelUpdate } from './intel-updates.ts';

const topologies: Topology[] = ['coordinator', 'pubsub', 'routed', 'handoff'];
const help = `Pi Communication Lab — synthetic inventory and intelligence experiments

node src/cli.ts benchmark [--worker scripted|pi-faux|pi] [--repeats N] [--output DIRECTORY]
node src/cli.ts cancel RUN_ID --db PATH --text REASON
node src/cli.ts access RUN_ID --db PATH --topic SUBJECT --readers analyst,reviewer --writers reviewer
node src/cli.ts doctor
node src/cli.ts login-models [--pi-package PATH]
node src/cli.ts compare [--worker scripted|pi-faux|pi] [--duplicates]
node src/cli.ts run coordinator|pubsub|routed|handoff [options]
node src/cli.ts list
node src/cli.ts inspect RUN_ID [--json]
node src/cli.ts resume RUN_ID [--provider NAME --model ID]
node src/cli.ts export RUN_ID [--output runs/report.json]
node src/cli.ts board RUN_ID [--json]
node src/cli.ts post RUN_ID --topic SUBJECT --text "Your note"
node src/cli.ts serve [RUN_ID] [--worker scripted|pi-faux|pi] [--trace]
node src/cli.ts serve [RUN_ID] --scenario intel --dashboard [--trace]
node src/cli.ts inject RUN_ID --source PATH.json [--topic intel-brief]
node src/cli.ts status
node src/cli.ts dm RUN_ID --to AGENT --text "Private note" [--topic SUBJECT]
node src/cli.ts stop

Options:
  --db PATH             SQLite journal; default runs/lab.sqlite
  --worker MODE         scripted (default), pi-faux (real SDK/offline), pi (live inference)
  --scenario NAME       inventory (default) or intel (pubsub only); saved on resume
  --no-direct           Disable private messages (new pubsub runs)
  --no-subjects         Disable shared subjects (new pubsub runs)
  --no-helpers          Disable temporary helpers
  --no-intelligence     Disable added intelligence sources
  --max-concurrent-agents N  Active agent limit, 1..3; default 1, saved per run
  --repeats N           Benchmark repetitions per configuration, 1..20
  --dashboard           Start a local visual dashboard with serve
  --source PATH         Dated intelligence source JSON for inject (intel only)
  --provider NAME       Installed Pi built-in provider; live inference only
  --model ID            Installed Pi catalog model ID; live inference only
  --auth MODE           environment (default) or pi-login (saved Pi OAuth login)
  --pi-package PATH     Override the installed pi-coding-agent package directory
  --duplicates          Inject duplicate pubsub delivery
  --trace               Show pub/sub subscription and work decisions as they happen
  --topic ID            Subject for a user post
  --to AGENT            Direct message recipient: analyst, reviewer or reporter
  --text TEXT           Post or direct message. An active service wakes agents automatically.
  --title TEXT          Required when creating a new subject with post
  --description TEXT    Required when creating a new subject with post
  --fail-once STAGE     Inject one analyze/review/report failure
  --timeout MS          Worker deadline; default 30000, max 300000
  --max-attempts N      Persistent per-stage budget; default 2, max 5
  --max-subagents N     Pub/sub lifetime helper limit, 0..3; new runs default 3
  --subagent-demo       Scripted/pi-faux reviewer requests one evidence-checking helper
  --json                Print JSON instead of a summary table
  --help                Show this help

Workers assess bundled synthetic evidence. No live targets or operational tools.
Intel: fictional conflicting sources, protected dependencies, and uncertainty.
pi-faux exercises Pi with predetermined responses; it does not measure model quality.
pi sends fixture context and board notes to your selected provider and may incur usage.
pubsub workers choose subjects and work; files are written beside the DB in boards/RUN_ID.
Posts and topic descriptions are also included when resuming a live Pi board.
`;

function numberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function summary(report: ReturnType<Kernel['report']>) {
  return { topology: report.topology, scenario: report.scenario, revision: report.assessmentRevision, worker: report.worker, success: report.success,
    messages: report.metrics.messages, calls: report.metrics.workerCalls, decisions: report.metrics.decisionCalls,
    helpers: report.metrics.subagentsCreated, helperCalls: report.metrics.subagentCalls,
    failures: report.metrics.failedAttempts + report.metrics.decisionFailures + report.metrics.subagentFailures, duplicates: report.metrics.duplicatesSuppressed,
    handoffs: report.metrics.handoffs, inputTokens: report.metrics.inputTokens,
    outputTokens: report.metrics.outputTokens, runId: report.runId };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'max-concurrent-agents': {type:'string'}, 'no-direct': {type:'boolean'}, 'no-subjects': {type:'boolean'}, 'no-helpers': {type:'boolean'}, 'no-intelligence': {type:'boolean'}, repeats: {type:'string'},
    'require-approval': {type:'boolean'}, stage: {type:'string'}, 'task-id': {type:'string'}, 'message-type': {type:'string'}, 'expires-at': {type:'string'}, readers: {type:'string'}, writers: {type:'string'}, db: { type: 'string' }, worker: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, auth: { type: 'string' }, scenario: { type: 'string' },
    'pi-package': { type: 'string' }, duplicates: { type: 'boolean' }, 'fail-once': { type: 'string' },
    timeout: { type: 'string' }, 'max-attempts': { type: 'string' }, output: { type: 'string' },
    'max-subagents': { type: 'string' }, 'subagent-demo': { type: 'boolean' },
    dashboard: { type: 'boolean' }, source: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean' }, trace: { type: 'boolean' },
    topic: { type: 'string' }, text: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, to: { type: 'string' },
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { console.log(help); return; }
  if (!['require-approval', 'authorize', 'cancel', 'access', 'benchmark', 'doctor', 'login-models', 'compare', 'run', 'list', 'inspect', 'resume', 'export', 'board', 'post', 'serve', 'status', 'stop', 'dm', 'inject'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const maxConcurrentAgents = numberOption(values['max-concurrent-agents'], '--max-concurrent-agents');
  if (maxConcurrentAgents !== undefined && (!Number.isInteger(maxConcurrentAgents) || maxConcurrentAgents < 1 || maxConcurrentAgents > 3)) throw new Error('--max-concurrent-agents must be 1..3');
  if (maxConcurrentAgents !== undefined && !['run','serve','resume','benchmark'].includes(command)) throw new Error('--max-concurrent-agents requires pubsub run, serve, resume, or benchmark');
  if (maxConcurrentAgents !== undefined && command === 'run' && positionals[1] !== 'pubsub') throw new Error('Concurrency settings require pubsub');
  const featureFlags = ['no-direct','no-subjects','no-helpers','no-intelligence'] as const;
  const selectedFeatures = featureFlags.some(key => values[key]) ? features({ directMessages: !values['no-direct'], sharedSubjects: !values['no-subjects'], helpers: !values['no-helpers'], newIntelligence: !values['no-intelligence'] }) : undefined;
  if (selectedFeatures && !['run','serve','resume','benchmark'].includes(command)) throw new Error('Feature flags require a new run or matching resume');
  if (values.repeats && command !== 'benchmark') throw new Error('--repeats requires benchmark');
  if (command === 'benchmark') {
    const allowed = new Set(['max-concurrent-agents','worker','provider','model','auth','scenario','pi-package','timeout','output','json','repeats',...featureFlags]);
    for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error('Unsupported benchmark option: --' + key);
    if (positionals.length !== 1) throw new Error('benchmark does not take positional arguments');
    if (values.auth && !['environment','pi-login'].includes(values.auth)) throw new Error('--auth must be environment or pi-login');
    const result = await runBenchmark({ maxConcurrentAgents, directory: resolve(values.output ?? 'runs/benchmarks'), repeats: numberOption(values.repeats, '--repeats'),
      scenario: (values.scenario ?? 'intel') as Scenario,
      configurations: selectedFeatures ? [{ name: 'custom', features: selectedFeatures }] : undefined,
      worker: { mode: (values.worker ?? 'scripted') as WorkerMode, provider: values.provider, model: values.model,
        authMode: values.auth as 'environment' | 'pi-login' | undefined, timeoutMs: numberOption(values.timeout, '--timeout'), packagePath: values['pi-package'] } });
    if (values.json) console.log(JSON.stringify(result, null, 2)); else { console.log('Worker: ' + result.worker + ' · Usage: ' + (result.rows[0]?.report.usage.measurement ?? 'unavailable') + ' · Transport: inline · Active agent limit: ' + result.maxConcurrentAgents); console.table(result.summary); console.log('Results: ' + result.directory); }
    return;
  }
  if (selectedFeatures && command === 'run' && positionals[1] !== 'pubsub') throw new Error('Feature switches require pubsub');
  if (values.dashboard && command !== 'serve') throw new Error('--dashboard requires serve');
  if (values.source && command !== 'inject') throw new Error('--source requires inject');
  if (values.auth && !['environment', 'pi-login'].includes(values.auth)) throw new Error('--auth must be environment or pi-login');
  if (command === 'login-models') {
    const providers = await listPiLoginModels(values['pi-package']);
    console.log(JSON.stringify(providers, null, 2));
    if (!providers.length) console.log('No saved OAuth logins. Open Pi and run /login first.');
    return;
  }
  if (values.trace && values.json) throw new Error('--trace and --json cannot be combined');
  if (command === 'doctor') {
    const installed = await discoverPi(values['pi-package']);
    console.log(JSON.stringify({ node: process.version, pi: installed,
      testedPiVersion: '0.87.1', sqlite: 'Node built-in',
      auth: 'Default: environment credentials. Opt in to saved Pi OAuth with --auth pi-login; list metadata with login-models.',
      next: installed ? 'node src/cli.ts compare --worker pi-faux' : 'Set PI_PACKAGE_PATH to your installed pi-coding-agent directory.',
    }, null, 2));
    if (!installed) process.exitCode = 1;
    return;
  }
  const selectedTopology = positionals[1] as Topology | undefined;
  const scenario = values.scenario as Scenario | undefined;
  if (scenario && !['inventory', 'intel'].includes(scenario)) throw new Error('--scenario must be inventory or intel');
  if (scenario && !['run', 'serve', 'resume'].includes(command)) throw new Error('--scenario is for run, serve, or resume');
  if (scenario === 'intel' && command === 'run' && selectedTopology !== 'pubsub') throw new Error('Intel scenario requires pubsub');
  if (command === 'run' && (!selectedTopology || !topologies.includes(selectedTopology))) throw new Error('Choose coordinator, pubsub, routed, or handoff');
  if (['inspect', 'resume', 'export', 'board', 'post', 'dm', 'inject'].includes(command) && !positionals[1]) throw new Error('A run ID is required');
  let intelligence: ReturnType<typeof validateIntelUpdate> | undefined;
  if (command === 'inject') {
    if (!values.source) throw new Error('inject requires --source PATH.json');
    if (statSync(values.source).size > 32768) throw new Error('Intelligence source exceeds 32 KiB');
    intelligence = validateIntelUpdate(JSON.parse(readFileSync(values.source, 'utf8')));
  }
  const timeoutMs = numberOption(values.timeout, '--timeout');
  const maxAttempts = numberOption(values['max-attempts'], '--max-attempts');
  const subagentLimit = numberOption(values['max-subagents'], '--max-subagents');
  if (subagentLimit !== undefined && subagentLimit > 3) throw new Error('--max-subagents must be 0..3');
  if ((subagentLimit !== undefined || values['subagent-demo']) && !['serve', 'resume'].includes(command) && !(command === 'run' && selectedTopology === 'pubsub')) throw new Error('Subagent options require pubsub run, serve, or resume');
  const failStage = values['fail-once'] as Stage | undefined;
  if (failStage && !['analyze', 'review', 'report'].includes(failStage)) throw new Error('--fail-once must be analyze, review, or report');
  const dbPath = resolve(values.db ?? 'runs/lab.sqlite');
  const boardDirectory = (runId: string) => resolve(dirname(dbPath), 'boards', runId);
  if (command === 'serve') {
    if (values.duplicates || failStage) throw new Error('Fault injection is available in run/compare, not serve');
    const runtime = await startRuntime({ requireApproval: values['require-approval'], maxConcurrentAgents, features: selectedFeatures, db: dbPath, runId: positionals[1], timeoutMs, maxAttempts, subagentLimit, subagentDemo: values['subagent-demo'], scenario, dashboard: values.dashboard,
      worker: { mode: (values.worker ?? 'scripted') as WorkerMode, provider: values.provider, model: values.model, authMode: values.auth as 'environment' | 'pi-login' | undefined,
        packagePath: values['pi-package'], timeoutMs }, trace: values.trace ? line => console.log(line) : undefined });
    console.log(`Service ready. Run: ${runtime.runId}\nJournal: ${dbPath}\nShared workspace: ${boardDirectory(runtime.runId)}\nUse a second terminal for post, dm, status or stop. Ctrl+C also stops the service.`);
    if (runtime.dashboardUrl) console.log('Dashboard: ' + runtime.dashboardUrl);
    const stop = () => { void runtime.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await runtime.closed; }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await runtime.close(); }
    return;
  }
  if (['status', 'stop'].includes(command) || readRuntime(dbPath)) {
    if (!['require-approval', 'authorize', 'cancel', 'access', 'status', 'stop', 'board', 'post', 'dm', 'resume', 'inspect', 'export', 'list', 'inject'].includes(command)) {
      throw new Error('This database has a running service. Stop it first or choose a different --db.');
    }
    const result = await runtimeCommand(dbPath, command, { runId: positionals[1], json: values.json,
      stage: values.stage, taskId: values['task-id'], maxConcurrentAgents, metadata: {messageType: values['message-type'], expiresAt: values['expires-at']}, readers: values.readers?.split(',').filter(Boolean) ?? [], writers: values.writers?.split(',').filter(Boolean) ?? [], features: selectedFeatures, topic: values.topic, text: values.text, title: values.title, description: values.description, to: values.to, scenario, source: intelligence });
    if (command === 'export') {
      const path = resolve(values.output ?? `runs/${positionals[1]}.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
      console.log(`Exported report and events: ${path}`);
    } else console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return;
  }
  if (['require-approval','authorize','cancel','access'].includes(command)) throw new Error('This command requires the running service for the selected database');
  if (values['message-type'] || values['expires-at']) throw new Error('Typed operator messages require an active service');
  const journal = new SqliteJournal(dbPath);
  try {
    if (command === 'list') {
      const runs = journal.runIds().map(runId => {
        const events = journal.read(runId);
        const config = events.find(event => event.kind === 'run.started')?.data as { pubsubVersion?: number };
        return { runId, ...config,
          completed: config.pubsubVersion === 2 ? boardSnapshot(events).settled
            : events.some(event => event.kind === 'receipt' && String((event.data as { key: string }).key).endsWith(':complete')) };
      });
      if (values.json) console.log(JSON.stringify(runs, null, 2)); else console.table(runs.map(run => ({ runId: run.runId, completed: run.completed })));
      return;
    }
    const savedId = ['inspect', 'export', 'resume', 'board', 'post', 'dm', 'inject'].includes(command) ? positionals[1] : undefined;
    const savedEvents = savedId ? journal.read(savedId) : [];
    const saved = savedEvents.find(event => event.kind === 'run.started')?.data as Record<string, unknown> | undefined;
    if (savedId && !saved) throw new Error(`Unknown run: ${savedId}`);
    if (command === 'board') {
      if (values.json) console.log(JSON.stringify(boardSnapshot(savedEvents), null, 2));
      else console.log(formatBoard(savedEvents));
      return;
    }
    if (command === 'inject') {
      const kernel = new Kernel({ journal, runId: savedId!, workerLabel: String(saved!.workerLabel), recoverInterrupted: false });
      const result = new TopicBoard(kernel, { directory: boardDirectory(savedId!) }).inject(intelligence, values.topic ?? 'intel-brief');
      console.log(JSON.stringify(result, null, 2));
      if (!values.json) console.log('Source saved. Resume this run, or serve it with --dashboard, to let agents reassess.');
      return;
    }
    if (command === 'post' || command === 'dm') {
      if (command === 'post' && (!values.topic || !values.text)) throw new Error('post requires --topic and --text');
      if (command === 'dm' && (!values.to || !values.text)) throw new Error('dm requires --to and --text');
      const kernel = new Kernel({ journal, runId: savedId!, workerLabel: String(saved!.workerLabel), recoverInterrupted: false });
      const board = new TopicBoard(kernel, { directory: boardDirectory(savedId!) });
      if (command === 'dm') {
        const message = board.direct(values.to as WorkerId, values.text!, values.topic);
        console.log(JSON.stringify(message, null, 2));
        if (!values.json) console.log(`Message saved. Use serve ${savedId} for socket delivery and automatic wakeups, or resume for inline delivery.`);
        return;
      }
      const exists = board.snapshot.topics.some(topic => topic.id === values.topic);
      if (!exists && (!values.title || !values.description)) throw new Error('A new topic requires --title and --description');
      const update = board.post(values.topic!, values.text!, exists ? undefined : { id: values.topic!, title: values.title!, description: values.description! });
      if (values.json) console.log(JSON.stringify(update, null, 2));
      else console.log(`Posted ${update.id}. Resume the run to let agents react: node src/cli.ts resume ${savedId}${values.db ? ` --db ${JSON.stringify(values.db)}` : ''}`);
      return;
    }
    if (command === 'inspect' || command === 'export') {
      // Observing a run must not reconcile or otherwise mutate its journal.
      const snapshot = new (await import('./store.ts')).MemoryJournal();
      snapshot.append(savedId!, savedEvents.map(event => ({ kind: event.kind, data: event.data })));
      const kernel = new Kernel({ journal: snapshot, runId: savedId!, workerLabel: String(saved!.workerLabel), recoverInterrupted: false });
      const report = kernel.report();
      if (command === 'export') {
        const path = resolve(values.output ?? `runs/${savedId}.json`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ report, events: savedEvents }, null, 2) + '\n');
        console.log(`Exported report, evidence, context manifests and events: ${path}`);
      } else if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.table([summary(report)]);
        for (const issue of report.issues) console.log(`Issue: ${issue}`);
        if (report.scenario === 'intel') console.log('Assessment revision: ' + report.assessmentRevision);
        const artifact = report.artifacts.find(item => item.kind === 'report' && revisionOf(item) === report.assessmentRevision);
        if (artifact) console.log((artifact.data as { text: string }).text);
        if (report.board) console.log(formatBoard(savedEvents));
      }
      return;
    }
    let mode = (values.worker ?? 'scripted') as WorkerMode;
    if (saved) mode = String(saved.workerLabel).startsWith('pi:') ? 'pi' : saved.workerLabel as WorkerMode;
    const savedPi = saved && String(saved.workerLabel).startsWith('pi:') ? String(saved.workerLabel).slice(3) : undefined;
    const slash = savedPi?.indexOf('/') ?? -1;
    const authMode = (values.auth ?? saved?.authMode ?? 'environment') as 'environment' | 'pi-login';
    if ((values['subagent-demo'] ?? saved?.subagentDemo) && mode === 'pi') throw new Error('--subagent-demo is for scripted or pi-faux; live agents decide whether to delegate');
    if (saved && authMode !== (saved.authMode ?? 'environment')) throw new Error('Resume authentication mode mismatch');
    const workerSpec = await makeWorker({ mode, provider: values.provider ?? (savedPi && slash >= 0 ? savedPi.slice(0, slash) : undefined),
      model: values.model ?? (savedPi && slash >= 0 ? savedPi.slice(slash + 1) : undefined),
      packagePath: values['pi-package'], timeoutMs, authMode });
    const selected = command === 'compare' ? topologies : [saved ? saved.topology as Topology : selectedTopology!];
    const reports: ReturnType<Kernel['report']>[] = [];
    for (const topology of selected) {
      let injected = false;
      let kernel: Kernel;
      const worker = failStage ? async (request: Parameters<typeof workerSpec.worker>[0]) => {
        if (!injected && request.stage === failStage) {
          injected = true;
          kernel.record('fault.injected', { stage: failStage, kind: 'worker-failure-once' });
          throw new Error('Injected fixture-worker failure');
        }
        return workerSpec.worker(request);
      } : workerSpec.worker;
      kernel = new Kernel({ requireApproval: values['require-approval'], maxConcurrentAgents, features: selectedFeatures, journal, topology, runId: savedId, worker, workerLabel: workerSpec.label, authMode,
        subagentLimit, subagentDemo: values['subagent-demo'], scenario,
        duplicateDelivery: values.duplicates, timeoutMs, maxAttempts });
      try {
        await runTopology(kernel, { decide: workerSpec.decide, subagentWorker: workerSpec.subagent, directory: boardDirectory(kernel.runId),
          trace: values.trace ? line => console.log(line) : undefined });
      } catch (error) {
        console.error(`${topology} stopped: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      reports.push(kernel.report());
    }
    if (values.json) console.log(JSON.stringify(reports, null, 2));
    else {
      console.table(reports.map(summary));
      for (const report of reports) if (report.scenario === 'intel') {
        const assessment = report.artifacts.find(item => item.kind === 'report' && revisionOf(item) === report.assessmentRevision);
        if (assessment) console.log('Intelligence assessment: ' + (assessment.data as { text: string }).text);
        for (const issue of report.issues) console.log('Issue: ' + issue);
      }
      console.log(`Journal: ${dbPath}`);
      for (const report of reports) if (report.board) console.log(`Shared board files: ${boardDirectory(report.runId)}`);
      console.log(`Inspect a run: node src/cli.ts inspect RUN_ID${values.db ? ` --db ${JSON.stringify(values.db)}` : ''}`);
    }
    if (reports.some(report => !report.success)) process.exitCode = 1;
  } finally { journal.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
