import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../../api/client';
import { bodyDisplay, subscribeFaceNames } from '../../workbench/faceNames';
import { linkedWorkerRpc, stampRecords } from '../../workbench/geometryRev';
import { SciNumberInput } from '../../forms/SciNumberInput';
import {
  customPresetKey,
  defaultPreset,
  materialRecord,
  modelFor,
  presetByKey,
  presetOf,
  presets,
  presetValues,
  properties,
  recordValues,
  type MaterialModelRow,
  type SavedMaterial,
} from '../../materialModel';
import { prefersImperial } from '../../prefs';
import { useProjectStore } from '../../store/project';
import type { IslandProps } from '../../islands';
import { convertQuantity, preferredUnit, SI_DEFAULT } from '../../units/convert';
import { subscribeBodyPicks } from '../../viewer/pick';
import { applyMaterial, deleteMaterial, geometryBodies, studyStateNow, subscribeStudyState, type StudyState } from '../legacyBridge';
import { PanelChrome } from '../PanelChrome';
import { scopeIds, useRegistryReady } from '../scope';

export type { SavedMaterial } from '../../materialModel';

/** The study's fluid among its saved materials: the assigned one, else an older study's Air, else the first. */
export function studyFluid(rows: SavedMaterial[]): SavedMaterial | null {
  const assigned = rows.find(
    (m) => (Array.isArray(m.assigned_volumes) && m.assigned_volumes.length > 0) || !!m.assigned_volume,
  );
  return assigned || rows.find((m) => /air/i.test(String(m.name || ''))) || rows[0] || null;
}

/** Next assigned list after a click on one body. */
export function toggleVolume(volumes: string[], body: string): string[] {
  return volumes.includes(body) ? volumes.filter((v) => v !== body) : [...volumes, body];
}

/** A property's label without its leading symbol: "(ν) Kinematic viscosity" is "Kinematic viscosity". */
function plainLabel(label: string): string {
  return label.replace(/^\([^)]*\)\s*/, '') || label;
}

function useStudyState(): StudyState | null {
  const [state, setState] = useState<StudyState | null>(() => studyStateNow());
  useEffect(() => subscribeStudyState(setState), []);
  return state;
}

/**
 * Materials → the study's fluid. The Fluid list, the property rows and what a
 * save writes come from the study's material model (its registry row): a
 * preset loads its values, the custom preset keeps the numbers to edit under
 * its own name. Values save on change; a body clicked here, in the viewport or
 * in the tree toggles its assignment.
 */
