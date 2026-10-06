// Snapping to MODEL geometry while drawing, without projecting first (P4b
// SELECT, scope addition A; Fusion's "auto project", SolidWorks' pierce): with
// any drawing tool the pointer snaps to a body's vertices, the middle of a
// straight edge, a point on an edge, the centre of a round edge, and where an
// edge pierces the sketch plane, all seen projected on the sketch plane, with
// the sketch snaps' glyphs (Ctrl still suppresses snapping). A click on one
// adds, in the same sketch edit (one undo step), a LINKED reference made for
// it (a projected point or edge, re-projected at every rebuild, drawn light:
// `auto`) and the relation that ties the new point to it: coincident, on
// curve, midpoint. Picking is the viewport's BVH pick; what a snap needs from
// the kernel (the edge's persistent name, its projection, a pierce point) is
// read once per hovered edge or vertex, so a snap shows once that is known
// (milliseconds after the pointer arrives) and a click always has it.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId } from '../../lib/ids';
import { kernelLookup, refOfEdge, refOfVertex } from '../../naming';
import type { AppServices } from '../../types/app';
import type { PersistentRef, PlaneFrame, SketchLink, SketchLinkSource, Vec2, Vec3 } from '../../types/doc';
import type { TopoResult } from '../../types/kernel-protocol';
import type { SketchBuilder } from '../edit';
import { applyLinkCurves, pierceSegment, toPlaneUv, type PlaneCurve } from './curves';
import { projectItem } from './source';

/** A snap on the model, ready to be placed. */
export interface ModelSnap {
  /** Where the point lands (sketch u/v). */
  at: Vec2;
  kind: 'vertex' | 'midpoint' | 'on-edge' | 'centre' | 'pierce';
  /** The glyph the sketch snaps show for the same relation. */
  glyph: 'coincident' | 'midpoint' | 'on-curve' | 'intersection';
  source: SketchLinkSource;
  /** What the link makes (a point, or the projected edge). */
  curve: PlaneCurve;
  /** The model point the pointer goes to (a vertex, an edge's middle, a centre): the snap distance is measured on screen to it. */
  model?: Vec3;
}

interface Resolved {
  ref: PersistentRef;
  /** The edge's topo (type, ends, centre), or the vertex's position. */
  edge?: TopoResult['edges'][number];
  vertex?: Vec3;
  /** The edge projected on the plane (null when it projects to nothing usable). */
  curve?: PlaneCurve | null;
  /** Where a curved edge crosses the plane (kernel edge_eval), u/v. */
  pierce?: Vec2[];
}

const SNAP_PX = 8;
const cache = new Map<string, Resolved | 'pending' | 'none'>();
let cachePlane = '';
/** Round edges hovered lately: their centres snap even when the pointer has left the edge. */
let recentRound: { key: string; body: string; index: number }[] = [];

const planeKey = (p: PlaneFrame) => [...p.origin, ...p.normal, ...p.xdir].map((x) => x.toFixed(9)).join(',');

/** Forget what was read (another sketch, a rebuild: shape ids and names change). */
export function clearModelSnaps() {
  cache.clear();
  recentRound = [];
}

function resolve(services: AppServices, plane: PlaneFrame, body: string, kind: 'edge' | 'vertex', index: number, onReady: () => void): Resolved | null {
  const pk = planeKey(plane);
  if (pk !== cachePlane) {
    clearModelSnaps();
    cachePlane = pk;
  }
  const info = services.doc.state.get().rebuild.bodies.find((b) => b.id === body);
  const names = info?.names;
  if (!info || !names) return null;
  const key = `${info.shape}|${info.tessKey}|${kind}|${index}`;
  const hit = cache.get(key);
  if (hit && hit !== 'pending' && hit !== 'none') return hit;
  if (hit) return null;
  cache.set(key, 'pending');
  const lookup = kernelLookup(services.kernel);
  void (async () => {
    try {
      if (kind === 'vertex') {
        const [v] = await lookup.vertices!(info.shape, [index]);
        const ref = await refOfVertex(lookup, info.shape, names, index);
        cache.set(key, v ? { ref, vertex: v.p as Vec3 } : 'none');
      } else {
        const [e] = await lookup.edges!(info.shape, [index]);
        const ref = await refOfEdge(lookup, info.shape, names, index);
        const pr = await projectItem(services.kernel, info.shape, plane, { edge: index });
        let pierce: Vec2[] = [];
        if (e && e.type !== 'line') {
          const ev = await services.kernel.call('edge_eval', { id: info.shape, edge: index, plane: { origin: [...plane.origin] as Vec3, normal: [...plane.normal] as Vec3 } });
          pierce = ev.result.crossings.map((c) => toPlaneUv(plane, c.p));
        }
        cache.set(key, e ? { ref, edge: e, curve: pr.curves[0]?.curve ?? null, pierce } : 'none');
      }
    } catch {
      cache.set(key, 'none');
    }
    onReady();
  })();
  return null;
}

