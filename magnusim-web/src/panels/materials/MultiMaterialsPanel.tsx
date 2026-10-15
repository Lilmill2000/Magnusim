import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../../api/client';
import { bodyDisplay, subscribeFaceNames } from '../../workbench/faceNames';
import { linkedWorkerRpc, stampRecords } from '../../workbench/geometryRev';
import { SciNumberInput } from '../../forms/SciNumberInput';
import {
  customPresetKey,
  defaultPreset,
  materialRecord,
  modelOf,
  modelsFor,
  presetByKey,
  presetOf,
  presets,
  presetValues,
  properties,
  recordValues,
  roleOf,
  takesAnyNumber,
  type MaterialModelRow,
  type SavedMaterial,
} from '../../materialModel';
import { prefersImperial } from '../../prefs';
import { useProjectStore } from '../../store/project';
import type { IslandProps } from '../../islands';
import { convertQuantity, preferredUnit, SI_DEFAULT } from '../../units/convert';
import { subscribeBodyPicks } from '../../viewer/pick';
import { addMaterial, applyMaterial, deleteMaterial, geometryBodies, openMaterial } from '../legacyBridge';
import { PanelChrome } from '../PanelChrome';
import { scopeIds } from '../scope';

/**
 * Materials of a study whose analysis offers several material models (host API
 * 1.8, e.g. a fluid and solids for heat transfer). The study holds one record
 * per group of bodies; a body belongs to one record at a time.
 *
 * - The Materials hub (or the panel opened on no record) lists the records.
 * - The material picker (the tree's "+") makes a new record on its first change.
 * - A record's row opens it: its type (the analysis's models), its preset,
 *   its properties and its bodies. Changes save at once.
 */

const ROLE_LABEL = { fluid: 'Fluid', solid: 'Solid' } as const;

function volumesOf(m: SavedMaterial | null | undefined): string[] {
  return Array.isArray(m?.assigned_volumes) ? m.assigned_volumes.map(String) : [];
}

/** A property's label without its leading symbol: "(k) Thermal conductivity" is "Thermal conductivity". */
function plainLabel(label: string): string {
  return label.replace(/^\([^)]*\)\s*/, '') || label;
}

/** `rec` with `bodies` taken off it (another record took them), or null when it had none of them. */
export function withoutBodies(rec: SavedMaterial, bodies: string[], now: string): SavedMaterial | null {
  const had = volumesOf(rec);
  const kept = had.filter((v) => !bodies.includes(v));
  if (kept.length === had.length) return null;
  const next: SavedMaterial = {
    ...rec,
    assigned_volumes: kept,
    assigned_volume: kept[0] || null,
    body_ids: kept.slice(),
    volume_ids: kept.slice(),
    updated_at: now,
  };
  // Its bodies are drawn from the geometry shown now: it takes the current stamp.
  delete next.geometry_rev;
  return next;
}

/** What the panel shows: the list, a new record, or one record. */
export function materialsView(panelId: string, itemId: string | undefined): 'list' | 'new' | 'record' {
  if (panelId === 'panel-material-picker') return 'new';
  if (panelId === 'panel-air-material' && itemId) return 'record';
  return 'list';
}

interface Draft {
  model: string;
  preset: string;
  name: string;
  values: Record<string, number>;
  volumes: string[];
}

function draftFor(model: MaterialModelRow | undefined, rec: SavedMaterial | null): Draft {
  const p = rec ? presetOf(model, rec) : defaultPreset(model);
  const custom = !!p && p.key === customPresetKey(model);
  return {
    model: String(model?.key || ''),
    preset: String(p?.key || ''),
    name: custom ? String(rec?.name || p?.name || '') : String(p?.name || rec?.name || ''),
    values: rec ? recordValues(model, rec) : presetValues(p),
    volumes: volumesOf(rec),
  };
}

