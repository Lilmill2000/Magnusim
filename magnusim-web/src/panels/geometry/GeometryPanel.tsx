import { useEffect, useState } from 'react';
import { apiGet } from '../../api/client';
import type { IslandProps } from '../../islands';
import { useProjectStore } from '../../store/project';
import { lostDisplay } from '../../workbench/faceNames';
import { deleteGeometry, forgetLostFaces, geometryStateNow, subscribeGeometryState, type GeometryState } from '../legacyBridge';
import { PanelChrome } from '../PanelChrome';
import {
  geometryActionNotice,
  geometryActionsNow,
  geometryOriginalNow,
  importOriginal,
  openGeometryAction,
  subscribeGeometryActions,
  type GeometryActionEntry,
} from '../../workspace/geometryActions';

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

/** The tree's last read of a geometry's actions and original (API 1.7), kept current. */
function useGeometryActions(geometryId: string | undefined): { entries: GeometryActionEntry[]; original: { fileName: string | null; present: boolean } | null } {
  const projectId = useProjectStore((st) => st.projectId) || '';
  const read = () => ({
    entries: geometryId ? geometryActionsNow(projectId, geometryId, 'panel') : [],
    original: geometryId ? geometryOriginalNow(projectId, geometryId) : null,
  });
  const [now, setNow] = useState(read);
  useEffect(() => {
    setNow(read());
    return subscribeGeometryActions(() => setNow(read()));
  }, [projectId, geometryId]);
  return now;
}

/**
 * The Geometry panel's actions (API 1.7): "Edit in CAD" and its line, disabled with the
 * reason when the geometry cannot be edited now. Disabled while it opens.
 */
function ActionRows({ entries, geometryId, geometryName }: { entries: GeometryActionEntry[]; geometryId: string; geometryName: string }) {
  const projectId = useProjectStore((st) => st.projectId) || '';
  const [busy, setBusy] = useState('');
  return (
    <>
      {entries.map((entry) => {
        const key = `${entry.plugin}|${entry.studyKind}`;
        return (
          <div key={key} className="geom-panel-action" data-geometry-action={entry.studyKind}>
            <button
              type="button"
              className="fp-btn fp-btn-primary"
              data-geometry-action-button={entry.studyKind}
              disabled={!entry.enabled || !!busy}
              onClick={async () => {
                setBusy(key);
                const answer = await openGeometryAction(projectId, geometryId, entry);
                setBusy('');
                if (!answer.ok) await geometryActionNotice(answer.title || `Couldn't open ${geometryName}`, answer.message || '');
              }}
            >
              {busy === key ? 'Opening…' : entry.label}
            </button>
            {entry.enabled ? (
              entry.hint ? <div className="sim-def-note">{entry.hint}</div> : null
            ) : (
              <div className="sim-def-note" data-geometry-action-reason="1">
                {entry.reason}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** An adopted geometry's original (API 1.7): its file, and importing it again as a new geometry. */
function OriginalRow({ original, geometryId }: { original: { fileName: string | null; present: boolean }; geometryId: string }) {
  const projectId = useProjectStore((st) => st.projectId) || '';
  const [busy, setBusy] = useState(false);
  return (
    <div className="sim-def-row" data-geometry-original="1">
      <span className="sim-def-k">Original</span>
      <span className="sim-def-v">
        {original.fileName || 'the imported file'}
        {original.present ? (
          <>
            {' · '}
            <button
              type="button"
              className="mat-clear-link"
              data-geometry-original-import="1"
              disabled={busy}
              title="Import the file this geometry was made from again, as a new geometry beside it"
              onClick={async () => {
                setBusy(true);
                const r = await importOriginal(projectId, geometryId);
                setBusy(false);
                if (!r.ok) await geometryActionNotice("Couldn't add the original", r.message || '');
                else window.dispatchEvent(new CustomEvent('cfd:tree-sync'));
              }}
            >
              {busy ? 'Adding…' : 'Add the original as a new geometry'}
            </button>
          </>
        ) : null}
      </span>
    </div>
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
  const actions = useGeometryActions(state?.has_geometry ? state.id : undefined);

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
      {actions.entries.length && state.id ? <ActionRows entries={actions.entries} geometryId={state.id} geometryName={state.name || 'the geometry'} /> : null}
      {link && state.id ? <LinkRows link={link} geometryId={state.id} onError={(e) => setError(e instanceof Error ? e.message : String(e))} /> : null}
      {actions.original && state.id ? <OriginalRow original={actions.original} geometryId={state.id} /> : null}
      <div className="sim-def-note">Click a body in the tree to highlight it in the viewport.</div>
      {error ? (
        <p className="mat-assign-hint" data-run-reason="1" role="alert">
          {error}
        </p>
      ) : null}
    </PanelChrome>
  );
}