const d2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * The model snap under the pointer (or near it), when the drawing tool's own inference found
 * nothing: sketch u/v `at`, `px` mm per pixel, the pointer in frame client px. `onReady` asks the
 * tool to look again once what a snap needs has been read.
 */
export function modelSnap(services: AppServices, plane: PlaneFrame, e: { uv: Vec2; px: number; clientX: number; clientY: number }, onReady: () => void): ModelSnap | null {
  const h = services.viewport.get().handle;
  if (!h?.pickKinds) return null;
  const tol = SNAP_PX * e.px;
  const pick = h.pickKinds(e.clientX, e.clientY, ['vertex', 'edge']);
  const cands: ModelSnap[] = [];
  if (pick?.item.kind === 'vertex') {
    const r = resolve(services, plane, pick.item.body, 'vertex', pick.item.index, onReady);
    if (r?.vertex) {
      const at = toPlaneUv(plane, r.vertex);
      cands.push({ at, kind: 'vertex', glyph: 'coincident', source: { kind: 'vertex', body: pick.item.body, ref: r.ref }, curve: { kind: 'point', p: at }, model: r.vertex });
    }
  } else if (pick?.item.kind === 'edge') {
    const { body, index } = pick.item;
    const r = resolve(services, plane, body, 'edge', index, onReady);
    if (r?.edge) {
      const src: SketchLinkSource = { kind: 'edge', body, ref: r.ref };
      const ed = r.edge;
      if (ed.type === 'circle' || (ed.radius != null && ed.center)) {
        const key = `${body}|${index}`;
        recentRound = [{ key, body, index }, ...recentRound.filter((x) => x.key !== key)].slice(0, 6);
      }
      // Where it pierces the sketch plane (a straight edge: exact from its ends; curved: the kernel's crossings).
      const pierces = ed.type === 'line' && ed.first && ed.last ? [pierceSegment(plane, ed.first, ed.last)].filter((p): p is Vec2 => !!p) : (r.pierce ?? []);
      for (const p of pierces) cands.push({ at: p, kind: 'pierce', glyph: 'intersection', source: { kind: 'pierce', body, ref: r.ref, near: pierceNear(plane, p) }, curve: { kind: 'point', p } });
      const c = r.curve;
      if (c && c.kind === 'line') {
        const mid: Vec2 = [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2];
        const m3: Vec3 | undefined = ed.first && ed.last ? [(ed.first[0] + ed.last[0]) / 2, (ed.first[1] + ed.last[1]) / 2, (ed.first[2] + ed.last[2]) / 2] : undefined;
        cands.push({ at: mid, kind: 'midpoint', glyph: 'midpoint', source: src, curve: c, ...(m3 ? { model: m3 } : {}) });
      }
      if (c && (c.kind === 'line' || c.kind === 'circle' || c.kind === 'arc')) {
        const on = toPlaneUv(plane, pick.point);
        cands.push({ at: closestOnCurve(c, on), kind: 'on-edge', glyph: 'on-curve', source: src, curve: c });
      }
    }
  }
  // Centres of round edges hovered lately (the pointer goes from the rim to the middle).
  for (const r0 of recentRound) {
    const r = resolve(services, plane, r0.body, 'edge', r0.index, onReady);
    const c = r?.curve;
    if (r && c && (c.kind === 'circle' || c.kind === 'arc')) cands.push({ at: c.c, kind: 'centre', glyph: 'coincident', source: { kind: 'edge', body: r0.body, ref: r.ref }, curve: c, ...(r.edge?.center ? { model: r.edge.center as Vec3 } : {}) });
  }
  let best: ModelSnap | null = null;
  let bestD = Infinity;
  const rank = (s: ModelSnap) => (s.kind === 'on-edge' ? 1 : 0);
  for (const s of cands) {
    // Distance in sketch mm: to the snap's model point on screen (a vertex above the plane is seen
    // where it is, not where it projects), else to where it lies on the plane.
    let d = d2(s.at, e.uv);
    if (s.model) {
      const sc = h.project(s.model);
      d = sc ? Math.hypot(sc[0] - e.clientX, sc[1] - e.clientY) * e.px : Infinity;
    }
    if (d > tol && s.kind !== 'on-edge') continue;
    if (s.kind === 'on-edge' && !pick) continue;
    // Points (vertex, middle, centre, pierce) win over a point on the edge.
    const score = d + rank(s) * tol;
    if (score < bestD) {
      best = s;
      bestD = score;
    }
  }
  return best;
}

