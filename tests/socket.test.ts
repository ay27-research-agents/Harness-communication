import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection } from 'node:net';
import { authorized, callRpc, listenRpc } from '../src/socket.ts';

test('loopback RPC authenticates, correlates responses and preserves Unicode across split frames', async () => {
  const server = await listenRpc(async request => {
    if (!authorized(request.token, 'secret')) throw new Error('Unauthorized');
    return request.data;
  });
  try {
    assert.deepEqual(await callRpc(server.port, 'secret', 'echo', { text: 'agent → agent 📨' }), { text: 'agent → agent 📨' });
    await assert.rejects(callRpc(server.port, 'wrong', 'echo'), /Unauthorized/);
    const response = await new Promise<any>((resolve, reject) => {
      const socket = createConnection({ port: server.port, host: '127.0.0.1' });
      let result = '';
      socket.on('error', reject);
      socket.on('data', chunk => { result += chunk; });
      socket.on('end', () => resolve(JSON.parse(result)));
      socket.on('connect', () => {
        const bytes = Buffer.from(JSON.stringify({ id: 'split', token: 'secret', method: 'echo', data: '→' }) + '\n');
        const split = bytes.indexOf(Buffer.from('→')) + 1;
        socket.write(bytes.subarray(0, split));
        setImmediate(() => socket.write(bytes.subarray(split)));
      });
    });
    assert.equal(response.id, 'split');
    assert.equal(response.data, '→');
  } finally { await server.close(); }
});

test('RPC deadlines and caller cancellation abort work at the receiver', async () => {
  let cancelled = 0;
  const server = await listenRpc(async (_request, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled++; resolve(); }, { once: true }));
    return null;
  });
  try {
    await assert.rejects(callRpc(server.port, '', 'wait', {}, { timeoutMs: 50 }), /timed out/);
    const controller = new AbortController();
    const pending = callRpc(server.port, '', 'wait', {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /aborted/);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(cancelled, 2);
    await assert.rejects(callRpc(server.port, '', 'echo', 'x'.repeat(8 * 1024 * 1024)), /8 MiB/);
  } finally { await server.close(); }
});
