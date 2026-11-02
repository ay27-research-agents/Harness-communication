import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Kernel } from './kernel.ts';
import type { Artifact, JournalEvent, Stage, WorkerId } from './types.ts';
import { intelInputs, intelProfiles, intelSourceOwners, sourceId } from './intel.ts';
import { currentRevision, revisionOf } from './intel-updates.ts';
import { scriptedBoardDecider } from './board-policy.ts';
import { runSubagentTask, scriptedSubagentWorker } from './subagents.ts';
import type { SubagentWorker } from './subagent-types.ts';
import { agentIds, agentProfiles, boardSnapshot } from './board-types.ts';
import type { AgentState, BoardContext, BoardDecision, BoardDecider, BoardUpdate, DirectMessage, Topic } from './board-types.ts';

type Change = { kind: string; data: unknown };
type Turn = { id: string; agent: WorkerId; context: BoardContext; seenCatalog: string; seenOwn: string; seenSubagents?: string; cursors: Record<string, number>; directCursor?: number };
export interface BoardOptions {
  decide?: BoardDecider; directory?: string; trace?: (line: string) => void;
  sendDirect?: (message: DirectMessage) => Promise<void>;
  allowIdle?: boolean;
  signal?: AbortSignal;
  subagentWorker?: SubagentWorker;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const taskIds: Record<Stage, string> = { analyze: 'analysis', review: 'review', report: 'report' };
const requiredKinds: Record<Stage, string[]> = { analyze: ['fixture'], review: ['fixture', 'analysis'], report: ['fixture', 'analysis', 'review'] };
const slug = /^[a-z][a-z0-9-]{0,63}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Board decision must contain objects');
  return value as Record<string, unknown>;
}
function textValue(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Board text must contain 1..${max} characters`);
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Board array must contain at most ${max} items`);
  return value;
}
export function validateTopic(value: unknown): Topic {
  const item = object(value);
  const id = textValue(item.id, 64);
  if (!slug.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) throw new Error('Topic ID must be a lowercase letters/digits/hyphens slug and not a reserved Windows name');
  return { id, title: textValue(item.title, 100), description: textValue(item.description, 500) };
}
export function validateDecision(value: unknown, context: BoardContext): BoardDecision {
  const item = object(value);
  if (context.features?.sharedSubjects === false && ['subscriptions', 'createTopics', 'publish'].some(key => !Array.isArray(item[key]) || (item[key] as unknown[]).length)) throw new Error('Shared subjects are disabled');
  if (context.features?.directMessages === false && array(item.directMessages ?? [], 2).length) throw new Error('Direct messages are disabled');
  if (context.features?.helpers === false && array(item.spawnSubagents ?? [], 1).length) throw new Error('Helpers are disabled');
  const allowed = ['subscriptions', 'status', 'reason', 'createTopics', 'publish', 'work'];
  if (Object.keys(item).some(key => ![...allowed, 'directMessages', 'spawnSubagents'].includes(key)) || allowed.some(key => !Object.hasOwn(item, key))) throw new Error('Board decision has missing or unknown fields');
  const createTopics = array(item.createTopics, 2).map(validateTopic);
  const topicIds = new Set(context.catalog.map(topic => topic.id));
  for (const topic of createTopics) {
    if (topicIds.has(topic.id)) throw new Error('Cannot recreate an existing topic');
    topicIds.add(topic.id);
  }
  if (topicIds.size > 16) throw new Error('Topic budget exhausted (16)');
  const subscriptions = array(item.subscriptions, 16).map(value => {
    const sub = object(value);
    const topicId = textValue(sub.topicId, 64);
    if (!topicIds.has(topicId)) throw new Error('Subscription refers to an unknown topic');
    return { topicId, reason: textValue(sub.reason, 1000) };
  });
  if (new Set(subscriptions.map(sub => sub.topicId)).size !== subscriptions.length) throw new Error('Duplicate subscription');
  const known = new Set(context.evidence.map(artifact => artifact.id));
  const publish = array(item.publish, 2).map(value => {
    const post = object(value);
    const topicId = textValue(post.topicId, 64);
    if (!topicIds.has(topicId)) throw new Error('Publication refers to an unknown topic');
    const evidenceRefs = array(post.evidenceRefs, context.scenario === 'intel' ? 16 : 8).map(value => textValue(value, 250));
    if (new Set(evidenceRefs).size !== evidenceRefs.length || evidenceRefs.some(ref => !known.has(ref))) throw new Error('Publication contains unavailable evidence');
    return { topicId, text: textValue(post.text, 6000), evidenceRefs };
  });
  if (item.work !== null && (!context.availableWork || item.work !== context.availableWork)) throw new Error('Requested work is unavailable to this agent');
  const directMessages = array(item.directMessages ?? [], 2).map(value => {
    const post = object(value);
    if (!agentIds.includes(post.to as WorkerId) || post.to === context.agent) throw new Error('Direct message requires another known agent');
    const topicId = post.topicId === undefined ? undefined : textValue(post.topicId, 64);
    if (topicId && !topicIds.has(topicId)) throw new Error('Direct message refers to an unknown topic');
    const evidenceRefs = array(post.evidenceRefs, context.scenario === 'intel' ? 16 : 8).map(value => textValue(value, 250));
    if (new Set(evidenceRefs).size !== evidenceRefs.length || evidenceRefs.some(ref => !known.has(ref))) throw new Error('Direct message contains unavailable evidence');
    const replyTo = post.replyTo === undefined ? undefined : textValue(post.replyTo, 100);
    if (replyTo && !context.directInbox?.some(message => message.id === replyTo && message.from === post.to)) throw new Error('Reply must address a message from this recipient in your inbox');
    return { to: post.to as WorkerId, text: textValue(post.text, 6000), evidenceRefs,
      ...(topicId ? { topicId } : {}), ...(replyTo ? { replyTo } : {}) };
  });
  const spawnSubagents = array(item.spawnSubagents ?? [], 1).map(value => {
    const spawn = object(value);
    if (Object.keys(spawn).some(key => !['name', 'task', 'evidenceRefs'].includes(key))) throw new Error('Subagent request has unknown fields');
    if (!context.delegation?.canSpawn) throw new Error('Subagent budget unavailable');
    if (item.work !== null) throw new Error('Delegate first, then perform your own work after the result');
    const name = textValue(spawn.name, 64);
    if (!slug.test(name)) throw new Error('Subagent name must be a lowercase slug');
    const evidenceRefs = array(spawn.evidenceRefs, 8).map(value => textValue(value, 250));
    if (new Set(evidenceRefs).size !== evidenceRefs.length || evidenceRefs.some(ref => !known.has(ref))) throw new Error('Subagent received unavailable evidence');
    return { name, task: textValue(spawn.task, 2000), evidenceRefs };
  });
  return { subscriptions, status: textValue(item.status, 500), reason: textValue(item.reason, 1500),
    createTopics, publish, work: item.work as Stage | null, directMessages, spawnSubagents };
}

