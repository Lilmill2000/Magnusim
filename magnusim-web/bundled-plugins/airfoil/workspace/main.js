// The Airfoil workspace: the study's section (a NACA 4- or 5-digit designation, or an
// imported Selig or Lednicer .dat file) and its conditions; an engine picker (NeuralFoil,
// computed again as the inputs change; XFOIL, a job with per-angle progress; OpenFOAM 2D,
// one case per angle: the openfoam_2d job meshes the section and writes the case, the host
// queues and runs it in WSL (ws.compute), its residuals show as it solves, and a finished
// case opens in the project's 3D view); the Cl–α, Cl–Cd and Cm–α polars and XFOIL's
// Cp(x), with every engine's polar overlaid and named with its settings; the picked
// engine's table; CSV and .dat export.
// Everything is saved in the study: its settings and what the page shows (engine, overlay,
// the Cp angle, OpenFOAM's angle and mesh) in the record (ws.study), the imported section,
// the results and the OpenFOAM cases in its folder (written by the service and the jobs),
// so a reload reopens it as it was and follows a case that is still queued or running.
// SPDX-License-Identifier: GPL-3.0-or-later
import { connect } from '@magnusim/workspace';
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Button,
  DisabledReason,
  Elapsed,
  EmptyState,
  Field,
  Hint,
  LinePlot,
  NumberUnitInput,
  Select,
  StatusBlock,
  Toggle,
} from '@magnusim/plugin-ui';

const ws = await connect();
const STUDY_ID = ws.context.study.id;

const ENGINES = [
  { value: 'neuralfoil', label: 'NeuralFoil' },
  { value: 'xfoil', label: 'XFOIL' },
  { value: 'openfoam', label: 'OpenFOAM 2D' },
];
const ENGINE_COLOR = { neuralfoil: 'var(--mg-series-1)', xfoil: 'var(--mg-series-2)', openfoam: 'var(--mg-series-4)' };
const DEFAULT_VIEW = { engine: 'neuralfoil', overlay: true, cp_alpha: null, of_alpha: 4, of_level: 'medium' };
// OpenFOAM cases run through the host (ws.compute and ws.results, host 1.3).
const HOST = String(ws.context.hostVersion || '0.0')
  .split('.')
  .map((v) => Number(v) || 0);
const HAS_COMPUTE = Boolean(ws.compute && ws.results) && (HOST[0] > 1 || (HOST[0] === 1 && HOST[1] >= 3));
// How a case ended, from the host (compute events' `end`).
const FINAL = ['done', 'failed', 'stopped', 'lost'];
const STAGE_LABEL = {
  pre_copy_in: 'Copying the case to WSL',
  pre_copy_back: 'Copying the mesh back',
  copy_to_wsl: 'Copying the case to WSL',
  decompose: 'Splitting the mesh across cores',
  solve: 'Solving',
  reconstruct: 'Joining the mesh',
  copy: 'Copying the results back',
  cleanup: 'Cleaning up',
  stopping: 'Stopping',
  ending: 'Ending',
};
// The residual plot keeps at most this many iterations (older ones are thinned out).
const RESIDUAL_ROWS = 2000;
// Turning forced transition on trips both surfaces here (x/c) until the user says otherwise.
const DEFAULT_TRIP = 0.05;
// The field a failed check names (the service's `field`): its input and the fix link's words.
const FIELDS = {
  code: ['af-naca', 'Change the NACA designation'],
  points_per_side: ['af-pps', 'Change the points per side'],
  re: ['af-re', 'Change the Reynolds number'],
  mach: ['af-mach', 'Change the Mach number'],
  alpha_start: ['af-a0', 'Change the first α'],
  alpha_end: ['af-a1', 'Change the last α'],
  alpha_step: ['af-da', 'Change the α step'],
  ncrit: ['af-ncrit', 'Change Ncrit'],
  xtr_top: ['af-xtr-top', 'Change the upper trip'],
  xtr_bottom: ['af-xtr-bottom', 'Change the lower trip'],
};

/** A disabled reason's fix that takes the user to the field the check named (in another card). */
function goToField(field) {
  const f = FIELDS[field];
  if (!f) return undefined;
  return { label: f[1], onFix: () => document.getElementById(f[0])?.focus() };
}

/** A small number as the residual readouts write it: "1.6e−3". */
function sci(v) {
  return minus(v.toExponential(1)).replace('e-', 'e−');
}

/** A real minus sign for a number's text. */
function minus(text) {
  return text.startsWith('-') ? `−${text.slice(1)}` : text;
}

/** A number for a table cell: fixed decimals, a real minus sign, "—" when missing. */
function num(v, decimals) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return minus(v.toFixed(decimals));
}

/** An angle as the page writes it: "−4°", "2.5°". */
function deg(v) {
  return `${minus(String(Number(Number(v).toFixed(3))))}°`;
}

