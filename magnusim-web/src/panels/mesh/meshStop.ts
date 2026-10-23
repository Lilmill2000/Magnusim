/**
 * The mesh's Stop (Assistant phase 5 spec 8.4), from the Mesh panel and the tree's mesh
 * row while it generates. It asks first, in the app's own dialog, then POSTs
 * /api/mesh/stop: the generate ends and nothing is deleted (the mesh, its settings and
 * refinements stay). The panel and the tree then say Stopped, from the job's end as the
 * runtime follows it (and the mesh record's live status after a reload).
 */
import { ApiError, apiPost } from '../../api/client';
import { confirmAction } from '../../workbench/dialogs';
import { refreshTree } from '../legacyBridge';

export function stopMeshTitle(name: string): string {
  return `Stop meshing "${name || 'Mesh'}"?`;
}
export const STOP_MESH_COPY = 'What it made so far is discarded.';
export const STOP_MESH_YES = 'Stop';
export const STOP_MESH_NO = 'Keep meshing';

export interface StopMeshTarget {
  projectId: string;
  simulationId: string;
  meshId: string;
  name: string;
}

/**
 * Asks, then stops the mesh: 'stopped'; 'kept' when the person chose Keep meshing;
 * 'not_running' when it had ended meanwhile. Any other refusal throws its text.
 */
export async function stopMesh(t: StopMeshTarget): Promise<'stopped' | 'kept' | 'not_running'> {
  const yes = await confirmAction({ title: stopMeshTitle(t.name), copy: STOP_MESH_COPY, yes: STOP_MESH_YES, no: STOP_MESH_NO, safe: true });
  if (!yes) return 'kept';
  try {
    await apiPost('/api/mesh/stop', { project_id: t.projectId, simulation_id: t.simulationId || undefined, mesh_id: t.meshId });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && (e.body as { code?: string } | null)?.code === 'not_running') return 'not_running';
    throw e;
  }
  refreshTree();
  return 'stopped';
}
