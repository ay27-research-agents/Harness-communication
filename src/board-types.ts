import type { MessageMetadata } from './operation.ts';
import type { Features } from './features.ts';
import type { Artifact, JournalEvent, Scenario, Stage, WorkerId, WorkResult } from './types.ts';
import { subagentSnapshot, type SpawnRequest, type SubagentRecord } from './subagent-types.ts';

export interface Topic { id: string; title: string; description: string }
export interface Subscription { topicId: string; reason: string }
export interface DirectPost {
  to: WorkerId; topicId?: string; text: string; evidenceRefs: string[]; replyTo?: string;
}
export interface DirectMessage extends DirectPost, Partial<MessageMetadata> {
  id: string; from: WorkerId | 'user'; createdAt: string;
}
export interface BoardUpdate extends Partial<MessageMetadata> {
  id: string; topicId: string; author: WorkerId | 'system' | 'user';
  text: string; evidenceRefs: string[]; createdAt: string;
}
export interface AgentState {
  readEvidenceRefs?: string[];
  seenRevision?: number;
  agent: WorkerId; subscriptions: Subscription[]; status: string;
  cursors: Record<string, number>; knownRefs: string[];
  seenCatalog: string; seenOwn: string; turnId: string;
  directCursor?: number;
  seenSubagents?: string;
}
export interface BoardDecision {
  readEvidenceRefs?: string[];
  subscriptions: Subscription[];
  status: string;
  reason: string;
  createTopics: Topic[];
  publish: { topicId: string; text: string; evidenceRefs: string[] }[];
  work: Stage | null;
  directMessages?: DirectPost[];
  spawnSubagents?: SpawnRequest[];
}
export interface BoardContext {
  readEvidenceRefs?: string[];
  features?: Features;
  sentEvidenceRefs?: Record<string, string[]>;
  assessment?: { revision: number; requiredSourceRefs: string[]; changedClaims: string[] };
  scenario?: Scenario;
  agent: WorkerId; goal: string; capability: Stage;
  catalog: Topic[]; subscriptions: Subscription[]; status: string;
  inbox: BoardUpdate[]; evidence: Artifact[]; availableWork: Stage | null;
  /** Index only: complete result bodies are already present in evidence. */
  ownWork: Pick<Artifact, 'id' | 'kind' | 'revision'>[]; publishedEvidenceRefs: string[];
  directInbox?: DirectMessage[];
  peers?: { agent: WorkerId; goal: string; subscriptions: Subscription[] }[];
  transport?: 'inline' | 'socket';
  delegation?: { canSpawn: boolean; remaining: number; maxDepth: 1; maxPerParent: 1; demo: boolean };
  subagents?: SubagentRecord[];
}
export interface BoardRequest { context: BoardContext; signal?: AbortSignal }
export type BoardDecider = (request: BoardRequest) => Promise<WorkResult>;

export const agentIds: WorkerId[] = ['analyst', 'reviewer', 'reporter'];
export const agentProfiles: Record<WorkerId, { capability: Stage; goal: string }> = {
  analyst: { capability: 'analyze', goal: 'Find differences in supplied synthetic inventory. Choose relevant subjects to follow. Publish your analysis with its fixture evidence so others can inspect it.' },
  reviewer: { capability: 'review', goal: 'Independently verify unreviewed inventory findings. Choose subjects that carry useful evidence. Publish your review with the analysis and fixture evidence.' },
  reporter: { capability: 'report', goal: 'Write a concise report of approved inventory findings. Follow subjects useful to that goal. Publish the final report with all supporting evidence.' },
};

export function boardSnapshot(events: JournalEvent[]) {
  const topics = events.filter(e => e.kind === 'board.topic').map(e => e.data as Topic);
  const updates = events.filter(e => e.kind === 'board.update').map(e => e.data as BoardUpdate);
  const agents = new Map<WorkerId, AgentState>();
  for (const e of events) if (e.kind === 'board.state') {
    const state = e.data as AgentState;
    agents.set(state.agent, state);
  }
  const decisions = events.filter(e => e.kind === 'board.decision').map(e => e.data as {
    turnId: string; agent: WorkerId; decision: BoardDecision;
  });
  const settled = events.findLast(e => e.kind === 'board.settled');
  const activity = events.findLast(e => (e.kind.startsWith('board.') || e.kind.startsWith('subagent.') && !e.kind.startsWith('subagent.process.')) && e.kind !== 'board.settled');
  const directMessages = events.filter(e => e.kind === 'board.direct').map(e => e.data as DirectMessage);
  const deliveryStatus = directMessages.map(message => {
    const received = events.find(event => event.kind === 'board.direct.received' && (event.data as any).id === message.id);
    const processed = events.some(event => event.kind === 'receipt' && (event.data as any).key === 'direct:' + message.to + ':' + message.id);
    return {id:message.id,operationId:message.operationId,
      state:(received?.data as any)?.status === 'expired' ? 'expired' : processed ? 'processed' : received ? 'received' : 'queued'};
  });
  return { topics, updates, directMessages, deliveryStatus, subagents: subagentSnapshot(events), agents: [...agents.values()], decisions,
    settled: Boolean(settled && (!activity || settled.seq > activity.seq)) };
}
