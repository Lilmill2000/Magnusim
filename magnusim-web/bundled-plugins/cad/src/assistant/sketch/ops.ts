// The person's sketch tools as rows of the sketch tool (help sketch_tools), run in row order on the
// sketch as the rows before them left it, solved first (the person draws, dimensions, then trims or
// fillets what the solver placed), through the person's own functions, so what is stored is what
// the person's tool stores:
//   trim [curve, at(u, v)]          trimAt: the piece around the place goes to the nearest crossings
//   extend [curve, at(u, v)]        extendAt: the end nearest the place runs to the next curve
//   fillet [corner] or [c1, c2]     filletCorner, value the radius (its Radius dimension is driving)
//   chamfer [corner] or [l1, l2]    chamferCorner, value "d" (equal) or "d1; d2"
//   mirror [axis, items...]         mirrorEntities: copies kept symmetric (Symmetric relations)
//   offset [curve, at(u, v)?]       offsetChain: the curve's chain, to the place's side or both
//                                   sides without one, value the distance; follows its source (a tie)
//   linear_pattern [items...]       createPattern, value "count 4; spacing 10 mm; angle 0 deg" and
//                                   a second direction "count2 2; spacing2 8 mm; angle2 90 deg";
//                                   "along <line>" / "along2 <line>" run along a line instead
//   circular_pattern [centre, items...]  value "count 6" (the full circle, equal spacing) or
//                                   "count 4; angle 90 deg" (the total angle)
//   project [selector]              a face, an edge or a vertex of a body (fixed, linked curves), or
//                                   a body: its silhouette along the sketch normal (readLink)
//   intersect [body]                where the sketch plane cuts the body (linked)
//   break_link [curves or a link]   breakLinks: ordinary geometry where it is
//   import [attachment id]          a drawing the person attached (SVG, DXF; the host's
//                                   call.readAttachment), read and added as the person's Import
//                                   SVG/DXF adds it (sketch/import: importIntoDraft), value
//                                   "scale <mm per unit>; place origin|centre; layers <a>, <b>";
//                                   its curves are "<id>.1", "<id>.2"... and `made` gives the
//                                   summary the person's panel shows
//   copy [items..., at(u, v)?]      the person's Copy and Paste (sketch/tools/clip.ts clipOf,
//                                   pasteClip): new geometry, the relations and dimensions between
//                                   the items made again on the copies, those to anything else left
//                                   out and counted; value "from <sketch>" copies another sketch's
//                                   items (its names as get_model gives them), "from clipboard" pastes
//                                   what the person copied (Ctrl+C, any Part: paste.ts heldClip; refs
//                                   [] or "all"), "offset <du>, <dv>" moves it; at(u, v) puts the
//                                   middle of its box there; neither: where it was. Copies are
//                                   "<id>.<item>" ("<id>.1", "<id>.2"... from the clipboard)
// Ties and links keep the row's id, so they stay the model's rows: a replace that sends a row with
// the id of one the sketch has keeps it, its copies or curves with their ids (a pattern's or an
// offset's new values lay it out again: updatePattern); left out, it goes with its copies. Their
// copies and curves are named as names.ts says. The one-shot tools' new geometry takes the person's
// ids; the row's id names it in later rows of the call (the fillet's arc "f1", its corner
// "f1.corner"; a mirror's copies "m1.<item>") and `made` lists the ids it keeps.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { kernelLookup, refOfEdge, refOfFace, refOfVertex } from '../../naming';
import { extendAt, trimAt, type EditOutcome } from '../../sketch/edit';
import { entityOf, entityPoints, evaluateDimensions, isDimension, pointIdOf, withSolved } from '../../sketch/model';
import { applyLinkCurves, breakLinks, linkedRefusal, prunedLinks } from '../../sketch/project/curves';
import { readLink, sourceWords, type LinkEnv } from '../../sketch/project/source';
import { chamferCorner, filletCorner, sharedCorner } from '../../sketch/tools/fillet';
import { mirrorEntities } from '../../sketch/tools/mirror';
import { chainOf, offsetChain, sideOf } from '../../sketch/tools/offset';
import { createPattern, updatePattern } from '../../sketch/tools/pattern';
import { DrawingRefused, importIntoDraft, planImport, summaryWords, tryReadDrawing, type ImportOptions } from '../../sketch/import';
import { promoteTies, prunedTies } from '../../sketch/tools/ties';
import { clipOf, clipWords, leftOutWords, pasteClip, valuedWords, type SketchClip } from '../../sketch/tools/clip';
import { evaluatedIn, heldClip } from '../../sketch/tools/paste';
import type { CallCtx } from '../../types/assistant';
import type { PlaneFrame, SketchFeature, SketchLink, SketchLinkSource, SketchTie } from '../../types/doc';
import { ToolError } from '../errors';
import { featureByName } from '../model';
import { selectAny, withScene, type SceneOptions } from '../selectors/resolve';
import { describeSketch } from './describe';
import { placeOf, storeExpr, type ConstraintIn, type MadeRow, type SketchCompiler, type SketchGeometry, type ToolHost } from './compile';
import { linkEntityNames, tieCopyNames } from './names';
import { solverReady } from './solve';

