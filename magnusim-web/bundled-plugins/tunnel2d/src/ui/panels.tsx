// The side panels: wind, tunnel, bodies, view; and the selected body's properties.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Button, Field, Hint, Icon, NumberUnitInput, Select, Toggle, fromSi, type UnitSystem } from '@magnusim/plugin-ui';
import type { Workspace } from '@magnusim/workspace';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DatError, parseDat } from '../geometry/datfile';
import { NacaError, parseCode } from '../geometry/naca';
import { outline, referenceLength, shapeLabel, type Shape } from '../geometry/shapes';
import { radius } from '../geometry/polygon';
import { FLUIDS, LIMITS, newBodyId, type Body, type FieldMode, type FlowModel, type RefineLevels, type Resolution, type Scene, type Walls } from '../scene/scene';
import { RESOLUTION_CELLS, gridFor, type Engine } from '../sim/engine';
import { useStore, type Store } from '../app/store';

const fmt3 = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });
export const fmtRe = (v: number) => fmt3.format(v);

function Section({ title, children, attr }: { title: string; children: ReactNode; attr?: string }) {
  return (
    <section className="t2d-section" data-t2d-section={attr ?? title.toLowerCase()}>
      <h2 className="t2d-section-title">{title}</h2>
      <div className="t2d-section-body">{children}</div>
    </section>
  );
}

const lengthUnit = (units: UnitSystem) => (units === 'imperial' ? 'ft' : 'm');