function sameSettings(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function forced(c) {
  return c.xtr_top < 1 || c.xtr_bottom < 1;
}

/** The settings a result was made with, as the legends and hints name them. */
function settingsLabel(doc) {
  const c = doc.conditions;
  const parts = [doc.name, `Re ${Number(c.re).toExponential(2)}`];
  // OpenFOAM 2D is incompressible and fully turbulent: Mach, Ncrit and the trips are not its.
  if (doc.engine === 'openfoam') return parts.join(' · ');
  if (c.mach) parts.push(`Mach ${c.mach}`);
  parts.push(`Ncrit ${c.ncrit}`);
  if (forced(c)) parts.push(`trip ${c.xtr_top}/${c.xtr_bottom}`);
  return parts.join(' · ');
}

/** The engine's own name, with NeuralFoil's model size and OpenFOAM's model and mesh. */
function engineName(doc) {
  if (doc.engine === 'neuralfoil') return `NeuralFoil (${doc.model_size})`;
  if (doc.engine === 'openfoam') return `OpenFOAM 2D (k-ω SST, ${doc.level} mesh)`;
  return 'XFOIL';
}

/** A polar's legend entry: the engine and its settings. */
function engineLabel(doc) {
  return `${engineName(doc)} · ${settingsLabel(doc)}`;
}

// The study record: saved one patch at a time, with the rev of the last save (the
// header's rename or another tab moves it on; ws.on('study') hears that).
let rev = ws.context.study.rev;
let saving = Promise.resolve();
ws.on('study', (s) => {
  if (s && Number.isFinite(s.rev)) rev = s.rev;
});
function saveStudy(patch) {
  const next = saving.then(async () => {
    let s;
    try {
      s = await ws.study.update(patch, rev);
    } catch (e) {
      if (!e || e.code !== 'conflict') throw e;
      rev = (await ws.study.get()).rev;
      s = await ws.study.update(patch, rev);
    }
    rev = s.rev;
    return s;
  });
  saving = next.catch(() => {});
  return next;
}

/** Hand the user a file: the browser's own download (the frame may start one). */
function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** The section's outline, chord across the box, y to the same scale. */
function Outline({ section }) {
  if (!section) return h(EmptyState, { variant: 'chart' }, 'No section yet');
  const W = 600;
  const pad = 16;
  const ys = section.y;
  const ymin = Math.min(...ys);
  const ymax = Math.max(...ys);
  const scale = W - 2 * pad;
  const H = Math.max(80, Math.ceil((ymax - ymin) * scale + 2 * pad));
  const pts = section.x.map((x, i) => `${(pad + x * scale).toFixed(2)},${(pad + (ymax - ys[i]) * scale).toFixed(2)}`).join(' ');
  return h(
    'svg',
    { className: 'af-outline', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${section.name} outline`, 'data-af': 'outline' },
    h('line', { className: 'af-chord', x1: pad, x2: W - pad, y1: pad + ymax * scale, y2: pad + ymax * scale }),
    h('polyline', { className: 'af-shape', points: pts }),
  );
}

function SectionFacts({ section }) {
  if (!section) return null;
  const pct = (v) => `${(v * 100).toFixed(2)} %`;
  return h(
    Hint,
    null,
    `${section.name} · thickness ${pct(section.thickness)} at ${pct(section.thickness_at)} · ` +
      `camber ${pct(Math.abs(section.camber))} at ${pct(section.camber_at)} · ${section.points} points`,
  );
}

function PolarTable({ rows, engine, notConverged }) {
  const all = [...rows];
  for (const a of notConverged || []) all.push({ alpha: a, missing: true });
  all.sort((p, q) => p.alpha - q.alpha);
  const last = { neuralfoil: 'Confidence', xfoil: 'Transition (top)', openfoam: 'Iterations' }[engine];
  const head = ['α', 'Cl', 'Cd', 'Cm', 'Cl/Cd', last];
  return h(
    'table',
    { className: 'af-table', 'data-af': `${engine}-table` },
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        head.map((t) => h('th', { key: t, scope: 'col' }, t)),
      ),
    ),
    h(
      'tbody',
      null,
      all.map((r) =>
        r.missing
          ? h(
              'tr',
              { key: `m${r.alpha}`, className: 'af-missing', 'data-alpha': r.alpha },
              h('td', null, deg(r.alpha)),
              h('td', { colSpan: 5 }, 'did not converge'),
            )
          : h(
              'tr',
              { key: r.alpha, 'data-alpha': r.alpha },
              h('td', null, deg(r.alpha)),
              h('td', { 'data-col': 'cl' }, num(r.cl, 4)),
              h('td', { 'data-col': 'cd' }, num(r.cd, 5)),
              h('td', { 'data-col': 'cm' }, num(r.cm, 4)),
              h('td', { 'data-col': 'cl_cd' }, num(r.cl_cd, 1)),
              engine === 'neuralfoil'
                ? h('td', { 'data-col': 'confidence' }, r.confidence == null ? '—' : `${Math.round(r.confidence * 100)} %`)
                : engine === 'openfoam'
                  ? h('td', { 'data-col': 'iterations' }, r.steady === false ? `${r.iterations} · not steady` : String(r.iterations ?? '—'))
                  : h('td', { 'data-col': 'xtr_top' }, num(r.xtr_top, 3)),
            ),
      ),
    ),
  );
}

/** One plot of the grid: its title, then the kit's LinePlot (or the empty state). */
function PlotBox({ title, af, children }) {
  return h('figure', { className: 'af-plot', 'data-af': af }, h('figcaption', null, title), children);
}

/** Cl–α, Cl–Cd, Cm–α of every shown engine, and XFOIL's Cp(x) at one angle. */
function Plots({ docs, xfDoc, cpAlpha, onCpAlpha }) {
  const polar = useMemo(() => {
    const byAlpha = new Map();
    const drag = [];
    for (const d of docs) {
      for (const r of d.rows) {
        const row = byAlpha.get(r.alpha) || { alpha: r.alpha };
        row[`${d.engine}_cl`] = r.cl;
        row[`${d.engine}_cm`] = r.cm;
        byAlpha.set(r.alpha, row);
        if (Number.isFinite(r.cd)) drag.push({ cd: r.cd, alpha: r.alpha, [`${d.engine}_cl`]: r.cl });
      }
    }
    return { alpha: [...byAlpha.values()].sort((p, q) => p.alpha - q.alpha), drag };
  }, [docs]);
  const series = (what, decimals) =>
    docs.map((d) => ({
      key: `${d.engine}_${what}`,
      label: engineLabel(d),
      color: ENGINE_COLOR[d.engine],
      legend: 'always',
      format: (v) => num(v, decimals),
    }));
  const alphaAxis = { kind: 'linear', label: 'α', format: deg };
  // The tips: the angle, then one line per engine in its colour (the legend has the settings).
  const alphaTip = (what) => (row) =>
    h(
      'span',
      null,
      h('b', null, `α = ${deg(row.alpha)}`),
      docs
        .filter((d) => Number.isFinite(row[`${d.engine}_${what}`]))
        .map((d) =>
          h(
            'span',
            { key: d.engine },
            h('br'),
            h('span', { style: { color: ENGINE_COLOR[d.engine] } }, engineName(d)),
            ` ${num(row[`${d.engine}_${what}`], 4)}`,
          ),
        ),
    );
  const dragTip = (row) => {
    const d = docs.find((doc) => Number.isFinite(row[`${doc.engine}_cl`]));
    return h(
      'span',
      null,
      h('b', null, `α = ${deg(row.alpha)}`),
      h('br'),
      d ? h('span', { style: { color: ENGINE_COLOR[d.engine] } }, engineName(d)) : null,
      ` Cd ${num(row.cd, 5)} · Cl ${d ? num(row[`${d.engine}_cl`], 4) : '—'}`,
    );
  };

  // Cp(x): XFOIL's file at the chosen angle, upper surface then lower (−Cp upward, as usual).
  const cpAngles =
    xfDoc && xfDoc.cp
      ? Object.keys(xfDoc.cp)
          .map(Number)
          .sort((p, q) => p - q)
      : [];
  let shownAlpha = null;
  if (cpAngles.length) {
    // The saved angle while XFOIL has it, else the one nearest 4°.
    shownAlpha = cpAlpha == null ? undefined : cpAngles.find((a) => Math.abs(a - Number(cpAlpha)) < 0.01);
    if (shownAlpha === undefined) shownAlpha = cpAngles.reduce((best, a) => (Math.abs(a - 4) < Math.abs(best - 4) ? a : best), cpAngles[0]);
  }
  const cpRows = useMemo(() => {
    if (shownAlpha === null) return [];
    const key = Object.keys(xfDoc.cp).find((k) => Math.abs(Number(k) - shownAlpha) < 0.01);
    const { x, cp } = xfDoc.cp[key];
    let le = 0;
    for (let i = 1; i < x.length; i++) if (x[i] < x[le]) le = i;
    // XFOIL's nodes can sit a hair outside the chord (x/c −0.00001, or 1.0001 at an open
    // trailing edge): drawn at 0 and 1, so the axis ends there and not at −0.5.
    const chord = (v) => Math.min(1, Math.max(0, v));
    return x.map((xi, i) => (i <= le ? { x: chord(xi), upper: -cp[i] } : { x: chord(xi), lower: -cp[i] }));
  }, [xfDoc, shownAlpha]);
  const cpFormat = (v) => `Cp ${num(-v, 3)}`;

  if (!docs.length && !cpAngles.length) {
    return h('div', { className: 'af-plots' }, h(EmptyState, { variant: 'chart' }, 'No polar yet'));
  }
  const empty = (text) => h(EmptyState, { variant: 'chart' }, text);
  return h(
    'div',
    { className: 'af-plots' },
    h(
      PlotBox,
      { title: 'Cl against α', af: 'plot-cl-alpha' },
      docs.length
        ? h(LinePlot, {
            rows: polar.alpha,
            series: series('cl', 4),
            label: 'Lift coefficient against angle of attack',
            xKey: 'alpha',
            x: alphaAxis,
            y: { scale: 'linear', unit: 'Cl' },
            height: 170,
            tip: alphaTip('cl'),
          })
        : empty('No polar yet'),
    ),
    h(
      PlotBox,
      { title: 'Cl against Cd', af: 'plot-cl-cd' },
      docs.length
        ? h(LinePlot, {
            rows: polar.drag,
            series: series('cl', 4),
            label: 'Drag polar: lift coefficient against drag coefficient',
            xKey: 'cd',
            x: { kind: 'linear', label: 'Cd' },
            y: { scale: 'linear', unit: 'Cl' },
            height: 170,
            tip: dragTip,
          })
        : empty('No polar yet'),
    ),
    h(
      PlotBox,
      { title: 'Cm against α', af: 'plot-cm-alpha' },
      docs.length
        ? h(LinePlot, {
            rows: polar.alpha,
            series: series('cm', 4),
            label: 'Moment coefficient against angle of attack',
            xKey: 'alpha',
            x: alphaAxis,
            y: { scale: 'linear', unit: 'Cm' },
            height: 170,
            tip: alphaTip('cm'),
          })
        : empty('No polar yet'),
    ),
    h(
      PlotBox,
      { title: shownAlpha === null ? 'Cp(x)' : `Cp(x) at α = ${deg(shownAlpha)}`, af: 'plot-cp' },
      shownAlpha === null
        ? empty('No Cp(x) yet: XFOIL writes it for each angle it converges')
        : h(
            'div',
            null,
            h(
              'div',
              { className: 'af-plot-tools' },
              h(Select, {
                id: 'af-cp-alpha',
                label: 'Angle of attack for Cp(x)',
                value: String(shownAlpha),
                options: cpAngles.map((a) => ({ value: String(a), label: deg(a) })),
                onChange: (v) => onCpAlpha(Number(v)),
              }),
              h(Hint, null, `XFOIL · ${settingsLabel(xfDoc)} · −Cp upward`),
            ),
            h(LinePlot, {
              rows: cpRows,
              series: [
                { key: 'upper', label: 'XFOIL, upper surface', color: ENGINE_COLOR.xfoil, legend: 'always', format: cpFormat },
                { key: 'lower', label: 'XFOIL, lower surface', color: 'var(--mg-series-3)', legend: 'always', format: cpFormat },
              ],
              label: `Pressure coefficient along the chord at ${deg(shownAlpha)}`,
              xKey: 'x',
              x: { kind: 'linear', min: 0, max: 1, label: 'x/c' },
              y: { scale: 'linear', unit: '−Cp' },
              height: 170,
            }),
          ),
    ),
  );
}

/** Residual points of a progress event added to the plot's rows (the oldest thinned out past RESIDUAL_ROWS). */
function addPoints(rows, points) {
  if (!Array.isArray(points) || !points.length) return rows;
  let out = [...rows];
  for (const p of points) {
    const t = Number(p && p.t);
    if (!Number.isFinite(t)) continue;
    const row = { t };
    for (const [k, v] of Object.entries(p)) if (k !== 't' && !k.startsWith('co_') && k !== 'delta_t' && Number.isFinite(Number(v))) row[k] = Number(v);
    out.push(row);
  }
  if (out.length > RESIDUAL_ROWS) {
    const half = Math.floor(out.length / 2);
    out = [...out.slice(0, half).filter((_, i) => i % 2 === 0), ...out.slice(half)];
  }
  return out;
}

/** OpenFOAM's residuals as it solves: the largest initial residual of each field per iteration (log). */
function ResidualPlot({ rows, planned }) {
  const fields = useMemo(() => {
    const seen = new Set();
    for (const r of rows) for (const k of Object.keys(r)) if (k !== 't') seen.add(k);
    return [...seen];
  }, [rows]);
  if (!rows.length) return null;
  return h(
    'div',
    { 'data-af': 'openfoam-residuals' },
    h(LinePlot, {
      rows,
      series: fields.map((k) => ({ key: k, label: k, legend: 'when-data' })),
      label: 'Initial residuals per iteration',
      x: { kind: 'iterations', max: planned },
      y: { scale: 'log' },
      // It spans the engine panel: taller than a side panel's plot, so its decades read.
      height: 220,
    }),
  );
}

/** How a run stands, in words: its place in the queue, its iteration, or how it ended. */
function runStatus(run, live) {
  if (live && live.phase === 'queued') return live.ahead > 0 ? `Queued: ${live.ahead} ahead` : 'Queued: next';
  if (live && live.phase === 'running') return live.iteration ? `Running: iteration ${live.iteration}` : `Running: ${live.stageLabel || 'starting'}`;
  switch (run.status) {
    case 'done': {
      const how = run.steady ? 'Steady' : `Not steady: Cl moved ${num(run.cl_change, 4)} over the last ${run.averaged} iterations`;
      // The last iteration's largest initial residual: Cl can settle while p still sits at 1e−2.
      const worst = Object.entries(run.residuals && typeof run.residuals === 'object' ? run.residuals : {})
        .filter(([, v]) => Number.isFinite(v))
        .sort((p, q) => q[1] - p[1])[0];
      return worst ? `${how} · largest residual ${sci(worst[1])} (${worst[0]})` : how;
    }
    case 'failed':
      return `Failed: ${run.error || 'see the logs in the case folder'}`;
    case 'stopped':
      return run.error ? `Stopped: ${run.error}` : 'Stopped';
    case 'lost':
      return `Lost: ${run.error || 'WSL did not answer'}`;
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    default:
      return run.status || '';
  }
}

/** Every OpenFOAM run of the study, newest first, with what can be done with it. */
function OpenfoamRuns({ runs, live, onOpen, onStop, onDelete, busy }) {
  if (!runs.length) return h(EmptyState, { variant: 'chart' }, 'No OpenFOAM run yet');
  const rows = [...runs].reverse();
  return h(
    'table',
    { className: 'af-table af-runs', 'data-af': 'openfoam-runs' },
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        ['α', 'Mesh', 'Cl', 'Cd', 'Cm', 'Status', ''].map((t, i) =>
          h('th', { key: i, scope: 'col', className: t === 'Status' ? 'af-run-status' : undefined }, t),
        ),
      ),
    ),
    h(
      'tbody',
      null,
      rows.map((run) => {
        const lv = run.compute_id ? live[run.compute_id] : null;
        const ended = FINAL.includes(run.status) && !(lv && !FINAL.includes(lv.phase));
        return h(
          'tr',
          { key: run.case_rel, 'data-case': run.case_rel, 'data-status': run.status },
          h('td', null, deg(run.alpha)),
          h('td', null, run.level),
          h('td', { 'data-col': 'cl' }, run.status === 'done' ? num(run.cl, 4) : '—'),
          h('td', { 'data-col': 'cd' }, run.status === 'done' ? num(run.cd, 5) : '—'),
          h('td', { 'data-col': 'cm' }, run.status === 'done' ? num(run.cm, 4) : '—'),
          h('td', { 'data-col': 'status', className: 'af-run-status' }, runStatus(run, lv)),
          h(
            'td',
            { className: 'af-run-actions' },
            ended
              ? [
                  run.status === 'done'
                    ? h(
                        Button,
                        { key: 'open', variant: 'link', disabled: busy, onClick: () => onOpen(run), attrs: { 'data-af': 'open-3d' } },
                        'Open in 3D',
                      )
                    : null,
                  h(
                    Button,
                    { key: 'delete', variant: 'link', disabled: busy, onClick: () => onDelete(run), attrs: { 'data-af': 'delete-run' } },
                    'Delete',
                  ),
                ]
              : h(Button, { variant: 'link', onClick: () => onStop(run), attrs: { 'data-af': 'stop-run' } }, 'Stop'),
          ),
        );
      }),
    ),
  );
}

function App() {
  const [settings, setSettings] = useState(null);
  const [view, setViewState] = useState(DEFAULT_VIEW);
  const [draftCode, setDraftCode] = useState('');
  const [section, setSection] = useState(null);
  const [inputError, setInputError] = useState('');
  const [inputField, setInputField] = useState(null);
  const [importNote, setImportNote] = useState({ error: '', warnings: [] });
  const [nf, setNf] = useState(null);
  const [nfState, setNfState] = useState({ busy: false, error: '' });
  const [warm, setWarm] = useState({ state: 'warming', error: '' });
  const [xf, setXf] = useState(null);
  const [xfStatus, setXfStatus] = useState({ available: null, reason: '' });
  const [xfRun, setXfRun] = useState(null);
  const [exportError, setExportError] = useState('');
  const [checked, setChecked] = useState(null);
  const [ofInfo, setOfInfo] = useState(null);
  const [ofRuns, setOfRuns] = useState([]);
  const [ofPolar, setOfPolar] = useState([]);
  // Followed cases by the host's id: {phase, ahead, stageLabel, iteration, rows, startedAt}.
  const [ofLive, setOfLive] = useState({});
  // The case being written (the openfoam_2d job) and queued: {alpha, line}.
  const [ofWrite, setOfWrite] = useState(null);
  const [ofError, setOfError] = useState('');
  const followed = useRef(new Map());
  const ask = useRef(0);
  const fileInput = useRef(null);
  const viewRef = useRef(DEFAULT_VIEW);
  // What the study record holds: inputs are saved only once they pass the checks.
  const stored = useRef(null);

  // Open: the study's settings and view (a new study gets the defaults, saved once), its
  // saved results, and NeuralFoil warmed up in the background.
  useEffect(() => {
    let live = true;
    (async () => {
      const study = await ws.study.get();
      rev = study.rev;
      let current = study.airfoil && study.conditions ? { airfoil: study.airfoil, conditions: study.conditions } : null;
      if (!current) {
        current = await ws.service('defaults', {});
        await saveStudy(current);
      }
      const saved = await ws.service('results', { study_id: STUDY_ID });
      if (!live) return;
      stored.current = current;
      setSettings(current);
      viewRef.current = { ...DEFAULT_VIEW, ...(study.view && typeof study.view === 'object' ? study.view : {}) };
      setViewState(viewRef.current);
      setDraftCode(current.airfoil.source === 'naca' ? current.airfoil.code : '');
      if (saved.neuralfoil) setNf(saved.neuralfoil);
      if (saved.xfoil) setXf(saved.xfoil);
      const runs = (saved.openfoam && saved.openfoam.runs) || [];
      setOfRuns(runs);
      // A case still queued or running when the page last closed: follow it again (the host
      // replays where it is now, or how it ended).
      if (HAS_COMPUTE) for (const run of runs) if (run.compute_id && !FINAL.includes(run.status)) followCase(run);
    })().catch((e) => setInputError(e.message || String(e)));
    ws.service('openfoam_info', {}).then(
      (r) => live && setOfInfo(r),
      () => {},
    );
    ws.service('warmup', {}).then(
      (r) => live && setWarm(r.ready ? { state: 'ready', error: '' } : { state: 'failed', error: r.error }),
      (e) => live && setWarm({ state: 'failed', error: e.message || String(e) }),
    );
    ws.service('xfoil_status', {}).then(
      (r) => live && setXfStatus(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  // Inputs: check them (the preview), then the NeuralFoil polar unless the saved one matches.
  useEffect(() => {
    if (!settings) return;
    const n = ++ask.current;
    (async () => {
      const checked = await ws.service('check', { study_id: STUDY_ID, ...settings });
      if (n !== ask.current) return;
      if (!checked.ok) {
        setInputError(checked.error);
        setInputField(checked.field || null);
        return;
      }
      setInputError('');
      setInputField(null);
      setSection(checked.section);
      const clean = { airfoil: checked.airfoil, conditions: checked.conditions };
      setChecked(clean);
      if (!sameSettings(stored.current, clean)) {
        stored.current = clean;
        saveStudy(clean).catch((e) => ws.ui.toast(`Could not save the study: ${e.message || e}`, { kind: 'error' }));
      }
      if (nf && sameSettings(nf.airfoil, checked.airfoil) && sameSettings(nf.conditions, checked.conditions)) return;
      setNfState({ busy: true, error: '' });
      const polar = await ws.service('neuralfoil_polar', { study_id: STUDY_ID, airfoil: checked.airfoil, conditions: checked.conditions });
      if (n !== ask.current) return;
      if (!polar.ok) {
        setNfState({ busy: false, error: polar.error });
        return;
      }
      setNf(polar);
      setNfState({ busy: false, error: '' });
    })().catch((e) => n === ask.current && setNfState({ busy: false, error: e.message || String(e) }));
  }, [settings]);

  const change = useCallback(
    (patch) => {
      const next = {
        airfoil: patch.replaceAirfoil || { ...settings.airfoil, ...(patch.airfoil || {}) },
        conditions: { ...settings.conditions, ...(patch.conditions || {}) },
      };
      setSettings(next);
    },
    [settings],
  );

  // What the page shows is part of the study too: saved as it changes, restored on reopen.
  const setView = useCallback((patch) => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setViewState(next);
    saveStudy({ view: next }).catch((e) => ws.ui.toast(`Could not save the study: ${e.message || e}`, { kind: 'error' }));
  }, []);

  // OpenFOAM's polar of the checked inputs at the picked mesh: the latest finished run per angle.
  const ofLevel = view.of_level || 'medium';
  useEffect(() => {
    if (!checked) return undefined;
    let live = true;
    ws.service('openfoam_polar', { study_id: STUDY_ID, ...checked, level: ofLevel }).then(
      (r) => live && setOfPolar(r.ok ? r.rows : []),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [checked, ofLevel, ofRuns]);

  // Close every case stream with the page.
  useEffect(
    () => () => {
      for (const stop of followed.current.values()) stop();
      followed.current.clear();
    },
    [],
  );

  const commitCode = () => {
    const code = draftCode.trim();
    if (!code || (settings.airfoil.source === 'naca' && code === settings.airfoil.code)) return;
    const prev = settings.airfoil.source === 'naca' ? settings.airfoil : {};
    setImportNote({ error: '', warnings: [] });
    change({ replaceAirfoil: { source: 'naca', code, points_per_side: prev.points_per_side || 81, closed_te: Boolean(prev.closed_te) } });
  };

  const importDat = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const r = await ws.service('import_dat', { study_id: STUDY_ID, text, filename: file.name });
      if (!r.ok) {
        setImportNote({ error: `${file.name}: ${r.error}`, warnings: [] });
        return;
      }
      setImportNote({ error: '', warnings: r.warnings || [] });
      setDraftCode('');
      change({ replaceAirfoil: r.airfoil });
    } catch (e) {
      setImportNote({ error: `${file.name}: ${e.message || e}`, warnings: [] });
    }
  };

  const runXfoil = async () => {
    setXfRun({ running: true, done: 0, total: 0, alpha: null, error: '', failed: [] });
    try {
      const { id } = await ws.jobs.start('xfoil_polar', { study_id: STUDY_ID });
      const stop = ws.jobs.events(id, (ev) => {
        const d = ev.data || ev;
        if (d.event === 'progress') setXfRun((r) => ({ ...r, done: d.done, total: d.total, alpha: d.alpha }));
        else if (d.event === 'log' && d.line) setXfRun((r) => ({ ...r, failed: [...r.failed, d.line] }));
        else if (d.event === 'error' && d.message) setXfRun((r) => ({ ...r, error: d.message }));
        else if (d.event === 'end') {
          stop();
          ws.service('results', { study_id: STUDY_ID }).then((saved) => {
            if (saved.xfoil) setXf(saved.xfoil);
            setXfRun((r) => ({ ...r, running: false, error: r.error || (d.status === 'done' ? '' : d.error || 'XFOIL did not finish.') }));
          });
        }
      });
    } catch (e) {
      setXfRun({ running: false, done: 0, total: 0, alpha: null, error: e.message || String(e), failed: [] });
    }
  };

  /** Follow one queued or running case: its place in the queue, stages, residuals, and its end. */
  function followCase(run) {
    const id = run.compute_id;
    if (!id || followed.current.has(id)) return;
    const patch = (fn) =>
      setOfLive((all) => ({ ...all, [id]: fn(all[id] || { phase: 'queued', ahead: 0, rows: [], stageLabel: '', iteration: 0 }) }));
    let ended = false;
    let stop = () => {};
    const finish = async (ev) => {
      ended = true;
      stop();
      followed.current.delete(id);
      patch((l) => ({ ...l, phase: ev.status }));
      const r = await ws
        .service('openfoam_collect', { study_id: STUDY_ID, case_rel: run.case_rel, status: ev.status, error: ev.error || '', code: ev.code || '' })
        .catch((e) => ({ ok: false, error: e.message || String(e) }));
      if (r.ok) setOfRuns(r.runs);
      else setOfError(r.error);
    };
    try {
      stop = ws.compute.events(id, (ev) => {
        if (ended) return;
        if (ev.event === 'queued') patch((l) => ({ ...l, phase: 'queued', ahead: Number(ev.ahead) || 0 }));
        else if (ev.event === 'start') patch((l) => ({ ...l, phase: 'running', startedAt: l.startedAt || Date.now() }));
        else if (ev.event === 'stage') patch((l) => ({ ...l, phase: 'running', stageLabel: STAGE_LABEL[ev.stage] || ev.stage }));
        else if (ev.event === 'pre') patch((l) => ({ ...l, stageLabel: `${ev.tool}: ${ev.skipped ? 'skipped' : ev.exit_code === 0 ? 'done' : 'failed'}` }));
        else if (ev.event === 'progress') {
          patch((l) => ({
            ...l,
            phase: 'running',
            startedAt: l.startedAt || Date.now(),
            iteration: Number.isFinite(Number(ev.time)) ? Math.round(Number(ev.time)) : l.iteration,
            rows: addPoints(l.rows, ev.points),
          }));
        } else if (ev.event === 'end') finish(ev);
      });
    } catch (e) {
      setOfError(e.message || String(e));
      return;
    }
    if (ended) stop();
    else followed.current.set(id, stop);
  }

  // OpenFOAM at one angle: the openfoam_2d job meshes the section and writes the case, the
  // host queues it (it may wait for a mesh or a solve), and the page follows it.
  const runOpenfoam = async () => {
    setOfError('');
    const alpha = Number(view.of_alpha);
    setOfWrite({ alpha, line: 'Starting' });
    try {
      await saving;
      const { id } = await ws.jobs.start('openfoam_2d', { study_id: STUDY_ID, alpha, level: ofLevel });
      const written = await new Promise((resolve, reject) => {
        let result = null;
        let error = '';
        const stop = ws.jobs.events(id, (ev) => {
          const d = ev.data || ev;
          if (d.event === 'stage' && d.label) setOfWrite((w) => ({ ...w, line: d.label }));
          // The job's own result names its case; the host adds a 'result' of its own as the job ends.
          else if (d.event === 'result' && d.case_rel) result = d;
          else if (d.event === 'error' && d.message) error = d.message;
          else if (d.event === 'end') {
            stop();
            if (result && d.status === 'done') resolve(result);
            else reject(new Error(error || d.error || 'The case was not written.'));
          }
        });
      });
      setOfWrite((w) => ({ ...w, line: 'Queueing the case' }));
      const queued = await ws.compute.submitOpenFOAM(written.submit);
      const rec = await ws.service('openfoam_record', { study_id: STUDY_ID, case_rel: written.case_rel, compute_id: queued.id });
      if (!rec.ok) throw new Error(rec.error);
      setOfRuns(rec.runs);
      setOfWrite(null);
      followCase({ case_rel: written.case_rel, compute_id: queued.id });
    } catch (e) {
      setOfWrite(null);
      setOfError(e && e.code ? `${e.message || e} (${e.code})` : (e && e.message) || String(e));
    }
  };

  const stopRun = async (run) => {
    try {
      await ws.compute.stop(run.compute_id);
    } catch (e) {
      setOfError(e.message || String(e));
    }
  };

  const deleteRun = async (run) => {
    const yes = await ws.ui.confirm({
      title: `Delete the OpenFOAM run at α = ${deg(run.alpha)}?`,
      message: `Its case folder (${run.case_rel}) and its result go. This cannot be undone.`,
      confirmLabel: 'Delete',
    });
    if (!yes) return;
    const r = await ws
      .service('openfoam_delete', { study_id: STUDY_ID, case_rel: run.case_rel })
      .catch((e) => ({ ok: false, error: e.message || String(e) }));
    if (r.ok) setOfRuns(r.runs);
    else setOfError(r.error);
  };

  const openRun = async (run) => {
    setOfError('');
    try {
      await ws.results.openIn3D(run.case_rel);
    } catch (e) {
      setOfError(e && e.code ? `${e.message || e} (${e.code})` : (e && e.message) || String(e));
    }
  };

  const exportCsv = async () => {
    setExportError('');
    const r = await ws.service('export_csv', { study_id: STUDY_ID }).catch((e) => ({ ok: false, error: e.message || String(e) }));
    if (!r.ok) return setExportError(r.error);
    download(r.filename, r.text, 'text/csv');
  };

  const exportDat = async () => {
    setExportError('');
    const r = await ws
      .service('export_dat', { study_id: STUDY_ID, airfoil: stored.current.airfoil })
      .catch((e) => ({ ok: false, error: e.message || String(e) }));
    if (!r.ok) return setExportError(r.error);
    download(r.filename, r.text, 'text/plain');
  };

  if (!settings) {
    return h(
      'main',
      { className: 'af' },
      inputError ? h(DisabledReason, { reason: inputError, role: 'alert' }) : h(Hint, null, 'Opening the study…'),
    );
  }
  const c = settings.conditions;
  const a = settings.airfoil;
  const engine = ENGINES.some((e) => e.value === view.engine) ? view.engine : 'neuralfoil';
  const xfoilMatches = xf && sameSettings(xf.conditions, stored.current?.conditions) && sameSettings(xf.airfoil, stored.current?.airfoil);
  const ofDoc =
    ofPolar.length && checked ? { engine: 'openfoam', name: ofPolar[0].name, conditions: checked.conditions, level: ofLevel, rows: ofPolar } : null;
  const shown = [nf, xf, ofDoc].filter((d) => d && d.rows && (view.overlay || d.engine === engine));
  const running = Boolean(xfRun && xfRun.running);
  const runReason =
    xfStatus.available === false
      ? { reason: xfStatus.reason }
      : inputError
        ? { reason: `Fix the inputs first: ${inputError}`, fix: goToField(inputField) }
        : null;
  const hasPolar = Boolean((nf && nf.rows.length) || (xf && (xf.rows.length || xf.not_converged.length)) || ofRuns.length);

  const sectionCard = h(
    'section',
    { className: 'af-card af-inputs', 'aria-label': 'Section and conditions' },
    h('h2', null, 'Section'),
    h(
      Field,
      { label: 'NACA', htmlFor: 'af-naca', help: 'A 4-digit or 5-digit designation, such as 2412 or 23012' },
      // The kit has no text input yet: a plain one with the kit input's look and keys (Enter
      // and blur commit, Escape puts the committed designation back).
      h(
        'span',
        { className: 'mgk-type mgk-value-row' },
        h('input', {
          id: 'af-naca',
          className: 'mgk-input mgk-input--wide',
          type: 'text',
          spellCheck: false,
          'aria-label': 'NACA designation',
          'data-af': 'naca',
          value: draftCode,
          placeholder: a.source === 'dat' ? a.name : '2412',
          onChange: (e) => setDraftCode(e.target.value),
          onBlur: commitCode,
          onKeyDown: (e) => {
            if (e.key === 'Enter') commitCode();
            else if (e.key === 'Escape') setDraftCode(a.source === 'naca' ? a.code : '');
          },
        }),
      ),
    ),
    a.source === 'naca'
      ? h(
          'div',
          null,
          h(
            Field,
            { label: 'Points per side', htmlFor: 'af-pps', help: 'Points on each surface, cosine spaced: more points, a finer section' },
            h(NumberUnitInput, {
              id: 'af-pps',
              label: 'Points per side',
              valueSi: a.points_per_side,
              onCommitSi: (v) => change({ airfoil: { points_per_side: Math.round(v) } }),
            }),
          ),
          h(
            Field,
            {
              label: 'Closed trailing edge',
              htmlFor: 'af-closed-te',
              help: 'Off: the NACA formula’s small trailing-edge gap. On: the surfaces meet at the trailing edge',
            },
            h(Toggle, {
              id: 'af-closed-te',
              label: 'Closed trailing edge',
              checked: Boolean(a.closed_te),
              onChange: (v) => change({ airfoil: { closed_te: v } }),
            }),
          ),
        )
      : null,
    h(
      'div',
      { className: 'af-import' },
      h(
        Button,
        { variant: 'secondary', onClick: () => fileInput.current && fileInput.current.click(), attrs: { 'data-af': 'import-dat' } },
        'Import .dat file',
      ),
      h('input', {
        ref: fileInput,
        type: 'file',
        accept: '.dat,.txt',
        hidden: true,
        'data-af': 'import-file',
        onChange: (e) => {
          const f = e.target.files && e.target.files[0];
          e.target.value = '';
          importDat(f);
        },
      }),
      a.source === 'dat' ? h(Hint, null, `Imported: ${a.name}`) : null,
    ),
    importNote.error ? h(DisabledReason, { reason: importNote.error, role: 'alert' }) : null,
    importNote.warnings.length ? h(Hint, { tone: 'warning' }, importNote.warnings.join(' ')) : null,
    h(SectionFacts, { section }),
    h(Outline, { section }),
    h('h2', null, 'Conditions'),
    h(
      Field,
      { label: 'Reynolds number', htmlFor: 'af-re' },
      h(NumberUnitInput, {
        id: 'af-re',
        label: 'Reynolds number',
        valueSi: c.re,
        width: 'wide',
        onCommitSi: (v) => change({ conditions: { re: v } }),
      }),
    ),
    h(
      Field,
      { label: 'Mach number', htmlFor: 'af-mach' },
      h(NumberUnitInput, { id: 'af-mach', label: 'Mach number', valueSi: c.mach, onCommitSi: (v) => change({ conditions: { mach: v } }) }),
    ),
    h(
      Field,
      { label: 'First α', htmlFor: 'af-a0' },
      h(NumberUnitInput, {
        id: 'af-a0',
        label: 'First α',
        unit: '°',
        valueSi: c.alpha_start,
        onCommitSi: (v) => change({ conditions: { alpha_start: v } }),
      }),
    ),
    h(
      Field,
      { label: 'Last α', htmlFor: 'af-a1' },
      h(NumberUnitInput, {
        id: 'af-a1',
        label: 'Last α',
        unit: '°',
        valueSi: c.alpha_end,
        onCommitSi: (v) => change({ conditions: { alpha_end: v } }),
      }),
    ),
    h(
      Field,
      { label: 'α step', htmlFor: 'af-da' },
      h(NumberUnitInput, {
        id: 'af-da',
        label: 'α step',
        unit: '°',
        valueSi: c.alpha_step,
        onCommitSi: (v) => change({ conditions: { alpha_step: v } }),
      }),
    ),
    h('h2', null, 'Transition'),
    h(
      Field,
      { label: 'Ncrit', htmlFor: 'af-ncrit', help: 'The e^N transition criterion: 9 for a clean wind tunnel, lower for a turbulent one' },
      h(NumberUnitInput, { id: 'af-ncrit', label: 'Ncrit', valueSi: c.ncrit, onCommitSi: (v) => change({ conditions: { ncrit: v } }) }),
    ),
    h(
      Field,
      {
        label: 'Forced transition',
        htmlFor: 'af-forced',
        help: 'Trip the boundary layer at a fixed chord position on each surface, as a trip strip does',
      },
      h(Toggle, {
        id: 'af-forced',
        label: 'Forced transition',
        checked: forced(c),
        onChange: (on) => change({ conditions: on ? { xtr_top: DEFAULT_TRIP, xtr_bottom: DEFAULT_TRIP } : { xtr_top: 1, xtr_bottom: 1 } }),
      }),
    ),
    forced(c)
      ? h(
          'div',
          null,
          h(
            Field,
            { label: 'Upper trip x/c', htmlFor: 'af-xtr-top' },
            h(NumberUnitInput, {
              id: 'af-xtr-top',
              label: 'Upper trip x/c',
              valueSi: c.xtr_top,
              onCommitSi: (v) => change({ conditions: { xtr_top: v } }),
            }),
          ),
          h(
            Field,
            { label: 'Lower trip x/c', htmlFor: 'af-xtr-bottom' },
            h(NumberUnitInput, {
              id: 'af-xtr-bottom',
              label: 'Lower trip x/c',
              valueSi: c.xtr_bottom,
              onCommitSi: (v) => change({ conditions: { xtr_bottom: v } }),
            }),
          ),
        )
      : null,
    inputError ? h(DisabledReason, { reason: inputError, role: 'alert' }) : null,
  );

  const neuralfoilPanel = h(
    'div',
    { 'data-af': 'neuralfoil' },
    h(Hint, null, 'NeuralFoil draws the polar again as you change the inputs.'),
    warm.state === 'failed' ? h(DisabledReason, { reason: warm.error, role: 'alert' }) : null,
    nfState.error && nfState.error !== warm.error ? h(DisabledReason, { reason: nfState.error, role: 'alert' }) : null,
    nf
      ? h(
          Hint,
          null,
          `${settingsLabel(nf)} · ${nf.model_size} model · ${Math.round(nf.seconds * 1000)} ms${nfState.busy ? ' · updating…' : ''}`,
        )
      : h(EmptyState, { variant: 'chart' }, nfState.busy || warm.state === 'warming' ? 'Computing the polar…' : 'No NeuralFoil polar yet'),
  );

  const xfoilPanel = h(
    'div',
    { 'data-af': 'xfoil' },
    h(
      'div',
      { className: 'af-run' },
      h(
        Button,
        { variant: 'primary', disabled: Boolean(runReason) || running, onClick: runXfoil, attrs: { 'data-af': 'run-xfoil' } },
        'Run XFOIL',
      ),
    ),
    runReason && !running ? h(DisabledReason, runReason) : null,
    running
      ? h(
          'div',
          { 'data-af': 'xfoil-progress' },
          h(StatusBlock, {
            title: 'Running XFOIL',
            status: 'running',
            line: xfRun.total ? `α = ${deg(xfRun.alpha)} · ${xfRun.done} of ${xfRun.total}` : 'Starting',
          }),
        )
      : null,
    xfRun && xfRun.error ? h(DisabledReason, { reason: xfRun.error, role: 'alert' }) : null,
    xf
      ? h(
          'div',
          null,
          h(
            Hint,
            { tone: xfoilMatches ? 'muted' : 'warning' },
            xfoilMatches
              ? `${settingsLabel(xf)} · ${xf.rows.length} of ${xf.alphas.length} angles converged`
              : 'These results are from other inputs. Run XFOIL again to update them.',
          ),
          xf.not_converged.length
            ? h(
                'ul',
                { className: 'af-failed', 'data-af': 'xfoil-not-converged' },
                xf.not_converged.map((al) => h('li', { key: al }, `α = ${deg(al)}: did not converge`)),
              )
            : null,
        )
      : h(EmptyState, { variant: 'chart' }, 'No XFOIL polar yet'),
  );

  // OpenFOAM 2D: one case per angle, queued on the app's compute slot and run in WSL.
  const ofRange = ofInfo ? ofInfo.re_range : null;
  const ofReAllowed = !ofRange || (c.re >= ofRange[0] && c.re <= ofRange[1]);
  const ofLiveRuns = ofRuns.filter((r) => r.compute_id && ofLive[r.compute_id] && !FINAL.includes(ofLive[r.compute_id].phase));
  const ofShown = ofLiveRuns.find((r) => ofLive[r.compute_id].phase === 'running') || ofLiveRuns[0] || null;
  const ofShownLive = ofShown ? ofLive[ofShown.compute_id] : null;
  const ofLevelInfo = ofInfo ? ofInfo.levels.find((lv) => lv.value === ofLevel) : null;
  let ofReason = null;
  if (!HAS_COMPUTE) {
    ofReason = {
      reason: `This version of Magnusim cannot run OpenFOAM cases for a workspace (it needs host 1.3 or later; this one is ${ws.context.hostVersion}).`,
    };
  } else if (inputError) {
    ofReason = { reason: `Fix the inputs first: ${inputError}`, fix: goToField(inputField) };
  } else if (!ofReAllowed) {
    ofReason = {
      reason: ofInfo.re_reason,
      fix: { label: 'Change the Reynolds number', onFix: () => document.getElementById('af-re')?.focus() },
    };
  } else if (ofInfo && !ofInfo.ready) {
    ofReason = { reason: ofInfo.reason };
  }
  const openfoamPanel = h(
    'div',
    { 'data-af': 'openfoam' },
    h(
      Hint,
      null,
      'One case per angle: Gmsh meshes the section, then OpenFOAM (simpleFoam, k-ω SST) solves it in WSL, queued with the app’s meshes and solves.',
    ),
    c.mach > 0 ? h(Hint, { tone: 'warning' }, 'OpenFOAM 2D is incompressible: the Mach number is not used.') : null,
    h(Hint, null, 'It runs fully turbulent: compare it with XFOIL with forced transition.'),
    h(
      Field,
      { label: 'Angle of attack', htmlFor: 'af-of-alpha' },
      h(NumberUnitInput, {
        id: 'af-of-alpha',
        label: 'Angle of attack',
        unit: '°',
        valueSi: Number(view.of_alpha),
        onCommitSi: (v) => setView({ of_alpha: Math.max(-30, Math.min(30, Math.round(v * 1000) / 1000)) }),
      }),
    ),
    h(
      Field,
      {
        label: 'Mesh',
        htmlFor: 'af-of-level',
        help: ofLevelInfo ? `A structured C-mesh, y+ about 1 at the wall; ${ofLevelInfo.iterations} iterations` : undefined,
      },
      h(Select, {
        id: 'af-of-level',
        label: 'Mesh',
        value: ofLevel,
        options: (ofInfo ? ofInfo.levels : [{ value: 'medium', label: 'Medium' }]).map((lv) => ({ value: lv.value, label: lv.label })),
        onChange: (v) => setView({ of_level: v }),
      }),
    ),
    h(
      'div',
      { className: 'af-run' },
      h(
        Button,
        { variant: 'primary', disabled: Boolean(ofReason) || Boolean(ofWrite), onClick: runOpenfoam, attrs: { 'data-af': 'run-openfoam' } },
        'Run OpenFOAM',
      ),
    ),
    ofReason && !ofWrite ? h(DisabledReason, ofReason) : null,
    ofWrite
      ? h(
          'div',
          { 'data-af': 'openfoam-writing' },
          h(StatusBlock, { title: `Writing the case at α = ${deg(ofWrite.alpha)}`, status: 'writing', line: ofWrite.line }),
        )
      : null,
    ofShown
      ? h(
          'div',
          { 'data-af': 'openfoam-progress' },
          h(
            StatusBlock,
            {
              title: ofShownLive.phase === 'queued' ? 'Waiting in the queue' : 'Running OpenFOAM',
              status: ofShownLive.phase,
              line: `α = ${deg(ofShown.alpha)} · ${runStatus(ofShown, ofShownLive)}`,
              elapsed: ofShownLive.startedAt ? h(Elapsed, { startedAt: ofShownLive.startedAt }) : undefined,
              meta: ofShownLive.phase === 'running' && ofShownLive.stageLabel ? [ofShownLive.stageLabel] : undefined,
            },
            h(ResidualPlot, { rows: ofShownLive.rows, planned: ofLevelInfo ? ofLevelInfo.iterations : undefined }),
          ),
          h(
            'div',
            { className: 'af-run' },
            h(Button, { variant: 'secondary', onClick: () => stopRun(ofShown), attrs: { 'data-af': 'stop-openfoam' } }, 'Stop'),
          ),
        )
      : null,
    ofError ? h(DisabledReason, { reason: ofError, role: 'alert' }) : null,
    h('h3', { className: 'af-subhead' }, 'Runs'),
    h(OpenfoamRuns, { runs: ofRuns, live: ofLive, onOpen: openRun, onStop: stopRun, onDelete: deleteRun, busy: !HAS_COMPUTE }),
  );

  const tableDoc = engine === 'xfoil' ? xf : engine === 'openfoam' ? ofDoc : nf;
  const panels = { neuralfoil: neuralfoilPanel, xfoil: xfoilPanel, openfoam: openfoamPanel };
  const tableTitle = { neuralfoil: 'NeuralFoil polar', xfoil: 'XFOIL polar', openfoam: 'OpenFOAM 2D polar' };
  const tableEmpty = { neuralfoil: 'No NeuralFoil polar yet', xfoil: 'No XFOIL polar yet', openfoam: 'No OpenFOAM polar yet' };
  return h(
    'main',
    { className: 'af' },
    sectionCard,
    h(
      'div',
      { className: 'af-results' },
      h(
        'section',
        { className: 'af-card', 'aria-label': 'Engine', 'data-af': 'engine' },
        h(
          'div',
          { className: 'af-head' },
          h('h2', null, 'Engine'),
          h(Select, { id: 'af-engine', label: 'Engine', value: engine, options: ENGINES, onChange: (v) => setView({ engine: v }) }),
        ),
        panels[engine],
        h(
          Field,
          {
            label: 'Overlay engines',
            htmlFor: 'af-overlay',
            help: 'Draw every engine’s saved polar on the plots, each named with its settings in the legend',
          },
          h(Toggle, {
            id: 'af-overlay',
            label: 'Overlay engines',
            checked: Boolean(view.overlay),
            onChange: (v) => setView({ overlay: v }),
          }),
        ),
      ),
      h(
        'section',
        { className: 'af-card', 'aria-label': 'Plots', 'data-af': 'plots' },
        h('h2', null, 'Plots'),
        h(Plots, { docs: shown, xfDoc: xf, cpAlpha: view.cp_alpha, onCpAlpha: (al) => setView({ cp_alpha: al }) }),
        ofDoc && ofDoc.rows.length === 1 && shown.includes(ofDoc)
          ? h(
              Hint,
              null,
              `OpenFOAM 2D has one angle so far (α = ${deg(ofDoc.rows[0].alpha)}): its numbers are in its table. Run another angle to draw its line.`,
            )
          : null,
      ),
      h(
        'section',
        { className: 'af-card', 'aria-label': 'Polar table', 'data-af': 'table' },
        h(
          'div',
          { className: 'af-head' },
          h('h2', null, tableTitle[engine]),
          h(
            'div',
            { className: 'af-toolbar' },
            h(
              Button,
              { variant: 'secondary', disabled: !hasPolar, onClick: exportCsv, attrs: { 'data-af': 'export-csv' } },
              'Export all polars (CSV)',
            ),
            h(Button, { variant: 'secondary', disabled: !section, onClick: exportDat, attrs: { 'data-af': 'export-dat' } }, 'Export .dat'),
          ),
        ),
        !hasPolar
          ? h(DisabledReason, {
              reason: 'No polar to export yet.',
              fix:
                xfStatus.available && !runReason
                  ? {
                      label: 'Run XFOIL',
                      onFix: () => {
                        setView({ engine: 'xfoil' });
                        runXfoil();
                      },
                    }
                  : undefined,
            })
          : null,
        exportError ? h(DisabledReason, { reason: exportError, role: 'alert' }) : null,
        tableDoc
          ? h(PolarTable, { rows: tableDoc.rows, engine, notConverged: engine === 'xfoil' ? tableDoc.not_converged : [] })
          : h(EmptyState, { variant: 'chart' }, tableEmpty[engine]),
      ),
    ),
  );
}

createRoot(document.getElementById('root')).render(h(App));
