// An in-memory `ws.files` (host API 1.2) over a plugin folder: etags, ifMatch
// (a mismatch rejects with code "changed"), create-only with ifMatch null. The
// folder is shared with the fake ws.data (tests/fakes/workspace-sdk.ts), as on
// the real host, where ws.data and ws.files are two views of one folder.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { WsFileInfo, WsFilesApi } from '../../src/types/docstore';

export interface FolderEntry {
  bytes: Uint8Array;
  etag: string;
  mtime: string;
}

/** The plugin's folder of a project: rel -> bytes and version. */
export class FakeFolder {
  readonly entries = new Map<string, FolderEntry>();
  private n = 0;

  put(rel: string, bytes: Uint8Array): FolderEntry {
    const e = { bytes, etag: `e${++this.n}`, mtime: new Date().toISOString() };
    this.entries.set(rel, e);
    return e;
  }

  putJson(rel: string, value: unknown): void {
    this.put(rel, new TextEncoder().encode(JSON.stringify(value)));
  }

  json(rel: string): unknown {
    const f = this.entries.get(rel);
    return f ? JSON.parse(new TextDecoder().decode(f.bytes)) : null;
  }

  has(rel: string): boolean {
    return this.entries.has(rel);
  }

  info(rel: string): WsFileInfo | null {
    const f = this.entries.get(rel);
    return f ? { rel, size: f.bytes.byteLength, mtime: f.mtime, etag: f.etag } : null;
  }
}

const refusal = (code: string, message = code) => Object.assign(new Error(message), { code });

export class FakeFiles implements WsFilesApi {
  writes: { rel: string; ifMatch: string | null | undefined }[] = [];
  /** Reject every call with this code (e.g. "not_allowed" on a 1.1 host). */
  refuse: string | null = null;
  /** Reject the next writes with these codes, one per write ("disk_full", "quota", ...). */
  failNext: { code: string; message: string }[] = [];
  /** Hold every write here until the test releases it (a write on its way). */
  hold: Promise<void> | null = null;

  constructor(readonly folder: FakeFolder = new FakeFolder()) {}

  private check() {
    if (this.refuse) throw refusal(this.refuse, `files: ${this.refuse}`);
  }

  async read(rel: string, opts: { ifMatch?: string } = {}): Promise<ArrayBuffer | null> {
    this.check();
    const f = this.folder.entries.get(rel);
    if (!f) return null;
    if (opts.ifMatch !== undefined && opts.ifMatch !== f.etag) throw refusal('changed', 'the file changed since it was read');
    return f.bytes.slice().buffer;
  }

  async readBlob(rel: string, opts: { ifMatch?: string } = {}): Promise<Blob | null> {
    const b = await this.read(rel, opts);
    return b ? new Blob([b]) : null;
  }

  async stat(rel: string) {
    this.check();
    return this.folder.info(rel);
  }

  async write(rel: string, data: ArrayBuffer | ArrayBufferView | Blob | string, opts: { ifMatch?: string | null } = {}) {
    this.check();
    this.writes.push({ rel, ifMatch: opts.ifMatch });
    if (this.hold) await this.hold;
    const fail = this.failNext.shift();
    if (fail) throw refusal(fail.code, fail.message);
    const cur = this.folder.entries.get(rel);
    if (opts.ifMatch === null && cur) throw refusal('changed', 'a file is already there');
    if (typeof opts.ifMatch === 'string' && (!cur || cur.etag !== opts.ifMatch)) throw refusal('changed', 'the file changed since it was read');
    let bytes: Uint8Array;
    if (typeof data === 'string') bytes = new TextEncoder().encode(data);
    else if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    else bytes = new Uint8Array(data.slice(0));
    this.folder.put(rel, bytes);
    return { ...this.folder.info(rel)!, sha256: 'x' };
  }

  async list(prefix = '') {
    this.check();
    return [...this.folder.entries.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => this.folder.info(k)!);
  }

  async delete(rel: string) {
    this.check();
    return { deleted: this.folder.entries.delete(rel) ? 1 : 0 };
  }

  json(rel: string): unknown {
    return this.folder.json(rel);
  }
}
