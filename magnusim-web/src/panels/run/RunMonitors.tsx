import { useEffect, useState } from 'react';
import { apiGet } from '../../api/client';

interface MonitorRow {
  name?: string;
  patch?: string;
  key?: string;
  final?: { pressure_Pa?: number; volumetric_flow_m3s?: number } | null;
}

/** Final monitor values (area averages) for a run that has written results: BC patches, then custom monitors. */
export function RunMonitors({
  projectId,
  simulationId,
  runId,
  live,
}: {
  projectId: string;
  simulationId: string;
  runId: string;
  /** Poll while the solve runs; load once otherwise. */
  live: boolean;
}) {
  const [rows, setRows] = useState<MonitorRow[]>([]);
  useEffect(() => {
    if (!projectId || !runId) return;
    let dead = false;
    const load = () =>
      void apiGet<{ monitors?: MonitorRow[]; custom?: MonitorRow[] }>('/api/run/monitors', {
        project_id: projectId,
        simulation_id: simulationId || undefined,
        run_id: runId,
      })
        .then((body) => {
          if (!dead) setRows([...(body.monitors || []), ...(body.custom || [])]);
        })
        .catch(() => {});
    load();
    const timer = live ? window.setInterval(load, 3000) : null;
    return () => {
      dead = true;
      if (timer) window.clearInterval(timer);
    };
  }, [projectId, simulationId, runId, live]);
  const shown = rows.filter((row) => row.final && (row.final.pressure_Pa != null || row.final.volumetric_flow_m3s != null));
  if (!shown.length) return null;
  return (
    <ul className="run-monitors" data-run-monitors="1">
      {shown.map((row) => (
        <li key={row.key || row.patch || row.name} className="mat-assign-hint">
          {row.name || row.patch}
          {row.final?.pressure_Pa != null ? ` · ${row.final.pressure_Pa.toFixed(1)} Pa` : ''}
          {row.final?.volumetric_flow_m3s != null ? ` · ${row.final.volumetric_flow_m3s.toExponential(3)} m³/s` : ''}
        </li>
      ))}
    </ul>
  );
}
