import { features, type Features } from './features.ts';
import { usageReport } from './usage.ts';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Artifact, ContextPackage, Envelope, HandoffRecord, Journal, JournalEvent, Party, Scenario, Stage, TaskRecord, Topology, Worker, WorkerId, WorkResult } from './types.ts';
import { MemoryJournal } from './store.ts';
import { sampleFixture } from './fixtures.ts';
import { evaluateReport, scriptedWorker, validateResult } from './workers.ts';
import { boardSnapshot } from './board-types.ts';
import { intelBrief, legacyIntelBrief, intelSources, intelContract, evaluateIntelReport, validateIntelResult, sourceId } from './intel.ts';
import { currentRevision, revisionArtifacts, revisionOf, validateIntelUpdate, maxIntelUpdates, type AssessmentRevision } from './intel-updates.ts';

const contracts: Record<Stage, string> = {
  analyze: 'Return {data:{discrepancies:[{asset,missing:string[],unexpected:string[],evidenceRefs:string[]}]},summary:string}. Compare the supplied expected and observed inventories exactly. Cite the fixture artifact ID. Include only assets with differences.',
  review: 'Return {data:{approved:boolean,issues:string[],analysisRef:string},summary:string}. Independently compare analysis with the supplied fixture. Cite the analysis artifact ID. Approve only when all discrepancies and evidence are correct.',
  report: 'Return {data:{text:string,discrepancyCount:number,evidenceRefs:string[]},summary:string}. Count differing assets, cite fixture, analysis and approved review artifact IDs, and describe the supplied findings.',
};
const kindFor: Record<Stage, string> = { analyze: 'analysis', review: 'review', report: 'report' };
const workerFor: Record<Stage, WorkerId> = { analyze: 'analyst', review: 'reviewer', report: 'reporter' };
const topologyNames: Topology[] = ['coordinator', 'pubsub', 'routed', 'handoff'];
const terminal = (task: TaskRecord) => task.status === 'completed' || task.status === 'cancelled';
const hashData = (data: unknown): string => createHash('sha256').update(JSON.stringify(data)).digest('hex');

export interface KernelOptions {
  features?: Partial<Features>;
  maxConcurrentAgents?: number;
  scenario?: Scenario;
  subagentLimit?: number;
  subagentDemo?: boolean;
  authMode?: 'environment' | 'pi-login';
  journal?: Journal;
  runId?: string;
  topology?: Topology;
  worker?: Worker;
  workerLabel?: string;
  duplicateDelivery?: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
  maxContextChars?: number;
  recoverInterrupted?: boolean;
  signal?: AbortSignal;
}

/** Owns the only state mutation path. Agents see copies of fixed fixture data. */
export class Kernel {
  readonly features: Features;
  readonly maxConcurrentAgents: number;
  readonly scenario: Scenario;
  readonly subagentLimit: number;
  readonly subagentDemo: boolean;
  readonly authMode: 'environment' | 'pi-login';
  readonly journal: Journal;
  readonly runId: string;
  readonly topology: Topology;
  readonly duplicateDelivery: boolean;
  readonly workerLabel: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly maxContextChars: number;
  readonly pubsubVersion: number;
  #worker: Worker;
  #signal?: AbortSignal;
  #active = new Map<string, AbortController>();

