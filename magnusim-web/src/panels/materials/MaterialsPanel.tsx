import { useEffect, useRef, useState } from 'react';
import type { RegistryRow } from '../../api/registry.gen';
import { apiGet } from '../../api/client';
import { workerRpc } from '../../api/workerRpc';
import { SciNumberInput } from '../../forms/SciNumberInput';
import { prefersImperial } from '../../prefs';
import { useProjectStore } from '../../store/project';
import type { IslandProps } from '../../islands';
import { convertQuantity } from '../../units/convert';
import { subscribeBodyPicks } from '../../viewer/pick';
import { applyMaterial, deleteMaterial, geometryBodies } from '../legacyBridge';
import { PanelChrome } from '../PanelChrome';
import { scopeIds } from '../scope';

/** Air at about 20 °C. */
export const AIR = { name: 'Air', nu: 1.529e-5, rho: 1.196 } as const;
/** Fresh water at 20 °C. */
export const WATER = { name: 'Water', nu: 1.004e-6, rho: 998.2 } as const;

/**
 * A study solves one incompressible fluid: Air, Water, or a custom fluid with
 * its own name, viscosity and density. The solver reads the assigned one.
 */
export type FluidKind = 'Air' | 'Water' | 'Custom';
export const FLUID_OPTIONS: Array<{ kind: FluidKind; label: string }> = [
  { kind: 'Air', label: 'Air' },
  { kind: 'Water', label: 'Water' },
  { kind: 'Custom', label: 'Custom fluid' },
];

export function fluidKindOf(m: { name?: unknown; library?: unknown } | null | undefined): FluidKind {
  const lib = String(m?.library || '').toUpperCase();
  const name = String(m?.name || '').trim();
  if (lib === 'WATER' || /^water$/i.test(name)) return 'Water';
  if (lib === 'CUSTOM') return 'Custom';
  if (!name || lib === 'AIR' || /^air$/i.test(name)) return 'Air';
  return 'Custom';
}

/** The study's fluid among its saved materials: the assigned one, else an older study's Air, else the first. */
export function studyFluid(rows: SavedMaterial[]): SavedMaterial | null {
  const assigned = rows.find(
    (m) => (Array.isArray(m.assigned_volumes) && m.assigned_volumes.length > 0) || !!m.assigned_volume,
  );
  return assigned || rows.find((m) => /air/i.test(String(m.name || ''))) || rows[0] || null;
}

export interface SavedMaterial {
  id?: string;
  name?: string;
  kinematic_viscosity?: number;
  nu?: number;
  density?: number;
  rho?: number;
  assigned_volumes?: string[];
  simulation_id?: string;
  created_at?: string;
  [key: string]: unknown;
}

/** Registry row label for the simulation picker: the Newtonian model is Air. */
export function materialPresetLabel(row: RegistryRow): string | null {
  const key = String(row.key || '');
  const label = String(row.label || '');
  if (key === 'newtonian_incompressible') return 'Air';
  if (/water/i.test(key) || /water/i.test(label)) return 'Water';
  return label || key;
}

function newMaterialId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `mat-${Date.now().toString(36)}-${hex}`;
}

/** The on-disk record the case writer reads (same keys POST /api/materials writes). */
export function airRecord(
  base: SavedMaterial | null,
  fields: { nu: number; rho: number; volumes: string[]; name?: string; kind?: FluidKind },
  ids: { simulation_id?: string; geometry_id?: string; project_id?: string },
  now: string,
): SavedMaterial {
  const volumes = fields.volumes.map(String);
  const kind = fields.kind || fluidKindOf(base);
  const name =
    kind === 'Custom'
      ? String(fields.name || (fluidKindOf(base) === 'Custom' ? base?.name : '') || 'Custom fluid').trim() ||
        'Custom fluid'
      : kind;
  return {
    ...(base || {}),
    id: base?.id || newMaterialId(),
    name,
    type: 'Newtonian',
    viscosity_model: 'Newtonian',
    kinematic_viscosity: fields.nu,
    nu: fields.nu,
    kinematic_viscosity_unit: 'm2/s',
    density: fields.rho,
    rho: fields.rho,
    density_unit: 'kg/m3',
    library: kind === 'Custom' ? 'CUSTOM' : kind.toUpperCase(),
    assigned_volumes: volumes,
    assigned_volume: volumes[0] || null,
    // The Python material model reads body_ids first; keep the aliases in step.
    body_ids: volumes.slice(),
    volume_ids: volumes.slice(),
    ...(ids.simulation_id ? { simulation_id: ids.simulation_id } : {}),
    ...(ids.geometry_id ? { geometry_id: ids.geometry_id } : {}),
    ...(ids.project_id ? { project_id: ids.project_id } : {}),
    saved: true,
    created_at: base?.created_at || now,
    updated_at: now,
  };
}

