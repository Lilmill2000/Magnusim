import { useEffect, useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { apiGet } from '../api/client';
import type { RegistryRow } from '../api/registry.gen';
import { useProjectStore } from '../store/project';
import { useUiStore } from '../store/ui';

/** Loads filter schemas for the existing FILTERS panel; does not replace vtk controls. */
export function FiltersPanel() {
  const filtersMode = useUiStore((s) => s.filtersMode);
  const filters = (useProjectStore((s) => s.registry?.filter) || []) as RegistryRow[];
  const [, setSchema] = useState<RJSFSchema | null>(null);

  useEffect(() => {
    const key = filtersMode === 'mesh' ? 'mesh_surface' : 'cut_plane';
    const cut = filters.find((f) => f.key === key);
    const s = (cut?.schema || cut?.params_schema) as RJSFSchema | undefined;
    if (s) {
      setSchema(s);
      return;
    }
    void apiGet(`/api/registry/filter/${key}`)
      .then((j) => {
        const row = j as { schema?: RJSFSchema; params_schema?: RJSFSchema };
        setSchema(row.schema || row.params_schema || null);
      })
      .catch(() => {});
  }, [filters, filtersMode]);

  return null;
}

export function Legend() {
  return null;
}

export function Timeline() {
  return null;
}

export function CompareLayout() {
  return null;
}

export function SavedViews() {
  return null;
}

export function InspectPoint() {
  return null;
}
