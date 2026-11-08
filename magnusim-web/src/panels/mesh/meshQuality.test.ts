import { describe, expect, it } from 'vitest';
import { failedCheckWords, failedChecksLine, meshQualityLines, meshQualityOf, worstCellsLine } from './meshQuality';

// The quality magnusim_sdk.mesh_facts.record_quality writes for OpenFOAM v2606's checkMesh
// report on a sheared, graded slab (python/tests/fixtures/mesh-facts/checkmesh/skewed.log).
const SKEWED = {
  known: true,
  ok: false,
  n_failed: 1,
  max_non_orthogonality: 72.64597596,
  avg_non_orthogonality: 72.64597536,
  severe_non_orthogonal_faces: 750,
  max_skewness: 8.000000342,
  skewed_faces: 22,
  max_aspect_ratio: 38.02406827,
  min_volume_m3: 1.435788593e-7,
  failed: [{ check: 'skewness', count: 22, unit: 'faces', accepted: true }],
};

describe('mesh quality (RH2)', () => {
  it('reads the record quality the generator wrote', () => {
    const q = meshQualityOf({ status: 'done', quality: SKEWED });
    expect(q).toEqual({
      ok: false,
      n_failed: 1,
      failed: [{ check: 'skewness', count: 22, unit: 'faces', accepted: true }],
      max_non_orthogonality: 72.64597596,
      max_skewness: 8.000000342,
      max_aspect_ratio: 38.02406827,
    });
    expect(meshQualityLines(q)).toEqual(['Worst cells: 73° non-orthogonal, skewness 8.0, aspect ratio 38', 'checkMesh failed 1 check: 22 highly skewed faces.']);
  });

  it('is not known without a report: no line', () => {
    expect(meshQualityOf({ status: 'done', quality: { known: false } })).toBeNull();
    expect(meshQualityOf({ status: 'done', quality: null })).toBeNull();
    expect(meshQualityOf({ status: 'done', n_cells: 5 })).toBeNull();
    expect(meshQualityOf(null)).toBeNull();
    expect(meshQualityLines(null)).toEqual([]);
  });

  it('still reads an older record with the worst cells as top-level keys', () => {
    const q = meshQualityOf({ max_non_ortho: 78.2, max_skewness: 3.84 });
    expect(q).toEqual({ ok: null, n_failed: 0, failed: [], max_non_orthogonality: 78.2, max_skewness: 3.84, max_aspect_ratio: null });
    expect(meshQualityLines(q)).toEqual(['Worst cells: 78° non-orthogonal, skewness 3.8']);
    // The record's own quality wins over the older keys.
    expect(meshQualityOf({ max_skewness: 9, quality: SKEWED })?.max_skewness).toBe(8.000000342);
  });

  it('writes numbers plainly: one decimal below 10, whole and grouped above', () => {
    const q = { ok: true, n_failed: 0, failed: [], max_non_orthogonality: 0.4, max_skewness: 12.6, max_aspect_ratio: 8333.33 };
    expect(worstCellsLine(q)).toBe('Worst cells: 0° non-orthogonal, skewness 13, aspect ratio 8,333');
    expect(failedChecksLine(q)).toBeNull();
    expect(worstCellsLine({ ...q, max_non_orthogonality: null, max_skewness: null, max_aspect_ratio: null })).toBeNull();
    // Cells turned inside out (the 55 D pipe on Hex-dominant): not 94 digits.
    expect(worstCellsLine({ ...q, max_non_orthogonality: 179.825, max_skewness: 29.2463, max_aspect_ratio: 4.45313e93 })).toBe(
      'Worst cells: 180° non-orthogonal, skewness 29, aspect ratio over 1,000,000',
    );
  });

  it('names every failed check checkMesh reports, with its count', () => {
    const f = (check: string, count: number | null, text?: string) => failedCheckWords({ check, count, unit: null, accepted: false, ...(text ? { text } : {}) });
    expect(f('negative_volume', 1)).toBe('1 cell with a negative volume');
    expect(f('aspect_ratio', 36)).toBe('36 cells with a high aspect ratio');
    expect(f('non_orthogonality', 3)).toBe('3 faces over 90° non-orthogonal');
    expect(f('face_pyramids', 4)).toBe('4 wrongly oriented faces');
    expect(f('non_aligned_edges', 1)).toBe('1 edge out of line with the 2D directions');
    expect(f('skewness', null)).toBe('highly skewed faces');
    expect(f('boundary_openness', null)).toBe('the boundary is not closed');
    expect(f('other', null, 'Some   new check failed')).toBe('Some new check failed');
    expect(f('other', null)).toBe('another check');
    const q = meshQualityOf({
      quality: {
        known: true,
        ok: false,
        n_failed: 2,
        failed: [
          { check: 'negative_volume', count: 1, unit: 'cells' },
          { check: 'face_pyramids', count: 4, unit: 'faces' },
        ],
      },
    });
    expect(failedChecksLine(q!)).toBe('checkMesh failed 2 checks: 1 cell with a negative volume, 4 wrongly oriented faces.');
  });
});
