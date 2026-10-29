// pattern: repeat features, bodies or faces in a row, around an axis, or mirrored, in one step
// (CAD tools spec §3.2.12). edit "" makes one; edit "<name>" replaces that pattern's inputs (its
// type must be the kind's).
//   - linear: copies along `about` (an axis selector: X axis, an edge, a sketch line, "normal of
//     Top"), `count` copies (the original included) `spacing` apart; about2, count2 and spacing2 a
//     second direction ("" for none); flip and flip2 reverse each; symmetric puts copies on both
//     sides. Spacing is always a positive pitch (flip turns it round);
//   - circular: about the axis `about`, `count` copies over `spacing`, the total angle ("360 deg"
//     spreads them evenly all round);
//   - mirror: about the plane `about`; "<plane> offset <length>" makes the construction plane first
//     in the same step (or uses one the Part has: the same plane, offset and flip).
//   of features: items are feature names (extrudes, revolves, sweeps, lofts, patterns, mirrors),
//   op source keeps each feature's own operation; bodies: body selectors (op source is a new
//   body per copy); faces: face selectors on one body (a boss joins, a pocket cuts). bodies: the
//   bodies a join, cut or intersect acts on ([] the ones the copies meet).
// Selectors read the bodies built now, or for an edit the bodies just before the pattern. New-body
// copies are named "<body> (Instance k)"; combine takes them as "bodies of <pattern>". The person's
// own panel opens read-only, filled; a copy that misses its body turns the pattern red, which
// changes nothing and answers feature_failed with CAD's words naming the copies.
// options: symmetric (both sides of the first direction, or of a circular pattern), flip2 and
// symmetric2 (the second direction), extent and extent2 (spacing is the whole length from the
// original to the last copy: the panel's Extent). skip: copies left out by key, as a click on a
// copy's marker does ("2", "1.3", "-1"); a key no copy has is refused once the pattern is built
// (nothing changes), and the reply lists every copy's key.
// get_model full shows patterns as this tool's input (registerFeatureIo), and edit_feature sets
// count, spacing, count2 and spacing2.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { featureRefusal } from '../../features/pattern/panel';
import type { PatternType } from '../../features/pattern/defs';
import type { AppServices } from '../../types/app';
import type { CallCtx, EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { BodyId, CircularPatternFeature, Feature, FeatureId, LinearPatternFeature, MirrorFeature, PatternCommon, PatternOp, PatternOf, PersistentRef, RefPlaneFeature } from '../../types/doc';
import type { DocState, PatternOutput } from '../../types/doc-service';
import type { AxisRef, PlaneRef } from '../../types/references';
import { PATTERN_OPTIONS } from '../schemas';
import { ToolError, type Reason } from '../errors';
import { andList, axisText, bodyText, createdLabels, editTarget, faceText, fillFeature, nameFor, partOf, pathIn, planeText, str, strings, type RefBodies } from '../feature-tools';
import { registerFeatureIo, type FeatureValue } from '../features-io';
import { bodyWords, type JudgedPlan } from '../judge';
import { featureByName } from '../model';
import { runtimeOf } from '../runtime';
import { axisRefOf, faceRefOf, planeRefOf } from '../selectors/refs';
import { echo, selectOne, selectSet, withScene, type AxisHit, type FaceHit, type PlaneHit } from '../selectors/resolve';
import { storeExpr } from '../sketch/compile';
import { offsetPlaneLike } from '../sketch/support';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';
import { closestName, closestWords } from '../closest';

type Kind = 'linear' | 'circular' | 'mirror';
const KINDS: readonly Kind[] = ['linear', 'circular', 'mirror'];
const TYPE: Record<Kind, PatternType> = { linear: 'pattern_linear', circular: 'pattern_circular', mirror: 'mirror' };
const KIND_OF: Record<string, Kind> = { pattern_linear: 'linear', pattern_circular: 'circular', mirror: 'mirror' };
const OFS: readonly PatternOf[] = ['features', 'bodies', 'faces'];
const OPS: readonly PatternOp[] = ['source', 'new', 'join', 'cut', 'intersect'];
/** The schema's most items, and so the most get_model writes back. */
const ITEMS_MAX = 40;

/** A mirror about "<plane> offset <length>": the construction plane made (or reused) first. */
interface OffsetPlane {
  base: PlaneRef;
  distance: string;
  flip: boolean;
  /** A construction plane the Part has with the same base, offset and flip, or null (one is made). */
  reuse: FeatureId | null;
}

interface Plan extends EditPlan {
  kind: Kind;
  type: PatternType;
  edit: FeatureId | null;
  name: string | null;
  fields: Partial<Feature>;
  offsetPlane: OffsetPlane | null;
  /** The construction plane this call made (get_model's by: assistant). */
  madePlane: FeatureId | null;
  sources: string;
  warnings: string[];
  /** The copies to leave out (checked against the built copies' keys). */
  skip: string[];
}

type PatternOption = (typeof PATTERN_OPTIONS)[number];
/** A copy key: "2", "-1", "1.3" (along both directions). */
const KEY = /^-?\d+(\.-?\d+)?$/;

const unquote = (t: string) => (/^".*"$/.test(t) ? t.slice(1, -1).replace(/\\(["\\])/g, '$1') : t);

/** A construction plane offset from `base` as asked (built, before `before` when an edit needs it),
 *  or null. The sketch tool's rule (sketch/support.ts), so a sketch's offset plane serves a mirror
 *  too, and the other way round. */
function samePlane(s: DocState, o: Omit<OffsetPlane, 'reuse'>, before: FeatureId | null): FeatureId | null {
  const limit = before ? s.doc.features.findIndex((f) => f.id === before) : s.doc.features.length;
  return offsetPlaneLike(s, o, limit)?.id ?? null;
}

/** A value the pattern's type refuses, as the field it came from (CAD's own words). */
function valueError(why: string): ToolError {
  const field = /^Direction 2: Count/.test(why) ? 'count2' : /^Direction 2: /.test(why) ? 'spacing2' : /^(Count|That makes)/.test(why) ? 'count' : /^(Spacing|Extent|Angle)/.test(why) ? 'spacing' : null;
  if (!field) return new ToolError('bad_input', `${why}.`);
  // "Count: Unknown parameter ..." is the expression; "Count must be ..." a rule of the value.
  const reason: Reason = /^(Direction 2: )?(Count|Spacing|Extent|Angle): /.test(why) ? 'expr_error' : 'bad_input';
  const flipHint = /^(Direction 2: )?Spacing must be more than 0/.test(why) ? { hint: `Spacing is a pitch above 0: set ${field === 'spacing2' ? 'flip2' : 'flip'} true to go the other way.` } : {};
  return new ToolError(reason, `${field}: ${why}.`, { detail: { field }, ...flipHint });
}

const pattern: EditTool<Plan> = {
  async plan(ctx) {
    const { services } = ctx;
    const s = services.doc.state.get();
    const kind = ctx.input.kind as Kind;
    const of = ctx.input.of as PatternOf;
    const op = ctx.input.op as PatternOp;
    const problems: string[] = [];
    if (!KINDS.includes(kind)) problems.push('kind: linear, circular or mirror');
    if (!OFS.includes(of)) problems.push('of: features, bodies or faces');
    if (!OPS.includes(op)) problems.push('op: source, new, join, cut or intersect');
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });
    const type = TYPE[kind];
    const editing = editTarget(services, ctx.input.edit, [type], kind === 'mirror' ? 'mirror' : `${kind} pattern`, (f) => (KIND_OF[f.type] ? `send kind ${KIND_OF[f.type]} to change it` : null));
    const name = nameFor(services, ctx.input.name, editing);
    const items = strings(ctx.input.items);
    const about = str(ctx.input.about);
    const count = str(ctx.input.count);
    const spacing = str(ctx.input.spacing);
    const about2 = str(ctx.input.about2);
    const count2 = str(ctx.input.count2);
    const spacing2 = str(ctx.input.spacing2);
    const scopeIn = strings(ctx.input.bodies);
    const options = strings(ctx.input.options) as PatternOption[];
    // A call written before options came (symmetric and flip2 on their own) means the same.
    const on = (o: PatternOption) => options.includes(o) || (o === 'symmetric' && ctx.input.symmetric === true) || (o === 'flip2' && ctx.input.flip2 === true);
    const symmetric = on('symmetric');
    const flip = ctx.input.flip === true;
    const flip2 = on('flip2');
    const symmetric2 = on('symmetric2');
    const extent = on('extent');
    const extent2 = on('extent2');
    const skip = [...new Set(strings(ctx.input.skip))];
    for (const o of options) if (!(PATTERN_OPTIONS as readonly string[]).includes(o)) problems.push(`options: "${o}" is not one of ${PATTERN_OPTIONS.join(', ')}`);
    if (kind === 'mirror' && (options.length || skip.length)) problems.push('options and skip: [] for a mirror');
    if (kind === 'circular' && (flip2 || symmetric2 || extent || extent2)) problems.push('options: a circular pattern takes symmetric only');
    if (kind === 'linear' && !str(ctx.input.about2) && (flip2 || symmetric2 || extent2)) problems.push('options: flip2, symmetric2 and extent2 need about2');
    for (const [i, k] of skip.entries()) if (!KEY.test(k) || /^0(\.0)?$/.test(k)) problems.push(`skip[${i}]: a copy's key ("2", "1.3", "-1"), not the original "0"`);
    if (!items.length) problems.push(`items: at least one ${of === 'features' ? 'feature' : of === 'bodies' ? 'body' : 'face'}`);
    if (items.length > ITEMS_MAX) problems.push(`items: at most ${ITEMS_MAX}`);
    items.forEach((t, i) => {
      if (!t) problems.push(`items[${i}]: a name or a selector, not ""`);
    });
    if (!about) problems.push(kind === 'mirror' ? 'about: the mirror plane (Top, a construction plane, a flat face)' : `about: the ${kind === 'linear' ? 'direction' : 'axis'} (X axis, an edge, "axis of <round face>")`);
    if (kind === 'mirror') {
      if (count || spacing) problems.push('count and spacing: "" for a mirror');
    } else {
      if (!count) problems.push('count: the copies, the original included ("4", "n")');
      if (!spacing) problems.push(kind === 'linear' ? 'spacing: the pitch between copies ("20 mm")' : 'spacing: the total angle ("360 deg" spreads the copies evenly)');
    }
    if (kind !== 'linear' && (about2 || count2 || spacing2)) problems.push('about2, count2 and spacing2: only a linear pattern has a second direction; send ""');
    if (kind === 'linear' && about2 && (!count2 || !spacing2)) problems.push('count2 and spacing2: the second direction\'s copies and pitch');
    if (kind === 'linear' && !about2 && (count2 || spacing2)) problems.push('about2: the second direction, or "" with count2 and spacing2 ""');
    if ((op === 'new' || op === 'source') && scopeIn.length) problems.push(`bodies: [] with op ${op} (only join, cut and intersect act on bodies)`);
    if (of === 'faces' && op !== 'source' && op !== 'join') problems.push('op: copies of faces go onto their own body (a boss joins, a pocket cuts): send op source');
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });

    const self = editing?.id ?? null;
    const r = await withScene(ctx, { before: self, self }, async (sc) => {
      const resolved: Record<string, string> = {};
      const warnings: string[] = [];
      const features: FeatureId[] = [];
      const bodies: BodyId[] = [];
      let faceBody: BodyId | '' = '';
      const faces: PersistentRef[] = [];
      let sources = '';
      if (of === 'features') {
        for (const [i, t] of items.entries()) {
          const f = featureByName(s, unquote(t));
          if (!f) {
            const names = s.doc.features.filter((g) => !featureRefusal(services, self ?? '', g.id)).map((g) => g.name);
            const near = closestName(unquote(t), names);
            throw new ToolError('not_found', `items[${i}]: no feature is called "${t}".${closestWords(near)} Features it can repeat: ${names.length ? names.slice(0, 30).join(', ') : 'none yet'}.`, { detail: { field: `items[${i}]`, names: names.slice(0, 30), ...(near ? { closest: near } : {}) } });
          }
          const why = featureRefusal(services, self ?? '', f.id);
          if (why) {
            const reason: Reason = /comes after/.test(why) ? 'later_feature' : /repeat itself/.test(why) ? 'self_reference' : 'bad_input';
            throw new ToolError(reason, `items[${i}]: ${why}.`, { detail: { field: `items[${i}]`, feature: f.name } });
          }
          if (!features.includes(f.id)) features.push(f.id);
        }
        // In history order, as the pattern repeats them.
        const order = new Map(s.doc.features.map((g, i) => [g.id, i]));
        features.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
        sources = andList(features.map((id) => s.doc.features.find((g) => g.id === id)!.name));
      } else if (of === 'bodies') {
        const echoes: string[] = [];
        for (const [i, t] of items.entries()) {
          const sel = await selectSet(sc, t, 'body', `items[${i}]`);
          for (const h of sel.hits) if (h.kind === 'body' && !bodies.includes(h.body.id)) bodies.push(h.body.id);
          echoes.push(echo(sc, sel));
        }
        resolved.items = echoes.join('; ');
        sources = andList(bodies.map((id) => sc.bodies.find((b) => b.id === id)?.name ?? id));
      } else {
        const echoes: string[] = [];
        const hits: FaceHit[] = [];
        for (const [i, t] of items.entries()) {
          const sel = await selectSet(sc, t, 'face', `items[${i}]`);
          for (const h of sel.hits) if (h.kind === 'face' && !hits.some((x) => x.bi === h.bi && x.index === h.index)) hits.push(h);
          echoes.push(echo(sc, sel));
          for (const w of sel.warnings) if (!warnings.includes(w)) warnings.push(w);
        }
        const on = [...new Set(hits.map((h) => h.body.name))];
        if (on.length > 1) throw new ToolError('bad_selector', `items are on ${andList(on)}: the faces of one body per call.`, { detail: { field: 'items', bodies: on } });
        faceBody = hits[0].body.id;
        for (const h of hits) faces.push((await faceRefOf(sc, h)).ref);
        resolved.items = echoes.join('; ');
        sources = `${hits.length} ${hits.length === 1 ? 'face' : 'faces'} of ${hits[0].body.name}`;
      }
      let axis: AxisRef | null = null;
      let axis2: AxisRef | null = null;
      let plane: PlaneRef | null = null;
      let offsetPlane: Omit<OffsetPlane, 'reuse'> | null = null;
      if (kind === 'mirror') {
        const { hit, selected } = await selectOne(sc, about, 'plane', 'about');
        const p = hit as PlaneHit;
        // The distance as the sketch tool stores it ("40" in a mm Part is "40 mm").
        if (p.offset) offsetPlane = { base: await planeRefOf(sc, p), distance: storeExpr(p.offset.expr, 'length', services.doc.units), flip: p.flip };
        else plane = await planeRefOf(sc, p);
        resolved.about = p.offset ? `${p.words} (a construction plane)` : echo(sc, selected);
        warnings.push(...p.warnings.filter((w) => !warnings.includes(w)));
      } else {
        const one = await selectOne(sc, about, 'axis', 'about');
        axis = await axisRefOf(sc, one.hit as AxisHit);
        resolved.about = (one.hit as AxisHit).words;
        if (about2) {
          const two = await selectOne(sc, about2, 'axis', 'about2');
          axis2 = await axisRefOf(sc, two.hit as AxisHit);
          resolved.about2 = (two.hit as AxisHit).words;
        }
      }
      const scope: BodyId[] = [];
      for (const [i, t] of scopeIn.entries()) {
        const sel = await selectSet(sc, t, 'body', `bodies[${i}]`);
        for (const h of sel.hits) if (h.kind === 'body' && !scope.includes(h.body.id)) scope.push(h.body.id);
      }
      if (scope.length) resolved.bodies = andList(scope.map((id) => sc.bodies.find((b) => b.id === id)?.name ?? id));
      return { resolved, warnings, features, bodies, faceBody, faces, sources, axis, axis2, plane, offsetPlane, scope };
    });

    const effectiveOp: PatternOp = of === 'faces' ? 'join' : of === 'bodies' && op === 'source' ? 'new' : op;
    const common: Partial<PatternCommon> = {
      of,
      features: r.features,
      bodies: r.bodies,
      faceBody: r.faceBody,
      faces: r.faces,
      op: effectiveOp,
      scope: r.scope,
      skip,
    };
    let fields: Partial<Feature>;
    if (kind === 'linear') {
      const dir1 = { axis: r.axis, flip, count, mode: extent ? ('extent' as const) : ('spacing' as const), distance: spacing, symmetric };
      const dir2 = about2 ? { axis: r.axis2, flip: flip2, count: count2, mode: extent2 ? ('extent' as const) : ('spacing' as const), distance: spacing2, symmetric: symmetric2 } : null;
      fields = { ...common, dir1, dir2 } as Partial<LinearPatternFeature>;
    } else if (kind === 'circular') {
      const a = services.doc.units.evaluate(spacing, 'angle');
      const full = a.ok && Math.abs(a.value - 360) < 1e-9;
      fields = { ...common, axis: r.axis, flip, count, mode: full ? 'full' : 'angle', angle: spacing, symmetric } as Partial<CircularPatternFeature>;
    } else fields = { ...common, plane: r.plane } as Partial<MirrorFeature>;
    // The dry run: the pattern as its type checks it (counts, pitches, angles), before anything changes.
    const def = services.doc.features.get(type)!;
    const draft = { ...(editing ?? def.create(s.doc, {})), ...fields, ...(r.offsetPlane ? { plane: { kind: 'origin', plane: 'origin:top' } } : {}) } as Feature;
    const why = def.incomplete(draft, services.doc.units);
    if (why) throw valueError(why);
    const label = services.doc.features.get(type)?.label ?? type;
    const resolved: Record<string, string> = { ...r.resolved, of: `${of}: ${r.sources}`, op: of === 'faces' ? 'onto the faces\' body (a boss joins, a pocket cuts)' : effectiveOp };
    if (kind !== 'mirror') resolved.count = count;
    if (options.length) resolved.options = options.join(', ');
    if (skip.length) resolved.skip = skip.join(', ');
    if (kind === 'linear') resolved.spacing = spacing;
    if (kind === 'circular') resolved.spacing = (fields as Partial<CircularPatternFeature>).mode === 'full' ? `${spacing} (evenly all round)` : spacing;
    if (editing) resolved.edit = editing.name;
    return {
      part: partOf(services, type, name ?? editing?.name ?? label, !!editing),
      value: false,
      own: editing?.id ?? null,
      feature: editing?.id ?? null,
      resolved,
      kind,
      type,
      edit: editing?.id ?? null,
      name,
      fields,
      offsetPlane: r.offsetPlane ? { ...r.offsetPlane, reuse: samePlane(s, r.offsetPlane, self) } : null,
      madePlane: null,
      sources: r.sources,
      warnings: r.warnings,
      skip,
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { services } = ctx;
    const { doc } = services;
    const editName = plan.edit ? doc.state.get().doc.features.find((f) => f.id === plan.edit)?.name : null;
    const label = plan.name ?? editName ?? services.doc.features.get(plan.type)?.label ?? plan.type;
    let fields = plan.fields;
    if (plan.offsetPlane) {
      let planeId = plan.offsetPlane.reuse;
      if (!planeId) {
        // The construction plane first, in this same step, on the person's CONSTRUCT panel.
        const own: JudgedPlan = { value: false };
        const init: Partial<RefPlaneFeature> = { method: 'offset', plane: plan.offsetPlane.base, distance: plan.offsetPlane.distance, flip: plan.offsetPlane.flip };
        planeId = await fillFeature(ctx, own, { edit: null, type: 'ref_plane', fields: init as Partial<Feature>, label: 'Plane' });
        plan.madePlane = planeId;
        await ctx.checkpoint({ hold: 'between-opens' });
        // An edit's mirror reads the plane from above it in the history.
        if (plan.edit) {
          const at = doc.state.get().doc.features.findIndex((f) => f.id === plan.edit);
          const id = planeId;
          const r = ctx.step.run(() => doc.move(id, at));
          if (!r.ok) throw new ToolError('bad_input', `about: the construction plane cannot go above ${editName}: ${r.reason}.`, { detail: { field: 'about' } });
          await ctx.checkpoint({ hold: 'between-opens' });
        }
      }
      fields = { ...fields, plane: { kind: 'feature', feature: planeId } } as Partial<Feature>;
    }
    const id = await fillFeature(ctx, plan, { edit: plan.edit, type: plan.type, fields: plan.name ? { ...fields, name: plan.name } : fields, label });
    // A copy key that no copy has would skip nothing: refused, as the built copies say.
    const out = doc.state.get().rebuild.outputs[id] as PatternOutput | undefined;
    if (plan.skip.length && out?.type === 'pattern') {
      const keys = out.copies.map((c) => c.key);
      const unknown = plan.skip.filter((k) => !keys.includes(k));
      if (unknown.length) throw new ToolError('bad_input', `skip: no copy has the key ${unknown.join(', ')}; the copies are ${keys.slice(0, 40).join(', ')}.`, { detail: { field: 'skip', keys: keys.slice(0, 60) } });
    }
    const made = doc.state.get().doc.features.find((f) => f.id === id);
    if (made) plan.part = partOf(services, plan.type, made.name, !!plan.edit);
  },

  sealed(plan, ctx) {
    const rt = runtimeOf(ctx.services);
    if (!plan.edit && plan.own) rt?.madeBy.add(plan.own);
    if (plan.madePlane) rt?.madeBy.add(plan.madePlane);
  },

  reply(plan, data: EditData, ctx): ToolReply {
    const s = ctx.services.doc.state.get();
    const id = plan.own!;
    const f = s.doc.features.find((g) => g.id === id);
    const out = s.rebuild.outputs[id] as PatternOutput | undefined;
    const created = createdLabels(ctx.services, id);
    const planeName = plan.madePlane ? s.doc.features.find((g) => g.id === plan.madePlane)?.name ?? null : null;
    const copies =
      out?.type === 'pattern'
        ? { made: out.made, skipped: out.copies.filter((c) => c.skipped).map((c) => c.label), failed: out.copies.filter((c) => c.failed).map((c) => c.label), keys: out.copies.slice(0, 60).map((c) => `${c.key} (${c.label})`) }
        : null;
    const body = bodyWords(data);
    const name = f?.name ?? plan.name ?? plan.type;
    const what = plan.kind === 'mirror' ? `mirrored ${plan.sources}` : `${copies ? copies.made : '?'} ${copies?.made === 1 ? 'copy' : 'copies'} of ${plan.sources}`;
    const text = `${name} ${data.feature?.state ?? 'ok'}${plan.edit ? ' (replaced)' : ''}: ${what}${planeName ? ` about ${planeName}` : ''}${body ? ` · ${body}` : ''}`;
    return {
      text,
      summary: text,
      data: {
        ...data,
        created: created.labels,
        ...(created.more ? { created_more: created.more } : {}),
        warnings: [...plan.warnings, ...data.warnings].slice(0, 20),
        ...(copies ? { copies } : {}),
        ...(planeName ? { plane: planeName } : {}),
      },
    };
  },
};

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx: CallCtx) => runEdit(ctx, pattern),
};

