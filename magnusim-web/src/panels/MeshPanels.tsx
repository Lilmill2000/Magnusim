import { useEffect, useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { apiPost } from '../api/client';
import type { RegistryRow } from '../api/registry.gen';
import { useProjectStore } from '../store/project';
import { useJobsStore } from '../store/jobs';
import type { IslandProps } from '../islands';
import { PanelChrome } from './PanelChrome';

function mesherSchema(): RJSFSchema | undefined {
  const rows = (useProjectStore.getState().registry?.mesher || []) as RegistryRow[];
  const row = rows.find((r) => r.key === 'standard') || rows[0];
  return (row?.schema || row?.settings_schema) as RJSFSchema | undefined;
}

export function MeshHub(_props: IslandProps) {
  return (
    <PanelChrome title="Mesh">
      <p className="mat-assign-hint">Create or open a mesh from the tree. Generated meshes open inspect first.</p>
    </PanelChrome>
  );
}

export function MeshForm(_props: IslandProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const sync = () => {
      const fin = document.getElementById('mesh-fineness') as HTMLInputElement | null;
      const hex = document.getElementById('mesh-toggle-hex');
      const draft = {
        fineness: fin ? Number(fin.value) : 5,
        hex_element_core: hex ? hex.getAttribute('aria-pressed') !== 'false' : true,
        schema: mesherSchema() || null,
      };
      const mid =
        (window.__CFD_W20_STATE__ &&
          (window.__CFD_W20_STATE__.active_id ||
            (window.__CFD_W20_STATE__.mesh && window.__CFD_W20_STATE__.mesh.id))) ||
        null;
      if (mid) {
        window.__CFD_MESH_DRAFTS__ = window.__CFD_MESH_DRAFTS__ || {};
        window.__CFD_MESH_DRAFTS__[String(mid)] = {
          ...(window.__CFD_MESH_DRAFTS__[String(mid)] || {}),
          ...draft,
        };
      }
      setTick((n) => n + 1);
    };
    document.getElementById('mesh-form')?.addEventListener('change', sync);
    document.getElementById('mesh-fineness')?.addEventListener('input', sync);
    sync();
    return () => {
      document.getElementById('mesh-form')?.removeEventListener('change', sync);
      document.getElementById('mesh-fineness')?.removeEventListener('input', sync);
    };
  }, []);

  async function generate() {
    if (typeof window.__CFD_W21_GENERATE__ === 'function') {
      const result = (await window.__CFD_W21_GENERATE__()) as { job_id?: string } | undefined;
      if (result?.job_id) useJobsStore.getState().watch(result.job_id);
      return;
    }
    const projectId = useProjectStore.getState().projectId;
    const j = await apiPost('/api/mesh/generate', { project_id: projectId });
    const id = (j as { job_id?: string }).job_id;
    if (id) useJobsStore.getState().watch(id);
  }

  return (
    <div hidden>
      <button type="button" data-react-generate="1" onClick={() => void generate()}>
        Generate
      </button>
    </div>
  );
}

export function MeshInspect(_props: IslandProps) {
  return (
    <PanelChrome title="Mesh 1">
      <p className="mat-assign-hint">Click Mesh 1 in the sidebar to inspect a generated mesh.</p>
    </PanelChrome>
  );
}
