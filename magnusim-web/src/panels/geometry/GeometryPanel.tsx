import { useEffect, useState } from 'react';
import { apiGet } from '../../api/client';
import type { IslandProps } from '../../islands';
import { useProjectStore } from '../../store/project';
import { lostDisplay } from '../../workbench/faceNames';
import { deleteGeometry, forgetLostFaces, geometryStateNow, subscribeGeometryState, type GeometryState } from '../legacyBridge';
import { PanelChrome } from '../PanelChrome';

/** GET /api/geometry/lost-faces: a linked geometry's source, last update and lost entries (API 1.5). */
export interface GeometryLink {
  linked: boolean;
  rev?: number;
  name?: string;
  unlinked?: boolean;
  source?: { plugin?: string; study_id?: string; study_title?: string } | null;
  last_update?: { rev?: number; from_rev?: number; change?: string; lost?: number; returned?: number } | null;
  entries: Array<{ studyTitle: string; item: string; field: string; old: string; name?: string | null; label?: string | null; reason: string }>;
}

/** "Rev 3 (from rev 2): 1 face lost, 1 came back." */
export function lastUpdateLine(u: GeometryLink['last_update']): string {
  if (!u || !u.rev) return '';
  const parts: string[] = [];
  if (u.lost) parts.push(`${u.lost} face${u.lost === 1 ? '' : 's'} lost`);
  if (u.returned) parts.push(`${u.returned} came back`);
  return `Rev ${u.rev}${u.from_rev ? ` (from rev ${u.from_rev})` : ''}${parts.length ? `: ${parts.join(', ')}.` : '.'}`;
}

function useGeometryLink(geometryId: string | undefined): [GeometryLink | null, () => void] {
  const projectId = useProjectStore((st) => st.projectId);
  const [link, setLink] = useState<GeometryLink | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!projectId || !geometryId) {
      setLink(null);
      return undefined;
    }
    let dead = false;
    void apiGet<GeometryLink>('/api/geometry/lost-faces', { project_id: projectId, geometry_id: geometryId })
      .then((j) => {
        if (!dead) setLink(j && j.linked ? j : null);
      })
      .catch(() => {
        if (!dead) setLink(null);
      });
    return () => {
      dead = true;
    };
  }, [projectId, geometryId, tick]);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener('cfd:lost-faces', again);
    window.addEventListener('cfd:tree-sync', again);
    return () => {
      window.removeEventListener('cfd:lost-faces', again);
      window.removeEventListener('cfd:tree-sync', again);
    };
  }, []);
  return [link, () => setTick((n) => n + 1)];
}

/** A linked geometry's rows: where it comes from, its last update, and its lost faces with Forget all. */
function LinkRows({ link, geometryId, onError }: { link: GeometryLink; geometryId: string; onError: (e: unknown) => void }) {
  const last = lastUpdateLine(link.last_update);
  return (
    <>
      {link.source && !link.unlinked ? (
        <div className="sim-def-row">
          <span className="sim-def-k">Source</span>
          <span className="sim-def-v" data-geometry-source="1">
            from {link.source.study_title || 'its study'}
          </span>
        </div>
      ) : null}
      {last ? (
        <div className="sim-def-row">
          <span className="sim-def-k">Last update</span>
          <span className="sim-def-v" data-geometry-last-update="1">
            {last}
          </span>
        </div>
      ) : null}
      {link.entries.length ? (
        <div className="mat-assign-block" data-geometry-lost="1">
          <div className="mat-assign-head">
            <span className="mat-k">Lost faces ({link.entries.length})</span>
            <button
              type="button"
              className="mat-clear-link"
              onClick={() => void forgetLostFaces({ geometry_id: geometryId }).catch(onError)}
            >
              Forget all
            </button>
          </div>
          <ul className="mat-assign-list" aria-label="Lost faces">
            {link.entries.map((e, i) => (
              <li key={`${e.studyTitle}|${e.item}|${e.field}|${e.old}|${i}`} className="bc-assign-item" data-lost-face={e.old}>
                <span className="bc-assign-pick">
                  {e.studyTitle} {'\u203a'} {e.item}: {lostDisplay(e)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mat-assign-hint">Each one stays listed on its record and comes back if its face does.</div>
        </div>
      ) : null}
    </>
  );
}

function useGeometryState(): GeometryState | null {
  const [state, setState] = useState<GeometryState | null>(() => geometryStateNow());
  useEffect(() => subscribeGeometryState(setState), []);
  return state;
}

/** Geometry panel: the V0.1.0 rows (Name, Representation, Volume) and Delete. The runtime owns the data. */
export function GeometryPanel(_props: IslandProps) {
  const state = useGeometryState();
  const [error, setError] = useState('');
  const [link] = useGeometryLink(state?.has_geometry ? state.id : undefined);

  if (!state?.has_geometry) {
    return (
      <PanelChrome title="Geometry">
        <p className="mat-assign-hint">Add geometry (STEP, IGES, BREP, STL, OBJ or PLY) to start the setup.</p>
      </PanelChrome>
    );
  }

  return (
    <PanelChrome
      title={state.title || 'Geometry'}
      onDelete={
        state.can_delete
          ? () => {
              setError('');
              deleteGeometry().catch((e) => setError(e instanceof Error ? e.message : String(e)));
            }
          : undefined
      }
    >
      <div className="sim-def-row">
        <span className="sim-def-k">Name</span>
        <span className="sim-def-v" data-geometry-name="1">
          {state.name}
        </span>
      </div>
      <div className="sim-def-row">
        <span className="sim-def-k">Representation</span>
        <span className="sim-def-v" data-geometry-repr="1">
          {state.representation}
        </span>
      </div>
      <div className="sim-def-row">
        <span className="sim-def-k">Volume</span>
        <span className="sim-def-v" data-geometry-volume="1">
          {state.volume}
        </span>
      </div>
      {link && state.id ? <LinkRows link={link} geometryId={state.id} onError={(e) => setError(e instanceof Error ? e.message : String(e))} /> : null}
      <div className="sim-def-note">Click a body in the tree to highlight it in the viewport.</div>
      {error ? (
        <p className="mat-assign-hint" data-run-reason="1" role="alert">
          {error}
        </p>
      ) : null}
    </PanelChrome>
  );
}
