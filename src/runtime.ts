import { setTopicAccess, authorizeWork, assertOperationActive } from './operation.ts';
import { runBenchmark } from './benchmark.ts';
import { features as parseFeatures } from './features.ts';
import type { Features } from './features.ts';
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kernel } from './kernel.ts';
import { SqliteJournal } from './store.ts';
import { TopicBoard, formatBoard } from './board.ts';
import { agentIds, type DirectMessage } from './board-types.ts';
import { authorized, callRpc, listenRpc } from './socket.ts';
import type { Scenario, WorkerId } from './types.ts';
import type { makeWorker } from './experiments.ts';
import { runSubagentProcess } from './subagent-process.ts';
import { startDashboard } from './dashboard.ts';
import { dashboardState } from './dashboard-state.ts';

type WorkerConfig = Parameters<typeof makeWorker>[0];
type Descriptor = { version: 1; pid: number; port: number; token: string; runId: string };
type Peer = { agent: WorkerId; child: ChildProcess; port: number; token: string; deliveries: Record<string, string> };
const secret = () => randomBytes(32).toString('hex');
export const descriptorPath = (db: string) => resolve(db) + '.runtime.json';
export function readRuntime(db: string): Descriptor | undefined {
  const path = descriptorPath(db);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, 'utf8')) as Descriptor;
  if (value.version !== 1 || !Number.isInteger(value.pid) || value.pid < 1 || typeof value.token !== 'string' ||
    !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.runId !== 'string') throw new Error('Invalid runtime descriptor');
  try { process.kill(value.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined; throw error; }
  return value;
}
export async function runtimeCommand(db: string, method: string, data: unknown = {}) {
  const runtime = readRuntime(db);
  if (!runtime) throw new Error('No running service for this database. Start serve first.');
  return callRpc(runtime.port, runtime.token, method, data);
}

