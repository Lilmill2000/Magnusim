// Sketch patterns (P4b): Linear pattern (1 or 2 directions: count, spacing and
// a direction angle, or along a picked line) and Circular pattern (a centre
// point, count, the full circle or a set angle). The copies are ordinary
// entities tied to their sources through the sketch's SketchTie row
// (src/sketch/tools/ties.ts), so they follow the sources, and changing the count
// or a spacing (in the tool, or later in the pattern's row of the sketch panel)
// lays them out again: missing instances are made, extra ones go.
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId } from '../../lib/ids';
import type { SketchEntity, SketchFeature, SketchTie, Vec2 } from '../../types/doc';
import type { UnitsService } from '../../types/units';
import { SketchBuilder, type EditOutcome, type SketchDraft } from '../edit';
import { entityLabel, entityOf, lineEnds, ORIGIN, pointAt } from '../model';
import { emptyPreview, storeExpr, type SketchMode, type SketchTool } from '../mode';
import { hitTest, samples } from '../pick';
import { copyEntities } from './copy';
import type { ToolOption } from './options';
import { circularStep, evaluateTies, linearShift } from './ties';

/** The most copies one pattern makes. */
export const MAX_INSTANCES = 400;

type Draft = SketchDraft & { ties?: SketchTie[] };

/** Every instance a tie wants now, sources excluded: [i, k]. */
export function instancesOf(t: Pick<SketchTie, 'kind' | 'count' | 'skip'>): [number, number][] {
  const out: [number, number][] = [];
  if (t.kind === 'linear') {
    for (let k = 0; k < Math.max(1, t.count[1]); k++) for (let i = 0; i < Math.max(1, t.count[0]); i++) if (i || k) out.push([i, k]);
  } else if (t.kind === 'circular') {
    for (let i = 1; i < t.count[0]; i++) out.push([i, 0]);
  }
  // fix1 B5: instances the user deleted stay deleted.
  const skip = new Set((t.skip ?? []).map((s) => `${s[0]},${s[1]}`));
  return out.filter((a) => !skip.has(`${a[0]},${a[1]}`));
}

/** The skipped instances that are still within the counts (what the row reports). */
export function skippedOf(t: Pick<SketchTie, 'kind' | 'count' | 'skip'>): [number, number][] {
  const all = instancesOf({ ...t, skip: [] }).map((a) => `${a[0]},${a[1]}`);
  return (t.skip ?? []).filter((s) => all.includes(`${s[0]},${s[1]}`));
}

/** Where a source point goes in instance `at` (null when the tie's values cannot say). */
export function placer(d: Pick<SketchFeature, 'points' | 'entities'>, t: SketchTie, at: [number, number], values: Readonly<Record<string, number>>): ((p: Vec2) => Vec2) | null {
  if (t.kind === 'linear') {
    const along = t.along ?? [null, null];
    if (!along[0] && !along[1]) {
      const s = linearShift(t, at, values);
      return s ? (p) => [p[0] + s[0], p[1] + s[1]] : null;
    }
    const shift: Vec2 = [0, 0];
    for (const k of [0, 1] as const) {
      if (!at[k]) continue;
      const sv = values[`${t.id}:spacing${k + 1}`];
      if (sv == null) return null;
      const line = along[k];
      let dir: Vec2;
      if (line) {
        const ends = lineEnds(d, line);
        if (!ends) return null;
        const l = Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]);
        if (!(l > 0)) return null;
        dir = [(ends[1][0] - ends[0][0]) / l, (ends[1][1] - ends[0][1]) / l];
      } else {
        const a = values[`${t.id}:angle${k + 1}`];
        if (a == null) return null;
        dir = [Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180)];
      }
      shift[0] += at[k] * sv * dir[0];
      shift[1] += at[k] * sv * dir[1];
    }
    return (p) => [p[0] + shift[0], p[1] + shift[1]];
  }
  if (t.kind === 'circular') {
    const step = circularStep(t, values);
    const c = t.centre ? pointAt(d, t.centre) : null;
    if (step == null || !c) return null;
    const a = (at[0] * step * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    return (p) => [c[0] + ca * (p[0] - c[0]) - sa * (p[1] - c[1]), c[1] + sa * (p[0] - c[0]) + ca * (p[1] - c[1])];
  }
  return null;
}

