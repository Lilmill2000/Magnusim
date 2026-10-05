import { useEffect, useState } from 'react';
import { apiGet } from '../../api/client';
import type { MonitorQuantity, RunMonitor } from '../../api/registry.gen';
import { headlineText, monitorQuantities } from '../../monitors';

interface MonitorRow extends RunMonitor {
  final?: { pressure_Pa?: number; volumetric_flow_m3s?: number } | null;
}

/**
 * A row's line: a boundary or area-average monitor keeps its v0.2.0 form (its
 * final pressure and volume flow); a row that names its quantities (a Forces
 * monitor, a point probe) lists its headline quantities at its last point.
 */
export function runMonitorLine(row: MonitorRow, qs: readonly MonitorQuantity[]): string {
  const f = row.final;
  if (f && (f.pressure_Pa != null || f.volumetric_flow_m3s != null)) {
    return (
      String(row.name || row.patch) +
      (f.pressure_Pa != null ? ` · ${f.pressure_Pa.toFixed(1)} Pa` : '') +
      (f.volumetric_flow_m3s != null ? ` · ${f.volumetric_flow_m3s.toExponential(3)} m³/s` : '')
    );
  }
  return Array.isArray(row.quantities) ? headlineText(row, qs) : '';
}

/** Final monitor values for a run that has written results: BC patches, then custom monitors. */
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
  const [quantities, setQuantities] = useState<readonly MonitorQuantity[]>([]);
  useEffect(() => {
    if (!projectId || !runId) return;
    let dead = false;
    const load = () =>
      void apiGet<{ monitors?: MonitorRow[]; custom?: MonitorRow[]; quantities?: MonitorQuantity[] }>('/api/run/monitors', {
        project_id: projectId,
        simulation_id: simulationId || undefined,
        run_id: runId,
      })
        .then((body) => {
          if (dead) return;
          setRows([...(body.monitors || []), ...(body.custom || [])]);
          setQuantities(monitorQuantities(body));
        })
        .catch(() => {});
    load();
    const timer = live ? window.setInterval(load, 3000) : null;
    return () => {
      dead = true;
      if (timer) window.clearInterval(timer);
    };
  }, [projectId, simulationId, runId, live]);
  const shown = rows.map((row) => ({ row, line: runMonitorLine(row, quantities) })).filter((x) => x.line);
  if (!shown.length) return null;
  return (
    <ul className="run-monitors" data-run-monitors="1">
      {shown.map(({ row, line }) => (
        <li key={row.key || row.patch || row.name} className="mat-assign-hint">
          {line}
        </li>
      ))}
    </ul>
  );
}
