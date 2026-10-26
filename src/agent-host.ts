import { makeWorker } from './experiments.ts';
import { agentProfiles, type DirectMessage } from './board-types.ts';
import { authorized, callRpc, listenRpc } from './socket.ts';
import type { WorkerId } from './types.ts';

// The supervisor supplies configuration over private parent/child IPC, never model context.
process.once('message', async (config: {
  agent: WorkerId; token: string; deliveries: Record<string, string>; supervisorPort: number;
  worker: Parameters<typeof makeWorker>[0];
}) => {
  try {
    const spec = await makeWorker(config.worker);
    let busy = false;
    const server = await listenRpc(async (request, signal) => {
      if (request.method === 'deliver') {
        const message = request.data?.message as DirectMessage;
        const expected = config.deliveries[message?.from];
        if (!expected || !authorized(request.token, expected) || message.to !== config.agent) throw new Error('Unauthorized peer delivery');
        // Receipt is acknowledged only after the supervisor commits the inbox.
        await callRpc(config.supervisorPort, config.token, 'received', {
          agent: config.agent, message, receiverPid: process.pid,
        }, { signal });
        return { received: message.id, receiverPid: process.pid };
      }
      if (!authorized(request.token, config.token)) throw new Error('Unauthorized agent control');
      if (request.method === 'send') {
        const message = request.data.message as DirectMessage;
        if (message.from !== config.agent || message.to === config.agent) throw new Error('Invalid sender');
        // Actual agent-to-agent connection: payload goes from this child to its peer.
        return callRpc(request.data.port, request.data.deliveryToken, 'deliver', { message }, { signal });
      }
      if (!['decide', 'work'].includes(request.method)) throw new Error('Unknown agent method');
      if (busy) throw new Error('Agent is already working');
      if (request.method === 'decide' && request.data?.context?.agent !== config.agent) throw new Error('Wrong decision owner');
      if (request.method === 'work' && request.data?.stage !== agentProfiles[config.agent].capability) throw new Error('Wrong work owner');
      busy = true;
      try {
        return await (request.method === 'decide' ? spec.decide : spec.worker)({ ...request.data, signal });
      } finally { busy = false; }
    });
    process.send?.({ ready: true, port: server.port, pid: process.pid, label: spec.label });
    process.once('disconnect', () => { void server.close().finally(() => process.exit(0)); });
  } catch (error) {
    process.send?.({ ready: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
    process.disconnect?.();
  }
});
// Also exit if the supervisor disappears during slow SDK initialization.
process.once('disconnect', () => process.exit(0));
