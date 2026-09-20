import { create } from 'zustand';
import { apiGet, apiPost } from '../api/client';
import type { RegistryDescribe, RegistryRow } from '../api/registry.gen';

export interface ProjectState {
  projectId: string | null;
  hydrate: Record<string, unknown> | null;
  registry: RegistryDescribe | null;
  activeSimId: string | null;
  activeGeometryId: string | null;
  setHydrate: (projectId: string, payload: Record<string, unknown>) => void;
  setActiveSim: (id: string | null) => void;
  setActiveGeometry: (id: string | null) => void;
  loadRegistry: () => Promise<RegistryDescribe>;
  refreshHydrate: (projectId: string) => Promise<Record<string, unknown>>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectId: null,
  hydrate: null,
  registry: null,
  activeSimId: null,
  activeGeometryId: null,
  setHydrate(projectId, payload) {
    const catalog = payload.simulation as { id?: string; active_id?: string; simulation?: {id?: string} } | undefined;
    const project = payload.project as {active_geometry_id?: string} | undefined;
    set({
      projectId,
      hydrate: payload,
      activeSimId: String(
        (payload.active_simulation_id as string) ||
          catalog?.simulation?.id || catalog?.active_id || catalog?.id ||
          '',
      ) || null,
      activeGeometryId: project?.active_geometry_id || null,
    });
    window.__cfdProject = { projectId, hydrate: payload };
  },
  setActiveSim(id) {
    set({ activeSimId: id });
  },
  setActiveGeometry(id) {
    set({ activeGeometryId: id });
  },
  async loadRegistry() {
    if (get().registry) return get().registry as RegistryDescribe;
    const data = await apiGet<RegistryDescribe>('/api/registry');
    set({ registry: data });
    const analyses = (data.analysis || []) as RegistryRow[];
    const inc = analyses.find((a) => a.key === 'incompressible_steady') || analyses[0];
    if (inc) {
      window.__CFD_W17_DEFAULTS__ = {
        analysis: String(inc.label || 'Incompressible'),
        analysis_type: String(inc.key || 'incompressible_steady'),
        turbulence_model: String(inc.default_turbulence || 'k-omega SST'),
        time_dependency: /transient/i.test(String(inc.time_dependency || ''))
          ? 'Transient'
          : 'Steady-state',
        algorithm: /pimple/i.test(String(inc.default_solver || '')) ? 'PIMPLE' : 'SIMPLE',
      };
    }
    return data;
  },
  async refreshHydrate(projectId) {
    const payload = await apiGet<Record<string, unknown>>('/api/project/hydrate', {
      project_id: projectId,
      simulation_id: get().projectId === projectId ? get().activeSimId || undefined : undefined,
    });
    get().setHydrate(projectId, payload);
    return payload;
  },
}));

export function useSimulation(): unknown {
  return useProjectStore((s) => s.hydrate && (s.hydrate as { simulation?: unknown }).simulation);
}

export function useMesh(): unknown {
  return useProjectStore((s) => s.hydrate && (s.hydrate as { mesh?: unknown }).mesh);
}

export function useBcs(): unknown {
  return useProjectStore((s) => s.hydrate && (s.hydrate as { bcs?: unknown }).bcs);
}

export async function persistJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  return apiPost(path, body);
}
