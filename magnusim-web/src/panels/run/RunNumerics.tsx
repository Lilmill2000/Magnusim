/**
 * RH3: the Run panel's "Numerics as written" (spec 5.5): what the run's case is written with, a
 * read-only disclosure under "Before you start". Its analysis builds the rows from the values its
 * writer uses (RunModel.check's `numerics`: the schemes, linear solvers, relaxation or PIMPLE
 * outer loops, the velocity limit with its numbers, and what stays fixed), each with where it
 * comes from (set in the study, on the run, the Numerics preset, the default). A draft shows its
 * study's numerics; a started run shows what it started with (its `numerics_used`) once it has
 * one. The Assistant reads the same rows (read_setup {what:'numerics'}, parity row R35).
 */
import type { RunNumericsRow, RunState } from '../legacyBridge';

const SOURCE: Readonly<Record<string, string>> = Object.freeze({
  study: 'set in the study',
  run: 'set on the run',
  default: 'default',
});

/** "Robust preset", "set in the study", or ''. */
export function sourceWords(row: RunNumericsRow, preset: string): string {
  if (row.source === 'preset') return preset ? `${preset} preset` : 'the preset';
  return SOURCE[row.source] || '';
}

/** The rows by group, in the order they come. */
export function groupRows(rows: readonly RunNumericsRow[]): Array<[string, RunNumericsRow[]]> {
  const out: Array<[string, RunNumericsRow[]]> = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last[0] === r.group) last[1].push(r);
    else out.push([r.group, [r]]);
  }
  return out;
}

export function RunNumerics({ state }: { state: RunState }) {
  const rows = Array.isArray(state.numerics) ? state.numerics : [];
  if (!rows.length) return null;
  const record = (state.study || {}) as Record<string, unknown>;
  const p = String(record.numerics_preset || '');
  const preset = p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Robust';
  return (
    <details className="mesh-advanced run-numerics" data-run-numerics="1">
      <summary>Numerics as written</summary>
      {groupRows(rows).map(([group, list]) => (
        <div key={group} data-run-numerics-group={group}>
          <p className="run-numerics-group">{group}</p>
          {list.map((r) => {
            const from = sourceWords(r, preset);
            return (
              <div className="mat-row" key={`${group}/${r.label}`} data-run-numerics-row={r.label}>
                <span className="mat-k">{r.label}</span>
                <span className="mat-v">
                  <span className="run-numerics-value">{r.value}</span>
                  {from ? <span className="run-numerics-source">{` (${from})`}</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </details>
  );
}
