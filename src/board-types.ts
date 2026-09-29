import type { Artifact, JournalEvent, Stage, WorkerId, WorkResult } from './types.ts';

export interface Topic { id: string; title: string; description: string }
export interface Subscription { topicId: string; reason: string }
export interface BoardUpdate {
  id: string; topicId: string; author: WorkerId | 'system' | 'user';
  text: string; evidenceRefs: string[]; createdAt: string;
}
export interface AgentState {
  agent: WorkerId; subscriptions: Subscription[]; status: string;
  cursors: Record<string, number>; knownRefs: string[];
  seenCatalog: string; seenOwn: string; turnId: string;
}
export interface BoardDecision {
  subscriptions: Subscription[];
  status: string;
  reason: string;
  createTopics: Topic[];
  publish: { topicId: string; text: string; evidenceRefs: string[] }[];
  work: Stage | null;
}
export interface BoardContext {
  agent: WorkerId; goal: string; capability: Stage;
  catalog: Topic[]; subscriptions: Subscription[]; status: string;
  inbox: BoardUpdate[]; evidence: Artifact[]; availableWork: Stage | null;
  ownWork: Artifact[]; publishedEvidenceRefs: string[];
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
  const activity = events.findLast(e => e.kind.startsWith('board.') && e.kind !== 'board.settled');
  return { topics, updates, agents: [...agents.values()], decisions,
    settled: Boolean(settled && (!activity || settled.seq > activity.seq)) };
}
