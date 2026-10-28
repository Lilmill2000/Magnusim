// The tunnel page: toolbar, side panels, the view with its legend and status line.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Button, ColorLegend, DisabledReason, type UnitSystem } from '@magnusim/plugin-ui';
import type { Workspace } from '@magnusim/workspace';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { hasOutline, referenceLength } from '../geometry/shapes';
import type { FieldMode, Scene } from '../scene/scene';
import { particleMap, type Engine } from '../sim/engine';
import { mapRgb, type MapName } from '../render/renderer';
import { BodiesPanel, BodyPanel, TunnelPanel, ViewPanel, WindPanel, fmtRe } from '../ui/panels';
import { MarkersPanel, RakePanel, rakeName } from '../ui/markers';
import { Viewport, fitView } from '../ui/Viewport';
import { PresetPanel, PresetPicker } from '../ui/presets';
import { DimensionInput, SketchBar } from '../ui/sketchbar';
import type { SketchEditor } from '../sketch/editor';
import type { SweepHost } from '../sim/sweep';
import type { ProbeFeed } from '../ui/probeFeed';
import { ForcesPanel, SurfacePanel, SweepPanel } from '../ui/forces';
import { ProbePanel, ProbesPanel } from '../ui/probes';
import { ShortcutsHelp } from '../ui/shortcuts';
import { Capture, type LegendSpec } from './capture';
import { exposeCapture } from './debug';
import { useWorkspaceUnits } from './hooks';
import { FLUIDS } from '../scene/scene';
import { useStore, type Store } from './store';

/** The legend's title, unit and the factor from the dimensionless field to it. */
function legendFor(field: FieldMode, scene: Scene, lRefM: number): { title: string; unit: string; k: number; centred: boolean } {
  const U = scene.flow.speed;
  switch (field) {
    case 'vorticity':
      return { title: 'Vorticity', unit: '1/s', k: U / lRefM, centred: true };
    case 'speed':
      return { title: 'Speed', unit: 'm/s', k: U, centred: false };
    case 'pressure':
      return { title: 'Pressure coefficient Cp', unit: '', k: 1, centred: true };
    case 'schlieren':
      return { title: 'Density gradient (relative)', unit: '', k: 1, centred: false };
    case 'particles':
      return scene.view.particleColor === 'vorticity' ? { title: 'Vorticity', unit: '1/s', k: U / lRefM, centred: true } : { title: 'Speed', unit: 'm/s', k: U, centred: false };
    case 'none':
    case 'rheoscopic':
      return { title: '', unit: '', k: 1, centred: false };
  }
}

/** The legend as the view shows it now (for captures), or null when no field is shown. */
function legendNow(engine: Engine, scene: Scene): LegendSpec | null {
  if (scene.view.field === 'none' || scene.view.field === 'rheoscopic') return null;
  const first = scene.bodies.find((b) => b.enabled && hasOutline(b.shape));
  const lg = legendFor(scene.view.field, scene, first ? referenceLength(first.shape) : scene.tunnel.height / 8);
  const auto = engine.autoRangeNow;
  const lo = scene.view.autoRange ? (auto?.lo ?? scene.view.min / lg.k) : scene.view.min / lg.k;
  const hi = scene.view.autoRange ? (auto?.hi ?? scene.view.max / lg.k) : scene.view.max / lg.k;
  return { title: lg.title, unit: lg.unit, lo: lo * lg.k, hi: hi * lg.k, rgb: mapRgb(particleMap(scene.view)) };
}

