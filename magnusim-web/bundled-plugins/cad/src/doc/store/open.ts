// Which store holds this Part: the study record's pointer ({ doc: {rel, schema,
// store, view} }), written when a Part is first opened. On a host with API 1.2
// the model goes through ws.files (etag + ifMatch): new Parts start there, and
// a Part a P1 build kept with ws.data moves there once, when it is opened.
// ws.data and ws.files see the same folder, so the model stays at
// studies/<sid>/model.json; the move rewrites it through ws.files (its version
// is then the host's etag) after keeping the P1 file byte for byte as
// studies/<sid>/model.p1.json. Nothing the user made is deleted.
// A 1.1 host (or one that refuses ws.files: "not_allowed") keeps ws.data.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { StudyRecord } from '@magnusim/workspace';
import type { Bridge } from '../../lib/bridge';
import { STUDY_POINTER_FIELD, defaultPointer, readPointer, type DocStore, type StudyPointer, type WsFilesApi } from '../../types/docstore';
import { readDoc } from '../schema';
import { errorCode, isChanged, modelOf, sourceVersionOf, WsDataStore, WsFilesStore } from './stores';

/** Where the move keeps the model file as a P1 build (ws.data) last wrote it. */
export function p1CopyRel(pointer: StudyPointer): string {
  return pointer.rel.replace(/\.json$/, '') + '.p1.json';
}

/** ws.files when the host has them (host API 1.2, see lib/bridge.ts), else null. */
export function filesApi(bridge: Bridge): WsFilesApi | null {
  return bridge.files;
}

export interface OpenedStore {
  store: DocStore;
  /** The study's rev after any pointer write (adopt later ones from ws.on('study')). */
  rev: number;
  /** What happened, for the log ("moved to plugin files"). */
  note: string | null;
}

function storeFor(bridge: Bridge, pointer: StudyPointer, session: string, files: WsFilesApi | null): DocStore {
  if (pointer.store === 'files') {
    if (!files) throw new Error('this Part is saved with plugin files, which need Magnusim with host API 1.2 or newer');
    return new WsFilesStore(files, bridge.data, pointer);
  }
  return new WsDataStore(bridge.data, pointer, session);
}

/** Save the pointer in the study record; a stale rev (a rename meanwhile) is read again once. */
async function writePointer(bridge: Bridge, pointer: StudyPointer, record: StudyRecord): Promise<{ record: StudyRecord; pointer: StudyPointer }> {
  try {
    const next = await bridge.study.update({ [STUDY_POINTER_FIELD]: pointer }, record.rev);
    return { record: next, pointer };
  } catch (first) {
    const fresh = await bridge.study.get();
    const theirs = readPointer(fresh);
    // Another tab wrote a pointer first: use theirs.
    if (theirs && theirs.store === pointer.store) return { record: fresh, pointer: theirs };
    if (fresh.rev === record.rev) throw first;
    const next = await bridge.study.update({ [STUDY_POINTER_FIELD]: pointer }, fresh.rev);
    return { record: next, pointer };
  }
}

/**
 * The one-time move of a P1 Part (pointer "data") to ws.files. The model file
 * is the same file in both views; when ws.data wrote it last (it carries
 * WsDataStore's own version token), keep that file as model.p1.json, then
 * write it again through ws.files on top of the version just read. Returns
 * what happened, or null when there was nothing to move.
 */
async function moveP1Model(store: WsFilesStore, files: WsFilesApi, pointer: StudyPointer): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const r = await store.readJson(pointer.rel);
    if (!r) return null;
    const file = modelOf(r.json);
    if (typeof file.etag !== 'string' || file.moved_to) return null; // already written through ws.files
    // Read it first: a file this version cannot fully read is not moved (nothing is
    // copied or rewritten), and the Part says why instead (P1.5 review round 1).
    const doc = readDoc(file.doc);
    try {
      await files.write(p1CopyRel(pointer), r.bytes, { ifMatch: null });
    } catch (e) {
      // Kept by an earlier try (or another tab opening it at the same moment).
      if (!isChanged(e)) throw e;
    }
    try {
      // The move keeps the design's save counter (a P1 file has none: 0).
      await store.saveModel(doc, r.etag, sourceVersionOf(file));
      return `moved to plugin files (the P1 file is kept as ${p1CopyRel(pointer)})`;
    } catch (e) {
      // Another tab wrote it between the read and the write: read it again.
      if (attempt < 2 && (isChanged(e) || errorCode(e) === 'conflict')) continue;
      throw e;
    }
  }
}

/** Resolve (and if needed write) the pointer, move a P1 ws.data Part to ws.files when the host has them, and open its store. */
export async function openDocStore(bridge: Bridge, session: string, log: (msg: string, err?: unknown) => void = () => {}): Promise<OpenedStore> {
  let record = await bridge.study.get().catch(() => bridge.context.study);
  let files = filesApi(bridge);
  let pointer = readPointer(record);
  let note: string | null = null;

  if (files && (!pointer || pointer.store === 'data')) {
    const target: StudyPointer = pointer ? { ...pointer, store: 'files' } : defaultPointer(bridge.studyId, 'files');
    try {
      if (pointer) note = await moveP1Model(new WsFilesStore(files, bridge.data, target), files, target);
      else await files.stat(target.rel); // a host that lists ws.files but refuses them answers "not_allowed" here
      const wrote = await writePointer(bridge, target, record);
      record = wrote.record;
      pointer = wrote.pointer;
    } catch (e) {
      if (errorCode(e) === 'not_allowed') {
        log('plugin files are not usable here (not_allowed); using ws.data', e);
        files = null;
      } else if (pointer) {
        // The move failed (the disk is full, say): keep ws.data this time; it is tried again on the next open.
        log('could not move the model to plugin files', e);
      } else {
        throw e;
      }
    }
  }
  if (!pointer) {
    const wrote = await writePointer(bridge, defaultPointer(bridge.studyId, 'data'), record);
    record = wrote.record;
    pointer = wrote.pointer;
  }
  return { store: storeFor(bridge, pointer, session, files), rev: record.rev, note };
}