export function MultiMaterialsPanel(props: IslandProps & { analysisKey: string }) {
  const { analysisKey } = props;
  const view = materialsView(props.panelId, props.itemId);
  const models = modelsFor(analysisKey);
  const [rows, setRows] = useState<SavedMaterial[] | null>(null);
  // The record this panel edits: the row's, or the one a new material became.
  const [editId, setEditId] = useState<string>(view === 'record' ? String(props.itemId || '') : '');
  const [draft, setDraft] = useState<Draft>(() => draftFor(models[0], null));
  const [bodies, setBodies] = useState<string[]>(() => geometryBodies());
  const [note, setNote] = useState('');
  const imperial = prefersImperial();
  const live = useRef({ rows, editId, draft });
  live.current = { rows, editId, draft };
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  function ids() {
    return scopeIds({ ...props, projectId: props.projectId || useProjectStore.getState().projectId || '' });
  }

  function show(list: SavedMaterial[], id: string) {
    const rec = id ? list.find((r) => String(r.id) === id) || null : null;
    setRows(list);
    if (view !== 'list' && (rec || !id)) {
      const next = draftFor(rec ? modelOf(rec, analysisKey) : modelsFor(analysisKey)[0], rec);
      setDraft(next);
      live.current = { ...live.current, rows: list, draft: next };
    }
  }

  function load() {
    const scoped = scopeIds(props);
    void apiGet('/api/materials', {
      project_id: scoped.project_id || undefined,
      simulation_id: scoped.simulation_id || undefined,
    })
      .then((j) => {
        const doc = j as { materials?: SavedMaterial[] };
        show(Array.isArray(doc.materials) ? doc.materials : [], live.current.editId);
      })
      .catch((e) => setNote(`Could not read this simulation's materials: ${e instanceof Error ? e.message : String(e)}`));
    setBodies(geometryBodies());
  }

  useEffect(() => {
    load();
    const onMaterial = () => load();
    window.addEventListener('cfd:material', onMaterial);
    return () => window.removeEventListener('cfd:material', onMaterial);
  }, [props.projectId, props.simId, props.scope]);

  useEffect(() => subscribeFaceNames(() => setBodies(geometryBodies())), []);

  /** Write the record (and any record a body moved away from) through the worker. Saves run one at a time. */
  function save(next: Partial<Draft>): Promise<unknown> {
    const fields = { ...live.current.draft, ...next };
    setDraft(fields);
    live.current = { ...live.current, draft: fields };
    const run = async () => {
      const scoped = ids();
      if (!scoped.project_id || !scoped.simulation_id) {
        setNote('Create a simulation first.');
        return;
      }
      const list = live.current.rows || [];
      const model = modelsFor(analysisKey).find((m) => m.key === fields.model);
      if (!model) {
        setNote("Materials are not available: this simulation's analysis plugin is off or did not load.");
        return;
      }
      const now = new Date().toISOString();
      const id = live.current.editId;
      const saved = id ? list.find((r) => String(r.id) === id) || null : null;
      // A record that changes type keeps only what every record has.
      const base: SavedMaterial | null =
        saved && saved.material_model && saved.material_model !== model.key
          ? { id: saved.id, created_at: saved.created_at, simulation_id: saved.simulation_id }
          : saved;
      const rec = materialRecord(model, base, fields, {
        simulation_id: scoped.simulation_id,
        geometry_id: scoped.geometry_id || undefined,
        project_id: scoped.project_id,
      }, now);
      const moved: SavedMaterial[] = [];
      const others = list
        .filter((r) => String(r.id) !== String(rec.id))
        .map((r) => {
          const left = withoutBodies(r, fields.volumes, now);
          if (left) moved.push(left);
          return left || r;
        });
      const stamped = stampRecords([...moved, rec] as Record<string, unknown>[]) as SavedMaterial[];
      const byId = new Map(stamped.map((r) => [String(r.id), r]));
      const materials = [...others.map((r) => byId.get(String(r.id)) || r), byId.get(String(rec.id)) || rec];
      const doc = await linkedWorkerRpc<{ materials?: SavedMaterial[] }>('materials.set', {
        project_id: scoped.project_id,
        sim_id: scoped.simulation_id,
        body: {
          project_id: scoped.project_id,
          simulation_id: scoped.simulation_id,
          materials,
          air: byId.get(String(rec.id)) || rec,
          only_id: rec.id,
          only_ids: stamped.map((r) => String(r.id)),
        },
      });
      const after = Array.isArray(doc.materials) && doc.materials.length ? doc.materials : materials;
      const mine = after.find((r) => String(r.id) === String(rec.id)) || rec;
      setEditId(String(rec.id));
      live.current = { ...live.current, editId: String(rec.id), rows: after };
      setRows(after);
      setNote('');
      applyMaterial(mine as Record<string, unknown>, scoped.project_id);
      window.dispatchEvent(new CustomEvent('cfd:material'));
    };
    const p = queue.current.then(run).catch((e) => setNote(e instanceof Error ? e.message : 'Material save failed'));
    queue.current = p;
    return p;
  }

  function pickModel(key: string) {
    if (key === live.current.draft.model) return;
    const model = modelsFor(analysisKey).find((m) => m.key === key);
    const p = defaultPreset(model);
    return save({ model: key, preset: String(p?.key || ''), name: String(p?.name || ''), values: presetValues(p) });
  }

  function pickPreset(key: string) {
    const model = modelsFor(analysisKey).find((m) => m.key === live.current.draft.model);
    if (key === live.current.draft.preset) return;
    const p = presetByKey(model, key);
    if (!p) return;
    if (p.key === customPresetKey(model)) return save({ preset: p.key, name: p.name });
    // A value the new preset does not define (a solid's heat source) stays with the record;
    // one it defines is the preset's.
    const own = live.current.draft.values;
    const fill = presetValues(p);
    const kept = Object.fromEntries(
      properties(model)
        .filter((prop) => !(prop.key in fill) && own[prop.key] !== undefined)
        .map((prop) => [prop.key, own[prop.key]]),
    );
    return save({ preset: p.key, name: p.name, values: { ...kept, ...fill } });
  }

  function toggleBody(body: string) {
    const vols = live.current.draft.volumes;
    return save({ volumes: vols.includes(body) ? vols.filter((v) => v !== body) : [...vols, body] });
  }

  useEffect(() => {
    if (view === 'list') return undefined;
    return subscribeBodyPicks((picked) => {
      const hit = picked[0];
      if (hit) void toggleBody(hit.name);
    });
  }, [view]);

  if (view === 'list') {
    const list = rows || [];
    return (
      <PanelChrome title="Materials">
        {rows === null && !note ? (
          <p className="mat-assign-hint" role="status" data-material-loading="1">
            Loading the materials…
          </p>
        ) : null}
        {rows !== null && !list.length ? (
          <p className="mat-assign-hint">No materials yet. Add one, then give it the bodies it fills.</p>
        ) : null}
        {list.length ? (
          <ul className="mat-assign-list" aria-label="Materials" data-materials-list="1">
            {list.map((m) => {
              const model = modelOf(m, analysisKey);
              const vols = volumesOf(m);
              return (
                <li key={String(m.id)} className="bc-assign-item" data-material-row={String(m.id)}>
                  <button type="button" className="bc-assign-pick" onClick={() => openMaterial(String(m.id))}>
                    {String(m.name || model?.label || 'Material')}
                  </button>
                  <span className="mat-assign-state">
                    {`${ROLE_LABEL[roleOf(model)]} · ${vols.length} ${vols.length === 1 ? 'body' : 'bodies'}`}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="mat-assign-block">
          <button type="button" className="mat-clear-link" data-material-add="1" onClick={() => addMaterial()}>
            Add material
          </button>
        </div>
        {note ? (
          <p className="mat-assign-hint" role="alert">
            {note}
          </p>
        ) : null}
      </PanelChrome>
    );
  }

  const model = models.find((m) => m.key === draft.model) || models[0];
  const role = roleOf(model);
  const list = rows || [];
  const owner = new Map<string, SavedMaterial>();
  for (const r of list) if (String(r.id) !== editId) for (const v of volumesOf(r)) owner.set(v, r);
  const listed = [...new Set([...bodies, ...draft.volumes])];
  const title = draft.name || defaultPreset(model)?.name || 'Material';
  const missingRecord = view === 'record' && rows !== null && !list.some((r) => String(r.id) === editId);

  return (
    <PanelChrome
      title={title}
      onDelete={
        editId && !missingRecord
          ? () => void deleteMaterial(editId).catch((e) => setNote(e instanceof Error ? e.message : 'Delete failed'))
          : undefined
      }
    >
      {rows === null ? (
        <p className="mat-assign-hint" role="status" data-material-loading="1">
          Loading the material…
        </p>
      ) : null}
      {missingRecord ? (
        <p className="mat-assign-hint" role="status">
          This material was deleted.
        </p>
      ) : null}
      {rows !== null && !missingRecord ? (
        <>
          <div className="mat-row">
            <span className="mat-k">Type</span>
            <span className="mat-v">
              <select
                className="bc-input mat-wide-input"
                aria-label="Material type"
                data-material-model="1"
                value={draft.model}
                onChange={(e) => void pickModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label || ROLE_LABEL[roleOf(m)]}
                  </option>
                ))}
              </select>
            </span>
          </div>
          <div className="mat-row">
            <span className="mat-k">{ROLE_LABEL[role]}</span>
            <span className="mat-v">
              <select
                className="bc-input mat-wide-input"
                aria-label={ROLE_LABEL[role]}
                value={draft.preset}
                onChange={(e) => void pickPreset(e.target.value)}
              >
                {presets(model).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            </span>
          </div>
          {draft.preset === customPresetKey(model) ? (
            <div className="mat-row">
              <span className="mat-k">Name</span>
              <span className="mat-v">
                <input
                  className="bc-input mat-wide-input"
                  aria-label="Material name"
                  defaultValue={draft.name}
                  key={`name-${editId}-${draft.name}`}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== live.current.draft.name) void save({ name: v });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                />
              </span>
            </div>
          ) : null}
          {properties(model).map((prop) => {
            const q = prop.quantity;
            const unit = q ? preferredUnit(q, imperial) : prop.unit;
            const si = draft.values[prop.key];
            const shown = q && si !== undefined ? convertQuantity(q, si, SI_DEFAULT[q], unit) : si;
            return (
              <div className="mat-row" key={`${draft.model}:${prop.key}`} data-material-property={prop.key}>
                <span className="mat-k">{prop.label}</span>
                <span className="mat-v bc-value-row">
                  <SciNumberInput
                    value={shown ?? null}
                    label={plainLabel(prop.label)}
                    onCommit={(v) => {
                      if (takesAnyNumber(prop) ? !Number.isFinite(v) : !(v > 0)) return;
                      const values = { ...live.current.draft.values, [prop.key]: q ? convertQuantity(q, v, unit, SI_DEFAULT[q]) : v };
                      void save({ values });
                    }}
                  />
                  <span className="bc-unit-label">{unit}</span>
                </span>
              </div>
            );
          })}
          <div className="mat-assign-block">
            <div className="mat-assign-head">
              <span className="mat-k">Assigned bodies ({draft.volumes.length})</span>
              <button
                type="button"
                className="mat-clear-link"
                disabled={!draft.volumes.length}
                onClick={() => void save({ volumes: [] })}
              >
                Clear list
              </button>
            </div>
            <ul className="mat-assign-list" aria-label="Assigned bodies" data-material-volumes="1">
              {listed.map((body) => {
                const on = draft.volumes.includes(body);
                const other = !on ? owner.get(body) : undefined;
                return (
                  <li
                    key={body}
                    className={`bc-assign-item${on ? ' is-focus' : ''}`}
                    data-volume={body}
                    data-assigned={on ? '1' : '0'}
                  >
                    <button
                      type="button"
                      className="bc-assign-pick"
                      aria-pressed={on}
                      title={on ? `Unassign ${body}` : `Assign ${title} to ${body}`}
                      onClick={() => void toggleBody(body)}
                    >
                      {bodyDisplay(body)}
                    </button>
                    <span className="mat-assign-state">
                      {on ? 'Assigned' : other ? `In ${String(other.name || 'another material')}` : 'Not assigned'}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="mat-assign-hint" data-material-picking="1">
              Click a body in the viewport or in this list. A body belongs to one material: assigning it here takes it
              from the other. Changes save automatically.
            </div>
          </div>
        </>
      ) : null}
      {note ? (
        <p className="mat-assign-hint" role="alert">
          {note}
        </p>
      ) : null}
    </PanelChrome>
  );
}
