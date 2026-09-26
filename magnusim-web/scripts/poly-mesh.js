import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const POLYMESH_FILES = ['points', 'faces', 'owner', 'neighbour', 'boundary'];

function nonEmpty(path) {
  for (const p of [path, path + '.gz']) {
    try {
      if (existsSync(p) && statSync(p).size > 0) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Every file OpenFOAM needs to read the mesh is there and not empty. A generate
 * killed during copy-back (server closed, restart) can leave points/faces/owner
 * without neighbour/boundary; that is not a usable mesh.
 */
export function polyMeshComplete(polyDir) {
  if (!polyDir) return false;
  return POLYMESH_FILES.every((name) => nonEmpty(join(polyDir, name)));
}
