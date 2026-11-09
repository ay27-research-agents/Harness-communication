import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kernel } from '../src/kernel.ts';
import { TopicBoard } from '../src/board.ts';
import { decisionContext } from '../src/decision-context.ts';
import { boardPrompt } from '../src/board-policy.ts';

test('parents see an index, can retrieve known originals for one turn, and keep original evidence intact', async () => {
  const kernel = new Kernel({topology:'pubsub',scenario:'intel'});
  let requested = '', sawRead = false;
  const board = new TopicBoard(kernel, {allowIdle:true, decide: async request => {
    const context = request.context;
    const source = context.evidence.find(item => item.kind === 'intel-source');
    const view = decisionContext(context);
    const decision = {subscriptions:[],createTopics:[],publish:[],work:null,status:'Reading',reason:'Verify selected source',readEvidenceRefs:[] as string[]};
    if (context.agent === 'analyst' && source) {
      if (!requested) {
        assert.equal('data' in view.evidence.find(item => item.id === source.id)!, false);
        assert.ok(boardPrompt(request).includes('bodyAvailable'));
        requested = source.id;
        decision.readEvidenceRefs = [requested];
      } else if (context.readEvidenceRefs?.includes(requested)) {
        assert.deepEqual((view.evidence.find(item => item.id === requested) as any).data, source.data);
        sawRead = true;
      }
    }
    return {data:decision,summary:'Read selected source'};
  }});
  await board.run();
  assert.equal(sawRead,true);
  assert.ok(kernel.artifacts.find(item => item.id === requested)?.data);
  assert.deepEqual(board.snapshot.agents.find(item => item.agent === 'analyst')?.readEvidenceRefs,[]);
  assert.ok(kernel.report().metrics.maxParentDecisionContextChars > 0);
});

test('requesting evidence outside an agents grants is rejected', async () => {
  const kernel = new Kernel({topology:'pubsub',scenario:'intel',maxAttempts:1});
  const board = new TopicBoard(kernel,{decide:async () => ({data:{
    subscriptions:[],createTopics:[],publish:[],work:null,status:'Read',reason:'Read',
    readEvidenceRefs:['invented-source']
  },summary:'Read'})});
  await assert.rejects(board.run());
  assert.equal(kernel.events.some(event => event.kind === 'board.applied'),false);
});
