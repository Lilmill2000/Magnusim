// Flow markers: the tracer particles and their trail, velocity arrows, streamlines, and
// rakes (streaks, timelines or dye); and the selected rake's properties.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Button, Field, Hint, Icon, NumberUnitInput, Select, Toggle, type UnitSystem } from '@magnusim/plugin-ui';
import type { Workspace } from '@magnusim/workspace';
import type { ReactNode } from 'react';
import { LIMITS, RAKE_COLORS, newRakeId, type Density, type Rake, type RakeKind, type Scene, type TrailLength } from '../scene/scene';
import { useStore, type Store } from '../app/store';

export const RAKE_KIND_LABEL: Record<RakeKind, string> = { streaks: 'Streaks', timelines: 'Timelines', dye: 'Dye' };
/** The rake colours: the app's series colours, in order. */
export const RAKE_COLOR_NAMES = ['Blue', 'Purple', 'Green', 'Orange', 'Sky blue', 'Pink'];
export const rakeColorVar = (i: number) => `var(--mg-series-${(i % RAKE_COLORS) + 1})`;

function Section({ title, children, attr }: { title: string; children: ReactNode; attr: string }) {
  return (
    <section className="t2d-section" data-t2d-section={attr}>
      <h2 className="t2d-section-title">{title}</h2>
      <div className="t2d-section-body">{children}</div>
    </section>
  );
}

export function rakeName(scene: Scene, r: Rake): string {
  const same = scene.rakes.filter((x) => x.kind === r.kind);
  return `${RAKE_KIND_LABEL[r.kind]} ${same.indexOf(r) + 1}`;
}

/** A new rake: upright across the middle of the tunnel, just past the inlet's absorbing strip. */
export function addRake(store: Store, kind: RakeKind) {
  const s = store.get().scene;
  const { length, height } = s.tunnel;
  const used = new Set(s.rakes.map((r) => r.color));
  let color = 0;
  while (used.has(color) && color < RAKE_COLORS - 1) color++;
  const n = s.rakes.length;
  const x = length * (0.1 + 0.02 * (n % 4));
  const r: Rake = { id: newRakeId(), kind, x0: x, y0: height * 0.3, x1: x, y1: height * 0.7, emitters: kind === 'dye' ? 7 : 12, color, enabled: true };
  store.commit({ ...s, rakes: [...s.rakes, r] });
  store.select(r.id);
}

