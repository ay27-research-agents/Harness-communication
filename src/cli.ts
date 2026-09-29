import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Kernel } from './kernel.ts';
import { SqliteJournal } from './store.ts';
import { runTopology } from './topologies.ts';
import { discoverPi } from './pi.ts';
import { makeWorker } from './experiments.ts';
import type { WorkerMode } from './experiments.ts';
import type { Stage, Topology } from './types.ts';
import { TopicBoard, formatBoard } from './board.ts';
import { boardSnapshot } from './board-types.ts';

const topologies: Topology[] = ['coordinator', 'pubsub', 'routed', 'handoff'];
const help = `Pi Communication Lab — supplied inventory experiments

node src/cli.ts doctor
node src/cli.ts compare [--worker scripted|pi-faux|pi] [--duplicates]
node src/cli.ts run coordinator|pubsub|routed|handoff [options]
node src/cli.ts list
node src/cli.ts inspect RUN_ID [--json]
node src/cli.ts resume RUN_ID [--provider NAME --model ID]
node src/cli.ts export RUN_ID [--output runs/report.json]
node src/cli.ts board RUN_ID [--json]
node src/cli.ts post RUN_ID --topic SUBJECT --text "Your note"

Options:
  --db PATH             SQLite journal; default runs/lab.sqlite
  --worker MODE         scripted (default), pi-faux (real SDK/offline), pi (live inference)
  --provider NAME       Installed Pi built-in provider; live inference only
  --model ID            Installed Pi catalog model ID; live inference only
  --pi-package PATH     Override the installed pi-coding-agent package directory
  --duplicates          Inject duplicate pubsub delivery
  --trace               Show pub/sub subscription and work decisions as they happen
  --topic ID            Subject for a user post
  --text TEXT           Content of a user post (no model call)
  --title TEXT          Required when creating a new subject with post
  --description TEXT    Required when creating a new subject with post
  --fail-once STAGE     Inject one analyze/review/report failure
  --timeout MS          Worker deadline; default 30000, max 300000
  --max-attempts N      Persistent per-stage budget; default 2, max 5
  --json                Print JSON instead of a summary table
  --help                Show this help

Workers compare a bundled synthetic inventory. No live targets or operational tools.
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
  return { topology: report.topology, worker: report.worker, success: report.success,
    messages: report.metrics.messages, calls: report.metrics.workerCalls, decisions: report.metrics.decisionCalls,
    failures: report.metrics.failedAttempts + report.metrics.decisionFailures, duplicates: report.metrics.duplicatesSuppressed,
    handoffs: report.metrics.handoffs, inputTokens: report.metrics.inputTokens,
    outputTokens: report.metrics.outputTokens, runId: report.runId };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    db: { type: 'string' }, worker: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
    'pi-package': { type: 'string' }, duplicates: { type: 'boolean' }, 'fail-once': { type: 'string' },
    timeout: { type: 'string' }, 'max-attempts': { type: 'string' }, output: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean' }, trace: { type: 'boolean' },
    topic: { type: 'string' }, text: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { console.log(help); return; }
  if (!['doctor', 'compare', 'run', 'list', 'inspect', 'resume', 'export', 'board', 'post'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (values.trace && values.json) throw new Error('--trace and --json cannot be combined');
  if (command === 'doctor') {
    const installed = await discoverPi(values['pi-package']);
    console.log(JSON.stringify({ node: process.version, pi: installed,
      testedPiVersion: '0.87.1', sqlite: 'Node built-in',
      auth: 'Live mode uses environment/ambient credentials; saved Pi login credentials are not loaded.',
      next: installed ? 'node src/cli.ts compare --worker pi-faux' : 'Set PI_PACKAGE_PATH to your installed pi-coding-agent directory.',
    }, null, 2));
    if (!installed) process.exitCode = 1;
    return;
  }
  const selectedTopology = positionals[1] as Topology | undefined;
  if (command === 'run' && (!selectedTopology || !topologies.includes(selectedTopology))) throw new Error('Choose coordinator, pubsub, routed, or handoff');
  if (['inspect', 'resume', 'export', 'board', 'post'].includes(command) && !positionals[1]) throw new Error('A run ID is required');
  const timeoutMs = numberOption(values.timeout, '--timeout');
  const maxAttempts = numberOption(values['max-attempts'], '--max-attempts');
  const failStage = values['fail-once'] as Stage | undefined;
  if (failStage && !['analyze', 'review', 'report'].includes(failStage)) throw new Error('--fail-once must be analyze, review, or report');
  const dbPath = resolve(values.db ?? 'runs/lab.sqlite');
  const boardDirectory = (runId: string) => resolve(dirname(dbPath), 'boards', runId);
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
    const savedId = ['inspect', 'export', 'resume', 'board', 'post'].includes(command) ? positionals[1] : undefined;
    const savedEvents = savedId ? journal.read(savedId) : [];
    const saved = savedEvents.find(event => event.kind === 'run.started')?.data as Record<string, unknown> | undefined;
    if (savedId && !saved) throw new Error(`Unknown run: ${savedId}`);
    if (command === 'board') {
      if (values.json) console.log(JSON.stringify(boardSnapshot(savedEvents), null, 2));
      else console.log(formatBoard(savedEvents));
      return;
    }
    if (command === 'post') {
      if (!values.topic || !values.text) throw new Error('post requires --topic and --text');
      const kernel = new Kernel({ journal, runId: savedId!, workerLabel: String(saved!.workerLabel), recoverInterrupted: false });
      const board = new TopicBoard(kernel, { directory: boardDirectory(savedId!) });
      const exists = board.snapshot.topics.some(topic => topic.id === values.topic);
      if (!exists && (!values.title || !values.description)) throw new Error('A new topic requires --title and --description');
      const update = board.post(values.topic, values.text, exists ? undefined : { id: values.topic, title: values.title!, description: values.description! });
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
        const artifact = report.artifacts.find(item => item.kind === 'report');
        if (artifact) console.log((artifact.data as { text: string }).text);
        if (report.board) console.log(formatBoard(savedEvents));
      }
      return;
    }
    let mode = (values.worker ?? 'scripted') as WorkerMode;
    if (saved) mode = String(saved.workerLabel).startsWith('pi:') ? 'pi' : saved.workerLabel as WorkerMode;
    const savedPi = saved && String(saved.workerLabel).startsWith('pi:') ? String(saved.workerLabel).slice(3) : undefined;
    const slash = savedPi?.indexOf('/') ?? -1;
    const workerSpec = await makeWorker({ mode, provider: values.provider ?? (savedPi && slash >= 0 ? savedPi.slice(0, slash) : undefined),
      model: values.model ?? (savedPi && slash >= 0 ? savedPi.slice(slash + 1) : undefined),
      packagePath: values['pi-package'], timeoutMs });
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
      kernel = new Kernel({ journal, topology, runId: savedId, worker, workerLabel: workerSpec.label,
        duplicateDelivery: values.duplicates, timeoutMs, maxAttempts });
      try {
        await runTopology(kernel, { decide: workerSpec.decide, directory: boardDirectory(kernel.runId),
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