export async function startRuntime(options: {
  db: string; runId?: string; worker?: WorkerConfig; timeoutMs?: number; maxAttempts?: number; trace?: (line: string) => void;
  requireApproval?: boolean; maxConcurrentAgents?: number; subagentLimit?: number; subagentDemo?: boolean; scenario?: Scenario; dashboard?: boolean; features?: Partial<Features>;
}) {
  const db = resolve(options.db);
  if (readRuntime(db)) throw new Error('A service is already running for this database');
  const journal = new SqliteJournal(db);
  const peers = new Map<WorkerId, Peer>();
  const subagentProcesses = new Set<ChildProcess>();
  let subagentFlight: Promise<unknown> = Promise.resolve();
  let kernel: Kernel, board: TopicBoard;
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let closing = false, dirty = false, busy = false, lastError: string | null = null;
  let pump: Promise<void> = Promise.resolve(), closePromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const token = secret();
  const lifetime = new AbortController();
  let published = false;
  let experiment: any = null, experimentFlight: Promise<unknown> = Promise.resolve();
  let experimentWorker: WorkerConfig;
  const status = () => ({
    maxConcurrentAgents: kernel?.maxConcurrentAgents, runId: kernel?.runId, pid: process.pid, busy, error: lastError, closing,
    boardDirectory: kernel ? resolve(dirname(db), 'boards', kernel.runId) : undefined,
    authMode: kernel?.authMode, scenario: kernel?.scenario, assessmentRevision: kernel?.revision, dashboardUrl: dashboard?.url,
    subagentLimit: kernel?.subagentLimit,
    subagents: board?.snapshot.subagents.map(item => ({ id: item.id, parent: item.parent, name: item.name, status: item.status })) ?? [],
    activeSubagentPids: [...subagentProcesses].map(child => child.pid),
    agents: [...peers.values()].map(peer => ({ agent: peer.agent, pid: peer.child.pid, port: peer.port,
      alive: peer.child.exitCode === null && peer.child.signalCode === null && !peer.child.killed })),
    decisions: kernel?.events.filter(event => event.kind === 'board.decision').length ?? 0,
    directMessages: kernel?.events.filter(event => event.kind === 'board.direct').length ?? 0,
    socketReceipts: kernel?.events.filter(event => event.kind === 'board.direct.received' && (event.data as { mode: string }).mode === 'socket').length ?? 0,
  });
  const wake = () => {
    if (closing) return;
    dirty = true;
    if (busy) return;
    busy = true;
    pump = (async () => {
      while (dirty && !closing) {
        dirty = false;
        try { await board.run(); lastError = null; }
        catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          dirty = false;
          if (!closing) options.trace?.('Runtime paused: ' + lastError + '. Inspect status; stop and serve RUN_ID to recover a failed peer.');
        }
      }
    })().finally(() => { busy = false; });
  };
  const operatorAction = (action: 'inject' | 'post' | 'dm', data: any) => {
    if (closing) throw new Error('Runtime is closing');
    if (experiment?.status === 'running') throw new Error('Wait for the current experiment to finish');
    if (data?.runId && data.runId !== kernel.runId) throw new Error('Run ID does not match active service');
    if (action === 'inject') {
      const result = board.inject(data.source, data.topic ?? 'intel-brief');
      if (!result.duplicate) wake();
      return result;
    }
    if (action === 'dm') {
      const message = board.direct(data.to, data.text, data.topic, data.metadata); wake(); return message;
    }
    const { topic, text, title, description } = data;
    const exists = board.snapshot.topics.some(item => item.id === topic);
    if (!exists && (!title || !description)) throw new Error('A new topic requires --title and --description');
    const update = board.post(topic, text, exists ? undefined : { id: topic, title, description }, data.metadata); wake(); return update;
  };
  const server = await listenRpc(async request => {
    if (request.method === 'received') {
      const peer = peers.get(request.data?.agent);
      if (!peer || !authorized(request.token, peer.token) || request.data.receiverPid !== peer.child.pid ||
        request.data.message?.to !== peer.agent) throw new Error('Unauthorized receipt');
      const message = request.data.message as DirectMessage;
      board.receiveDirect(message, { mode: 'socket', receiverPid: peer.child.pid,
        senderPid: message.from === 'user' ? process.pid : peers.get(message.from)?.child.pid });
      return { committed: true };
    }
    if (!authorized(request.token, token)) throw new Error('Unauthorized service control');
    if (closing) throw new Error('Runtime is closing');
    if (request.data?.runId && request.data.runId !== kernel.runId) throw new Error('Run ID does not match active service');
    switch (request.method) {
      case 'require-approval':
        assertOperationActive(kernel);
        if (busy) throw new Error('Enable approval requirements while the team is idle');
        if (!kernel.events.some(event => event.kind === 'operation.approval-required')) kernel.record('operation.approval-required',{operationId:kernel.runId});
        return {approvalRequired:true};
      case 'authorize':
        authorizeWork(kernel,request.data.taskId,request.data.to,request.data.stage,request.data.metadata?.expiresAt);
        return {authorized:true};
      case 'cancel':
        if (!kernel.events.some(event => event.kind === 'operation.cancelled')) kernel.record('operation.cancelled', {operationId:kernel.runId,reason:request.data?.text ?? 'Operator cancellation'});
        lifetime.abort();
        await pump;
        await subagentFlight.catch(() => {});
        kernel.record('operation.cancellation-acknowledged',{operationId:kernel.runId});
        return {cancelled:true,runId:kernel.runId};
      case 'access':
        if (busy) throw new Error('Change subject access while the team is idle');
        setTopicAccess(kernel,request.data.topic,request.data.readers,request.data.writers);
        return {updated:true};
      case 'status': return status();
      case 'board': return request.data?.json ? board.snapshot : formatBoard(kernel.events);
      case 'inspect': return kernel.report();
      case 'list': return journal.runIds().map(runId => ({ runId, active: runId === kernel.runId }));
      case 'export': return { report: kernel.report(), events: kernel.events };
      case 'resume':
        if (experiment?.status === 'running') throw new Error('Wait for the current experiment to finish');
        if (request.data?.maxConcurrentAgents !== undefined && request.data.maxConcurrentAgents !== kernel.maxConcurrentAgents) throw new Error('Resume configuration mismatch: maxConcurrentAgents');
        if (request.data?.features && JSON.stringify(parseFeatures(request.data.features)) !== JSON.stringify(kernel.features)) throw new Error('Resume configuration mismatch: features');
        if (request.data?.scenario && request.data.scenario !== kernel.scenario) throw new Error('Resume configuration mismatch: scenario');
        wake(); return { queued: true, runId: kernel.runId };
      case 'post': case 'dm': case 'inject': return operatorAction(request.method, request.data);
      case 'stop': setTimeout(() => { void close(); }, 25); return { stopping: true, runId: kernel.runId };
      default: throw new Error('Unknown service command');
    }
  }).catch(error => { journal.close(); throw error; });
  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    lifetime.abort();
    closePromise = (async () => {
      // Terminating wrappers aborts pending model calls; unfinished durable turns replay on serve.
      await Promise.all([...peers.values()].map(peer => peer.child).concat([...subagentProcesses]).map(child => new Promise<void>(resolve => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.once('exit', () => resolve());
        child.kill();
      })));
      await experimentFlight.catch(() => {});
      await pump;
      await subagentFlight.catch(() => {});
      await dashboard?.close();
      await server.close();
      journal.close();
      if (published && existsSync(descriptorPath(db))) {
        const current = JSON.parse(readFileSync(descriptorPath(db), 'utf8')) as Descriptor;
        if (current.token === token) unlinkSync(descriptorPath(db));
      }
    })().finally(resolveClosed);
    return closePromise;
  }
  try {
    const saved = options.runId ? journal.read(options.runId).find(event => event.kind === 'run.started')?.data as any : undefined;
    if (options.runId && !saved) throw new Error('Unknown run: ' + options.runId);
    if (saved && (saved.topology !== 'pubsub' || saved.pubsubVersion !== 2)) throw new Error('serve only supports topic-board pubsub runs');
    let worker = options.worker ?? { mode: 'scripted' as const };
    if (saved) {
      if (worker.authMode && worker.authMode !== (saved.authMode ?? 'environment')) throw new Error('Resume authentication mode mismatch');
      const label = String(saved.workerLabel);
      const [provider, ...model] = label.slice(3).split('/');
      worker = { ...worker, authMode: saved.authMode ?? 'environment', mode: label.startsWith('pi:') ? 'pi' : label as WorkerConfig['mode'],
        ...(label.startsWith('pi:') ? { provider, model: model.join('/') } : {}) };
    }
    experimentWorker = worker;
    const workerLabel = worker.mode === 'pi' ? `pi:${worker.provider}/${worker.model}` : worker.mode;
    if (worker.mode === 'pi' && (!worker.provider || !worker.model)) throw new Error('Live Pi requires --provider and --model');
    if (worker.authMode === 'pi-login' && worker.mode !== 'pi') throw new Error('--auth pi-login requires --worker pi');
    if ((options.subagentDemo ?? saved?.subagentDemo) && worker.mode === 'pi') throw new Error('--subagent-demo is for scripted or pi-faux; live agents decide whether to delegate');
    const timeoutMs = Number(saved?.timeoutMs ?? options.timeoutMs ?? 30000);
    // Construct the kernel before spawning so configuration errors cannot leak processes.
    kernel = new Kernel({ requireApproval: options.requireApproval, journal, topology: 'pubsub', runId: options.runId, workerLabel, authMode: worker.authMode,
      maxConcurrentAgents: options.maxConcurrentAgents, features: options.features, subagentLimit: options.subagentLimit, subagentDemo: options.subagentDemo, scenario: options.scenario,
      timeoutMs, maxAttempts: options.maxAttempts, signal: lifetime.signal, worker: request => {
        const owner = ({ analyze: 'analyst', review: 'reviewer', report: 'reporter' } as const)[request.stage];
        const peer = peers.get(owner)!;
        return callRpc(peer.port, peer.token, 'work', { stage: request.stage, context: request.context },
          { timeoutMs: timeoutMs + 1000, signal: request.signal });
      } });
    for (const agent of agentIds) {
      const childOptions: ForkOptions & { windowsHide: boolean } = {
        execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true,
      };
      const child = fork(fileURLToPath(new URL('./agent-host.ts', import.meta.url)), [], childOptions);
      const peer: Peer = { agent, child, port: 0, token: secret(),
        deliveries: Object.fromEntries([...agentIds, 'user'].filter(id => id !== agent).map(id => [id, secret()])) };
      peers.set(agent, peer);
      child.on('exit', () => {
        if (!closing) {
          lastError = `Agent ${agent} exited. Stop the service, then serve ${kernel.runId} to replay pending work.`;
          options.trace?.(lastError);
        }
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Agent startup timed out')), 120000);
        const finish = (error?: Error) => {
          clearTimeout(timer); child.off('error', failed); child.off('exit', exited); child.off('message', ready);
          if (error) reject(error); else resolve();
        };
        const failed = (error: Error) => finish(error);
        const exited = () => finish(new Error('Agent exited during startup'));
        const ready = (message: any) => {
          if (!message.ready || !Number.isInteger(message.port) || message.pid !== child.pid || message.label !== workerLabel) {
            finish(new Error(message.error ?? 'Invalid agent startup acknowledgement')); return;
          }
          peer.port = message.port; finish();
        };
        child.once('error', failed); child.once('exit', exited); child.once('message', ready);
        child.send({ agent, token: peer.token, deliveries: peer.deliveries, supervisorPort: server.port, worker: { ...worker, timeoutMs } });
      });
    }
    board = new TopicBoard(kernel, {
      directory: resolve(dirname(db), 'boards', kernel.runId), allowIdle: true, trace: options.trace, signal: lifetime.signal,
      subagentWorker: request => {
        // Await teardown from a timed-out attempt before allocating its retry.
        const run = subagentFlight.catch(() => {}).then(() => runSubagentProcess({ ...worker, timeoutMs }, request,
          subagentProcesses, (kind, data) => kernel.record(kind, data)));
        subagentFlight = run;
        return run;
      },
      decide: request => {
        const peer = peers.get(request.context.agent)!;
        return callRpc(peer.port, peer.token, 'decide', { context: request.context }, { signal: request.signal, timeoutMs: timeoutMs + 1000 });
      },
      sendDirect: async message => {
        const receiver = peers.get(message.to)!;
        const data = { message, port: receiver.port, deliveryToken: receiver.deliveries[message.from] };
        if (message.from === 'user') await callRpc(receiver.port, data.deliveryToken, 'deliver', { message });
        else {
          const sender = peers.get(message.from)!;
          await callRpc(sender.port, sender.token, 'send', data, { timeoutMs: 15000 });
        }
      },
    });
    board.initialize();
    if (options.dashboard) dashboard = await startDashboard({
      snapshot: () => ({ ...dashboardState(kernel.events, status()), experiment }), act: (action, data) => {
        if (action !== 'experiment') return operatorAction(action, data);
        if (closing || busy || experiment?.status === 'running') throw new Error('Wait until the team and any experiment are idle');
        const repeats = data.repeats ?? 1;
        if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('Repeats must be 1..20');
        if (!['single','compare'].includes(data.mode)) throw new Error('Choose single or compare');
        const selected = parseFeatures(data.features);
        const maxConcurrentAgents = data.maxConcurrentAgents ?? kernel.maxConcurrentAgents;
        if (!Number.isInteger(maxConcurrentAgents) || maxConcurrentAgents < 1 || maxConcurrentAgents > 3) throw new Error('maxConcurrentAgents must be 1..3');
        experiment = { status: 'running', maxConcurrentAgents, rows: [], summary: [] };
        experimentFlight = runBenchmark({ maxConcurrentAgents, directory: resolve(dirname(db), 'benchmarks'), worker: experimentWorker, scenario: kernel.scenario,
          repeats, configurations: data.mode === 'single' ? [{name:'custom', features:selected}] : undefined,
          signal: lifetime.signal, onProgress: result => { experiment = { ...result, status: 'running' }; } })
          .then(result => { experiment = { ...result, status: 'complete' }; })
          .catch(error => { experiment = { ...experiment, status: 'failed', error: error instanceof Error ? error.message : String(error) }; });
        return { started: true };
      },
    });
    mkdirSync(dirname(descriptorPath(db)), { recursive: true });
    // Same-user local lab capability. Never log this token or include it in model context.
    writeFileSync(descriptorPath(db), JSON.stringify({ version: 1, pid: process.pid, port: server.port, token, runId: kernel.runId }), { mode: 0o600 });
    published = true;
    wake();
    return { runId: kernel.runId, dashboardUrl: dashboard?.url, status, close, closed, idle: async () => { await pump; } };
  } catch (error) { await close(); throw error; }
}
