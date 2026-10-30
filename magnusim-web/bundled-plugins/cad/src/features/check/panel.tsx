// Check (proposal §2.11), INSPECT's tool panel, in four modes:
//   Solids        BRepCheck of the selected bodies (or every shown body), each "Valid" or its
//                 problems by kind with where they are; it runs again after every rebuild;
//   Interference  the pairs of the selected bodies (or every shown body; one selected body against
//                 every other shown body) that overlap, with the volume they share (a press fit,
//                 a bore drawn under its shaft, apart), and with a clearance the pairs closer than it;
//   Loose parts   each axis bodies share (with bodies selected, the axes near them): its parts in
//                 order, what holds each radially and along it, and what can slide or has nothing
//                 in its bore (the play typed, 0.5 mm when empty);
//   Rotation      a body (or the selected bodies) turned a full turn about an axis round faces lie
//                 on, X, Y, Z or a construction axis: the first angle it meets each other body,
//                 counter-clockwise about the axis's direction (named in the table) and clockwise.
// A check the time limit stopped says so in its line and under it, with what helps (the tool's note).
// The last three are the Assistant's check tool (src/assistant/tools/check.ts) on the same engine
// (src/features/assembly), run when the person presses Check: its line of text is the tool's own,
// its rows click to select their bodies (Ctrl adds) and light them on hover, a long check shows its
// progress and Stop, and a result the Part has changed under says so. A tool panel: nothing is
// saved or undoable.
// Owner: P2-FEATURES (Solids); ASSISTANT (the assembly modes, the person's side of check).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { AppServices } from '../../types/app';
import type { BodyId } from '../../types/doc';
import type { BodyInfo } from '../../types/kernel';
import type { KernelResult } from '../../types/kernel-protocol';
import type { ToolPanelProps } from '../../types/modules';
import type { SelectionItem } from '../../types/selection';
import type { DocUnits } from '../../types/units';
import { Button, DisabledReason, Field, Hint, PanelChrome, Select } from '../../ui/kit';
import { formatQuantity, formatReadout, formatVolume, MM_PER } from '../../ui/kit/format';
import { timeoutForFaces } from '../../kernel/timeouts';
import { selectedBodies } from '../../ui/tree/model';
import { axisWords, PLAY_MM, sideWords as directionWords, type CheckEnv, type InterferenceResult, type SharedAxis, type StackResult, type StackSide, type SweepResult } from '../assembly/check';
import { axesNow, lengthIn, referenceAxes, referenceAxis, runAssembly, type AssemblyKind, type AssemblyOutcome, type AssemblyRequest } from './assembly';
import { CHECK_MODE_LABELS, CHECK_MODES, type CheckMode } from './controls';
import './check.css';

type CheckOut = KernelResult<'check'>;

