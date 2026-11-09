import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kernel } from '../src/kernel.ts';
import { TopicBoard } from '../src/board.ts';
import { messageMetadata, setTopicAccess, authorizeWork, assertWorkAuthorized } from '../src/operation.ts';

test('operator authorization is constrained to task, agent, stage and current revision', () => {
  const kernel = new Kernel({topology:'pubsub',scenario:'intel'});
  kernel.record('operation.approval-required',{operationId:kernel.runId});
  assert.throws(() => assertWorkAuthorized(kernel,'analysis','analyst','analyze'),/authorization/);
  authorizeWork(kernel,'analysis','analyst','analyze',new Date(Date.now()+60000).toISOString());
  assertWorkAuthorized(kernel,'analysis','analyst','analyze');
  assert.throws(() => assertWorkAuthorized(kernel,'other','analyst','analyze'),/authorization/);
  assert.throws(() => authorizeWork(kernel,'review','analyst','review',new Date(Date.now()+60000).toISOString()),/capability/);
});

const waitDecision = async () => ({data:{subscriptions:[],createTopics:[],publish:[],work:null,status:'Waiting',reason:'No task'},summary:'Waiting'});
test('operation envelopes reject foreign scope and invalid expiration', () => {
  const kernel = new Kernel({topology:'pubsub',scenario:'intel'});
  assert.throws(() => messageMetadata(kernel,{operationId:'foreign'}),/Foreign/);
  assert.throws(() => messageMetadata(kernel,{expiresAt:'invalid'}),/expiration/);
  assert.throws(() => messageMetadata(kernel,{messageType:'approval' as any}),/Unsupported/);
  const board = new TopicBoard(kernel); board.initialize();
  const message = board.direct('analyst','Question',undefined,{messageType:'question'});
  assert.equal(message.operationId,kernel.runId);
  assert.equal(message.messageType,'question');
  board.receiveDirect(message); board.receiveDirect(message);
  assert.equal(kernel.events.filter(event => event.kind === 'board.direct.received').length,1);
  assert.throws(() => board.receiveDirect({...message,operationId:'foreign'}),/outbox/);
});
test('subject permissions hide catalog metadata and block peer references', async () => {
  const kernel = new Kernel({topology:'pubsub',scenario:'intel'});
  const board = new TopicBoard(kernel,{allowIdle:true,decide:async request => {
    if (request.context.agent !== 'analyst') assert.equal(request.context.catalog.some(topic => topic.id === 'intel-brief'),false);
    return waitDecision();
  }});
  board.initialize();
  setTopicAccess(kernel,'intel-brief',['analyst'],['analyst']);
  assert.throws(() => board.direct('reviewer','Private topic','intel-brief'),/denied/);
  await board.run();
});
test('expired messages are accounted for without entering agent context', async () => {
  const kernel = new Kernel({topology:'pubsub',scenario:'intel'});
  const board = new TopicBoard(kernel,{allowIdle:true,decide:async request => {
    assert.equal(request.context.directInbox?.length,0);
    return waitDecision();
  }});
  board.initialize();
  const message = board.direct('analyst','Expired',undefined,{expiresAt:new Date(Date.now()+100).toISOString()});
  await new Promise(resolve => setTimeout(resolve,120));
  await board.run();
  assert.equal(board.snapshot.deliveryStatus.find(item => item.id === message.id)?.state,'expired');
});
test('durable cancellation prevents later turns and messages', async () => {
  const kernel = new Kernel({topology:'pubsub',scenario:'intel'});
  const board = new TopicBoard(kernel); board.initialize();
  kernel.record('operation.cancelled',{operationId:kernel.runId});
  await assert.rejects(board.run(),/cancelled/);
  assert.throws(() => board.direct('analyst','Later message'),/cancelled/);
});
