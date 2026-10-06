// The PATTERN group's feature types (proposal §2.6, Daniel's item 7): Linear pattern,
// Circular pattern and Mirror, each of features, bodies or faces, each with its own
// Operation, each copy named after its source (naming.ts) and skippable by its key.
// Values are evaluated here with the panel's words ("Count: ...", "Spacing must be more than 0").
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
import { parseDerivedBodyId } from '../../doc/features/body-ids';
import { newId, nextName } from '../../lib/ids';
import type { BodyId, CircularPatternFeature, Feature, FeatureId, LinearPatternFeature, MirrorFeature, PatternCommon, PatternDirection } from '../../types/doc';
import type { ExprField, FeatureTypeDef, ResolveResult } from '../../types/doc-service';
import type { Expr, UnitsService } from '../../types/units';
import { refBodies, refParents, resolveAxis, resolvePlane } from '../refgeom/resolve';
import { buildPattern, type PatternFeature } from './build';
import { PATTERN_ICONS } from './icons';
import { circularCopies, landsOn, linearCopies, MAX_COPIES, mirrorCopies, parallel, stepOf, unitOf, type LinearDir } from './transforms';

type R<T> = { ok: true; value: T } | { ok: false; message: string };

function evalAs(label: string, expr: Expr, q: 'length' | 'angle' | 'scalar', units: UnitsService): R<number> {
  const r = units.evaluate(typeof expr === 'string' ? expr : String(expr ?? ''), q);
  return r.ok ? { ok: true, value: r.value } : { ok: false, message: `${label}: ${r.error}` };
}

/** A count: a whole number from `min` (the original included). */
export function countOf(label: string, expr: Expr, units: UnitsService, min = 2): R<number> {
  const r = evalAs(label, expr, 'scalar', units);
  if (!r.ok) return r;
  if (Math.abs(r.value - Math.round(r.value)) > 1e-9) return { ok: false, message: `${label} must be a whole number` };
  const n = Math.round(r.value);
  if (n < min) return { ok: false, message: `${label} must be at least ${min} (the original counts as 1)` };
  return { ok: true, value: n };
}

export interface DirValues {
  count: number;
  /** Between neighbours (mm). */
  step: number;
  symmetric: boolean;
}

/** Field words of a direction ("Count", "Spacing" / "Extent"; "Direction 2: Count" for the second). */
export function resolveDirection(d: PatternDirection, units: UnitsService, prefix = ''): R<DirValues> {
  const c = countOf(`${prefix}Count`, d.count, units);
  if (!c.ok) return c;
  const what = d.mode === 'extent' ? 'Extent' : 'Spacing';
  const v = evalAs(`${prefix}${what}`, d.distance, 'length', units);
  if (!v.ok) return v;
  if (!(v.value > 0)) return { ok: false, message: `${prefix}${what} must be more than 0` };
  return { ok: true, value: { count: c.value, step: stepOf(d.mode, v.value, c.value), symmetric: !!d.symmetric } };
}

const total = (d: DirValues) => (d.symmetric ? 2 * d.count - 1 : d.count);

export interface LinearValues {
  dir1: DirValues;
  dir2: DirValues | null;
}
export interface CircularValues {
  count: number;
  angle: number;
}

/** Fields every pattern starts with (the source kind from the command's selection). */
function common(init: Partial<PatternCommon> = {}): PatternCommon {
  return { of: 'features', features: [], bodies: [], faceBody: '', faces: [], op: 'source', creates: null, scope: [], skip: [], ...init };
}

/** Why a pattern cannot build yet (its sources), or null. */
export function sourcesIncomplete(f: PatternCommon): string | null {
  if (f.of === 'features') return f.features.length ? null : 'Pick the features to repeat (their rows, or their faces in the view)';
  if (f.of === 'bodies') return f.bodies.length ? null : 'Pick the bodies to copy';
  return f.faceBody && f.faces.length ? null : 'Pick the faces to copy';
}

const sourceParents = (f: PatternCommon): FeatureId[] => (f.of === 'features' ? [...f.features] : []);

/** Bodies the pattern reads: features may read any body before them (their extents), bodies their own, faces theirs. */
function sourceUses(f: PatternCommon): BodyId[] | 'all' {
  if (f.of === 'features') return 'all';
  if (f.of === 'faces') return f.faceBody ? [f.faceBody] : [];
  if (f.op === 'new' || f.op === 'source') return [...f.bodies];
  return f.scope.length ? [...new Set([...f.bodies, ...f.scope])] : 'all';
}

/**
 * The bodies the copies make under New body (or "As each feature" of a feature that makes a new
 * body): ids derived from the source body (bodies), or from the pattern's own id (features).
 */
function ownsCopy(f: PatternCommon & { id: FeatureId }, id: BodyId): boolean {
  if (f.of === 'faces' || (f.op !== 'new' && f.op !== 'source')) return false;
  const d = parseDerivedBodyId(f.id, id);
  if (!d) return false;
  return f.of === 'bodies' ? f.bodies.includes(d.target) : d.target === f.id;
}

