// Linked sketch geometry, the pure part (P4b SELECT): the curves a source
// gives on the sketch plane (PlaneCurve: the kernel's project_to_plane /
// silhouette / plane_section output, or the JS projection of a straight edge
// or a vertex), how they become fixed sketch entities of a link (same key ->
// same entity, so constraints and region keys survive a re-projection), what
// a rebuild moves without changing the sketch's entities, and the links'
// upkeep (Break link, deleted entities). No kernel, no DOM (unit-tested).
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { hashString } from '../../doc/canonical';
import { newId } from '../../lib/ids';
import type { PlaneFrame, SketchEntity, SketchFeature, SketchLink, SketchLinkId, Vec2, Vec3 } from '../../types/doc';
import type { SketchDraft } from '../edit';
import { entityPoints } from '../model';

/** A curve on the sketch plane (u along xdir, v along normal x xdir; mm). Kernel R2-R4's PlaneCurve. */
export type PlaneCurve =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number }
  | { kind: 'arc'; c: Vec2; r: number; a: Vec2; b: Vec2; ccw: boolean }
  | { kind: 'bspline'; degree: number; poles: Vec2[]; knots: number[]; mults: number[]; a: Vec2; b: Vec2; closed: boolean }
  | { kind: 'point'; p: Vec2 };

export interface KeyedCurve {
  key: string;
  curve: PlaneCurve;
}

/** A link's draft fields: the geometry and the links. */
export type LinkDraft = SketchDraft & Pick<SketchFeature, 'links'>;

// ------------------------------------------------------------ projection in JS (straight edges and vertices)

/** A model point on the sketch plane (orthogonal projection along the normal), in the plane's u/v. */
export function toPlaneUv(plane: PlaneFrame, p: Vec3): Vec2 {
  const [nx, ny, nz] = plane.normal;
  const [xx, xy, xz] = plane.xdir;
  const y: Vec3 = [ny * xz - nz * xy, nz * xx - nx * xz, nx * xy - ny * xx];
  const d: Vec3 = [p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]];
  return [d[0] * plane.xdir[0] + d[1] * plane.xdir[1] + d[2] * plane.xdir[2], d[0] * y[0] + d[1] * y[1] + d[2] * y[2]];
}

/** Signed distance of a model point from the plane (along its normal). */
export function planeDistance(plane: PlaneFrame, p: Vec3): number {
  const n = plane.normal;
  return (p[0] - plane.origin[0]) * n[0] + (p[1] - plane.origin[1]) * n[1] + (p[2] - plane.origin[2]) * n[2];
}

/** The tolerance below which two plane points are the same (mm). */
export const SAME_PT = 1e-6;

/**
 * A straight edge from `first` to `last` projected on the plane: a line, or a point when the edge
 * runs along the normal (seen end-on).
 */
export function projectSegment(plane: PlaneFrame, first: Vec3, last: Vec3): PlaneCurve {
  const a = toPlaneUv(plane, first);
  const b = toPlaneUv(plane, last);
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= SAME_PT) return { kind: 'point', p: a };
  return { kind: 'line', a, b };
}

/** Where a straight edge pierces the plane (SolidWorks "pierce"), or null when it does not reach it or lies in it. */
export function pierceSegment(plane: PlaneFrame, first: Vec3, last: Vec3): Vec2 | null {
  const d0 = planeDistance(plane, first);
  const d1 = planeDistance(plane, last);
  if (Math.abs(d1 - d0) < 1e-12) return null;
  if ((d0 > SAME_PT && d1 > SAME_PT) || (d0 < -SAME_PT && d1 < -SAME_PT)) return null;
  const t = d0 / (d0 - d1);
  const p: Vec3 = [first[0] + t * (last[0] - first[0]), first[1] + t * (last[1] - first[1]), first[2] + t * (last[2] - first[2])];
  return toPlaneUv(plane, p);
}

// ------------------------------------------------------------ curves -> entities

/** The entity kind a curve makes. */
export function entityKindOf(c: PlaneCurve): SketchEntity['kind'] {
  return c.kind === 'bspline' ? 'spline' : c.kind;
}

/** The point positions an entity of this curve has, in entityPoints order. */
export function curvePoints(c: PlaneCurve): Vec2[] {
  switch (c.kind) {
    case 'point':
      return [c.p];
    case 'line':
      return [c.a, c.b];
    case 'circle':
      return [c.c];
    case 'arc':
      return [c.c, c.a, c.b];
    case 'bspline':
      return c.poles;
  }
}

