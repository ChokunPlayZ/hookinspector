import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createApp, clientAddress, headerPairs } from './app.js';
import { loadConfig, type Config } from './config.js';
import { RateLimiter } from './rate-limit.js';
import type { CapturedRequest, CapturedRequestSummary, Inbox, LiveEvent } from '../shared/types.js';

describe('Webhook Inspector HTTP service', { timeout: 15_000 }, () => {
  let app: ReturnType<typeof createApp>;
  let base: string;
  const controllers: AbortController[] = [];

  async function start(overrides: Partial<Config> = {}) {
    // Tests connect directly; deployment proxy settings must not change their trust boundary.
    app = createApp({ ...loadConfig(), databasePath: ':memory:', publicUrl: undefined, cookieSecure: false, trustProxyHops: 0, ...overrides });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  }

  beforeEach(async () => { await start(); });
  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await app.close();
  });

  async function create(ttlHours = 24, cookie?: string) {
    const response = await fetch(`${base}/api/inboxes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ ttlHours }),
    });
    assert.equal(response.status, 201);
    const data = await response.json() as { inbox: Inbox };
    return { inbox: data.inbox, cookie: response.headers.get('set-cookie')!.split(';')[0], response };
  }

  async function list(inbox: Inbox, cookie: string) {
    const response = await fetch(`${base}/api/inboxes/${inbox.id}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return (await response.json() as { requests: CapturedRequestSummary[] }).requests;
  }

  async function detail(inbox: Inbox, cookie: string, id: string) {
    const response = await fetch(`${base}/api/inboxes/${inbox.id}/requests/${id}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return (await response.json() as { request: CapturedRequest }).request;
  }

  async function live(inbox: Inbox, cookie: string) {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${base}/api/inboxes/${inbox.id}/events`, {
      headers: { Cookie: cookie }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return {
      async next(): Promise<{ event: string; data: { requests?: CapturedRequestSummary[] } & Partial<LiveEvent> }> {
        while (true) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary >= 0) {
            const message = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = message.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
            const data = message.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
            if (event && data) return { event, data: JSON.parse(data) };
            continue;
          }
          const result = await reader.read();
          assert.equal(result.done, false, 'SSE connection closed before the expected event');
          buffer += decoder.decode(result.value, { stream: true });
        }
      },
    };
  }

  it('creates a random, short-lived endpoint and a separate HttpOnly owner credential', async () => {
    const { inbox, cookie, response } = await create(1);
    assert.match(inbox.id, /^[a-zA-Z0-9_-]{16}$/);
    assert.equal(inbox.url, `${base}/h/${inbox.id}`);
    assert.equal(Date.parse(inbox.expiresAt) - Date.parse(inbox.createdAt), 3_600_000);
    assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.notEqual(cookie.slice('hi_owner='.length), inbox.id);
    const second = await create(6, cookie);
    assert.equal(second.cookie, cookie);
    assert.notEqual(second.inbox.id, inbox.id);
    assert.equal((await list(inbox, cookie)).length, 0);
  });

  it('rejects missing and wrong credentials for lists, detail, live feed, clear, and revoke', async () => {
    const { inbox } = await create();
    const other = await create();
    for (const [suffix, method] of [['', 'GET'], ['/events', 'GET'], ['/requests/abcdefghijklmnop', 'GET'], ['/requests', 'DELETE'], ['', 'DELETE']]) {
      for (const cookie of ['', other.cookie]) {
        const response = await fetch(`${base}/api/inboxes/${inbox.id}${suffix}`, { method, headers: { Cookie: cookie } });
        assert.equal(response.status, 404);
        await response.arrayBuffer();
      }
    }
  });

  it('captures exact JSON, query strings, paths, methods, source addresses, and connection metadata', async () => {
    const { inbox, cookie } = await create();
    const payload = '{ "event": "order.paid", "number": 42 }\n';
    const response = await fetch(`${inbox.url}/orders?tag=a&tag=b&name=hello%20world`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Custom': 'hello', 'X-Forwarded-For': '203.0.113.90', 'X-Forwarded-Proto': 'https' }, body: payload,
    });
    assert.equal(response.status, 200);
    const [summary] = await list(inbox, cookie);
    const request = await detail(inbox, cookie, summary.id);
    assert.equal(request.method, 'PATCH');
    assert.equal(request.url, `/h/${inbox.id}/orders?tag=a&tag=b&name=hello%20world`);
    assert.equal(Buffer.from(request.bodyBase64, 'base64').toString(), payload);
    assert.equal(request.bodySize, Buffer.byteLength(payload));
    assert.equal(request.remoteAddress, '127.0.0.1');
    assert.equal(request.clientAddress, '127.0.0.1', 'spoofed forwarding headers must not change the source IP');
    assert.equal(request.httpVersion, '1.1');
    assert.ok(request.remotePort! > 0);
    assert.ok(request.durationMs >= 0);
    assert.equal(request.protocol, 'http');
    assert.ok(request.headers.some(([name, value]) => name.toLowerCase() === 'x-custom' && value === 'hello'));
  });

  for (const [hops, expectedClient] of [[1, '192.0.2.10'], [2, '203.0.113.90']] as const) {
    it(`uses ${hops} explicitly trusted proxy hops while retaining the socket peer`, async () => {
      await app.close();
      await start({ trustProxyHops: hops });
      const { inbox, cookie } = await create();
      const forwarded = '198.51.100.99, 203.0.113.90, 192.0.2.10';
      const response = await fetch(inbox.url, {
        method: 'POST', headers: { 'X-Forwarded-For': forwarded, 'X-Forwarded-Proto': 'https' }, body: 'proxied',
      });
      assert.equal(response.status, 200);
      const [summary] = await list(inbox, cookie);
      const request = await detail(inbox, cookie, summary.id);
      assert.equal(request.clientAddress, expectedClient);
      assert.equal(request.remoteAddress, '127.0.0.1');
      assert.equal(request.protocol, 'https');
      assert.ok(request.headers.some(([name, value]) => name.toLowerCase() === 'x-forwarded-for' && value === forwarded));
    });
  }

  it('preserves duplicate header casing and HTTP trailers', async () => {
    const { inbox, cookie } = await create();
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(inbox.url, {
        method: 'POST', headers: ['Host', new URL(base).host, 'X-Duplicate', 'first', 'x-duplicate', 'second', 'Transfer-Encoding', 'chunked', 'Trailer', 'X-Checksum'],
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.write('hello');
      req.addTrailers({ 'X-Checksum': 'abc123' });
      req.end();
    });
    const [summary] = await list(inbox, cookie);
    const request = await detail(inbox, cookie, summary.id);
    assert.deepEqual(request.headers.filter(([name]) => name.toLowerCase() === 'x-duplicate'), [['X-Duplicate', 'first'], ['x-duplicate', 'second']]);
    assert.deepEqual(request.trailers, [['X-Checksum', 'abc123']]);
  });

  it('accepts malformed JSON without parsing or normalizing it', async () => {
    const { inbox, cookie } = await create();
    const payload = '{ definitely not json \r\n';
    const response = await fetch(inbox.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    assert.equal(response.status, 200);
    const [summary] = await list(inbox, cookie);
    const request = await detail(inbox, cookie, summary.id);
    assert.equal(Buffer.from(request.bodyBase64, 'base64').toString(), payload);
  });

  it('preserves arbitrary binary payloads byte for byte', async () => {
    const { inbox, cookie } = await create();
    const payload = Buffer.from([0, 255, 254, 128, 0, 13, 10, 42]);
    assert.equal((await fetch(inbox.url, { method: 'PUT', body: payload })).status, 200);
    const [summary] = await list(inbox, cookie);
    assert.deepEqual(Buffer.from((await detail(inbox, cookie, summary.id)).bodyBase64, 'base64'), payload);
  });

  it('keeps compressed bodies compressed instead of silently decompressing them', async () => {
    const { inbox, cookie } = await create();
    const payload = gzipSync(Buffer.from('{"event":"compressed"}'));
    const response = await fetch(inbox.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: payload,
    });
    assert.equal(response.status, 200);
    const [summary] = await list(inbox, cookie);
    assert.deepEqual(Buffer.from((await detail(inbox, cookie, summary.id)).bodyBase64, 'base64'), payload);
  });

  it('accepts GET, DELETE, HEAD, and OPTIONS and captures empty bodies', async () => {
    const { inbox, cookie } = await create();
    for (const method of ['GET', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = await fetch(inbox.url, { method });
      assert.equal(response.status, ['HEAD', 'OPTIONS'].includes(method) ? 204 : 200);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      await response.arrayBuffer();
    }
    const requests = await list(inbox, cookie);
    assert.equal(requests.length, 4);
    assert.ok(requests.every((request) => request.bodySize === 0));
    assert.ok(requests.every((request) => request.responseStatus === (['HEAD', 'OPTIONS'].includes(request.method) ? 204 : 200)));
  });

  it('streams new requests immediately and sends a consistent snapshot on reconnect', async () => {
    const { inbox, cookie } = await create();
    const stream = await live(inbox, cookie);
    assert.deepEqual((await stream.next()).data.requests, []);
    const post = await fetch(inbox.url, { method: 'POST', body: 'live!' });
    await post.arrayBuffer();
    const event = await stream.next();
    assert.equal(event.event, 'update');
    assert.equal(event.data.type, 'request');
    const secondStream = await live(inbox, cookie);
    const snapshot = await secondStream.next();
    assert.equal(snapshot.data.requests?.length, 1);
  });

  it('clears requests and notifies all connected inspectors without deleting the endpoint', async () => {
    const { inbox, cookie } = await create();
    await (await fetch(inbox.url, { method: 'POST', body: 'delete me' })).arrayBuffer();
    const stream = await live(inbox, cookie);
    await stream.next();
    const response = await fetch(`${base}/api/inboxes/${inbox.id}/requests`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal((await stream.next()).data.type, 'cleared');
    assert.deepEqual(await list(inbox, cookie), []);
    assert.equal((await fetch(inbox.url)).status, 200);
  });

  it('revokes an endpoint, deletes its requests, and closes its live feed', async () => {
    const { inbox, cookie } = await create();
    await (await fetch(inbox.url, { method: 'POST', body: 'delete me' })).arrayBuffer();
    const stream = await live(inbox, cookie);
    await stream.next();
    assert.equal((await fetch(`${base}/api/inboxes/${inbox.id}`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 200);
    assert.equal((await stream.next()).data.type, 'expired');
    assert.equal((await fetch(inbox.url)).status, 404);
    assert.equal(app.store.db.prepare('SELECT count(*) AS count FROM requests').get()?.count, 0);
  });

  it('rejects expired endpoints and deletes expired payloads during cleanup', async () => {
    const { inbox, cookie } = await create();
    await (await fetch(inbox.url, { method: 'POST', body: 'old' })).arrayBuffer();
    app.store.db.prepare('UPDATE inboxes SET expires_at = ? WHERE id = ?').run(Date.now() - 1, inbox.id);
    assert.equal((await fetch(inbox.url)).status, 410);
    assert.equal((await fetch(`${base}/api/inboxes/${inbox.id}`, { headers: { Cookie: cookie } })).status, 410);
    assert.deepEqual(app.store.prune(), [inbox.id]);
    assert.equal(app.store.db.prepare('SELECT count(*) AS count FROM requests').get()?.count, 0);
    assert.equal(app.store.db.prepare('SELECT bytes FROM storage_usage').get()?.bytes, 0);
  });

  it('enforces the per-inbox retention limit', async () => {
    await app.close();
    await start({ maxRequestsPerInbox: 2 });
    const { inbox, cookie } = await create();
    for (const body of ['first', 'second', 'third']) await (await fetch(inbox.url, { method: 'POST', body })).arrayBuffer();
    const requests = await list(inbox, cookie);
    assert.equal(requests.length, 2);
    assert.equal(Buffer.from((await detail(inbox, cookie, requests[0].id)).bodyBase64, 'base64').toString(), 'third');
  });

  it('rejects oversized bodies without storing a partial request', async () => {
    await app.close();
    await start({ maxBodyBytes: 4 });
    const { inbox, cookie } = await create();
    assert.equal((await fetch(inbox.url, { method: 'POST', body: '12345' })).status, 413);
    assert.deepEqual(await list(inbox, cookie), []);
    assert.equal((await fetch(inbox.url, { method: 'POST', body: '1234' })).status, 200);
  });

  it('bounds simultaneous uploads and releases capacity after an upload completes', async () => {
    await app.close();
    await start({ maxConcurrentUploads: 1 });
    const { inbox, cookie } = await create();
    const seen = new Promise<void>((resolve) => app.server.once('request', () => resolve()));
    let finish!: (status: number) => void;
    let fail!: (error: Error) => void;
    const completed = new Promise<number>((resolve, reject) => { finish = resolve; fail = reject; });
    const slow = httpRequest(inbox.url, { method: 'POST', headers: { 'Content-Length': '2' } }, (res) => {
      res.resume(); res.on('end', () => finish(res.statusCode!));
    });
    slow.on('error', fail);
    try {
      slow.write('a');
      await seen;
      assert.equal((await fetch(inbox.url, { method: 'POST', body: 'busy' })).status, 503);
      slow.end('b');
      assert.equal(await completed, 200);
      assert.equal((await fetch(inbox.url, { method: 'POST', body: 'available' })).status, 200);
      assert.equal((await list(inbox, cookie)).length, 2);
    } finally { slow.destroy(); }
  });

  it('enforces a global stored-data budget and recovers after clearing', async () => {
    await app.close();
    await start({ maxStorageBytes: 2400 });
    const { inbox, cookie } = await create();
    assert.equal((await fetch(inbox.url, { method: 'POST', body: 'a'.repeat(1000) })).status, 200);
    assert.equal((await fetch(inbox.url, { method: 'POST', body: 'b'.repeat(1000) })).status, 507);
    await (await fetch(`${base}/api/inboxes/${inbox.id}/requests`, { method: 'DELETE', headers: { Cookie: cookie } })).arrayBuffer();
    assert.equal((await fetch(inbox.url, { method: 'POST', body: 'c'.repeat(1000) })).status, 200);
  });

  it('rate-limits endpoint creation and webhook delivery', async () => {
    await app.close();
    await start({ createRateLimit: 1, webhookRateLimit: 1 });
    const { inbox } = await create();
    assert.equal((await fetch(`${base}/api/inboxes`, { method: 'POST', body: '{}' })).status, 429);
    assert.equal((await fetch(inbox.url)).status, 200);
    const limited = await fetch(inbox.url);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
  });

  it('enforces global endpoint capacity', async () => {
    await app.close();
    await start({ maxInboxes: 1 });
    await create();
    assert.equal((await fetch(`${base}/api/inboxes`, { method: 'POST', body: '{}' })).status, 503);
  });

  it('rejects cross-origin API mutations but allows public cross-origin webhook delivery', async () => {
    assert.equal((await fetch(`${base}/api/inboxes`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 403);
    const { inbox } = await create();
    assert.equal((await fetch(inbox.url, { method: 'POST', headers: { Origin: 'https://other.example' }, body: 'allowed' })).status, 200);
  });

  it('validates endpoint expiry and API JSON without creating unusable inboxes', async () => {
    for (const body of ['{', 'null', '[]', '{"ttlHours":0}', '{"ttlHours":25}', '{"ttlHours":"24"}', '{"ttlHours":1.5}']) {
      assert.equal((await fetch(`${base}/api/inboxes`, { method: 'POST', body })).status, 400);
    }
    assert.equal(app.store.countInboxes(), 0);
  });

  it('uses the configured public HTTPS origin and sets a Secure cookie', async () => {
    await app.close();
    await start({ publicUrl: 'https://hooks.example.com', cookieSecure: true });
    const { inbox, response } = await create();
    assert.equal(inbox.url, `https://hooks.example.com/h/${inbox.id}`);
    assert.match(response.headers.get('set-cookie')!, /; Secure/);
  });

  it('bounds live connections per inbox', async () => {
    const { inbox, cookie } = await create();
    for (let i = 0; i < 5; i++) await (await live(inbox, cookie)).next();
    assert.equal((await fetch(`${base}/api/inboxes/${inbox.id}/events`, { headers: { Cookie: cookie } })).status, 429);
  });

  it('persists captures across server restarts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hookinspector-test-'));
    try {
      await app.close();
      const databasePath = join(directory, 'test.sqlite');
      await start({ databasePath });
      const { inbox, cookie } = await create();
      await (await fetch(inbox.url, { method: 'POST', body: 'persistent' })).arrayBuffer();
      await app.close();
      await start({ databasePath });
      const [request] = await list(inbox, cookie);
      assert.equal(Buffer.from((await detail(inbox, cookie, request.id)).bodyBase64, 'base64').toString(), 'persistent');
    } finally {
      // Only this test's freshly created directory is removed.
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serves a minimal health check without exposing private state', async () => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await response.json(), { status: 'ok' });
  });
});

describe('Capture helpers and bounded rate limits', () => {
  it('pairs raw headers without merging duplicates', () => {
    assert.deepEqual(headerPairs(['X-Test', 'a', 'x-test', 'b']), [['X-Test', 'a'], ['x-test', 'b']]);
  });

  it('only trusts the configured right-hand proxy hops', () => {
    const req = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.2' } } as unknown as IncomingMessage;
    assert.equal(clientAddress(req, 0), '127.0.0.1');
    assert.equal(clientAddress(req, 1), '203.0.113.2');
    assert.equal(clientAddress(req, 2), '198.51.100.1');
    req.headers['x-forwarded-for'] = 'not-an-ip';
    assert.equal(clientAddress(req, 1), '127.0.0.1');
  });

  it('resets rate buckets after one minute', () => {
    const limiter = new RateLimiter();
    assert.equal(limiter.take('test', 1, 0), true);
    assert.equal(limiter.take('test', 1, 1), false);
    assert.equal(limiter.take('test', 1, 60_000), true);
    limiter.prune(120_001);
    assert.equal(limiter.take('test', 1, 120_001), true);
  });
});
