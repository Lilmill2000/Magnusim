// Sketch copy and paste, pure (the person's Ctrl+C / Ctrl+V in src/sketch/tools/paste.ts and the
// Assistant's copy row in src/assistant/sketch/ops.ts run these): clipOf takes the picked entities
// with their points (construction and centerline kept) and the relations and dimensions whose every
// reference is among them; those that also tie something not copied are counted, never taken.
// pasteClip makes new geometry of it (copyEntities, src/sketch/tools/copy.ts) moved so that the
// copy's anchor, the middle of its box, lands on the place given, in the target sketch's own u/v
// (a sketch on another plane takes the same 2D shape), and re-makes the relations and dimensions
// on the copies: a dimension keeps its expression where the target reads it (in a Part of the
// same units, as written: a parameter keeps its link; in a Part of other units only where it reads
// as the value the dimension had: a bare "2*15" copied in mm would read 762 mm in inches), else it
// takes that value in mm or deg; its label moves with it, a Fix holds the copy where it lands.
// Owner: SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchConstraint, SketchEntity, SketchFeature, Vec2 } from '../../types/doc';
import type { DocUnits } from '../../types/units';
import { SketchBuilder, type EditOutcome, type SketchDraft } from '../edit';
import { entityPoints, isDimension, measureDimension, pointAt, quantityOf } from '../model';
import { samples } from '../pick';
import { copyEntities, type CopyMap } from './copy';

/** What Copy holds: plain data (a page keeps it, the plugin's prefs carry it to another Part). */
export interface SketchClip {
  v: 1;
  /** The sketch it was copied from (its name). */
  from: string;
  /** The points its entities use, where they were (mm, the source sketch's u/v; the origin as "origin"). */
  points: Record<string, Vec2>;
  entities: SketchEntity[];
  /** The relations and dimensions whose every reference is copied. */
  constraints: SketchConstraint[];
  /** Each copied dimension's value when copied (mm or deg): a paste whose target cannot read its expression uses it. */
  values: Record<string, number>;
  /** Relations and dimensions of the copied geometry that also tie something not copied: left out. */
  outside: { relations: number; dimensions: number };
  /** Where the copy is held while it is placed: the middle of its box (mm, source u/v). */
  anchor: Vec2;
  /** The source Part's units (a bare number in an expression is in its length unit); left out by an older copy. */
  units?: { length: string; angle: string };
}

type Source = Pick<SketchFeature, 'points' | 'entities' | 'constraints'> & Partial<Pick<SketchFeature, 'name' | 'solved'>>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The clip of these entities (a picked point that a point entity stands on counts as that point
 * entity; other picks are ignored), or why there is none.
 */
export function clipOf(d: Source, ids: readonly string[], units?: Pick<DocUnits, 'length' | 'angle'>): SketchClip | string {
  const want = new Set(ids);
  for (const e of d.entities) if (e.kind === 'point' && want.has(e.p)) want.add(e.id);
  const entities = d.entities.filter((e) => want.has(e.id));
  if (!entities.length) return 'select sketch geometry first: lines, arcs, circles, splines or points';
  const own = new Set(entities.map((e) => e.id));
  const used = new Set<string>();
  for (const e of entities) for (const p of entityPoints(e)) used.add(p);
  const points: Record<string, Vec2> = {};
  for (const p of used) {
    const at = pointAt(d, p);
    if (at) points[p] = [at[0], at[1]];
  }
  const inside = (r: string) => own.has(r) || used.has(r);
  const constraints: SketchConstraint[] = [];
  const values: Record<string, number> = {};
  const outside = { relations: 0, dimensions: 0 };
  for (const c of d.constraints) {
    if (!c.refs.some(inside)) continue;
    if (!c.refs.every(inside)) {
      if (isDimension(c)) outside.dimensions++;
      else outside.relations++;
      continue;
    }
    constraints.push(JSON.parse(JSON.stringify(c)) as SketchConstraint);
    if (isDimension(c)) {
      const v = c.driving ? d.solved?.values?.[c.id] : undefined;
      const m = v ?? measureDimension(d, c);
      if (m != null && Number.isFinite(m)) values[c.id] = m;
    }
  }
  const copied = entities.map((e) => JSON.parse(JSON.stringify(e)) as SketchEntity);
  return { v: 1, from: d.name ?? 'a sketch', points, entities: copied, constraints, values, outside, anchor: boxMiddle({ points, entities: copied }), ...(units ? { units: { length: units.length, angle: units.angle } } : {}) };
}

