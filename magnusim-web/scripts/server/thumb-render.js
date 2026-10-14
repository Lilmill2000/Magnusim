// @ts-check
/**
 * What every thumbnail render (render_geometry_thumb.py: a Home card's picture, a linked
 * geometry's follow-up) shares: how long it may run, and the test stand-ins that make it
 * fail or hang.
 *
 * On a machine with no display and no EGL (GitHub's Linux runner) VTK finds no OpenGL
 * window and the renderer crashes (exit 139) within about three seconds. A render that
 * hangs (a driver that never answers) is stopped at the timeout, so it never keeps its
 * caller waiting.
 */
import { envGet } from '../env-compat.js';

/** A render's limit: MAGNUSIM_THUMB_TIMEOUT_MS, else 60 s. */
export function thumbRenderTimeoutMs() {
  const n = Number(envGet('THUMB_TIMEOUT_MS'));
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/**
 * MAGNUSIM_TEST_THUMB_FAIL (tests only): the Python a render runs instead of the renderer.
 * `1` (or `fail`): it ends at once with the renderer's crash code, as with no OpenGL.
 * `hang`: it never ends, until the render's timeout stops it.
 * Otherwise null: the real renderer.
 * @returns {string[] | null}
 */
export function thumbTestStandIn() {
  const mode = String(envGet('TEST_THUMB_FAIL') || '').trim().toLowerCase();
  if (mode === '1' || mode === 'fail') {
    return ['-c', "import sys; sys.stderr.write('thumbnail render failed (MAGNUSIM_TEST_THUMB_FAIL)\\n'); sys.exit(139)"];
  }
  if (mode === 'hang') return ['-c', 'import time; time.sleep(86400)'];
  return null;
}
