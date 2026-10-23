/**
 * A record's revision (`rev`), so a save made from an older copy is refused rather than
 * written over a newer one (Assistant phase 5, C2).
 *
 * Every record the Assistant can write carries an integer `rev`: BCs, materials, result
 * controls and refinements (persistChildItem), meshes (the mesh settings save) and runs (the
 * run settings save). A write that changes the record sets `rev` to the stored rev + 1; a
 * write that changes nothing keeps it, so a save of the same values never refuses a panel
 * that holds them. Writers that only report on a record (a mesh's generate, a run's status)
 * keep the stored rev.
 *
 * A save may carry `base_rev` on the record: the rev the caller read. When it is not the
 * stored rev the save is refused (StaleRecord, answered 409 `stale_record`). A save without
 * it is written as before, so older pages and plugin callers keep working. `base_rev` is
 * never stored.
 *
 * Python's writers (cfddesk/project/paths.py persist_child_item, web_writes.py) follow the
 * same rules; their refusal is the worker's -32012, which routes.ts answers the same 409.
 */

export const STALE_RECORD_TEXT = 'This was changed elsewhere.';

/** Keys that are not the record's content: a write that changes only these changes nothing. */
const NOT_CONTENT = new Set(['rev', 'base_rev', 'updated_at', 'dir', 'folder']);

export class StaleRecord extends Error {
  /**
   * @param {string} kind the record kind ('bc', 'material', 'refinement', 'rc', 'mesh', 'run', 'bc_defaults')
   * @param {string} id
   * @param {number} rev the stored rev
   */
  constructor(kind, id, rev) {
    super(STALE_RECORD_TEXT);
    this.name = 'StaleRecord';
    this.code = 'stale_record';
    this.status = 409;
    this.kind = kind;
    this.id = id;
    this.rev = rev;
  }
}

/** The 409 answer of a refused save. */
export function staleBody(err) {
  return { ok: false, code: 'stale_record', kind: err.kind, id: err.id, rev: err.rev, error: STALE_RECORD_TEXT };
}

/** A route's answer for a refused save ({ok:false, status, body}), as the w* handlers return them. */
export function staleAnswer(err) {
  return { ok: false, status: 409, body: staleBody(err) };
}

/** A stored record's rev (0 when it has none: written before revs, or not there). */
export function recordRev(rec) {
  const n = rec && typeof rec === 'object' ? rec.rev : undefined;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** The rev a save says it read (`base_rev`, a whole number), or null when it says none. */
export function baseRevOf(rec) {
  const n = rec && typeof rec === 'object' ? rec.base_rev : undefined;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Throws StaleRecord when `base` is given and is not the stored rev. */
export function checkBaseRev(kind, id, stored, base) {
  if (base === null || base === undefined) return;
  const rev = recordRev(stored);
  if (base !== rev) throw new StaleRecord(kind, String(id || ''), rev);
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

/** The record's content, for "did this write change it": every key but rev, base_rev, updated_at and `ignore`. */
function content(rec, ignore) {
  const out = {};
  for (const [k, v] of Object.entries(rec || {})) if (!NOT_CONTENT.has(k) && !(ignore && ignore.includes(k))) out[k] = v;
  return JSON.stringify(canonical(out));
}

/** True when `next` holds what `onDisk` holds (rev, base_rev, updated_at and the `ignore` keys aside). */
export function sameContent(next, onDisk, ignore) {
  return !!onDisk && content(next, ignore) === content(onDisk, ignore);
}

/**
 * Stamp a record about to be written (changed in place): `rev` is the stored rev + 1 when
 * its content changed (1 for a new record), else the stored rev; `base_rev` is dropped.
 * `bump: false` (a writer that only reports, a mesh's generate or a run's status) keeps the
 * stored rev whatever changed. `ignore`: keys that are not settings (a run's live filter set,
 * `current_view`, which the results view saves as the person looks around).
 * @param {Record<string, any>} bound
 * @param {Record<string, any> | null} onDisk
 * @param {{ bump?: boolean, ignore?: string[] }} [opts]
 */
export function stampRev(bound, onDisk, opts = {}) {
  delete bound.base_rev;
  const prev = recordRev(onDisk);
  if (opts.bump === false) {
    if (prev > 0) bound.rev = prev;
    else delete bound.rev;
    return bound;
  }
  bound.rev = onDisk && sameContent(bound, onDisk, opts.ignore) && prev > 0 ? prev : prev + 1;
  return bound;
}

/**
 * The first stale record of a save, or null: each sent record with `base_rev` against the
 * stored one of the same id in `stored` (a record that is gone has rev 0). Records without
 * an id or without `base_rev` are not checked.
 * @param {string} kind
 * @param {Array<Record<string, any>>} stored
 * @param {Array<Record<string, any>>} sent
 */
export function firstStale(kind, stored, sent) {
  const byId = new Map((stored || []).filter((r) => r && r.id != null).map((r) => [String(r.id), r]));
  for (const rec of sent || []) {
    const base = baseRevOf(rec);
    if (base === null || !rec || rec.id == null || rec.id === '') continue;
    const have = byId.get(String(rec.id)) || null;
    const rev = recordRev(have);
    if (base !== rev) return new StaleRecord(kind, String(rec.id), rev);
  }
  return null;
}