/** The middle of the box round the drawn geometry. */
function boxMiddle(f: Pick<SketchFeature, 'points' | 'entities'>): Vec2 {
  let lo: Vec2 = [Infinity, Infinity];
  let hi: Vec2 = [-Infinity, -Infinity];
  for (const e of f.entities)
    for (const p of samples(f, e, 32)) {
      lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
      hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
    }
  return Number.isFinite(lo[0]) ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2] : [0, 0];
}

/** The clip drawn where it was copied: its curves in pieces, and its point entities. */
export function clipSegments(clip: SketchClip): { lines: [Vec2, Vec2][]; points: Vec2[] } {
  const f = { points: clip.points, entities: clip.entities };
  const lines: [Vec2, Vec2][] = [];
  const points: Vec2[] = [];
  for (const e of clip.entities) {
    const s = samples(f, e, 48);
    if (e.kind === 'point') {
      if (s[0]) points.push(s[0]);
      continue;
    }
    for (let i = 1; i < s.length; i++) lines.push([s[i - 1], s[i]]);
  }
  return { lines, points };
}

export interface PasteResult {
  outcome: EditOutcome;
  /** The new entities, in the clip's order. */
  added: string[];
  /** Source entity and point ids -> the copies'. */
  map: CopyMap;
  /** The relations and dimensions made on the copies. */
  kept: { relations: number; dimensions: number };
  /** The dimensions whose expression the target reads otherwise: they took the value they had (their exprs as copied). */
  valued: string[];
}

/**
 * The clip pasted into a sketch as new geometry, its anchor on `at` (mm, the target's u/v).
 * `evaluate`: what the target reads a dimension's expression as (mm or deg), or null when it
 * cannot (a parameter of another Part may not be there); `units`: the target Part's. A dimension
 * keeps its expression where the target reads it and its units are the clip's (a parameter keeps
 * its link); in other units (or a copy that does not say its own) only where it reads as the value
 * the dimension had (a unitless "2*15" is 30 mm in a mm Part, 762 mm in an inch Part); else it
 * takes that value.
 */
export function pasteClip(d: SketchDraft, clip: SketchClip, at: Vec2, o: { evaluate?: (expr: string, q: 'length' | 'angle') => number | null; units?: Pick<DocUnits, 'length' | 'angle'> } = {}): PasteResult {
  const dx = at[0] - clip.anchor[0];
  const dy = at[1] - clip.anchor[1];
  const shift = (p: Vec2): Vec2 => [p[0] + dx, p[1] + dy];
  const b = new SketchBuilder(d);
  const map = copyEntities(b, clip.entities, (_id, p) => shift(p), { at: (id) => clip.points[id] ?? null });
  const kept = { relations: 0, dimensions: 0 };
  const valued: string[] = [];
  const ref = (r: string) => map.entities[r] ?? map.points[r] ?? null;
  for (const c of clip.constraints) {
    const refs = c.refs.map(ref);
    if (refs.some((r) => !r)) continue;
    if (isDimension(c)) {
      const q = quantityOf(c.kind);
      const v = clip.values[c.id];
      const here = o.evaluate ? o.evaluate(c.expr, q) : null;
      const sameUnits = !!clip.units && !!o.units && clip.units.length === o.units.length && clip.units.angle === o.units.angle;
      const keep = !o.evaluate || v == null || (here != null && (sameUnits || Math.abs(here - v) <= 1e-6 * Math.max(1, Math.abs(v))));
      const expr = keep ? c.expr : `${Number(v.toPrecision(6))} ${q === 'angle' ? 'deg' : 'mm'}`;
      if (expr !== c.expr) valued.push(c.expr);
      b.addDimension(c.kind, refs as string[], expr, { driving: c.driving, ...(c.at ? { at: shift(c.at) } : {}) });
      kept.dimensions++;
    } else {
      b.addRelation(c.kind, refs as string[], { ...(c.inferred ? { inferred: true } : {}), ...(c.value ? { value: shift(c.value) } : {}) });
      kept.relations++;
    }
  }
  const added = clip.entities.map((e) => map.entities[e.id]);
  return { outcome: { ok: true, draft: b.result(), optional: [], removed: [] }, added, map, kept, valued };
}