/** Make the instances a tie wants and remove the ones it no longer does (count changed). */
export function layOut(b: SketchBuilder, tie: SketchTie, values: Readonly<Record<string, number>>): SketchTie | string {
  const want = instancesOf(tie);
  if (want.length + 1 > MAX_INSTANCES) return `a pattern makes ${MAX_INSTANCES} instances at most`;
  const key = (at: [number, number]) => `${at[0]},${at[1]}`;
  const wanted = new Set(want.map(key));
  const keep = tie.copies.filter((c) => wanted.has(key(c.at)));
  const drop = tie.copies.filter((c) => !wanted.has(key(c.at)));
  if (drop.length) b.remove(drop.flatMap((c) => Object.values(c.entities)));
  const have = new Set(keep.map((c) => key(c.at)));
  const sources = tie.sources.map((id) => entityOf(b, id)).filter((e): e is SketchEntity => !!e);
  if (!sources.length) return 'its source geometry is gone';
  // fix1 B1: the copies kept are moved to where the new values put them FROM THE SOURCE AS IT IS, so
  // the solve starts on a solution and nothing the user placed moves (an under-defined source used to
  // be pulled toward the old copies: a circular pattern's radius crept 30 -> 38 mm over four edits).
  for (const c of keep) {
    const place = placer(b, tie, c.at, values);
    if (!place) return 'its values do not evaluate';
    for (const [p, q] of Object.entries(c.points)) {
      const at = p === q ? null : b.point(p);
      if (at && b.points[q]) b.movePoint(q, place(at));
    }
    for (const [src, cp] of Object.entries(c.entities)) {
      const se = entityOf(b, src);
      const ce = entityOf(b, cp);
      if (se?.kind === 'circle' && ce?.kind === 'circle' && ce.r !== se.r) b.replaceEntity({ ...ce, r: se.r });
    }
  }
  const copies = [...keep];
  for (const at of want) {
    if (have.has(key(at))) continue;
    const place = placer(b, tie, at, values);
    if (!place) return 'its values do not evaluate';
    const map = copyEntities(b, sources, (_id, p) => place(p));
    copies.push({ at, ...map });
  }
  copies.sort((x, y) => x.at[1] - y.at[1] || x.at[0] - y.at[0]);
  return { ...tie, copies };
}

/** A new pattern of `sources`. */
export function createPattern(d: Draft, tie: Omit<SketchTie, 'id' | 'copies'>, units: UnitsService): EditOutcome {
  const t: SketchTie = { ...tie, id: `t${newId('c').slice(1)}`, copies: [] };
  const ev = evaluateTies({ ties: [t] }, units);
  const bad = Object.values(ev.errors)[0];
  if (bad) return { ok: false, reason: bad };
  const b = new SketchBuilder(d);
  const laid = layOut(b, t, ev.values);
  if (typeof laid === 'string') return { ok: false, reason: laid };
  const draft: Draft = { ...b.result(), ties: [...(d.ties ?? []), laid] };
  return { ok: true, draft, optional: [], removed: [] };
}

/** Change a pattern (count, values, centre): the copies follow (instances made or removed). */
export function updatePattern(d: Draft, id: string, patch: Partial<Pick<SketchTie, 'count' | 'exprs' | 'full' | 'centre' | 'along' | 'skip'>>, units: UnitsService): EditOutcome {
  const cur = d.ties?.find((t) => t.id === id);
  if (!cur) return { ok: false, reason: 'that pattern is gone' };
  const next: SketchTie = { ...cur, ...patch, exprs: { ...cur.exprs, ...(patch.exprs ?? {}) } };
  if (next.kind !== 'offset' && (next.count[0] < 1 || next.count[1] < 1 || !Number.isInteger(next.count[0]) || !Number.isInteger(next.count[1]))) return { ok: false, reason: 'a count is a whole number, 1 or more' };
  if (next.kind === 'circular' && next.count[0] < 2) return { ok: false, reason: 'a circular pattern needs 2 instances or more' };
  if (next.kind === 'linear' && next.count[0] * next.count[1] < 2) return { ok: false, reason: 'a linear pattern needs 2 instances or more' };
  const ev = evaluateTies({ ties: [next] }, units);
  const bad = Object.values(ev.errors)[0];
  if (bad) return { ok: false, reason: bad };
  const b = new SketchBuilder(d);
  const laid = next.kind === 'offset' ? next : layOut(b, next, ev.values);
  if (typeof laid === 'string') return { ok: false, reason: laid };
  const draft: Draft = { ...b.result(), ties: (d.ties ?? []).map((t) => (t.id === id ? laid : t)) };
  return { ok: true, draft, optional: [], removed: [] };
}

/** Delete a pattern or an offset with its copies (the sources stay). */
export function deleteTie(d: Draft, id: string): EditOutcome {
  const cur = d.ties?.find((t) => t.id === id);
  if (!cur) return { ok: false, reason: 'that pattern is gone' };
  const b = new SketchBuilder(d);
  b.remove(cur.copies.flatMap((c) => Object.values(c.entities)));
  const draft: Draft = { ...b.result(), ties: (d.ties ?? []).filter((t) => t.id !== id) };
  return { ok: true, draft, optional: [], removed: [] };
}

