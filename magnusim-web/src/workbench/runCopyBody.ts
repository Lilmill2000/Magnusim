/**
 * The body of "Copy settings from" for a run (POST /api/run/update), shared by the run
 * panel (runtime.js copyRunSettingsFrom) and the Assistant's setup_edit {kind:'run',
 * action:'copy_from'}, so both copy the same way. Pure: the caller reads its own state.
 *
 * A run of another study keeps its mesh and monitors (they are that study's, maybe another
 * geometry's); only the time settings come across. Cores is the PC's, not the study's: it
 * comes across from any run. Its "Stop when settled" follows its monitor (carrySettle,
 * passed in: the server imports this file as it is, so it has no import of its own).
 */

export interface RunLike {
  id?: unknown;
  run_id?: unknown;
  simulation_id?: unknown;
  mesh_id?: unknown;
  endTime?: unknown;
  writeInterval?: unknown;
  time_dependency?: unknown;
  result_controls?: unknown;
  settle?: unknown;
  [k: string]: unknown;
}

export interface RunCopyInput {
  src: RunLike;
  dest: RunLike;
  /** The destination's study (the one shown). */
  studyId: string;
  /** endTime and writeInterval when the source has none (the run panel's). */
  fallback: { endTime?: unknown; writeInterval?: unknown };
  /** Copying inside Add run: the new run follows the study's time dependency. */
  insideCreate: boolean;
  /** The study is transient (insideCreate). */
  studyTransient: boolean;
  /** The source run solves transient (runRecIsTransient). */
  srcTransient: boolean;
  /** The source's transient block over its analysis's defaults (transientSettingsFor). */
  transient: Record<string, unknown>;
  /** The source's cores (null: Auto). */
  cores: number | null;
  /** The ids of the study's BCs that have faces (a settle on a boundary follows only to those). */
  studyBcIds: readonly string[];
  /** A new result control id (rc-…). */
  newRcId: () => string;
  /** runSettle.ts carrySettle (its shape here: this file imports nothing). */
  carry: (
    src: RunLike,
    opts: { copiedControls: ReadonlyArray<{ id?: unknown }>; otherStudy: boolean; srcTransient: boolean; destTransient: boolean; studyBcIds: readonly string[] },
  ) => { settle: Record<string, unknown> | null; note: string };
}

export interface RunCopy {
  body: Record<string, unknown>;
  otherStudy: boolean;
  /** Why "Stop when settled" did not come across, or ''. */
  note: string;
}

/** A run's result controls as a copy saves them: new ids, no results. */
export function cloneResultControls(src: unknown, newRcId: () => string): Record<string, unknown>[] {
  return (Array.isArray(src) ? src : []).map((rc) => ({
    ...(rc && typeof rc === 'object' ? (rc as Record<string, unknown>) : {}),
    id: newRcId(),
    results: null,
    series: null,
    chart_values: null,
    results_available: false,
  }));
}

export function runCopyBody(i: RunCopyInput): RunCopy {
  const { src, dest } = i;
  const otherStudy = !!(src.simulation_id && i.studyId && String(src.simulation_id) !== String(i.studyId));
  const timeDependency = i.insideCreate
    ? i.studyTransient
      ? 'Transient'
      : 'Steady-state'
    : String(src.time_dependency || '') || (i.srcTransient ? 'Transient' : 'Steady-state');
  const resultControls = otherStudy ? (Array.isArray(dest.result_controls) ? dest.result_controls : []) : cloneResultControls(src.result_controls, i.newRcId);
  const body: Record<string, unknown> = {
    run_id: dest.id,
    mesh_id: otherStudy ? dest.mesh_id || '' : src.mesh_id || '',
    endTime: src.endTime != null ? src.endTime : i.fallback.endTime,
    writeInterval: src.writeInterval != null ? src.writeInterval : i.fallback.writeInterval,
    time_dependency: timeDependency,
    transient: i.transient,
    result_controls: resultControls,
    cores: i.cores,
  };
  const destTransient = /transient/i.test(timeDependency);
  const carried = i.carry(src, {
    copiedControls: resultControls as Array<{ id?: unknown }>,
    otherStudy,
    srcTransient: i.srcTransient,
    destTransient,
    studyBcIds: i.studyBcIds,
  });
  body.settle = carried.settle;
  body.settle_time_dependency = destTransient ? 'Transient' : 'Steady-state';
  return { body, otherStudy, note: carried.note };
}