/** Broker owns delivery only. All subscription, publication and work choices come from a decider. */
export class TopicBoard {
  readonly kernel: Kernel;
  readonly options: BoardOptions;
  private directFlight: Promise<void> = Promise.resolve();
  constructor(kernel: Kernel, options: BoardOptions = {}) {
    if (kernel.topology !== 'pubsub' || kernel.pubsubVersion !== 2) throw new Error('This run does not use the topic-board pub/sub protocol');
    this.kernel = kernel;
    this.options = options;
  }
  get snapshot() { return boardSnapshot(this.kernel.events); }
  private append(changes: Change[]) { this.kernel.journal.append(this.kernel.runId, changes); }
  private trace(line: string) { this.options.trace?.(line.replace(/[\x00-\x1f\x7f]/g, ' ')); }
  private state(agent: WorkerId): AgentState {
    return this.snapshot.agents.find(item => item.agent === agent) ?? {
      agent, subscriptions: [], status: 'Discovering subjects.', cursors: {},
      knownRefs: (this.kernel.events.find(event => event.kind === 'board.assignment' && (event.data as { agent: string }).agent === agent)?.data as { evidenceRefs: string[] } | undefined)?.evidenceRefs ?? [],
      seenCatalog: '', seenOwn: '', turnId: '',
    };
  }
  initialize(): void {
    if (this.kernel.events.some(event => event.kind === 'board.started')) return;
    const now = new Date().toISOString();
    if (this.kernel.scenario === 'intel') {
      this.append([
        { kind: 'board.started', data: { version: 2, scenario: 'intel', maxTurns: 48, maxTopics: 16, maxUpdates: 64 } },
        { kind: 'board.topic', data: { id: 'intel-brief', title: 'Intelligence brief', description: 'Shared intelligence questions; peers initially hold different original sources. Create subjects to exchange relevant evidence.' } },
        { kind: 'board.topic', data: { id: 'announcements', title: 'Room announcements', description: 'Room logistics only, unrelated to analytical work.' } },
        { kind: 'board.update', data: { id: 'seed-intel', topicId: 'intel-brief', author: 'system',
          text: 'Assess the three claims in the supplied brief. Each peer has a different source packet; no agent starts with the full picture.',
          evidenceRefs: [this.kernel.fixture.id], createdAt: now } },
        { kind: 'board.update', data: { id: 'seed-announcement', topicId: 'announcements', author: 'system',
          text: 'The demonstration room opens at noon. This is an administrative note only.', evidenceRefs: [], createdAt: now } },
        ...agentIds.map(agent => ({ kind: 'board.assignment', data: { agent,
          evidenceRefs: [this.kernel.fixture.id, ...this.kernel.artifacts.filter(item => intelSourceOwners[sourceId(item) ?? ''] === agent).map(item => item.id)] } })),
      ]);
      this.materialize();
      return;
    }
    this.append([
      ...(!this.kernel.features.sharedSubjects ? [{ kind: 'board.assignment', data: { agent: 'analyst', evidenceRefs: [this.kernel.fixture.id] } }] : []),
      { kind: 'board.started', data: { version: 2, maxTurns: 48, maxTopics: 16, maxUpdates: 64 } },
      { kind: 'board.topic', data: { id: 'inventory', title: 'Supplied inventory', description: 'Supplied synthetic inventory records: expected and observed service labels.' } },
      { kind: 'board.topic', data: { id: 'announcements', title: 'General announcements', description: 'Social and administrative notes, unrelated to inventory evidence.' } },
      { kind: 'board.update', data: { id: 'seed-inventory', topicId: 'inventory', author: 'system',
        text: 'The sample expected and observed inventory is ready for anyone whose work needs it.', evidenceRefs: [this.kernel.fixture.id], createdAt: now } },
      { kind: 'board.update', data: { id: 'seed-announcement', topicId: 'announcements', author: 'system',
        text: 'The demonstration room has a blue noticeboard. This note contains no inventory finding.', evidenceRefs: [], createdAt: now } },
    ]);
    this.materialize();
  }
  private prepare(agent: WorkerId): Omit<Turn, 'id'> | undefined {
    const state = this.state(agent);
    const { topics, updates } = this.snapshot;
    const followed = new Set(this.kernel.features.sharedSubjects ? state.subscriptions.map(sub => sub.topicId) : []);
    const unread = this.kernel.events.filter(event => event.kind === 'board.update' &&
      followed.has((event.data as BoardUpdate).topicId) && (event.data as BoardUpdate).author !== agent &&
      event.seq > (state.cursors[(event.data as BoardUpdate).topicId] ?? 0));
    const messages = this.snapshot.directMessages;
    const directUnread = this.kernel.events.filter(event => event.kind === 'board.direct.received' &&
      (event.data as { to: string }).to === agent && event.seq > (state.directCursor ?? 0));
    const ownWork = this.kernel.currentArtifacts.filter(artifact => artifact.producer === agent && ['analysis', 'review', 'report'].includes(artifact.kind));
    const seenCatalog = digest(topics);
    const seenOwn = digest(ownWork.map(item => item.id));
    const subagents = this.snapshot.subagents.filter(item => item.parent === agent);
    const seenSubagents = digest(subagents);
    if ((state.seenRevision ?? 1) === this.kernel.revision && state.seenCatalog === seenCatalog && state.seenOwn === seenOwn && (state.seenSubagents ?? digest([])) === seenSubagents && !unread.length && !directUnread.length) return undefined;
    let selected = unread.slice(0, 4);
    let directSelected = directUnread.slice(0, 2);
    for (;;) {
      const inbox = selected.map(event => event.data as BoardUpdate);
      const directInbox = directSelected.map(event => messages.find(message => message.id === (event.data as { id: string }).id)!);
      const refs = new Set([...state.knownRefs, ...ownWork.map(item => item.id), ...inbox.flatMap(post => post.evidenceRefs), ...directInbox.flatMap(message => message.evidenceRefs)]);
      const evidence = this.kernel.currentArtifacts.filter(artifact => refs.has(artifact.id));
      const profiles = this.kernel.scenario === 'intel' ? intelProfiles : agentProfiles;
      const { capability, goal } = profiles[agent];
      const ready = !ownWork.length && (this.kernel.scenario === 'intel' ? Boolean(intelInputs(capability, evidence, this.kernel.assessment.sourceRefs)) : requiredKinds[capability].every(kind => evidence.some(item => item.kind === kind))) &&
        (capability !== 'report' || evidence.some(item => item.kind === 'review' && (item.data as { approved: boolean }).approved));
      const context: BoardContext = { agent, goal, capability, catalog: this.kernel.features.sharedSubjects ? topics : [], subscriptions: state.subscriptions,
        features: this.kernel.features,
        sentEvidenceRefs: Object.fromEntries(agentIds.filter(id => id !== agent).map(id => [id, [...new Set(messages.filter(m => m.from === agent && m.to === id).flatMap(m => m.evidenceRefs))]])),
        ...(this.kernel.scenario === 'intel' ? { scenario: 'intel' as const,
          assessment: { revision: this.kernel.revision, requiredSourceRefs: this.kernel.assessment.sourceRefs, changedClaims: this.kernel.assessment.changedClaims } } : {}),
        status: state.status, inbox, directInbox, evidence,
        ownWork: ownWork.map(({ id, kind, revision }) => ({ id, kind, ...(revision === undefined ? {} : { revision }) })),
        availableWork: ready ? capability : null,
        transport: this.options.sendDirect ? 'socket' : 'inline',
        subagents,
        delegation: { canSpawn: this.kernel.features.helpers && !subagents.length && this.snapshot.subagents.length < this.kernel.subagentLimit,
          remaining: Math.max(0, this.kernel.subagentLimit - this.snapshot.subagents.length), maxDepth: 1, maxPerParent: 1, demo: this.kernel.subagentDemo },
        peers: agentIds.filter(id => id !== agent).map(id => ({ agent: id, goal: profiles[id].goal, subscriptions: this.state(id).subscriptions })),
        publishedEvidenceRefs: [...new Set(updates.filter(post => post.author === agent).flatMap(post => post.evidenceRefs))]
          .filter(ref => evidence.some(item => item.id === ref)) };
      if (JSON.stringify(context).length <= this.kernel.maxContextChars) {
        const cursors = { ...state.cursors };
        for (const event of selected) cursors[(event.data as BoardUpdate).topicId] = event.seq;
        return { agent, context, seenCatalog, seenOwn, seenSubagents, cursors, directCursor: directSelected.at(-1)?.seq ?? state.directCursor ?? 0 };
      }
      if (selected.length + directSelected.length <= 1) throw new Error('Board context exceeds its character budget; required evidence is not truncated');
      if (selected.length) selected = selected.slice(0, -1);
      else directSelected = directSelected.slice(0, -1);
    }
  }
  private startTurn(prepared: Omit<Turn, 'id'>): Turn {
    const turns = this.kernel.events.filter(event => event.kind === 'board.turn').map(event => event.data as Turn);
    const ownTurns = turns.filter(turn => turn.agent === prepared.agent).length;
    const revisionTurns = turns.filter(turn => (turn.context.assessment?.revision ?? 1) === (prepared.context.assessment?.revision ?? 1));
    if (revisionTurns.length >= 48 || revisionTurns.filter(turn => turn.agent === prepared.agent).length >= 16) throw new Error('Board decision-turn budget exhausted; agents have not settled');
    const turn: Turn = { ...prepared, id: `${prepared.agent}-${ownTurns + 1}` };
    const changes: Change[] = [{ kind: 'board.turn', data: turn }];
    for (const update of turn.context.inbox) {
      const key = `board:${turn.agent}:${update.id}`;
      changes.push({ kind: 'board.delivery', data: { key, turnId: turn.id, from: update.author, to: turn.agent, updateId: update.id, topicId: update.topicId } });
      if (this.kernel.duplicateDelivery) changes.push({ kind: 'delivery.duplicate', data: { key } });
    }
    this.append(changes);
    return turn;
  }
  private async decision(turn: Turn): Promise<BoardDecision> {
    const saved = this.kernel.events.find(event => event.kind === 'board.decision' && (event.data as { turnId: string }).turnId === turn.id);
    if (saved) return (saved.data as { decision: BoardDecision }).decision;
    if (!this.options.decide && this.kernel.workerLabel !== 'scripted') throw new Error('Pi pub/sub requires a Pi decision worker as well as its stage worker');
    const decide = this.options.decide ?? scriptedBoardDecider;
    const starts = () => this.kernel.events.filter(event => event.kind === 'board.attempt.started' && (event.data as { turnId: string }).turnId === turn.id);
    for (const event of starts()) {
      const start = event.data as { turnId: string; attempt: number };
      if (!this.kernel.events.some(item => item.kind === 'board.attempt.failed' && (item.data as typeof start).turnId === turn.id && (item.data as typeof start).attempt === start.attempt)) {
        this.append([{ kind: 'board.attempt.failed', data: { ...start, interrupted: true, error: 'Interrupted decision attempt', elapsedMs: null } }]);
      }
    }
    while (starts().length < this.kernel.maxAttempts) {
      this.options.signal?.throwIfAborted();
      const attempt = starts().length + 1;
      this.append([{ kind: 'board.attempt.started', data: { turnId: turn.id, agent: turn.agent, attempt } }]);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = performance.now();
      const stop = () => controller.abort(new Error('Supervisor stopped'));
      this.options.signal?.addEventListener('abort', stop, { once: true });
      try {
        const deadline = new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
          timer = setTimeout(() => controller.abort(new Error('Board decision deadline exceeded')), this.kernel.timeoutMs);
        });
        const response = await Promise.race([decide({ context: structuredClone(turn.context), signal: controller.signal }), deadline]);
        controller.signal.throwIfAborted();
        const usage = response?.usage;
        const validUsage = usage && Number.isFinite(usage.input) && Number.isFinite(usage.output) && usage.input >= 0 && usage.output >= 0;
        this.append([{ kind: 'board.response', data: { turnId: turn.id, attempt, usage: validUsage ? usage : null } }]);
        if (JSON.stringify(response).length > 32000) throw new Error('Board decision exceeds output budget');
        if (usage && !validUsage) throw new Error('Invalid decision usage');
        const decision = validateDecision(response.data, turn.context);
        this.append([{ kind: 'board.decision', data: { turnId: turn.id, agent: turn.agent, attempt, decision, elapsedMs: performance.now() - started } }]);
        return decision;
      } catch (error) {
        // A storage exception after commit is an ambiguous acknowledgement, not
        // permission to ask the model again. Replay the saved decision on resume.
        if (this.kernel.events.some(event => event.kind === 'board.decision' && (event.data as { turnId: string }).turnId === turn.id)) throw error;
        this.append([{ kind: 'board.attempt.failed', data: { turnId: turn.id, attempt, error: error instanceof Error ? error.message : String(error), elapsedMs: performance.now() - started } }]);
        if (this.options.signal?.aborted || starts().length >= this.kernel.maxAttempts) throw error;
      } finally {
        if (timer) clearTimeout(timer);
        this.options.signal?.removeEventListener('abort', stop);
      }
    }
    throw new Error(`Decision attempt budget exhausted for ${turn.id}`);
  }
  private ensureTopic(topic: Topic): void {
    const existing = this.snapshot.topics.find(item => item.id === topic.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(topic)) throw new Error('Conflicting topic descriptor');
      return;
    }
    if (this.snapshot.topics.length >= 16) throw new Error('Topic budget exhausted (16)');
    this.append([{ kind: 'board.topic', data: topic }]);
  }
  private publish(update: BoardUpdate): void {
    const existing = this.snapshot.updates.find(item => item.id === update.id);
    if (existing) {
      if (existing.topicId !== update.topicId || existing.author !== update.author || existing.text !== update.text || JSON.stringify(existing.evidenceRefs) !== JSON.stringify(update.evidenceRefs)) throw new Error('Conflicting publication ID');
      return;
    }
    if (!this.snapshot.topics.some(topic => topic.id === update.topicId)) throw new Error('Unknown publication topic');
    if (this.snapshot.updates.length >= 64) throw new Error('Board update budget exhausted (64)');
    this.append([{ kind: 'board.update', data: update }]);
    this.trace(`${update.author} published to ${update.topicId}: ${update.text.slice(0, 160)}`);
  }
  private async apply(turn: Turn, decision: BoardDecision): Promise<void> {
    const previous = this.state(turn.agent);
    this.trace(`${turn.agent}: ${decision.status} Reason: ${decision.reason}`);
    for (const sub of decision.subscriptions) if (!previous.subscriptions.some(item => item.topicId === sub.topicId)) this.trace(`${turn.agent} subscribed to ${sub.topicId}: ${sub.reason}`);
    for (const sub of previous.subscriptions) if (!decision.subscriptions.some(item => item.topicId === sub.topicId)) this.trace(`${turn.agent} unsubscribed from ${sub.topicId}`);
    for (const topic of decision.createTopics) this.ensureTopic(topic);
    for (const [index, post] of decision.publish.entries()) this.publish({ ...post, id: `${turn.id}-post-${index + 1}`, author: turn.agent, createdAt: new Date().toISOString() });
    for (const [index, post] of (decision.directMessages ?? []).entries()) {
      this.saveDirect({ ...post, id: `${turn.id}-dm-${index + 1}`, from: turn.agent, createdAt: new Date().toISOString() });
    }
    await this.flushDirect();
    this.materialize();
    for (const spawn of decision.spawnSubagents ?? []) {
      const id = `sub-${turn.id}`;
      if (!this.options.subagentWorker && this.kernel.workerLabel !== 'scripted') throw new Error('Pi delegation requires a subagent worker');
      this.trace(`${turn.agent} requested ${id} (${spawn.name}): ${spawn.task}`);
      await runSubagentTask(this.kernel, { ...spawn, id, parent: turn.agent, depth: 1 },
        this.options.subagentWorker ?? scriptedSubagentWorker, this.options.signal);
      const result = this.snapshot.subagents.find(item => item.id === id)!;
      this.trace(`${id} ${result.status}; result returned only to ${turn.agent}.`);
      this.materialize();
    }
    if (decision.work) {
      const stage = decision.work;
      const inputs = this.kernel.scenario === 'intel' ? intelInputs(stage, turn.context.evidence, turn.context.assessment?.requiredSourceRefs)
        : requiredKinds[stage].map(kind => turn.context.evidence.find(item => item.kind === kind)!);
      if (!inputs) throw new Error('Required scenario evidence is unavailable');
      const revision = turn.context.assessment?.revision ?? 1;
      const taskId = revision === 1 ? taskIds[stage] : 'r' + revision + '-' + taskIds[stage];
      this.kernel.ensureTask(taskId, turn.agent, turn.context.goal, this.kernel.scenario === 'intel' ? revision : undefined);
      this.trace(`${turn.agent} chose to perform ${stage}.`);
      await this.kernel.execute(stage, taskId, turn.agent, inputs);
    }
    const state: AgentState = { agent: turn.agent, subscriptions: decision.subscriptions, status: decision.status,
      cursors: turn.cursors, knownRefs: turn.context.evidence.map(item => item.id),
      seenCatalog: turn.seenCatalog, seenOwn: turn.seenOwn, seenSubagents: turn.seenSubagents, turnId: turn.id, directCursor: turn.directCursor ?? 0 };
    if (this.kernel.scenario === 'intel') state.seenRevision = turn.context.assessment?.revision ?? 1;
    this.append([{ kind: 'board.state', data: state }, { kind: 'board.applied', data: { turnId: turn.id } },
      ...turn.context.inbox.map(update => ({ kind: 'receipt', data: { key: `board:${turn.agent}:${update.id}` } })),
      ...(turn.context.directInbox ?? []).map(message => ({ kind: 'receipt', data: { key: `direct:${turn.agent}:${message.id}` } })),
      ...(turn.context.subagents ?? []).filter(item => item.status !== 'pending' && !this.kernel.hasReceipt(`subagent:${turn.agent}:${item.id}`))
        .map(item => ({ kind: 'receipt', data: { key: `subagent:${turn.agent}:${item.id}` } }))]);
    this.materialize();
  }
  // Each slot covers a complete agent turn. A helper replaces its waiting parent
  // in that slot, so decisions, work, and helpers together respect the limit.
  private async runConcurrent(): Promise<void> {
    const active = new Map<WorkerId, Promise<void>>();
    let failure: unknown;
    let failed = false;
    try {
      for (;;) {
        this.options.signal?.throwIfAborted();
        if (failed) throw failure;
        while (active.size < this.kernel.maxConcurrentAgents) {
          const events = this.kernel.events;
          const pending = events.find(event => event.kind === 'board.turn' &&
            !active.has((event.data as Turn).agent) &&
            !events.some(item => item.kind === 'board.applied' && (item.data as {turnId:string}).turnId === (event.data as Turn).id));
          const last = events.findLast(event => event.kind === 'board.turn')?.data as Turn | undefined;
          const offset = last ? (agentIds.indexOf(last.agent) + 1) % agentIds.length : 0;
          const prepared = pending ? undefined : [...agentIds.slice(offset), ...agentIds.slice(0, offset)]
            .filter(agent => !active.has(agent)).map(agent => this.prepare(agent)).find(Boolean);
          const turn = pending ? pending.data as Turn : prepared ? this.startTurn(prepared) : undefined;
          if (!turn) break;
          const flight = Promise.resolve().then(async () => {
            await this.apply(turn, await this.decision(turn));
          }).catch(error => { if (!failed) { failed = true; failure = error; } })
            .finally(() => { active.delete(turn.agent); });
          active.set(turn.agent, flight);
        }
        if (!active.size) return;
        await Promise.race(active.values());
      }
    } finally {
      // Never return while another model request could still mutate this run.
      await Promise.allSettled(active.values());
    }
  }
  async run(): Promise<void> {
    this.options.signal?.throwIfAborted();
    this.initialize();
    await this.flushDirect();
    if (this.kernel.maxConcurrentAgents > 1) await this.runConcurrent();
    for (;;) {
      this.options.signal?.throwIfAborted();
      const events = this.kernel.events;
      const pending = events.find(event => event.kind === 'board.turn' && !events.some(item => item.kind === 'board.applied' && (item.data as { turnId: string }).turnId === (event.data as Turn).id));
      if (pending) {
        const turn = pending.data as Turn;
        await this.apply(turn, await this.decision(turn));
        continue;
      }
      // Rotate the first check after each turn so one chatty agent cannot starve others.
      const last = events.findLast(event => event.kind === 'board.turn')?.data as Turn | undefined;
      const offset = last ? (agentIds.indexOf(last.agent) + 1) % agentIds.length : 0;
      const next = [...agentIds.slice(offset), ...agentIds.slice(0, offset)].map(agent => this.prepare(agent)).find(Boolean);
      if (next) { this.startTurn(next); continue; }
      const report = this.kernel.currentArtifacts.find(item => item.kind === 'report');
      const complete = this.kernel.evaluate().success && this.kernel.currentTasks.every(task => task.status === 'completed') &&
        Boolean(report && (this.kernel.features.sharedSubjects ? this.snapshot.updates.some(update => update.author === 'reporter' && update.evidenceRefs.includes(report.id)) : this.snapshot.directMessages.some(message => message.from === 'reporter' && message.evidenceRefs.includes(report.id))));
      if (!complete && !this.options.allowIdle) throw new Error('Agents are idle without a published, verified report. Inspect their subscriptions and decisions; the broker will not assign work.');
      if (!complete) { this.materialize(); return; }
      if (!this.snapshot.settled) this.append([{ kind: 'board.settled', data: { completed: true } }]);
      this.materialize();
      return;
    }
  }
  post(topicId: string, text: string, descriptor?: Topic): BoardUpdate {
    if (!this.kernel.events.some(event => event.kind === 'board.started')) throw new Error('Start the pub/sub run before posting');
    if (!this.kernel.features.sharedSubjects) throw new Error('Shared subjects are disabled');
    textValue(text, 6000);
    if (this.snapshot.updates.length >= 64) throw new Error('Board update budget exhausted (64)');
    if (descriptor) this.ensureTopic(validateTopic(descriptor));
    const update: BoardUpdate = { id: `user-${randomUUID()}`, author: 'user', topicId,
      text: textValue(text, 6000), evidenceRefs: [], createdAt: new Date().toISOString() };
    this.publish(update);
    this.materialize();
    return update;
  }
  inject(value: unknown, topicId = 'intel-brief') {
    const result = this.kernel.injectIntelligence(value, topicId);
    this.trace('Intelligence source ' + (result.duplicate ? 'already recorded' : 'added') + '; assessment revision ' + result.revision + '.');
    this.materialize();
    return result;
  }
  materialize(): void {
    if (this.options.directory) writeBoardFiles(this.kernel.events, this.options.directory, this.kernel.runId);
  }
  private saveDirect(message: DirectMessage): void {
    const existing = this.snapshot.directMessages.find(item => item.id === message.id);
    if (existing) {
      if (digest({ ...existing, createdAt: '' }) !== digest({ ...message, createdAt: '' })) throw new Error('Conflicting direct message ID');
      return;
    }
    if (this.snapshot.directMessages.length >= 64) throw new Error('Direct message budget exhausted (64)');
    this.append([{ kind: 'board.direct', data: message }]);
    this.trace(`${message.from} messaged ${message.to}${message.topicId ? ' about ' + message.topicId : ''}: ${message.text.slice(0, 120)}`);
  }
  /** A durable transport receipt is separate from the recipient's processed receipt. */
  receiveDirect(message: DirectMessage, transport: Record<string, unknown> = { mode: 'inline' }): void {
    const saved = this.snapshot.directMessages.find(item => item.id === message.id);
    if (!saved || digest(saved) !== digest(message)) throw new Error('Message does not match committed outbox');
    if (!this.kernel.events.some(event => event.kind === 'board.direct.received' && (event.data as { id: string }).id === message.id)) {
      this.append([{ kind: 'board.direct.received', data: { id: message.id, to: message.to, ...transport } }]);
    }
  }
  private async flushDirect(): Promise<void> {
    const flight = this.directFlight.then(() => this.flushDirectUnlocked());
    this.directFlight = flight.catch(() => {});
    return flight;
  }
  private async flushDirectUnlocked(): Promise<void> {
    for (const message of this.snapshot.directMessages) {
      if (this.kernel.events.some(event => event.kind === 'board.direct.received' && (event.data as { id: string }).id === message.id)) continue;
      if (this.options.sendDirect) await this.options.sendDirect(message);
      else this.receiveDirect(message);
    }
  }
  direct(to: WorkerId, text: string, topicId?: string): DirectMessage {
    if (!this.kernel.features.directMessages) throw new Error('Direct messages are disabled');
    if (!agentIds.includes(to)) throw new Error('Unknown direct message recipient');
    if (topicId && !this.snapshot.topics.some(topic => topic.id === topicId)) throw new Error('Unknown direct message topic');
    const message: DirectMessage = { id: `user-${randomUUID()}`, from: 'user', to,
      text: textValue(text, 6000), evidenceRefs: [], createdAt: new Date().toISOString(), ...(topicId ? { topicId } : {}) };
    this.saveDirect(message);
    this.materialize();
    return message;
  }
}

