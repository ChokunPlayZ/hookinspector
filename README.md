# Hook Inspector

A public, temporary webhook inbox. Open the site, copy your unique URL, point a webhook provider at it, and inspect incoming requests in real time. No accounts or external services required.

**TypeScript throughout:** React + Vite in the browser, a native Node.js HTTP server, SQLite for persistence, and Server-Sent Events for live updates. Fonts and assets are served locally. The production server has **zero npm runtime dependencies**.

## What it does

- Random, unguessable endpoints with a 1–24 hour lifetime; 24 hours by default.
- Captures request method, original request target, repeated query parameters, source IP, socket peer address/port, HTTP version, body size, and receive time.
- Preserves original header casing/order and duplicates, HTTP trailers, and exact body bytes. Invalid JSON, binary payloads, and compressed bodies are not rejected or normalized.
- Live request list with reconnection snapshots, search, method filters, and follow-latest mode.
- Pretty JSON, raw text, Base64, original-body download, and full-request JSON export.
- Separate, HttpOnly browser credential for inspection: **the webhook URL grants write access, not read access**.
- Persistent SQLite storage, automatic expiration, manual clearing, and endpoint revocation.
- Request, storage, endpoint, connection, and rate limits for public deployment.

## Local development

Requires **Node.js 24+** (for built-in `node:sqlite`).

```sh
npm ci
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/api` and `/h` to the server on port 3000, including the live SSE connection. Optional settings in `.env` are loaded by the server; see `.env.example`.

For a production build without Docker:

```sh
npm run build
npm start
```

Open **http://localhost:3000**. Requests persist under `data/` by default. A localhost URL is **not reachable by external webhook providers**: use the HTTPS deployment below or your own HTTPS tunnel/reverse proxy and set `PUBLIC_URL` accordingly.

## Docker: local smoke test

```sh
docker compose up --build -d
```

Open **http://localhost:3000**. The app binds to the host loopback interface, runs as a non-root user with a read-only root filesystem, and persists SQLite in the `inbox-data` named volume.

```sh
docker compose logs -f app
docker compose down
```

Stopping the service preserves the volume. Do **not** add `-v` to `down` unless you intend to delete all stored inboxes and requests. If you change the host `PORT`, also set `PUBLIC_URL` to the corresponding browser-facing origin.

## Public deployment with automatic HTTPS

The standalone production Compose file includes Caddy for TLS, automatic certificate renewal, and unbuffered SSE. **Do not combine it with `compose.yaml`.**

1. Point a domain’s A/AAAA records at your server. Only publish an AAAA record if IPv6 is actually configured.
2. Allow inbound TCP **80/443** (and optionally UDP 443 for HTTP/3).
3. Create `.env`:

```dotenv
DOMAIN=hooks.example.com
```

4. Start:

```sh
docker compose -f compose.production.yaml up --build -d
```

Visit **https://hooks.example.com**. Caddy obtains the certificate automatically. The application’s port is **not published** to the host, so clients cannot bypass the trusted proxy. The app stores data in `inbox-data`; Caddy stores its certificates in `caddy-data`.

```sh
docker compose -f compose.production.yaml logs -f
docker compose -f compose.production.yaml down
```

The image build runs server tests and the production TypeScript build. A built-in health check probes `/api/health`, and the app handles SIGTERM gracefully.

### Existing reverse proxy

Build the `Dockerfile`, persist `/app/data` (writable by UID/GID **1000**), and route the public origin to container port **3000**. Set:

```dotenv
PUBLIC_URL=https://hooks.example.com
COOKIE_SECURE=true
TRUST_PROXY_HOPS=1
```

- Restrict direct access to the application. Set trusted proxy hops to your exact, controlled proxy chain length, **not** an arbitrary number.
- Have the edge proxy overwrite untrusted `X-Forwarded-For`, then append trusted forwarding information correctly. The included Caddy setup overwrites it with the actual connecting address.
- Preserve the original Host header and set `X-Forwarded-Proto` correctly.
- Disable buffering and compression for `/api/inboxes/*/events`; use a long proxy read timeout. The server sends a heartbeat every 15 seconds and `X-Accel-Buffering: no` for Nginx.
- Allow all desired HTTP methods and a body limit at least as large as `MAX_BODY_BYTES`.
- Do not parse, decompress, or rewrite incoming webhook bodies if you need to inspect the bytes the application received.