function TextField({ label, value, onCommit, error, attr }: { label: string; value: string; onCommit: (v: string) => void; error?: string; attr?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <span className="mgk-type mgk-value-row">
      <input
        className="mgk-input mgk-input--wide"
        aria-label={label}
        value={text}
        data-t2d-text={attr}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onCommit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(value);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------------------

/** How close the turbulence model's lift is with this many cells across a body (measured: NACA 0012 and 2412, R1/R2 reports). */
function liftBand(cells: number | null): number {
  if (cells == null || cells < 150) return 10;
  if (cells < 250) return 5;
  return 3;
}

export function WindPanel({ store, engine, units }: { store: Store; engine: Engine; units: UnitSystem }) {
  const scene = useStore(store, (s) => s.scene);
  const selected = useStore(store, (s) => s.selected);
  const [, tick] = useState(0);
  useEffect(() => engine.subscribe(() => tick((n) => n + 1)), [engine]);
  const set = (flow: Partial<Scene['flow']>) => store.commit({ ...scene, flow: { ...scene.flow, ...flow } });
  const ref = scene.bodies.find((b) => b.id === selected) ?? scene.bodies.find((b) => b.enabled) ?? null;
  const re = ref ? engine.reynoldsFor(ref) : null;
  const map = engine.lattice;
  const model = engine.flowModel;
  const cells = ref ? engine.cellsAcross(ref) : null;
  return (
    <Section title="Wind">
      <Field label="Wind speed" help="The speed of the flow coming in at the left.">
        <NumberUnitInput label="Wind speed" quantity="velocity" units={units} valueSi={scene.flow.speed} onCommitSi={(v) => set({ speed: Math.min(LIMITS.speed[1], Math.max(LIMITS.speed[0], v)) })} />
      </Field>
      <Field label="Fluid">
        <Select label="Fluid" value={scene.flow.fluid} options={Object.entries(FLUIDS).map(([value, f]) => ({ value, label: f.label }))} onChange={(v) => set({ fluid: v as Scene['flow']['fluid'] })} />
      </Field>
      <Field
        label="Flow model"
        help="Resolved: the grid's own flow, exact when the grid resolves the Reynolds number, otherwise run at the highest one it does. Turbulence model: Spalart–Allmaras with wall functions, at the real Reynolds number. Auto: the turbulence model from a Reynolds number of 100,000 up."
      >
        <Select
          label="Flow model"
          value={scene.flow.model}
          options={[
            { value: 'auto', label: `Auto (${model === 'sa' ? 'turbulence model' : 'resolved'})` },
            { value: 'resolved', label: 'Resolved' },
            { value: 'sa', label: 'Turbulence model (SA)' },
          ]}
          onChange={(v) => set({ model: v as FlowModel })}
        />
      </Field>
      {ref && re ? (
        <div className="t2d-re" data-t2d-re data-real={re.real} data-sim={re.sim} data-t2d-model={model}>
          <div className="t2d-re-row">
            <span>Reynolds number ({shapeLabel(ref.shape)}, {fmtRe(referenceLength(ref.shape))} m)</span>
          </div>
          <div className="t2d-re-row">
            <span className="t2d-re-k">Real</span>
            <span className="t2d-re-v" data-t2d-re-real>
              {fmtRe(re.real)}
            </span>
            <span className="t2d-re-k">Simulated</span>
            <span className="t2d-re-v" data-t2d-re-sim>
              {fmtRe(re.sim)}
            </span>
          </div>
          {model === 'sa' ? (
            <Hint tone={re.real < 3e5 ? 'warning' : undefined}>
              <span data-t2d-model-note="sa">
                Turbulence model on (Spalart–Allmaras, wall functions) at the real Reynolds number. It gives the mean flow: attached boundary layers, stall to within a few degrees, and lift to within about {liftBand(cells)} % with {fmtRe(Math.round(cells ?? 0))} cells across the body{(cells ?? 0) < 250 ? ' (Refine near bodies narrows it)' : ''}. Drag reads high (up to about twice the real drag at this resolution), and past the stall the flow is not reliable. Turbulent eddies themselves are not drawn: 2D turbulence is not the real, 3D kind.
                {re.real < 3e5 ? ' Below a Reynolds number of about 300,000, real airfoils often have laminar separation bubbles this model does not capture.' : ''}
              </span>
            </Hint>
          ) : map?.capped ? (
            <Hint tone="warning">
              <span data-t2d-model-note="capped">
                This grid resolves a Reynolds number of about {fmtRe(re.sim)} here, so the flow is simulated at that, not at {fmtRe(re.real)}. Wakes, shedding and separation show as they do at the lower Reynolds number, and so do the forces. A finer resolution raises it{re.real >= 1e5 ? '; the turbulence model runs the real one' : ''}.
              </span>
            </Hint>
          ) : null}
        </div>
      ) : (
        <Hint>Add a body to see its Reynolds number.</Hint>
      )}
    </Section>
  );
}

export function TunnelPanel({ store, engine, units }: { store: Store; engine: Engine; units: UnitSystem }) {
  const scene = useStore(store, (s) => s.scene);
  const [, tick] = useState(0);
  useEffect(() => engine.subscribe(() => tick((n) => n + 1)), [engine]);
  const set = (t: Partial<Scene['tunnel']>) => store.commit({ ...scene, tunnel: { ...scene.tunnel, ...t } });
  const grid = engine.grid;
  const resLabel = (r: Exclude<Resolution, 'auto'>) => {
    const g = gridFor(scene, RESOLUTION_CELLS[r]);
    return `${r[0].toUpperCase()}${r.slice(1)} (${g.nx} × ${g.ny})`;
  };
  return (
    <Section title="Tunnel">
      <Field label="Length" help="The tunnel from inlet to outlet.">
        <NumberUnitInput label="Length" quantity="length" unit={lengthUnit(units)} units={units} valueSi={scene.tunnel.length} onCommitSi={(v) => set({ length: Math.min(LIMITS.length[1], Math.max(LIMITS.length[0], v)) })} />
      </Field>
      <Field label="Height">
        <NumberUnitInput label="Height" quantity="length" unit={lengthUnit(units)} units={units} valueSi={scene.tunnel.height} onCommitSi={(v) => set({ height: Math.min(LIMITS.height[1], Math.max(LIMITS.height[0], v)) })} />
      </Field>
      <Field label="Walls" help="Open: no walls; the free stream goes on beyond the top and bottom, and waves and wakes pass out through them (a body in open air). Slip walls let the flow slide along them. Solid walls have boundary layers, like a real tunnel. Periodic: what leaves at the top comes in at the bottom.">
        <Select
          label="Walls"
          value={scene.tunnel.walls}
          options={[
            { value: 'farfield', label: 'Open (no walls)' },
            { value: 'slip', label: 'Slip walls' },
            { value: 'noslip', label: 'Solid' },
            { value: 'periodic', label: 'Periodic' },
          ]}
          onChange={(v) => set({ walls: v as Walls })}
        />
      </Field>
      <Field label="Resolution" help="Cells in the grid. Finer grids show more detail and a higher Reynolds number, and run slower. Auto picks the finest this GPU runs smoothly.">
        <Select
          label="Resolution"
          value={scene.tunnel.resolution}
          options={[
            { value: 'auto', label: scene.tunnel.resolution === 'auto' && grid ? `Auto (${grid.nx} × ${grid.ny})` : 'Auto' },
            ...(['low', 'medium', 'high', 'ultra'] as const).map((r) => ({ value: r, label: resLabel(r) })),
          ]}
          onChange={(v) => set({ resolution: v as Resolution })}
        />
      </Field>
      <Field
        label="Refine near bodies"
        help="Cells half (x2) or a quarter (x4) the size round each body, moving with it: thinner boundary layers, sharper leading and trailing edges, and, when the flow is resolved, twice or four times the Reynolds number near the body. The flow runs about 3 or 7 times slower. At a real Reynolds number of millions, drag still reads high: that needs cells far smaller than any real-time grid."
      >
        <Select
          label="Refine near bodies"
          value={String(scene.tunnel.refine)}
          options={[
            { value: '0', label: 'Off' },
            { value: '1', label: 'x2 finer' },
            { value: '2', label: 'x4 finer' },
          ]}
          onChange={(v) => set({ refine: Number(v) as RefineLevels })}
          disabled={!!engine.refineUnavailable}
        />
      </Field>
      {engine.refineUnavailable ? <Hint tone="warning">{engine.refineUnavailable}</Hint> : null}
      <Hint>The shaded strips at the inlet and the outlet absorb pressure waves; the flow there is not physical.</Hint>
    </Section>
  );
}

const FIELD_OPTIONS: { value: FieldMode; label: string }[] = [
  { value: 'particles', label: 'Flow with particles' },
  { value: 'vorticity', label: 'Vorticity' },
  { value: 'speed', label: 'Speed' },
  { value: 'pressure', label: 'Pressure (Cp)' },
  { value: 'schlieren', label: 'Density gradient (schlieren)' },
  { value: 'rheoscopic', label: 'Rheoscopic (flakes in a tank)' },
  { value: 'none', label: 'None (markers on a dark background)' },
];

export function ViewPanel({ store }: { store: Store }) {
  const scene = useStore(store, (s) => s.scene);
  const set = (v: Partial<Scene['view']>) => store.commit({ ...scene, view: { ...scene.view, ...v } }, false);
  return (
    <Section title="View">
      <Field label="Show">
        <Select label="Show" value={scene.view.field} options={FIELD_OPTIONS} onChange={(v) => set({ field: v as FieldMode })} />
      </Field>
      {scene.view.field === 'particles' ? (
        <Field label="Colour by" help="The flow's speed or its vorticity, drawn under the particles; each particle is a lighter shade of the colour where it is.">
          <Select
            label="Colour by"
            value={scene.view.particleColor}
            options={[
              { value: 'speed', label: 'Speed' },
              { value: 'vorticity', label: 'Vorticity' },
            ]}
            onChange={(p) => set({ particleColor: p as Scene['view']['particleColor'] })}
          />
        </Field>
      ) : null}
      {scene.view.field === 'rheoscopic' ? (
        <Field label="Flakes" help="How the tank looks: the flakes' colour and the two lights over it. Flakes lie flat and tilt with the flow, and catch the light where the flow shears and turns; still water goes dull.">
          <Select
            label="Flakes"
            value={scene.view.rheoPreset}
            options={[
              { value: 'kalliroscope', label: 'Kalliroscope blue' },
              { value: 'pearl', label: 'Pearl' },
              { value: 'copper', label: 'Copper' },
            ]}
            onChange={(p) => set({ rheoPreset: p as Scene['view']['rheoPreset'] })}
          />
        </Field>
      ) : null}
      <Field label="Colour range" help="Automatic follows the flow; turn it off to fix the range (in the legend's units).">
        <Toggle label="Automatic colour range" checked={scene.view.autoRange} onChange={(on) => set({ autoRange: on })} />
      </Field>
      <Field label="Run speed" help="As fast as possible runs as many steps as the GPU manages each frame. Real time slows it to the speed of the real flow, when the GPU is fast enough.">
        <Select
          label="Run speed"
          value={scene.view.speed}
          options={[
            { value: 'max', label: 'As fast as possible' },
            { value: 'realtime', label: 'Real time' },
          ]}
          onChange={(v) => set({ speed: v as Scene['view']['speed'] })}
        />
      </Field>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------

/** A new body, placed where it overlaps no other: the first free spot on a grid over the
 * tunnel's middle, from upstream (bodies' bounding circles, with a gap of a tenth of the
 * larger one). Where none is free, the tunnel's middle. */
function newBody(scene: Scene, shape: Shape, name: string): Body {
  const { length, height } = scene.tunnel;
  const r = radius(outline(shape));
  const others = scene.bodies.map((b) => ({ x: b.x, y: b.y, r: radius(outline(b.shape)) }));
  const free = (x: number, y: number) => others.every((o) => Math.hypot(o.x - x, o.y - y) > (o.r + r) * 1.1);
  let at = { x: length * 0.35, y: height / 2 };
  search: for (const fx of [0.3, 0.42, 0.54, 0.66, 0.24]) {
    for (const fy of [0.5, 0.3, 0.7, 0.2, 0.8]) {
      const x = length * fx;
      const y = height * fy;
      if (y - r < 0 || y + r > height) continue;
      if (free(x, y)) {
        at = { x, y };
        break search;
      }
    }
  }
  return { id: newBodyId(), name, shape, x: at.x, y: at.y, angle: 0, spin: 0, enabled: true, locked: false };
}

export function addShape(store: Store, kind: Shape['kind']): void {
  const scene = store.get().scene;
  const h = scene.tunnel.height;
  const shapes: Record<string, [Shape, string]> = {
    naca: [{ kind: 'naca', code: '0012', chord: h / 4 }, 'NACA 0012'],
    circle: [{ kind: 'circle', diameter: h / 10 }, 'Cylinder'],
    rect: [{ kind: 'rect', width: h / 8, height: h / 8 }, 'Rectangle'],
    ellipse: [{ kind: 'ellipse', width: h / 5, height: h / 10 }, 'Ellipse'],
    plate: [{ kind: 'plate', length: h / 4, thickness: h / 80 }, 'Flat plate'],
  };
  const [shape, name] = shapes[kind];
  const b = newBody(scene, shape, name);
  store.commit({ ...scene, bodies: [...scene.bodies, b] });
  store.select(b.id);
}

export function BodiesPanel({ store, ws }: { store: Store; ws: Workspace }) {
  const scene = useStore(store, (s) => s.scene);
  const selected = useStore(store, (s) => s.selected);
  const file = useRef<HTMLInputElement>(null);
  const full = scene.bodies.length >= LIMITS.maxBodies;

  const importDat = async (f: File) => {
    try {
      const sec = parseDat(await f.text(), f.name);
      const s = store.get().scene;
      const b = newBody(s, { kind: 'dat', name: sec.name, x: sec.x, y: sec.y, chord: s.tunnel.height / 4 }, sec.name);
      store.commit({ ...s, bodies: [...s.bodies, b] });
      store.select(b.id);
      void ws.ui.toast(sec.warnings.length ? `Imported ${sec.name}. ${sec.warnings.join(' ')}` : `Imported ${sec.name}.`, { kind: 'success' });
    } catch (err) {
      void ws.ui.toast(err instanceof DatError ? `${f.name}: ${err.message}` : `${f.name} could not be read: ${String(err)}`, { kind: 'error' });
    }
  };

  const remove = (b: Body) => {
    const s = store.get().scene;
    store.commit({ ...s, bodies: s.bodies.filter((x) => x.id !== b.id) });
    void ws.ui.toast(`Removed ${b.name}. Undo (Ctrl+Z) brings it back.`, { kind: 'info' });
  };

  return (
    <Section title="Bodies">
      <div className="t2d-add-row">
        <Button variant="secondary" disabled={full} onClick={() => addShape(store, 'naca')} attrs={{ 'data-t2d-add': 'naca' }}>
          Add airfoil
        </Button>
        <Select
          label="Add shape"
          value=""
          disabled={full}
          options={[
            { value: '', label: 'Add shape…' },
            { value: 'circle', label: 'Cylinder' },
            { value: 'rect', label: 'Rectangle' },
            { value: 'ellipse', label: 'Ellipse' },
            { value: 'plate', label: 'Flat plate' },
          ]}
          onChange={(v) => v && addShape(store, v as Shape['kind'])}
        />
        <Button variant="neutral" disabled={full} onClick={() => file.current?.click()} attrs={{ 'data-t2d-import': '1' }}>
          Import .dat…
        </Button>
        <input
          ref={file}
          type="file"
          accept=".dat,.txt"
          hidden
          data-t2d-file
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importDat(f);
          }}
        />
      </div>
      {full ? <Hint tone="warning">A tunnel holds at most {LIMITS.maxBodies} bodies.</Hint> : null}
      {scene.bodies.length === 0 ? <Hint>No bodies yet: add an airfoil or a shape, or import an airfoil’s .dat file.</Hint> : null}
      <ul className="t2d-body-list" role="listbox" aria-label="Bodies">
        {scene.bodies.map((b) => (
          <li
            key={b.id}
            role="option"
            aria-selected={b.id === selected}
            className={`t2d-body-row${b.id === selected ? ' is-selected' : ''}${b.enabled ? '' : ' is-off'}`}
            data-t2d-body={b.id}
            onClick={() => store.select(b.id)}
          >
            <span className="t2d-body-name">{b.name}</span>
            <span className="t2d-body-kind">{shapeLabel(b.shape) === b.name ? '' : shapeLabel(b.shape)}</span>
            <button
              type="button"
              className="t2d-icon-btn"
              title={b.enabled ? 'Take it out of the flow' : 'Put it in the flow'}
              aria-label={b.enabled ? `Take ${b.name} out of the flow` : `Put ${b.name} in the flow`}
              aria-pressed={b.enabled}
              onClick={(e) => {
                e.stopPropagation();
                store.updateBody(b.id, { enabled: !b.enabled });
              }}
            >
              <Icon path={b.enabled ? 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6' : 'M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6'} size={14} />
            </button>
            <button
              type="button"
              className="t2d-icon-btn"
              title={`Remove ${b.name}`}
              aria-label={`Remove ${b.name}`}
              onClick={(e) => {
                e.stopPropagation();
                remove(b);
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------

/** The spin cap (rad/s) when a body's spin is above it, else null. */
function spinCapped(engine: Engine, b: Body): number | null {
  const cap = engine.spinCap(b.id);
  return cap !== null && Math.abs(b.spin) > cap ? cap : null;
}

export function BodyPanel({ store, ws, units, engine }: { store: Store; ws: Workspace; units: UnitSystem; engine: Engine }) {
  const scene = useStore(store, (s) => s.scene);
  const selected = useStore(store, (s) => s.selected);
  const [codeError, setCodeError] = useState('');
  const b = scene.bodies.find((x) => x.id === selected);
  useEffect(() => setCodeError(''), [selected]);
  if (!b) {
    return (
      <Section title="Body" attr="body">
        <Hint>Select a body to edit it. Drag a body to move it, and drag the round handle above it to turn it (Shift: whole degrees).</Hint>
      </Section>
    );
  }
  const lu = lengthUnit(units);
  const up = (patch: Partial<Body>) => store.updateBody(b.id, patch);
  const shape = (patch: Partial<Shape>) => up({ shape: { ...b.shape, ...patch } as Shape });
  const pos = (v: number) => Math.max(1e-4, Math.min(1000, v));
  const len = (label: string, value: number, apply: (v: number) => void, help?: string) => (
    <Field label={label} help={help}>
      <NumberUnitInput label={label} quantity="length" unit={lu} units={units} valueSi={value} onCommitSi={(v) => apply(pos(v))} />
    </Field>
  );

  let shapeFields: ReactNode = null;
  switch (b.shape.kind) {
    case 'naca': {
      const code = b.shape.code;
      shapeFields = (
        <>
          <Field label="NACA designation" help="4 or 5 digits, such as 2412 or 23012.">
            <TextField
              label="NACA designation"
              attr="naca"
              value={code}
              error={codeError}
              onCommit={(text) => {
                try {
                  const c = parseCode(text);
                  setCodeError('');
                  const renamed = b.name === `NACA ${code}` ? `NACA ${c}` : b.name;
                  up({ shape: { ...b.shape, code: c } as Shape, name: renamed });
                } catch (err) {
                  setCodeError(err instanceof NacaError ? err.message : String(err));
                }
              }}
            />
          </Field>
          {codeError ? (
            <Hint tone="danger">
              <span data-t2d-naca-error>{codeError}</span>
            </Hint>
          ) : null}
          {len('Chord', b.shape.chord, (v) => shape({ chord: v }))}
        </>
      );
      break;
    }
    case 'dat':
      shapeFields = len('Chord', b.shape.chord, (v) => shape({ chord: v }));
      break;
    case 'circle':
      shapeFields = len('Diameter', b.shape.diameter, (v) => shape({ diameter: v }));
      break;
    case 'rect':
    case 'ellipse':
      shapeFields = (
        <>
          {len('Width', b.shape.width, (v) => shape({ width: v }), 'Along the flow, before turning.')}
          {len('Height', b.shape.height, (v) => shape({ height: v }))}
        </>
      );
      break;
    case 'plate':
      shapeFields = (
        <>
          {len('Length', b.shape.length, (v) => shape({ length: v }))}
          {len('Thickness', b.shape.thickness, (v) => shape({ thickness: v }), 'A plate thinner than about two cells of the grid is drawn thicker than it is.')}
        </>
      );
      break;
  }
  const dx = engine.lattice?.dx ?? 0;
  const thin = b.shape.kind === 'plate' && dx > 0 && b.shape.thickness < 2 * dx;

  return (
    <Section title="Body" attr="body">
      <Field label="Name">
        <TextField label="Name" attr="name" value={b.name} onCommit={(v) => up({ name: v.trim().slice(0, 80) || b.name })} />
      </Field>
      <div className="t2d-shape-kind">{shapeLabel(b.shape)}</div>
      {shapeFields}
      {thin ? (
        <Hint tone="warning">
          This plate is thinner than two grid cells ({fmtRe(fromSi('length', 2 * dx, units === 'imperial' ? 'in' : 'mm'))} {units === 'imperial' ? 'in' : 'mm'}): the flow sees a thicker one.
        </Hint>
      ) : null}
      {len('Position x', b.x, (v) => up({ x: Math.min(scene.tunnel.length, Math.max(0, v)) }), b.shape.kind === 'naca' || b.shape.kind === 'dat' ? 'Of the quarter chord, from the inlet.' : 'Of the centre, from the inlet.')}
      <Field label="Position y" help="From the bottom wall.">
        <NumberUnitInput label="Position y" quantity="length" unit={lu} units={units} valueSi={b.y} onCommitSi={(v) => up({ y: Math.min(scene.tunnel.height, Math.max(0, v)) })} />
      </Field>
      <Field label={b.shape.kind === 'naca' || b.shape.kind === 'dat' ? 'Angle of attack' : 'Angle'} help="Positive raises the leading (left) side.">
        <NumberUnitInput label="Angle" unit="°" valueSi={b.angle} onCommitSi={(v) => up({ angle: Math.max(-180, Math.min(180, v)) })} />
      </Field>
      <Field label="Spin" help="Turns the body continuously; positive is counter-clockwise. A spinning cylinder shows the Magnus effect.">
        <NumberUnitInput label="Spin" quantity="angular_velocity" unit="rpm" units={units} valueSi={b.spin} onCommitSi={(v) => up({ spin: Math.max(-1e4, Math.min(1e4, v)) })} />
      </Field>
      {spinCapped(engine, b) ? (
        <Hint tone="warning">
          <span data-t2d-spin-capped>
            This spin is held to {fmtRe((spinCapped(engine, b) as number) * (60 / (2 * Math.PI)))} rpm: the body’s edge would move faster than twice the wind speed, more than the lattice can carry.
          </span>
        </Hint>
      ) : null}
      <Field label="In the flow">
        <Toggle label="In the flow" checked={b.enabled} onChange={(on) => up({ enabled: on })} />
      </Field>
      <Field label="Locked" help="A locked body cannot be dragged or turned with the mouse.">
        <Toggle label="Locked" checked={b.locked} onChange={(on) => up({ locked: on })} />
      </Field>
      <div className="t2d-panel-foot">
        <Button
          variant="danger"
          onClick={() => {
            const s = store.get().scene;
            store.commit({ ...s, bodies: s.bodies.filter((x) => x.id !== b.id) });
            void ws.ui.toast(`Removed ${b.name}. Undo (Ctrl+Z) brings it back.`, { kind: 'info' });
          }}
          attrs={{ 'data-t2d-remove': b.id }}
        >
          Remove body
        </Button>
      </div>
    </Section>
  );
}