type Pick2 = Pick<CallCtx, 'services' | 'key' | 'signal' | 'progress'> & Partial<Pick<CallCtx, 'call'>>;

/** The keys a pattern's value takes. */
const LINEAR_KEYS = ['count', 'spacing', 'angle', 'along', 'count2', 'spacing2', 'angle2', 'along2'] as const;
const CIRCULAR_KEYS = ['count', 'angle'] as const;
const IMPORT_KEYS = ['scale', 'place', 'layers'] as const;
const COPY_KEYS = ['from', 'offset'] as const;
/** "40, 0" or "40 mm, -12.5 mm": an offset in mm. */
const OFFSET = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(?:mm)?\s*,\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(?:mm)?\s*$/i;
/** An attachment id as the host gives one. */
const ATTACHMENT_ID = /^att-[0-9a-f]{16}$/;
/** What to do when the host cannot hand over an attached drawing (each reason's own hint would send the model elsewhere). */
export const ATTACHMENT_HINTS = {
  not_found: "Ask the person to attach the drawing again in the Assistant panel: only this conversation's attachments can be read (none over MCP), and get_model does not list them.",
  not_allowed: 'This call may not read the file: do not send it again; tell the person, who can bring the drawing in with Import SVG/DXF in the sketch.',
  failed: 'The read did not complete: send the same row again once; if it fails again, tell the person.',
} as const;

/** "count 4; spacing 10 mm" as keys and values (every problem named). */
export function parseValues(text: string, keys: readonly string[]): { values: Record<string, string> } | { problem: string } {
  const values: Record<string, string> = {};
  for (const part of text.split(';').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z0-9]+)\s+(.+)$/i.exec(part);
    if (!m) return { problem: `"${part}" is not "<key> <value>" (${keys.join(', ')})` };
    const key = m[1].toLowerCase();
    if (!keys.includes(key)) return { problem: `"${m[1]}" is not one of ${keys.join(', ')}` };
    if (values[key] != null) return { problem: `${key} is given twice` };
    values[key] = m[2].trim();
  }
  return { values };
}

