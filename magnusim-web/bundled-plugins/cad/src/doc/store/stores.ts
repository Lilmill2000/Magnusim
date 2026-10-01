// DocStore backends: WsFilesStore (host API 1.2: the model through ws.files
// with etag / ifMatch) and WsDataStore (only on a 1.1 host: ws.data JSON).
// ws.data and ws.files are two views of one folder (the plugin's folder of the
// project), so studies/<sid>/model.json is the same file in both.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bridge } from '../../lib/bridge';
import type { CadDoc, CadView } from '../../types/doc';
import { DocConflictError, DocSaveError, type DocStore, type StoredModel, type StudyPointer, type WsFileInfo, type WsFilesApi } from '../../types/docstore';
import { DocReadError, readDoc } from '../schema';

export const MODEL_FORMAT = 'magnusim-cad/model';
export const VIEW_FORMAT = 'magnusim-cad/view';

/** The model file (both stores): the document, and WsDataStore's version token. */
export interface ModelFile {
  format: typeof MODEL_FORMAT;
  /**
   * WsDataStore's version token ("<n>.<session>"). A file written through
   * ws.files has none: the host's etag is its version. A model.json that has
   * one was last written by ws.data (a P1 Part, or a 1.1 host).
   */
  etag?: string;
  saved_at: string;
  doc: CadDoc | null;
  /** Set by a P1 build that moved the model to another store: this file is only a forwarding note. */
  moved_to?: 'files';
}

export interface ViewFile {
  format: typeof VIEW_FORMAT;
  view: CadView;
}

/** The counter of a WsDataStore version token ("12.s_ab" -> 12; none -> 0). */
function tokenNumber(etag: string | null): number {
  return etag ? Number.parseInt(etag, 10) || 0 : 0;
}

export function modelOf(file: unknown): ModelFile {
  if (!file || typeof file !== 'object' || (file as ModelFile).format !== MODEL_FORMAT) throw new DocReadError('the model file is not a Part model');
  return file as ModelFile;
}

/**
 * ws.data JSON files, for a 1.1 host only. The host has no conditional write,
 * so each save re-reads the stored token first: another writer since our read
 * is a DocConflictError (a narrow race remains). Every call runs on the host's
 * worker: the autosave budgets its writes (P0 gate 10, doc/autosave.ts).
 */
export class WsDataStore implements DocStore {
  readonly kind = 'data' as const;
  constructor(
    private readonly data: Bridge['data'],
    readonly pointer: StudyPointer,
    private readonly session: string,
  ) {}

  async loadModel(): Promise<StoredModel | null> {
    const raw = await this.data.read<unknown>(this.pointer.rel);
    if (raw == null) return null;
    const file = modelOf(raw);
    if (file.moved_to) throw new DocReadError(`the model moved to plugin ${file.moved_to}; reload the Part`);
    return { doc: readDoc(file.doc), etag: String(file.etag ?? ''), savedAt: typeof file.saved_at === 'string' ? file.saved_at : null };
  }

  /** The etag of the last model write this tab posted (a conditional save or saveModelNow). */
  private lastPosted: string | null = null;
  /** Bumped by saveModelNow(): a conditional save still reading when it came does not write. */
  private nowSeq = 0;
  private nowDone: Promise<string> | null = null;

  /** Written by this tab (this page's session): never another tab's work to protect. */
  private ours(etag: string | null): boolean {
    return !!etag && etag.endsWith(`.${this.session}`);
  }

  async saveModel(doc: CadDoc, ifMatch: string | null): Promise<string> {
    const seq = this.nowSeq;
    const raw = await this.data.read<unknown>(this.pointer.rel);
    // saveModelNow() posted a newer model while this one read: this one must not land after it.
    if (seq !== this.nowSeq && this.nowDone) return this.nowDone;
    const current = raw == null ? null : String((raw as ModelFile).etag ?? '');
    // Another writer since our read is a conflict. An etag this tab wrote (a
    // saveModelNow() whose answer never came back) is not.
    if (current !== ifMatch && !this.ours(current)) throw new DocConflictError();
    const etag = `${tokenNumber(current) + 1}.${this.session}`;
    const file: ModelFile = { format: MODEL_FORMAT, etag, saved_at: new Date().toISOString(), doc };
    this.lastPosted = etag;
    await this.data.write(this.pointer.rel, file);
    return etag;
  }

  /**
   * The page is going this instant (F5, the mouse's Back button): post the
   * model in one message, without the re-read, before returning. It goes on
   * top of the newer of `previous` and what this tab last posted (a
   * conditional write may be on its way). See DocStore.saveModelNow and
   * doc/autosave.ts leaveNow().
   */
  saveModelNow(doc: CadDoc, previous: string | null): { etag: string; done: Promise<string> } {
    this.nowSeq++;
    const base = tokenNumber(this.lastPosted) > tokenNumber(previous) ? this.lastPosted : previous;
    const etag = `${tokenNumber(base) + 1}.${this.session}`;
    const file: ModelFile = { format: MODEL_FORMAT, etag, saved_at: new Date().toISOString(), doc };
    this.lastPosted = etag;
    const done = this.data.write(this.pointer.rel, file).then(() => etag);
    this.nowDone = done;
    return { etag, done };
  }

