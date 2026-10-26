import type { Artifact, JournalEvent, WorkerId, WorkResult } from './types.ts';

export interface SpawnRequest { name: string; task: string; evidenceRefs: string[] }
export interface SubagentTask extends SpawnRequest { id: string; parent: WorkerId; depth: 1 }
export interface SubagentContext extends SubagentTask { evidence: Artifact[] }
export interface SubagentRequest { context: SubagentContext; signal?: AbortSignal }
export type SubagentWorker = (request: SubagentRequest) => Promise<WorkResult>;
export interface SubagentFinding { findings: string; evidenceRefs: string[]; limitations: string[] }
export interface SubagentRecord extends SubagentTask {
  status: 'pending' | 'completed' | 'failed';
  result?: SubagentFinding; error?: string;
}
export function subagentSnapshot(events: JournalEvent[]): SubagentRecord[] {
  return events.filter(event => event.kind === 'subagent.requested').map(event => {
    const task = event.data as SubagentTask;
    const terminal = events.findLast(item => ['subagent.completed', 'subagent.failed'].includes(item.kind) && (item.data as { id: string }).id === task.id);
    return { ...task, status: terminal?.kind === 'subagent.completed' ? 'completed' : terminal ? 'failed' : 'pending',
      ...(terminal ? terminal.data as { result?: SubagentFinding; error?: string } : {}) };
  });
}
