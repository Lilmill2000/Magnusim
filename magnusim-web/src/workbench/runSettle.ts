/**
 * A run's "Stop when a monitor settles" (API 1.4, the run record's `settle`) carried to
 * another run by "Copy from previous run" and "Add run" (copyRunSettingsFrom).
 *
 * The stop names a monitor by its result control's id (`source: 'monitor'`) or a
 * boundary condition by its id (`source: 'boundary'`). A copy gets new monitor ids
 * (the source's result controls, cloned in order: the same place in the list), so the
 * stop follows its monitor there. It is left off, with a note, when what it watched
 * does not come across: a monitor of another study (they stay with it), a monitor or
 * boundary that is gone, or a run of the other time dependency (its window is in
 * iterations for a steady run, seconds for a transient one).
 */

type RcLike = { id?: unknown } | null | undefined;

export interface SettleCopy {
  /** The stop the copy gets (null: off). */
  settle: Record<string, unknown> | null;
  /** Why the source's stop is off on the copy ('' when it came across or there was none). */
  note: string;
}

export function carrySettle(
  src: { settle?: unknown; result_controls?: unknown } | null | undefined,
  opts: {
    /** The copy's result controls, cloned from the source's in order (another study: its own). */
    copiedControls: readonly RcLike[];
    /** The source run is of another study. */
    otherStudy: boolean;
    /** The source run and the copy are transient. */
    srcTransient: boolean;
    destTransient: boolean;
    /** The ids of the copy's study's boundary conditions that have faces. */
    studyBcIds: readonly string[];
  },
): SettleCopy {
  const s = src && src.settle && typeof src.settle === 'object' ? (src.settle as Record<string, unknown>) : null;
  if (!s || !s.id) return { settle: null, note: '' };
  const off = (why: string): SettleCopy => ({ settle: null, note: `Its "Stop when settled" is off here: ${why}.` });
  if (opts.srcTransient !== opts.destTransient) {
    return off(`it was set for a ${opts.srcTransient ? 'transient' : 'steady'} run`);
  }
  const id = String(s.id);
  if (s.source === 'boundary') {
    return opts.studyBcIds.includes(id) ? { settle: { ...s }, note: '' } : off('the boundary it watched is not in this study');
  }
  if (opts.otherStudy) return off('the monitor it watched stays with the other study');
  const srcControls = Array.isArray(src && src.result_controls) ? (src!.result_controls as RcLike[]) : [];
  const at = srcControls.findIndex((rc) => !!rc && String(rc.id) === id);
  const copied = at >= 0 ? opts.copiedControls[at] : null;
  if (!copied || !copied.id) return off('the monitor it watched is gone');
  return { settle: { ...s, id: String(copied.id) }, note: '' };
}
