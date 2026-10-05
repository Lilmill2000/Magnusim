import { describe, expect, it } from 'vitest';
import type { RegistryRow } from './api/registry.gen';
import {
  DEFAULT_WALLS_LABEL,
  DEFAULT_WALLS_TOKEN,
  boundaryChoices,
  boundaryLacksPatch,
  isPlaced,
  meshPatchNames,
  newMonitorRecord,
  placedText,
  sanitizePatchName,
  savedPoint,
  targetOf,
} from './monitorTargets';

const forces: RegistryRow = { key: 'forces', label: 'Forces', target: 'boundary', boundary_kinds: ['wall'] };
const probe: RegistryRow = { key: 'probe', label: 'Point probe', target: 'point' };
const area: RegistryRow = { key: 'area_average', label: 'Area average', target: 'patch' };

const bcs = [
  { id: 'bc-in', name: 'Inlet', bc_type: 'Velocity inlet', faces: ['face 1@B'] },
  { id: 'bc-wing', name: 'Wing', bc_type: 'Wall', faces: ['face 2@B', 'face 3@B'] },
  { name: 'Flap', bc_type: 'Wall', faces: ['face 4@B'] },
  { id: 'bc-empty', name: 'Spare wall', bc_type: 'Wall', faces: [] },
];
const family = (bc: { bc_type?: unknown }) => (String(bc.bc_type) === 'Wall' ? 'wall' : 'velocity_inlet');

describe('monitor targets', () => {
  it('reads a type row target, faces when it names none', () => {
    expect(targetOf(forces)).toBe('boundary');
    expect(targetOf({ key: 'x', label: 'X' })).toBe('patch');
  });

  it('lists the BCs of the kinds a boundary monitor takes, then the walls no BC claims', () => {
    expect(boundaryChoices(bcs, ['wall'], family)).toEqual([
      { token: 'bc-wing', label: 'Wing', bcName: 'Wing' },
      { token: 'Flap', label: 'Flap', bcName: 'Flap' },
      { token: DEFAULT_WALLS_TOKEN, label: DEFAULT_WALLS_LABEL, bcName: '' },
    ]);
    // Inlets only: no default walls.
    expect(boundaryChoices(bcs, ['velocity_inlet'], family).map((c) => c.token)).toEqual(['bc-in']);
    // Any kind.
    expect(boundaryChoices(bcs, [], family).map((c) => c.token)).toEqual(['bc-in', 'bc-wing', 'Flap', DEFAULT_WALLS_TOKEN]);
  });

  it('names patches as the mesher does and tells which boundaries a mesh has no patch for', () => {
    expect(sanitizePatchName('Wing tip #2')).toBe('wing_tip_2');
    expect(sanitizePatchName('2nd wall')).toBe('p_2nd_wall');
    expect(sanitizePatchName('***')).toBe('patch');
    const wing = { token: 'bc-wing', label: 'Wing', bcName: 'Wing' };
    const walls = { token: DEFAULT_WALLS_TOKEN, label: DEFAULT_WALLS_LABEL, bcName: '' };
    expect(boundaryLacksPatch(wing, ['inlet', 'wing_2', 'walls'])).toBe(false);
    expect(boundaryLacksPatch(wing, ['inlet', 'walls'])).toBe(true);
    expect(boundaryLacksPatch(walls, ['inlet', 'wing'])).toBe(true);
    // Patches not known: nothing is claimed missing.
    expect(boundaryLacksPatch(wing, null)).toBe(false);
    expect(meshPatchNames({ patches: ['inlet', { name: 'wing' }] })).toEqual(['inlet', 'wing']);
    expect(meshPatchNames({ live_mesh_result: { patches: [{ name: 'walls', type: 'wall' }] } })).toEqual(['walls']);
    expect(meshPatchNames({ name: 'Mesh 1' })).toBeNull();
  });

  it("a new result control carries its target's fields", () => {
    const f = newMonitorRecord(forces, 'rc-1', 'Forces 1', { boundaries: ['bc-wing', DEFAULT_WALLS_TOKEN] });
    expect(f).toMatchObject({
      id: 'rc-1',
      name: 'Forces 1',
      monitor_type: 'forces',
      kind: 'Forces',
      category: 'Boundary data',
      faces: [],
      boundaries: ['bc-wing', DEFAULT_WALLS_TOKEN],
    });
    expect(newMonitorRecord(probe, 'rc-2', 'Point probe 1')).toMatchObject({ category: 'Point data', points: [] });
    const a = newMonitorRecord(area, 'rc-3', 'Area average 1');
    expect(a).toMatchObject({ category: 'Surface data', faces: [] });
    expect('boundaries' in a || 'points' in a).toBe(false);
  });

  it('says what a monitor is placed on', () => {
    expect(placedText({ boundaries: ['a', 'b'] }, forces)).toBe('2 walls');
    expect(placedText({ boundaries: ['a'] }, { ...forces, boundary_kinds: [] })).toBe('1 boundary');
    expect(placedText({ points: [[0, 0, 0]] }, probe)).toBe('1 point');
    expect(placedText({ faces: ['f1', 'f2', 'f3'] }, area)).toBe('3 faces');
    expect(placedText({ faces: [] }, area)).toBe('');
    expect(isPlaced({ points: [[0, 0, 0]] })).toBe(true);
    expect(isPlaced({ faces: [], boundaries: [] })).toBe(false);
  });

  it('reads saved points', () => {
    expect(savedPoint([0.1, '0', -2])).toEqual([0.1, 0, -2]);
    expect(savedPoint([0.1, '', 0])).toBeNull();
    expect(savedPoint([1, 2])).toBeNull();
  });
});
