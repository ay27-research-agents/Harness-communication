import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kernel } from '../src/kernel.ts';
import { MemoryJournal } from '../src/store.ts';
import { runTopology } from '../src/topologies.ts';
import type { Envelope, Stage, Topology, Worker } from '../src/types.ts';
import { scriptedWorker } from '../src/workers.ts';

const topologies: Topology[] = ['coordinator', 'pubsub', 'routed', 'handoff'];

class InspectKernel extends Kernel {
  capturedMessages: Envelope[] = [];
  duplicateKeys: string[] = [];
  override send(...args: Parameters<Kernel['send']>): Envelope {
    const envelope = super.send(...args);
    this.capturedMessages.push(envelope);
    return envelope;
  }
  override noteDuplicate(key: string): void {
    this.duplicateKeys.push(key);
    super.noteDuplicate(key);
  }
}

function countingWorker(calls: Stage[]): Worker {
  return async request => {
    calls.push(request.stage);
    return scriptedWorker(request);
  };
}

for (const topology of topologies) {
  test(`${topology} completes the same verified three-stage fixture workflow`, async () => {
    const calls: Stage[] = [];
    const kernel = new InspectKernel({ topology, worker: countingWorker(calls) });
    await runTopology(kernel);
    const report = kernel.report();
    assert.equal(report.success, true, JSON.stringify(report.issues));
    assert.deepEqual(calls, ['analyze', 'review', 'report']);
    assert.equal(kernel.tasks.length, topology === 'handoff' ? 1 : 3);
    assert.ok(kernel.tasks.every(task => task.status === 'completed'));
    assert.equal(kernel.artifacts.filter(artifact => artifact.kind === 'report').length, 1);
    const hub = { coordinator: 'coordinator', pubsub: 'broker', routed: 'router', handoff: 'controller' }[topology];
    if (topology === 'pubsub') {
      assert.ok(kernel.events.some(event => event.kind === 'board.delivery'));
      assert.equal(kernel.capturedMessages.length, 0, 'The broker must not send assignments');
      return;
    }
    assert.ok(kernel.capturedMessages.length > 0);
    assert.ok(kernel.capturedMessages.every(message => message.sender === hub || message.recipient === hub));
    assert.ok(kernel.capturedMessages.every(message => message.artifactRefs.length > 0));
  });

  test(`${topology} reconstructs a completed run without repeating work or messages`, async () => {
    const journal = new MemoryJournal();
    const calls: Stage[] = [];
    const options = { journal, topology, runId: `replay-${topology}`, worker: countingWorker(calls) };
    const original = new Kernel(options);
    await runTopology(original);
    const eventCount = original.events.length;
    const replay = new Kernel(options);
    await runTopology(replay);
    assert.equal(replay.report().success, true);
    assert.equal(replay.events.length, eventCount);
    assert.deepEqual(calls, ['analyze', 'review', 'report']);
  });

  for (const interruptedStage of ['analyze', 'review', 'report'] as const) {
    test(`${topology} resumes after ${interruptedStage} output persisted before publication`, async () => {
      const journal = new MemoryJournal();
      const calls: Stage[] = [];
      const options = {
        journal, topology, runId: `interrupted-${topology}-${interruptedStage}`,
        worker: countingWorker(calls),
      };
      const interrupted = new Kernel(options);
      const execute = interrupted.execute.bind(interrupted);
      interrupted.execute = async (...args: Parameters<Kernel['execute']>) => {
        const result = await execute(...args);
        if (args[0] === interruptedStage) throw new Error('Simulated supervisor restart');
        return result;
      };
      await assert.rejects(runTopology(interrupted), /Simulated supervisor restart/);
      const resumed = new Kernel(options);
      await runTopology(resumed);
      assert.equal(resumed.report().success, true);
      assert.deepEqual(calls, ['analyze', 'review', 'report']);
      assert.ok(resumed.tasks.every(task => task.status === 'completed'));
    });
  }
}