  constructor(options: KernelOptions = {}) {
    this.journal = options.journal ?? new MemoryJournal();
    this.runId = options.runId ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(this.runId)) throw new Error('Invalid run ID');
    const saved = this.events.find(event => event.kind === 'run.started')?.data as Record<string, unknown> | undefined;
    this.maxConcurrentAgents = options.maxConcurrentAgents ?? Number(saved?.maxConcurrentAgents ?? 1);
    if (!Number.isInteger(this.maxConcurrentAgents) || this.maxConcurrentAgents < 1 || this.maxConcurrentAgents > 3) throw new Error('maxConcurrentAgents must be 1..3');
    if (saved && this.maxConcurrentAgents !== Number(saved.maxConcurrentAgents ?? 1)) throw new Error('Resume configuration mismatch: maxConcurrentAgents');
    this.features = features(saved?.features ?? options.features);
    if (saved && options.features && JSON.stringify(features(options.features)) !== JSON.stringify(this.features)) throw new Error('Resume configuration mismatch: features');
    this.authMode = options.authMode ?? saved?.authMode as 'environment' | 'pi-login' ?? 'environment';
    if (!['environment', 'pi-login'].includes(this.authMode)) throw new Error('Unknown auth mode');
    this.topology = options.topology ?? saved?.topology as Topology ?? 'coordinator';
    if (!topologyNames.includes(this.topology)) throw new Error('Unknown topology');
    this.pubsubVersion = this.topology === 'pubsub' ? Number(saved ? saved.pubsubVersion ?? 1 : 2) : 0;
    this.scenario = options.scenario ?? saved?.scenario as Scenario ?? 'inventory';
    if (!['inventory', 'intel'].includes(this.scenario)) throw new Error('Unknown scenario');
    if (saved && this.scenario !== (saved.scenario ?? 'inventory')) throw new Error('Resume configuration mismatch: scenario');
    if (this.scenario === 'intel' && this.pubsubVersion !== 2) throw new Error('Intel scenario requires topic-board pubsub');
    this.subagentLimit = options.subagentLimit ?? Number(saved ? saved.subagentLimit ?? 0 : this.pubsubVersion === 2 ? 3 : 0);
    this.subagentDemo = options.subagentDemo ?? Boolean(saved?.subagentDemo);
    if (!Number.isInteger(this.subagentLimit) || this.subagentLimit < 0 || this.subagentLimit > 3) throw new Error('subagentLimit must be 0..3');
    if ((this.subagentLimit > 0 || this.subagentDemo) && this.pubsubVersion !== 2) throw new Error('Subagents require topic-board pubsub');
    if (this.subagentDemo && this.subagentLimit === 0) throw new Error('Subagent demo requires a positive subagent limit');
    this.workerLabel = options.workerLabel ?? 'scripted';
    this.duplicateDelivery = options.duplicateDelivery ?? Boolean(saved?.duplicateDelivery);
    this.timeoutMs = options.timeoutMs ?? Number(saved?.timeoutMs ?? 30000);
    this.maxAttempts = options.maxAttempts ?? Number(saved?.maxAttempts ?? 2);
    this.maxContextChars = options.maxContextChars ?? Number(saved?.maxContextChars ?? 24000);
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300000) throw new Error('timeoutMs must be 1..300000');
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 5) throw new Error('maxAttempts must be 1..5');
    if (!Number.isInteger(this.maxContextChars) || this.maxContextChars < 1000 || this.maxContextChars > 100000) throw new Error('maxContextChars must be 1000..100000');
    this.#worker = options.worker ?? scriptedWorker;
    this.#signal = options.signal;
    let fixtureHash = hashData(this.scenario === 'intel' ? { brief: intelBrief, sources: intelSources } : sampleFixture);
    if (saved && this.scenario === 'intel' && saved.fixtureHash === hashData({ brief: legacyIntelBrief, sources: intelSources })) {
      fixtureHash = String(saved.fixtureHash);
    }
    const config = { ...(!saved || saved.maxConcurrentAgents !== undefined ? { maxConcurrentAgents: this.maxConcurrentAgents } : {}), ...(!saved || saved.features ? { features: this.features } : {}), topology: this.topology, workerLabel: this.workerLabel, duplicateDelivery: this.duplicateDelivery,
      timeoutMs: this.timeoutMs, maxAttempts: this.maxAttempts, maxContextChars: this.maxContextChars,
      fixtureHash, protocolVersion: 1,
      ...(this.scenario === 'intel' || saved?.scenario !== undefined ? { scenario: this.scenario } : {}),
      ...(!saved && this.pubsubVersion === 2 || saved?.subagentLimit !== undefined || options.subagentLimit !== undefined || options.subagentDemo !== undefined
        ? { subagentLimit: this.subagentLimit, subagentDemo: this.subagentDemo } : {}),
      ...(this.authMode === 'pi-login' || saved?.authMode ? { authMode: this.authMode } : {}),
      ...(this.pubsubVersion === 2 ? { pubsubVersion: 2 } : {}) };
    if (saved) {
      for (const [key, value] of Object.entries(config)) {
        if (key === 'features' ? JSON.stringify(saved[key]) !== JSON.stringify(value) : saved[key] !== value) throw new Error(`Resume configuration mismatch: ${key}`);
      }
    } else {
      const fixture = this.makeArtifact('fixture', this.scenario === 'intel' ? intelBrief : sampleFixture, 'system', 'input');
      const sources = this.scenario === 'intel' ? intelSources.map(source =>
        ({ kind: 'artifact', data: this.makeArtifact('intel-source', source, 'system', source.sourceId) })) : [];
      this.journal.append(this.runId, [{ kind: 'run.started', data: config }, { kind: 'artifact', data: fixture }, ...sources]);
    }
    for (const artifact of this.artifacts) {
      if (artifact.hash !== hashData(artifact.data)) throw new Error(`Artifact integrity failure: ${artifact.id}`);
    }
    // A reopened supervisor cannot inherit an in-memory worker invocation. Keep its
    // consumed attempt budget, and make the interrupted outcome explicit.
    if (saved && options.recoverInterrupted !== false) this.reconcileInterruptedAttempts();
  }

  get events(): JournalEvent[] { return this.journal.read(this.runId); }
  get artifacts(): Artifact[] { return this.events.filter(event => event.kind === 'artifact').map(event => event.data as Artifact); }
  get revision(): number { return this.scenario === 'intel' ? currentRevision(this.events) : 1; }
  get currentArtifacts(): Artifact[] { return this.scenario === 'intel' ? revisionArtifacts(this.artifacts, this.revision) : this.artifacts; }
  get assessment(): AssessmentRevision {
    return this.events.findLast(event => event.kind === 'intel.revision')?.data as AssessmentRevision ??
      { revision: 1, sourceRefs: this.artifacts.filter(item => item.kind === 'intel-source').map(item => item.id), changedClaims: [] };
  }
  get currentTasks(): TaskRecord[] { return this.scenario === 'intel' ? this.tasks.filter(task => revisionOf(task) === this.revision) : this.tasks; }
  /** Commit the source, revision, and publication together. Repeating a source ID is idempotent. */
  injectIntelligence(value: unknown, topicId = 'intel-brief') {
    if (this.scenario !== 'intel' || !this.events.some(event => event.kind === 'board.started')) throw new Error('Start an intel pubsub board before adding intelligence');
    if (!this.features.newIntelligence) throw new Error('New intelligence is disabled for this run');
    const update = validateIntelUpdate(value);
    const existing = this.artifacts.find(item => sourceId(item) === update.sourceId);
    if (existing) {
      if (existing.kind !== 'intel-update' || JSON.stringify(existing.data) !== JSON.stringify(update)) throw new Error('Conflicting intelligence source ID');
      return { revision: revisionOf(existing), artifactRef: existing.id, duplicate: true };
    }
    if (this.artifacts.filter(item => item.kind === 'intel-update').length >= maxIntelUpdates) throw new Error('Intelligence update budget exhausted (' + maxIntelUpdates + ')');
    if (!this.features.sharedSubjects && !this.features.directMessages) throw new Error('No enabled channel can deliver new intelligence');
    const board = boardSnapshot(this.events);
    if (!this.features.sharedSubjects && board.directMessages.length >= 64) throw new Error('Direct message budget exhausted (64)');
    if (!board.topics.some(topic => topic.id === topicId)) throw new Error('Unknown intelligence subject');
    if (board.updates.length >= 64) throw new Error('Board update budget exhausted (64)');
    const revision = this.revision + 1;
    const artifact = this.makeArtifact('intel-update', update, 'user', 'source-' + update.sourceId, revision);
    const previous = this.currentArtifacts.find(item => item.kind === 'report');
    const assessment: AssessmentRevision = { revision, sourceRefs: [...this.assessment.sourceRefs, artifact.id],
      changedClaims: update.claims.map(item => item.id), ...(previous ? { previousReportRef: previous.id } : {}) };
    this.journal.append(this.runId, [
      { kind: 'artifact', data: artifact }, { kind: 'intel.revision', data: assessment },
      { kind: this.features.sharedSubjects ? 'board.update' : 'board.direct', data: { id: 'intel-source-' + update.sourceId,
        ...(this.features.sharedSubjects ? { topicId, author: 'user' } : { from: 'user', to: 'analyst' }),
        text: 'New intelligence for assessment revision ' + revision + ': ' + update.title + '. Observed ' + update.observedAt +
          '. Source classification: ' + update.reliability + '. ' + update.observations,
        evidenceRefs: [artifact.id], createdAt: new Date().toISOString() } },
    ]);
    return { revision, artifactRef: artifact.id, duplicate: false };
  }
  get tasks(): TaskRecord[] {
    const latest = new Map<string, TaskRecord>();
    for (const event of this.events) if (event.kind === 'task') {
      const task = event.data as TaskRecord;
      latest.set(task.id, task);
    }
    return [...latest.values()];
  }
  get fixture(): Artifact {
    const fixture = this.artifacts.find(artifact => artifact.kind === 'fixture');
    if (!fixture) throw new Error('Missing fixture');
    return fixture;
  }
  task(id: string): TaskRecord {
    const task = this.tasks.find(task => task.id === id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }
  ensureTask(id: string, owner: WorkerId, objective = 'Compare the supplied inventories and report evidenced differences.', revision?: number): TaskRecord {
    const existing = this.tasks.find(task => task.id === id);
    if (existing) return existing;
    if (!['analyst', 'reviewer', 'reporter'].includes(owner)) throw new Error('Unknown worker');
    const task: TaskRecord = { id, owner, objective, status: 'queued', stateVersion: 0, ownershipEpoch: 0, attempt: 0, outputs: {},
      ...(revision !== undefined ? { revision } : {}) };
    this.record('task', task);
    return task;
  }
  record(kind: string, data: unknown): void { this.journal.append(this.runId, [{ kind, data }]); }
  hasReceipt(key: string): boolean {
    return this.events.some(event => event.kind === 'receipt' && (event.data as { key: string }).key === key);
  }
  receipt(key: string): void { if (!this.hasReceipt(key)) this.record('receipt', { key }); }
  noteDuplicate(key: string): void { this.record('delivery.duplicate', { key }); }

  private reconcileInterruptedAttempts(): void {
    const events = this.events;
    for (const event of events.filter(item => item.kind === 'attempt.started')) {
      const started = event.data as { taskId: string; stage: Stage; attempt: number };
      const settled = events.some(item => ['result.accepted', 'attempt.failed'].includes(item.kind) &&
        (item.data as typeof started).taskId === started.taskId && (item.data as typeof started).attempt === started.attempt);
      if (settled) continue;
      const task = this.task(started.taskId);
      const changes: { kind: string; data: unknown }[] = [{ kind: 'attempt.failed', data: { ...started,
        error: 'Supervisor interrupted before result commit; fixture computation may be retried.', interrupted: true, elapsedMs: null } }];
      if (task.status === 'running' && task.attempt === started.attempt) changes.push({ kind: 'task', data: {
        ...task, status: 'failed', stateVersion: task.stateVersion + 1, error: 'Interrupted worker attempt',
      } });
      this.journal.append(this.runId, changes);
    }
  }

  send(sender: Party, recipient: Party, type: string, taskId: string, artifactRefs: string[], payload: Record<string, unknown> = {}, options: { dedupeKey?: string; correlationId?: string; causationId?: string } = {}): Envelope {
    if (options.dedupeKey) {
      const old = this.events.find(event => event.kind === 'delivery' && (event.data as { dedupeKey?: string }).dedupeKey === options.dedupeKey);
      if (old) return (old.data as { envelope: Envelope }).envelope;
    }
    const hubs: Record<Topology, Party> = { coordinator: 'coordinator', pubsub: 'broker', routed: 'router', handoff: 'controller' };
    const hub = hubs[this.topology];
    const workers = ['analyst', 'reviewer', 'reporter'];
    if (!((sender === hub && workers.includes(recipient)) || (recipient === hub && workers.includes(sender)))) {
      throw new Error(`Route forbidden in ${this.topology}: ${sender} -> ${recipient}`);
    }
    if (this.events.filter(event => event.kind === 'delivery').length >= 80) throw new Error('Message budget exhausted');
    const task = this.task(taskId);
    this.checkRefs(artifactRefs);
    const envelope: Envelope = { schemaVersion: 1, messageId: randomUUID(), runId: this.runId, taskId, type, sender, recipient,
      stateVersion: task.stateVersion, ownershipEpoch: task.ownershipEpoch,
      artifactRefs: [...artifactRefs], payload: structuredClone(payload),
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      ...(options.causationId ? { causationId: options.causationId } : {}),
    };
    this.record('delivery', { envelope, dedupeKey: options.dedupeKey ?? null });
    return envelope;
  }

  private checkRefs(refs: string[]): void {
    const valid = new Set(this.artifacts.map(artifact => artifact.id));
    if (refs.some(ref => !valid.has(ref))) throw new Error('Unknown artifact reference');
  }
  private assertOwner(task: TaskRecord, owner: WorkerId): void {
    if (task.owner !== owner) throw new Error(`Ownership mismatch: ${owner} does not own ${task.id}`);
    if (terminal(task)) throw new Error(`Task is ${task.status}`);
    const pending = this.events.filter(event => event.kind === 'handoff').map(event => event.data as HandoffRecord)
      .filter(handoff => handoff.taskId === task.id)
      .some(handoff => ['offered', 'accepted'].includes(this.handoff(handoff.id)!.status));
    if (pending) throw new Error('Task mutation paused during handoff');
  }
  private makeArtifact(kind: string, data: unknown, producer: string, taskId: string, revision?: number): Artifact {
    const hash = hashData(data);
    return { id: `${this.runId}:${taskId}:${kind}:${hash.slice(0,16)}`, kind, data: structuredClone(data), producer, taskId, hash, createdAt: new Date().toISOString(),
      ...(revision !== undefined ? { revision } : {}) };
  }
  private context(stage: Stage, task: TaskRecord, inputs: Artifact[]): ContextPackage {
    const recentMessages = this.events.filter(event => event.kind === 'delivery')
      .map(event => (event.data as { envelope: Envelope }).envelope)
      .filter(message => message.recipient === task.owner && message.taskId === task.id).slice(-4);
    const context: ContextPackage = { taskId: task.id, objective: task.objective, stateVersion: task.stateVersion,
      ownershipEpoch: task.ownershipEpoch, inputs: structuredClone(inputs), recentMessages,
      outputContract: this.scenario === 'intel' ? intelContract(stage, revisionOf(task)) : contracts[stage], maxChars: this.maxContextChars,
      ...(this.scenario === 'intel' ? { scenario: this.scenario } : {}) };
    if (this.scenario === 'intel') {
      const previous = this.artifacts.filter(item => revisionOf(item) < revisionOf(task));
      const analysis = previous.findLast(item => item.kind === 'analysis')?.data as { claims: { id: string; status: string }[] } | undefined;
      const report = previous.findLast(item => item.kind === 'report')?.data as { recommendation: string } | undefined;
      context.assessment = { revision: revisionOf(task),
        ...(analysis ? { previousClaims: analysis.claims.map(({ id, status }) => ({ id, status })) } : {}),
        ...(report ? { previousRecommendation: report.recommendation } : {}) };
    }
    while (JSON.stringify(context).length > this.maxContextChars && context.recentMessages.length) context.recentMessages.shift();
    if (JSON.stringify(context).length > this.maxContextChars) throw new Error('Required evidence exceeds context budget');
    return context;
  }

  async execute(stage: Stage, taskId: string, owner: WorkerId, inputs: Artifact[], final = true): Promise<Artifact> {
    const existing = this.task(taskId).outputs[stage];
    if (existing) {
      const artifact = this.artifacts.find(artifact => artifact.id === existing);
      if (!artifact) throw new Error('Committed output is missing');
      return artifact;
    }
    if (owner !== workerFor[stage]) throw new Error('Worker lacks capability for stage');
    if (this.#active.has(taskId)) throw new Error('Task is already executing');
    this.checkRefs(inputs.map(input => input.id));
    // Resolve canonical stored artifacts; a caller cannot forge data under a valid ID.
    const canonicalInputs = inputs.map(input => this.artifacts.find(artifact => artifact.id === input.id)!);
    const attempts = () => this.events.filter(event => event.kind === 'attempt.started' &&
      (event.data as { taskId: string; stage: string }).taskId === taskId && (event.data as { stage: string }).stage === stage).length;
    if (attempts() >= this.maxAttempts) throw new Error('Attempt budget exhausted');
    while (attempts() < this.maxAttempts) {
      this.#signal?.throwIfAborted();
      let task = this.task(taskId);
      this.assertOwner(task, owner);
      task = { ...task, status: 'running', attempt: task.attempt + 1, stateVersion: task.stateVersion + 1 };
      delete task.error;
      const context = this.context(stage, task, canonicalInputs);
      const controller = new AbortController();
      this.journal.append(this.runId, [{ kind: 'task', data: task }, { kind: 'attempt.started', data: { taskId, stage, attempt: task.attempt } }, { kind: 'context', data: { stage, owner, context } }]);
      this.#active.set(taskId, controller);
      const start = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      const stop = () => controller.abort(new Error('Supervisor stopped'));
      this.#signal?.addEventListener('abort', stop, { once: true });
      try {
        const stopped = new Promise<never>((_, reject) => {
          abortListener = () => reject(controller.signal.reason ?? new Error('Cancelled'));
          controller.signal.addEventListener('abort', abortListener, { once: true });
          timer = setTimeout(() => controller.abort(new Error('Worker deadline exceeded')), this.timeoutMs);
        });
        const result = await Promise.race([this.#worker({ stage, context: structuredClone(context), signal: controller.signal }), stopped]);
        if (controller.signal.aborted) throw new Error('Worker was cancelled');
        const usage = result?.usage;
        const validUsage = usage && Number.isFinite(usage.input) && Number.isFinite(usage.output) && usage.input >= 0 && usage.output >= 0;
        this.record('worker.response', { taskId, stage, attempt: task.attempt, usage: validUsage ? usage : null });
        if (JSON.stringify(result).length > 64000) throw new Error('Result exceeds 64000 characters');
        if (this.scenario === 'intel') validateIntelResult(stage, result, canonicalInputs);
        else validateResult(stage, result, canonicalInputs);
        if (usage && !validUsage) throw new Error('Invalid usage');
        const current = this.task(taskId);
        if (current.owner !== owner || current.ownershipEpoch !== task.ownershipEpoch || current.stateVersion !== task.stateVersion || current.status !== 'running') throw new Error('Stale result rejected');
        const artifact = this.makeArtifact(kindFor[stage], result.data, owner, taskId, task.revision);
        const completed: TaskRecord = { ...current, outputs: { ...current.outputs, [stage]: artifact.id }, status: final ? 'completed' : 'running', stateVersion: current.stateVersion + 1 };
        this.journal.append(this.runId, [{ kind: 'artifact', data: artifact }, { kind: 'task', data: completed },
          { kind: 'result.accepted', data: { taskId, stage, attempt: task.attempt, artifactRef: artifact.id, summary: result.summary, usage: result.usage ?? { input: 0, output: 0 }, elapsedMs: performance.now() - start } }]);
        return artifact;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const current = this.task(taskId);
        const changes: { kind: string; data: unknown }[] = [{ kind: 'attempt.failed', data: { taskId, stage, attempt: task.attempt, error: message, elapsedMs: performance.now() - start } }];
        if (!terminal(current) && current.ownershipEpoch === task.ownershipEpoch && current.stateVersion === task.stateVersion) {
          changes.push({ kind: 'task', data: { ...current, status: 'failed', stateVersion: current.stateVersion + 1, error: message } });
        }
        this.journal.append(this.runId, changes);
        if (this.#signal?.aborted || current.status === 'cancelled' || attempts() >= this.maxAttempts) throw error;
      } finally {
        if (timer) clearTimeout(timer);
        if (abortListener) controller.signal.removeEventListener('abort', abortListener);
        this.#signal?.removeEventListener('abort', stop);
        this.#active.delete(taskId);
      }
    }
    throw new Error('Attempt budget exhausted');
  }

  finish(taskId: string, owner: WorkerId): void {
    const task = this.task(taskId);
    if (task.status === 'completed') return;
    this.assertOwner(task, owner);
    if (!task.outputs.report) throw new Error('Cannot finish without report');
    this.record('task', { ...task, status: 'completed', stateVersion: task.stateVersion + 1 });
  }
  cancel(taskId: string): void {
    const task = this.task(taskId);
    if (terminal(task)) return;
    this.record('task', { ...task, status: 'cancelled', stateVersion: task.stateVersion + 1 });
    this.#active.get(taskId)?.abort(new Error('Task cancelled'));
  }
  handoff(id: string): HandoffRecord | undefined {
    return this.events.filter(event => event.kind === 'handoff').map(event => event.data as HandoffRecord).findLast(item => item.id === id);
  }
  offerHandoff(id: string, taskId: string, to: WorkerId, refs: string[]): HandoffRecord {
    if (this.topology !== 'handoff') throw new Error('Handoffs are only enabled in handoff topology');
    const existing = this.handoff(id);
    if (existing) {
      if (existing.taskId !== taskId || existing.to !== to) throw new Error('Conflicting handoff ID');
      return existing;
    }
    const task = this.task(taskId);
    this.assertOwner(task, task.owner);
    const next = task.owner === 'analyst' ? 'reviewer' : task.owner === 'reviewer' ? 'reporter' : null;
    if (to !== next) throw new Error('Invalid specialist transition');
    this.checkRefs(refs);
    const required = task.owner === 'analyst' ? task.outputs.analyze : task.outputs.review;
    if (!required || !refs.includes(required)) throw new Error('Handoff requires completed stage evidence');
    const packageArtifact = this.makeArtifact('handoff-package', { objective: task.objective, completed: task.outputs,
      remaining: to === 'reviewer' ? ['review', 'report'] : ['report'], evidenceRefs: refs,
      ownershipEpoch: task.ownershipEpoch, stateVersion: task.stateVersion }, task.owner, task.id);
    const handoff: HandoffRecord = { id, taskId, from: task.owner, to, expectedEpoch: task.ownershipEpoch, packageRef: packageArtifact.id, status: 'offered' };
    this.journal.append(this.runId, [{ kind: 'artifact', data: packageArtifact }, { kind: 'handoff', data: handoff }]);
    return handoff;
  }
  acceptHandoff(id: string, to: WorkerId): void {
    const handoff = this.handoff(id);
    if (!handoff || handoff.to !== to) throw new Error('Invalid handoff acceptance');
    if (handoff.status === 'committed' || handoff.status === 'accepted') return;
    if (handoff.status !== 'offered') throw new Error('Handoff is no longer offered');
    const task = this.task(handoff.taskId);
    if (terminal(task) || task.owner !== handoff.from || task.ownershipEpoch !== handoff.expectedEpoch) throw new Error('Stale handoff');
    this.record('handoff', { ...handoff, status: 'accepted' });
  }
  commitHandoff(id: string): void {
    const handoff = this.handoff(id);
    if (!handoff) throw new Error('Unknown handoff');
    if (handoff.status === 'committed') return;
    if (handoff.status !== 'accepted') throw new Error('Handoff must be accepted before commit');
    const task = this.task(handoff.taskId);
    if (this.#active.has(task.id) || terminal(task) || task.owner !== handoff.from || task.ownershipEpoch !== handoff.expectedEpoch) throw new Error('Stale or active ownership transfer');
    this.journal.append(this.runId, [
      { kind: 'task', data: { ...task, owner: handoff.to, ownershipEpoch: task.ownershipEpoch + 1, stateVersion: task.stateVersion + 1 } },
      { kind: 'handoff', data: { ...handoff, status: 'committed' } },
    ]);
  }
  abortHandoff(id: string): void {
    const handoff = this.handoff(id);
    if (!handoff) throw new Error('Unknown handoff');
    if (handoff.status === 'committed') throw new Error('Committed handoff cannot be aborted');
    if (handoff.status !== 'aborted') this.record('handoff', { ...handoff, status: 'aborted' });
  }
  evaluate() { return this.scenario === 'intel' ? evaluateIntelReport(this.currentArtifacts) : evaluateReport(this.artifacts); }
  report() {
    const events = this.events;
    const responses = events.filter(event => ['worker.response', 'board.response', 'subagent.response'].includes(event.kind)).map(event => event.data as { usage: { input: number; output: number } | null });
    const outcomes = events.filter(event => ['result.accepted', 'attempt.failed'].includes(event.kind)).map(event => event.data as { elapsedMs: number | null });
    const workerCalls = events.filter(event => event.kind === 'attempt.started').length;
    const decisionCalls = events.filter(event => event.kind === 'board.attempt.started').length;
    const subagentCalls = events.filter(event => event.kind === 'subagent.attempt.started').length;
    const board = this.pubsubVersion === 2 ? boardSnapshot(events) : undefined;
    const evaluation = this.evaluate();
    const issues = [...evaluation.issues];
    if (this.currentTasks.some(task => task.status !== 'completed')) issues.push('Some tasks are incomplete');
    if (board && !board.settled) issues.push('The topic board has pending activity or has not settled with a published report');
    return { runId: this.runId, topology: this.topology, scenario: this.scenario, assessmentRevision: this.revision,
      maxConcurrentAgents: this.maxConcurrentAgents, features: this.features, usage: usageReport(events, this.workerLabel), worker: this.workerLabel, success: evaluation.success && issues.length === 0, issues,
      metrics: { messages: events.filter(event => ['delivery', 'board.delivery'].includes(event.kind)).length,
        workerCalls, decisionCalls,
        subagentCalls,
        subagentsCreated: events.filter(event => event.kind === 'subagent.requested').length,
        subagentsCompleted: events.filter(event => event.kind === 'subagent.completed').length,
        subagentsFailed: events.filter(event => event.kind === 'subagent.failed').length,
        subagentFailures: events.filter(event => event.kind === 'subagent.attempt.failed').length,
        decisionFailures: events.filter(event => event.kind === 'board.attempt.failed').length,
        interruptedDecisionAttempts: events.filter(event => event.kind === 'board.attempt.failed' && (event.data as { interrupted?: boolean }).interrupted).length,
        maxDecisionContextChars: Math.max(0, ...events.filter(event => event.kind === 'board.turn').map(event => JSON.stringify((event.data as { context: unknown }).context).length)),
        publications: board?.updates.length ?? 0,
        directMessages: board?.directMessages.length ?? 0,
        directDeliveries: events.filter(event => event.kind === 'board.direct.received').length,
        directProcessed: events.filter(event => event.kind === 'receipt' && String((event.data as { key: string }).key).startsWith('direct:')).length,
        subscriptions: board?.agents.reduce((sum, agent) => sum + agent.subscriptions.length, 0) ?? 0,
        failedAttempts: events.filter(event => event.kind === 'attempt.failed').length,
        duplicatesSuppressed: events.filter(event => event.kind === 'delivery.duplicate').length,
        handoffs: events.filter(event => event.kind === 'handoff' && (event.data as HandoffRecord).status === 'committed').length,
        inputTokens: responses.reduce((sum, response) => sum + (response.usage?.input ?? 0), 0),
        outputTokens: responses.reduce((sum, response) => sum + (response.usage?.output ?? 0), 0),
        attemptsWithoutUsage: this.workerLabel === 'scripted' ? 0 : workerCalls + decisionCalls + subagentCalls - responses.filter(response => response.usage !== null).length,
        workerElapsedMs: Math.round(outcomes.reduce((sum, outcome) => sum + (outcome.elapsedMs ?? 0), 0)),
        decisionElapsedMs: Math.round(events.filter(event => ['board.decision', 'board.attempt.failed'].includes(event.kind))
          .reduce((sum, event) => sum + ((event.data as { elapsedMs?: number | null }).elapsedMs ?? 0), 0)),
        interruptedAttempts: events.filter(event => event.kind === 'attempt.failed' && (event.data as { interrupted?: boolean }).interrupted).length,
        maxContextChars: Math.max(0, ...events.filter(event => event.kind === 'context').map(event => JSON.stringify((event.data as { context: ContextPackage }).context).length)),
      }, tasks: this.tasks, artifacts: this.artifacts, ...(board ? { board } : {}) };
  }
}
