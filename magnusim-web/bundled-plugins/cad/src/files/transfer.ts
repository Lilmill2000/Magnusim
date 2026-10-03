// Files in and out of the Part (docs/p2p3-plan.md §3.7): the browser's file
// picker (a hidden <input type=file>), drops on the frame, storing bytes with
// ws.files (host API 1.2, create-only, content-addressed), reading them back
// in 16 MB ranges with progress, SHA-256, and handing a file to the user as a
// download (a blob URL on an <a download>; the frame is
// sandbox="allow-scripts allow-downloads").
// One FileTransfer per app (filesFor): published as services.apis.files.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bridge } from '../lib/bridge';
import type { AppServices } from '../types/app';
import type { StoredFileRef } from '../types/doc';
import type { WsFilesApi } from '../types/docstore';
import type { FileTransfer, TransferProgress } from '../types/files';
import { abortError, isAbort, plainFileReason } from './words';

/** Ranges read at a time (the host streams 16 MB chunks). */
export const READ_CHUNK = 16 * 1024 * 1024;
/** How long a download's blob URL lives after the click (the browser starts the save at once; a slow disk must not see it revoked). */
export const DOWNLOAD_URL_TTL_MS = 60_000;

/** The concrete transfer: FileTransfer plus what the import needs to clean up after itself. */
export interface CadFileTransfer extends FileTransfer {
  /** Whether a stored file is there (stat). */
  exists(rel: string): Promise<boolean>;
  /** store(), and whether this call wrote the file (false: an identical one was there). */
  storeNew(rel: string, data: Blob | ArrayBuffer, opts?: Parameters<FileTransfer['store']>[2]): Promise<{ ref: StoredFileRef; created: boolean }>;
  /** Delete stored files (missing ones are fine). */
  remove(rels: string[]): Promise<void>;
  /** ws.files is there (host API 1.2). */
  readonly available: boolean;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Of(data: Blob | ArrayBuffer): Promise<string> {
  const buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  return hex(await crypto.subtle.digest('SHA-256', buf));
}

function sizeOf(data: Blob | ArrayBuffer): number {
  return data instanceof ArrayBuffer ? data.byteLength : data.size;
}

/** "Not stored: <why>" errors keep the host's code for callers that care. */
function notStored(err: unknown): Error {
  if (isAbort(err)) return abortError();
  const e = new Error(`Not stored: ${plainFileReason(err)}`) as Error & { code?: string };
  const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
  if (typeof code === 'string') e.code = code;
  return e;
}

export interface FileTransferOptions {
  /** ws.files (null on a 1.1 host: storing then says so). */
  files: WsFilesApi | null;
  /** The document the picker and the drop hint live in (tests pass jsdom's). */
  document?: Document;
}

export function createFileTransfer(opts: FileTransferOptions): CadFileTransfer {
  // The document is looked up when needed (Node tests store and read without one).
  const dom = () => opts.document ?? document;
  const files = opts.files;
  const need = (): WsFilesApi => {
    if (!files) throw new Error("Not stored: this Magnusim cannot store CAD files (it needs host API 1.2)");
    return files;
  };

  async function exists(rel: string): Promise<boolean> {
    return !!(await need().stat(rel));
  }

  async function storeNew(rel: string, data: Blob | ArrayBuffer, o: Parameters<FileTransfer['store']>[2] = {}): Promise<{ ref: StoredFileRef; created: boolean }> {
    const api = need();
    if (o.signal?.aborted) throw abortError();
    const t0 = performance.now();
    const sha = (o.sha256 ?? (await sha256Of(data))).toLowerCase();
    const size = sizeOf(data);
    const ref: StoredFileRef = { rel, size, sha256: sha };
    // Content-addressed: the same path holds the same bytes, so a file already
    // there is reused (never rewritten: an older undo step may point at it).
    const there = await api.stat(rel).catch((err: unknown) => {
      throw notStored(err);
    });
    if (there && there.size === size) {
      o.onProgress?.({ stage: 'uploading', done: size, total: size, elapsedMs: performance.now() - t0 });
      return { ref, created: false };
    }
    try {
      await api.write(rel, data, {
        ifMatch: there ? there.etag : null,
        sha256: sha,
        signal: o.signal,
        onProgress: (done, total) => o.onProgress?.({ stage: 'uploading', done, total, elapsedMs: performance.now() - t0 }),
      });
    } catch (err) {
      if (o.signal?.aborted) throw abortError();
      // Written by another tab at the same moment (create-only refused): the same bytes are there.
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : null;
      if (code === 'changed') {
        const now = await api.stat(rel).catch(() => null);
        if (now && now.size === size) return { ref, created: false };
      }
      throw notStored(err);
    }
    return { ref, created: true };
  }

  async function read(ref: StoredFileRef | string, o: { onProgress?: (p: TransferProgress) => void; signal?: AbortSignal } = {}): Promise<ArrayBuffer | null> {
    const api = need();
    const rel = typeof ref === 'string' ? ref : ref.rel;
    const t0 = performance.now();
    const info = await api.stat(rel);
    if (!info) return null;
    const total = info.size;
    const out = new Uint8Array(total);
    let done = 0;
    while (done < total) {
      if (o.signal?.aborted) throw abortError();
      const length = Math.min(READ_CHUNK, total - done);
      // Every range from the version stat saw: a file replaced meanwhile is refused ("changed").
      const part = await api.read(rel, { offset: done, length, ifMatch: info.etag });
      if (!part) return null;
      const chunk = new Uint8Array(part).subarray(0, Math.min(part.byteLength, total - done));
      out.set(chunk, done);
      done += chunk.byteLength;
      if (chunk.byteLength === 0) break;
      o.onProgress?.({ stage: 'loading', done, total, elapsedMs: performance.now() - t0 });
    }
    const buf = out.buffer;
    if (typeof ref !== 'string' && ref.sha256) {
      const sha = await sha256Of(buf);
      if (sha !== ref.sha256.toLowerCase()) throw new Error(`the stored file ${rel} changed (its checksum is not the one the Part recorded)`);
    }
    return buf;
  }

  function pick(accept: string[]): Promise<File | null> {
    // Called from the command's click (a user gesture): the click below must
    // run before anything is awaited, or the browser blocks the picker.
    const doc = dom();
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = accept.join(',');
    input.style.display = 'none';
    input.setAttribute('data-cad-file-input', '1');
    doc.body.appendChild(input);
    return new Promise<File | null>((resolve) => {
      let settled = false;
      const done = (f: File | null) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(f);
      };
      input.addEventListener('change', () => done(input.files && input.files.length ? input.files[0] : null));
      input.addEventListener('cancel', () => done(null));
      input.click();
    });
  }