/** "1 dimension took the value it had (its expression 2*15 reads otherwise here)" (null when none did). */
export function valuedWords(exprs: readonly string[]): string | null {
  if (!exprs.length) return null;
  const list = exprs.slice(0, 3).map((e) => `"${e}"`).join(', ') + (exprs.length > 3 ? ', ...' : '');
  return `${plural(exprs.length, 'dimension')} took the value ${exprs.length === 1 ? 'it' : 'they'} had (${exprs.length === 1 ? 'its expression' : 'their expressions'} ${list} ${exprs.length === 1 ? 'reads' : 'read'} otherwise here)`;
}

/** "2 relations to other geometry were left out" (null when none were). */
export function leftOutWords(o: { relations: number; dimensions: number }): string | null {
  const parts = [o.relations ? plural(o.relations, 'relation') : '', o.dimensions ? plural(o.dimensions, 'dimension') : ''].filter(Boolean);
  if (!parts.length) return null;
  return `${parts.join(' and ')} to other geometry ${o.relations + o.dimensions === 1 ? 'was' : 'were'} left out`;
}

const KIND_WORDS: Record<SketchEntity['kind'], [string, string]> = {
  point: ['point', 'points'],
  line: ['line', 'lines'],
  circle: ['circle', 'circles'],
  arc: ['arc', 'arcs'],
  spline: ['spline', 'splines'],
  ellipse: ['ellipse', 'ellipses'],
  ellipse_arc: ['partial ellipse', 'partial ellipses'],
  parabola: ['parabola', 'parabolas'],
  conic: ['conic', 'conics'],
};

/** What a clip holds: "4 lines, 4 relations and 1 dimension". */
export function clipWords(clip: Pick<SketchClip, 'entities' | 'constraints'>): string {
  const n = new Map<SketchEntity['kind'], number>();
  for (const e of clip.entities) n.set(e.kind, (n.get(e.kind) ?? 0) + 1);
  const parts = [...n].map(([k, c]) => (c === 1 ? `1 ${KIND_WORDS[k][0]}` : `${c} ${KIND_WORDS[k][1]}`));
  const dims = clip.constraints.filter(isDimension).length;
  const rels = clip.constraints.length - dims;
  if (rels) parts.push(plural(rels, 'relation'));
  if (dims) parts.push(plural(dims, 'dimension'));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? 'nothing';
}

/** A clip read back (the plugin's prefs: another Part's Copy), or null when it is not one. */
export function readClip(v: unknown): SketchClip | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Partial<SketchClip>;
  const vec = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (c.v !== 1 || typeof c.from !== 'string' || !vec(c.anchor) || !c.points || typeof c.points !== 'object') return null;
  if (!Array.isArray(c.entities) || !c.entities.length || !Array.isArray(c.constraints) || !c.values || typeof c.values !== 'object') return null;
  if (!c.outside || typeof c.outside.relations !== 'number' || typeof c.outside.dimensions !== 'number') return null;
  if (c.units !== undefined && (!c.units || typeof c.units.length !== 'string' || typeof c.units.angle !== 'string')) return null;
  if (!Object.values(c.points).every(vec)) return null;
  // Every point an entity uses is in the clip, every reference of a relation is copied.
  const ids = new Set<string>();
  for (const e of c.entities) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !(e.kind in KIND_WORDS)) return null;
    ids.add(e.id);
    for (const p of entityPoints(e)) {
      if (!c.points[p]) return null;
      ids.add(p);
    }
  }
  for (const x of c.constraints) if (!x || !Array.isArray(x.refs) || !x.refs.every((r) => ids.has(r))) return null;
  return c as SketchClip;
}
