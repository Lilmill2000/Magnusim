import { describe, expect, it } from 'vitest';
import { splitStudiesOnRemove } from './geometryRemoveStudies';

describe('splitStudiesOnRemove', () => {
  const studies = [
    { id: 'sim-a', geometry_id: 'g-old' },
    { id: 'sim-b', geometry_id: 'g-other' },
    { id: 'sim-c', geometry_id: 'g-old' },
  ];

  it("takes the removed geometry's studies out and keeps the others in order", () => {
    expect(splitStudiesOnRemove(studies, 'g-old', 'g-old')).toEqual({
      removed: ['sim-a', 'sim-c'],
      left: [{ id: 'sim-b', geometry_id: 'g-other' }],
    });
  });

  it('removes every study when the only geometry goes', () => {
    expect(splitStudiesOnRemove([{ id: 'sim-a', geometry_id: 'g-old' }], 'g-old', 'g-old')).toEqual({ removed: ['sim-a'], left: [] });
  });

  it("counts a study with no geometry as the first geometry's", () => {
    const untagged = [{ id: 'sim-legacy' }, { id: 'sim-b', geometry_id: 'g-other' }];
    expect(splitStudiesOnRemove(untagged, 'g-first', 'g-first').removed).toEqual(['sim-legacy']);
    expect(splitStudiesOnRemove(untagged, 'g-other', 'g-first').removed).toEqual(['sim-b']);
  });

  it('keeps everything when nothing names the geometry', () => {
    expect(splitStudiesOnRemove(studies, 'g-none', 'g-old').left).toHaveLength(3);
    expect(splitStudiesOnRemove(null, 'g-old', 'g-old')).toEqual({ removed: [], left: [] });
    expect(splitStudiesOnRemove(studies, '', 'g-old').removed).toEqual([]);
  });
});
