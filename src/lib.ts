export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(data.error ?? 'Something went wrong. Please try again.', response.status);
  return data;
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function time(date: string): string {
  return new Date(date).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function remaining(expiresAt: string, now: number): string {
  const milliseconds = new Date(expiresAt).getTime() - now;
  if (milliseconds <= 0) return 'Expired';
  const minutes = Math.max(1, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

export function download(name: string, data: BlobPart, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function bodyBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

export function bodyText(base64: string): string | null {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bodyBytes(base64)); }
  catch { return null; }
}

export function requestPath(url: string): string {
  return url.replace(/^\/h\/[^/?]+/, '') || '/';
}

export function savedInbox(): string | null {
  try { return localStorage.getItem('hookinspector.inbox'); } catch { return null; }
}

export function saveInbox(id: string): void {
  try { localStorage.setItem('hookinspector.inbox', id); } catch { /* The app still works without persistent browser storage. */ }
}
