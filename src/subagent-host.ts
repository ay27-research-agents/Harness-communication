import { makeWorker } from './experiments.ts';
import { authorized, listenRpc } from './socket.ts';

// This host exposes one inference method, never the parent board action interface.
process.once('disconnect', () => process.exit(0));
process.once('message', async (config: { id: string; parent: string; token: string; worker: Parameters<typeof makeWorker>[0] }) => {
  try {
    const spec = await makeWorker(config.worker);
    let used = false;
    const server = await listenRpc(async (request, signal) => {
      if (!authorized(request.token, config.token)) throw new Error('Unauthorized subagent request');
      if (request.method !== 'specialist' || request.data?.context?.id !== config.id ||
        request.data.context.parent !== config.parent || request.data.context.depth !== 1) throw new Error('Invalid subagent assignment');
      if (used) throw new Error('Subagent request already consumed');
      used = true;
      return spec.subagent({ context: request.data.context, signal });
    });
    process.send?.({ ready: true, pid: process.pid, port: server.port, label: spec.label });
  } catch {
    process.send?.({ ready: false, error: 'Subagent initialization failed; check provider and authentication configuration.' });
    process.disconnect?.();
  }
});