/** "Linear pattern 2", "Circular pattern 1", "Offset 1" (numbered by kind in the sketch). */
export function tieLabel(d: Draft, id: string): string {
  const t = d.ties?.find((x) => x.id === id);
  if (!t) return 'A pattern';
  const same = (d.ties ?? []).filter((x) => x.kind === t.kind);
  const word = t.kind === 'linear' ? 'Linear pattern' : t.kind === 'circular' ? 'Circular pattern' : 'Offset';
  return `${word} ${same.indexOf(t) + 1}`;
}

// ------------------------------------------------------------ the tools

export function patternTool(mode: SketchMode, kind: 'linear' | 'circular'): SketchTool {
  const units = mode.services.doc.units;
  const toolId = kind === 'linear' ? 'pattern-linear' : 'pattern-circular';
  const unitsLen = () => units.units().length;
  const lenExpr = (mm: number) => storeExpr(String(+(mm / ({ mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }[unitsLen()])).toPrecision(6)), 'length', units);
  let count: [number, number] = kind === 'linear' ? [3, 1] : [6, 1];
  let exprs: Record<string, string> = kind === 'linear' ? { spacing1: lenExpr(20), angle1: '0 deg', spacing2: lenExpr(20), angle2: '90 deg' } : { angle: '90 deg' };
  let full = true;
  let centre: string = ORIGIN;
  let along: [string | null, string | null] = [null, null];
  let picking: 'sources' | 'centre' | 'direction1' | 'direction2' = 'sources';
  const picked = () =>
    mode
      .selected()
      .filter((h) => h.what === 'entity')
      .map((h) => h.id);
  const word = kind === 'linear' ? 'linear pattern' : 'circular pattern';

  const tieNow = (): SketchTie => ({ id: '#preview', kind, sources: picked(), copies: [], count, exprs, ...(kind === 'linear' ? { along } : { centre, full }) });

  function preview() {
    const d = mode.draft();
    const p = emptyPreview();
    if (d && picked().length) {
      const t = tieNow();
      const ev = evaluateTies({ ties: [t] }, units);
      for (const at of instancesOf(t).slice(0, MAX_INSTANCES)) {
        const place = placer(d, t, at, ev.values);
        if (!place) break;
        for (const id of picked()) {
          const e = entityOf(d, id);
          if (!e) continue;
          const pts = samples(d, e, 32).map(place);
          for (let i = 1; i < pts.length; i++) p.lines.push([pts[i - 1], pts[i]]);
          if (e.kind === 'point' && pts[0]) p.points.push(pts[0]);
        }
      }
      if (kind === 'circular') {
        const c = pointAt(d, centre);
        if (c) p.points.push(c);
      }
    }
    mode.setPreview(p);
  }

  function refresh() {
    preview();
    mode.refreshHint();
  }

  function place(): boolean {
    const ids = picked();
    if (!ids.length) {
      mode.note(`Not applied: pick the entities to pattern first`);
      return false;
    }
    const t = tieNow();
    void mode.apply(kind === 'linear' ? 'Linear pattern' : 'Circular pattern', (d) => createPattern(d, { kind, sources: t.sources, count: t.count, exprs: t.exprs, ...(kind === 'linear' ? { along } : { centre, full }) }, units)).then((r) => {
      if (r.ok) {
        mode.select([], false);
        mode.setPreview(null);
        mode.refreshHint();
      }
    });
    return true;
  }

  return {
    id: toolId,
    hint: () => {
      if (picking === 'centre') return 'Click the centre point of the pattern.';
      if (picking === 'direction1' || picking === 'direction2') return 'Click the line the pattern runs along.';
      return picked().length ? `Set the ${word} in the panel, then Enter or Place pattern.` : `Pick the entities to pattern (or select them first).`;
    },
    cancel() {
      if (picking !== 'sources') {
        picking = 'sources';
        mode.refreshHint();
        return true;
      }
      mode.setPreview(null);
      return false;
    },
    commit() {
      if (!picked().length) return false;
      return place();
    },
    options(): ToolOption[] {
      const d = mode.draft();
      const n = picked().length;
      const words = d ? picked().map((id) => entityLabel(d, id)) : [];
      const out: ToolOption[] = [{ kind: 'text', id: 'picked', text: n ? `To pattern: ${words.slice(0, 4).join(', ')}${n > 4 ? ` and ${n - 4} more` : ''}` : 'Nothing picked yet' }];
      const countField = (k: 0 | 1, label: string): ToolOption => ({
        kind: 'number',
        id: k === 0 ? 'count' : 'count2',
        label,
        expr: String(count[k]),
        quantity: 'scalar',
        validate: (v) => (Number.isInteger(v) && v >= (k === 0 ? 2 : 1) && v <= MAX_INSTANCES ? null : `A whole number from ${k === 0 ? 2 : 1} to ${MAX_INSTANCES}`),
        set: (_e, v) => {
          count = k === 0 ? [v, count[1]] : [count[0], v];
          refresh();
        },
      });
      const exprField = (name: string, label: string, quantity: 'length' | 'angle'): ToolOption => ({
        kind: 'number',
        id: name,
        label,
        expr: exprs[name],
        quantity,
        validate: quantity === 'length' ? (v) => (v > 0 ? null : 'Must be more than 0') : undefined,
        set: (e) => {
          exprs = { ...exprs, [name]: e };
          refresh();
        },
      });
      if (kind === 'linear') {
        out.push(countField(0, 'Count'), exprField('spacing1', 'Spacing', 'length'));
        if (along[0]) out.push({ kind: 'button', id: 'direction1', label: `Along ${d ? entityLabel(d, along[0]) : 'a line'} (use an angle)`, run: () => ((along = [null, along[1]]), refresh()) });
        else out.push(exprField('angle1', 'Direction', 'angle'), { kind: 'button', id: 'direction1', label: 'Along a line…', run: () => ((picking = 'direction1'), mode.refreshHint()) });
        out.push({ kind: 'check', id: 'two', label: 'Second direction', value: count[1] > 1, set: (v) => ((count = [count[0], v ? 2 : 1]), refresh()) });
        if (count[1] > 1) {
          out.push(countField(1, 'Count 2'), exprField('spacing2', 'Spacing 2', 'length'));
          if (along[1]) out.push({ kind: 'button', id: 'direction2', label: `Along ${d ? entityLabel(d, along[1]) : 'a line'} (use an angle)`, run: () => ((along = [along[0], null]), refresh()) });
          else out.push(exprField('angle2', 'Direction 2', 'angle'), { kind: 'button', id: 'direction2', label: 'Along a line…', run: () => ((picking = 'direction2'), mode.refreshHint()) });
        }
      } else {
        out.push(
          { kind: 'text', id: 'centre', text: `Centre: ${centre === ORIGIN ? 'the sketch origin' : d ? pointWords(d, centre) : 'a point'}` },
          { kind: 'button', id: 'pick-centre', label: 'Pick the centre…', run: () => ((picking = 'centre'), mode.refreshHint()) },
          countField(0, 'Count'),
          { kind: 'check', id: 'full', label: 'Full circle, equal spacing', value: full, set: (v) => ((full = v), refresh()) },
        );
        if (!full) out.push(exprField('angle', 'Total angle', 'angle'));
      }
      out.push({ kind: 'button', id: 'place', label: 'Place pattern', primary: true, disabled: n ? null : 'Pick the entities to pattern first', run: () => void place() });
      return out;
    },
    pointer(e) {
      const d = mode.draft();
      if (!d) return;
      if (e.type === 'move') {
        mode.setHover(hitTest(d, e.uv, e.px, picking === 'centre' ? { entities: false } : {}));
        if (!mode.view.get().preview && picked().length) preview();
        return;
      }
      if (e.type !== 'click') return;
      const h = hitTest(d, e.uv, e.px);
      if (picking === 'centre') {
        const pid = h?.what === 'point' ? h.id : h?.what === 'entity' && entityOf(d, h.id)?.kind === 'point' ? (entityOf(d, h.id) as Extract<SketchEntity, { kind: 'point' }>).p : null;
        if (!pid) {
          mode.note('Click a point (an end, a centre, the origin) for the centre');
          return;
        }
        centre = pid;
        picking = 'sources';
        mode.note(null);
        refresh();
        return;
      }
      if (picking === 'direction1' || picking === 'direction2') {
        const line = h?.what === 'entity' && entityOf(d, h.id)?.kind === 'line' ? h.id : null;
        if (!line) {
          mode.note('Click a line for the direction');
          return;
        }
        along = picking === 'direction1' ? [line, along[1]] : [along[0], line];
        picking = 'sources';
        mode.note(null);
        refresh();
        return;
      }
      if (h && h.what === 'entity') mode.select([h], true);
      refresh();
    },
    dispose() {
      mode.setPreview(null);
    },
  };
}

function pointWords(d: SketchFeature, id: string): string {
  const owner = d.entities.find((e) => (e.kind === 'circle' || e.kind === 'arc') && e.c === id);
  if (owner) return `the centre of ${entityLabel(d, owner.id)}`;
  const pe = d.entities.find((e) => e.kind === 'point' && e.p === id);
  if (pe) return entityLabel(d, pe.id);
  const end = d.entities.find((e) => (e.kind === 'line' && e.p.includes(id)) || (e.kind === 'arc' && (e.a === id || e.b === id)));
  return end ? `an end of ${entityLabel(d, end.id)}` : 'a point';
}
