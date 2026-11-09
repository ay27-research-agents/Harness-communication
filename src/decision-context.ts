import type { BoardContext } from './board-types.ts';

/** Full evidence stays in the journal and work-stage inputs. */
export function decisionContext(context: BoardContext) {
  const requested = new Set(context.readEvidenceRefs ?? []);
  const evidence = context.evidence.map(artifact => {
    if (artifact.kind === 'fixture' || artifact.producer === context.agent || requested.has(artifact.id)) return artifact;
    const data = artifact.data as Record<string, unknown>;
    return {
      id: artifact.id, kind: artifact.kind, revision: artifact.revision,
      title: data.title ?? artifact.kind,
      recordedAt: data.recordedAt,
      characters: JSON.stringify(artifact.data).length,
      bodyAvailable: true
    };
  });
  return { ...context, evidence };
}
