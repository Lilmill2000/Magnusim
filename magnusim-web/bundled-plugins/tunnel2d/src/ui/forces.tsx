// The selected body's numbers: its force coefficients and forces (mean over the last passes
// of the flow, and now) with their history; the pressure round its surface; and an angle
// sweep with its polar. Each says what it was run at (the Reynolds number and the flow
// model), so a number from a capped grid is not read as the real one.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Button, Field, Hint, LinePlot, NumberUnitInput, fromSi, preferredUnit, type UnitSystem } from '@magnusim/plugin-ui';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { referenceLength } from '../geometry/shapes';
import { FLUIDS, type Body } from '../scene/scene';
import type { Engine } from '../sim/engine';
import { AVERAGE_PASSES, SETTLE_PASSES, sweepAngles, type SweepHost } from '../sim/sweep';
import type { CpPoint } from '../sim/surfaceCp';
import { useStore, type Store } from '../app/store';
import { fmtRe, liftBand } from './panels';

function Section({ title, children, attr }: { title: string; children: ReactNode; attr: string }) {
  return (
    <section className="t2d-section" data-t2d-section={attr}>
      <h2 className="t2d-section-title">{title}</h2>
      <div className="t2d-section-body">{children}</div>
    </section>
  );
}

function useTicker(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

const fmt = (v: number | null | undefined, digits = 3) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(digits));

/** Where a body's moment is taken: its pivot, which the position fields name. */
export function momentAbout(b: Body): string {
  switch (b.shape.kind) {
    case 'naca':
    case 'dat':
      return 'the quarter chord';
    case 'sketch':
      return 'the sketch’s origin';
    default:
      return 'its centre';
  }
}

/** What the numbers were run at, and how far to trust them (the Wind panel's wording, short). */
export function forceBasis(engine: Engine, b: Body): { label: string; note: string; warn: boolean; model: 'sa' | 'off'; exact: boolean } | null {
  const re = engine.reynoldsFor(b);
  const map = engine.lattice;
  if (!re || !map) return null;
  const model = engine.flowModel;
  if (model === 'sa') {
    return {
      label: `Re ${fmtRe(re.real)} · turbulence model`,
      note: `Lift to within about ${liftBand(engine.cellsAcross(b))} %; drag reads high (up to about twice the real drag at this resolution).`,
      warn: false,
      model,
      exact: true,
    };
  }
  if (!map.capped) return { label: `Re ${fmtRe(re.real)} · resolved, no model`, note: '', warn: false, model, exact: true };
  return {
    label: `Re (sim) ${fmtRe(re.sim)}, not the real ${fmtRe(re.real)}`,
    note: 'Qualitative: these are the forces of the lower Reynolds number the grid resolves.',
    warn: true,
    model,
    exact: false,
  };
}

/** Force per metre of span in the unit system's unit. */
function forceText(nPerM: number, units: UnitSystem): string {
  return units === 'imperial' ? `${fmtRe(nPerM * 0.0685218)} lbf/ft` : `${fmtRe(nPerM)} N/m`;
}
function momentText(n: number, units: UnitSystem): string {
  return units === 'imperial' ? `${fmtRe(n * 0.224809)} lbf·ft/ft` : `${fmtRe(n)} N·m/m`;
}

