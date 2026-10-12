// The tunnel page: toolbar, side panels, the view with its legend and status line.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Button, ColorLegend, DisabledReason, type UnitSystem } from '@magnusim/plugin-ui';
import type { Workspace } from '@magnusim/workspace';
import { useEffect, useState } from 'react';
import { referenceLength } from '../geometry/shapes';
import type { FieldMode, Scene } from '../scene/scene';
import { FIELD_COLORMAP, type Engine } from '../sim/engine';
import { BodiesPanel, BodyPanel, TunnelPanel, ViewPanel, WindPanel, fmtRe } from '../ui/panels';
import { MarkersPanel, RakePanel, rakeName } from '../ui/markers';
import { Viewport, fitView } from '../ui/Viewport';
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
    case 'none':
      return { title: '', unit: '', k: 1, centred: false };
  }
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
        <span className="t2d-squeeze" data-t2d-squeeze title="Flow squeezed between bodies that touch or close a gap is held to equilibrium there, so the flow in that gap is approximate.">
          Bodies close a gap: flow there approximated
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
  const first = scene.bodies.find((b) => b.enabled);
  const lRef = first ? referenceLength(first.shape) : scene.tunnel.height / 8;
  const lg = legendFor(scene.view.field, scene, lRef);
  const auto = engine.autoRangeNow;
  const lo = scene.view.autoRange ? (auto?.lo ?? scene.view.min / lg.k) : scene.view.min / lg.k;
  const hi = scene.view.autoRange ? (auto?.hi ?? scene.view.max / lg.k) : scene.view.max / lg.k;
  useEffect(() => {
    if (!scene.view.autoRange) engine.setRange(scene.view.min / lg.k, scene.view.max / lg.k);
  }, [engine, scene.view.autoRange, scene.view.min, scene.view.max, lg.k]);
  // No field shown: no legend (after the hooks, which run on every render).
  if (scene.view.field === 'none') return null;
  return (
    <div className="t2d-legend" data-t2d-legend data-lo={lo * lg.k} data-hi={hi * lg.k}>
      <ColorLegend map={FIELD_COLORMAP[scene.view.field]} min={lo * lg.k} max={hi * lg.k} title={lg.title} unit={lg.unit} centred={lg.centred} ticks={5} format={fmtRe} />
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

export function App({ ws, store, engine, units: units0, problem }: { ws: Workspace; store: Store; engine: Engine; units: UnitSystem; problem: string }) {
  const [units, setUnits] = useState<UnitSystem>(units0);
  const [paused, setPaused] = useState(false);
  const [unstable, setUnstable] = useState(false);
  const [hint, setHint] = useState('');
  const save = useStore(store, (s) => s.save);
  const saveError = useStore(store, (s) => s.saveError);
  const selectedRake = useStore(store, (s) => s.scene.rakes.find((r) => r.id === s.selected) ?? null);
  useEffect(() => ws.on('units', setUnits), [ws]);
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
        store.undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        store.redo();
      } else if (e.key === ' ' && !mod) {
        e.preventDefault();
        togglePause();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && store.get().selected) {
        e.preventDefault();
        const s = store.get().scene;
        const b = s.bodies.find((x) => x.id === store.get().selected);
        const r = s.rakes.find((x) => x.id === store.get().selected);
        if (b) {
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
        <Button variant="neutral" onClick={resetFlow} attrs={{ 'data-t2d-reset': '1' }} title="Start the flow again from a uniform stream">
          Reset flow
        </Button>
        <span className="t2d-sep" />
        <Button variant="neutral" onClick={() => store.undo()} disabled={!store.canUndo} title="Ctrl+Z" attrs={{ 'data-t2d-undo': '1' }}>
          Undo
        </Button>
        <Button variant="neutral" onClick={() => store.redo()} disabled={!store.canRedo} title="Ctrl+Y" attrs={{ 'data-t2d-redo': '1' }}>
          Redo
        </Button>
        <Button variant="neutral" onClick={() => fitView(engine, store.get().scene)} title="Double-click empty space" attrs={{ 'data-t2d-fit': '1' }}>
          Fit view
        </Button>
        <span className="t2d-toolbar-hint" data-t2d-hint>
          {hint}
        </span>
      </header>
      <div className="t2d-main">
        <aside className="t2d-side">
          <WindPanel store={store} engine={engine} units={units} />
          <BodiesPanel store={store} ws={ws} />
          <MarkersPanel store={store} ws={ws} />
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
          <Viewport engine={engine} store={store} onStatus={setHint} />
          <Legend engine={engine} store={store} />
          <StatusLine engine={engine} store={store} />
        </div>
        <aside className="t2d-side t2d-side--right">
          {selectedRake ? <RakePanel store={store} ws={ws} units={units} rake={selectedRake} /> : <BodyPanel store={store} ws={ws} units={units} engine={engine} />}
        </aside>
      </div>
    </div>
  );
}
