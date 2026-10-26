import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { callRpc } from './socket.ts';
import type { makeWorker } from './experiments.ts';
import type { SubagentRequest } from './subagent-types.ts';
import type { WorkResult } from './types.ts';

/** A new isolated process for each bounded attempt; always terminated before returning. */
export async function runSubagentProcess(
  worker: Parameters<typeof makeWorker>[0], request: SubagentRequest,
  active: Set<ChildProcess>, record: (kind: string, data: unknown) => void,
): Promise<WorkResult> {
  request.signal?.throwIfAborted();
  const config: ForkOptions & { windowsHide: boolean } = { execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] };
  const child = fork(fileURLToPath(new URL('./subagent-host.ts', import.meta.url)), [], config);
  active.add(child);
  let port = 0;
  const token = randomBytes(32).toString('hex');
  const abort = () => { child.kill(); };
  request.signal?.addEventListener('abort', abort, { once: true });
  try {
    record('subagent.process.started', { id: request.context.id, parent: request.context.parent, pid: child.pid });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Subagent startup deadline exceeded')), worker.timeoutMs ?? 30000);
      const finish = (error?: Error) => {
        clearTimeout(timer); child.off('error', failed); child.off('exit', exited); child.off('message', ready);
        request.signal?.removeEventListener('abort', cancelled);
        if (error) reject(error); else resolve();
      };
      const failed = () => finish(new Error('Subagent process failed'));
      const exited = () => finish(new Error('Subagent exited before becoming ready'));
      const cancelled = () => finish(new Error('Subagent cancelled'));
      const ready = (message: any) => {
        const label = worker.mode === 'pi' ? `pi:${worker.provider}/${worker.model}` : worker.mode;
        if (!message.ready || message.pid !== child.pid || !Number.isInteger(message.port) || message.label !== label) {
          finish(new Error('Subagent initialization failed')); return;
        }
        port = message.port; finish();
      };
      child.once('error', failed); child.once('exit', exited); child.once('message', ready);
      request.signal?.addEventListener('abort', cancelled, { once: true });
      if (request.signal?.aborted) { cancelled(); return; }
      child.send({ id: request.context.id, parent: request.context.parent, token, worker });
    });
    return await callRpc<WorkResult>(port, token, 'specialist', { context: request.context },
      { signal: request.signal, timeoutMs: worker.timeoutMs ?? 30000 });
  } finally {
    request.signal?.removeEventListener('abort', abort);
    await new Promise<void>(resolve => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once('exit', () => resolve());
      child.kill();
    });
    active.delete(child);
    record('subagent.process.stopped', { id: request.context.id, pid: child.pid });
  }
}
