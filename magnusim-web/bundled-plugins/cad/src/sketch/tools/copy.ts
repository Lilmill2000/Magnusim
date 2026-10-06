// Copies of sketch entities under a point map (P4b: mirror and patterns): each
// source point gets its copy point (made once, so a corner two lines share
// stays one corner), each source entity its copy with the mapped points. A
// mirrored arc runs the other way. Copies keep construction and centerline,
// never a link or a lineage parent (they are new geometry).
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId } from '../../lib/ids';
import type { SketchEntity, Vec2 } from '../../types/doc';
import type { SketchBuilder } from '../edit';
import { entityPoints } from '../model';

/** One copy: source entity -> copy entity, source point -> copy point. */
export interface CopyMap {
  entities: Record<string, string>;
  points: Record<string, string>;
}

/**
 * Copy `sources` into the builder: `place(p)` gives a source point's new position, or null to
 * share the source point itself (a point on a mirror line). Returns the maps.
 */
export function copyEntities(b: SketchBuilder, sources: readonly SketchEntity[], place: (id: string, at: Vec2) => Vec2 | null, opts: { flip?: boolean } = {}): CopyMap {
  const points: Record<string, string> = {};
  const entities: Record<string, string> = {};
  const map = (id: string): string => {
    if (points[id]) return points[id];
    const at = b.point(id);
    const to = at ? place(id, at) : null;
    points[id] = to ? b.addPoint(to) : id;
    return points[id];
  };
  for (const e of sources) {
    for (const p of entityPoints(e)) map(p);
    const id = newId('e');
    entities[e.id] = id;
    b.addEntity(copyOf(e, id, map, !!opts.flip));
  }
  return { entities, points };
}

function copyOf(e: SketchEntity, id: string, map: (p: string) => string, flip: boolean): SketchEntity {
  const keep = { ...(e.construction ? { construction: true } : {}) };
  switch (e.kind) {
    case 'point':
      return { id, kind: 'point', p: map(e.p), ...keep };
    case 'line':
      return { id, kind: 'line', p: [map(e.p[0]), map(e.p[1])], ...keep, ...(e.centerline ? { centerline: true } : {}) };
    case 'circle':
      return { id, kind: 'circle', c: map(e.c), r: e.r, ...keep };
    case 'arc': {
      const ccw = e.ccw !== false;
      const nowCcw = flip ? !ccw : ccw;
      return { id, kind: 'arc', c: map(e.c), a: map(e.a), b: map(e.b), ...(nowCcw ? {} : { ccw: false }), ...keep };
    }
    case 'spline':
      return {
        id,
        kind: 'spline',
        form: e.form,
        degree: e.degree,
        pts: e.pts.map(map),
        ...(e.closed ? { closed: true } : {}),
        ...(e.handles ? { handles: [e.handles[0] ? map(e.handles[0]) : null, e.handles[1] ? map(e.handles[1]) : null] as [string | null, string | null] } : {}),
        ...(e.knots && e.mults ? { knots: [...e.knots], mults: [...e.mults] } : {}),
        ...(e.spans ? { spans: [e.spans[0], e.spans[1]] as [number, number] } : {}),
        ...keep,
      };
  }
}

/** The entities picked for a mirror or a pattern (curves and point entities; the origin never). */
export function pickedEntities(d: { entities: SketchEntity[] }, ids: readonly string[]): SketchEntity[] {
  return d.entities.filter((e) => ids.includes(e.id));
}
