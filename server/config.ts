import { resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  databasePath: string;
  publicUrl: string | undefined;
  defaultTtlHours: number;
  maxBodyBytes: number;
  maxRequestsPerInbox: number;
  maxInboxes: number;
  maxStorageBytes: number;
  maxConcurrentUploads: number;
  createRateLimit: number;
  webhookRateLimit: number;
  trustProxyHops: number;
  cookieSecure: boolean;
  publicDir: string;
}

function integer(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(): Config {
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '');
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new Error('PUBLIC_URL must be an http(s) origin, e.g. https://hooks.example.com');
    }
  }
  return {
    port: integer('PORT', 3000, 0, 65535),
    host: process.env.HOST ?? '0.0.0.0',
    databasePath: process.env.DATABASE_PATH ?? resolve('data/hookinspector.sqlite'),
    publicUrl,
    defaultTtlHours: integer('DEFAULT_TTL_HOURS', 24, 1, 24),
    maxBodyBytes: integer('MAX_BODY_BYTES', 1024 * 1024, 1, 10 * 1024 * 1024),
    maxRequestsPerInbox: integer('MAX_REQUESTS_PER_INBOX', 100, 1, 1000),
    maxInboxes: integer('MAX_INBOXES', 1000, 1, 100000),
    maxStorageBytes: integer('MAX_STORAGE_BYTES', 256 * 1024 * 1024),
    maxConcurrentUploads: integer('MAX_CONCURRENT_UPLOADS', 32, 1, 1024),
    createRateLimit: integer('CREATE_RATE_LIMIT', 10),
    webhookRateLimit: integer('WEBHOOK_RATE_LIMIT', 120),
    trustProxyHops: integer('TRUST_PROXY_HOPS', 0, 0, 10),
    cookieSecure: process.env.COOKIE_SECURE === 'true' || publicUrl?.startsWith('https://') === true,
    publicDir: resolve('dist/public'),
  };
}
