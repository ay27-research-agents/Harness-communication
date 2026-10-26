import type { Artifact, JournalEvent } from './types.ts';

export type ClaimId = 'atlas-primary' | 'protected-dependency' | 'backup-ready';
export type ClaimStatus = 'confirmed' | 'refuted' | 'unresolved';
export interface IntelUpdate {
  sourceId: string; title: string; observedAt: string; recordedAt: string;
  provenance: string; observations: string; reliability: 'direct' | 'unverified';
  claims: { id: ClaimId; status: ClaimStatus }[];
}
export interface AssessmentRevision {
  revision: number; sourceRefs: string[]; changedClaims: ClaimId[];
  previousReportRef?: string;
}
export const maxIntelUpdates = 4;
export const backupTestExample: IntelUpdate = {
  sourceId: 'beacon-readiness-test', title: 'BEACON witnessed readiness test',
  observedAt: '2026-10-08T10:15:00Z', recordedAt: '2026-10-08T10:20:00Z',
  provenance: 'Fictional exercise engineer: signed test record with a named exercise-control witness.',
  observations: 'The supplied tabletop test record shows BEACON passing the readiness test at 10:15Z. It contains no change to ATLAS medical-telemetry dependencies or the exercise constraints.',
  reliability: 'direct', claims: [{ id: 'backup-ready', status: 'confirmed' }],
};

/** Operator-supplied exercise evidence. This validates its format, not external truth. */
export function validateIntelUpdate(value: unknown): IntelUpdate {
  const fail = (message: string): never => { throw new Error('Intelligence source: ' + message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected a JSON object');
  const item = value as Record<string, unknown>;
  const fields = ['sourceId', 'title', 'observedAt', 'recordedAt', 'provenance', 'observations', 'reliability', 'claims'];
  if (Object.keys(item).length !== fields.length || fields.some(field => !Object.hasOwn(item, field))) fail('unexpected or missing fields');
  for (const [key, max] of [['sourceId', 64], ['title', 120], ['provenance', 500], ['observations', 2000]] as const) {
    if (typeof item[key] !== 'string' || !item[key].trim() || item[key].length > max) fail(key + ' must contain 1..' + max + ' characters');
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(item.sourceId as string)) fail('sourceId must be a lowercase slug');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(item.sourceId as string)) fail('sourceId is a reserved file name');
  for (const field of ['observedAt', 'recordedAt']) {
    if (typeof item[field] !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(item[field] as string) ||
      !Number.isFinite(Date.parse(item[field] as string)) ||
      new Date(item[field] as string).toISOString().replace('.000Z', 'Z') !== item[field]) fail(field + ' must be a valid UTC timestamp, YYYY-MM-DDTHH:MM:SSZ');
  }
  if (Date.parse(item.observedAt as string) > Date.parse(item.recordedAt as string)) fail('observation cannot be later than the record');
  if (!['direct', 'unverified'].includes(item.reliability as string)) fail('reliability must be direct or unverified');
  if (!Array.isArray(item.claims) || item.claims.length < 1 || item.claims.length > 3) fail('include 1..3 claims');
  const seen = new Set<string>();
  const claims = (item.claims as unknown[]).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid claim');
    const claim = value as Record<string, unknown>;
    if (Object.keys(claim).length !== 2 || !['atlas-primary', 'protected-dependency', 'backup-ready'].includes(claim.id as string) ||
      !['confirmed', 'refuted', 'unresolved'].includes(claim.status as string) || seen.has(claim.id as string)) fail('unknown or repeated claim, status, or field');
    seen.add(claim.id as string);
    return { id: claim.id as ClaimId, status: claim.status as ClaimStatus };
  });
  return { sourceId: item.sourceId as string, title: item.title as string, observedAt: item.observedAt as string,
    recordedAt: item.recordedAt as string, provenance: item.provenance as string, observations: item.observations as string,
    reliability: item.reliability as IntelUpdate['reliability'], claims };
}
export function revisionOf(value: { revision?: number }): number { return value.revision ?? 1; }
export function currentRevision(events: JournalEvent[]): number {
  return (events.findLast(event => event.kind === 'intel.revision')?.data as AssessmentRevision | undefined)?.revision ?? 1;
}
export function revisionArtifacts(artifacts: Artifact[], revision: number): Artifact[] {
  return artifacts.filter(item => ['analysis', 'review', 'report'].includes(item.kind)
    ? revisionOf(item) === revision : item.kind !== 'intel-update' || revisionOf(item) <= revision);
}