/** Whether entity `e` can take curve `c` in place (same kind and the same number of points). */
export function fits(e: SketchEntity, c: PlaneCurve): boolean {
  if (entityKindOf(c) !== e.kind) return false;
  if (e.kind === 'spline') return c.kind === 'bspline' && e.pts.length === c.poles.length && e.degree === c.degree;
  if (e.kind === 'arc' && c.kind === 'arc') return (e.ccw !== false) === c.ccw;
  return true;
}

/** Which point slots of a curve are ends (shared with a neighbour where they meet); the rest are its own (a centre, an inner pole). */
export function sharedSlots(c: PlaneCurve): number[] {
  switch (c.kind) {
    case 'point':
      return [0];
    case 'line':
      return [0, 1];
    case 'circle':
      return [];
    case 'arc':
      return [1, 2];
    case 'bspline':
      return c.poles.length > 1 ? [0, c.poles.length - 1] : [0];
  }
}

/** Ends closer than this are one point (mm): the kernel gives neighbours the same vertex. */
export const SHARED_TOL = 1e-6;

/** A deterministic id (the rebuild and the opened sketch make the same entities for the same curves). */
function detId(prefix: 'e' | 'pt', ...parts: string[]): string {
  return `${prefix}_${hashString(parts.join('|'))}`;
}

/** The entity with these point ids in entityPoints order (and a curve's radius / knots). */
function withPoints(e: SketchEntity, ids: string[], c: PlaneCurve | null): SketchEntity {
  switch (e.kind) {
    case 'point':
      return ids[0] === e.p ? e : { ...e, p: ids[0] };
    case 'line':
      return ids[0] === e.p[0] && ids[1] === e.p[1] ? e : { ...e, p: [ids[0], ids[1]] };
    case 'circle': {
      const r = c?.kind === 'circle' ? c.r : e.r;
      return ids[0] === e.c && r === e.r ? e : { ...e, c: ids[0], r };
    }
    case 'arc':
      return ids[0] === e.c && ids[1] === e.a && ids[2] === e.b ? e : { ...e, c: ids[0], a: ids[1], b: ids[2] };
    case 'spline': {
      const same = ids.length >= e.pts.length && e.pts.every((p, i) => p === ids[i]);
      if (c?.kind !== 'bspline') return same ? e : { ...e, pts: ids.slice(0, e.pts.length) };
      const sameKnots = !!e.knots && !!e.mults && e.knots.join() === c.knots.join() && e.mults.join() === c.mults.join();
      return same && sameKnots ? e : { ...e, pts: ids.slice(0, e.pts.length), knots: [...c.knots], mults: [...c.mults] };
    }
  }
}

/** A new linked entity for a curve, with these point ids. */
function makeEntity(c: PlaneCurve, id: string, link: SketchLinkId, ids: string[], construction: boolean): SketchEntity {
  const base = { id, link, ...(construction ? { construction: true } : {}) };
  switch (c.kind) {
    case 'point':
      return { ...base, kind: 'point', p: ids[0] };
    case 'line':
      return { ...base, kind: 'line', p: [ids[0], ids[1]] };
    case 'circle':
      return { ...base, kind: 'circle', c: ids[0], r: c.r };
    case 'arc':
      return { ...base, kind: 'arc', c: ids[0], a: ids[1], b: ids[2], ...(c.ccw ? {} : { ccw: false }) };
    case 'bspline':
      return { ...base, kind: 'spline', form: 'control', pts: ids, degree: c.degree, knots: [...c.knots], mults: [...c.mults] };
  }
}

const samePt = (a: Vec2 | undefined, b: Vec2 | undefined) => !!a && !!b && Math.abs(a[0] - b[0]) <= 1e-9 && Math.abs(a[1] - b[1]) <= 1e-9;

/**
 * Put a link's curves into a draft, so the linked geometry is exactly what the source gives now
 * (P4b fix round 1, B-1: shared corners were written last-write-wins when the source gained or lost
 * curves, and kept lines ran diagonally across the face):
 * - the curves' ends are clustered where they meet: one point per place, so neighbours stay joined;
 * - a key the link has keeps its entity (its id and every constraint on it) and takes the points of its
 *   places; an old point id that two places now want stays with the first, the other gets a new point;
 * - a new key (not one the user dropped) adds a fixed entity with deterministic ids, so the rebuild
 *   (in memory) and the opened sketch (stored) make the same ones;
 * - a key the source no longer gives keeps its entity WHERE IT WAS (lost, amber): its points are
 *   detached from the places the others moved to;
 * - a key whose curve changed kind gets a new entity; the old one stays, lost.
 * `construction`: new entities of an auto-made reference (a guide, never part of a profile).
 */
