import type { JournalEvent } from './types.ts';
export function usageReport(events: JournalEvent[], worker: string) {
  const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, missingUsage: 0 });
  const total = empty(), byAgent: Record<string, ReturnType<typeof empty>> = {}, byActivity: Record<string, ReturnType<typeof empty>> = {};
  const starts: Record<string, [string, string]> = { 'attempt.started': ['work', 'worker.response'], 'board.attempt.started': ['decision', 'board.response'], 'subagent.attempt.started': ['helper', 'subagent.response'] };
  for (const [index, event] of events.entries()) {
    const pair = starts[event.kind]; if (!pair) continue;
    const data = event.data as any, [activity, responseKind] = pair;
    const key = activity === 'work' ? 'taskId' : activity === 'decision' ? 'turnId' : 'id';
    const response = events.find(e => e.kind === responseKind && (e.data as any)[key] === data[key] && (e.data as any).attempt === data.attempt)?.data as any;
    let agent = 'unknown';
    if (activity === 'work') agent = (events.slice(0, index).findLast(e => e.kind === 'task' && (e.data as any).id === data.taskId)?.data as any)?.owner ?? agent;
    if (activity === 'decision') agent = (events.find(e => e.kind === 'board.turn' && (e.data as any).id === data.turnId)?.data as any)?.agent ?? agent;
    if (activity === 'helper') agent = (events.find(e => e.kind === 'subagent.requested' && (e.data as any).id === data.id)?.data as any)?.parent ?? agent;
    const usage = response?.usage;
    for (const row of [total, byAgent[agent] ??= empty(), byActivity[activity] ??= empty()]) {
      row.calls++;
      if (!usage && worker !== 'scripted') row.missingUsage++;
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) row[field] += usage?.[field] ?? 0;
    }
  }
  return { measurement: worker === 'scripted' ? 'no-model' : worker === 'pi-faux' ? 'synthetic' : 'provider-reported',
    complete: total.missingUsage === 0, total, byAgent, byActivity,
    cacheBreakdownAvailable: events.some(e => e.kind.endsWith('.response') && (e.data as any).usage?.cacheRead !== undefined) };
}
