import type { IncomingMessage, ServerResponse } from 'node:http';

export type SendJson = (res: ServerResponse, status: number, body: unknown) => void;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

export function parseUrl(reqUrl: string | undefined): URL {
  return new URL(reqUrl || '/', 'http://127.0.0.1');
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBinaryBody(req, 2 * 1024 * 1024)).toString('utf8');
  if (!raw.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new HttpError(400, 'invalid JSON body'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'JSON body must be an object');
  }
  return parsed as Record<string, unknown>;
}

export function readBinaryBody(req: IncomingMessage, limit = 256 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let exceeded = false;
    req.on('data', (c: Buffer) => {
      if (exceeded) return;
      total += c.length;
      if (total > limit) {
        exceeded = true;
        chunks = [];
        reject(new HttpError(413, 'request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    req.on('aborted', () => { chunks = []; reject(new HttpError(400, 'request aborted')); });
    req.on('error', reject);
  });
}

export function sendBytes(
  res: ServerResponse,
  buf: Buffer,
  headers: Record<string, string>,
  headOnly = false,
): void {
  res.statusCode = 200;
  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v);
  }
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', headers['Cache-Control'] || 'no-store');
  if (headOnly) {
    res.end();
    return;
  }
  res.end(buf);
}

export function weakEtag(payload: string): string {
  let h = 2166136261;
  for (let i = 0; i < payload.length; i += 1) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `W/"${(h >>> 0).toString(16)}-${payload.length.toString(16)}"`;
}

/** Browser requests must come from the app origin, including localhost deployments. */
export function assertSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-site API request denied');
  if (!origin) return; // Native/CLI clients do not send Origin.
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new HttpError(403, 'invalid request origin'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.headers.host) {
    throw new HttpError(403, 'cross-origin API request denied');
  }
}
