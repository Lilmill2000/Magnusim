// Probes: points pinned in the tunnel that read the flow (velocity, pressure, Cp) five times
// a second, listed with their speed; the selected one with all its readings and a plot over
// time. Drag one in the view to move it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Button, Field, Hint, Icon, LinePlot, NumberUnitInput, fromSi, preferredUnit, type UnitSystem } from '@magnusim/plugin-ui';
import { useSyncExternalStore, type ReactNode } from 'react';
import { referenceLength } from '../geometry/shapes';
import { LIMITS, newProbeId, type Probe, type Scene } from '../scene/scene';
import { useStore, type Store } from '../app/store';
import type { ProbeFeed } from './probeFeed';
import { fmtRe } from './panels';

function Section({ title, children, attr }: { title: string; children: ReactNode; attr: string }) {
  return (
    <section className="t2d-section" data-t2d-section={attr}>
      <h2 className="t2d-section-title">{title}</h2>
      <div className="t2d-section-body">{children}</div>
    </section>
  );
}

function useFeed(feed: ProbeFeed) {
  return useSyncExternalStore(
    (fn) => feed.subscribe(fn),
    () => feed.version,
  );
}

export const probeName = (scene: Scene, p: Probe) => `P${scene.probes.findIndex((x) => x.id === p.id) + 1}`;

/** A new probe two body lengths behind the first body (or in the tunnel's middle), the next ones above and below it. */
export function addProbe(store: Store) {
  const s = store.get().scene;
  const b = s.bodies.find((x) => x.enabled);
  const { length, height } = s.tunnel;
  const n = s.probes.length;
  const x = b ? Math.min(length * 0.95, b.x + 2 * referenceLength(b.shape)) : length / 2;
  const y = Math.min(height * 0.95, Math.max(height * 0.05, (b?.y ?? height / 2) + (n % 2 ? -1 : 1) * Math.ceil(n / 2) * height * 0.06));
  const p: Probe = { id: newProbeId(), x, y };
  store.commit({ ...s, probes: [...s.probes, p] });
  store.select(p.id);
}