export function MarkersPanel({ store, ws }: { store: Store; ws: Workspace }) {
  const scene = useStore(store, (s) => s.scene);
  const selected = useStore(store, (s) => s.selected);
  const v = scene.view;
  const set = (p: Partial<Scene['view']>) => store.commit({ ...scene, view: { ...v, ...p } }, false);
  const dyeCount = scene.rakes.filter((r) => r.kind === 'dye').length;
  const full = scene.rakes.length >= LIMITS.maxRakes;
  const remove = (r: Rake) => {
    const s = store.get().scene;
    store.commit({ ...s, rakes: s.rakes.filter((x) => x.id !== r.id) });
    void ws.ui.toast(`Removed ${rakeName(scene, r)}. Undo (Ctrl+Z) brings it back.`, { kind: 'info' });
  };
  return (
    <Section title="Flow markers" attr="markers">
      {v.field === 'particles' ? (
        <Hint>The particles view shows the tracer particles; here you set how many and their trails.</Hint>
      ) : (
        <Field label="Tracer particles" help="Particles carried by the flow, drawn faintly over the field.">
          <Toggle label="Tracer particles" checked={v.tracers} onChange={(on) => set({ tracers: on })} />
        </Field>
      )}
      <Field label="Particle count">
        <Select
          label="Particle count"
          value={v.density}
          disabled={!v.tracers && v.field !== 'particles'}
          options={[
            { value: 'low', label: 'Few' },
            { value: 'normal', label: 'Normal' },
            { value: 'high', label: 'Many' },
          ]}
          onChange={(x) => set({ density: x as Density })}
        />
      </Field>
      <Field label="Streaks" help="Each particle is drawn as a short streak along its motion.">
        <Select
          label="Streaks"
          value={v.trail}
          options={[
            { value: 'off', label: 'Dots' },
            { value: 'short', label: 'Short' },
            { value: 'long', label: 'Long' },
          ]}
          onChange={(x) => set({ trail: x as TrailLength })}
        />
      </Field>
      <Field label="Velocity arrows">
        <Toggle label="Velocity arrows" checked={v.arrows} onChange={(on) => set({ arrows: on })} />
      </Field>
      <Field label="Streamlines" help="Lines along the flow’s direction now, from just past the inlet. In shedding flow they differ from the particles’ paths.">
        <Toggle label="Streamlines" checked={v.streamlines} onChange={(on) => set({ streamlines: on })} />
      </Field>
      <div className="t2d-add-row">
        <Select
          label="Add rake"
          value=""
          disabled={full}
          options={[
            { value: '', label: 'Add rake…' },
            { value: 'streaks', label: 'Streaks (a thread from each emitter)' },
            { value: 'timelines', label: 'Timelines (a line released at intervals)' },
            { value: 'dye', label: 'Dye', disabled: dyeCount >= LIMITS.maxDyeRakes },
          ]}
          onChange={(k) => k && addRake(store, k as RakeKind)}
        />
      </div>
      {full ? <Hint tone="warning">A tunnel holds at most {LIMITS.maxRakes} rakes.</Hint> : null}
      {dyeCount >= LIMITS.maxDyeRakes ? <Hint>At most {LIMITS.maxDyeRakes} dye rakes: one colour each.</Hint> : null}
      {scene.rakes.length ? (
        <ul className="t2d-body-list" role="listbox" aria-label="Rakes">
          {scene.rakes.map((r) => (
            <li
              key={r.id}
              role="option"
              aria-selected={r.id === selected}
              className={`t2d-body-row${r.id === selected ? ' is-selected' : ''}${r.enabled ? '' : ' is-off'}`}
              data-t2d-rake={r.id}
              onClick={() => store.select(r.id)}
            >
              <span className="t2d-swatch" style={{ background: rakeColorVar(r.color) }} />
              <span className="t2d-body-name">{rakeName(scene, r)}</span>
              <span className="t2d-body-kind" />
              <button
                type="button"
                className="t2d-icon-btn"
                aria-pressed={r.enabled}
                aria-label={r.enabled ? `Stop ${rakeName(scene, r)}` : `Start ${rakeName(scene, r)}`}
                title={r.enabled ? 'Stop it' : 'Start it'}
                onClick={(e) => {
                  e.stopPropagation();
                  const s = store.get().scene;
                  store.commit({ ...s, rakes: s.rakes.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) });
                }}
              >
                <Icon path={r.enabled ? 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6' : 'M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6'} size={14} />
              </button>
              <button
                type="button"
                className="t2d-icon-btn"
                aria-label={`Remove ${rakeName(scene, r)}`}
                title="Remove it"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(r);
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Hint>A rake releases streaks, timelines or dye from a line you place and drag in the tunnel.</Hint>
      )}
    </Section>
  );
}

export function RakePanel({ store, ws, units, rake }: { store: Store; ws: Workspace; units: UnitSystem; rake: Rake }) {
  const scene = useStore(store, (s) => s.scene);
  const lu = units === 'imperial' ? 'ft' : 'm';
  const up = (p: Partial<Rake>) => {
    const s = store.get().scene;
    store.commit({ ...s, rakes: s.rakes.map((x) => (x.id === rake.id ? { ...x, ...p } : x)) });
  };
  const { length, height } = scene.tunnel;
  const clampX = (x: number) => Math.min(length, Math.max(0, x));
  const clampY = (y: number) => Math.min(height, Math.max(0, y));
  const dyeOthers = scene.rakes.filter((r) => r.kind === 'dye' && r.id !== rake.id).length;
  const len = (label: string, value: number, apply: (v: number) => void) => (
    <Field label={label}>
      <NumberUnitInput label={label} quantity="length" unit={lu} units={units} valueSi={value} onCommitSi={apply} />
    </Field>
  );
  return (
    <Section title="Rake" attr="rake">
      <div className="t2d-shape-kind" data-t2d-rake-name>
        {rakeName(scene, rake)}
      </div>
      <Field label="Releases">
        <Select
          label="Releases"
          value={rake.kind}
          options={[
            { value: 'streaks', label: 'Streaks' },
            { value: 'timelines', label: 'Timelines' },
            { value: 'dye', label: 'Dye', disabled: dyeOthers >= LIMITS.maxDyeRakes },
          ]}
          onChange={(k) => up({ kind: k as RakeKind })}
        />
      </Field>
      {rake.kind !== 'timelines' ? (
        <Field label="Emitters" help="Points along the rake that release the markers.">
          <NumberUnitInput label="Emitters" valueSi={rake.emitters} onCommitSi={(n) => up({ emitters: Math.round(Math.min(LIMITS.emitters[1], Math.max(LIMITS.emitters[0], n))) })} />
        </Field>
      ) : null}
      <Field label="Colour">
        <Select label="Colour" value={String(rake.color)} options={RAKE_COLOR_NAMES.map((name, i) => ({ value: String(i), label: name }))} onChange={(c) => up({ color: Number(c) })} />
      </Field>
      {len('Start x', rake.x0, (v) => up({ x0: clampX(v) }))}
      {len('Start y', rake.y0, (v) => up({ y0: clampY(v) }))}
      {len('End x', rake.x1, (v) => up({ x1: clampX(v) }))}
      {len('End y', rake.y1, (v) => up({ y1: clampY(v) }))}
      <Field label="Releasing">
        <Toggle label="Releasing" checked={rake.enabled} onChange={(on) => up({ enabled: on })} />
      </Field>
      <Hint>Drag the rake to move it, or one of its ends to stretch or turn it.</Hint>
      <div className="t2d-panel-foot">
        <Button
          variant="danger"
          attrs={{ 'data-t2d-remove-rake': rake.id }}
          onClick={() => {
            const s = store.get().scene;
            store.commit({ ...s, rakes: s.rakes.filter((x) => x.id !== rake.id) });
            void ws.ui.toast(`Removed ${rakeName(scene, rake)}. Undo (Ctrl+Z) brings it back.`, { kind: 'info' });
          }}
        >
          Remove rake
        </Button>
      </div>
    </Section>
  );
}