export function ForcesPanel({ engine, store, body, units }: { engine: Engine; store: Store; body: Body; units: UnitSystem }) {
  useTicker(250);
  const scene = useStore(store, (s) => s.scene);
  const live = engine.bodyLive(body.id);
  if (!live) {
    return (
      <Section title="Forces" attr="forces">
        <Hint>Not in the flow, so there are no forces to show.</Hint>
      </Section>
    );
  }
  const L = referenceLength(body.shape);
  const U = scene.flow.speed;
  const pass = L / U;
  const m = engine.measure(body.id, AVERAGE_PASSES * pass);
  const ready = !!m && m.span >= 0.9 * AVERAGE_PASSES * pass;
  const mean = ready ? m : null;
  const q = 0.5 * FLUIDS[scene.flow.fluid].rho * U * U;
  const basis = forceBasis(engine, body);
  const rows: { key: string; label: string; title: string; mean: number | null; now: number | null; text?: (v: number) => string }[] = [
    { key: 'cl', label: 'Cl', title: 'Lift coefficient', mean: mean?.cl ?? null, now: live.cl },
    { key: 'cd', label: 'Cd', title: 'Drag coefficient', mean: mean?.cd ?? null, now: live.cd },
    { key: 'cm', label: 'Cm', title: 'Moment coefficient', mean: mean?.cm ?? null, now: live.cm },
    { key: 'ld', label: 'L/D', title: 'Lift over drag', mean: mean && Math.abs(mean.cd) > 1e-9 ? mean.cl / mean.cd : null, now: Math.abs(live.cd) > 1e-9 ? live.cl / live.cd : null, text: (v) => v.toFixed(1) },
    { key: 'lift', label: 'Lift', title: 'Lift per metre of span', mean: mean ? mean.cl * q * L : null, now: live.fy, text: (v) => forceText(v, units) },
    { key: 'drag', label: 'Drag', title: 'Drag per metre of span', mean: mean ? mean.cd * q * L : null, now: live.fx, text: (v) => forceText(v, units) },
    { key: 'moment', label: 'Moment', title: 'Moment per metre of span', mean: mean ? mean.cm * q * L * L : null, now: live.mz, text: (v) => momentText(v, units) },
  ];
  // The last 20 passes, for the plot (a few hundred rows at most).
  const t1 = engine.stats.simTime;
  const sm = engine.samplesOf(body.id, t1 - 20 * pass);
  const every = Math.max(1, Math.ceil(sm.t.length / 240));
  const plot: Record<string, number>[] = [];
  for (let i = 0; i < sm.t.length; i += every) plot.push({ t: sm.t[i], cl: sm.cl[i], cd: sm.cd[i], cm: sm.cm[i] });
  return (
    <Section title="Forces" attr="forces">
      {basis ? (
        <Hint tone={basis.warn ? 'warning' : undefined}>
          <span data-t2d-force-basis={basis.exact ? (basis.model === 'sa' ? 'sa' : 'resolved') : 'capped'}>
            {basis.label}. {basis.note} Per metre of span; reference length {fmtRe(L)} m; moment about {momentAbout(body)}, nose up positive.
          </span>
        </Hint>
      ) : null}
      <table className="t2d-preset-table t2d-forces" data-t2d-forces={body.id}>
        <thead>
          <tr>
            <th />
            <th>Mean</th>
            <th>Now</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-t2d-force={r.key} data-mean={r.mean ?? ''} data-now={r.now ?? ''}>
              <td title={r.title}>{r.label}</td>
              <td>{r.mean == null || !Number.isFinite(r.mean) ? '–' : r.text ? r.text(r.mean) : fmt(r.mean)}</td>
              <td>{r.now == null || !Number.isFinite(r.now) ? '–' : r.text ? r.text(r.now) : fmt(r.now)}</td>
            </tr>
          ))}
          {mean?.st != null ? (
            <tr data-t2d-force="st" data-mean={mean.st}>
              <td title="Strouhal number: shedding frequency × length / speed">St</td>
              <td>{fmt(mean.st)}</td>
              <td />
            </tr>
          ) : null}
        </tbody>
      </table>
      <Hint>
        <span data-t2d-force-window={ready ? 'mean' : 'settling'}>
          {ready ? `Mean over the last ${AVERAGE_PASSES} passes of the flow past the body (${fmtRe(AVERAGE_PASSES * pass)} s).` : `Settling: the mean shows after ${AVERAGE_PASSES} passes of the flow past the body.`}
        </span>
      </Hint>
      {plot.length > 2 ? (
        <LinePlot
          label="Force coefficients over time"
          rows={plot}
          xKey="t"
          x={{ kind: 'linear', label: 't', format: (v) => `${fmtRe(v)} s` }}
          y={{ scale: 'linear' }}
          series={[
            { key: 'cl', label: 'Cl', format: (v) => v.toFixed(3) },
            { key: 'cd', label: 'Cd', format: (v) => v.toFixed(3) },
            { key: 'cm', label: 'Cm', format: (v) => v.toFixed(3) },
          ]}
        />
      ) : null}
    </Section>
  );
}

/** x/c, closer together near the leading and trailing edges. */
const CP_X = Array.from({ length: 81 }, (_, i) => (1 - Math.cos((Math.PI * i) / 80)) / 2);

function interp(curve: CpPoint[], x: number): number | undefined {
  if (curve.length < 2 || x < curve[0].x || x > curve[curve.length - 1].x) return undefined;
  let i = 1;
  while (i < curve.length - 1 && curve[i].x < x) i++;
  const a = curve[i - 1];
  const b = curve[i];
  const t = b.x > a.x ? (x - a.x) / (b.x - a.x) : 0;
  return a.cp + t * (b.cp - a.cp);
}

/** Reads kept for the mean (about three seconds at four a second). */
const CP_KEEP = 12;

