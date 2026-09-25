import { useJobsStore } from '../store/jobs';
import type { IslandProps } from '../islands';
import { PanelChrome } from './PanelChrome';

export { RunControl } from './run/RunControl';

export function RunResults(_props: IslandProps) {
  return (
    <PanelChrome title="Results">
      <p className="mat-assign-hint">Open a finished or live run from the tree.</p>
    </PanelChrome>
  );
}

export function RunGraphs(_props: IslandProps) {
  const residuals = useJobsStore((s) => Object.values(s.jobs).at(-1)?.residual);
  return (
    <PanelChrome title="Graphs">
      <p className="mat-assign-hint">Residuals and monitor series from the run.</p>
      {residuals != null ? <pre className="mat-assign-hint">{JSON.stringify(residuals)}</pre> : null}
    </PanelChrome>
  );
}

export function RunMedia(_props: IslandProps) {
  return (
    <PanelChrome title="Saved captures">
      <p className="mat-assign-hint">Screenshots and recordings for this run.</p>
    </PanelChrome>
  );
}

export function RunMesh(_props: IslandProps) {
  return (
    <PanelChrome title="Run mesh">
      <p className="mat-assign-hint">Mesh used by the selected run.</p>
    </PanelChrome>
  );
}

export { GeometryPanel } from './geometry/GeometryPanel';

export function JobDrawer(_props: IslandProps) {
  const jobs = useJobsStore((s) => s.jobs);
  return (
    <PanelChrome title="Jobs">
      <ul>
        {Object.values(jobs).map((j) => (
          <li key={j.id}>
            {j.kind || 'job'} {j.status}
          </li>
        ))}
      </ul>
    </PanelChrome>
  );
}