/** A capture's caption: what is in the tunnel and what it runs at. */
function captionNow(engine: Engine, scene: Scene): string {
  const first = scene.bodies.find((b) => b.enabled && hasOutline(b.shape));
  const re = first ? engine.reynoldsFor(first) : null;
  const t = engine.stats.simTime;
  const parts = [
    first ? first.name : '',
    `${fmtRe(scene.flow.speed)} m/s, ${FLUIDS[scene.flow.fluid].label}`,
    re ? (engine.flowModel === 'sa' ? `Re ${fmtRe(re.real)}, turbulence model` : engine.lattice?.capped ? `Re (sim) ${fmtRe(re.sim)} of ${fmtRe(re.real)}` : `Re ${fmtRe(re.real)}`) : '',
    `t = ${t < 1 ? `${(t * 1000).toPrecision(3)} ms` : `${t.toPrecision(4)} s`}`,
    'Magnusim 2D Wind Tunnel',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** The ordered views the number keys pick (the View panel's order). */
const FIELD_KEYS: FieldMode[] = ['particles', 'vorticity', 'speed', 'pressure', 'schlieren', 'rheoscopic', 'none'];

function RecordButton({ capture, onError }: { capture: Capture; onError: (m: string) => void }) {
  useSyncExternalStore(
    (fn) => capture.subscribe(fn),
    () => capture.version,
  );
  useTicker(500);
  const rec = capture.recording;
  const secs = rec ? Math.floor((performance.now() - rec.since) / 1000) : 0;
  return (
    <Button
      variant={rec ? 'danger' : 'neutral'}
      disabled={!rec && !capture.canRecord}
      title={capture.canRecord ? 'Shift+C' : 'This browser cannot record the view'}
      attrs={{ 'data-t2d-record': rec ? 'on' : 'off' }}
      onClick={() => {
        if (rec) capture.stopRecording();
        else {
          const why = capture.startRecording();
          if (why) onError(why);
        }
      }}
    >
      {rec ? `Stop recording ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : 'Record'}
    </Button>
  );
}

function useTicker(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function StatusLine({ engine, store }: { engine: Engine; store: Store }) {
  useTicker(300);
  const save = useStore(store, (s) => s.save);
  const s = engine.stats;
  const saveText = { saved: 'Saved', pending: 'Not saved yet', saving: 'Saving…', failed: 'Not saved', conflict: 'Saved elsewhere' }[save];
  return (
    <div className="t2d-status" data-t2d-status data-state={s.state} data-steps={s.stepsPerFrame} data-grid={`${s.nx}x${s.ny}`}>
      <span title="The GPU the flow runs on">{s.adapter}</span>
      <span>
        {s.nx} × {s.ny} cells
      </span>
      <span>{s.stepsPerFrame} steps a frame</span>
      <span title="Simulated seconds per second">{s.state === 'running' ? `×${fmtRe(s.speedRatio)} real time` : s.state === 'paused' ? 'Paused' : 'Stopped'}</span>
      {performance.now() - engine.limitedAt < 2000 ? (
        <span className="t2d-squeeze" data-t2d-squeeze title="Where the flow went faster, or was squeezed harder, than the lattice can carry (a body dragged fast, or a gap closing between bodies), it is held to those limits there, so the flow at that spot is approximate.">
          Flow held to its limits where it moved too fast
        </span>
      ) : null}
      <span data-t2d-simtime={s.simTime}>t = {s.simTime < 1 ? `${(s.simTime * 1000).toPrecision(3)} ms` : `${s.simTime.toPrecision(4)} s`}</span>
      <span className={`t2d-save t2d-save--${save}`} data-t2d-save={save}>
        {saveText}
      </span>
    </div>
  );
}

function Legend({ engine, store }: { engine: Engine; store: Store }) {
  useTicker(400);
  const scene = useStore(store, (s) => s.scene);
  const first = scene.bodies.find((b) => b.enabled && hasOutline(b.shape));
  const lRef = first ? referenceLength(first.shape) : scene.tunnel.height / 8;
  const lg = legendFor(scene.view.field, scene, lRef);
  const auto = engine.autoRangeNow;
  const lo = scene.view.autoRange ? (auto?.lo ?? scene.view.min / lg.k) : scene.view.min / lg.k;
  const hi = scene.view.autoRange ? (auto?.hi ?? scene.view.max / lg.k) : scene.view.max / lg.k;
  useEffect(() => {
    if (!scene.view.autoRange) engine.setRange(scene.view.min / lg.k, scene.view.max / lg.k);
  }, [engine, scene.view.autoRange, scene.view.min, scene.view.max, lg.k]);
  // No field shown: no legend (after the hooks, which run on every render).
  if (scene.view.field === 'none' || scene.view.field === 'rheoscopic') return null;
  const map = particleMap(scene.view);
  return (
    <div className="t2d-legend" data-t2d-legend data-lo={lo * lg.k} data-hi={hi * lg.k}>
      {map === 'inferno' ? (
        <MapLegend map={map} min={lo * lg.k} max={hi * lg.k} title={lg.title} unit={lg.unit} />
      ) : (
        <ColorLegend map={map} min={lo * lg.k} max={hi * lg.k} title={lg.title} unit={lg.unit} centred={lg.centred} ticks={5} format={fmtRe} />
      )}
      {!scene.view.autoRange ? (
        <RangeInputs
          lo={scene.view.min}
          hi={scene.view.max}
          onCommit={(min, max) => store.commit({ ...scene, view: { ...scene.view, min, max } }, false)}
        />
      ) : null}
    </div>
  );
}

/** A colour bar for a map the UI kit does not carry (inferno), in the kit legend's layout. */
function MapLegend({ map, min, max, title, unit }: { map: MapName; min: number; max: number; title: string; unit: string }) {
  const rgb = mapRgb(map);
  const stops = Array.from({ length: 9 }, (_, i) => {
    const j = Math.round((i / 8) * 255);
    return `rgb(${rgb[3 * j]}, ${rgb[3 * j + 1]}, ${rgb[3 * j + 2]}) ${(i / 8) * 100}%`;
  });
  const ticks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);
  return (
    <div className="t2d-maplegend">
      <div className="mgk-legend-title">
        {title}
        {unit ? ` (${unit})` : ''}
      </div>
      <div className="mgk-legend-bar" style={{ background: `linear-gradient(to right, ${stops.join(', ')})` }} />
      <div className="mgk-legend-ticks">
        {ticks.map((t, i) => (
          <span key={i}>{fmtRe(t)}</span>
        ))}
      </div>
    </div>
  );
}

function RangeInputs({ lo, hi, onCommit }: { lo: number; hi: number; onCommit: (lo: number, hi: number) => void }) {
  const [a, setA] = useState(String(lo));
  const [b, setB] = useState(String(hi));
  useEffect(() => {
    setA(String(lo));
    setB(String(hi));
  }, [lo, hi]);
  const apply = () => {
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y) && y > x) onCommit(x, y);
    else {
      setA(String(lo));
      setB(String(hi));
    }
  };
  return (
    <div className="t2d-range">
      <input className="mgk-input" aria-label="Colour range minimum" value={a} onChange={(e) => setA(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === 'Enter' && apply()} />
      <span>to</span>
      <input className="mgk-input" aria-label="Colour range maximum" value={b} onChange={(e) => setB(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === 'Enter' && apply()} />
    </div>
  );
}

export function App({
  ws,
  store,
  engine,
  editor,
  probes,
  sweeps,
  units: units0,
  problem,
}: {
  ws: Workspace;
  store: Store;
  engine: Engine;
  editor: SketchEditor;
  probes: ProbeFeed;
  sweeps: SweepHost;
  units: UnitSystem;
  problem: string;
}) {
  const units = useWorkspaceUnits(ws, units0);
  const [paused, setPaused] = useState(false);
  const [unstable, setUnstable] = useState(false);
  const [hint, setHint] = useState('');
  const save = useStore(store, (s) => s.save);
  const saveError = useStore(store, (s) => s.saveError);
  const selectedRake = useStore(store, (s) => s.scene.rakes.find((r) => r.id === s.selected) ?? null);
  const selectedProbe = useStore(store, (s) => s.scene.probes.find((p) => p.id === s.selected) ?? null);
  const selectedBody = useStore(store, (s) => s.scene.bodies.find((b) => b.id === s.selected) ?? null);
  // Selecting another body (or the sketch body going: undo, remove) ends the edit.
  useEffect(
    () =>
      store.subscribe(() => {
        if (!editor.bodyId) return;
        const { scene, selected } = store.get();
        if (selected !== editor.bodyId || !scene.bodies.some((b) => b.id === editor.bodyId && b.shape.kind === 'sketch')) editor.close();
      }),
    [editor, store],
  );
  const [help, setHelp] = useState(false);
  const [capture] = useState(
    () =>
      new Capture(
        engine,
        () => legendNow(engine, store.get().scene),
        () => captionNow(engine, store.get().scene),
      ),
  );
  useEffect(() => exposeCapture(capture), [capture]);
  const picture = () => {
    void capture
      .screenshot()
      .then((name) => ws.ui.toast(`Saved the view as ${name}.`, { kind: 'success' }))
      .catch((err) => ws.ui.toast(String(err instanceof Error ? err.message : err), { kind: 'error' }));
  };
  const toggleRecording = () => {
    if (capture.recording) capture.stopRecording();
    else {
      const why = capture.startRecording();
      if (why) void ws.ui.toast(why, { kind: 'error' });
    }
  };
  const undo = () => {
    store.undo();
    editor.resync();
  };
  const redo = () => {
    store.redo();
    editor.resync();
  };
  useEffect(() => {
    engine.onUnstable = () => {
      setUnstable(true);
      void ws.ui.toast('The flow became unstable and was stopped. Reset the flow to start again.', { kind: 'error' });
    };
    return () => {
      engine.onUnstable = null;
    };
  }, [engine, ws]);

  const togglePause = () => {
    engine.paused = !engine.paused;
    setPaused(engine.paused);
  };
  const resetFlow = () => {
    engine.resetFlow();
    setUnstable(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (editor.editing && e.key !== ' ') {
        // Sketching: Escape, Enter and Delete are the sketch's (never the body's).
        if (editor.key(e.key)) e.preventDefault();
      } else if (e.key === ' ' && !mod) {
        e.preventDefault();
        togglePause();
      } else if (e.key === '?' && !mod) {
        e.preventDefault();
        setHelp((h) => !h);
      } else if (!mod && !e.altKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        resetFlow();
      } else if (!mod && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        fitView(engine, store.get().scene);
      } else if (!mod && e.key === '.') {
        e.preventDefault();
        engine.stepOnce();
      } else if (!mod && !e.altKey && e.key === 'c') {
        e.preventDefault();
        picture();
      } else if (!mod && !e.altKey && e.key === 'C') {
        e.preventDefault();
        toggleRecording();
      } else if (!mod && !e.altKey && /^[1-7]$/.test(e.key)) {
        e.preventDefault();
        const s = store.get().scene;
        store.commit({ ...s, view: { ...s.view, field: FIELD_KEYS[Number(e.key) - 1] } }, false);
      } else if (!mod && (e.code === 'BracketLeft' || e.code === 'BracketRight') && store.get().selected) {
        const s = store.get().scene;
        const b = s.bodies.find((x) => x.id === store.get().selected);
        if (!b || b.locked) return;
        e.preventDefault();
        // ] raises the leading side (the angle's positive sense), [ lowers it.
        const d = (e.code === 'BracketRight' ? 1 : -1) * (e.shiftKey ? 10 : 1);
        store.updateBody(b.id, { angle: Math.max(-180, Math.min(180, Math.round((b.angle + d) * 1000) / 1000)) });
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && store.get().selected) {
        e.preventDefault();
        const s = store.get().scene;
        const b = s.bodies.find((x) => x.id === store.get().selected);
        const r = s.rakes.find((x) => x.id === store.get().selected);
        const pr = s.probes.find((x) => x.id === store.get().selected);
        if (pr) store.commit({ ...s, probes: s.probes.filter((x) => x.id !== pr.id) });
        else if (b) {
          store.commit({ ...s, bodies: s.bodies.filter((x) => x.id !== b.id) });
          void ws.ui.toast(`Removed ${b.name}. Undo (Ctrl+Z) brings it back.`, { kind: 'info' });
        } else if (r) {
          store.commit({ ...s, rakes: s.rakes.filter((x) => x.id !== r.id) });
          void ws.ui.toast(`Removed ${rakeName(s, r)}. Undo (Ctrl+Z) brings it back.`, { kind: 'info' });
        }
      } else if (e.key === 'Escape') {
        store.select(null);
      } else if (e.key.startsWith('Arrow') && store.get().selected) {
        const s = store.get().scene;
        const b = s.bodies.find((x) => x.id === store.get().selected);
        if (!b || b.locked) return;
        e.preventDefault();
        const step = (s.tunnel.height / 200) * (e.shiftKey ? 10 : 1);
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key] ?? [0, 0];
        store.updateBody(b.id, { x: Math.min(s.tunnel.length, Math.max(0, b.x + d[0])), y: Math.min(s.tunnel.height, Math.max(0, b.y + d[1])) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="t2d-app" data-t2d-app>
      <header className="t2d-toolbar" role="toolbar" aria-label="Tunnel">
        <Button variant={paused ? 'primary' : 'secondary'} onClick={togglePause} attrs={{ 'data-t2d-play': paused ? 'paused' : 'running' }} title="Space">
          {paused ? 'Run' : 'Pause'}
        </Button>
        <Button variant="neutral" onClick={resetFlow} attrs={{ 'data-t2d-reset': '1' }} title="Start the flow again from a uniform stream (R)">
          Reset flow
        </Button>
        <span className="t2d-sep" />
        <Button variant="neutral" onClick={undo} disabled={!store.canUndo} title="Ctrl+Z" attrs={{ 'data-t2d-undo': '1' }}>
          Undo
        </Button>
        <Button variant="neutral" onClick={redo} disabled={!store.canRedo} title="Ctrl+Y" attrs={{ 'data-t2d-redo': '1' }}>
          Redo
        </Button>
        <Button variant="neutral" onClick={() => fitView(engine, store.get().scene)} title="F, or double-click empty space" attrs={{ 'data-t2d-fit': '1' }}>
          Fit view
        </Button>
        <Button variant="neutral" onClick={() => engine.stepOnce()} disabled={!paused} title="Run one frame of the paused flow (.)" attrs={{ 'data-t2d-step': '1' }}>
          Step
        </Button>
        <span className="t2d-sep" />
        <Button variant="neutral" onClick={picture} title="Save a picture of the view (C)" attrs={{ 'data-t2d-picture': '1' }}>
          Picture
        </Button>
        <RecordButton capture={capture} onError={(m) => void ws.ui.toast(m, { kind: 'error' })} />
        <Button variant="neutral" onClick={() => setHelp((h) => !h)} title="Keyboard shortcuts (?)" attrs={{ 'data-t2d-shortcuts-open': '1' }}>
          Shortcuts
        </Button>
        <span className="t2d-sep" />
        <PresetPicker store={store} engine={engine} ws={ws} />
        <span className="t2d-toolbar-hint" data-t2d-hint>
          {hint}
        </span>
      </header>
      <div className="t2d-main">
        <aside className="t2d-side">
          <PresetPanel store={store} engine={engine} />
          <WindPanel store={store} engine={engine} units={units} />
          <BodiesPanel store={store} ws={ws} editor={editor} />
          <MarkersPanel store={store} ws={ws} />
          <ProbesPanel store={store} feed={probes} units={units} />
          <TunnelPanel store={store} engine={engine} units={units} />
          <ViewPanel store={store} />
        </aside>
        <div className="t2d-stage">
          {problem ? (
            <div className="t2d-banner">
              <DisabledReason reason={`The saved tunnel could not be read (${problem}), so a new one was started.`} role="alert" />
            </div>
          ) : null}
          {save === 'conflict' || save === 'failed' ? (
            <div className="t2d-banner" data-t2d-save-problem>
              <DisabledReason reason={save === 'conflict' ? saveError : `The tunnel could not be saved: ${saveError}`} role="alert" />
            </div>
          ) : null}
          {unstable ? (
            <div className="t2d-banner" data-t2d-unstable>
              <DisabledReason reason="The flow became unstable and was stopped." fix={{ label: 'Reset flow', onFix: resetFlow }} role="alert" />
            </div>
          ) : null}
          <Viewport engine={engine} store={store} editor={editor} capture={capture} units={units} onStatus={setHint} />
          <SketchBar editor={editor} />
          {help ? <ShortcutsHelp onClose={() => setHelp(false)} /> : null}
          <DimensionInput editor={editor} />
          <Legend engine={engine} store={store} />
          <StatusLine engine={engine} store={store} />
        </div>
        <aside className="t2d-side t2d-side--right">
          {selectedRake ? (
            <RakePanel store={store} ws={ws} units={units} rake={selectedRake} />
          ) : selectedProbe ? (
            <ProbePanel store={store} feed={probes} units={units} probe={selectedProbe} />
          ) : (
            <>
              <BodyPanel store={store} ws={ws} units={units} engine={engine} editor={editor} />
              {selectedBody ? (
                <>
                  <ForcesPanel engine={engine} store={store} body={selectedBody} units={units} />
                  <SurfacePanel engine={engine} store={store} body={selectedBody} />
                  <SweepPanel engine={engine} store={store} body={selectedBody} host={sweeps} />
                </>
              ) : null}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