export function formatBoard(events: JournalEvent[]): string {
  const board = boardSnapshot(events);
  if (!board.topics.length) return 'No topic board is recorded for this run (older pub/sub runs used fixed routing).';
  const lines = ['TOPIC BOARD', `State: ${board.settled ? 'settled' : 'pending or incomplete'}`, '', 'SUBJECTS'];
  for (const topic of board.topics) lines.push(`${topic.id}: ${topic.description}`);
  lines.push('', 'AGENTS');
  for (const agent of agentIds) {
    const state = board.agents.find(item => item.agent === agent);
    const latest = board.decisions.findLast(item => item.agent === agent);
    const pending = latest && latest.turnId !== state?.turnId;
    lines.push(`${agent}: ${pending ? `${latest.decision.status} (saved choice pending completion)` : state?.status ?? 'No completed decision yet.'}`);
    for (const sub of state?.subscriptions ?? []) lines.push(`  follows ${sub.topicId} — ${sub.reason}`);
  }
  lines.push('', 'UPDATES');
  for (const post of board.updates) lines.push(`[${post.topicId}] ${post.author}: ${post.text}`);
  lines.push('', 'DIRECT MESSAGES (operator audit)');
  for (const message of board.directMessages) lines.push(`${message.from} -> ${message.to}${message.topicId ? ' [' + message.topicId + ']' : ''}: ${message.text}`);
  lines.push('', 'SUBAGENTS');
  for (const child of board.subagents) lines.push(`${child.id} (${child.name}), parent ${child.parent}: ${child.status}`);
  return lines.join('\n');
}