const commonExprs = (): ExprField[] => [];

function dirExprs(d: PatternDirection, at: string): ExprField[] {
  return [
    { path: `${at}.count`, expr: d.count },
    { path: `${at}.distance`, expr: d.distance },
  ];
}
const mapDir = (d: PatternDirection, fn: (e: Expr) => Expr): PatternDirection => ({ ...d, count: fn(d.count), distance: fn(d.distance) });

export const DEFAULT_DIRECTION: PatternDirection = { axis: null, flip: false, count: '3', mode: 'spacing', distance: '20 mm', symmetric: false };

// ------------------------------------------------------------ Linear pattern

export const linearPatternDef: FeatureTypeDef<LinearPatternFeature, LinearValues> = {
  type: 'pattern_linear',
  label: 'Linear pattern',
  icon: PATTERN_ICONS.linear,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'pattern_linear',
      name: nextName('Linear pattern', doc.features.map((f) => f.name)),
      ...common(init),
      dir1: { ...DEFAULT_DIRECTION },
      dir2: null,
      ...init,
    } as LinearPatternFeature;
  },
  resolve(f, units) {
    const d1 = resolveDirection(f.dir1, units);
    if (!d1.ok) return d1;
    let d2: DirValues | null = null;
    if (f.dir2) {
      const r = resolveDirection(f.dir2, units, 'Direction 2: ');
      if (!r.ok) return r;
      d2 = r.value;
    }
    if (total(d1.value) * (d2 ? total(d2) : 1) - 1 > MAX_COPIES) return { ok: false, message: `That makes ${total(d1.value) * (d2 ? total(d2) : 1) - 1} copies: at most ${MAX_COPIES} in one pattern` };
    return { ok: true, values: { dir1: d1.value, dir2: d2 } };
  },
  incomplete(f, units) {
    const s = sourcesIncomplete(f);
    if (s) return s;
    if (!f.dir1.axis) return 'Pick direction 1: an edge, an axis, a sketch line or a plane (its normal)';
    if (f.dir2 && !f.dir2.axis) return 'Pick direction 2, or remove it';
    const r = linearPatternDef.resolve(f, units);
    return r.ok ? null : r.message;
  },
  parents: (f) => [...new Set([...sourceParents(f), ...refParents([f.dir1.axis, f.dir2?.axis])])],
  uses(f) {
    const own = sourceUses(f);
    return own === 'all' ? 'all' : [...new Set([...own, ...refBodies([f.dir1.axis, f.dir2?.axis])])];
  },
  ownsBody: (f, id) => ownsCopy(f, id),
  exprs: (f) => [...commonExprs(), ...dirExprs(f.dir1, 'dir1'), ...(f.dir2 ? dirExprs(f.dir2, 'dir2') : [])],
  mapExprs: (f, fn) => ({ ...f, dir1: mapDir(f.dir1, fn), dir2: f.dir2 ? mapDir(f.dir2, fn) : null }),
  async build(f, v, ctx) {
    const axisOf = async (d: PatternDirection, words: string) => {
      if (!d.axis) return { ok: false as const, message: `${f.name} failed: Pick ${words}` };
      const a = await resolveAxis(d.axis, ctx);
      if (!a.ok) return { ok: false as const, message: `${f.name} failed: ${words[0].toUpperCase()}${words.slice(1)}: ${a.message}` };
      const u = unitOf(a.value.dir);
      if (!u) return { ok: false as const, message: `${f.name} failed: ${words} has no direction` };
      return { ok: true as const, dir: (d.flip ? [-u[0], -u[1], -u[2]] : u) as [number, number, number], warning: a.warning };
    };
    const a1 = await axisOf(f.dir1, 'direction 1');
    if (!a1.ok) return a1;
    let d2: LinearDir | null = null;
    if (f.dir2 && v.dir2) {
      const a2 = await axisOf(f.dir2, 'direction 2');
      if (!a2.ok) return a2;
      if (parallel(a1.dir, a2.dir)) return { ok: false, message: `${f.name} failed: Direction 2 runs along direction 1, so the copies would land on each other: pick a direction across it` };
      d2 = { dir: a2.dir, step: v.dir2.step, count: v.dir2.count, symmetric: v.dir2.symmetric };
    }
    const copies = linearCopies({ dir: a1.dir, step: v.dir1.step, count: v.dir1.count, symmetric: v.dir1.symmetric }, d2);
    return buildPattern(f as unknown as PatternFeature, copies, ctx);
  },
};

// ------------------------------------------------------------ Circular pattern

