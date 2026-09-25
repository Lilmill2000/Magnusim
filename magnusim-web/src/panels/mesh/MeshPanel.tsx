import { useEffect, useRef, useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import type { RegistryRow } from '../../api/registry.gen';
import { apiGet } from '../../api/client';
import { workerRpc } from '../../api/workerRpc';
import { SchemaForm } from '../../forms/SchemaForm';
import { formatElapsed, useElapsed } from '../../store/jobs';
import { useProjectStore } from '../../store/project';
import { dispatchPanelDone, type IslandProps } from '../../islands';
import { PanelChrome } from '../PanelChrome';
import {
  copyMeshSettings,
  deleteMesh,
  generateMesh,
  meshCopyNow,
  meshCopyPick,
  meshJobNow,
  openMeshSettings,
  renameMesh,
  restoreMeshDefaults,
  subscribeMeshCopy,
  subscribeMeshJob,
  subscribeMeshSettings,
  type MeshCopyState,
  type MeshGenerateKind,
  type MeshJobState,
} from '../legacyBridge';
import { scopeIds, useRegistryReady } from '../scope';

/** Settings as they live on disk (mesh.json `settings`). */
interface MeshSettingsDoc {
  name?: string;
  fineness?: number;
  hex_element_core?: boolean;
  automatic_boundary_layers?: boolean;
  physics_based_meshing?: boolean;
  sizing?: string;
  advanced?: {
    mesh_engine?: string;
    small_feature_suppression?: string | number | null;
    gap_refinement_factor?: number;
    global_gradation_rate?: number;
  };
}

interface MeshDoc {
  id?: string;
  name?: string;
  n_cells?: number;
  n_points?: number;
  settings?: MeshSettingsDoc;
  ui_mesh_engine?: string;
}

export function meshEngines(rows: RegistryRow[]): RegistryRow[] {
  return rows.filter((row) => String(row.key || '').trim());
}

function schemaFor(key: string, rows: RegistryRow[]): RJSFSchema {
  const row = rows.find((item) => item.key === key) || rows.find((item) => item.key === 'standard');
  return ((row?.schema || row?.settings_schema) as RJSFSchema | undefined) || {
    type: 'object',
    properties: {},
  };
}

/** The legacy fixed default reads as "automatic" so old projects show an empty box. */
const LEGACY_AUTO_SFS = '4.227e-6';

/** Form values (schema keys) from the on-disk settings. */
export function formValuesFrom(settings: MeshSettingsDoc | undefined): Record<string, unknown> {
  const s = settings || {};
  const adv = s.advanced || {};
  const sfs = adv.small_feature_suppression;
  const sfsText = sfs == null || String(sfs) === LEGACY_AUTO_SFS ? '' : String(sfs);
  const values: Record<string, unknown> = {};
  if (s.fineness != null) values.fineness = Number(s.fineness);
  if (s.automatic_boundary_layers != null) values.add_layers = !!s.automatic_boundary_layers;
  if (s.physics_based_meshing != null) values.physics_based = !!s.physics_based_meshing;
  if (s.hex_element_core != null) values.hex_element_core = !!s.hex_element_core;
  values.small_feature_suppression = sfsText;
  if (adv.gap_refinement_factor != null) values.gap_refinement_factor = Number(adv.gap_refinement_factor);
  if (adv.global_gradation_rate != null) values.global_gradation_rate = Number(adv.global_gradation_rate);
  return values;
}

/** On-disk settings from the form values. Every advanced key is sent so nothing is left to a merge. */
export function settingsFrom(values: Record<string, unknown>, engine: string): Record<string, unknown> {
  const advanced: Record<string, unknown> = { mesh_engine: engine };
  if (values.small_feature_suppression !== undefined) {
    advanced.small_feature_suppression = String(values.small_feature_suppression ?? '').trim();
    advanced.small_feature_suppression_unit = 'm';
  }
  if (values.gap_refinement_factor != null) advanced.gap_refinement_factor = Number(values.gap_refinement_factor);
  if (values.global_gradation_rate != null) advanced.global_gradation_rate = Number(values.global_gradation_rate);
  const body: Record<string, unknown> = { ui_mesh_engine: engine, advanced };
  if (values.fineness != null) body.fineness = Number(values.fineness);
  if (values.hex_element_core != null) body.hex_element_core = !!values.hex_element_core;
  if (values.add_layers != null) body.automatic_boundary_layers = !!values.add_layers;
  if (values.physics_based != null) body.physics_based_meshing = !!values.physics_based;
  // Manual sizing is not implemented by any mesher; the panel shows Sizing as a fixed row.
  body.sizing = 'Automatic';
  return body;
}

export function generateButtonFor(kind: MeshGenerateKind): { text: string; title: string; disabled: boolean } {
  switch (kind) {
    case 'generating':
      return { text: 'Generating…', title: 'This mesh is generating', disabled: true };
    case 'queued':
      return { text: 'Remove from queue', title: 'Remove this mesh from the queue', disabled: false };
    case 'queue':
      return { text: 'Add to queue', title: 'Generate this mesh when the current job finishes', disabled: false };
    default:
      return { text: 'Generate', title: 'Generate the mesh', disabled: false };
  }
}

function jobIsForMesh(job: MeshJobState | null, meshId: string): job is MeshJobState {
  if (!job) return false;
  if (!meshId || !job.mesh_id) return true;
  return String(job.mesh_id) === String(meshId);
}

/** Runtime mesh job state for one mesh, live. */
function useMeshJob(meshId: string): MeshJobState | null {
  const [job, setJob] = useState<MeshJobState | null>(() => {
    const now = meshJobNow();
    return jobIsForMesh(now, meshId) ? now : null;
  });
  useEffect(() => {
    const now = meshJobNow();
    setJob(jobIsForMesh(now, meshId) ? now : null);
    return subscribeMeshJob((next) => {
      if (jobIsForMesh(next, meshId)) setJob(next);
    });
  }, [meshId]);
  return job;
}

function useMeshCopy(meshId: string): MeshCopyState | null {
  const [copy, setCopy] = useState<MeshCopyState | null>(() => meshCopyNow());
  useEffect(() => {
    setCopy(meshCopyNow());
    return subscribeMeshCopy(setCopy);
  }, [meshId]);
  if (!copy || !copy.available) return null;
  if (meshId && copy.dest_id && String(copy.dest_id) !== String(meshId)) return null;
  return copy;
}

function formatCount(n: number | null | undefined): string {
  return n == null ? '–' : Number(n).toLocaleString();
}

/** "Waiting for Mesh 1 in Sample project to finish." */
export function queuedLine(queue: MeshJobState['queue']): string {
  const behind = queue?.behind ? `Waiting for ${queue.behind} to finish.` : 'Waiting for the current job to finish.';
  const place = queue?.position && queue.position > 1 ? ` Number ${queue.position} in the queue.` : '';
  return behind + place;
}

/** The progress block under Generate: what V0.1.0 showed in #mesh-finished. */
function MeshStatus({ job }: { job: MeshJobState | null }) {
  const ticking = useElapsed(job?.started_at ?? undefined, job?.finished_at ?? undefined);
  if (!job || job.phase === 'idle') return null;
  if (job.phase === 'queued') {
    return (
      <div className="mesh-finished" data-mesh-status="queued">
        <div className="mat-k">Queued</div>
        <div className="mesh-finished-line">{queuedLine(job.queue)}</div>
      </div>
    );
  }
  const elapsed = job.started_at ? ticking : job.elapsed_ms != null ? formatElapsed(job.elapsed_ms) : '';
  const running = job.phase === 'generating';
  const finishing = job.phase === 'finishing';
  const ready = job.phase === 'ready';
  const failed = job.phase === 'failed';
  const title = failed ? 'Mesh failed' : running ? 'Generating mesh' : finishing ? 'Finishing mesh' : 'Mesh ready';
  let line = '';
  if (failed) line = job.error || 'Generate failed. Open Job / debug for the log.';
  else if (running) line = `${job.stage_text || 'Working'}…`;
  else if (finishing) line = 'Writing the mesh into the project…';
  else if (ready) line = `${formatCount(job.n_cells)} cells / ${formatCount(job.n_points)} nodes`;
  const meta = [...(ready ? job.meta_bits : []), ...((ready || failed) && elapsed ? [elapsed] : [])];
  return (
    <div className="mesh-finished" data-mesh-status={job.phase}>
      <div className="mat-k">{title}</div>
      <div
        className="mesh-finished-line"
        data-n-cells={ready && job.n_cells != null ? job.n_cells : undefined}
        data-n-points={ready && job.n_points != null ? job.n_points : undefined}
        data-source={ready ? job.counts_source : undefined}
      >
        {line}
      </div>
      {(running || finishing) && elapsed ? <div className="mesh-elapsed">{elapsed}</div> : null}
      {meta.length ? <div className="mesh-finished-meta">{meta.join(' · ')}</div> : null}
    </div>
  );
}

function MeshTitle({ name, onRename }: { name: string; onRename: (next: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);
  function stop(commit: boolean) {
    setEditing(false);
    const next = draft.trim();
    if (commit && next && next !== name) void onRename(next);
    else setDraft(name);
  }
  return (
    <div className="mat-panel-head">
      <div className="mesh-title-row">
        {editing ? (
          <input
            type="text"
            className="mesh-rename-input"
            maxLength={64}
            aria-label="Mesh name"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => stop(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stop(true);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                stop(false);
              }
            }}
          />
        ) : (
          <>
            <span className="mat-panel-title" data-mesh-title="1">
              {name}
            </span>
            <button
              type="button"
              className="mesh-rename"
              title="Rename mesh"
              aria-label="Rename mesh"
              onClick={() => setEditing(true)}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
                <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 16.8V20h3.2L18.4 8.8l-3.2-3.2L4 16.8z" />
                  <path d="M13.8 6.9l3.2 3.2" />
                </g>
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function CopyFromMesh({ copy, meshId, onCopied }: { copy: MeshCopyState; meshId: string; onCopied: () => void }) {
  const [busy, setBusy] = useState(false);
  async function pick(sourceId: string) {
    if (!sourceId) return;
    setBusy(true);
    try {
      await copyMeshSettings(sourceId);
      onCopied();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="sim-copy-from" data-mesh-copy="1">
      {copy.picking ? (
        <div className="sim-copy-picker">
          <label className="mat-k" htmlFor="mesh-copy-source">
            Copy settings from
          </label>
          <select
            id="mesh-copy-source"
            className="bc-select"
            aria-label="Mesh to copy settings from"
            defaultValue=""
            disabled={busy}
            onChange={(e) => void pick(e.target.value)}
          >
            <option value="">Select a mesh…</option>
            {copy.sources.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
              </option>
            ))}
          </select>
          <p className="mat-assign-hint">Includes meshes on other geometries. Or click a mesh in the tree.</p>
          <button type="button" className="mat-clear-link" onClick={() => meshCopyPick(false, meshId)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="fp-btn" onClick={() => meshCopyPick(true, meshId)}>
          Copy from another mesh
        </button>
      )}
      {copy.note ? <p className="mat-assign-hint">{copy.note}</p> : null}
    </div>
  );
}

export function MeshSettings(props: IslandProps) {
  const registry = useRegistryReady();
  const rows = meshEngines((registry?.mesher || []) as RegistryRow[]);
  const [engine, setEngine] = useState('standard');
  const [data, setData] = useState<Record<string, unknown>>({});
  const [meshId, setMeshId] = useState(props.itemId || '');
  const [name, setName] = useState('Mesh 1');
  const [note, setNote] = useState('');
  const live = useRef(data);
  const schema = schemaFor(engine, rows);
  const job = useMeshJob(meshId);
  const copy = useMeshCopy(meshId);
  const button = generateButtonFor(job?.generate_kind || 'generate');

  function ids() {
    return scopeIds({
      ...props,
      projectId: props.projectId || useProjectStore.getState().projectId || '',
      itemId: meshId || props.itemId,
    });
  }

  function applyDoc(mesh: MeshDoc | undefined) {
    if (!mesh) return;
    if (mesh.id) setMeshId(String(mesh.id));
    if (mesh.name || mesh.settings?.name) setName(String(mesh.name || mesh.settings?.name));
    const settings = mesh.settings || {};
    setEngine(String(mesh.ui_mesh_engine || settings.advanced?.mesh_engine || 'standard'));
    const next = formValuesFrom(settings);
    live.current = next;
    setData(next);
  }

  function load() {
    const scoped = scopeIds(props);
    return apiGet('/api/mesh', {
      project_id: scoped.project_id || undefined,
      simulation_id: scoped.simulation_id || undefined,
      mesh_id: scoped.mesh_id || scoped.item_id || undefined,
    })
      .then((j) => applyDoc((j as { mesh?: MeshDoc }).mesh))
      .catch(() => {});
  }

  useEffect(() => {
    void load();
  }, [props.projectId, props.simId, props.itemId, props.scope]);

  useEffect(
    () =>
      subscribeMeshSettings((ev) => {
        if (meshId && ev.mesh_id && String(ev.mesh_id) !== String(meshId)) return;
        applyDoc({ settings: ev.settings as MeshSettingsDoc, name: (ev.settings as MeshSettingsDoc).name });
      }),
    [meshId],
  );

  useEffect(() => {
    if (job?.name && job.mesh_id && String(job.mesh_id) === String(meshId)) setName(job.name);
  }, [job?.name, job?.mesh_id, meshId]);

  async function save(values: Record<string, unknown>, nextEngine = engine) {
    const scoped = ids();
    const settings = settingsFrom(values, nextEngine);
    const mesh = scoped.mesh_id || meshId || undefined;
    await workerRpc('mesh.set', {
      project_id: scoped.project_id,
      sim_id: scoped.simulation_id,
      body: {
        simulation_id: scoped.simulation_id,
        geometry_id: scoped.geometry_id || undefined,
        mesh_id: mesh,
        id: mesh,
        active_id: mesh,
        settings,
        meshes: mesh ? [{ id: mesh, settings, simulation_id: scoped.simulation_id }] : [],
      },
    });
    return settings;
  }

  async function generate() {
    setNote('');
    try {
      const settings = await save(live.current);
      await generateMesh({ mesh_id: meshId || undefined, settings });
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Generate failed to start');
    }
  }

  async function restore() {
    setNote('');
    try {
      await restoreMeshDefaults();
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Restore defaults failed');
    }
  }

  async function rename(next: string) {
    setName(next);
    try {
      setName(await renameMesh(next));
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Rename failed');
    }
  }

  function done() {
    void save(live.current).catch(() => {});
    dispatchPanelDone();
  }

  const engineLabel = rows.find((row) => row.key === engine)?.label || engine;
  const engineRow = (
    <div className="mat-row">
      <span
        className="mat-k"
        title="Standard: CAD-fitted surface, hex element core and boundary layers. cfMesh: legacy cartesianMesh (hex element core only)."
      >
        Mesh engine
      </span>
      <span className="mat-v">
        <select
          className="bc-input"
          data-mesh-engine="1"
          aria-label="Mesh engine"
          value={engine}
          onChange={(e) => {
            const next = e.target.value;
            setEngine(next);
            void save(live.current, next);
          }}
        >
          {rows.map((row) => (
            <option key={row.key} value={row.key}>
              {row.label || row.key}
            </option>
          ))}
        </select>
      </span>
    </div>
  );

  return (
    <div data-mesh-settings-panel="1">
      <MeshTitle name={name} onRename={rename} />
      <div className="mat-panel-body">
        {copy ? <CopyFromMesh copy={copy} meshId={meshId} onCopied={() => void load()} /> : null}
        <div className="mat-row">
          <span className="mat-k">Algorithm</span>
          <span className="mat-v" data-mesh-algorithm="1">
            {engineLabel}
          </span>
        </div>
        <div className="mat-row">
          <span className="mat-k">Sizing</span>
          <span className="mat-v">Automatic</span>
        </div>
        <SchemaForm
          schema={schema}
          formData={data}
          hideFooter
          advancedExtra={engineRow}
          onLive={(values) => {
            live.current = values;
            setData(values);
          }}
          onCommit={(values) => {
            live.current = values;
            setData(values);
            void save(values);
          }}
        />
        <div className="mesh-generate-row">
          <button
            type="button"
            className="fp-btn fp-btn-primary"
            data-mesh-generate="1"
            title={button.title}
            disabled={button.disabled}
            onClick={() => void generate()}
          >
            {button.text}
          </button>
        </div>
        <MeshStatus job={job} />
        {note ? (
          <p className="mat-assign-hint" role="alert">
            {note}
          </p>
        ) : null}
        <div className="mat-panel-foot">
          <div className="mesh-foot-left">
            <button type="button" className="mat-clear-link" title="Reset meshing settings to defaults" onClick={() => void restore()}>
              Restore defaults
            </button>
            {job?.can_delete ? (
              <button type="button" className="mat-clear-link" title="Delete mesh" onClick={() => void deleteMesh()}>
                Delete
              </button>
            ) : null}
          </div>
          <button type="button" className="js-btn tree-panel-done" onClick={done}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** The inspect flyout: name, counts, Settings, Delete. Mirrors the viewport mesh card. */
export function MeshInspect(props: IslandProps) {
  const ids = scopeIds(props);
  const meshId = ids.mesh_id || ids.item_id;
  const [name, setName] = useState('');
  const [cells, setCells] = useState<number | null>(null);
  const [points, setPoints] = useState<number | null>(null);
  const job = useMeshJob(meshId);

  useEffect(() => {
    const projectId = ids.project_id;
    if (!projectId) return;
    void apiGet('/api/project/tree', { project_id: projectId })
      .then((doc) => {
        const geoms = (doc as { geometries?: Array<{ studies?: Array<{ meshes?: MeshDoc[] }> }> }).geometries || [];
        for (const geom of geoms) {
          for (const study of geom.studies || []) {
            for (const mesh of study.meshes || []) {
              if (!meshId || String(mesh.id || '') === meshId) {
                setName(String(mesh.name || mesh.id || 'Mesh'));
                setCells(typeof mesh.n_cells === 'number' ? mesh.n_cells : null);
                setPoints(typeof mesh.n_points === 'number' ? mesh.n_points : null);
                return;
              }
            }
          }
        }
      })
      .catch(() => {});
  }, [ids.project_id, meshId]);

  const ready = job?.phase === 'ready';
  const liveCells = ready && job?.n_cells != null ? job.n_cells : cells;
  const livePoints = ready && job?.n_points != null ? job.n_points : points;
  const status =
    job?.phase === 'queued'
      ? 'Queued'
      : job?.phase === 'generating'
        ? `${job.stage_text || 'Generating'}…`
        : job?.phase === 'finishing'
          ? 'Finishing mesh'
          : job?.phase === 'failed'
            ? 'Mesh failed'
            : liveCells != null
              ? 'Generated'
              : 'No mesh';
  const counts =
    liveCells != null && livePoints != null
      ? `${formatCount(liveCells)} cells · ${formatCount(livePoints)} nodes`
      : liveCells != null
        ? `${formatCount(liveCells)} cells`
        : '';

  return (
    <PanelChrome
      title={job?.name || name || 'Mesh'}
      onDelete={ready ? () => void deleteMesh() : undefined}
    >
      <p className="mesh-chip-line" data-mesh-id={meshId}>
        {status}
      </p>
      {counts ? <p className="mesh-chip-size">{counts}</p> : null}
      <div className="mesh-chip-actions">
        <button type="button" className="mat-clear-link" data-mesh-settings="1" onClick={() => openMeshSettings(meshId)}>
          Settings
        </button>
      </div>
    </PanelChrome>
  );
}
