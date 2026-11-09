import type { Kernel } from './kernel.ts';
import type { WorkerId } from './types.ts';
import type { Stage } from './types.ts';

export type MessageType = 'observation' | 'question' | 'result';
export interface MessageMetadata {
  operationId: string;
  messageType: MessageType;
  revision: number;
  expiresAt?: string;
  requiresAcknowledgement: boolean;
}
const members = ['analyst', 'reviewer', 'reporter', 'user', 'system'];

export function assertOperationActive(kernel: Kernel) {
  if (kernel.events.some(event => event.kind === 'operation.cancelled')) throw new Error('Operation is cancelled');
}

export function authorizeWork(kernel: Kernel, taskId: string, agent: WorkerId, stage: Stage, expiresAt: string) {
  assertOperationActive(kernel);
  const owners = {analyze:'analyst',review:'reviewer',report:'reporter'};
  if (!Object.hasOwn(owners,stage) || owners[stage] !== agent) throw new Error('Authorization exceeds agent capability');
  if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) throw new Error('Invalid task ID');
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw new Error('Authorization must expire in the future');
  kernel.record('operation.authorized',{operationId:kernel.runId,taskId,agent,stage,revision:kernel.revision,expiresAt});
}

export function assertWorkAuthorized(kernel: Kernel, taskId: string, agent: WorkerId, stage: Stage) {
  assertOperationActive(kernel);
  if (!kernel.events.some(event => event.kind === 'operation.approval-required')) return;
  const grant = kernel.events.findLast(event => event.kind === 'operation.authorized' &&
    (event.data as any).taskId === taskId && (event.data as any).agent === agent && (event.data as any).stage === stage)?.data as any;
  if (!grant || grant.operationId !== kernel.runId || grant.revision !== kernel.revision || Date.parse(grant.expiresAt) <= Date.now()) throw new Error('Current operator authorization required for this task');
}

export function messageMetadata(kernel: Kernel, options: Partial<MessageMetadata> = {}): MessageMetadata {
  assertOperationActive(kernel);
  if (options.operationId !== undefined && options.operationId !== kernel.runId) throw new Error('Foreign operation');
  const messageType = options.messageType ?? 'observation';
  if (!['observation','question','result'].includes(messageType)) throw new Error('Unsupported message type');
  if (options.expiresAt !== undefined && (!Number.isFinite(Date.parse(options.expiresAt)) || Date.parse(options.expiresAt) <= Date.now())) throw new Error('Message expiration must be in the future');
  return {operationId:kernel.runId,messageType,revision:kernel.revision,requiresAcknowledgement:true,
    ...(options.expiresAt ? {expiresAt:options.expiresAt} : {})};
}

export function fresh(message: Partial<MessageMetadata>) {
  return !message.expiresAt || Date.parse(message.expiresAt) > Date.now();
}

export function canAccess(kernel: Kernel, topicId: string, agent: string, mode: 'readers' | 'writers') {
  if (!members.includes(agent)) return false;
  if (agent === 'user' || agent === 'system') return true;
  const policy = kernel.events.findLast(event => event.kind === 'operation.topic-access' && (event.data as any).topicId === topicId)?.data as any;
  return !policy || policy[mode].includes(agent);
}

export function setTopicAccess(kernel: Kernel, topicId: string, readers: WorkerId[], writers: WorkerId[]) {
  assertOperationActive(kernel);
  if (!kernel.events.some(event => event.kind === 'board.topic' && (event.data as any).id === topicId)) throw new Error('Unknown subject');
  for (const list of [readers,writers]) {
    if (!Array.isArray(list) || list.some(agent => !members.slice(0,3).includes(agent)) || new Set(list).size !== list.length) throw new Error('Invalid subject access list');
  }
  kernel.record('operation.topic-access',{operationId:kernel.runId,topicId,readers,writers});
}
