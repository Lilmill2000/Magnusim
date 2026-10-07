// Plugin packages (Settings > Plugins > Install plugin from zip): the upload is
// streamed to .cache/plugin-incoming/upload-<id>.zip, never held in memory, and the
// worker checks and installs it from there (cfddesk/registry/plugin_package.py).
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join, resolve } from 'node:path';
import { HttpError } from './http.ts';

/** A package is at most this big (plugin_package.MAX_PACKAGE_BYTES). */
export const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
/** An upload's name, the only thing the worker is given. */
export const UPLOAD_RE = /^upload-[A-Za-z0-9]{8,64}\.zip$/;
/** An upload nobody installed is deleted after this long. */
const UPLOAD_TTL_MS = 60 * 60 * 1000;

export function incomingDir(webRoot: string): string {
  return resolve(webRoot, '.cache', 'plugin-incoming');
}

/** Delete uploads older than an hour (a check that was never confirmed). */
export function sweepUploads(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!UPLOAD_RE.test(name)) continue;
    try {
      if (now - statSync(join(dir, name)).mtimeMs > UPLOAD_TTL_MS) unlinkSync(join(dir, name));
    } catch {
      /* in use or gone */
    }
  }
}

export function dropUpload(dir: string, name: string): void {
  if (!UPLOAD_RE.test(name)) return;
  try {
    unlinkSync(join(dir, name));
  } catch {
    /* gone */
  }
}

/**
 * Stream the request body into a new upload file; its name. Refuses a body over
 * `limit` (by its Content-Length before reading, else as it arrives) with 413.
 */
export function saveUpload(req: IncomingMessage, dir: string, limit = MAX_PACKAGE_BYTES): Promise<string> {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) {
    req.resume();
    return Promise.reject(new HttpError(413, `the file is ${Math.round(declared / 1048576)} MB; a plugin package is at most ${limit / 1048576} MB`));
  }
  mkdirSync(dir, { recursive: true });
  sweepUploads(dir);
  const name = `upload-${randomBytes(12).toString('hex')}.zip`;
  const path = join(dir, name);
  return new Promise((done, fail) => {
    const out = createWriteStream(path, { flags: 'wx' });
    let total = 0;
    let failed = false;
    const stop = (err: Error) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      req.resume();
      out.destroy();
      out.once('close', () => dropUpload(dir, name));
      fail(err);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) stop(new HttpError(413, `a plugin package is at most ${limit / 1048576} MB`));
    });
    req.on('aborted', () => stop(new HttpError(400, 'the upload was interrupted')));
    req.on('error', (err) => stop(err));
    out.on('error', (err) => stop(err));
    out.on('finish', () => {
      if (failed) return;
      if (total === 0) {
        dropUpload(dir, name);
        fail(new HttpError(400, 'no file was sent'));
        return;
      }
      done(name);
    });
    req.pipe(out);
  });
}