/** A count: a whole number, 1 or more. */
const countOf = (text: string | undefined, dflt: number): number | null => {
  if (text == null) return dflt;
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 ? n : null;
};

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Run the person's sketch tools for one sketch call. */
export function toolHost(ctx: Pick2, o: { frame: PlaneFrame; scene: SceneOptions }): ToolHost {
  const { services } = ctx;
  const units = services.doc.units;

  return {
    async run(c: SketchCompiler, row: ConstraintIn, i: number): Promise<void> {
      const kind = String(row.kind);
      const at = `constraints[${i}]`;
      const fail = (why: string, reason: 'bad_input' | 'bad_ref' | 'expr_error' = 'bad_input'): never => {
        throw new ToolError(reason, `${at} (${row.id}, ${kind}): ${why}.`, { detail: { field: at, row: row.id } });
      };
      const refsAll = (Array.isArray(row.refs) ? row.refs.map(String) : []).map((s) => s.trim());
      const placesIn = refsAll.filter((r) => /^at\s*\(/.test(r));
      const refs = refsAll.filter((r) => !/^at\s*\(/.test(r));
      const places = placesIn.map((p) => placeOf(p) ?? fail(`"${p}" is not a place: write at(u, v) in mm`, 'bad_ref'));
      const value = typeof row.value === 'string' ? row.value.trim() : '';
      const one = (r: string, j = 0): string => {
        const x = c.resolve(r);
        if ('problem' in x) fail(`refs[${refsAll.indexOf(r) >= 0 ? refsAll.indexOf(r) : j}]: ${x.problem}`, 'bad_ref');
        return (x as { id: string }).id;
      };
      const curve = (r: string): string => {
        const id = one(r);
        const e = entityOf(c.g, id);
        if (!e || e.kind === 'point') fail(`${r} is not a curve`, 'bad_ref');
        return id;
      };
      const items = (list: readonly string[]): string[] => {
        const out: string[] = [];
        for (const r of list) {
          const x = c.resolveItems(r);
          if ('problem' in x) fail(`refs[${refsAll.indexOf(r)}]: ${x.problem}`, 'bad_ref');
          for (const id of (x as { ids: string[] }).ids) if (!out.includes(id)) out.push(id);
        }
        if (!out.length) fail('name what it works on', 'bad_ref');
        return out;
      };
      const noValue = () => {
        if (value) fail(`its value is "", not "${value}"`);
      };
      const length = (text: string, what: string): { expr: string; mm: number } => {
        const expr = storeExpr(text, 'length', units);
        const r = units.evaluate(expr, 'length');
        if (!r.ok) fail(`${what} "${text}": ${r.error}`, 'expr_error');
        const mm = (r as { value: number }).value;
        if (!(mm > 0)) fail(`${what} must be more than 0`);
        return { expr, mm };
      };
      const ensureNew = (list: readonly { id: string }[] | undefined, what: string) => {
        if ((list ?? []).some((x) => x.id === row.id)) fail(`the sketch has a ${what} called ${row.id} already: give another id`, 'bad_ref');
      };

      /** The sketch after one of the person's edits (as sketch mode stores one: patterns promoted, ties and links pruned). */
      const take = (out: EditOutcome): SketchGeometry => {
        if (!out.ok) fail(out.reason.replace(/\.$/, ''));
        const ok = out as Extract<EditOutcome, { ok: true }>;
        const before = c.g;
        const draft = { ...before, ...ok.draft } as SketchGeometry;
        const promoted = promoteTies(before, draft).draft;
        const next: SketchGeometry = { ...promoted, ties: prunedTies(promoted), links: prunedLinks(promoted) };
        c.set(next);
        for (const id of ok.optional) if (!c.optional.includes(id)) c.optional.push(id);
        return next;
      };
      const newEntities = (before: SketchGeometry, after: SketchGeometry) => {
        const had = new Set(before.entities.map((e) => e.id));
        return after.entities.filter((e) => !had.has(e.id));
      };
      const newDimensions = (before: SketchGeometry, after: SketchGeometry) => {
        const had = new Set(before.constraints.map((x) => x.id));
        return after.constraints.filter((x) => !had.has(x.id) && isDimension(x)).map((x) => x.id);
      };
      const record = (m: MadeRow) => c.made.push(m);

      // ---- the sketch solved as the rows so far define it (the person's tools act on solved geometry)
      const settle = async () => {
        const ev = evaluateDimensions(c.g, units);
        if (Object.keys(ev.errors).length) return;
        const solver = await solverReady(ctx);
        try {
          const r = await solver.solveFeature(c.g as unknown as SketchFeature, ev.values);
          if (r.solved) c.set(withSolved(c.g, r.values));
        } catch {
          /* the final solve says what is wrong */
        }
      };

      /** A tie or a link the edited sketch has under this id, kept: its copies or curves with their ids. */
      const carry = (owned: readonly string[]) => {
        const st = c.stored!;
        const have = new Set(c.g.entities.map((e) => e.id));
        const points = { ...c.g.points };
        const entities = [...c.g.entities];
        for (const id of owned) {
          const e = st.entities.find((x) => x.id === id);
          if (!e || have.has(id)) continue;
          entities.push(e);
          for (const p of entityPoints(e)) if (!points[p] && st.points[p]) points[p] = [st.points[p][0], st.points[p][1]];
        }
        return { points, entities };
      };
      const nameTie = (t: SketchTie) => {
        for (const [copy, name] of tieCopyNames(t, c.refOf)) c.aliasOf(name, copy, true);
      };
      const tieRow = (t: SketchTie): MadeRow => {
        const names = [...tieCopyNames(t, c.refOf).values()];
        const values: Record<string, string | number> = t.kind === 'offset' ? { distance: t.exprs.distance } : t.kind === 'circular' ? { count: t.count[0], ...(t.full ? {} : { angle: t.exprs.angle }) } : { count: t.count[0], spacing: t.exprs.spacing1, ...(t.count[1] > 1 ? { count2: t.count[1], spacing2: t.exprs.spacing2 } : {}) };
        return { id: t.id, kind, entities: names.slice(0, 60), values };
      };

      /** A new tie from the person's edit, under the row's id. */
      const newTie = (out: EditOutcome) => {
        const before = c.g;
        const next = take(out);
        const made = (next.ties ?? []).find((t) => !(before.ties ?? []).some((b) => b.id === t.id));
        if (!made) fail('it made nothing');
        const tie = { ...made!, id: row.id };
        c.set({ ...next, ties: (next.ties ?? []).map((t) => (t === made ? tie : t)) });
        nameTie(tie);
        record(tieRow(tie));
      };

      /** A kept tie: its copies come back as they are, then the row's values lay it out again. */
      const keptTie = (old: SketchTie, patch: Partial<Pick<SketchTie, 'count' | 'exprs' | 'full' | 'centre' | 'along'>>) => {
        const owned = old.copies.flatMap((x) => Object.values(x.entities));
        const { points, entities } = carry(owned);
        c.set({ ...c.g, points, entities, ties: [...(c.g.ties ?? []).filter((t) => t.id !== old.id), old] });
        const changed = Object.keys(patch).some((k) => JSON.stringify((old as unknown as Record<string, unknown>)[k]) !== JSON.stringify((patch as Record<string, unknown>)[k]));
        if (changed) take(updatePattern(c.g, old.id, patch, units));
        const tie = (c.g.ties ?? []).find((t) => t.id === old.id)!;
        nameTie(tie);
        record(tieRow(tie));
      };

      const storedTie = (k: SketchTie['kind']) => {
        const old = c.stored?.ties?.find((t) => t.id === row.id) ?? null;
        if (old && old.kind !== k) fail(`${row.id} is the sketch's ${old.kind === 'offset' ? 'offset' : `${old.kind} pattern`}: give this row another id, or its own kind`, 'bad_ref');
        return old;
      };

      switch (kind) {
        case 'trim':
        case 'extend': {
          noValue();
          if (refs.length !== 1 || places.length !== 1) fail(`${kind} takes one curve and the place at(u, v) ${kind === 'trim' ? 'on the piece to cut away' : 'near the end to extend'}`, 'bad_ref');
          await settle();
          const id = curve(refs[0]);
          const why = linkedRefusal(c.g, id, c.refOf(id));
          if (why) fail(why);
          const before = c.g;
          const after = take(kind === 'trim' ? trimAt(c.g, id, places[0]) : extendAt(c.g, id, places[0]));
          record({ id: row.id, kind, entities: newEntities(before, after).map((e) => e.id) });
          return;
        }
        case 'fillet':
        case 'chamfer': {
          if (places.length) fail(`${kind} takes no at(u, v)`, 'bad_ref');
          if (refs.length < 1 || refs.length > 2) fail(`${kind} takes the corner point, or the two curves that meet there`, 'bad_ref');
          await settle();
          let corner: string;
          if (refs.length === 1) {
            const p = pointIdOf(c.g, one(refs[0]));
            if (!p) fail(`${refs[0]} is not a point: name the corner, or the two curves`, 'bad_ref');
            corner = p!;
          } else {
            const shared = sharedCorner(c.g, curve(refs[0]), curve(refs[1]));
            if (!shared) fail(`${refs[0]} and ${refs[1]} share no corner: join them first`, 'bad_ref');
            corner = shared!;
          }
          if (!value) fail(kind === 'fillet' ? 'its value is the radius ("3 mm")' : 'its value is the distance ("2 mm"), or two ("2 mm; 3 mm")');
          const before = c.g;
          let after: SketchGeometry;
          if (kind === 'fillet') {
            const r = length(value, 'the radius');
            after = take(filletCorner(c.g, corner, r.mm, r.expr));
          } else {
            const parts = value.split(';').map((s) => s.trim()).filter(Boolean);
            if (parts.length > 2) fail('its value is one distance, or two ("2 mm; 3 mm")');
            const d1 = length(parts[0], 'the distance');
            const d2 = parts[1] ? length(parts[1], 'the second distance') : d1;
            after = take(chamferCorner(c.g, corner, d1.mm, d2.mm, [d1.expr, d2.expr], parts.length === 1));
          }
          const made = newEntities(before, after);
          const main = made.find((e) => (kind === 'fillet' ? e.kind === 'arc' : e.kind === 'line' && !e.construction));
          if (main) c.aliasOf(row.id, main.id);
          const cp = made.find((e) => e.kind === 'point');
          if (cp) c.aliasOf(`${row.id}.corner`, cp.id);
          record({ id: row.id, kind, entities: made.map((e) => e.id), dimensions: newDimensions(before, after) });
          return;
        }
        case 'mirror': {
          noValue();
          if (places.length) fail('mirror takes no at(u, v)', 'bad_ref');
          if (refs.length < 2) fail('mirror takes the axis line first, then what it copies', 'bad_ref');
          await settle();
          const axis = curve(refs[0]);
          if (entityOf(c.g, axis)?.kind !== 'line') fail(`${refs[0]} is not a line: the axis is a line or a centerline`, 'bad_ref');
          const ids = items(refs.slice(1));
          const before = c.g;
          const after = take(mirrorEntities(c.g, ids, axis));
          // Each copy by its source: the Symmetric relations pair their points (a point on the axis is shared).
          const back = new Map<string, string>();
          const had = new Set(before.constraints.map((x) => x.id));
          for (const x of after.constraints) if (!had.has(x.id) && x.kind === 'symmetric') back.set(x.refs[1], x.refs[0]);
          const made = newEntities(before, after);
          for (const e of made) {
            const pts = entityPoints(e).map((p) => back.get(p) ?? p);
            const src = ids.map((id) => entityOf(before, id)).find((s) => s && s.kind === e.kind && JSON.stringify(entityPoints(s)) === JSON.stringify(pts));
            if (src) c.aliasOf(`${row.id}.${c.refOf(src.id)}`, e.id);
          }
          record({ id: row.id, kind, entities: made.map((e) => e.id) });
          return;
        }
        case 'offset': {
          if (refs.length !== 1 || places.length > 1) fail('offset takes one curve of the chain, and at(u, v) on the side to offset to (none: both sides)', 'bad_ref');
          if (!value) fail('its value is the distance ("2 mm")');
          const d = length(value, 'the distance');
          await settle();
          const id = curve(refs[0]);
          const why = linkedRefusal(c.g, id, c.refOf(id));
          if (why) fail(why);
          const chain = chainOf(c.g, id);
          if (!chain) fail('offset takes lines, arcs, circles and splines');
          const both = !places.length;
          const side = places.length ? sideOf(c.g, chain!, places[0]) : 1;
          const old = storedTie('offset');
          if (old) {
            const sides = old.copies.map((x) => x.at[0]).sort();
            const want = both ? [-1, 1] : [side];
            if (sameSet(old.sources, chain!.items.map((x) => x.e.id)) && JSON.stringify(sides) === JSON.stringify(want)) {
              keptTie(old, { exprs: { distance: d.expr } });
              return;
            }
          }
          ensureNew(c.g.ties, 'pattern or offset');
          newTie(offsetChain(c.g, id, side, both, d.expr, units));
          return;
        }
        case 'linear_pattern':
        case 'circular_pattern': {
          const circular = kind === 'circular_pattern';
          if (places.length) fail(`${kind} takes no at(u, v)`, 'bad_ref');
          const parsed = parseValues(value, circular ? CIRCULAR_KEYS : LINEAR_KEYS);
          if ('problem' in parsed) fail(`value: ${parsed.problem}`);
          const v = (parsed as { values: Record<string, string> }).values;
          const count = countOf(v.count, 0);
          if (!count) fail(`value: count is a whole number, ${circular ? 2 : 1} or more ("count 4")`);
          await settle();
          // A kept pattern keeps the values the row leaves out; a new one takes the person's tool's defaults.
          const was = c.stored?.ties?.find((t) => t.id === row.id) ?? null;
          const lenExpr = (mm: number) => storeExpr(String(+(mm / ({ mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }[units.units().length] ?? 1)).toPrecision(6)), 'length', units);
          let tie: Omit<SketchTie, 'id' | 'copies'>;
          if (circular) {
            if (refs.length < 2) fail('circular_pattern takes the centre point first, then what it copies', 'bad_ref');
            const centre = pointIdOf(c.g, one(refs[0]));
            if (!centre) fail(`${refs[0]} is not a point: the centre is a point (c.center, origin)`, 'bad_ref');
            const angle = v.angle ? storeExpr(v.angle, 'angle', units) : null;
            tie = { kind: 'circular', sources: items(refs.slice(1)), count: [count!, 1], exprs: { angle: angle ?? was?.exprs.angle ?? '90 deg' }, centre: centre!, full: !angle };
          } else {
            if (!v.spacing) fail('value: give the spacing ("count 4; spacing 10 mm")');
            const count2 = countOf(v.count2, 1);
            if (!count2) fail('value: count2 is a whole number, 1 or more');
            if (v.along && v.angle) fail('value: a direction runs along a line or at an angle, not both');
            if (v.along2 && v.angle2) fail('value: the second direction runs along a line or at an angle, not both');
            const line = (r: string | undefined) => {
              if (!r) return null;
              const id = curve(r);
              if (entityOf(c.g, id)?.kind !== 'line') fail(`${r} is not a line: a pattern runs along a line`, 'bad_ref');
              return id;
            };
            const spacing1 = storeExpr(v.spacing, 'length', units);
            tie = {
              kind: 'linear',
              sources: items(refs),
              count: [count!, count2!],
              exprs: {
                spacing1,
                angle1: v.angle ? storeExpr(v.angle, 'angle', units) : v.along ? (was?.exprs.angle1 ?? '0 deg') : '0 deg',
                spacing2: v.spacing2 ? storeExpr(v.spacing2, 'length', units) : (was?.exprs.spacing2 ?? lenExpr(20)),
                angle2: v.angle2 ? storeExpr(v.angle2, 'angle', units) : (was?.exprs.angle2 ?? '90 deg'),
              },
              along: [line(v.along), line(v.along2)],
            };
            if (count2! > 1 && !v.spacing2) fail('value: a second direction takes spacing2');
          }
          const old = storedTie(tie.kind);
          if (old && sameSet(old.sources, tie.sources)) {
            keptTie(old, { count: tie.count, exprs: tie.exprs, ...(circular ? { centre: tie.centre, full: tie.full } : { along: tie.along }) });
            return;
          }
          ensureNew(c.g.ties, 'pattern or offset');
          newTie(createPattern(c.g, tie, units));
          return;
        }
        case 'project':
        case 'intersect': {
          noValue();
          if (places.length || refs.length !== 1) fail(kind === 'project' ? 'project takes one face, edge or vertex of a body, or a body (its silhouette)' : 'intersect takes one body', 'bad_ref');
          const type: SketchLink['type'] = kind === 'project' ? 'projected' : 'intersection';
          const old = c.stored?.links?.find((l) => l.id === row.id) ?? null;
          if (old) {
            if (old.type !== type) fail(`${row.id} is the sketch's ${old.type === 'projected' ? 'projection' : 'intersection'}: give this row another id`, 'bad_ref');
            const { points, entities } = carry(c.stored!.entities.filter((e) => e.link === old.id).map((e) => e.id));
            c.set({ ...c.g, points, entities, links: [...(c.g.links ?? []).filter((l) => l.id !== old.id), old] });
            for (const [e, name] of linkEntityNames(old)) if (c.has(e)) c.aliasOf(name, e, true);
            record({ id: row.id, kind, entities: [...linkEntityNames(old).values()] });
            return;
          }
          ensureNew(c.g.links, 'link');
          await withScene(ctx, o.scene, async (sc) => {
            const sel = await selectAny(sc, refs[0], `${at}.refs[${refsAll.indexOf(refs[0])}]`);
            if (sel.hits.length !== 1) fail(`${refs[0]} names ${sel.hits.length} things: name one`, 'bad_ref');
            const hit = sel.hits[0];
            let source: SketchLinkSource;
            if (kind === 'intersect') {
              if (hit.kind !== 'body') fail(`${refs[0]} is not a body: intersect cuts a body`, 'bad_ref');
              source = { kind: 'section', body: (hit as { body: { id: string } }).body.id };
            } else if (hit.kind === 'body') source = { kind: 'silhouette', body: hit.body.id };
            else if (hit.kind === 'face' || hit.kind === 'edge' || hit.kind === 'vertex') {
              const b = hit.body;
              if (!b.names) fail(`${b.name} has no face names, so its geometry cannot be followed`);
              const lookup = kernelLookup(services.kernel);
              const ref = hit.kind === 'vertex' ? await refOfVertex(lookup, b, hit.index) : hit.kind === 'edge' ? await refOfEdge(lookup, b, hit.index) : await refOfFace(lookup, b, hit.index);
              source = { kind: hit.kind, body: b.id, ref };
            } else fail(`${refs[0]} is a ${hit.kind}: project takes a face, an edge, a vertex or a body`, 'bad_ref');
            const env: LinkEnv = {
              kernel: services.kernel,
              bodies: new Map(sc.bodies.map((b) => [b.id, { shape: b.shape, names: b.names, placement: b.placement }] as const)),
              bodyName: (id) => sc.bodies.find((b) => b.id === id)?.name ?? sc.state.doc.bodies[id]?.name ?? 'a body',
              featureName: (id) => sc.state.doc.features.find((f) => f.id === id)?.name ?? null,
            };
            const src = source!;
            const words = sourceWords(src, env);
            const same = (c.g.links ?? []).find((l) => l.type === type && l.source.kind === src.kind && l.source.body === src.body && (!('ref' in l.source) || !('ref' in src) || l.source.ref.name === src.ref.name));
            if (same) fail(`${words} is in the sketch already (${same.id})`);
            const link: SketchLink = { id: row.id, type, source: src, entities: [] };
            const r = await readLink(link, o.frame, env);
            if (r.state === 'lost') fail(r.message.replace(/ not found after rebuild$/, ' cannot be read'));
            const curves = (r as Extract<typeof r, { state: 'ok' }>).curves;
            if (!curves.length) fail(`${words} gives nothing on the sketch plane`);
            const a = applyLinkCurves(c.g as Parameters<typeof applyLinkCurves>[0], link, curves);
            c.set({ ...c.g, ...a.draft });
            for (const [e, name] of linkEntityNames(a.link)) c.aliasOf(name, e, true);
            record({ id: row.id, kind, entities: [...linkEntityNames(a.link).values()], values: { source: words } });
          });
          return;
        }
        case 'import': {
          if (places.length || refs.length !== 1) fail('import takes one attachment id: the drawing the person attached ("att-" and 16 hex digits, from their message)', 'bad_ref');
          const att = refs[0];
          if (!ATTACHMENT_ID.test(att)) fail(`"${att}" is not an attachment id: the person's message names each attached drawing's attachment_id ("att-" and 16 hex digits)`, 'bad_ref');
          const parsed = parseValues(value, IMPORT_KEYS);
          if ('problem' in parsed) fail(`value: ${parsed.problem}`);
          const v = (parsed as { values: Record<string, string> }).values;
          const opts: ImportOptions = {};
          if (v.scale !== undefined) {
            const s = Number(v.scale.replace(/\s*mm$/i, ''));
            if (!(Number.isFinite(s) && s > 0)) fail(`value: scale is the mm per drawing unit, a number above 0 ("scale 25.4"), not "${v.scale}"`);
            opts.scale = s;
          }
          if (v.place !== undefined) {
            const pl = v.place.toLowerCase();
            if (pl !== 'origin' && pl !== 'centre' && pl !== 'center') fail(`value: place is origin (the drawing's origin on the sketch origin) or centre, not "${v.place}"`);
            opts.place = pl === 'origin' ? 'origin' : 'centre';
          }
          if (v.layers !== undefined && v.layers.toLowerCase() !== 'all') opts.layers = v.layers.split(',').map((x) => x.trim()).filter(Boolean);
          const call = ctx.call as { readAttachment?: (id: string) => Promise<File> } | undefined;
          if (!call || typeof call.readAttachment !== 'function') {
            throw new ToolError('not_editable', `${at} (${row.id}, import): this Magnusim cannot hand an attached file to a tool: the person can bring the drawing in with Import SVG/DXF in the sketch (MODIFY).`, { detail: { field: at, row: row.id } });
          }
          let file: File;
          try {
            file = await call.readAttachment(att);
          } catch (err) {
            const code = err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'failed';
            const said = err instanceof Error && err.message ? ` (${err.message.replace(/\.$/, '')})` : '';
            const detail = { field: at, row: row.id };
            if (code === 'not_found') throw new ToolError('not_found', `${at} (${row.id}, import): no attached file ${att} in this conversation${said}: use the attachment_id of an "Attached drawing" line of the person's message.`, { detail, hint: ATTACHMENT_HINTS.not_found });
            if (code === 'bad_request') fail(`"${att}" is not an attachment id the host takes${said}`, 'bad_ref');
            if (code === 'not_allowed') throw new ToolError('not_editable', `${at} (${row.id}, import): the host did not let this call read ${att}${said}.`, { detail, hint: ATTACHMENT_HINTS.not_allowed });
            throw new ToolError('internal', `${at} (${row.id}, import): ${att} could not be read${said}: try again.`, { detail, hint: ATTACHMENT_HINTS.failed });
          }
          const read = tryReadDrawing(file!.name || att, new Uint8Array(await file!.arrayBuffer()));
          if ('refused' in read) fail(read.refused);
          const drawing = (read as Exclude<typeof read, { refused: string }>).drawing;
          let plan: ReturnType<typeof planImport>;
          try {
            plan = planImport(drawing, opts);
          } catch (err) {
            if (err instanceof DrawingRefused) fail(`value: ${err.message}`);
            throw err;
          }
          if (plan!.summary.refused) fail(plan!.summary.refused);
          const { outcome, added } = importIntoDraft(c.g as Parameters<typeof importIntoDraft>[0], plan!);
          take(outcome);
          added.forEach((e, k) => {
            c.aliasOf(`${row.id}.${k + 1}`, e, true);
            // Watched, the drawing goes in as one step (sketch/write.ts drawSteps).
            c.drawGroups[e] = row.id;
          });
          const w = summaryWords(plan!.summary);
          const values: Record<string, string | number> = { file: drawing.name, read: w.read, skipped: w.skipped, size: w.size, open_ends: plan!.summary.openEnds, join: w.join, scale: w.scale };
          if (w.layers) values.layers = w.layers;
          if (w.notes.length) values.notes = w.notes.join(' ');
          record({ id: row.id, kind, entities: added.slice(0, 60).map((_, k) => `${row.id}.${k + 1}`), values });
          return;
        }
        case 'copy': {
          if (places.length > 1) fail('copy takes one at(u, v) at most: where the middle of the copy goes', 'bad_ref');
          const parsed = parseValues(value, COPY_KEYS);
          if ('problem' in parsed) fail(`value: ${parsed.problem}`);
          const v = (parsed as { values: Record<string, string> }).values;
          let offset: [number, number] | null = null;
          if (v.offset !== undefined) {
            if (places.length) fail('value: offset or at(u, v), not both');
            const m = OFFSET.exec(v.offset);
            if (!m) fail(`value: offset is "<du>, <dv>" in mm ("offset 40, 0"), not "${v.offset}"`);
            offset = [Number(m![1]), Number(m![2])];
          }
          await settle();
          // What the person copied (Ctrl+C in a sketch of any Part): all of it, as their Ctrl+V pastes it.
          const fromClip = v.from !== undefined && v.from.trim().toLowerCase() === 'clipboard';
          let held: SketchClip | null = null;
          if (fromClip) {
            if (refs.some((r) => r !== 'all')) fail('value "from clipboard" pastes all of what the person copied: give refs ["all"], or only an at(u, v) where its middle goes', 'bad_ref');
            held = await heldClip(services);
            if (!held) fail('value: the person has copied no sketch geometry (Ctrl+C in a sketch): nothing is on the clipboard', 'bad_ref');
          } else if (!refs.length) fail('copy takes what it copies: entities, whole macros ("r") or "all"', 'bad_ref');
          // From another sketch (as stored), or from this one as the rows so far leave it.
          const st = services.doc.state.get();
          const from = v.from !== undefined && !fromClip ? featureByName(st, v.from) : null;
          if (v.from !== undefined && !fromClip && !from) fail(`value: no feature is called "${v.from}" (from takes a sketch, or "clipboard": what the person copied)`, 'bad_ref');
          if (from && from.type !== 'sketch') fail(`value: ${from.name} is a ${from.type}, not a sketch`, 'bad_ref');
          const other = from && from.id !== c.stored?.id ? (from as SketchFeature) : null;
          const ids: string[] = [];
          const nameOf = new Map<string, string>();
          if (held) held.entities.forEach((e, k) => nameOf.set(e.id, String(k + 1)));
          else if (other) {
            const form = describeSketch(other, st);
            const exact = new Map<string, string>();
            const heads = new Map<string, string[]>();
            for (const e of other.entities) {
              const n = form.refOf(e.id);
              exact.set(n, e.id);
              if (!exact.has(e.id)) exact.set(e.id, e.id);
              nameOf.set(e.id, n);
              const dot = n.indexOf('.');
              if (dot > 0) heads.set(n.slice(0, dot), [...(heads.get(n.slice(0, dot)) ?? []), e.id]);
            }
            for (const r of refs) {
              const got = r === 'all' && !exact.has(r) ? other.entities.map((e) => e.id) : exact.has(r) ? [exact.get(r)!] : (heads.get(r) ?? []);
              if (!got.length) fail(`refs[${refsAll.indexOf(r)}]: ${other.name} has no entity called "${r}" (its names: ${[...exact.keys()].slice(0, 20).join(', ')})`, 'bad_ref');
              for (const id of got) if (!ids.includes(id)) ids.push(id);
            }
          } else {
            if (refs.length === 1 && refs[0] === 'all' && !('id' in c.resolve('all'))) ids.push(...c.g.entities.map((e) => e.id));
            else ids.push(...items(refs));
            for (const id of ids) nameOf.set(id, c.refOf(id));
          }
          const clip = held ?? clipOf(other ?? (c.g as unknown as SketchFeature), ids, units.units());
          if (typeof clip === 'string') fail(clip);
          const k = clip as Exclude<typeof clip, string>;
          const to: [number, number] = places.length ? [places[0][0], places[0][1]] : offset ? [k.anchor[0] + offset[0], k.anchor[1] + offset[1]] : [k.anchor[0], k.anchor[1]];
          const before = c.g;
          const pasted = pasteClip(c.g, k, to, { evaluate: (expr, q) => evaluatedIn(units, expr, q), units: units.units() });
          const after = take(pasted.outcome);
          const names: string[] = [];
          for (const e of k.entities) {
            const name = `${row.id}.${nameOf.get(e.id) ?? e.id}`;
            c.aliasOf(name, pasted.map.entities[e.id], true);
            // Watched, the copy goes in as one step (sketch/write.ts drawSteps), as the person's paste.
            c.drawGroups[pasted.map.entities[e.id]] = row.id;
            names.push(name);
          }
          const left = leftOutWords(k.outside);
          if (left) c.warnings.push(`${row.id} (copy): ${left}`);
          const valued = valuedWords(pasted.valued);
          if (valued) c.warnings.push(`${row.id} (copy): ${valued}`);
          const n = pasted.kept;
          const kept = [n.relations ? `${n.relations} relation${n.relations === 1 ? '' : 's'}` : '', n.dimensions ? `${n.dimensions} dimension${n.dimensions === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
          record({
            id: row.id,
            kind,
            entities: names.slice(0, 60),
            dimensions: newDimensions(before, after),
            values: { from: held ? `the clipboard (copied from ${held.from})` : other ? other.name : 'this sketch', copied: clipWords(k), kept: kept || 'none', left_out: left ? left.replace(/ (was|were) left out$/, '') : 'nothing', middle_at: `at(${+to[0].toFixed(6)}, ${+to[1].toFixed(6)})` },
          });
          return;
        }
        case 'break_link': {
          noValue();
          if (places.length) fail('break_link takes no at(u, v)', 'bad_ref');
          const ids: string[] = [];
          for (const r of refs) {
            const l = (c.g.links ?? []).find((x) => x.id === r);
            if (l) ids.push(...l.entities.map((x) => x.entity).filter((id) => c.has(id)));
            else ids.push(curve(r));
          }
          if (!ids.length) fail('name the linked curves, or a project or intersect row', 'bad_ref');
          const next = breakLinks(c.g as Parameters<typeof breakLinks>[0], ids);
          if (!next) fail('none of them is linked');
          c.set({ ...c.g, ...next! });
          record({ id: row.id, kind, entities: ids });
          return;
        }
        default:
          fail(`"${kind}" is not one of the sketch tools`);
      }
    },
  };
}
