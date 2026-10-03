import { useEffect, useState } from 'react';
import { apiGet } from '../../api/client';
import type { MonitorQuantity, RunMonitor } from '../../api/registry.gen';
import { formatSampleValue, lastSample, monitorName, monitorQuantities, type MonitorAnswer } from '../../monitors';

/**
 * Each monitor's latest headline values (the analysis's monitor quantities) for
 * a run that has written results: boundary monitors, then custom monitors.
 */
export function RunMonitors({
  projectId,
  simulationId,
  runId,
  live,
  quantities,
}: {
  projectId: string;
  simulationId: string;
  runId: string;
  /** Poll while the solve runs; load once otherwise. */
  live: boolean;
  /** The run analysis's monitor quantities (its registry row), when the answer names none. */
  quantities?: readonly MonitorQuantity[] | null;
}) {
  const [answer, setAnswer] = useState<MonitorAnswer | null>(null);
  useEffect(() => {
    if (!projectId || !runId) return;
    let dead = false;
    const load = () =>
      void apiGet<MonitorAnswer>('/api/run/monitors', {
        project_id: projectId,
        simulation_id: simulationId || undefined,
        run_id: runId,
      })
        .then((body) => {
          if (!dead) setAnswer(body || null);
        })
        .catch(() => {});
    load();
    const timer = live ? window.setInterval(load, 3000) : null;
    return () => {
      dead = true;
      if (timer) window.clearInterval(timer);
    };
  }, [projectId, simulationId, runId, live]);
  const headline = monitorQuantities(answer, quantities).filter((q) => q.headline);
  const rows: RunMonitor[] = [...(answer?.monitors || []), ...(answer?.custom || [])];
  const shown = rows
    .map((row) => {
      const last = lastSample(row);
      return { row, values: headline.map((q) => formatSampleValue(q, last)).filter(Boolean) };
    })
    .filter((entry) => entry.values.length);
  if (!shown.length) return null;
  return (
    <ul className="run-monitors" data-run-monitors="1">
      {shown.map(({ row, values }) => (
        <li key={String(row.key || row.patch || row.name)} className="mat-assign-hint">
          {[monitorName(row), ...values].join(' · ')}
        </li>
      ))}
    </ul>
  );
}
