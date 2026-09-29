import type { RequiredPluginMissing } from '../api/registry.gen';
import { useProjectStore } from '../store/project';

/** "Incompressible Flow failed to load: <why>. Magnusim can't create or run simulations." */
export function requiredPluginMessage(row: RequiredPluginMissing): string {
  return `${row.name || row.key} failed to load: ${row.error || 'unknown error'}. Magnusim can't create or run simulations.`;
}

/** The required bundled plugins that did not load (registry.describe required_missing). */
export function useRequiredPluginsMissing(): RequiredPluginMissing[] {
  return useProjectStore((state) => state.registry?.required_missing || EMPTY);
}

const EMPTY: RequiredPluginMissing[] = [];

/**
 * App-wide notice while a required plugin is missing. Creating and running
 * simulations are refused (server side too); this says why and where the log is.
 */
export function RequiredPluginError() {
  const missing = useRequiredPluginsMissing();
  if (!missing.length) return null;
  return (
    <div className="required-plugin-error" role="alert" data-required-plugin-error="app">
      {missing.map((row) => (
        <p key={row.key}>
          <strong>{requiredPluginMessage(row)}</strong>
          {row.log ? <span> Details are in {row.log}.</span> : null}
        </p>
      ))}
    </div>
  );
}
