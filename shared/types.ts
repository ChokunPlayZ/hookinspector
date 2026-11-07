export type HeaderPair = [string, string];

export interface Inbox {
  id: string;
  url: string;
  createdAt: string;
  expiresAt: string;
  requestLimit: number;
  bodyLimit: number;
}

export interface CapturedRequestSummary {
  id: string;
  inboxId: string;
  method: string;
  url: string;
  receivedAt: string;
  remoteAddress: string;
  clientAddress: string;
  contentType: string;
  bodySize: number;
  durationMs: number;
  responseStatus: number;
}

export interface CapturedRequest extends CapturedRequestSummary {
  headers: HeaderPair[];
  trailers: HeaderPair[];
  bodyBase64: string;
  httpVersion: string;
  remotePort: number | null;
  protocol: string;
}

export type LiveEvent =
  | { type: 'request'; request: CapturedRequestSummary }
  | { type: 'cleared' }
  | { type: 'expired' };
