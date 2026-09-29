import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Kernel } from './kernel.ts';
import type { Artifact, JournalEvent, Stage, WorkerId } from './types.ts';
import { evaluateReport } from './workers.ts';
import { scriptedBoardDecider } from './board-policy.ts';
import { agentIds, agentProfiles, boardSnapshot } from './board-types.ts';
import type { AgentState, BoardContext, BoardDecision, BoardDecider, BoardUpdate, Topic } from './board-types.ts';

type Change = { kind: string; data: unknown };
type Turn = { id: string; agent: WorkerId; context: BoardContext; seenCatalog: string; seenOwn: string; cursors: Record<string, number> };
export interface BoardOptions { decide?: BoardDecider; directory?: string; trace?: (line: string) => void }
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
  const allowed = ['subscriptions', 'status', 'reason', 'createTopics', 'publish', 'work'];
  if (Object.keys(item).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(item, key))) throw new Error('Board decision has missing or unknown fields');
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
    const evidenceRefs = array(post.evidenceRefs, 8).map(value => textValue(value, 250));
    if (new Set(evidenceRefs).size !== evidenceRefs.length || evidenceRefs.some(ref => !known.has(ref))) throw new Error('Publication contains unavailable evidence');
    return { topicId, text: textValue(post.text, 6000), evidenceRefs };
  });
  if (item.work !== null && (!context.availableWork || item.work !== context.availableWork)) throw new Error('Requested work is unavailable to this agent');
  return { subscriptions, status: textValue(item.status, 500), reason: textValue(item.reason, 1500),
    createTopics, publish, work: item.work as Stage | null };
}