  function onDrop(accept: string[], fn: (file: File) => void): () => void {
    const doc = dom();
    const hint = doc.createElement('div');
    hint.className = 'cad-drop-hint';
    hint.setAttribute('data-cad-drop-hint', '1');
    hint.setAttribute('aria-hidden', 'true');
    hint.hidden = true;
    const card = doc.createElement('div');
    card.className = 'cad-drop-card';
    card.textContent = `Drop a STEP file (${accept.join(', ')}) to import it`;
    hint.appendChild(card);
    doc.body.appendChild(hint);
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...(e.dataTransfer.types ?? [])].includes('Files');
    const show = (on: boolean) => {
      hint.hidden = !on;
    };
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      show(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      show(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) show(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      show(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) fn(f);
    };
    doc.addEventListener('dragenter', enter);
    doc.addEventListener('dragover', over);
    doc.addEventListener('dragleave', leave);
    doc.addEventListener('drop', drop);
    return () => {
      doc.removeEventListener('dragenter', enter);
      doc.removeEventListener('dragover', over);
      doc.removeEventListener('dragleave', leave);
      doc.removeEventListener('drop', drop);
      hint.remove();
    };
  }

  function download(data: Blob | ArrayBuffer, fileName: string, mime = 'application/octet-stream') {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const doc = dom();
    const a = doc.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    a.setAttribute('data-cad-download', fileName);
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_TTL_MS);
  }

  async function remove(rels: string[]): Promise<void> {
    if (!files) return;
    for (const rel of rels) await files.delete(rel).catch(() => {});
  }

  return {
    available: !!files,
    exists,
    storeNew,
    async store(rel, data, o) {
      return (await storeNew(rel, data, o)).ref;
    },
    read,
    sha256: sha256Of,
    pick,
    onDrop,
    download,
    remove,
  };
}

const instances = new WeakMap<AppServices, CadFileTransfer>();

/** The app's FileTransfer, published once as services.apis.files (P2-FEATURES is its one writer). */
export function filesFor(services: AppServices): CadFileTransfer {
  let t = instances.get(services);
  if (!t) {
    t = createFileTransfer({ files: services.bridge.files });
    instances.set(services, t);
  }
  if (services.apis.get().files !== t) services.apis.set({ files: t });
  return t;
}

/** For tests: a transfer over a bridge without the app's services. */
export function filesOfBridge(bridge: Pick<Bridge, 'files'>, document?: Document): CadFileTransfer {
  return createFileTransfer({ files: bridge.files, document });
}
