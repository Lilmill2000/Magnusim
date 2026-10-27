// The sketch tool's names for what is not one of the model's own macros (CAD tools spec §6.3): an
// entity's geometric parts (a line's start and end, a circle's center, an arc's center, start and
// end, a spline's p0..., start, end, h0, h1), the copies of a sketch pattern or an offset
// ("<tie>.<place>.<source>": place 1, 2... along a linear pattern, i_k with a second direction,
// round a circular one; 1 and 2 for an offset's sides) and a link's curves ("<link>" for one,
// "<link>.1", "<link>.2"... for several). compile.ts and describe.ts both name them this way, so
// a resent sketch keeps every name.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { entityOf, entityPoints } from '../../sketch/model';
import type { SketchEntity, SketchFeature, SketchLink, SketchTie, Vec2 } from '../../types/doc';

/** An entity's points by their parts ('' for a point entity's own point). */
export function partsOfEntity(e: SketchEntity): [part: string, point: string][] {
  switch (e.kind) {
    case 'point':
      return [['', e.p]];
    case 'line':
      return [
        ['start', e.p[0]],
        ['end', e.p[1]],
      ];
    case 'circle':
      return [['center', e.c]];
    case 'arc': {
      const ccw = e.ccw !== false;
      return [
        ['center', e.c],
        ['start', ccw ? e.a : e.b],
        ['end', ccw ? e.b : e.a],
      ];
    }
    case 'spline': {
      const out: [string, string][] = e.pts.map((p, i) => [`p${i}`, p]);
      if (!e.closed) out.push(['start', e.pts[0]], ['end', e.pts[e.pts.length - 1]]);
      if (e.handles?.[0]) out.push(['h0', e.handles[0]]);
      if (e.handles?.[1]) out.push(['h1', e.handles[1]]);
      return out;
    }
    // The Ellipse group (macros.ts): start and end in the curve's own sense.
    case 'ellipse':
      return [
        ['center', e.c],
        ['major', e.major],
        ['minor', e.minor],
      ];
    case 'ellipse_arc': {
      const ccw = e.ccw !== false;
      return [
        ['center', e.c],
        ['major', e.major],
        ['minor', e.minor],
        ['start', ccw ? e.a : e.b],
        ['end', ccw ? e.b : e.a],
      ];
    }
    case 'parabola':
      return [
        ['focus', e.f],
        ['vertex', e.v],
        ['start', e.a],
        ['end', e.b],
      ];
    case 'conic':
      return [
        ['start', e.a],
        ['end', e.b],
        ['top', e.t],
      ];
  }
}

/** The point an entity has at a part, or null. */
export function pointOfPart(e: SketchEntity, part: string): string | null {
  return partsOfEntity(e).find(([p]) => p === part)?.[1] ?? null;
}

/** A copy's place in its tie's name. */
export function placeOf(t: Pick<SketchTie, 'kind' | 'count'>, at: readonly [number, number]): string {
  if (t.kind === 'offset') return at[0] === -1 ? '2' : '1';
  if (t.kind === 'linear' && t.count[1] > 1) return `${at[0]}_${at[1]}`;
  return String(at[0]);
}

/** Each copy entity of a tie by its name "<tie>.<place>.<source's name>". */
export function tieCopyNames(t: SketchTie, nameOf: (id: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of t.copies) {
    const place = placeOf(t, c.at);
    for (const [src, copy] of Object.entries(c.entities)) out.set(copy, `${t.id}.${place}.${nameOf(src)}`);
  }
  return out;
}

/** Each curve of a link by its name: the link's id for one curve, "<link>.<k>" for several. */
export function linkEntityNames(l: SketchLink): Map<string, string> {
  const out = new Map<string, string>();
  const rows = l.entities;
  rows.forEach((r, i) => out.set(r.entity, rows.length === 1 ? l.id : `${l.id}.${i + 1}`));
  return out;
}

/** The entity ids a sketch's ties and links own (pattern and offset copies, linked curves). */
export function ownedEntities(d: { ties?: SketchTie[]; links?: SketchLink[]; entities: SketchEntity[] }): Set<string> {
  const out = new Set<string>();
  for (const t of d.ties ?? []) for (const c of t.copies) for (const id of Object.values(c.entities)) out.add(id);
  for (const e of d.entities) if (e.link) out.add(e.id);
  return out;
}

/** A tie's values as its row's value ("count 4; spacing 10 mm; angle 0 deg"; an offset's distance). */
export function tieValue(t: SketchTie, nameOf: (id: string) => string): string {
  if (t.kind === 'offset') return t.exprs.distance ?? '';
  if (t.kind === 'circular') return t.full ? `count ${t.count[0]}` : `count ${t.count[0]}; angle ${t.exprs.angle}`;
  const along = t.along ?? [null, null];
  const parts = [`count ${t.count[0]}`, `spacing ${t.exprs.spacing1}`, along[0] ? `along ${nameOf(along[0])}` : `angle ${t.exprs.angle1}`];
  if (t.count[1] > 1) parts.push(`count2 ${t.count[1]}`, `spacing2 ${t.exprs.spacing2}`, along[1] ? `along2 ${nameOf(along[1])}` : `angle2 ${t.exprs.angle2}`);
  return parts.join('; ');
}

/** An offset's side as a place on it (describe.ts): a point just off its first source, on the side of the first copy. */
export function offsetSidePlace(d: Pick<SketchFeature, 'points' | 'entities'>, t: SketchTie): Vec2 | null {
  if (t.kind !== 'offset' || t.copies.length !== 1) return null;
  const cp = t.copies[0];
  const src = t.sources[0];
  const copy = cp.entities[src];
  const a = entityOf(d, src);
  const b = copy ? entityOf(d, copy) : null;
  if (!a || !b) return null;
  // A point of the copy lies on the side the offset went: one the source does not have (a circle's: on its edge).
  if (b.kind === 'circle') {
    const c = d.points[b.c];
    return c ? [c[0] + b.r, c[1]] : null;
  }
  const own = entityPoints(a);
  const pa = entityPoints(b)
    .filter((p) => !own.includes(p))
    .map((p) => d.points[p])
    .find(Boolean);
  return pa ? [pa[0], pa[1]] : null;
}