export function applyLinkCurves(d: LinkDraft, link: SketchLink, curves: readonly KeyedCurve[], opts: { construction?: boolean } = {}): { draft: LinkDraft; link: SketchLink; added: string[]; lostKeys: string[]; changed: boolean } {
  const points = { ...d.points };
  const byId = new Map(d.entities.map((e) => [e.id, e] as const));
  const entities = [...d.entities];
  const index = new Map(entities.map((e, i) => [e.id, i] as const));
  const put = (e: SketchEntity) => {
    const i = index.get(e.id);
    if (i == null) {
      index.set(e.id, entities.length);
      entities.push(e);
    } else entities[i] = e;
  };
  const dropped = new Set(link.dropped ?? []);
  const rows = link.entities.map((r) => ({ ...r }));
  const oldLinked = new Set<string>();
  for (const r of rows) {
    const e = byId.get(r.entity);
    if (e) for (const p of entityPoints(e)) oldLinked.add(p);
  }
  const clusters: { at: Vec2; id: string | null }[] = [];
  const clusterOf = (p: Vec2) => {
    for (const c of clusters) if (Math.hypot(c.at[0] - p[0], c.at[1] - p[1]) <= SHARED_TOL) return c;
    const c = { at: [p[0], p[1]] as Vec2, id: null as string | null };
    clusters.push(c);
    return c;
  };
  const used = new Set<string>();
  const live = curves.filter((k) => !dropped.has(k.key));
  const kept: { key: string; curve: PlaneCurve; e: SketchEntity }[] = [];
  const fresh: { key: string; curve: PlaneCurve }[] = [];
  for (const k of live) {
    const row = rows.find((r) => r.key === k.key);
    const e = row ? byId.get(row.entity) : undefined;
    if (e && e.link === link.id && fits(e, k.curve)) kept.push({ key: k.key, curve: k.curve, e });
    else fresh.push(k);
  }
  /** The point ids for a curve's slots: shared places by cluster, own points kept unless taken. */
  const assign = (key: string, curve: PlaneCurve, current: string[] | null): string[] => {
    const at = curvePoints(curve);
    const shared = new Set(sharedSlots(curve));
    return at.map((p, i) => {
      const mine = current?.[i] ?? null;
      let id: string;
      if (shared.has(i)) {
        const c = clusterOf(p);
        if (c.id) id = c.id;
        else {
          id = mine && !used.has(mine) ? mine : detId('pt', link.id, key, String(i));
          c.id = id;
        }
      } else id = mine && !used.has(mine) ? mine : detId('pt', link.id, key, String(i));
      used.add(id);
      points[id] = [p[0], p[1]];
      return id;
    });
  };
  for (const k of kept) put(withPoints(k.e, assign(k.key, k.curve, entityPoints(k.e)), k.curve));
  const added: string[] = [];
  for (const k of fresh) {
    const row = rows.find((r) => r.key === k.key);
    const id = detId('e', link.id, k.key, k.curve.kind, row?.entity ?? '');
    const ne = makeEntity(k.curve, id, link.id, assign(k.key, k.curve, null), !!opts.construction);
    put(ne);
    added.push(ne.id);
    if (row) {
      // The curve changed kind: the new entity takes the key; the old one stays where it was, lost.
      const old = row.entity;
      row.entity = ne.id;
      if (byId.has(old)) rows.push({ key: `${k.key}~${old}`, entity: old });
    } else rows.push({ key: k.key, entity: ne.id });
  }
  // Lost entities stay where they were: a point of theirs that a kept curve moved is detached.
  const seen = new Set(live.map((k) => k.key));
  const lostKeys = rows.filter((r) => !seen.has(r.key) && !dropped.has(r.key)).map((r) => r.key);
  for (const r of rows) {
    if (seen.has(r.key)) continue;
    const e = entities[index.get(r.entity) ?? -1];
    if (!e) continue;
    const ids = entityPoints(e);
    let detached = false;
    const next = ids.map((id, i) => {
      const was = d.points[id];
      if (!was || !used.has(id) || samePt(points[id], was)) return id;
      detached = true;
      const nid = detId('pt', link.id, r.key, String(i), 'lost');
      points[nid] = [was[0], was[1]];
      return nid;
    });
    if (detached) put(withPoints(e, next, null));
  }
  // Points of this link that no entity and no constraint uses any more go.
  const inUse = new Set<string>();
  for (const e of entities) for (const p of entityPoints(e)) inUse.add(p);
  for (const c of d.constraints) for (const ref of c.refs) inUse.add(ref);
  for (const id of oldLinked) if (!inUse.has(id)) delete points[id];
  const next: SketchLink = { ...link, entities: rows };
  const links = (d.links ?? []).some((l) => l.id === link.id) ? (d.links ?? []).map((l) => (l.id === link.id ? next : l)) : [...(d.links ?? []), next];
  const changed =
    added.length > 0 ||
    entities.length !== d.entities.length ||
    entities.some((e, i) => e !== d.entities[i]) ||
    Object.keys(points).length !== Object.keys(d.points).length ||
    Object.entries(points).some(([id, p]) => !samePt(d.points[id], p));
  return { draft: { ...d, points, entities, links }, link: next, added, lostKeys, changed };
}

