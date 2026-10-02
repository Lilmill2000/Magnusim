/**
 * Before preview version 8 the viewport numbered a face two solids share once, while the
 * face table and the mesher number it once per solid: every later viewport face id named
 * another face. Opening such a geometry must rebuild its preview; every other cached
 * preview (no shared face, same numbers either way) stays as it is.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'magnusim-face-ids-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
const { cadPreviewFaceIdsStale } = await import('../w16-project-geometry.js');

const OLD = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'e2e', 'fixtures', 'shared-face-preview-v7');

after(() => rmSync(root, { recursive: true, force: true }));

const face = (id, area, centroid) => ({ id, area, centroid, normal: [1, 0, 0], surface_type: 'Plane' });

describe('cadPreviewFaceIdsStale', () => {
  it('rebuilds the old preview of two boxes that share a face', () => {
    const meta = JSON.parse(readFileSync(join(OLD, 'cad_preview.json'), 'utf8'));
    assert.equal(meta.preview_version, 7);
    assert.equal(cadPreviewFaceIdsStale(meta), true);
  });

  it('keeps an old preview with no shared face', () => {
    const meta = {
      preview_version: 7,
      display: 'occt-prs3d',
      faces: [face(1, 100, [0, 5, 5]), face(2, 100, [10, 5, 5]), face(3, 200, [20, 0, 5])],
    };
    assert.equal(cadPreviewFaceIdsStale(meta), false);
  });

  it('keeps a version 8 preview, which numbers every visit already', () => {
    const meta = { preview_version: 8, display: 'occt-prs3d', faces: [face(2, 100, [10, 5, 5]), face(7, 100, [10, 5, 5])] };
    assert.equal(cadPreviewFaceIdsStale(meta), false);
  });

  it('keeps mesh imports and previews without a face table', () => {
    const twin = [face(1, 0.5, [0, 0, 0]), face(2, 0.5, [0, 0, 0])];
    assert.equal(cadPreviewFaceIdsStale({ preview_version: 7, display: 'mesh-triangles', faces: twin }), false);
    assert.equal(cadPreviewFaceIdsStale({ preview_version: 7, display: 'occt-prs3d' }), false);
    assert.equal(cadPreviewFaceIdsStale(null), false);
  });

  it('needs the area and the centroid to match exactly', () => {
    const meta = {
      preview_version: 7,
      display: 'occt-prs3d',
      faces: [face(1, 100, [10, 5, 5]), face(2, 100.0000001, [10, 5, 5]), face(3, 100, [10, 5, 5.0000001])],
    };
    assert.equal(cadPreviewFaceIdsStale(meta), false);
  });
});