  async loadView(): Promise<CadView | null> {
    return readViewFile(await this.data.read<unknown>(this.pointer.view));
  }

  async saveView(view: CadView): Promise<void> {
    const file: ViewFile = { format: VIEW_FORMAT, view };
    await this.data.write(this.pointer.view, file);
  }
}

function readViewFile(raw: unknown): CadView | null {
  const f = raw as ViewFile | null;
  return f && typeof f === 'object' && f.format === VIEW_FORMAT ? f.view : null;
}

/** A host rejection's code ("changed", "not_allowed", ...), or null. */
export function errorCode(e: unknown): string | null {
  if (!e || typeof e !== 'object') return null;
  const c = (e as { code?: unknown }).code;
  if (typeof c === 'string') return c;
  const s = (e as { status?: unknown }).status;
  return s === 409 ? 'changed' : null;
}

export const isChanged = (e: unknown) => {
  const c = errorCode(e);
  return c === 'changed' || c === 'conflict';
};

/** The host's own words after a code, when it gave any ("a file may be 512 MB at most"). */
function hostWords(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return m.replace(/^Error:\s*/, '').trim();
}

/**
 * Why a save was refused, in plain words, for the chip ("Not saved: <why>").
 * The host's codes are listed in docs/plugins/compatibility.md "## 1.2".
 */
export function plainSaveReason(e: unknown): string {
  const words = hostWords(e);
  switch (errorCode(e)) {
    case 'too_large':
      return words ? `the part is too large to save (${words})` : 'the part is too large to save';
    case 'quota':
      return words ? `Magnusim CAD's files in this project are full (${words})` : "Magnusim CAD's files in this project are full";
    case 'disk_full':
      return 'the disk is full';
    case 'plugin_off':
      return 'Magnusim CAD was turned off';
    case 'busy':
      return "another program has the part's file open";
    case 'invalid_path':
      return "the part's file name was refused";
    case 'study_not_found':
    case 'study_record':
      return 'this Part was deleted';
    case 'project_not_found':
      return 'the project was removed';
    case 'too_many_uploads':
      return 'too many files are being saved at once';
    case 'unavailable':
      return 'the app is busy';
    case 'checksum':
      return 'the part arrived damaged at the app';
    default:
      return words || 'the app did not answer';
  }
}

const dec = new TextDecoder();

/**
 * The model through ws.files (host API 1.2): every save is conditional on the
 * etag this tab last read or wrote (ifMatch; null creates only), so another
 * tab's save is never overwritten: the host answers "changed", and the chip
 * says "Changed in another tab · Reload". The view (rollback bar, folders,
 * eyes, camera) is a small last-write-wins JSON file: it goes through ws.data,
 * one message on the host's plugin lane, and never makes the page dirty.
 */
export class WsFilesStore implements DocStore {
  readonly kind = 'files' as const;
  constructor(
    private readonly files: WsFilesApi,
    private readonly data: Bridge['data'],
    readonly pointer: StudyPointer,
  ) {}

  /** The file's JSON and the etag it was read at (stat, then read with ifMatch: one version). */
  async readJson(rel: string): Promise<{ json: unknown; etag: string; bytes: ArrayBuffer } | null> {
    for (let attempt = 0; ; attempt++) {
      const info: WsFileInfo | null = await this.files.stat(rel);
      if (!info) return null;
      try {
        const buf = await this.files.read(rel, { ifMatch: info.etag });
        if (buf == null) return null;
        let json: unknown;
        try {
          json = JSON.parse(dec.decode(buf));
        } catch {
          throw new DocReadError(`${rel} is not valid JSON`);
        }
        return { json, etag: info.etag, bytes: buf };
      } catch (e) {
        // Written between stat and read: read again (twice at most).
        if (isChanged(e) && attempt < 2) continue;
        throw e;
      }
    }
  }

  async loadModel(): Promise<StoredModel | null> {
    const r = await this.readJson(this.pointer.rel);
    if (!r) return null;
    const file = modelOf(r.json);
    if (file.moved_to) throw new DocReadError(`the model moved to plugin ${file.moved_to}; reload the Part`);
    return { doc: readDoc(file.doc), etag: r.etag, savedAt: typeof file.saved_at === 'string' ? file.saved_at : null };
  }

  async saveModel(doc: CadDoc, ifMatch: string | null): Promise<string> {
    const file: ModelFile = { format: MODEL_FORMAT, saved_at: new Date().toISOString(), doc };
    try {
      const r = await this.files.write(this.pointer.rel, JSON.stringify(file), { ifMatch });
      return r.etag;
    } catch (e) {
      if (isChanged(e)) throw new DocConflictError();
      throw new DocSaveError(plainSaveReason(e), errorCode(e));
    }
  }

  async loadView(): Promise<CadView | null> {
    return readViewFile(await this.data.read<unknown>(this.pointer.view));
  }

  async saveView(view: CadView): Promise<void> {
    const file: ViewFile = { format: VIEW_FORMAT, view };
    await this.data.write(this.pointer.view, file);
  }
}