/** "NotClosed ×1, UnorientableShape ×2" (most first). */
export function countsWords(counts: Record<string, number> | undefined): string {
  if (!counts) return '';
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ×${n}`)
    .join(', ');
}

function problemCount(r: CheckOut): string {
  const n = r.problem_total ?? r.problems?.length ?? 0;
  return n === 1 ? '1 problem' : `${n} problems`;
}

/** The mode the panel opens in: the last one used while the page is open. */
let lastMode: CheckMode = 'solids';

export function CheckPanel({ close }: ToolPanelProps) {
  const services = useServices();
  const [mode, setModeNow] = useState<CheckMode>(lastMode);
  const runs = useAssemblyRuns(services);
  const setMode = (m: CheckMode) => {
    lastMode = m;
    setModeNow(m);
  };
  const [solidsError, setSolidsError] = useState<string | null>(null);
  const foot = mode === 'solids' && solidsError ? [<DisabledReason key="error">{solidsError}</DisabledReason>] : null;
  return (
    <PanelChrome panel="tool" title="Check" onDone={close} foot={foot}>
      <div data-tool-panel="inspect.check" data-check-mode={mode}>
        <div className="cad-check-modes" role="radiogroup" aria-label="What to check">
          {CHECK_MODES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={m === mode} className={m === mode ? 'is-on' : undefined} data-check-mode-button={m} onClick={() => setMode(m)}>
              {CHECK_MODE_LABELS[m]}
            </button>
          ))}
        </div>
        {mode === 'solids' ? <SolidsCheck onError={setSolidsError} /> : <AssemblyCheck kind={mode} runs={runs} />}
      </div>
    </PanelChrome>
  );
}

// ------------------------------------------------------------------ Solids (BRepCheck)

function SolidsCheck({ onError }: { onError(e: string | null): void }) {
  const services = useServices();
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const sel = useStateStore(services.selection);
  const picked = selectedBodies(sel);
  const chosen = bodies.filter((b) => picked.has(b.id));
  const list = chosen.length ? chosen : bodies.filter((b) => b.visible);
  const key = list.map((b) => `${b.id}|${b.tessKey}`).join(',');
  const [out, setOut] = useState<Record<BodyId, CheckOut>>({});
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState(0);

  useEffect(() => {
    let live = true;
    setOut({});
    onError(null);
    setBusy(true);
    void (async () => {
      const res: Record<BodyId, CheckOut> = {};
      try {
        for (const b of list) {
          const timeoutMs = timeoutForFaces('check', b.faces);
          res[b.id] = (await services.kernel.call('check', { id: b.shape, max_problems: 40 }, timeoutMs ? { timeoutMs } : {})).result;
          if (!live) return;
          setOut({ ...res });
        }
      } catch (err) {
        if (live) onError(`Check failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, key, again]);

  const bad = list.filter((b) => out[b.id] && !out[b.id].valid).length;
  return (
    <>
      <div className="cad-p2-sub" data-check-summary="1">
        {!list.length ? 'No body is shown' : busy ? `Checking ${list.length === 1 ? list[0].name : `${list.length} bodies`}…` : bad ? `${bad} of ${list.length} ${list.length === 1 ? 'body is' : 'bodies are'} not valid` : list.length === 1 ? `${list[0].name} is valid` : `All ${list.length} bodies are valid`}
      </div>
      <table className="cad-p2-table" data-check-bodies="1">
        <tbody>
          {list.map((b) => {
            const r = out[b.id];
            return (
              <tr key={b.id} data-check-body={b.id} data-valid={r ? (r.valid ? '1' : '0') : undefined}>
                <td>{b.name}</td>
                <td className={r ? (r.valid ? 'cad-p2-ok' : 'cad-p2-bad') : ''} data-check-state={b.id}>
                  {!r ? 'Checking…' : r.valid ? 'Valid' : `${problemCount(r)}: ${countsWords(r.problem_counts)}`}
                  {r && !r.valid && r.problems?.length ? (
                    <ul className="cad-p2-problems">
                      {r.problems.map((p, i) => (
                        <li key={i}>
                          {p.status} · {p.type} {p.index + 1}
                          {p.in ? ` of ${p.in.type} ${p.in.index + 1}` : ''}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="cad-p2-actions">
        <Button variant="secondary" data-check-again="1" disabledReason={busy ? 'Checking now' : null} onClick={() => setAgain((n) => n + 1)}>
          Check again
        </Button>
      </div>
      <Hint>The geometry kernel's own check (BRepCheck): open shells, bad orientation, self-intersections, tolerance gaps.</Hint>
    </>
  );
}

// ------------------------------------------------------------------ the assembly checks: runs

interface Job {
  kind: AssemblyKind;
  fraction: number | null;
  label: string;
  ac: AbortController;
}

type Shown = { outcome: AssemblyOutcome } | { error: string } | { stopped: true };

interface Fields {
  clearance: string;
  play: string;
  turning: string;
  axis: string;
}

interface Runs {
  job: Job | null;
  shown: Partial<Record<AssemblyKind, Shown>>;
  /** What each mode's fields hold (kept while the panel is open). */
  fields: Fields;
  setField(k: keyof Fields, v: string): void;
  run(kind: AssemblyKind, make: () => Promise<AssemblyRequest>): void;
  stop(): void;
}

/** One check at a time, its progress and Stop, and each mode's last result; closing the panel stops it. */
function useAssemblyRuns(services: AppServices): Runs {
  const [job, setJob] = useState<Job | null>(null);
  const [shown, setShown] = useState<Partial<Record<AssemblyKind, Shown>>>({});
  const [fields, setFields] = useState<Fields>({ clearance: '', play: '', turning: '', axis: '' });
  const current = useRef<Job | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      current.current?.ac.abort(new DOMException('The Check panel closed.', 'AbortError'));
    };
  }, []);
  const run = (kind: AssemblyKind, make: () => Promise<AssemblyRequest>) => {
    if (current.current) return;
    const ac = new AbortController();
    const first: Job = { kind, fraction: null, label: 'Waiting for the rebuild', ac };
    current.current = first;
    setJob(first);
    const env: CheckEnv = {
      kernel: services.kernel,
      signal: ac.signal,
      progress: (fraction, label) => {
        if (live.current && current.current?.ac === ac) setJob({ kind, fraction, label, ac });
      },
    };
    void (async () => {
      let out: Shown;
      try {
        out = { outcome: await runAssembly(services, await make(), env) };
      } catch (e) {
        out = ac.signal.aborted ? { stopped: true } : { error: e instanceof Error ? e.message.replace(/^[a-z_]+: /, '') : String(e) };
      }
      if (current.current?.ac === ac) current.current = null;
      if (!live.current) return;
      setJob(null);
      setShown((m) => ({ ...m, [kind]: out }));
    })();
  };
  return {
    job,
    shown,
    fields,
    setField: (k, v) => setFields((f) => ({ ...f, [k]: v })),
    run,
    stop: () => current.current?.ac.abort(new DOMException('Stopped', 'AbortError')),
  };
}

/** The axes round faces lie on, found again after each rebuild while Rotation is shown. */
function useAxes(services: AppServices, on: boolean): { axes: SharedAxis[] | null; busy: boolean; error: string | null } {
  const seq = useStateStore(services.doc.state, (s) => s.rebuild.seq);
  const [got, setGot] = useState<{ seq: number; axes: SharedAxis[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    const ac = new AbortController();
    setError(null);
    axesNow(services, { kernel: services.kernel, signal: ac.signal }).then(
      (r) => {
        if (!ac.signal.aborted) setGot(r);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setError(`The axes could not be found: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
    return () => ac.abort(new DOMException('Stopped', 'AbortError'));
  }, [services, on, seq]);
  return { axes: got?.axes ?? null, busy: on && got?.seq !== seq && !error, error };
}

// ------------------------------------------------------------------ the assembly checks: the panel

const KIND_WORDS: Readonly<Record<AssemblyKind, string>> = {
  interference: 'Which bodies overlap, and by how much.',
  stack: 'Whether each part on a shaft is held: radially by its shaft or bore, and along it on both sides.',
  sweep: 'What a part meets when it turns a full turn about an axis, each way.',
};

type RowProps = (names: readonly string[]) => HTMLAttributes<HTMLElement>;

/** A point in the document's unit: "(10, 0, 5) mm". */
function pointWords(p: readonly number[], units: DocUnits): string {
  return `(${p.map((x) => formatReadout(x / MM_PER[units.length])).join(', ')}) ${units.length}`;
}

function AssemblyCheck({ kind, runs }: { kind: AssemblyKind; runs: Runs }) {
  const services = useServices();
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const seq = useStateStore(services.doc.state, (s) => s.rebuild.seq);
  const units = useStateStore(services.doc.state, (s) => s.doc.units);
  const sel = useStateStore(services.selection);
  const handle = useStateStore(services.viewport, (s) => s.handle);
  const axes = useAxes(services, kind === 'sweep');
  useEffect(() => () => handle?.flash([]), [handle]);

  const picked = selectedBodies(sel);
  const chosen = bodies.filter((b) => picked.has(b.id));
  const solids = bodies.filter((b) => b.solids !== 0);
  const { fields, job } = runs;
  const shown = runs.shown[kind] ?? null;

  /** The bodies a row names, as selection items (a body renamed or gone since is left out). */
  const itemsOf = (names: readonly string[]): SelectionItem[] => {
    const now = services.doc.state.get().rebuild.bodies;
    return names.map((n) => now.find((b) => b.name === n)).filter((b): b is BodyInfo => !!b).map((b) => ({ kind: 'body', body: b.id }));
  };
  const rowProps: RowProps = (names) => ({
    className: 'cad-check-row',
    onClick: (e) => {
      const items = itemsOf(names);
      if (!(e.ctrlKey || e.metaKey)) services.selection.set((s) => ({ ...s, items }));
      else {
        const have = new Set(services.selection.get().items.map((it) => JSON.stringify(it)));
        services.selection.set((s) => ({ ...s, items: [...s.items, ...items.filter((it) => !have.has(JSON.stringify(it)))] }));
      }
    },
    onMouseEnter: () => handle?.flash(itemsOf(names)),
    onMouseLeave: () => handle?.flash([]),
  });

  // What this mode checks, its fields, and why it cannot run yet.
  let scopeWords = '';
  let reason: string | null = null;
  let start: (() => void) | null = null;
  let form: ReactNode = null;
  if (kind === 'interference') {
    // One selected body: it against every other shown body (as the check tool's one body).
    const one = chosen.length === 1 ? chosen[0] : null;
    const shown = bodies.filter((b) => b.visible || b === one);
    const scope = one ? shown : chosen.length ? chosen : shown;
    scopeWords = one ? `Checks ${one.name} against every other shown body (${scope.length - 1})` : chosen.length ? `Checks the ${chosen.length} selected bodies` : `Checks every shown body (${scope.length})`;
    const c = lengthIn(services, fields.clearance, units, 0);
    if (scope.length < 2) reason = one ? 'Show another body to check it against' : 'Show two bodies or more';
    else if ('error' in c) reason = `Clearance: ${c.error}`;
    else start = () => runs.run('interference', async () => ({ kind: 'interference', bodies: scope.map((b) => b.id), clearance: c.value, one: one?.id ?? null }));
    form = (
      <Field label="Clearance" field="clearance" help="Also list the pairs closer than this">
        <input className="mgk-input cad-check-length" aria-label="Clearance" placeholder="none" spellCheck={false} data-check-clearance="1" value={fields.clearance} onChange={(e) => runs.setField('clearance', e.target.value)} />
      </Field>
    );
  } else if (kind === 'stack') {
    scopeWords = chosen.length ? `Checks the axes near the ${chosen.length === 1 ? 'selected body' : `${chosen.length} selected bodies`}, and lists ${chosen.length === 1 ? 'its' : 'their'} findings` : 'Checks every body on a shared axis';
    const p = lengthIn(services, fields.play, units, PLAY_MM);
    if (!bodies.length) reason = 'No body yet';
    else if ('error' in p) reason = `Play: ${p.error}`;
    else start = () => runs.run('stack', async () => ({ kind: 'stack', only: chosen.length ? chosen.map((b) => b.id) : null, play: p.value }));
    form = (
      <Field label="Play" field="play" help="The radial and axial play still counted as held">
        <input className="mgk-input cad-check-length" aria-label="Play" placeholder={formatQuantity(PLAY_MM, 'length', units)} spellCheck={false} data-check-play="1" value={fields.play} onChange={(e) => runs.setField('play', e.target.value)} />
      </Field>
    );
  } else {
    // Turning: one body, or the selected bodies together.
    const several = chosen.filter((b) => b.solids !== 0);
    const turnOptions = [...(several.length >= 2 ? [{ value: 'selected', label: `The ${several.length} selected bodies (${several.map((b) => b.name).join(', ')})` }] : []), ...solids.map((b) => ({ value: `body:${b.id}`, label: b.name }))];
    const fallback = several.length >= 2 ? 'selected' : several.length === 1 ? `body:${several[0].id}` : solids.length ? `body:${solids[0].id}` : '';
    const turningValue = turnOptions.some((o) => o.value === fields.turning) ? fields.turning : fallback;
    const turning = turningValue === 'selected' ? several : solids.filter((b) => `body:${b.id}` === turningValue);
    const turningIdx = turning.map((b) => bodies.indexOf(b));
    // Axes: the lines round faces of every turning body lie on (shared ones first), then the reference axes.
    const found = (axes.axes ?? []).map((a, i) => ({ a, i })).filter(({ a }) => turningIdx.length > 0 && turningIdx.every((t) => a.members.includes(t)));
    found.sort((p, q) => (q.a.members.length >= 2 ? 1 : 0) - (p.a.members.length >= 2 ? 1 : 0) || p.i - q.i);
    const axisOptions = [
      ...found.map(({ a, i }) => ({ value: `found:${i}`, label: `${axisWords(a.line)}: ${a.members.length >= 2 ? `shared with ${a.members.filter((m) => !turningIdx.includes(m)).map((m) => bodies[m]?.name ?? '').join(', ')}` : 'its own round faces'}` })),
      ...referenceAxes(services).map((r) => ({ value: `ref:${r}`, label: r })),
    ];
    const axisValue = axisOptions.some((o) => o.value === fields.axis) ? fields.axis : (axisOptions[0]?.value ?? '');
    if (!turning.length) reason = 'No solid body to turn';
    else if (axes.busy && !axisOptions.some((o) => o.value === fields.axis)) reason = 'Finding the axes';
    else {
      const line = axisValue.startsWith('found:') ? (axes.axes?.[Number(axisValue.slice(6))]?.line ?? null) : null;
      const ids = turning.map((b) => b.id);
      const ref = axisValue.slice(4);
      start = () => {
        // The choices it ran with stay chosen (a row's click selects bodies, which would move the defaults).
        runs.setField('turning', turningValue);
        runs.setField('axis', axisValue);
        runs.run('sweep', async () => ({ kind: 'sweep', turning: ids, axis: line ? { line, words: '' } : await referenceAxis(services, ref) }));
      };
    }
    form = (
      <>
        <Field label="Turning" field="turning">
          <Select label="Turning" field="turning" attrs={{ 'data-check-turning': '1' }} value={turningValue} options={turnOptions} onChange={(v) => runs.setField('turning', v)} />
        </Field>
        <Field label="Axis" field="axis">
          <Select label="Axis" field="axis" attrs={{ 'data-check-axis-pick': '1' }} value={axisValue} options={axisOptions} onChange={(v) => runs.setField('axis', v)} />
        </Field>
        {axes.busy ? <Hint>Finding the axes round faces lie on…</Hint> : null}
        {axes.error ? <Hint tone="warning">{axes.error}</Hint> : null}
      </>
    );
  }
  if (job && !reason) {
    reason = job.kind === kind ? 'Checking now' : `${CHECK_MODE_LABELS[job.kind]} is checking now`;
    start = null;
  }

  return (
    <div data-check-kind={kind}>
      <div className="cad-p2-sub">{KIND_WORDS[kind]}</div>
      {scopeWords ? (
        <div className="cad-p2-sub" data-check-scope="1">
          {scopeWords}
        </div>
      ) : null}
      {form}
      <div className="cad-p2-actions">
        <Button variant="primary" data-check-run={kind} disabledReason={reason} onClick={() => start?.()}>
          Check
        </Button>
      </div>
      {job && job.kind === kind ? <Progress job={job} onStop={runs.stop} /> : null}
      {shown && 'stopped' in shown ? (
        <div className="cad-p2-sub" data-check-stopped="1">
          Stopped: nothing was checked.
        </div>
      ) : null}
      {shown && 'error' in shown ? <DisabledReason>{shown.error}</DisabledReason> : null}
      {shown && 'outcome' in shown ? (
        <div className="cad-check-result" data-check-result={kind}>
          <div className="cad-check-text" data-check-text="1">
            {shown.outcome.text}
          </div>
          {shown.outcome.notes.map((n) => (
            <div key={n} data-check-note="1">
              <Hint tone="warning">{n}</Hint>
            </div>
          ))}
          {shown.outcome.seq !== seq ? (
            <div data-check-stale="1">
              <Hint tone="warning">The Part has changed since this check: press Check again.</Hint>
            </div>
          ) : null}
          {shown.outcome.interference ? <InterferenceRows r={shown.outcome.interference} units={units} rowProps={rowProps} /> : null}
          {shown.outcome.stack ? <StackRows r={shown.outcome.stack} units={units} rowProps={rowProps} /> : null}
          {shown.outcome.sweep ? <SweepRows r={shown.outcome.sweep} units={units} rowProps={rowProps} /> : null}
          <Hint>Click a row to select its bodies (Ctrl adds them).</Hint>
        </div>
      ) : null}
    </div>
  );
}

function Progress({ job, onStop }: { job: Job; onStop(): void }) {
  const width = job.fraction === null ? undefined : `${Math.max(0, Math.min(100, job.fraction * 100))}%`;
  return (
    <div className="cad-progress" data-check-progress="1" role="status" aria-live="polite">
      <div className="cad-progress-line">
        <span data-check-progress-label="1">{job.label}…</span>
        <Button variant="secondary" onClick={onStop} data-check-stop="1">
          Stop
        </Button>
      </div>
      <div className={`cad-progress-track${width ? '' : ' is-busy'}`}>
        <div className="cad-progress-bar" style={width ? { width } : undefined} />
      </div>
    </div>
  );
}

function InterferenceRows({ r, units, rowProps }: { r: InterferenceResult; units: DocUnits; rowProps: RowProps }) {
  return (
    <>
      {r.rows.length ? (
        <table className="cad-p2-table" data-check-pairs="1">
          <tbody>
            {r.rows.map((x) => (
              <tr key={`${x.a}|${x.b}`} {...rowProps([x.a, x.b])} title={`${x.press ? 'A press fit: a ring round the axis both have round faces on. ' : ''}${x.overlap !== null ? 'The middle of what they share' : 'Halfway between their nearest points'}: ${pointWords(x.at, units)}`} data-check-pair={`${x.a}|${x.b}`} data-check-overlap-mm3={x.overlap ?? undefined} data-check-press={x.press ? '1' : undefined} data-check-gap-mm={x.gap ?? undefined}>
                <td>
                  {x.a} and {x.b}
                </td>
                <td className={`num${x.overlap !== null && !x.press ? ' cad-p2-bad' : ''}`}>{x.overlap !== null ? `${formatVolume(x.overlap, units)} ${x.press ? 'press fit' : 'overlap'}` : x.gap ? `${formatQuantity(x.gap, 'length', units)} apart` : 'touching'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {r.surfaces.length ? <Hint>Surface bodies have no volume to overlap, so they were left out: {r.surfaces.join(', ')}.</Hint> : null}
    </>
  );
}

function sideWords(s: StackSide | null, units: DocUnits): string {
  if (!s) return '';
  if (s.by === null) return s.off ? 'nothing: it comes off' : 'nothing';
  return `${s.by}, ${formatQuantity(s.gap ?? 0, 'length', units)}`;
}

function StackRows({ r, units, rowProps }: { r: StackResult; units: DocUnits; rowProps: RowProps }) {
  return (
    <>
      {r.findings.length ? (
        <ul className="cad-check-list" data-check-loose-list="1">
          {r.findings.map((f, i) => (
            <li key={i} {...rowProps([f.body])} data-check-loose={f.body} data-check-finding={f.kind} data-check-side={f.side ? r.axes[f.axis][f.side === 'neg' ? 'negWords' : 'posWords'] : ''}>
              {f.words}
            </li>
          ))}
        </ul>
      ) : null}
      {r.axes.map((a, k) => (
        <div key={k} className="cad-check-axis" data-check-axis={a.words}>
          <div className="cad-check-axis-head">{a.words}</div>
          <table className="cad-p2-table">
            <thead>
              <tr>
                <th>Part</th>
                <th>Held by</th>
                <th>Toward {a.negWords}</th>
                <th>Toward {a.posWords}</th>
              </tr>
            </thead>
            <tbody>
              {a.parts.map((p) => (
                <tr key={p.body} {...rowProps([p.body])} title={`Along the axis from ${formatQuantity(p.from, 'length', units)} to ${formatQuantity(p.to, 'length', units)}${p.bore !== null ? `; its bore's radius ${formatQuantity(p.bore, 'length', units)}` : ''}`} data-check-part={p.body}>
                  <td>{p.body}</td>
                  <td>{p.on ? `${p.inBore ? 'in' : 'on'} ${p.on}, play ${formatQuantity(p.play ?? 0, 'length', units)}` : p.fixed.length ? `fixed to ${p.fixed.join(', ')}` : ''}</td>
                  <td>{sideWords(p.neg, units)}</td>
                  <td>{sideWords(p.pos, units)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

function SweepRows({ r, units, rowProps }: { r: SweepResult; units: DocUnits; rowProps: RowProps }) {
  const deg = (v: number | null) => (v === null ? 'never' : formatQuantity(v, 'angle', units));
  return (
    <>
      {r.hits.length ? (
        <table className="cad-p2-table" data-check-hits="1">
          <thead>
            <tr>
              <th>Turning</th>
              <th>Meets</th>
              <th data-check-ccw="1">Counter-clockwise about {directionWords(r.line, 1)}</th>
              <th data-check-cw="1">Clockwise</th>
            </tr>
          </thead>
          <tbody>
            {r.hits.map((h) => (
              <tr key={`${h.turning}|${h.hits}`} {...rowProps([h.turning, h.hits])} title={`They meet first at ${pointWords(h.at, units)}${h.overlap !== null ? `; turned 1° past that, the kernel finds ${formatVolume(h.overlap, units)} shared` : ''}`} data-check-hit={h.hits} data-check-first-deg={h.pos ?? undefined} data-check-back-deg={h.neg ?? undefined}>
                <td>{h.turning}</td>
                <td>{h.hits}</td>
                <td className="num">{deg(h.pos)}</td>
                <td className="num">{deg(h.neg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {r.already.length ? (
        <ul className="cad-check-list" data-check-already="1">
          {r.already.map((a) => (
            <li key={`${a.turning}|${a.with}`} {...rowProps([a.turning, a.with])}>
              {a.turning} already overlaps {a.with} before it turns: see Interference.
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