test('pubsub coalesces repeated notifications without repeating decisions or execution', async () => {
  const calls: Stage[] = [];
  const kernel = new InspectKernel({ topology: 'pubsub', duplicateDelivery: true, worker: countingWorker(calls) });
  await runTopology(kernel);
  assert.equal(kernel.report().success, true);
  assert.deepEqual(calls, ['analyze', 'review', 'report']);
  assert.equal(kernel.capturedMessages.length, 0);
  const delivered = kernel.events.filter(event => event.kind === 'board.delivery');
  assert.ok(delivered.length > 0);
  assert.equal(kernel.report().metrics.duplicatesSuppressed, delivered.length);
  for (const event of delivered) assert.equal(kernel.hasReceipt((event.data as { key: string }).key), true);
  const withoutDuplicates = new Kernel({ topology: 'pubsub' });
  await runTopology(withoutDuplicates);
  assert.equal(kernel.report().metrics.decisionCalls, withoutDuplicates.report().metrics.decisionCalls);
});

test('pubsub resumes after a finding is published before its decision is acknowledged', async () => {
  const journal = new MemoryJournal();
  const calls: Stage[] = [];
  const options = { journal, topology: 'pubsub' as const, runId: 'pubsub-publication-gap', worker: countingWorker(calls) };
  const interrupted = new InspectKernel(options);
  const append = journal.append.bind(journal);
  journal.append = (...args) => {
    const written = append(...args);
    if (args[1].some(change => change.kind === 'board.update' && (change.data as { author: string }).author === 'reviewer')) throw new Error('Restart after review publication');
    return written;
  };
  await assert.rejects(runTopology(interrupted), /Restart after review publication/);
  assert.deepEqual(calls, ['analyze', 'review']);
  journal.append = append;
  const resumed = new Kernel(options);
  await runTopology(resumed);
  assert.equal(resumed.report().success, true);
  assert.deepEqual(calls, ['analyze', 'review', 'report']);
  assert.equal(resumed.events.filter(event => event.kind === 'board.update' && (event.data as { author: string }).author === 'reviewer').length, 1);
});

test('routed conversation has explicit subtasks, provenance, and a bounded message graph', async () => {
  const kernel = new InspectKernel({ topology: 'routed' });
  await runTopology(kernel);
  assert.equal(kernel.capturedMessages.length, 8);
  const requested = kernel.capturedMessages.filter(message => message.type === 'subtask.requested');
  assert.equal(requested.length, 2);
  assert.deepEqual(requested.map(message => message.payload.recipient), ['reviewer', 'reporter']);
  const reply = kernel.capturedMessages.find(message => message.sender === 'reviewer')!;
  const forwarded = kernel.capturedMessages.find(message => message.type === 'conversation.reply' && message.sender === 'router')!;
  assert.equal(forwarded.payload.originalMessageId, reply.messageId);
  assert.equal(forwarded.causationId, reply.messageId);
  assert.deepEqual(forwarded.artifactRefs, reply.artifactRefs);
  assert.deepEqual(kernel.tasks.map(task => task.owner).sort(), ['analyst', 'reporter', 'reviewer']);
});

test('handoff transfers one task through two ownership epochs', async () => {
  const kernel = new InspectKernel({ topology: 'handoff' });
  await runTopology(kernel);
  assert.equal(kernel.tasks.length, 1);
  const task = kernel.task('workflow');
  assert.equal(task.owner, 'reporter');
  assert.equal(task.ownershipEpoch, 2);
  assert.deepEqual(Object.keys(task.outputs).sort(), ['analyze', 'report', 'review']);
  for (const id of ['handoff:analysis-to-review', 'handoff:review-to-report']) {
    const handoff = kernel.handoff(id)!;
    assert.equal(handoff.status, 'committed');
    assert.ok(kernel.artifacts.some(artifact => artifact.id === handoff.packageRef));
  }
});

for (const handoffId of ['handoff:analysis-to-review', 'handoff:review-to-report']) {
  test(`handoff resumes after ${handoffId} commits before confirmation`, async () => {
    const journal = new MemoryJournal();
    const calls: Stage[] = [];
    const options = { journal, topology: 'handoff' as const, runId: handoffId.replaceAll(':', '-'), worker: countingWorker(calls) };
    const interrupted = new Kernel(options);
    const commit = interrupted.commitHandoff.bind(interrupted);
    interrupted.commitHandoff = (id: string) => {
      commit(id);
      if (id === handoffId) throw new Error('Restart after handoff commit');
    };
    await assert.rejects(runTopology(interrupted), /Restart after handoff commit/);
    const resumed = new Kernel(options);
    await runTopology(resumed);
    assert.equal(resumed.report().success, true);
    assert.equal(resumed.task('workflow').owner, 'reporter');
    assert.equal(resumed.task('workflow').ownershipEpoch, 2);
    assert.deepEqual(calls, ['analyze', 'review', 'report']);
  });
}
