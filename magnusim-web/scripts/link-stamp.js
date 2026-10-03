// @ts-check
/**
 * Saves of face-carrying records on a linked geometry (host API 1.5, LINK proposal 5.16).
 *
 * A geometry a link made keeps `link/state.json` with its rev. Every boundary condition,
 * material, refinement, study result control, draft run and mesh doc of its studies
 * carries `geometry_rev`, the rev its face labels were drawn at. After an update the
 * labels on disk are the new rev's, so a tab that loaded the old ones must not save:
 *
 * - a save must carry the geometry's current rev (the record's own stamp, else the rev
 *   of the geometry the tab shows), else `409 geometry_changed`:
 *   "<Geometry> was updated. This change was not saved." (for every field, D28);
 * - while the geometry is fenced (a commit journal no live job owns) such saves answer
 *   `503 geometry_updating` "Updating <Geometry>. Try again in a moment." (Retry-After 2);
 * - the stamp on disk is the server's: once the check passes, the writer sets
 *   `geometry_rev` to the rev it passed with (persistChildItem's `geometryRev`); a writer
 *   with no checked rev keeps the one on disk, as it keeps `lost_faces`.
 *
 * A study on a geometry no link made is not checked. Deletes and renames are never refused.
 */
import { join } from 'node:path';
import { findStudy, keepLinkKeys, readJsonFile } from './project-layout.js';
import { geometryFenced } from './server/link-job.js';

export const LINK_STAMP_TEXT = Object.freeze({
  updating: (/** @type {string} */ g) => `Updating ${g}. Try again in a moment.`,
  changed: (/** @type {string} */ g) => `${g} was updated. This change was not saved.`,
});

/**
 * The link state of a study's geometry, or null when no link made it.
 * @param {string} projectDirPath @param {string | null | undefined} simId
 * @returns {{ dir: string, rev: number, name: string } | null}
 */
export function studyLinkState(projectDirPath, simId) {
  if (!projectDirPath || !simId) return null;
  let s;
  try {
    s = findStudy(projectDirPath, String(simId));
  } catch {
    return null;
  }
  if (!s || !s.geometry_dir) return null;
  const state = readJsonFile(join(String(s.geometry_dir), 'link', 'state.json'));
  const rev = state && Number(state.rev);
  if (!state || !Number.isSafeInteger(rev) || rev < 1) return null;
  return { dir: String(s.geometry_dir), rev, name: String(state.name || s.geometry_id || 'the geometry') };
}

/**
 * Check a save of face-carrying records of one study.
 *
 * `sentRev` is the top-level `geometry_rev` the request carries (the client's census
 * helper sends it); without it each record's own `geometry_rev` must be the current rev.
 * Answers `{ok: true, rev}` (rev null: not a linked geometry, write as before) or
 * `{ok: false, status, body, headers?}` to send as is.
 * @param {string} projectDirPath @param {string | null | undefined} simId
 * @param {any[]} records @param {any} [sentRev]
 */
export function checkRecordSave(projectDirPath, simId, records, sentRev) {
  const link = studyLinkState(projectDirPath, simId);
  if (!link) return { ok: true, rev: null };
  if (geometryFenced(link.dir)) return updatingAnswer(link.name);
  const given = sentRev === undefined || sentRev === null || sentRev === '' ? null : Number(sentRev);
  if (given !== null) {
    if (given !== link.rev) return changedAnswer(link.name);
    return { ok: true, rev: link.rev };
  }
  for (const rec of records || []) {
    if (!rec || typeof rec !== 'object') continue;
    const stamp = rec.geometry_rev;
    if (typeof stamp !== 'number' || stamp !== link.rev) return changedAnswer(link.name);
  }
  return { ok: true, rev: link.rev };
}

/** @param {string} name */
export function updatingAnswer(name) {
  return {
    ok: false,
    status: 503,
    headers: { 'Retry-After': '2' },
    body: { ok: false, code: 'geometry_updating', error: LINK_STAMP_TEXT.updating(name) },
  };
}

/** @param {string} name */
export function changedAnswer(name) {
  return { ok: false, status: 409, body: { ok: false, code: 'geometry_changed', error: LINK_STAMP_TEXT.changed(name) } };
}

/**
 * A refusal the Python writer answered (its stamp check runs again there): the same
 * 409 or 503, or null for any other error.
 * @param {any} err
 */
export function stampRefusalOf(err) {
  const code = err && (err.code === -32010 || err.code === -32011) ? err.code : null;
  const dataCode = err && err.data && typeof err.data.code === 'string' ? err.data.code : '';
  const message = String((err && err.message) || '');
  if (code === -32010 || dataCode === 'geometry_changed') {
    return { ok: false, status: 409, body: { ok: false, code: 'geometry_changed', error: message } };
  }
  if (code === -32011 || dataCode === 'geometry_updating') {
    return { ok: false, status: 503, headers: { 'Retry-After': '2' }, body: { ok: false, code: 'geometry_updating', error: message } };
  }
  return null;
}

export { keepLinkKeys };