function closestOnCurve(c: PlaneCurve, p: Vec2): Vec2 {
  if (c.kind === 'line') {
    const dx = c.b[0] - c.a[0];
    const dy = c.b[1] - c.a[1];
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - c.a[0]) * dx + (p[1] - c.a[1]) * dy) / l2));
    return [c.a[0] + t * dx, c.a[1] + t * dy];
  }
  if (c.kind === 'circle' || c.kind === 'arc') {
    const dx = p[0] - c.c[0];
    const dy = p[1] - c.c[1];
    const l = Math.hypot(dx, dy) || 1;
    return [c.c[0] + (c.r * dx) / l, c.c[1] + (c.r * dy) / l];
  }
  return p;
}

/**
 * Place a point on a model snap inside a sketch edit: the auto-made link (re-used when the same
 * source is linked already) and its entity, a new point at the snap, and the relation tying them
 * (optional, as inferred relations are). Returns the new point's id.
 */
export function placeOnModel(b: SketchBuilder, s: ModelSnap, id?: string): string {
  const cur = { points: b.points, entities: b.entities, constraints: b.constraints, links: b.links };
  const same = (b.links ?? []).find((l) => l.source.kind === s.source.kind && l.source.body === s.source.body && 'ref' in l.source && 'ref' in s.source && l.source.ref.name === s.source.ref.name);
  const link: SketchLink = same ?? { id: newId('e').replace(/^e_/, 'l_'), type: 'projected', source: s.source, auto: true, entities: [] };
  const key = s.source.kind === 'vertex' ? 'v' : s.source.kind === 'pierce' ? 'p' : 'e';
  const a = same ? { draft: cur, link: same } : applyLinkCurves(cur, link, [{ key, curve: s.curve }], { construction: true });
  b.points = { ...a.draft.points };
  b.entities = [...a.draft.entities];
  b.links = a.draft.links;
  const row = a.link.entities.find((r) => r.key === key);
  const ent = row ? b.entities.find((x) => x.id === row.entity) : undefined;
  const p = b.addPoint(s.at, id);
  if (!ent) return p;
  if (ent.kind === 'point') b.addRelation('coincident', [p, ent.p], { inferred: true, optional: true });
  else if (s.kind === 'centre' && (ent.kind === 'circle' || ent.kind === 'arc')) b.addRelation('coincident', [p, ent.c], { inferred: true, optional: true });
  else if (s.kind === 'midpoint' && ent.kind === 'line') b.addRelation('midpoint', [p, ent.id], { inferred: true, optional: true });
  else if (ent.kind === 'line') b.addRelation('point_on_line', [p, ent.id], { inferred: true, optional: true });
  else if (ent.kind === 'circle' || ent.kind === 'arc') b.addRelation('point_on_circle', [p, ent.id], { inferred: true, optional: true });
  return p;
}

/** The model point of a plane u/v (the plane's own frame). */
function pierceNear(plane: PlaneFrame, uv: Vec2): Vec3 {
  const [nx, ny, nz] = plane.normal;
  const [x, y, z] = plane.xdir;
  const yv: Vec3 = [ny * z - nz * y, nz * x - nx * z, nx * y - ny * x];
  return [0, 1, 2].map((k) => plane.origin[k] + uv[0] * plane.xdir[k] + uv[1] * yv[k]) as Vec3;
}
