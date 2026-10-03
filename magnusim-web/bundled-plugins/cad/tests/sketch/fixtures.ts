// Small sketches for the sketch-mode unit tests (test-only).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchConstraint, SketchEntity, SketchFeature, Vec2 } from '../../src/types/doc';

export type Geo = Pick<SketchFeature, 'points' | 'entities' | 'constraints'>;

/** A sketch feature around some geometry (Top plane). */
export function sketchOf(g: Partial<Geo>, extra: Partial<SketchFeature> = {}): SketchFeature {
  return {
    id: 'f_sketch',
    type: 'sketch',
    name: 'Sketch 1',
    support: { kind: 'plane', plane: 'origin:top' },
    plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
    points: g.points ?? {},
    entities: g.entities ?? [],
    constraints: g.constraints ?? [],
    solved: { values: {}, dof: 0, state: 'unsolved' },
    ...extra,
  };
}

/** A rectangle e1..e4 through p1..p4, counter-clockwise from (x0, y0), width w, height h, H/V on its sides. */
export function rectangle(x0: number, y0: number, w: number, h: number, opts: { hv?: boolean; origin?: boolean } = {}): Geo {
  const points: Record<string, Vec2> = { p1: [x0, y0], p2: [x0 + w, y0], p3: [x0 + w, y0 + h], p4: [x0, y0 + h] };
  const entities: SketchEntity[] = [
    { id: 'e1', kind: 'line', p: ['p1', 'p2'] },
    { id: 'e2', kind: 'line', p: ['p2', 'p3'] },
    { id: 'e3', kind: 'line', p: ['p3', 'p4'] },
    { id: 'e4', kind: 'line', p: ['p4', 'p1'] },
  ];
  const constraints: SketchConstraint[] = [];
  if (opts.hv !== false) {
    constraints.push(
      { id: 'h1', kind: 'horizontal', refs: ['e1'] },
      { id: 'v2', kind: 'vertical', refs: ['e2'] },
      { id: 'h3', kind: 'horizontal', refs: ['e3'] },
      { id: 'v4', kind: 'vertical', refs: ['e4'] },
    );
  }
  if (opts.origin) constraints.push({ id: 'co', kind: 'coincident', refs: ['p1', 'origin'] });
  return { points, entities, constraints };
}

export function circle(id: string, c: Vec2, r: number, centre = `${id}c`): Geo {
  return { points: { [centre]: c }, entities: [{ id, kind: 'circle', c: centre, r }], constraints: [] };
}

export function merge(...gs: Geo[]): Geo {
  return {
    points: Object.assign({}, ...gs.map((g) => g.points)),
    entities: gs.flatMap((g) => g.entities),
    constraints: gs.flatMap((g) => g.constraints),
  };
}