/** Broker owns delivery only. All subscription, publication and work choices come from a decider. */
export class TopicBoard {
  readonly kernel: Kernel;
  readonly options: BoardOptions;
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
      agent, subscriptions: [], status: 'Discovering subjects.', cursors: {}, knownRefs: [], seenCatalog: '', seenOwn: '', turnId: '',
    };
  }
  initialize(): void {
    if (this.kernel.events.some(event => event.kind === 'board.started')) return;
    const now = new Date().toISOString();
    this.append([
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
    const followed = new Set(state.subscriptions.map(sub => sub.topicId));
    const unread = this.kernel.events.filter(event => event.kind === 'board.update' &&
      followed.has((event.data as BoardUpdate).topicId) && (event.data as BoardUpdate).author !== agent &&
      event.seq > (state.cursors[(event.data as BoardUpdate).topicId] ?? 0));
    const ownWork = this.kernel.artifacts.filter(artifact => artifact.producer === agent && ['analysis', 'review', 'report'].includes(artifact.kind));
    const seenCatalog = digest(topics);
    const seenOwn = digest(ownWork.map(item => item.id));
    if (state.seenCatalog === seenCatalog && state.seenOwn === seenOwn && !unread.length) return undefined;
    let selected = unread.slice(0, 4);
    for (;;) {
      const inbox = selected.map(event => event.data as BoardUpdate);
      const refs = new Set([...state.knownRefs, ...ownWork.map(item => item.id), ...inbox.flatMap(post => post.evidenceRefs)]);
      const evidence = this.kernel.artifacts.filter(artifact => refs.has(artifact.id));
      const { capability, goal } = agentProfiles[agent];
      const ready = !ownWork.length && requiredKinds[capability].every(kind => evidence.some(item => item.kind === kind)) &&
        (capability !== 'report' || evidence.some(item => item.kind === 'review' && (item.data as { approved: boolean }).approved));
      const context: BoardContext = { agent, goal, capability, catalog: topics, subscriptions: state.subscriptions,
        status: state.status, inbox, evidence, ownWork, availableWork: ready ? capability : null,
        publishedEvidenceRefs: updates.filter(post => post.author === agent).flatMap(post => post.evidenceRefs) };
      if (JSON.stringify(context).length <= this.kernel.maxContextChars) {
        const cursors = { ...state.cursors };
        for (const event of selected) cursors[(event.data as BoardUpdate).topicId] = event.seq;
        return { agent, context, seenCatalog, seenOwn, cursors };
      }
      if (selected.length <= 1) throw new Error('Board context exceeds its character budget; required evidence is not truncated');
      selected = selected.slice(0, -1);
    }
  }
  private startTurn(prepared: Omit<Turn, 'id'>): Turn {
    const turns = this.kernel.events.filter(event => event.kind === 'board.turn').map(event => event.data as Turn);
    const ownTurns = turns.filter(turn => turn.agent === prepared.agent).length;
    if (turns.length >= 48 || ownTurns >= 16) throw new Error('Board decision-turn budget exhausted; agents have not settled');
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
    if (!this.options.decide && this.kernel.workerLabel !== 'scripted') throw new Error('Pi pub/sub requires a Pi decision worker as well as its inventory worker');
    const decide = this.options.decide ?? scriptedBoardDecider;
    const starts = () => this.kernel.events.filter(event => event.kind === 'board.attempt.started' && (event.data as { turnId: string }).turnId === turn.id);
    for (const event of starts()) {
      const start = event.data as { turnId: string; attempt: number };
      if (!this.kernel.events.some(item => item.kind === 'board.attempt.failed' && (item.data as typeof start).turnId === turn.id && (item.data as typeof start).attempt === start.attempt)) {
        this.append([{ kind: 'board.attempt.failed', data: { ...start, interrupted: true, error: 'Interrupted decision attempt', elapsedMs: null } }]);
      }
    }
    while (starts().length < this.kernel.maxAttempts) {
      const attempt = starts().length + 1;
      this.append([{ kind: 'board.attempt.started', data: { turnId: turn.id, agent: turn.agent, attempt } }]);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = performance.now();
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Board decision deadline exceeded')); }, this.kernel.timeoutMs);
        });
        const response = await Promise.race([decide({ context: structuredClone(turn.context), signal: controller.signal }), deadline]);
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
        if (starts().length >= this.kernel.maxAttempts) throw error;
      } finally { if (timer) clearTimeout(timer); }
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
    this.materialize();
    if (decision.work) {
      const stage = decision.work;
      const inputs = requiredKinds[stage].map(kind => turn.context.evidence.find(item => item.kind === kind)!);
      this.kernel.ensureTask(taskIds[stage], turn.agent, agentProfiles[turn.agent].goal);
      this.trace(`${turn.agent} chose to perform ${stage}.`);
      await this.kernel.execute(stage, taskIds[stage], turn.agent, inputs);
    }
    const state: AgentState = { agent: turn.agent, subscriptions: decision.subscriptions, status: decision.status,
      cursors: turn.cursors, knownRefs: turn.context.evidence.map(item => item.id),
      seenCatalog: turn.seenCatalog, seenOwn: turn.seenOwn, turnId: turn.id };
    this.append([{ kind: 'board.state', data: state }, { kind: 'board.applied', data: { turnId: turn.id } },
      ...turn.context.inbox.map(update => ({ kind: 'receipt', data: { key: `board:${turn.agent}:${update.id}` } }))]);
    this.materialize();
  }
  async run(): Promise<void> {
    this.initialize();
    for (;;) {
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
      const report = this.kernel.artifacts.find(item => item.kind === 'report');
      const complete = evaluateReport(this.kernel.artifacts).success && this.kernel.tasks.every(task => task.status === 'completed') &&
        Boolean(report && this.snapshot.updates.some(update => update.author === 'reporter' && update.evidenceRefs.includes(report.id)));
      if (!complete) throw new Error('Agents are idle without a published, verified report. Inspect their subscriptions and decisions; the broker will not assign work.');
      if (!this.snapshot.settled) this.append([{ kind: 'board.settled', data: { completed: true } }]);
      this.materialize();
      return;
    }
  }
  post(topicId: string, text: string, descriptor?: Topic): BoardUpdate {
    if (!this.kernel.events.some(event => event.kind === 'board.started')) throw new Error('Start the pub/sub run before posting');
    textValue(text, 6000);
    if (this.snapshot.updates.length >= 64) throw new Error('Board update budget exhausted (64)');
    if (descriptor) this.ensureTopic(validateTopic(descriptor));
    const update: BoardUpdate = { id: `user-${randomUUID()}`, author: 'user', topicId,
      text: textValue(text, 6000), evidenceRefs: [], createdAt: new Date().toISOString() };
    this.publish(update);
    this.materialize();
    return update;
  }
  materialize(): void {
    if (this.options.directory) writeBoardFiles(this.kernel.events, this.options.directory, this.kernel.runId);
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
  return lines.join('\n');
}

