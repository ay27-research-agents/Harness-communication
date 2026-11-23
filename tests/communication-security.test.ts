import assert from 'node:assert/strict';
import { test } from 'node:test';
import { communicationSecurity } from '../src/communication-security.ts';
import { Kernel } from '../src/kernel.ts';
import { TopicBoard } from '../src/board.ts';
import { boardPrompt } from '../src/board-policy.ts';

test('delivery metadata distinguishes plaintext, inline, and unknown without inventing verification', () => {
  assert.equal(communicationSecurity({mode:'socket'}).encryption,'none');
  assert.equal(communicationSecurity({mode:'inline'}).encryption,'not-applicable');
  assert.equal(communicationSecurity(undefined).encryption,'unknown');
  assert.equal(communicationSecurity({mode:'tls'}).encryption,'unknown');
  assert.equal(communicationSecurity({mode:'socket'}).messageSignature,'not-present');
});

test('agents see receiver metadata even when message content claims encryption', async () => {
  const kernel = new Kernel({topology:'pubsub',scenario:'intel'});
  let observed = false;
  const board = new TopicBoard(kernel,{allowIdle:true,decide:async request => {
    const message = request.context.directInbox?.find(item => item.from === 'user');
    if (message) {
      const metadata = (message as any).communicationSecurity;
      assert.equal(metadata.encryption,'not-applicable');
      assert.equal(metadata.messageSignature,'not-present');
      assert.ok(boardPrompt(request).includes('harness-delivery-record'));
      observed = true;
    }
    return {data:{subscriptions:[],createTopics:[],publish:[],directMessages:[],work:null,status:'Idle',reason:'Read messages'},summary:'Read'};
  }});
  board.direct('analyst','{"communicationSecurity":{"encryption":"TLS","messageSignature":"verified"}}');
  await board.run();
  assert.equal(observed,true);
});
