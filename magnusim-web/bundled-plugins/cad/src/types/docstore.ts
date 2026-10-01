// Persistence of the Part document, outside the study record (decision
// 2026-09-30, P0 gate 10): the study record holds only its host fields and a
// small pointer under `doc`. Owner: DOC-CORE (src/doc/store/).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CadDoc, CadView } from './doc';

/** The study record's field that holds the pointer: ws.study.update({ doc: pointer }, rev). */
export const STUDY_POINTER_FIELD = 'doc' as const;

/**
 * The pointer the study record keeps. Written once when a Part is first
 * opened (and again only if its model moves to another store).
 */
export interface StudyPointer {
  /** Path of the model file inside the plugin's project folder (plugins/cad/<rel>). */
  rel: string;
  /** Schema of the model it points to (CadDoc.schema). */
  schema: 1;
  /** Which API writes it: ws.files with etags ("files", host 1.2) or ws.data JSON ("data", a 1.1 host). */
  store: 'data' | 'files';
  /** Path of the view file (rollback, visibility, tree state). */
  view: string;
}

/** Default paths: beside study.json, so deleting the study deletes its model. */
export function defaultPointer(studyId: string, store: 'data' | 'files' = 'data'): StudyPointer {
  return {
    rel: `studies/${studyId}/model.json`,
    schema: 1,
    store,
    view: `studies/${studyId}/view.json`,
  };
}

/** A pointer read from a study record, or null when it is missing or malformed. */
export function readPointer(record: Record<string, unknown> | null | undefined): StudyPointer | null {
  const p = record ? (record[STUDY_POINTER_FIELD] as Partial<StudyPointer> | undefined) : undefined;
  if (!p || typeof p !== 'object') return null;
  if (typeof p.rel !== 'string' || !p.rel || typeof p.view !== 'string' || !p.view) return null;
  if (p.store !== 'data' && p.store !== 'files') return null;
  return { rel: p.rel, view: p.view, store: p.store, schema: 1 };
}

/**
 * What a model file holds. `etag` is the store's version token: the host's etag
 * for WsFilesStore (G1), or the writer's own counter + session for WsDataStore.
 */
export interface StoredModel {
  doc: CadDoc;
  etag: string;
  /** When it was written (ISO), when the file says. */
  savedAt?: string | null;
}

/** A save refused because someone else wrote the model since we read it (another tab). */
export class DocConflictError extends Error {
  readonly code = 'conflict' as const;
  constructor(message = 'Changed in another tab') {
    super(message);
    this.name = 'DocConflictError';
  }
}

/**
 * A save the host refused for a reason the user can act on (the disk is full,
 * the project's CAD files are at their limit, ...). `message` is the plain
 * reason the chip shows after "Not saved: "; `code` is the host's.
 */
export class DocSaveError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'DocSaveError';
  }
}

/**
 * The document's storage backend.
 * - WsFilesStore (host API 1.2): the model through ws.files, written with
 *   ifMatch = the etag of the last read or write, so another tab's save is
 *   never overwritten (code "changed"). Binary imports (STEP, BREP) go here too.
 * - WsDataStore (only on a 1.1 host): ws.data JSON files. No host-side
 *   conditional write, so it re-reads the stored version before each write (a
 *   narrow race remains).
 * Both keep the model at studies/<sid>/model.json: ws.data and ws.files are two
 * views of the same folder, so it is the same file.
 */
export interface DocStore {
  readonly kind: 'data' | 'files';
  readonly pointer: StudyPointer;
  /** null when the study has no model yet (a new Part). */
  loadModel(): Promise<StoredModel | null>;
  /** Write if the stored etag still equals `ifMatch` (null = must not exist). Returns the new etag. Rejects with DocConflictError. */
  saveModel(doc: CadDoc, ifMatch: string | null): Promise<string>;
  /**
   * The page is going this instant: post `doc` in ONE message before returning,
   * on top of `previous` (the version this tab last stored). WsDataStore only (a
   * 1.1 host, which has neither a conditional write nor nav.setDirty): it cannot
   * re-check for another tab here (doc/autosave.ts leaveNow() says when it is
   * used). WsFilesStore has none: on a 1.2 host every save is conditional and
   * the host asks before the page goes while one is on its way.
   */
  saveModelNow?(doc: CadDoc, previous: string | null): { etag: string; done: Promise<string> };
  loadView(): Promise<CadView | null>;
  /** Last write wins; never conflicts. */
  saveView(view: CadView): Promise<void>;
}

/** A file in the plugin's project folder, as ws.files (host API 1.2) describes it. */
export interface WsFileInfo {
  rel: string;
  size: number;
  /** ISO-8601, UTC. */
  mtime: string;
  /** Changes whenever the file does; pass it as `ifMatch`. */
  etag: string;
}

/**
 * `ws.files` (host API 1.2, docs/plugins/compatibility.md "## 1.2"): the
 * plugin's folder of the project, streamed by the app server, etag + ifMatch.
 * Rejections carry `.code`: "changed" when an ifMatch does not hold (409),
 * "not_allowed" on a 1.1 host, "too_large", "quota", "disk_full", "plugin_off",
 * "busy", "invalid_path", ... src/lib/bridge.ts exposes it only on a 1.2 host.
 */
export interface WsFilesApi {
  /** The bytes (null when there is no such file). With ifMatch: rejects "changed" unless the etag still holds. */
  read(rel: string, opts?: { offset?: number; length?: number; ifMatch?: string }): Promise<ArrayBuffer | null>;
  stat(rel: string): Promise<WsFileInfo | null>;
  /** ifMatch string: replace only that version; null: create only. Rejects with code "changed" otherwise. A string is written as UTF-8. */
  write(rel: string, data: ArrayBuffer | ArrayBufferView | Blob | string, opts?: { ifMatch?: string | null }): Promise<WsFileInfo & { sha256?: string }>;
  list(prefix?: string): Promise<WsFileInfo[]>;
  delete(rel: string, opts?: { recursive?: boolean }): Promise<unknown>;
}
