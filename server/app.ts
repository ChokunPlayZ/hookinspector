import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import type { Config } from './config.js';
import { Store, StorageFullError, type InboxRow } from './store.js';
import { RateLimiter } from './rate-limit.js';
import type { HeaderPair, Inbox, LiveEvent } from '../shared/types.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function headerPairs(raw: string[]): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (let i = 0; i < raw.length; i += 2) pairs.push([raw[i], raw[i + 1]]);
  return pairs;
}

function peerAddress(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

export function clientAddress(req: IncomingMessage, hops: number): string {
  const peer = peerAddress(req);
  if (!hops) return peer;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') return peer;
  const chain = [...forwarded.split(',').map((ip) => ip.trim()), peer];
  const candidate = chain[Math.max(0, chain.length - 1 - hops)];
  return isIP(candidate) ? candidate.replace(/^::ffff:/, '') : peer;
}

function ownerToken(req: IncomingMessage): string | undefined {
  const token = req.headers.cookie?.split(';').map((value) => value.trim())
    .find((value) => value.startsWith('hi_owner='))?.slice('hi_owner='.length);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

function hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((accept, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    let settled = false;
    req.on('data', (part: Buffer) => {
      if (settled) return;
      size += part.length;
      if (size > limit) {
        settled = true;
        parts.length = 0;
        reject(new HttpError(413, `Request body exceeds the ${limit}-byte limit.`));
      } else parts.push(part);
    });
    req.on('end', () => { if (!settled) { settled = true; accept(Buffer.concat(parts)); } });
    req.on('error', () => { if (!settled) { settled = true; reject(new HttpError(400, 'Could not read request body.')); } });
    req.on('aborted', () => { if (!settled) { settled = true; reject(new HttpError(400, 'Request was interrupted.')); } });
  });
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webp': 'image/webp',
};

export function createApp(config: Config) {
  const store = new Store(config.databasePath, config.maxRequestsPerInbox, config.maxStorageBytes);
  const limiter = new RateLimiter();
  const streams = new Map<string, Set<ServerResponse>>();
  let streamCount = 0;
  let activeUploads = 0;

  function broadcast(id: string, event: LiveEvent): void {
    for (const res of streams.get(id) ?? []) {
      if (res.writableLength > 256 * 1024) { res.destroy(); continue; }
      res.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'expired') res.end();
    }
  }

  function prune(): void {
    for (const id of store.prune()) broadcast(id, { type: 'expired' });
    limiter.prune();
  }

  const cleanup = setInterval(prune, 30_000);
  cleanup.unref();
  prune();

  function origin(req: IncomingMessage): string {
    if (config.publicUrl) return config.publicUrl;
    const forwardedProtocol = config.trustProxyHops > 0 ? req.headers['x-forwarded-proto'] : undefined;
    const protocol = forwardedProtocol === 'https' ? 'https' : 'http';
    const host = req.headers.host;
    if (!host || !/^[a-zA-Z0-9.\-\[\]:]+$/.test(host)) throw new HttpError(400, 'Invalid Host header.');
    return new URL(`${protocol}://${host}`).origin;
  }

  function inboxInfo(row: InboxRow, req: IncomingMessage): Inbox {
    return {
      id: row.id,
      url: `${origin(req)}/h/${row.id}`,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      requestLimit: config.maxRequestsPerInbox,
      bodyLimit: config.maxBodyBytes,
    };
  }

  function requireInbox(id: string, req: IncomingMessage, authorize: boolean): InboxRow {
    const row = store.inbox(id);
    if (!row) throw new HttpError(404, 'This endpoint does not exist or has expired.');
    // Do not leak inbox metadata to callers without the browser credential.
    if (authorize) {
      const token = ownerToken(req);
      if (!token || row.owner_hash !== hash(token)) throw new HttpError(404, 'Endpoint not found in this browser. Create a new endpoint.');
    }
    if (row.expires_at <= Date.now()) throw new HttpError(410, 'This endpoint has expired. Create a new one.');
    return row;
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const url = new URL(req.url ?? '/', 'http://internal');
    const path = url.pathname;
    const ip = clientAddress(req, config.trustProxyHops);

    const hook = /^\/h\/([a-zA-Z0-9_-]{16})(?:\/.*)?$/.exec(path);
    if (hook) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*');
      res.setHeader('Access-Control-Max-Age', '0');
      const row = requireInbox(hook[1], req, false);
      if (!limiter.take(`hook:${ip}`, config.webhookRateLimit) || !limiter.take(`inbox:${row.id}`, config.webhookRateLimit)) {
        res.setHeader('Retry-After', '60');
        throw new HttpError(429, 'Too many requests. Try again in a minute.');
      }
      if (activeUploads >= config.maxConcurrentUploads) {
        res.setHeader('Retry-After', '1');
        throw new HttpError(503, 'Too many uploads in progress. Please retry shortly.');
      }
      const receivedAt = Date.now();
      const start = performance.now();
      const remoteAddress = peerAddress(req);
      const remotePort = req.socket.remotePort ?? null;
      let body: Buffer;
      activeUploads++;
      try { body = await readBody(req, config.maxBodyBytes); }
      finally { activeUploads--; }
      // An upload may finish after expiration or deletion; never resurrect it.
      requireInbox(row.id, req, false);
      const captured = store.insert({
        inboxId: row.id, method: req.method ?? 'UNKNOWN', url: req.url ?? '/',
        receivedAt, remoteAddress, clientAddress: ip, remotePort,
        headers: headerPairs(req.rawHeaders), trailers: headerPairs(req.rawTrailers), body,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
        contentType: req.headers['content-type'] ?? '', httpVersion: req.httpVersion,
        protocol: config.trustProxyHops > 0 && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http',
      });
      broadcast(row.id, { type: 'request', request: captured });
      if (req.method === 'HEAD' || req.method === 'OPTIONS') { res.writeHead(204); res.end(); }
      else json(res, 200, { ok: true, message: 'Webhook received.', requestId: captured.id });
      return;
    }

    if (path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET' && path === '/api/health') { json(res, 200, { status: 'ok' }); return; }
      if (!limiter.take(`api:${ip}`, 300)) {
        res.setHeader('Retry-After', '60');
        throw new HttpError(429, 'Too many requests. Try again in a minute.');
      }
      if (!['GET', 'HEAD'].includes(req.method ?? '')) {
        if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin(req))) {
          throw new HttpError(403, 'Cross-origin API requests are not allowed.');
        }
      }

      if (path === '/api/inboxes' && req.method === 'POST') {
        if (!limiter.take(`create:${ip}`, config.createRateLimit)) {
          res.setHeader('Retry-After', '60');
          throw new HttpError(429, 'Endpoint creation limit reached. Try again in a minute.');
        }
        const body = await readBody(req, 1024);
        let data: unknown;
        try { data = JSON.parse(body.toString('utf8') || '{}'); }
        catch { throw new HttpError(400, 'Expected a JSON request body.'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Expected a JSON object.');
        const ttl = (data as { ttlHours?: unknown }).ttlHours ?? config.defaultTtlHours;
        if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > 24) throw new HttpError(400, 'Expiry must be a whole number of hours between 1 and 24.');
        prune();
        if (store.countInboxes() >= config.maxInboxes) throw new HttpError(503, 'All endpoints are in use. Please try again later.');
        const token = ownerToken(req) ?? randomBytes(32).toString('hex');
        // Validate the origin before mutating storage.
        origin(req);
        const row = store.createInbox(hash(token), ttl);
        res.setHeader('Set-Cookie', `hi_owner=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=172800${config.cookieSecure ? '; Secure' : ''}`);
        json(res, 201, { inbox: inboxInfo(row, req) });
        return;
      }

      const api = /^\/api\/inboxes\/([a-zA-Z0-9_-]{16})(?:\/(events|requests)(?:\/([a-zA-Z0-9_-]{16}))?)?$/.exec(path);
      if (!api) throw new HttpError(404, 'API route not found.');
      const [, id, resource, requestId] = api;
      const row = requireInbox(id, req, true);

      if (!resource && req.method === 'GET') { json(res, 200, { inbox: inboxInfo(row, req), requests: store.list(id) }); return; }
      if (!resource && req.method === 'DELETE') {
        broadcast(id, { type: 'expired' });
        store.deleteInbox(id);
        json(res, 200, { ok: true });
        return;
      }
      if (resource === 'requests' && !requestId && req.method === 'DELETE') {
        store.clear(id);
        broadcast(id, { type: 'cleared' });
        json(res, 200, { ok: true });
        return;
      }
      if (resource === 'requests' && requestId && req.method === 'GET') {
        const request = store.request(id, requestId);
        if (!request) throw new HttpError(404, 'This request was cleared or removed by the retention limit.');
        json(res, 200, { request });
        return;
      }
      if (resource === 'events' && !requestId && req.method === 'GET') {
        const connections = streams.get(id) ?? new Set<ServerResponse>();
        if (connections.size >= 5 || streamCount >= 500) throw new HttpError(429, 'Too many live connections. Close another tab and retry.');
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
        });
        res.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ requests: store.list(id) })}\n\n`);
        connections.add(res);
        streams.set(id, connections);
        streamCount++;
        const heartbeat = setInterval(() => {
          if (row.expires_at <= Date.now()) { broadcast(id, { type: 'expired' }); return; }
          if (res.writableLength > 256 * 1024) { res.destroy(); return; }
          res.write(': heartbeat\n\n');
        }, 15_000);
        heartbeat.unref();
        res.on('close', () => {
          clearInterval(heartbeat);
          connections.delete(res);
          streamCount--;
          if (!connections.size) streams.delete(id);
        });
        return;
      }
      throw new HttpError(405, 'Method not allowed.');
    }

    if (!['GET', 'HEAD'].includes(req.method ?? '')) throw new HttpError(404, 'Not found.');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    let file: string;
    try { file = resolve(config.publicDir, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`); }
    catch { throw new HttpError(400, 'Invalid URL.'); }
    if (!file.startsWith(config.publicDir + sep)) throw new HttpError(404, 'Not found.');
    if (!existsSync(file)) {
      if (path === '/') throw new HttpError(503, 'Frontend not built. Use npm run dev, or run npm run build first.');
      throw new HttpError(404, 'Not found.');
    }
    const info = await stat(file);
    if (!info.isFile()) throw new HttpError(404, 'Not found.');
    res.writeHead(200, {
      'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  const server = createServer({ maxHeaderSize: 32 * 1024, requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => {
    void handler(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : error instanceof StorageFullError ? 507 : 500;
      if (status === 500) console.error('Request failed:', error);
      // Never keep a connection alive with an unread, potentially unlimited body.
      if (!req.complete || status === 413) res.setHeader('Connection', 'close');
      json(res, status, { error: error instanceof HttpError || error instanceof StorageFullError ? error.message : 'Something went wrong. Please try again.' });
      req.resume();
    });
  });
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;
  server.maxConnections = 1024;

  async function close(): Promise<void> {
    clearInterval(cleanup);
    for (const responses of streams.values()) for (const res of responses) res.end();
    server.closeIdleConnections();
    await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    store.close();
  }

  return { server, store, close };
}
