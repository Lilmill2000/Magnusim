// Presets: the toolbar's picker, and the panel that shows what a preset is, the published
// values it should give and what this run measures, live.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Hint, Select } from '@magnusim/plugin-ui';
import type { Workspace } from '@magnusim/workspace';
import { useEffect, useState } from 'react';
import { PRESETS, matchesPreset, presetById, type Preset, type Range } from '../scene/presets';
import { referenceLength } from '../geometry/shapes';
import type { Engine, Measurement } from '../sim/engine';
import { useStore, type Store } from '../app/store';

/** The toolbar's picker: a preset replaces the scene (Undo brings the old one back). */
export function PresetPicker({ store, engine, ws }: { store: Store; engine: Engine; ws: Workspace }) {
  return (
    <Select
      label="Presets"
      value=""
      options={[{ value: '', label: 'Presets…' }, ...PRESETS.map((p) => ({ value: p.id, label: p.title }))]}
      onChange={(id) => {
        const p = presetById(id);
        if (!p) return;
        store.commit(p.build());
        store.select(null);
        engine.resetFlow();
        void ws.ui.toast(`${p.title}. Undo (Ctrl+Z) brings your tunnel back.`, { kind: 'info' });
      }}
    />
  );
}

const fmt = (v: number, d = 3) => v.toFixed(d);

function Row({ label, value, range, digits, attr }: { label: string; value: number | null; range: Range; digits: number; attr: string }) {
  const inside = value != null && value >= range[0] && value <= range[1];
  // Off by how much (relative to the nearer end of the published range).
  const off = value == null || inside ? null : (value < range[0] ? value / range[0] - 1 : value / range[1] - 1) * 100;
  return (
    <tr data-t2d-preset-row={attr} data-value={value ?? ''} data-within={inside ? 'yes' : value == null ? '' : 'no'}>
      <th scope="row">{label}</th>
      <td>{value == null ? '…' : fmt(value, digits)}</td>
      <td>
        {fmt(range[0], digits)} – {fmt(range[1], digits)}
      </td>
      <td className="t2d-preset-off">{off == null ? '' : `${off > 0 ? '+' : ''}${off.toFixed(1)} %`}</td>
    </tr>
  );
}

/** The panel for the preset the scene was started from (none: nothing shown). */
export function PresetPanel({ store, engine }: { store: Store; engine: Engine }) {
  const scene = useStore(store, (s) => s.scene);
  const p: Preset | null = presetById(scene.preset);
  const [m, setM] = useState<Measurement | null>(null);
  const [wake, setWake] = useState<number | null>(null);
  const body = scene.bodies.find((b) => b.enabled) ?? null;
  useEffect(() => {
    if (!p || !body) return;
    let alive = true;
    const tick = async () => {
      const D = referenceLength(body.shape);
      const tc = D / scene.flow.speed;
      setM(engine.measure(body.id, p.window * tc));
      if (p.refs.wake) {
        const w = await engine.wakeLength(body.id);
        if (alive) setWake(w);
      }
    };
    const t = window.setInterval(() => void tick(), 500);
    void tick();
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [p, body, engine, scene.flow.speed]);
  if (!p || !body) return null;
  const same = matchesPreset(scene, p);
  const map = engine.lattice;
  const exact = map && !map.capped && engine.flowModel === 'off';
  const tc = referenceLength(body.shape) / scene.flow.speed;
  const settled = m ? Math.min(1, m.since / (p.settle * tc)) : 0;
  const show = settled >= 1 ? m : null;
  return (
    <section className="t2d-section" data-t2d-section="preset" data-t2d-preset={p.id} data-settled={settled >= 1 ? 'yes' : 'no'}>
      <h2 className="t2d-section-title">{p.title}</h2>
      <div className="t2d-section-body">
        <p className="t2d-preset-summary">{p.summary}</p>
        {!same ? (
          <Hint tone="warning">The setup has been changed from the preset (the flow, the tunnel or the body): the published values below no longer apply.</Hint>
        ) : exact ? (
          <Hint>
            <span data-t2d-preset-exact>The grid resolves this Reynolds number: the flow runs as it is, with no model, so it is the real flow in two dimensions.</span>
          </Hint>
        ) : (
          <Hint tone="warning">The flow is not resolved at this setting, so the published values below do not apply. (A coarser resolution or the turbulence model changes it.)</Hint>
        )}
        {p.caveat ? <Hint tone="warning">{p.caveat}</Hint> : null}
        <table className="t2d-preset-table">
          <thead>
            <tr>
              <th />
              <th scope="col">This run</th>
              <th scope="col">Published</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {p.refs.st ? <Row label="Strouhal number" value={show?.st ?? null} range={p.refs.st} digits={3} attr="st" /> : null}
            {p.refs.cd ? <Row label="Drag coefficient" value={show?.cd ?? null} range={p.refs.cd} digits={2} attr="cd" /> : null}
            {p.refs.clAmp ? <Row label="Lift swing (±)" value={show?.clAmp ?? null} range={p.refs.clAmp} digits={2} attr="clAmp" /> : null}
            {p.refs.wake ? <Row label="Wake length (diameters)" value={settled >= 1 ? wake : null} range={p.refs.wake} digits={2} attr="wake" /> : null}
          </tbody>
        </table>
        <p className="t2d-preset-note">
          {settled < 1 ? `Settling: ${Math.round(settled * 100)} % of ${p.settle} passes of the flow past the body before measuring. ` : `Measured over the last ${p.window} passes. `}
          Published: {p.sources}
        </p>
      </div>
    </section>
  );
}