// ------------------------------------------------------------ upkeep

/** The link an entity belongs to, or null. */
export function linkOfEntity(d: Pick<SketchFeature, 'entities' | 'links'>, entity: string): SketchLink | null {
  const e = d.entities.find((x) => x.id === entity);
  if (!e?.link) return null;
  return (d.links ?? []).find((l) => l.id === e.link) ?? null;
}

/**
 * Links pruned to the entities still in the sketch and still linked: a curve the user deleted or broke
 * leaves its link, and its key is DROPPED (never re-added by a re-projection, never reported as
 * changed: B-2). A link with no curve left goes.
 */
export function prunedLinks(d: Pick<SketchFeature, 'entities' | 'links'>): SketchLink[] | undefined {
  if (!d.links) return d.links;
  const linked = new Map(d.entities.filter((e) => e.link).map((e) => [e.id, e.link] as const));
  const out: SketchLink[] = [];
  for (const l of d.links) {
    const rows = l.entities.filter((r) => linked.get(r.entity) === l.id);
    if (!rows.length) continue;
    if (rows.length === l.entities.length) {
      out.push(l);
      continue;
    }
    const gone = l.entities.filter((r) => !rows.includes(r)).map((r) => r.key.split('~')[0]);
    const dropped = [...new Set([...(l.dropped ?? []), ...gone.filter((k) => !rows.some((r) => r.key === k))])];
    out.push({ ...l, entities: rows, ...(dropped.length ? { dropped } : {}) });
  }
  return out.length ? out : undefined;
}

/**
 * Break link: these entities become ordinary geometry where they are (their fixes go; constraints
 * on them stay). Null when none of them is linked.
 */
export function breakLinks(d: LinkDraft, ids: readonly string[]): LinkDraft | null {
  const set = new Set(ids);
  if (!d.entities.some((e) => set.has(e.id) && e.link)) return null;
  // Points the broken curves share with curves that stay linked: the broken ones get their own copy,
  // so they no longer move with the model nor stay fixed by it (B-2).
  const stayLinked = new Set<string>();
  for (const e of d.entities) if (e.link && !set.has(e.id)) for (const p of entityPoints(e)) stayLinked.add(p);
  const points = { ...d.points };
  const copies = new Map<string, string>();
  const own = (id: string) => {
    if (!stayLinked.has(id) || !points[id]) return id;
    let c = copies.get(id);
    if (!c) {
      c = newId('pt');
      points[c] = [points[id][0], points[id][1]];
      copies.set(id, c);
    }
    return c;
  };
  const entities = d.entities.map((e) => {
    if (!set.has(e.id) || !e.link) return e;
    const { link: _l, ...rest } = e;
    return withPoints(rest as SketchEntity, entityPoints(e).map(own), null);
  });
  const next: LinkDraft = { ...d, points, entities };
  next.links = prunedLinks(next);
  return next;
}

/** The refusal for editing a linked entity's own shape (trim, extend, offset, drag): null when it is not linked. */
export function linkedRefusal(d: Pick<SketchFeature, 'entities'>, id: string, label: string): string | null {
  const e = d.entities.find((x) => x.id === id);
  return e?.link ? `${label} follows the model: Break link first (right-click it)` : null;
}
