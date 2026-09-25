import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { RJSFSchema } from '@rjsf/utils';
import { apiGet } from '../api/client';
import type { RegistryRow } from '../api/registry.gen';
import { SchemaForm } from '../forms/SchemaForm';
import { PanelBoundary } from '../islands';
import { filterWidgetEntries, panelsFor, useViewer } from '../plugin-api';
import { sameProjectRuns } from '../panels/run/residuals';
import { useProjectStore } from '../store/project';
import type { LayerId } from '../viewer/layers';

function useFiltersHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const panel = document.getElementById('filters-panel');
    if (!panel) return;
    let slot = document.getElementById('filters-island');
    if (!slot) {
      slot = document.createElement('div');
      slot.id = 'filters-island';
      panel.appendChild(slot);
    }
    setHost(slot);
  }, []);
  return host;
}

function Hosted({ children }: { children: ReactNode }) {
  const host = useFiltersHost();
  if (!children) return null;
  if (host) return createPortal(children, host);
  return <>{children}</>;
}

function usePanelTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener('cfd:panels', bump);
    return () => window.removeEventListener('cfd:panels', bump);
  }, []);
  return tick;
}

const FILTER_LAYERS: Record<string, LayerId> = {
  cut_plane: 'cut_plane:0',
  mesh_surface: 'mesh_surface',
  mesh_section: 'cut_plane:0',
  surface_field: 'surface_field',
  streamlines: 'streamlines',
  iso_surface: 'iso',
  iso_volume: 'iso_volume',
  inspect_point: 'inspect_marker',
};

async function runFilterTool(key: string, projectId: string, values: Record<string, unknown>) {
  const params = new URLSearchParams({ project_id: projectId });
  for (const [name, value] of Object.entries(values)) {
    if (value == null || value === '') continue;
    if (name === 'case') params.set('case_dir', String(value));
    else params.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const response = await fetch(`/api/filter/${encodeURIComponent(key)}?${params.toString()}`);
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error || 'Filter failed');
  return body;
}

function FilterSection({ row, projectId }: { row: RegistryRow; projectId: string }) {
  const viewer = useViewer();
  const [note, setNote] = useState('');
  const schema = (row.schema || row.params_schema) as RJSFSchema | undefined;
  return (
    <section data-filter-key={row.key}>
      <h3>{row.label || row.key}</h3>
      {schema?.properties ? (
        <SchemaForm
          schema={schema}
          onLive={() => {}}
          onCommit={(values) => {
            void runFilterTool(row.key, projectId, values)
              .then(() => {
                const layer = FILTER_LAYERS[row.key];
                if (layer) viewer.setLayerVisible(layer, true);
                viewer.render();
                setNote('Updated');
              })
              .catch((error: unknown) => {
                setNote(error instanceof Error ? error.message : 'Filter failed');
              });
          }}
        />
      ) : null}
      {note ? <p data-filter-status={row.key}>{note}</p> : null}
    </section>
  );
}

/** One section per registry filter, plus plugin sections for this place. */
export function FiltersPanel() {
  useViewer();
  usePanelTick();
  const projectId = useProjectStore((s) => s.projectId);
  const filters = (useProjectStore((s) => s.registry?.filter) || []) as RegistryRow[];
  if (!projectId) return null;
  const placed = panelsFor('filters');
  const widgets = filterWidgetEntries();
  return (
    <Hosted>
      <div data-filters-panel="1">
        {filters.map((row) => (
          <FilterSection key={row.key} row={row} projectId={projectId} />
        ))}
        {placed.map((row) => (
          <section key={row.key} data-filter-section={row.key}>
            <PanelBoundary>
              <row.Component />
            </PanelBoundary>
          </section>
        ))}
        {widgets.map(([key, Widget]) => (
          <section key={key} data-filter-widget={key}>
            <PanelBoundary>
              <Widget />
            </PanelBoundary>
          </section>
        ))}
      </div>
    </Hosted>
  );
}

export function Legend() {
  const viewer = useViewer();
  const projectId = useProjectStore((s) => s.projectId);
  const [min, setMin] = useState('0');
  const [max, setMax] = useState('1');
  if (!projectId) return null;
  return (
    <Hosted>
      <section data-legend="1">
        <h3>Legend</h3>
        <label>
          Minimum
          <input aria-label="Legend minimum" value={min} onChange={(event) => setMin(event.target.value)} />
        </label>
        <label>
          Maximum
          <input aria-label="Legend maximum" value={max} onChange={(event) => setMax(event.target.value)} />
        </label>
        <button
          type="button"
          onClick={() => {
            const lo = Number(min);
            const hi = Number(max);
            const lut = viewer.createRainbowLut();
            viewer.setLutRange(lut, lo, hi);
            window.__CFD_HOST_SURFACES__?.setLegendRange(lo, hi);
            viewer.render();
          }}
        >
          Apply scale
        </button>
      </section>
    </Hosted>
  );
}