**IP accuracy:** with `TRUST_PROXY_HOPS=0` the app ignores forwarding headers for IP attribution and reports the direct socket peer. With trusted hops enabled, it derives client IP from the right-hand side of the `X-Forwarded-For` chain. It always retains the socket address and all received forwarding headers for inspection.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Application HTTP port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATABASE_PATH` | `./data/hookinspector.sqlite` | SQLite path (`/app/data/hookinspector.sqlite` in Docker) |
| `PUBLIC_URL` | Request origin | Canonical public origin, e.g. `https://hooks.example.com` |
| `DEFAULT_TTL_HOURS` | `24` | New endpoint lifetime, integer 1–24 hours |
| `MAX_BODY_BYTES` | `1048576` | Maximum body size; oversized requests receive 413 and are not stored |
| `MAX_REQUESTS_PER_INBOX` | `100` | Most recent requests retained per endpoint |
| `MAX_INBOXES` | `1000` | Maximum active endpoints; creation returns 503 at capacity |
| `MAX_STORAGE_BYTES` | `268435456` | Global logical stored-data budget (256 MiB); ingestion returns 507 when full |
| `MAX_CONCURRENT_UPLOADS` | `32` | Simultaneous body uploads; excess requests receive 503 |
| `CREATE_RATE_LIMIT` | `10` | Endpoint creations per client IP per minute |
| `WEBHOOK_RATE_LIMIT` | `120` | Webhook requests per client IP **and** per endpoint per minute |
| `TRUST_PROXY_HOPS` | `0` | Trusted reverse proxy hops; never enable on an exposed app port |
| `COOKIE_SECURE` | `false` | Secure inspection cookie; automatically true for an HTTPS `PUBLIC_URL` |

Rate limits use bounded, in-memory minute windows and reset on restart. API requests are limited to 300 per IP/minute. Live streams are limited to 5 per inbox and 500 globally. HTTP headers are limited to 32 KiB. The storage budget includes payload bytes, serialized headers/trailers, URL bytes, and an overhead allowance; it is **not a physical disk quota**. SQLite pages are reused after deletion, but the file may retain its high-water size. Apply a filesystem/storage quota and monitor the volume in production.

## Test

```sh
npm test
npm run build
```

The server suite covers live delivery and reconnect snapshots, raw and binary capture, duplicate headers, trailers, IP trust, browser credential isolation, CSRF checks, expiration, retention, persistence across restart, and capacity/rate limits.

Browser tests exercise the real production build on desktop and mobile:

```sh
npx playwright install chromium
npm run build
npm run test:e2e
```

To use an existing Chrome installation instead:

```sh
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e
```

Browser tests use an isolated in-memory database and port 4173. They do not touch your development inboxes.

## HTTP API

| Route | Purpose |
| --- | --- |
| `POST /api/inboxes` | Create endpoint; accepts `{ "ttlHours": 24 }`, returns `{ inbox }`, sets owner cookie |
| `GET /api/inboxes/:id` | Read inbox metadata and request summaries (owner cookie required) |
| `GET /api/inboxes/:id/events` | SSE `ready` snapshot and `update` events (owner cookie required) |
| `GET /api/inboxes/:id/requests/:requestId` | Full captured request; exact body in `bodyBase64` (owner cookie required) |
| `DELETE /api/inboxes/:id/requests` | Clear captured requests (owner cookie required) |
| `DELETE /api/inboxes/:id` | Revoke endpoint and delete its requests (owner cookie required) |
| `ANY /h/:id[/optional/path][?query]` | Public webhook capture; does not require owner cookie |
| `GET /api/health` | Minimal health check |

Accepted webhooks receive **200 JSON** (`{ "ok": true, "message": "Webhook received.", "requestId": "…" }`); HEAD/OPTIONS receive **204**. CORS preflight OPTIONS requests are captured too. Failed, oversized, interrupted, expired, or rate-limited requests are not added to the inbox. The app does not forward or retry webhooks.

## Privacy, scope, and operational notes

- **Do not send production secrets or sensitive personal data.** Incoming authorization headers and cookies are deliberately captured. The operator can access the database; browser isolation is not end-to-end encryption.
- The inbox ID is high-entropy but intentionally shared with senders. Inspection uses a separate 256-bit HttpOnly, SameSite=Strict cookie; only its SHA-256 hash is stored server-side. Keep using the same browser profile to inspect your inbox.
- Expired endpoints are inaccessible immediately and deleted with their requests within 30 seconds while the service is running, or on the next startup. Clearing and revoking delete the corresponding stored records immediately.
- SQLite uses secure deletion and checkpoints its WAL on explicit deletion and expiration. Backups, SSD wear-leveling, snapshots, OS caches, and operator proxy logs have independent retention; this is not a guarantee of forensic erasure.
- Capture reflects **what this HTTP application receives**, not a network packet capture: Node removes HTTP chunk framing; reverse proxies can alter headers, HTTP versions, and connection metadata. Compressed entity bodies remain compressed and are available as original bytes/Base64.
- Body previews are capped at 64K characters/1,000 lines for browser responsiveness; copy, download, and JSON export retain the complete accepted body.
- No third-party scripts, fonts, analytics, or outbound webhook calls are included. An essential cookie and local storage remember browser ownership and the active inbox ID.
- This deployment is designed for a **single application instance**. SQLite, live streams, and rate limits are local; do not horizontally scale it without shared persistence, pub/sub, and distributed limits.
- For a heavily used public service, add edge-level abuse protection, network connection limits, monitoring, storage quotas, and an operator retention/backups policy. Application rate limits do not replace DDoS protection.