export const circularPatternDef: FeatureTypeDef<CircularPatternFeature, CircularValues> = {
  type: 'pattern_circular',
  label: 'Circular pattern',
  icon: PATTERN_ICONS.circular,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'pattern_circular',
      name: nextName('Circular pattern', doc.features.map((f) => f.name)),
      ...common(init),
      axis: null,
      flip: false,
      count: '6',
      mode: 'full',
      angle: '90 deg',
      symmetric: false,
      ...init,
    } as CircularPatternFeature;
  },
  resolve(f, units) {
    const c = countOf('Count', f.count, units);
    if (!c.ok) return c;
    let angle = 360;
    if (f.mode === 'angle') {
      const a = evalAs('Angle', f.angle, 'angle', units);
      if (!a.ok) return a;
      if (!(a.value > 0)) return { ok: false, message: 'Angle must be more than 0' };
      if (a.value > 360 + 1e-9) return { ok: false, message: 'Angle must be at most 360°' };
      angle = a.value;
    }
    const n = (f.mode === 'angle' && f.symmetric ? 2 * c.value - 1 : c.value) - 1;
    if (n > MAX_COPIES) return { ok: false, message: `That makes ${n} copies: at most ${MAX_COPIES} in one pattern` };
    return { ok: true, values: { count: c.value, angle } };
  },
  incomplete(f, units) {
    const s = sourcesIncomplete(f);
    if (s) return s;
    if (!f.axis) return 'Pick an axis: an origin or CONSTRUCT axis, a straight or round edge, a round face or a sketch line';
    const r = circularPatternDef.resolve(f, units);
    return r.ok ? null : r.message;
  },
  parents: (f) => [...new Set([...sourceParents(f), ...refParents([f.axis])])],
  uses(f) {
    const own = sourceUses(f);
    return own === 'all' ? 'all' : [...new Set([...own, ...refBodies([f.axis])])];
  },
  ownsBody: (f, id) => ownsCopy(f, id),
  exprs: (f) => [
    { path: 'count', expr: f.count },
    { path: 'angle', expr: f.angle },
  ],
  mapExprs: (f, fn) => ({ ...f, count: fn(f.count), angle: fn(f.angle) }),
  async build(f, v, ctx) {
    if (!f.axis) return { ok: false, message: `${f.name} failed: Pick an axis` };
    const a = await resolveAxis(f.axis, ctx);
    if (!a.ok) return { ok: false, message: `${f.name} failed: Axis: ${a.message}` };
    const u = unitOf(a.value.dir);
    if (!u) return { ok: false, message: `${f.name} failed: the axis has no direction` };
    const dir = (f.flip ? [-u[0], -u[1], -u[2]] : u) as [number, number, number];
    const copies = circularCopies({ origin: a.value.origin, dir, count: v.count, mode: f.mode, angle: v.angle, symmetric: f.mode === 'angle' && f.symmetric });
    // Two instances in one place would make a coincident body or cut nothing (fix round 1, B1).
    const clash = landsOn(copies);
    if (clash) return { ok: false, message: `${f.name} failed: ${clash.copy} lands on ${clash.on === 'the original' ? 'the original' : clash.on.replace(/^Instance/, 'instance')} (a whole turn from it): lower the Angle or the Count, or use Full 360°` };
    const r = await buildPattern(f as unknown as PatternFeature, copies, ctx);
    return r.ok && a.warning ? { ...r, warning: [r.warning, `Axis: ${a.warning}`].filter(Boolean).join('; ') } : r;
  },
};

// ------------------------------------------------------------ Mirror

export const mirrorDef: FeatureTypeDef<MirrorFeature, Record<string, never>> = {
  type: 'mirror',
  label: 'Mirror',
  icon: PATTERN_ICONS.mirror,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'mirror',
      name: nextName('Mirror', doc.features.map((f) => f.name)),
      ...common(init),
      plane: null,
      ...init,
    } as MirrorFeature;
  },
  resolve: (): ResolveResult<Record<string, never>> => ({ ok: true, values: {} }),
  incomplete(f) {
    const s = sourcesIncomplete(f);
    if (s) return s;
    return f.plane ? null : 'Pick the mirror plane: an origin plane, a CONSTRUCT plane or a flat face';
  },
  parents: (f) => [...new Set([...sourceParents(f), ...refParents([f.plane])])],
  uses(f) {
    const own = sourceUses(f);
    return own === 'all' ? 'all' : [...new Set([...own, ...refBodies([f.plane])])];
  },
  ownsBody: (f, id) => ownsCopy(f, id),
  exprs: () => [],
  mapExprs: (f) => f,
  async build(f, _v, ctx) {
    if (!f.plane) return { ok: false, message: `${f.name} failed: Pick the mirror plane` };
    const p = await resolvePlane(f.plane, ctx);
    if (!p.ok) return { ok: false, message: `${f.name} failed: Mirror plane: ${p.message}` };
    const r = await buildPattern(f as unknown as PatternFeature, mirrorCopies(p.value.origin, p.value.normal), ctx);
    return r.ok && p.warning ? { ...r, warning: [r.warning, `Mirror plane: ${p.warning}`].filter(Boolean).join('; ') } : r;
  },
};

export const PATTERN_DEFS = [linearPatternDef, circularPatternDef, mirrorDef] as unknown as FeatureTypeDef<Feature>[];
export type PatternType = 'pattern_linear' | 'pattern_circular' | 'mirror';
export const PATTERN_TYPES: readonly PatternType[] = ['pattern_linear', 'pattern_circular', 'mirror'];
