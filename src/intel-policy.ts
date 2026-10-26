import type { BoardDecider, BoardDecision, Topic } from './board-types.ts';
import { intelSourceOwners, sourceId } from './intel.ts';

/** Scripted communication baseline only. Live Pi chooses its own topics and actions. */
export const scriptedIntelDecider: BoardDecider = async ({ context, signal }) => {
  signal?.throwIfAborted();
  const decision: BoardDecision = {
    subscriptions: context.catalog.filter(topic => /intel|evidence|assessment/i.test(topic.title + ' ' + topic.description))
      .map(topic => ({ topicId: topic.id, reason: 'Relevant intelligence may resolve my evidence gaps or contradict my assumptions.' })),
    status: 'Watching relevant intelligence subjects.', reason: 'Exchange original sources before drawing conclusions.',
    createTopics: [], publish: [], work: context.availableWork,
  };
  const create = (topic: Topic) => {
    if (!context.catalog.some(item => item.id === topic.id)) decision.createTopics.push(topic);
    if (!decision.subscriptions.some(item => item.topicId === topic.id)) decision.subscriptions.push({
      topicId: topic.id, reason: 'Follow peer responses and evidence on this shared subject.',
    });
  };
  const initial = context.evidence.filter(item => {
    const id = sourceId(item);
    return id && intelSourceOwners[id] === context.agent && !context.publishedEvidenceRefs.includes(item.id);
  });
  if (initial.length) {
    const topic = context.agent === 'analyst'
      ? { id: 'route-history', title: 'Route history and backup leads', description: 'Intelligence evidence: dated route diagrams and unverified backup claims needing corroboration.' }
      : context.agent === 'reviewer'
        ? { id: 'current-observations', title: 'Current observations', description: 'Intelligence evidence: completed changes and current observations to reconcile with older sources.' }
        : { id: 'mission-constraints', title: 'Mission constraints', description: 'Intelligence evidence: protected-service dependencies and assessment constraints.' };
    create(topic);
    decision.publish.push({ topicId: topic.id, evidenceRefs: initial.map(item => item.id),
      text: initial.map(item => {
        const data = item.data as { title: string; recordedAt: string; provenance: string; observations: string };
        return data.title + ' (' + data.recordedAt + '). ' + data.provenance + '\n' + data.observations;
      }).join('\n\n') });
    decision.status = 'Publishing my initial evidence so other agents can assess it.';
    if (context.agent === 'analyst') decision.directMessages = [{
      to: 'reviewer', topicId: topic.id, text: 'Can your current observations confirm or contradict this older route diagram and backup tip? Please return source evidence and share the answer on this subject.',
      evidenceRefs: initial.map(item => item.id),
    }];
  }
  const question = context.directInbox?.find(message => message.from !== 'user' && !message.replyTo);
  if (question && question.from !== 'user') {
    const current = context.evidence.filter(item => sourceId(item) === 'current-log');
    decision.directMessages = [{ to: question.from, replyTo: question.id,
      ...(question.topicId ? { topicId: question.topicId } : {}),
      text: current.length ? 'The supplied completed change and observation contradict the old primary-route claim. They do not verify BEACON readiness. I am sharing the original source.'
        : 'I received your question. My available evidence is on the shared intelligence subjects.',
      evidenceRefs: current.map(item => item.id) }];
    if (question.topicId && current.length) decision.publish.push({ topicId: question.topicId,
      text: 'Cross-check: newer change/observation evidence supersedes the old routing diagram; the backup remains unmeasured. See the attached original source.',
      evidenceRefs: current.map(item => item.id) });
  }
  const unpublished = context.evidence.find(item => context.ownWork.some(own => own.id === item.id) && !context.publishedEvidenceRefs.includes(item.id));
  if (unpublished) {
    const topic = context.agent === 'analyst'
      ? { id: 'intel-analysis', title: 'Reconciled intelligence', description: 'Unreviewed intelligence assessment with source chronology and uncertainty.' }
      : context.agent === 'reviewer'
        ? { id: 'intel-review', title: 'Intelligence review', description: 'Reviewed intelligence assessment with original evidence and audit result.' }
        : { id: 'intel-assessment', title: 'Final mission assessment', description: 'Final intelligence assessment: recommendation, protected dependencies, unresolved questions.' };
    create(topic);
    decision.publish.push({ topicId: topic.id, text: JSON.stringify(unpublished.data, null, 2),
      evidenceRefs: context.evidence.map(item => item.id) });
    decision.status = 'Published my evidence-linked ' + unpublished.kind + '.';
  }
  if (context.availableWork === 'review' && context.delegation?.canSpawn) {
    decision.spawnSubagents = [{ name: 'chronology-checker',
      task: 'Compare the archived route diagram with the completed change and current observation. Check whether the backup tip is verified; distinguish receipt time from observation time. Return advisory source chronology and limitations, not stage approval.',
      evidenceRefs: context.evidence.filter(item => ['archive-map', 'current-log', 'backup-tip'].includes(sourceId(item) ?? '')).map(item => item.id) }];
    decision.work = null;
    decision.status = 'Requesting a focused chronology and source-quality check before my independent review.';
    decision.reason = 'A temporary specialist checks the conflicting dated evidence; I retain responsibility for the full review.';
  }
  if (decision.work) decision.status = 'Performing ' + decision.work + ' with the required original sources.';
  return { data: decision, summary: decision.reason };
};
