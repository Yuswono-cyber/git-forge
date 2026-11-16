// Shared HTTP plumbing: JSON replies with the protocol discipline every surface
// shares (a JSON content type and a non-empty X-GitHub-Request-Id on every reply),
// body reading, and the bearer-token check against MAKEFUN_SHOP_TOKEN.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    ...headers,
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': randomUUID() });
  res.end();
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/**
 * The presented bearer token must be the trial's token. When the environment
 * carries no token (a local dev run), any non-empty bearer token passes, but a missing one still fails:
 * the suite checks that anonymous calls are refused.
 */
export function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented === '') return false;
  return EXPECTED_TOKEN === '' || presented === EXPECTED_TOKEN;
}

/** The absolute base URL of this server as the caller reached it. */
export function baseUrlOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? 'localhost'}`;
}