export function Timeline() {
  const viewer = useViewer();
  const projectId = useProjectStore((s) => s.projectId);
  const [times, setTimes] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!projectId) return;
    setTimes(window.__CFD_HOST_SURFACES__?.timelineTimes() || []);
  }, [projectId]);
  if (!projectId) return null;
  return (
    <Hosted>
      <section data-timeline="1">
        <h3>Timeline</h3>
        <input
          type="range"
          aria-label="Result time"
          min={0}
          max={Math.max(times.length - 1, 0)}
          value={Math.min(index, Math.max(times.length - 1, 0))}
          onChange={(event) => {
            const next = Number(event.target.value);
            setIndex(next);
            const time = times[next];
            if (time) void window.__CFD_HOST_SURFACES__?.setTimeline(time);
            viewer.render();
          }}
        />
        <span data-timeline-time="1">{times[index] || 'No saved times'}</span>
      </section>
    </Hosted>
  );
}

export function CompareLayout() {
  const viewer = useViewer();
  const projectId = useProjectStore((s) => s.projectId);
  const [runs, setRuns] = useState<Array<{ id: string; name: string; project_id?: string; case_dir?: string }>>([]);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!projectId) return;
    let dead = false;
    void apiGet<{ runs?: Array<{ id?: string; name?: string; project_id?: string; case_dir?: string }> }>('/api/run/status', {
      project_id: projectId,
    })
      .then((body) => {
        if (dead) return;
        const rows = (body.runs || []).filter((run) => !run.project_id || run.project_id === projectId);
        setRuns(
          rows
            .map((run) => ({
              id: String(run.id || ''),
              name: String(run.name || run.id || 'Run'),
              project_id: run.project_id,
              case_dir: run.case_dir,
            }))
            .filter((run) => run.id),
        );
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [projectId]);
  if (!projectId) return null;
  const options = runs.map((run) => (
    <option key={run.id} value={run.id}>
      {run.name}
    </option>
  ));
  return (
    <Hosted>
      <section data-compare="1">
        <label>
          Run A
          <select data-compare-run="a" aria-label="Compare run A" value={left} onChange={(event) => setLeft(event.target.value)}>
            <option value="">Select a run</option>
            {options}
          </select>
        </label>
        <label>
          Run B
          <select data-compare-run="b" aria-label="Compare run B" value={right} onChange={(event) => setRight(event.target.value)}>
            <option value="">Select a run</option>
            {options}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            const check = sameProjectRuns(projectId, runs, left, right);
            if (!check.ok) {
              setNote(check.error);
              return;
            }
            setNote('');
            void window.__CFD_HOST_SURFACES__
              ?.compareRuns(left, right)
              .then(() => viewer.render())
              .catch((error: unknown) => {
                setNote(error instanceof Error ? error.message : 'Compare failed');
              });
          }}
        >
          Compare
        </button>
        {note ? <p data-compare-note="1">{note}</p> : null}
      </section>
    </Hosted>
  );
}

export function SavedViews() {
  const viewer = useViewer();
  const projectId = useProjectStore((s) => s.projectId);
  const [views, setViews] = useState<Array<{ name: string; camera: NonNullable<ReturnType<typeof viewer.captureRelativeCamera>> }>>([]);
  if (!projectId) return null;
  return (
    <Hosted>
      <section data-saved-views="1">
        <h3>Saved views</h3>
        <button
          type="button"
          onClick={() => {
            const bounds = window.__CFD_MESH_VIEW__?.bounds;
            const camera = viewer.captureRelativeCamera(bounds || null);
            if (!camera) return;
            setViews((current) => [...current, { name: `View ${current.length + 1}`, camera }]);
          }}
        >
          Save view
        </button>
        <ul>
          {views.map((view) => (
            <li key={view.name}>
              <button
                type="button"
                onClick={() => {
                  const bounds = window.__CFD_MESH_VIEW__?.bounds;
                  if (viewer.applyRelativeCamera(view.camera, bounds || null)) viewer.render();
                }}
              >
                {view.name}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </Hosted>
  );
}

export function InspectPoint() {
  const viewer = useViewer();
  const projectId = useProjectStore((s) => s.projectId);
  const [x, setX] = useState('0');
  const [y, setY] = useState('0');
  const [z, setZ] = useState('0');
  if (!projectId) return null;
  return (
    <Hosted>
      <section data-inspect-point="1">
        <h3>Inspect point</h3>
        <input aria-label="Inspect X" value={x} onChange={(event) => setX(event.target.value)} />
        <input aria-label="Inspect Y" value={y} onChange={(event) => setY(event.target.value)} />
        <input aria-label="Inspect Z" value={z} onChange={(event) => setZ(event.target.value)} />
        <button
          type="button"
          onClick={() => {
            viewer.setLayerVisible('inspect_marker', true);
            void window.__CFD_HOST_SURFACES__?.inspect([Number(x), Number(y), Number(z)]);
            viewer.render();
          }}
        >
          Inspect
        </button>
      </section>
    </Hosted>
  );
}
