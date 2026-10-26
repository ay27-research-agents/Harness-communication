import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';

const MAX_FRAME = 8 * 1024 * 1024;
export interface RpcRequest { id: string; token: string; method: string; data: any }
export function authorized(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function frame(socket: Socket, receive: (value: any) => void, fail: (error: Error) => void) {
  let buffer = Buffer.alloc(0), done = false;
  socket.on('data', chunk => {
    if (done) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.length > MAX_FRAME) { done = true; fail(new Error('Socket frame exceeds 8 MiB')); return; }
    const end = buffer.indexOf(10);
    if (end < 0) return;
    done = true;
    try { receive(JSON.parse(buffer.subarray(0, end).toString('utf8'))); }
    catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
}
function encode(value: unknown): string {
  const result = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(result) > MAX_FRAME) throw new Error('Socket frame exceeds 8 MiB');
  return result;
}
/** Bounded, authenticated-by-handler, single-request JSON RPC on loopback only. */
export async function listenRpc(handler: (request: RpcRequest, signal: AbortSignal) => Promise<unknown>) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    const controller = new AbortController();
    socket.setTimeout(310000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); controller.abort(); });
    frame(socket, request => {
      if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') { socket.destroy(); return; }
      void (async () => {
        try { socket.end(encode({ id: request.id, ok: true, data: await handler(request, controller.signal) })); }
        catch (error) {
          if (!socket.destroyed) socket.end(encode({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
      })();
    }, () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
export function callRpc<T = any>(port: number, token: string, method: string, data: unknown = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) { reject(new Error('Invalid loopback port')); return; }
    const id = randomUUID();
    let payload: string;
    try { options.signal?.throwIfAborted(); payload = encode({ id, token, method, data }); }
    catch (error) { reject(error); return; }
    const socket = createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (error?: Error, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(new Error('Socket request aborted'));
    const timer = setTimeout(() => finish(new Error('Socket request timed out')), options.timeoutMs ?? 10000);
    options.signal?.addEventListener('abort', abort, { once: true });
    socket.once('error', error => finish(error));
    socket.once('close', () => { if (!done) finish(new Error('Peer closed before acknowledgement')); });
    socket.once('connect', () => socket.write(payload));
    frame(socket, response => {
      if (!response || response.id !== id || typeof response.ok !== 'boolean') { finish(new Error('Invalid socket response')); return; }
      if (!response.ok) finish(new Error(String(response.error)));
      else finish(undefined, response.data);
    }, error => finish(error));
  });
}
