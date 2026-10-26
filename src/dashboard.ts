import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

export async function startDashboard(options: {
  snapshot: () => unknown;
  act: (action: 'inject' | 'post' | 'dm', data: any) => unknown | Promise<unknown>;
}) {
  const token = randomBytes(32).toString('hex');
  const assets = new Map([
    ['/', { type: 'text/html; charset=utf-8', body: readFileSync(new URL('./dashboard/index.html', import.meta.url)) }],
    ['/app.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(new URL('./dashboard/app.js', import.meta.url)) }],
    ['/style.css', { type: 'text/css; charset=utf-8', body: readFileSync(new URL('./dashboard/style.css', import.meta.url)) }],
  ]);
  let origin = '';
  const send = (response: ServerResponse, code: number, value: unknown) => {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };
  const authorized = (request: IncomingMessage) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (request.headers.host !== new URL(origin).host) { send(response, 421, { error: 'Invalid host' }); return; }
    if (request.headers.origin && request.headers.origin !== origin) { send(response, 403, { error: 'Invalid origin' }); return; }
    const asset = assets.get(request.url ?? '');
    if (asset && request.method === 'GET') { response.writeHead(200, { 'Content-Type': asset.type }); response.end(asset.body); return; }
    if (!authorized(request)) { send(response, 401, { error: 'Open the dashboard link printed by serve to connect.' }); return; }
    if (request.url === '/api/state' && request.method === 'GET') {
      try { send(response, 200, options.snapshot()); } catch { send(response, 503, { error: 'The service is stopping or unavailable.' }); }
      return;
    }
    const action = request.url?.slice('/api/'.length);
    if (!request.url?.startsWith('/api/') || !['inject', 'post', 'dm'].includes(action ?? '') || request.method !== 'POST') {
      send(response, 404, { error: 'Unknown endpoint' }); return;
    }
    if (request.headers.origin !== origin || !request.headers['content-type']?.startsWith('application/json')) {
      send(response, 403, { error: 'Same-origin JSON requests are required.' }); return;
    }
    if (Number(request.headers['content-length'] ?? 0) > 32768) {
      request.resume(); send(response, 413, { error: 'Request exceeds 32 KiB' }); return;
    }
    try {
      let length = 0, tooLarge = false;
      const chunks: Buffer[] = [];
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > 32768) { tooLarge = true; break; }
        chunks.push(Buffer.from(chunk));
      }
      if (tooLarge) { request.resume(); send(response, 413, { error: 'Request exceeds 32 KiB' }); return; }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object');
      send(response, 200, await options.act(action as 'inject' | 'post' | 'dm', data));
    } catch (error) { if (!response.writableEnded) send(response, 400, { error: error instanceof Error ? error.message : 'Request failed' }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  return { url: origin + '/#' + token,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    }) };
}