// ------------------------------------------------------------------ get_model full and edit_feature

/** What every kind writes back: of, items, op and bodies (null when there are more items than one call takes). */
function sourcesOf(services: AppServices, f: PatternCommon & { type: string }, at: RefBodies | null): { of: PatternOf; items: string[]; op: PatternOp; bodies: string[] } | null {
  const s = services.doc.state.get();
  const items =
    f.of === 'features'
      ? f.features.map((id) => s.doc.features.find((g) => g.id === id)?.name ?? id)
      : f.of === 'bodies'
        ? f.bodies.map((id) => bodyText(s, id))
        : f.faceBody
          ? f.faces.map((r) => faceText(s, f.faceBody as BodyId, r, at))
          : [];
  if (items.length > ITEMS_MAX) return null;
  return { of: f.of, items, op: f.of === 'faces' ? 'source' : f.op, bodies: f.op === 'new' || f.op === 'source' ? [] : f.scope.map((id) => bodyText(s, id)) };
}

const noSecond = { about2: '', count2: '', spacing2: '' };

registerFeatureIo('pattern_linear', {
  tool: 'pattern',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as LinearPatternFeature;
    const src = sourcesOf(services, g, at);
    if (!src) return null;
    const s = services.doc.state.get();
    const options: string[] = [];
    if (g.dir1.symmetric) options.push('symmetric');
    if (g.dir2?.flip) options.push('flip2');
    if (g.dir2?.symmetric) options.push('symmetric2');
    if (g.dir1.mode === 'extent') options.push('extent');
    if (g.dir2?.mode === 'extent') options.push('extent2');
    return {
      edit: g.name,
      name: '',
      kind: 'linear',
      of: src.of,
      items: src.items,
      about: axisText(s, g.dir1.axis, at),
      count: g.dir1.count,
      spacing: g.dir1.distance,
      flip: !!g.dir1.flip,
      ...(g.dir2 ? { about2: axisText(s, g.dir2.axis, at), count2: g.dir2.count, spacing2: g.dir2.distance } : noSecond),
      options,
      skip: [...(g.skip ?? [])],
      op: src.op,
      bodies: src.bodies,
    };
  },
  values(f) {
    const g = f as LinearPatternFeature;
    const out: FeatureValue[] = [];
    // spacing is the pitch, or with extent the whole length: the direction's distance either way.
    const dir = (d: LinearPatternFeature['dir1'], n: string) => out.push({ field: `count${n}`, expr: d.count }, { field: `spacing${n}`, expr: d.distance });
    dir(g.dir1, '');
    if (g.dir2) dir(g.dir2, '2');
    return out;
  },
  pathOf(f, field, services) {
    const g = f as LinearPatternFeature;
    const map: Record<string, string> = { count: 'dir1.count', spacing: 'dir1.distance' };
    if (g.dir2) Object.assign(map, { count2: 'dir2.count', spacing2: 'dir2.distance' });
    return pathIn(services, f, field, map);
  },
});