export function SurfacePanel({ engine, store, body }: { engine: Engine; store: Store; body: Body }) {
  const scene = useStore(store, (s) => s.scene);
  const [curve, setCurve] = useState<{ x: number; up?: number; lo?: number }[]>([]);
  const [reads, setReads] = useState(0);
  const inFlow = !!engine.bodyLive(body.id);
  // What the mean is of: a change of shape, angle or flow starts it again.
  const key = JSON.stringify([body.shape, body.angle, body.spin, scene.flow, scene.tunnel]);
  const acc = useRef<{ key: string; list: { up: (number | undefined)[]; lo: (number | undefined)[] }[] }>({ key: '', list: [] });
  useEffect(() => {
    if (!inFlow) return;
    let alive = true;
    let busy = false;
    const t = setInterval(() => {
      if (busy) return;
      busy = true;
      void engine
        .surfaceCp(body.id)
        .then((s) => {
          if (!alive || !s) return;
          const a = acc.current;
          if (a.key !== key) acc.current = { key, list: [] };
          acc.current.list.push({ up: CP_X.map((x) => interp(s.upper, x)), lo: CP_X.map((x) => interp(s.lower, x)) });
          if (acc.current.list.length > CP_KEEP) acc.current.list.shift();
          const list = acc.current.list;
          const avg = (pick: (r: (typeof list)[number]) => (number | undefined)[], i: number) => {
            let s2 = 0;
            let n = 0;
            for (const r of list) {
              const v = pick(r)[i];
              if (v !== undefined) {
                s2 += v;
                n++;
              }
            }
            return n ? -s2 / n : undefined;
          };
          setCurve(CP_X.map((x, i) => ({ x, up: avg((r) => r.up, i), lo: avg((r) => r.lo, i) })));
          setReads(list.length);
        })
        .finally(() => {
          busy = false;
        });
    }, 250);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [engine, body.id, key, inFlow]);
  if (!inFlow) return null;
  const airfoil = body.shape.kind === 'naca' || body.shape.kind === 'dat';
  return (
    <Section title="Surface pressure" attr="surface">
      <div data-t2d-cp-reads={reads}>
        <LinePlot
          label="Pressure coefficient along the surface"
          rows={curve}
          xKey="x"
          x={{ kind: 'linear', min: 0, max: 1, label: airfoil ? 'x/c' : 'x/L', format: (v) => v.toFixed(1) }}
          y={{ scale: 'linear', unit: '−Cp' }}
          series={[
            { key: 'up', label: 'Upper surface', format: (v) => (-v).toFixed(2) },
            { key: 'lo', label: 'Lower surface', format: (v) => (-v).toFixed(2) },
          ]}
          height={150}
        />
      </div>
      <Hint>
        −Cp (suction up, as XFOIL draws it) along the body from its leading point (0) to its trailing one (1), read one cell off the wall{engine.refineInfo().length ? ' on the finest grid round it' : ''}, the mean of the last few seconds.
      </Hint>
    </Section>
  );
}

function useSweep(host: SweepHost) {
  return useSyncExternalStore(
    (fn) => host.subscribe(fn),
    () => host.version,
  );
}

export function SweepPanel({ engine, store, body, host }: { engine: Engine; store: Store; body: Body; host: SweepHost }) {
  useSweep(host);
  const scene = useStore(store, (s) => s.scene);
  const [from, setFrom] = useState(-4);
  const [to, setTo] = useState(12);
  const [step, setStep] = useState(2);
  const run = host.run && host.run.state.bodyId === body.id ? host.run : null;
  const running = !!run?.running;
  const otherRunning = !!host.run?.running && !run;
  const angles = sweepAngles(from, to, step);
  const pass = referenceLength(body.shape) / scene.flow.speed;
  const inFlow = !!engine.bodyLive(body.id);
  const result = scene.sweep && scene.sweep.bodyId === body.id ? scene.sweep : null;
  const st = run?.state;
  const rows = (running ? st!.rows : result?.rows) ?? [];
  const plotRows = rows.map((r) => ({ a: r.angle, cl: r.cl, cd: r.cd, cm: r.cm }));
  const polar = [...rows].sort((a, b) => a.angle - b.angle).map((r) => ({ cd: r.cd, cl: r.cl }));
  const basis = forceBasis(engine, body);
  return (
    <Section title="Angle sweep" attr="sweep">
      <div className="t2d-sweep-inputs">
        <Field label="From">
          <NumberUnitInput label="Sweep from" unit="°" valueSi={from} onCommitSi={setFrom} />
        </Field>
        <Field label="To">
          <NumberUnitInput label="Sweep to" unit="°" valueSi={to} onCommitSi={setTo} />
        </Field>
        <Field label="Step">
          <NumberUnitInput label="Sweep step" unit="°" valueSi={step} onCommitSi={setStep} />
        </Field>
      </div>
      {'error' in angles ? <Hint tone="danger">{angles.error}</Hint> : null}
      <div className="t2d-add-row">
        {running ? (
          <Button variant="neutral" onClick={() => host.stop()} attrs={{ 'data-t2d-sweep-stop': '1' }}>
            Stop
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={'error' in angles || !inFlow || otherRunning || body.locked}
            onClick={() => !('error' in angles) && host.start(body.id, angles)}
            attrs={{ 'data-t2d-sweep-start': '1' }}
          >
            Run sweep
          </Button>
        )}
      </div>
      {!inFlow ? <Hint>Put the body in the flow to sweep it.</Hint> : body.locked ? <Hint>Unlock the body to sweep its angle.</Hint> : otherRunning ? <Hint>Another body’s sweep is running.</Hint> : null}
      {running && st ? (
        <Hint>
          <span data-t2d-sweep-progress={st.index}>
            {`Angle ${fmtRe(st.angles[st.index])}° (${st.index + 1} of ${st.angles.length}): ${st.phase === 'settling' ? 'settling' : 'averaging'} ${Math.round(st.progress * 100)} %.`}
            {engine.stats.state === 'paused' ? ' Paused: the sweep waits for the flow.' : ''}
          </span>
        </Hint>
      ) : (
        <Hint>
          Each angle: {SETTLE_PASSES} passes of the flow past the body to settle ({fmtRe(SETTLE_PASSES * pass)} s), then the mean over {AVERAGE_PASSES}. The angle goes back when it ends.
          {st?.phase === 'stopped' && st.reason ? <span data-t2d-sweep-stopped> Stopped: {st.reason}</span> : null}
        </Hint>
      )}
      {rows.length ? (
        <>
          <div className="t2d-sweep-caption" data-t2d-sweep-rows={rows.length}>
            {result && !running ? `${result.bodyName} · ${result.model === 'sa' ? `Re ${fmtRe(result.re)} · turbulence model` : result.exact ? `Re ${fmtRe(result.re)} · resolved` : `Re (sim) ${fmtRe(result.re)} · qualitative`}` : basis?.label}
          </div>
          <LinePlot
            label="Lift and moment against angle"
            rows={plotRows}
            xKey="a"
            x={{ kind: 'linear', label: 'α', format: (v) => `${fmtRe(v)}°` }}
            y={{ scale: 'linear' }}
            series={[
              { key: 'cl', label: 'Cl', format: (v) => v.toFixed(3) },
              { key: 'cm', label: 'Cm', format: (v) => v.toFixed(3) },
            ]}
          />
          <LinePlot
            label="Drag against angle"
            rows={plotRows}
            xKey="a"
            x={{ kind: 'linear', label: 'α', format: (v) => `${fmtRe(v)}°` }}
            y={{ scale: 'linear' }}
            series={[{ key: 'cd', label: 'Cd', format: (v) => v.toFixed(4) }]}
          />
          <LinePlot label="Drag polar" rows={polar} xKey="cd" x={{ kind: 'linear', label: 'Cd', format: (v) => v.toFixed(3) }} y={{ scale: 'linear' }} series={[{ key: 'cl', label: 'Cl against Cd', format: (v) => v.toFixed(3) }]} />
          <table className="t2d-preset-table" data-t2d-sweep-table>
            <thead>
              <tr>
                <th>α</th>
                <th>Cl</th>
                <th>Cd</th>
                <th>Cm</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.angle} data-t2d-sweep-row={r.angle} data-cl={r.cl} data-cd={r.cd} data-cm={r.cm}>
                  <td>{fmtRe(r.angle)}°</td>
                  <td>{fmt(r.cl)}</td>
                  <td>{fmt(r.cd, 4)}</td>
                  <td>{fmt(r.cm)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </Section>
  );
}

/** A reading's words (the hover readout and the probes). */
export function readingText(r: { u: number; v: number; speed: number; p: number; cp: number; inBody: boolean }, units: UnitSystem): string {
  if (r.inBody) return 'Inside a body';
  const vu = preferredUnit('velocity', units === 'imperial');
  const pu = preferredUnit('pressure', units === 'imperial');
  const V = (x: number) => `${fmtRe(fromSi('velocity', x, vu))}`;
  // No "-0.00": a value that rounds to nothing reads 0.
  const cp = Math.abs(r.cp) < 0.005 ? '0.00' : r.cp.toFixed(2);
  return `u ${V(r.u)}, v ${V(r.v)}, |u| ${V(r.speed)} ${vu} · p ${fmtRe(fromSi('pressure', r.p, pu))} ${pu} · Cp ${cp}`;
}
