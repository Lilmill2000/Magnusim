/**
 * The run panel's Cores choice: Auto (the core picks: one core for a small mesh,
 * else one per physical core) or a number from 1 up to what this PC gives a run
 * (the server's own cap, /api/prefs rank_cap). Saved on the run; locked once it
 * has started. Shown only for runs whose solver can run on more than one core.
 */
import { useEffect, useState } from 'react';
import { apiGet } from '../../api/client';
import type { RegistryDescribe, RegistryRow } from '../../api/registry.gen';
import type { RunState } from '../legacyBridge';

function capOf(prefs: Record<string, unknown> | null | undefined): number | null {
  const n = Math.floor(Number(prefs && prefs.rank_cap));
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/** The most cores a run gets on this PC (the runner's own cap), null until the server says. */
export function useRankCap(): number | null {
  const [cap, setCap] = useState<number | null>(() => capOf(window.__CFD_PREFS__));
  useEffect(() => {
    let live = true;
    // Asked each time the panel opens: Settings → Hardware can change it.
    apiGet<Record<string, unknown>>('/api/prefs')
      .then((j) => {
        const n = capOf(j);
        if (live && n != null) setCap(n);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return cap;
}

/**
 * Whether a run can use more than one core: its launch says so once it has
 * started; before that its analysis's solver does (mpirun). Unknown: true.
 */
export function runCanUseCores(
  state: Pick<RunState, 'launch_parallel'>,
  registry: RegistryDescribe | null | undefined,
  row: RegistryRow | undefined,
): boolean {
  if (typeof state.launch_parallel === 'boolean') return state.launch_parallel;
  const key = row?.default_solver;
  const solver = key ? (registry?.solver || []).find((r) => r.key === key) : undefined;
  if (!solver) return true;
  return String((solver as unknown as { parallel?: unknown }).parallel || '') === 'mpirun';
}

function coresText(n: number): string {
  return n === 1 ? '1 core' : `${n} cores`;
}

export function RunCores({
  cores,
  locked,
  cap,
  onSave,
}: {
  /** The run's setting: a whole number, or null for Auto. */
  cores: number | null;
  locked: boolean;
  /** The most cores this PC gives a run (null while unknown). */
  cap: number | null;
  onSave: (cores: number | null) => void;
}) {
  const value = cores == null ? 'auto' : String(cores);
  if (locked) {
    return (
      <div className="mat-row" data-run-cores="1">
        <span className="mat-k">Cores</span>
        <span className="mat-v" data-run-cores-value="1">
          {cores == null ? 'Auto' : String(cores)}
        </span>
      </div>
    );
  }
  const counts: number[] = [];
  for (let n = 1; n <= (cap || 0); n++) counts.push(n);
  const over = cores != null && (cap == null || cores > cap);
  return (
    <>
      <div className="mat-row" data-run-cores="1">
        <span
          className="mat-k"
          title="How many processor cores the solve runs on. Auto runs a small mesh on one core and a larger one on every core this PC gives a run."
        >
          Cores
        </span>
        <select
          className="bc-select"
          aria-label="Cores"
          value={value}
          onChange={(e) => onSave(e.target.value === 'auto' ? null : Number(e.target.value))}
        >
          <option value="auto">Auto</option>
          {counts.map((n) => (
            <option key={n} value={String(n)}>
              {String(n)}
            </option>
          ))}
          {over ? (
            <option value={String(cores)}>{cap == null ? String(cores) : `${cores} (this PC gives ${cap})`}</option>
          ) : null}
        </select>
      </div>
      <p className="mat-assign-hint" data-run-cores-hint="1">
        {cores == null
          ? cap != null
            ? `Auto: a small mesh runs on 1 core, a larger one on ${coresText(cap)}.`
            : 'Auto: a small mesh runs on 1 core, a larger one on every core this PC gives a run.'
          : cores === 1
            ? 'Runs on 1 core.'
            : over && cap != null
              ? `Runs on ${coresText(cap)}: the most this PC gives a run.`
              : `Runs on ${coresText(cores)}, whatever the mesh size.`}
      </p>
    </>
  );
}