/** Next assigned list after a click on one body. */
export function toggleVolume(volumes: string[], body: string): string[] {
  return volumes.includes(body) ? volumes.filter((v) => v !== body) : [...volumes, body];
}

/**
 * Materials → the study's fluid (Air, Water or custom). Fluid, name, density
 * and kinematic viscosity save on change; a body clicked here, in the viewport
 * or in the tree toggles its assignment.
 */
export function MaterialsPanel(props: IslandProps) {
  const [material, setMaterial] = useState<SavedMaterial | null>(null);
  const [others, setOthers] = useState<SavedMaterial[]>([]);
  const [kind, setKind] = useState<FluidKind>('Air');
  const [name, setName] = useState<string>(AIR.name);
  const [nu, setNu] = useState<number>(AIR.nu);
  const [rho, setRho] = useState<number>(AIR.rho);
  const [volumes, setVolumes] = useState<string[]>([]);
  const [bodies, setBodies] = useState<string[]>(() => geometryBodies());
  const [note, setNote] = useState('');
  const imperial = prefersImperial();
  // Saves and body picks read the latest values, not the render they were created in.
  const live = useRef({ material, others, kind, name, nu, rho, volumes });
  live.current = { material, others, kind, name, nu, rho, volumes };
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  function ids() {
    return scopeIds({
      ...props,
      projectId: props.projectId || useProjectStore.getState().projectId || '',
    });
  }

  function applySaved(rows: SavedMaterial[]) {
    const fluid = studyFluid(rows);
    const k = fluidKindOf(fluid);
    const preset = k === 'Water' ? WATER : AIR;
    setMaterial(fluid);
    setOthers(rows.filter((m) => m !== fluid));
    setKind(k);
    setName(k === 'Custom' ? String(fluid?.name || 'Custom fluid') : k);
    const savedNu = Number(fluid?.kinematic_viscosity ?? fluid?.nu);
    const savedRho = Number(fluid?.density ?? fluid?.rho);
    setNu(Number.isFinite(savedNu) && savedNu > 0 ? savedNu : preset.nu);
    setRho(Number.isFinite(savedRho) && savedRho > 0 ? savedRho : preset.rho);
    setVolumes(Array.isArray(fluid?.assigned_volumes) ? fluid.assigned_volumes.map(String) : []);
  }

  function load() {
    const scoped = scopeIds(props);
    void apiGet('/api/materials', {
      project_id: scoped.project_id || undefined,
      simulation_id: scoped.simulation_id || undefined,
    })
      .then((j) => {
        const doc = j as { materials?: SavedMaterial[]; air?: SavedMaterial | null };
        const rows = Array.isArray(doc.materials) ? doc.materials : doc.air ? [doc.air] : [];
        applySaved(rows);
      })
      .catch(() => {});
    setBodies(geometryBodies());
  }

  useEffect(() => {
    load();
    const onMaterial = () => load();
    window.addEventListener('cfd:material', onMaterial);
    return () => window.removeEventListener('cfd:material', onMaterial);
  }, [props.projectId, props.simId, props.scope]);

  /** Write the fluid through the worker (materials.set) and tell the runtime. Saves run one at a time. */
  function save(next: Partial<{ nu: number; rho: number; volumes: string[]; kind: FluidKind; name: string }>) {
    const cur = live.current;
    const fields = {
      nu: next.nu ?? cur.nu,
      rho: next.rho ?? cur.rho,
      volumes: next.volumes ?? cur.volumes,
      kind: next.kind ?? cur.kind,
      name: next.name ?? cur.name,
    };
    live.current = { ...cur, ...fields };
    if (next.nu !== undefined) setNu(fields.nu);
    if (next.rho !== undefined) setRho(fields.rho);
    if (next.volumes !== undefined) setVolumes(fields.volumes);
    if (next.kind !== undefined) setKind(fields.kind);
    if (next.name !== undefined) setName(fields.name);
    const run = async () => {
      const scoped = ids();
      if (!scoped.project_id || !scoped.simulation_id) {
        setNote('Create a simulation first.');
        return;
      }
      const rec = airRecord(live.current.material, fields, {
        simulation_id: scoped.simulation_id,
        geometry_id: scoped.geometry_id || undefined,
        project_id: scoped.project_id,
      }, new Date().toISOString());
      const doc = await workerRpc<{ materials?: SavedMaterial[]; air?: SavedMaterial }>('materials.set', {
        project_id: scoped.project_id,
        sim_id: scoped.simulation_id,
        body: {
          project_id: scoped.project_id,
          simulation_id: scoped.simulation_id,
          materials: [...live.current.others, rec],
          air: rec,
          only_id: rec.id,
        },
      });
      const saved = (doc.materials || []).find((m) => m.id === rec.id) || doc.air || rec;
      setMaterial(saved);
      setNote('');
      applyMaterial(saved as Record<string, unknown>, scoped.project_id);
    };
    const p = queue.current.then(run).catch((e) => setNote(e instanceof Error ? e.message : 'Material save failed'));
    queue.current = p;
    return p;
  }

  /** Air and Water load their property values; Custom keeps the numbers to edit. */
  function pickFluid(next: FluidKind) {
    if (next === live.current.kind) return;
    if (next === 'Air') return save({ kind: 'Air', name: AIR.name, nu: AIR.nu, rho: AIR.rho });
    if (next === 'Water') return save({ kind: 'Water', name: WATER.name, nu: WATER.nu, rho: WATER.rho });
    return save({ kind: 'Custom', name: 'Custom fluid' });
  }

  function toggleBody(body: string) {
    return save({ volumes: toggleVolume(live.current.volumes, body) });
  }

  useEffect(
    () =>
      subscribeBodyPicks((picked) => {
        const hit = picked[0];
        if (hit) void toggleBody(hit.name);
      }),
    [],
  );

  const shownNu = imperial ? convertQuantity('kinematic_viscosity', nu, 'm²/s', 'ft²/s') : nu;
  const shownRho = imperial ? convertQuantity('density', rho, 'kg/m³', 'lb/ft³') : rho;
  const listed = [...new Set([...bodies, ...volumes])];

  return (
    <PanelChrome
      title={name || AIR.name}
      onDelete={material ? () => void deleteMaterial().catch((e) => setNote(e instanceof Error ? e.message : 'Delete failed')) : undefined}
    >
      <div className="mat-row">
        <span className="mat-k">Fluid</span>
        <span className="mat-v">
          <select
            className="bc-input mat-wide-input"
            aria-label="Fluid"
            value={kind}
            onChange={(e) => void pickFluid(e.target.value as FluidKind)}
          >
            {FLUID_OPTIONS.map((o) => (
              <option key={o.kind} value={o.kind}>
                {o.label}
              </option>
            ))}
          </select>
        </span>
      </div>
      {kind === 'Custom' ? (
        <div className="mat-row">
          <span className="mat-k">Name</span>
          <span className="mat-v">
            <input
              className="bc-input mat-wide-input"
              aria-label="Fluid name"
              defaultValue={name}
              key={`name-${material?.id || ''}-${name}`}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== live.current.name) void save({ name: v });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </span>
        </div>
      ) : null}
      <div className="mat-row">
        <span className="mat-k">Viscosity model</span>
        <span className="mat-v">Newtonian</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">(ν) Kinematic viscosity</span>
        <span className="mat-v bc-value-row">
          <SciNumberInput
            value={shownNu}
            label="Kinematic viscosity"
            onCommit={(v) => {
              if (!(v > 0)) return;
              void save({ nu: imperial ? convertQuantity('kinematic_viscosity', v, 'ft²/s', 'm²/s') : v });
            }}
          />
          <span className="bc-unit-label">{imperial ? 'ft²/s' : 'm²/s'}</span>
        </span>
      </div>
      <div className="mat-row">
        <span className="mat-k">(ρ) Density</span>
        <span className="mat-v bc-value-row">
          <SciNumberInput
            value={shownRho}
            label="Density"
            onCommit={(v) => {
              if (!(v > 0)) return;
              void save({ rho: imperial ? convertQuantity('density', v, 'lb/ft³', 'kg/m³') : v });
            }}
          />
          <span className="bc-unit-label">{imperial ? 'lb/ft³' : 'kg/m³'}</span>
        </span>
      </div>
      <div className="mat-assign-block">
        <div className="mat-assign-head">
          <span className="mat-k">Assigned volumes ({volumes.length})</span>
          <button type="button" className="mat-clear-link" disabled={!volumes.length} onClick={() => void save({ volumes: [] })}>
            Clear list
          </button>
        </div>
        <ul className="mat-assign-list" aria-label="Assigned volumes" data-material-volumes="1">
          {listed.map((body) => {
            const on = volumes.includes(body);
            return (
              <li key={body} className={`bc-assign-item${on ? ' is-focus' : ''}`} data-volume={body} data-assigned={on ? '1' : '0'}>
                <button
                  type="button"
                  className="bc-assign-pick"
                  aria-pressed={on}
                  title={on ? `Unassign ${body}` : `Assign ${name || AIR.name} to ${body}`}
                  onClick={() => void toggleBody(body)}
                >
                  {body}
                </button>
                <span className="mat-assign-state">{on ? 'Assigned' : 'Not assigned'}</span>
              </li>
            );
          })}
        </ul>
        <div className="mat-assign-hint" data-material-picking="1">
          Picking bodies: click a body in the viewport or in this list. Changes save automatically.
        </div>
      </div>
      {note ? (
        <p className="mat-assign-hint" role="alert">
          {note}
        </p>
      ) : null}
    </PanelChrome>
  );
}