export function MaterialsPanel(props: IslandProps) {
  const registry = useRegistryReady();
  const study = useStudyState();
  const studyKey = study && (!props.simId || !study.id || study.id === props.simId) ? study.analysis_type : '';
  const model: MaterialModelRow | undefined = registry ? modelFor(studyKey) : undefined;
  const [material, setMaterial] = useState<SavedMaterial | null>(null);
  const [others, setOthers] = useState<SavedMaterial[]>([]);
  // Until the saved fluid loads, a new fluid: the model's default preset.
  const [preset, setPreset] = useState<string>(() => defaultPreset(model)?.key || '');
  const [name, setName] = useState<string>(() => defaultPreset(model)?.name || '');
  const [values, setValues] = useState<Record<string, number>>(() => presetValues(defaultPreset(model)));
  const [volumes, setVolumes] = useState<string[]>([]);
  const [bodies, setBodies] = useState<string[]>(() => geometryBodies());
  const [note, setNote] = useState('');
  const imperial = prefersImperial();
  // Saves and body picks read the latest values, not the render they were created in.
  const live = useRef({ model, material, others, preset, name, values, volumes });
  live.current = { model, material, others, preset, name, values, volumes };
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // The rows last loaded, shown again once the model arrives.
  const loaded = useRef<SavedMaterial[] | null>(null);

  function ids() {
    return scopeIds({
      ...props,
      projectId: props.projectId || useProjectStore.getState().projectId || '',
    });
  }

  function applySaved(rows: SavedMaterial[]) {
    const m = live.current.model;
    const fluid = studyFluid(rows);
    const p = presetOf(m, fluid);
    const custom = !!p && p.key === customPresetKey(m);
    setMaterial(fluid);
    setOthers(rows.filter((r) => r !== fluid));
    setPreset(p?.key || '');
    setName(custom ? String(fluid?.name || p?.name || '') : String(p?.name || fluid?.name || ''));
    // A saved fluid keeps its numbers (one without them reads what older versions
    // filled in); no fluid yet is a new one, with the preset's values.
    setValues(fluid ? recordValues(m, fluid) : presetValues(p));
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
        loaded.current = rows;
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

  // The registry (the material model) can arrive after the saved fluid.
  useEffect(() => {
    if (model && loaded.current) applySaved(loaded.current);
  }, [model?.key]);

  /** Write the fluid through the worker (materials.set) and tell the runtime. Saves run one at a time. */
  function save(next: Partial<{ values: Record<string, number>; volumes: string[]; preset: string; name: string }>) {
    const cur = live.current;
    const fields = {
      values: next.values ? { ...cur.values, ...next.values } : cur.values,
      volumes: next.volumes ?? cur.volumes,
      preset: next.preset ?? cur.preset,
      name: next.name ?? cur.name,
    };
    live.current = { ...cur, ...fields };
    if (next.values !== undefined) setValues(fields.values);
    if (next.volumes !== undefined) setVolumes(fields.volumes);
    if (next.preset !== undefined) setPreset(fields.preset);
    if (next.name !== undefined) setName(fields.name);
    const run = async () => {
      const scoped = ids();
      if (!scoped.project_id || !scoped.simulation_id) {
        setNote('Create a simulation first.');
        return;
      }
      const m = live.current.model;
      if (!m) {
        setNote("Fluids are not available: this simulation's analysis plugin is off or did not load.");
        return;
      }
      const rec = materialRecord(m, live.current.material, fields, {
        simulation_id: scoped.simulation_id,
        geometry_id: scoped.geometry_id || undefined,
        project_id: scoped.project_id,
      }, new Date().toISOString());
      // Each record carries the rev its bodies were drawn at (a linked geometry's stamp).
      const [stamped] = stampRecords([rec as Record<string, unknown>]);
      const doc = await linkedWorkerRpc<{ materials?: SavedMaterial[]; air?: SavedMaterial }>('materials.set', {
        project_id: scoped.project_id,
        sim_id: scoped.simulation_id,
        body: {
          project_id: scoped.project_id,
          simulation_id: scoped.simulation_id,
          materials: [...live.current.others, stamped],
          air: stamped,
          only_id: rec.id,
        },
      });
      const saved = (doc.materials || []).find((r) => r.id === rec.id) || doc.air || rec;
      setMaterial(saved);
      setNote('');
      applyMaterial(saved as Record<string, unknown>, scoped.project_id);
    };
    const p = queue.current.then(run).catch((e) => setNote(e instanceof Error ? e.message : 'Material save failed'));
    queue.current = p;
    return p;
  }

  /** A preset loads its values; the custom preset keeps the numbers to edit. */
  function pickFluid(key: string) {
    const m = live.current.model;
    if (key === live.current.preset) return;
    const p = presetByKey(m, key);
    if (!p) return;
    if (p.key === customPresetKey(m)) return save({ preset: p.key, name: p.name });
    return save({ preset: p.key, name: p.name, values: presetValues(p) });
  }

  function toggleBody(body: string) {
    return save({ volumes: toggleVolume(live.current.volumes, body) });
  }

  // A linked geometry's body names arrive with its preview: show "Fluid (Body1)".
  useEffect(() => subscribeFaceNames(() => setBodies(geometryBodies())), []);

  useEffect(
    () =>
      subscribeBodyPicks((picked) => {
        const hit = picked[0];
        if (hit) void toggleBody(hit.name);
      }),
    [],
  );

  const listed = [...new Set([...bodies, ...volumes])];
  const fluids = presets(model);
  const title = name || defaultPreset(model)?.name || 'Material';
  const viscosityModel = model?.record_constants?.viscosity_model;
  const missing = registry && !model ? "Fluids are not available: this simulation's analysis plugin is off or did not load." : '';

  return (
    <PanelChrome
      title={title}
      onDelete={material ? () => void deleteMaterial().catch((e) => setNote(e instanceof Error ? e.message : 'Delete failed')) : undefined}
    >
      {missing ? (
        <p className="mat-assign-hint" role="status">
          {missing}
        </p>
      ) : null}
      {model ? (
        <div className="mat-row">
          <span className="mat-k">Fluid</span>
          <span className="mat-v">
            <select
              className="bc-input mat-wide-input"
              aria-label="Fluid"
              value={preset}
              onChange={(e) => void pickFluid(e.target.value)}
            >
              {fluids.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </span>
        </div>
      ) : null}
      {model && preset === customPresetKey(model) ? (
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
      {viscosityModel ? (
        <div className="mat-row">
          <span className="mat-k">Viscosity model</span>
          <span className="mat-v">{String(viscosityModel)}</span>
        </div>
      ) : null}
      {properties(model).map((prop) => {
        const q = prop.quantity;
        const unit = q ? preferredUnit(q, imperial) : prop.unit;
        const si = values[prop.key];
        const shown = q && si !== undefined ? convertQuantity(q, si, SI_DEFAULT[q], unit) : si;
        return (
          <div className="mat-row" key={prop.key} data-material-property={prop.key}>
            <span className="mat-k">{prop.label}</span>
            <span className="mat-v bc-value-row">
              <SciNumberInput
                value={shown ?? null}
                label={plainLabel(prop.label)}
                onCommit={(v) => {
                  if (!(v > 0)) return;
                  void save({ values: { [prop.key]: q ? convertQuantity(q, v, unit, SI_DEFAULT[q]) : v } });
                }}
              />
              <span className="bc-unit-label">{unit}</span>
            </span>
          </div>
        );
      })}
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
                  title={on ? `Unassign ${body}` : `Assign ${title} to ${body}`}
                  onClick={() => void toggleBody(body)}
                >
                  {bodyDisplay(body)}
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
