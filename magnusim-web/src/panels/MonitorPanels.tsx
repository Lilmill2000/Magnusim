import { useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { apiPost } from '../api/client';
import type { RegistryRow } from '../api/registry.gen';
import { SchemaForm } from '../forms/SchemaForm';
import { useProjectStore } from '../store/project';
import type { IslandProps } from '../islands';
import { PanelChrome } from './PanelChrome';

export function MonitorsHub(_props: IslandProps) {
  return (
    <PanelChrome title="Monitors">
      <p className="mat-assign-hint">Surface and point monitors for the run.</p>
    </PanelChrome>
  );
}

export function AreaAverageEditor(_props: IslandProps) {
  const rows = (useProjectStore.getState().registry?.monitor || []) as RegistryRow[];
  const row = rows.find((r) => r.key === 'area_average') || rows[0];
  const schema = (row?.schema || row?.params_schema) as RJSFSchema | undefined;
  const [data, setData] = useState<Record<string, unknown>>({});
  if (!schema) {
    return (
      <PanelChrome title="Area average">
        <p className="mat-assign-hint">Average of a field on the faces you assign.</p>
      </PanelChrome>
    );
  }
  return (
    <SchemaForm
      schema={schema}
      formData={data}
      onCommit={(values) => {
        setData(values);
        void apiPost('/api/result-controls', {
          project_id: useProjectStore.getState().projectId,
          ...values,
        });
      }}
    />
  );
}
