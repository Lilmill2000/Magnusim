import { useEffect } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import type { IslandProps } from '../islands';
import { useProjectStore } from '../store/project';

export function useRegistryReady() {
  const registry = useProjectStore((s) => s.registry);
  useEffect(() => {
    if (!registry) {
      void useProjectStore.getState().loadRegistry().catch(() => {});
    }
  }, [registry]);
  return registry;
}

export interface ScopeIds {
  project_id: string;
  geometry_id: string;
  simulation_id: string;
  mesh_id: string;
  item_id: string;
  scope: string;
}

/** Ids carried on the open panel. A study island never reads another study's catalog. */
export function scopeIds(props: IslandProps): ScopeIds {
  const parts: Record<string, string> = {};
  for (const piece of String(props.scope || '').split('/')) {
    const i = piece.indexOf(':');
    if (i <= 0) continue;
    parts[piece.slice(0, i)] = piece.slice(i + 1);
  }
  return {
    project_id: props.projectId || parts.p || '',
    geometry_id: parts.g || '',
    simulation_id: props.simId || parts.s || '',
    mesh_id: parts.mesh || '',
    item_id: props.itemId || parts.item || parts.mesh || parts.run || '',
    scope: props.scope || '',
  };
}

export function mergeObjectSchemas(parts: Array<RJSFSchema | null | undefined>): RJSFSchema {
  const properties: RJSFSchema['properties'] = {};
  for (const part of parts) {
    const props = part && part.properties;
    if (props && typeof props === 'object') Object.assign(properties, props);
  }
  return { type: 'object', properties, additionalProperties: false };
}

export function pickSchemaValues(
  data: Record<string, unknown>,
  schema: RJSFSchema,
): Record<string, unknown> {
  const props = (schema && schema.properties) || {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

export const facesField = {
  type: 'array',
  title: 'Faces',
  items: { type: 'string' },
  'x-cfddesk': { widget: 'faces' },
} as RJSFSchema;
