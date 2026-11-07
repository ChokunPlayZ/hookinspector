import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CapturedRequest, CapturedRequestSummary, HeaderPair } from '../shared/types.js';

export interface InboxRow {
  id: string;
  owner_hash: string;
  created_at: number;
  expires_at: number;
}

interface RequestRow {
  id: string;
  inbox_id: string;
  method: string;
  url: string;
  received_at: number;
  remote_address: string;
  client_address: string;
  remote_port: number | null;
  content_type: string;
  body_size: number;
  duration_ms: number;
  headers: string;
  trailers: string;
  body: Uint8Array;
  http_version: string;
  protocol: string;
}

export interface RequestInput {
  inboxId: string;
  method: string;
  url: string;
  receivedAt: number;
  remoteAddress: string;
  clientAddress: string;
  remotePort: number | null;
  headers: HeaderPair[];
  trailers: HeaderPair[];
  body: Buffer;
  durationMs: number;
  contentType: string;
  httpVersion: string;
  protocol: string;
}

export class StorageFullError extends Error {}

function summary(row: RequestRow): CapturedRequestSummary {
  return {
    id: row.id,
    inboxId: row.inbox_id,
    method: row.method,
    url: row.url,
    receivedAt: new Date(row.received_at).toISOString(),
    remoteAddress: row.remote_address,
    clientAddress: row.client_address,
    contentType: row.content_type,
    bodySize: row.body_size,
    durationMs: row.duration_ms,
    responseStatus: ['HEAD', 'OPTIONS'].includes(row.method) ? 204 : 200,
  };
}

const summaryColumns = `id, inbox_id, method, url, received_at, remote_address,
  client_address, content_type, body_size, duration_ms`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, private readonly maxRequests: number, private readonly maxStorageBytes = 256 * 1024 * 1024) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS inboxes (
        id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inboxes_expiry ON inboxes(expires_at);
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
        method TEXT NOT NULL, url TEXT NOT NULL, received_at INTEGER NOT NULL,
        remote_address TEXT NOT NULL, client_address TEXT NOT NULL, remote_port INTEGER,
        content_type TEXT NOT NULL, body_size INTEGER NOT NULL, duration_ms REAL NOT NULL,
        headers TEXT NOT NULL, trailers TEXT NOT NULL, body BLOB NOT NULL,
        http_version TEXT NOT NULL, protocol TEXT NOT NULL, stored_bytes INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_inbox ON requests(inbox_id, received_at DESC);
      CREATE TABLE IF NOT EXISTS storage_usage (
        id INTEGER PRIMARY KEY CHECK (id = 1), bytes INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO storage_usage SELECT 1, coalesce(sum(stored_bytes), 0) FROM requests;
      CREATE TRIGGER IF NOT EXISTS storage_insert AFTER INSERT ON requests BEGIN
        UPDATE storage_usage SET bytes = bytes + NEW.stored_bytes WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS storage_delete AFTER DELETE ON requests BEGIN
        UPDATE storage_usage SET bytes = bytes - OLD.stored_bytes WHERE id = 1;
      END;
    `);
  }

  createInbox(ownerHash: string, ttlHours: number): InboxRow {
    const now = Date.now();
    const row: InboxRow = {
      id: randomBytes(12).toString('base64url'),
      owner_hash: ownerHash,
      created_at: now,
      expires_at: now + ttlHours * 3_600_000,
    };
    this.db.prepare('INSERT INTO inboxes VALUES (?, ?, ?, ?)')
      .run(row.id, row.owner_hash, row.created_at, row.expires_at);
    return row;
  }

  inbox(id: string): InboxRow | undefined {
    return this.db.prepare('SELECT * FROM inboxes WHERE id = ?').get(id) as unknown as InboxRow | undefined;
  }

  countInboxes(): number {
    return Number(this.db.prepare('SELECT count(*) AS count FROM inboxes').get()?.count ?? 0);
  }

  prune(now = Date.now()): string[] {
    const expired = this.db.prepare('SELECT id FROM inboxes WHERE expires_at <= ?').all(now) as { id: string }[];
    this.db.prepare('DELETE FROM inboxes WHERE expires_at <= ?').run(now);
    // Expired payloads should not linger indefinitely in a write-ahead log.
    if (expired.length) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return expired.map(({ id }) => id);
  }

  clear(id: string): void {
    this.db.prepare('DELETE FROM requests WHERE inbox_id = ?').run(id);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  deleteInbox(id: string): void {
    this.db.prepare('DELETE FROM inboxes WHERE id = ?').run(id);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  insert(input: RequestInput): CapturedRequestSummary {
    const id = randomBytes(12).toString('base64url');
    const headers = JSON.stringify(input.headers);
    const trailers = JSON.stringify(input.trailers);
    const storedBytes = input.body.length + Buffer.byteLength(headers) + Buffer.byteLength(trailers) + Buffer.byteLength(input.url) + 512;
    const used = Number(this.db.prepare('SELECT bytes FROM storage_usage WHERE id = 1').get()?.bytes ?? 0);
    if (used + storedBytes > this.maxStorageBytes) throw new StorageFullError('Request storage is full. Clear requests or try again after endpoints expire.');
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.inboxId, input.method, input.url, input.receivedAt,
          input.remoteAddress, input.clientAddress, input.remotePort, input.contentType,
          input.body.length, input.durationMs, headers,
          trailers, input.body, input.httpVersion, input.protocol, storedBytes);
      this.db.prepare(`DELETE FROM requests WHERE inbox_id = ? AND id NOT IN (
        SELECT id FROM requests WHERE inbox_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?
      )`).run(input.inboxId, input.inboxId, this.maxRequests);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.list(input.inboxId).find((request) => request.id === id)!;
  }

  list(inboxId: string): CapturedRequestSummary[] {
    const rows = this.db.prepare(`SELECT ${summaryColumns} FROM requests WHERE inbox_id = ? ORDER BY received_at DESC, rowid DESC`)
      .all(inboxId) as unknown as RequestRow[];
    return rows.map(summary);
  }

  request(inboxId: string, id: string): CapturedRequest | undefined {
    const row = this.db.prepare('SELECT * FROM requests WHERE inbox_id = ? AND id = ?')
      .get(inboxId, id) as unknown as RequestRow | undefined;
    if (!row) return undefined;
    return {
      ...summary(row),
      headers: JSON.parse(row.headers) as HeaderPair[],
      trailers: JSON.parse(row.trailers) as HeaderPair[],
      bodyBase64: Buffer.from(row.body).toString('base64'),
      httpVersion: row.http_version,
      remotePort: row.remote_port,
      protocol: row.protocol,
    };
  }

  close(): void { this.db.close(); }
}
