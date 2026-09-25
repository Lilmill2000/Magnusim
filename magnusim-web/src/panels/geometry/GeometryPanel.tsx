import { useEffect, useState } from 'react';
import type { IslandProps } from '../../islands';
import { deleteGeometry, geometryStateNow, subscribeGeometryState, type GeometryState } from '../legacyBridge';
import { PanelChrome } from '../PanelChrome';

function useGeometryState(): GeometryState | null {
  const [state, setState] = useState<GeometryState | null>(() => geometryStateNow());
  useEffect(() => subscribeGeometryState(setState), []);
  return state;
}

/** Geometry panel: the V0.1.0 rows (Name, Representation, Volume) and Delete. The runtime owns the data. */
export function GeometryPanel(_props: IslandProps) {
  const state = useGeometryState();
  const [error, setError] = useState('');

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
      <div className="sim-def-note">Click a body in the tree to highlight it in the viewport.</div>
      {error ? (
        <p className="mat-assign-hint" data-run-reason="1" role="alert">
          {error}
        </p>
      ) : null}
    </PanelChrome>
  );
}
