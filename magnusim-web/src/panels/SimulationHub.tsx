import { useEffect, useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { acceptsW17Analysis, analysisLabel } from '../api/w17';
import { apiGet, apiPost } from '../api/client';
import type { RegistryRow } from '../api/registry.gen';
import { SchemaForm } from '../forms/SchemaForm';
import { useProjectStore } from '../store/project';
import type { IslandProps } from '../islands';
import { PanelChrome } from './PanelChrome';

export function SimulationHub(_props: IslandProps) {
  const registry = useProjectStore((s) => s.registry);
  const rows = ((registry?.analysis || []) as RegistryRow[]).filter((r) =>
    acceptsW17Analysis(r.key),
  );

  async function create(key: string) {
    const projectId = useProjectStore.getState().projectId;
    await apiPost('/api/simulation', {
      project_id: projectId,
      analysis_type: key,
      analysis: 'Incompressible',
    });
    if (projectId) await useProjectStore.getState().refreshHydrate(projectId);
  }

  return (
    <PanelChrome title="Simulation">
      <p className="mat-assign-hint">Incompressible studies in this slice.</p>
      <ul className="ml-list">
        {rows.map((row) => (
          <li key={row.key}>
            <button type="button" className="ml-type" onClick={() => void create(row.key)}>
              <span className="ml-type-name">{analysisLabel(row)}</span>
            </button>
          </li>
        ))}
      </ul>
    </PanelChrome>
  );
}

export function SimulationDefaults(_props: IslandProps) {
  const registry = useProjectStore((s) => s.registry);
  const row = ((registry?.analysis || []) as RegistryRow[]).find((r) =>
    acceptsW17Analysis(r.key),
  );
  const schema = (row?.schema || row?.settings_schema) as RJSFSchema | undefined;
  const [data, setData] = useState<Record<string, unknown>>({});

  useEffect(() => {
    void apiGet('/api/simulation')
      .then((j) => {
        const sim = (j as { simulation?: Record<string, unknown> }).simulation;
        if (sim) setData(sim);
      })
      .catch(() => {});
  }, []);

  if (!schema) {
    return (
      <PanelChrome title="Incompressible">
        <p className="mat-assign-hint">Defaults load from the analysis registry.</p>
      </PanelChrome>
    );
  }

  return (
    <SchemaForm
      schema={schema}
      formData={data}
      onCommit={(values) => {
        setData(values);
        void apiPost('/api/simulation', values);
      }}
    />
  );
}