/** Readable projections of committed history. Agents cannot choose paths or modify other agents' files. */
export function writeBoardFiles(events: JournalEvent[], directory: string, runId: string): void {
  const root = resolve(directory);
  const board = boardSnapshot(events);
  const isIntel = (events.find(event => event.kind === 'run.started')?.data as { scenario?: string })?.scenario === 'intel';
  const profiles = isIntel ? intelProfiles : agentProfiles;
  const revision = currentRevision(events);
  const write = (relative: string, content: string, immutable = false) => {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
    if (immutable && existsSync(path)) throw new Error(`Generated update file differs from its journal: ${path}`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, { flag: 'wx' });
    try {
      // Windows sync/indexing clients can briefly hold the destination without
      // delete-sharing. Retry the atomic replacement; never fall back to truncation.
      for (let attempt = 0; ; attempt++) {
        try { renameSync(temporary, path); break; }
        catch (error) {
          if (attempt >= 7 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  };
  const overview = [
    '# Shared topic board', `Run: ${runId}`, `State: ${board.settled ? 'settled — waiting for new notes' : 'pending or incomplete'}`,
    ...(isIntel ? ['Assessment revision: ' + revision + '. [Revision history](assessments/index.json). Evidence output files show the latest completed stages; consult revision history for pending work.'] : []),
    'These files are generated from the journal. Use the CLI post command to add notes; direct file edits are not imported.',
    '## Subjects', board.topics.map(topic => `- [${topic.title}](topics/${topic.id}.md): ${topic.description}`).join('\n'),
    '## Workers', agentIds.map(agent => {
      const state = board.agents.find(item => item.agent === agent);
      return `- [${agent} status](agents/${agent}/status.md) · [decisions](agents/${agent}/decisions.md) · [subscriptions](agents/${agent}/subscriptions.json)\n  Follows: ${state?.subscriptions.map(sub => sub.topicId).join(', ') || '(none)'}. ${state?.status ?? 'Discovering subjects.'}`;
    }).join('\n'),
    '## Publications', board.updates.map(post => `- [${post.id}](updates/${post.id}.md) — ${post.author} on **${post.topicId}**`).join('\n'),
    '## Evidence', (isIntel ? '[Intelligence brief](evidence/fixture.json) · [Initial source assignments](assignments.json)' : '[Supplied inventory](evidence/fixture.json)') + ' · [Analysis](evidence/analysis.json) · [Review](evidence/review.json) · [Report](evidence/report.json)',
    ...(isIntel ? ['Original source files are in evidence/sources/. This folder is an operator audit view, not an agent filesystem. Agents receive only their assigned sources and references delivered through subjects or direct messages.'] : []),
    '## Temporary subagents', board.subagents.map(child => `- [${child.name}](subagents/${child.id}.md) — parent: ${child.parent}, status: ${child.status}`).join('\n') || '(none requested)',
  ];
  write('README.md', overview.join('\n\n') + '\n');
  write('board.json', JSON.stringify(board, null, 2) + '\n');
  if (isIntel) write('assignments.json', JSON.stringify(events.filter(event => event.kind === 'board.assignment').map(event => event.data), null, 2) + '\n');
  if (isIntel) write('assessments/index.json', JSON.stringify({ currentRevision: revision,
    revisions: Array.from({ length: revision }, (_, index) => {
      const number = index + 1;
      const artifacts = events.filter(event => event.kind === 'artifact').map(event => event.data as Artifact)
        .filter(item => revisionOf(item) === number && ['analysis', 'review', 'report'].includes(item.kind));
      return { revision: number, status: number < revision ? 'superseded' : artifacts.some(item => item.kind === 'report') && board.settled ? 'complete' : 'pending',
        artifacts: artifacts.map(item => ({ kind: item.kind, id: item.id, path: 'revision-' + number + '/' + item.kind + '.json' })) };
    }) }, null, 2) + '\n');
  write('subagents/index.json', JSON.stringify(board.subagents, null, 2) + '\n');
  for (const child of board.subagents) write(`subagents/${child.id}.md`,
    `# ${child.name}\n\nParent: ${child.parent}\nStatus: ${child.status}\n\nTask: ${child.task}\n\n${child.result?.findings ?? child.error ?? 'Pending'}\n\nAdvisory only; not a validated stage result.\n\nLimitations:\n${child.result?.limitations.join('\n') ?? ''}\n`);
  write('topics/index.json', JSON.stringify(board.topics, null, 2) + '\n');
  for (const topic of board.topics) {
    write(`topics/${topic.id}.md`, `# ${topic.title}\n\n${topic.description}\n\n` + board.updates.filter(post => post.topicId === topic.id)
      .map(post => `## ${post.author} — ${post.createdAt}\n\n${post.text}\n\nUpdate: ${post.id}\n`).join('\n'));
  }
  for (const post of board.updates) write(`updates/${post.id}.md`, `# ${post.topicId}\n\nAuthor: ${post.author}\nDate: ${post.createdAt}\nID: ${post.id}\n\n${post.text}\n\nEvidence:\n${post.evidenceRefs.map(ref => `- ${ref}`).join('\n')}\n`, true);
  for (const agent of agentIds) {
    const state = board.agents.find(item => item.agent === agent);
    const latest = board.decisions.findLast(item => item.agent === agent);
    write(`agents/${agent}/status.md`, `# ${agent}\n\nGoal: ${profiles[agent].goal}\n\n${latest?.decision.status ?? state?.status ?? 'Discovering subjects.'}\n`);
    write(`agents/${agent}/subscriptions.json`, JSON.stringify(state?.subscriptions ?? [], null, 2) + '\n');
    write(`agents/${agent}/messages.md`, `# ${agent}: direct messages\n\n` + board.directMessages.filter(message => message.from === agent || message.to === agent)
      .map(message => `## ${message.from} → ${message.to} (${message.id})\n\n${message.text}\n\nSubject: ${message.topicId ?? '(none)'}\n`).join('\n'));
    write(`agents/${agent}/decisions.md`, `# ${agent}: decisions\n\n` + board.decisions.filter(item => item.agent === agent).map(item =>
      `## ${item.turnId}\n\n${item.decision.reason}\n\nSubscriptions:\n\n${item.decision.subscriptions.map(sub => `- ${sub.topicId}: ${sub.reason}`).join('\n') || '(none)'}\n\nAction: ${item.decision.work ?? 'read/publish/wait'}\n`).join('\n'));
  }
  for (const event of events.filter(item => item.kind === 'artifact')) {
    const artifact = event.data as Artifact;
    if (isIntel && ['analysis', 'review', 'report'].includes(artifact.kind)) {
      write('assessments/revision-' + revisionOf(artifact) + '/' + artifact.kind + '.json', JSON.stringify(artifact, null, 2) + '\n', true);
    }
    const source = sourceId(artifact);
    if (source && slug.test(source)) write(`evidence/sources/${source}.json`, JSON.stringify(artifact, null, 2) + '\n');
    if (['fixture', 'analysis', 'review', 'report'].includes(artifact.kind)) write(`evidence/${artifact.kind}.json`, JSON.stringify(artifact, null, 2) + '\n');
  }
}