export function ProbesPanel({ store, feed, units }: { store: Store; feed: ProbeFeed; units: UnitSystem }) {
  useFeed(feed);
  const scene = useStore(store, (s) => s.scene);
  const selected = useStore(store, (s) => s.selected);
  const full = scene.probes.length >= LIMITS.maxProbes;
  const vu = preferredUnit('velocity', units === 'imperial');
  return (
    <Section title="Probes" attr="probes">
      <div className="t2d-add-row">
        <Button variant="secondary" disabled={full} onClick={() => addProbe(store)} attrs={{ 'data-t2d-add-probe': '1' }}>
          Add probe
        </Button>
      </div>
      {full ? <Hint tone="warning">A tunnel holds at most {LIMITS.maxProbes} probes.</Hint> : null}
      {scene.probes.length ? (
        <ul className="t2d-body-list" role="listbox" aria-label="Probes">
          {scene.probes.map((p) => {
            const r = feed.latest(p.id);
            return (
              <li
                key={p.id}
                role="option"
                aria-selected={p.id === selected}
                className={`t2d-body-row${p.id === selected ? ' is-selected' : ''}`}
                data-t2d-probe={p.id}
                data-speed={r && !r.inBody ? r.speed : ''}
                onClick={() => store.select(p.id)}
              >
                <span className="t2d-body-name">{probeName(scene, p)}</span>
                <span className="t2d-body-kind">{r ? (r.inBody ? 'in a body' : `${fmtRe(fromSi('velocity', r.speed, vu))} ${vu}`) : ''}</span>
                <button
                  type="button"
                  className="t2d-icon-btn"
                  title={`Remove ${probeName(scene, p)}`}
                  aria-label={`Remove ${probeName(scene, p)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const s = store.get().scene;
                    store.commit({ ...s, probes: s.probes.filter((x) => x.id !== p.id) });
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <Hint>A probe reads the flow at a point you place: velocity, pressure and Cp, over time. Hover over the flow to read it anywhere.</Hint>
      )}
    </Section>
  );
}

export function ProbePanel({ store, feed, units, probe }: { store: Store; feed: ProbeFeed; units: UnitSystem; probe: Probe }) {
  useFeed(feed);
  const scene = useStore(store, (s) => s.scene);
  const lu = units === 'imperial' ? 'ft' : 'm';
  const vu = preferredUnit('velocity', units === 'imperial');
  const pu = preferredUnit('pressure', units === 'imperial');
  const up = (p: Partial<Probe>) => {
    const s = store.get().scene;
    store.commit({ ...s, probes: s.probes.map((x) => (x.id === probe.id ? { ...x, ...p } : x)) });
  };
  const { length, height } = scene.tunnel;
  const r = feed.latest(probe.id);
  const hist = feed.history(probe.id);
  const every = Math.max(1, Math.ceil(hist.length / 300));
  const rows: Record<string, number>[] = [];
  for (let i = 0; i < hist.length; i += every) if (!hist[i].inBody) rows.push({ t: hist[i].t, speed: fromSi('velocity', hist[i].speed, vu), cp: hist[i].cp });
  const val = (v: number, q: 'velocity' | 'pressure') => fmtRe(fromSi(q, v, q === 'velocity' ? vu : pu));
  return (
    <Section title="Probe" attr="probe">
      <div className="t2d-shape-kind" data-t2d-probe-name>
        {probeName(scene, probe)}
      </div>
      <Field label="Position x">
        <NumberUnitInput label="Probe x" quantity="length" unit={lu} units={units} valueSi={probe.x} onCommitSi={(v) => up({ x: Math.min(length, Math.max(0, v)) })} />
      </Field>
      <Field label="Position y">
        <NumberUnitInput label="Probe y" quantity="length" unit={lu} units={units} valueSi={probe.y} onCommitSi={(v) => up({ y: Math.min(height, Math.max(0, v)) })} />
      </Field>
      {r ? (
        r.inBody ? (
          <Hint tone="warning">The probe is inside a body: there is no flow there.</Hint>
        ) : (
          <table className="t2d-preset-table" data-t2d-probe-reading={probe.id} data-u={r.u} data-v={r.v} data-speed={r.speed} data-p={r.p} data-cp={r.cp}>
            <tbody>
              <tr>
                <td>Velocity u, v</td>
                <td>
                  {val(r.u, 'velocity')}, {val(r.v, 'velocity')} {vu}
                </td>
              </tr>
              <tr>
                <td>Speed |u|</td>
                <td>
                  {val(r.speed, 'velocity')} {vu}
                </td>
              </tr>
              <tr>
                <td>Pressure</td>
                <td>
                  {val(r.p, 'pressure')} {pu}
                </td>
              </tr>
              <tr>
                <td>Pressure coefficient Cp</td>
                <td>{r.cp.toFixed(3)}</td>
              </tr>
            </tbody>
          </table>
        )
      ) : (
        <Hint>Reading…</Hint>
      )}
      {rows.length > 2 ? (
        <LinePlot
          label="Probe readings over time"
          rows={rows}
          xKey="t"
          x={{ kind: 'linear', label: 't', format: (v) => `${fmtRe(v)} s` }}
          y={{ scale: 'linear' }}
          series={[
            { key: 'speed', label: `|u| (${vu})`, format: (v) => fmtRe(v) },
            { key: 'cp', label: 'Cp', format: (v) => v.toFixed(3) },
          ]}
        />
      ) : null}
      <Hint>Pressure is against the free stream’s, read just past the inlet. Drag the probe in the view to move it.</Hint>
      <div className="t2d-panel-foot">
        <Button
          variant="danger"
          attrs={{ 'data-t2d-remove-probe': probe.id }}
          onClick={() => {
            const s = store.get().scene;
            store.commit({ ...s, probes: s.probes.filter((x) => x.id !== probe.id) });
          }}
        >
          Remove probe
        </Button>
      </div>
    </Section>
  );
}
