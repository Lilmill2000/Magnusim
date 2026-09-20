import { useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { apiPost } from '../api/client';
import type { RegistryRow } from '../api/registry.gen';
import { SchemaForm } from '../forms/SchemaForm';
import { useProjectStore } from '../store/project';
import type { IslandProps } from '../islands';
import { PanelChrome } from './PanelChrome';

export function MaterialsHub(_props: IslandProps) {
  return (
    <PanelChrome title="Materials">
      <p className="mat-assign-hint">Assign a material to each body.</p>
    </PanelChrome>
  );
}

export function MaterialPicker(_props: IslandProps) {
  const rows = (useProjectStore((s) => s.registry?.material) || []) as RegistryRow[];
  return (
    <PanelChrome title="Materials">
      <ul className="ml-list">
        {rows.map((row) => (
          <li key={row.key}>{row.label || row.key}</li>
        ))}
      </ul>
    </PanelChrome>
  );
}

export function MaterialEditor(_props: IslandProps) {
  const rows = (useProjectStore.getState().registry?.material || []) as RegistryRow[];
  const schema = (rows[0]?.schema || rows[0]?.settings_schema) as RJSFSchema | undefined;
  const [data, setData] = useState<Record<string, unknown>>({});
  if (!schema) {
    return (
      <PanelChrome title="Air">
        <p className="mat-assign-hint">Air is the built-in incompressible fluid.</p>
      </PanelChrome>
    );
  }
  return (
    <SchemaForm
      schema={schema}
      formData={data}
      onCommit={(values) => {
        setData(values);
        void apiPost('/api/materials', { project_id: useProjectStore.getState().projectId, ...values });
      }}
    />
  );
}