registerFeatureIo('pattern_circular', {
  tool: 'pattern',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as CircularPatternFeature;
    const src = sourcesOf(services, g, at);
    if (!src) return null;
    const s = services.doc.state.get();
    const options = g.mode === 'angle' && g.symmetric ? ['symmetric'] : [];
    return { edit: g.name, name: '', kind: 'circular', of: src.of, items: src.items, about: axisText(s, g.axis, at), count: g.count, spacing: g.mode === 'full' ? '360 deg' : g.angle, flip: !!g.flip, ...noSecond, options, skip: [...(g.skip ?? [])], op: src.op, bodies: src.bodies };
  },
  // A full turn has no angle to change: send the pattern again with another spacing.
  values: (f) => {
    const g = f as CircularPatternFeature;
    return [{ field: 'count', expr: g.count }, ...(g.mode === 'angle' ? [{ field: 'spacing', expr: g.angle }] : [])];
  },
  pathOf: (f, field, services) => pathIn(services, f, field, (f as CircularPatternFeature).mode === 'angle' ? { count: 'count', spacing: 'angle' } : { count: 'count' }),
});

registerFeatureIo('mirror', {
  tool: 'pattern',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as MirrorFeature;
    const src = sourcesOf(services, g, at);
    if (!src) return null;
    return { edit: g.name, name: '', kind: 'mirror', of: src.of, items: src.items, about: planeText(services.doc.state.get(), g.plane, at), count: '', spacing: '', flip: false, ...noSecond, options: [], skip: [], op: src.op, bodies: src.bodies };
  },
  values: () => [],
  pathOf: () => null,
});