/** Readable projections of committed history. Agents cannot choose paths or modify other agents' files. */
export function writeBoardFiles(events: JournalEvent[], directory: string, runId: string): void {
  const root = resolve(directory);
  const board = boardSnapshot(events);
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
    'These files are generated from the journal. Use the CLI post command to add notes; direct file edits are not imported.',
    '## Subjects', board.topics.map(topic => `- [${topic.title}](topics/${topic.id}.md): ${topic.description}`).join('\n'),
    '## Workers', agentIds.map(agent => {
      const state = board.agents.find(item => item.agent === agent);
      return `- [${agent} status](agents/${agent}/status.md) · [decisions](agents/${agent}/decisions.md) · [subscriptions](agents/${agent}/subscriptions.json)\n  Follows: ${state?.subscriptions.map(sub => sub.topicId).join(', ') || '(none)'}. ${state?.status ?? 'Discovering subjects.'}`;
    }).join('\n'),
    '## Publications', board.updates.map(post => `- [${post.id}](updates/${post.id}.md) — ${post.author} on **${post.topicId}**`).join('\n'),
    '## Evidence', '[Supplied inventory](evidence/fixture.json) · [Analysis](evidence/analysis.json) · [Review](evidence/review.json) · [Report](evidence/report.json)',
  ];
  write('README.md', overview.join('\n\n') + '\n');
  write('board.json', JSON.stringify(board, null, 2) + '\n');
  write('topics/index.json', JSON.stringify(board.topics, null, 2) + '\n');
  for (const topic of board.topics) {
    write(`topics/${topic.id}.md`, `# ${topic.title}\n\n${topic.description}\n\n` + board.updates.filter(post => post.topicId === topic.id)
      .map(post => `## ${post.author} — ${post.createdAt}\n\n${post.text}\n\nUpdate: ${post.id}\n`).join('\n'));
  }
  for (const post of board.updates) write(`updates/${post.id}.md`, `# ${post.topicId}\n\nAuthor: ${post.author}\nDate: ${post.createdAt}\nID: ${post.id}\n\n${post.text}\n\nEvidence:\n${post.evidenceRefs.map(ref => `- ${ref}`).join('\n')}\n`, true);
  for (const agent of agentIds) {
    const state = board.agents.find(item => item.agent === agent);
    const latest = board.decisions.findLast(item => item.agent === agent);
    write(`agents/${agent}/status.md`, `# ${agent}\n\nGoal: ${agentProfiles[agent].goal}\n\n${latest?.decision.status ?? state?.status ?? 'Discovering subjects.'}\n`);
    write(`agents/${agent}/subscriptions.json`, JSON.stringify(state?.subscriptions ?? [], null, 2) + '\n');
    write(`agents/${agent}/decisions.md`, `# ${agent}: decisions\n\n` + board.decisions.filter(item => item.agent === agent).map(item =>
      `## ${item.turnId}\n\n${item.decision.reason}\n\nSubscriptions:\n\n${item.decision.subscriptions.map(sub => `- ${sub.topicId}: ${sub.reason}`).join('\n') || '(none)'}\n\nAction: ${item.decision.work ?? 'read/publish/wait'}\n`).join('\n'));
  }
  for (const event of events.filter(item => item.kind === 'artifact')) {
    const artifact = event.data as Artifact;
    if (['fixture', 'analysis', 'review', 'report'].includes(artifact.kind)) write(`evidence/${artifact.kind}.json`, JSON.stringify(artifact, null, 2) + '\n');
  }
}
