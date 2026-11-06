import { describe, expect, it } from 'vitest';
import { REACH_ENGINES, reachApplies, reachNote, reachValue } from './reach';

const NOTE = 'ignores Refine out to: it sizes these faces only. Hex-dominant refines the cells out to this distance.';

describe('Refine out to: which meshers use it, and the note under the field', () => {
  it('Hex-dominant refines out to it, and a plugin mesher on its run path does too: nothing is said', () => {
    expect(REACH_ENGINES).toEqual(['snappy_hexdominant']);
    expect(reachApplies({ key: 'snappy_hexdominant', label: 'Hex-dominant', engine: 'snappy_hexdominant' }, 'snappy_hexdominant')).toBe(true);
    expect(reachNote({ key: 'my_hex', label: 'My hex', engine: 'snappy_hexdominant' }, 'my_hex')).toBe('');
    // Its row not loaded yet: its key.
    expect(reachNote(undefined, 'snappy_hexdominant')).toBe('');
  });

  it('Standard and cfMesh size the faces only, and say so by their names', () => {
    expect(reachNote({ key: 'standard', label: 'Standard', engine: 'standard' }, 'standard')).toBe(`Standard ${NOTE}`);
    expect(reachNote({ key: 'cfmesh', label: 'cfMesh cartesianMesh (legacy)', engine: 'cfmesh' }, 'cfmesh')).toBe(`cfMesh cartesianMesh (legacy) ${NOTE}`);
    // A plugin mesher on Standard's run path, and a core one whose row has not loaded.
    expect(reachNote({ key: 'my_std', label: 'My mesher', engine: 'standard' }, 'my_std')).toBe(`My mesher ${NOTE}`);
    expect(reachNote(null, 'standard')).toBe(`Standard ${NOTE}`);
  });
});

describe('Refine out to: a value typed', () => {
  it('is a distance above 0, or null (empty, 0) for the default band', () => {
    expect(reachValue(15)).toBe(15);
    expect(reachValue('0.025')).toBe(0.025);
    expect(reachValue(' 12 ')).toBe(12);
    expect(reachValue('')).toBeNull();
    expect(reachValue(null)).toBeNull();
    expect(reachValue(undefined)).toBeNull();
    expect(reachValue(0)).toBeNull();
    expect(reachValue('0')).toBeNull();
  });

  it('is refused (undefined) when it is negative or not a number', () => {
    for (const bad of [-5, '-1', 'far', true, {}, Number.NaN, Number.POSITIVE_INFINITY]) expect(reachValue(bad)).toBeUndefined();
  });
});
