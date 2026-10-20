// extrude: extrude regions of one sketch in one step (CAD tools spec §3.2.8). edit "" makes one;
// edit "<name>" replaces that extrude's inputs (send all of them). Regions, bodies and the "to"
// face or vertex are selectors (help selectors) read on the bodies built now, or for an edit on the
// bodies just before the extrude. The extents map to the feature's own:
//   blind, symmetric      {kind, distance}             along the sketch normal (flip: against it)
//   two                   {kind: two, distance, distance2}   along, and against
//   through, through_both {kind: through_all, both}    past every body (or the bodies' given)
//   to                    {kind: to, target, offset}   up to a flat face's plane or a vertex
// Bare numbers are stored with the Part's unit ("6" in a mm Part is "6 mm"). The person's own
// Extrude panel opens read-only, filled, the Part rebuilds, and its Done keeps the feature; a new
// body then gets its name and colour in the same step. A join, cut or intersect that meets nothing
// changes nothing and answers feature_failed with CAD's words and which way it missed
// (region-tools.ts, diagnose.ts); a cut on given bodies that cuts nothing away answers
// cut_removed_nothing.
// face: one flat face of a body extruded with no sketch (the person's Extrude of a selected face;
// sketch "" and regions []), along its outward normal. direction: an axis to go along instead of
// the normal (the panel's Along: an origin or construction axis, a sketch line, an edge, "normal of
// <plane>"), "" for the normal.
// get_model full shows extrudes as this tool's input (registerFeatureIo), regions as "at(u, v)";
// edit_feature sets distance (an Up to's offset) and distance2.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_DISTANCE } from '../../features/extrude/def';
import type { AppServices } from '../../types/app';
import type { CallCtx, EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { BodyRef, ExtrudeExtentDef, ExtrudeFeature, Feature, FeatureId, SketchFeature } from '../../types/doc';
import type { AxisRef } from '../../types/references';
import type { SketchOutput } from '../../types/sketch';
import { axisWords } from '../diagnose';
import { ToolError } from '../errors';
import { axisText, bodyText, createdLabels, editTarget, faceText, nameFor, partOf, pathIn, str, strings, type RefBodies } from '../feature-tools';
import { registerFeatureIo } from '../features-io';
import { bodyWords } from '../judge';
import { len } from '../numbers';
import { checkBodyName, checkScoped, fillSwept, nameNewBody, opWords, readOp, regionsOf, regionTexts, scopeOf, scopeTexts, sketchFor, type Op } from '../region-tools';
import { runtimeOf } from '../runtime';
import { axisRefOf, faceRefOf, targetRefOf } from '../selectors/refs';
import { candidates, evaluate, faceLabel, hitWords, parseFor, selectOne, withScene, type AxisHit, type FaceHit, type Hit, type Scene } from '../selectors/resolve';
import { storeExpr } from '../sketch/compile';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';

type Extent = 'blind' | 'symmetric' | 'two' | 'through' | 'through_both' | 'to';
const EXTENTS: readonly Extent[] = ['blind', 'symmetric', 'two', 'through', 'through_both', 'to'];
/** The schema's most regions, and so the most get_model writes back. */
const REGIONS_MAX = 40;

interface Plan extends EditPlan {
  edit: FeatureId | null;
  name: string | null;
  fields: Partial<ExtrudeFeature>;
  op: Op;
  bodyName: string;
  color: string;
  sketchName: string;
  /** The face extruded (no sketch), in words, or "". */
  faceWords: string;
  warnings: string[];
  /** Warnings found after the Done (bodies a scoped cut did not touch). */
  late: string[];
}

/** A dry-run refusal of the extent as the field it came from (CAD's own words). */
function extentError(why: string): ToolError {
  const field = /^Distance 2/.test(why) || /add up to 0/.test(why) ? 'distance2' : /^Up to/.test(why) ? 'to' : 'distance';
  const reason = /^(Distance|Distance 1|Distance 2|Total distance|Offset): /.test(why) ? 'expr_error' : 'bad_input';
  return new ToolError(reason, `${field}: ${why}.`, { detail: { field } });
}

/** A value and, when it is no plain number, what it comes to: "t (6 mm)". */
function valueWords(services: AppServices, expr: string, q: 'length' | 'angle'): string {
  const r = services.doc.units.evaluate(expr, q);
  if (!r.ok || /^[-+]?[\d.]+\s*(mm|deg)?$/.test(expr.trim())) return expr;
  return `${expr} (${len(r.value)} ${q === 'length' ? 'mm' : 'deg'})`;
}

/** The face or vertex an Up to goes to: one, flat when a face. */
async function targetOf(sc: Scene, text: string): Promise<{ ref: BodyRef; words: string; warnings: string[] }> {
  const sel = await evaluate(sc, parseFor(sc, text, 'any', 'to'), 'any');
  if (!sel.hits.length) throw new ToolError('nothing_selected', `to: "${text}" names no face or vertex.`, { detail: { field: 'to', candidates: [] } });
  const other = sel.hits.find((h) => h.kind !== 'face' && h.kind !== 'vertex');
  if (other) throw new ToolError('bad_selector', `to: "${text}" names ${other.kind === 'edge' ? 'an edge' : `a ${other.kind}`}: up to takes one flat face or one vertex.`, { detail: { field: 'to', selector: text } });
  if (sel.hits.length > 1) {
    throw new ToolError('selector_ambiguous', `to: "${text}" names ${sel.hits.length} faces or vertices; up to takes one: narrow it, or use one of the candidates' handles.`, { detail: { field: 'to', count: sel.hits.length, candidates: await candidates(sc, sel.hits) } });
  }
  const h: Hit = sel.hits[0];
  if (h.kind === 'face' && h.topo.type !== 'plane') throw new ToolError('not_flat', `to: ${faceLabel(sc, h) ?? hitWords(sc, h)} is ${h.topo.type === 'cylinder' ? 'round' : 'curved'}: up to takes a flat face or a vertex.`, { detail: { field: 'to' } });
  const ref = await targetRefOf(sc, h);
  return { ref, words: h.kind === 'face' ? (faceLabel(sc, h) ?? hitWords(sc, h)) : hitWords(sc, h), warnings: sel.warnings };
}

/** The one flat face an extrude of a face takes, as the person's Extrude keeps it. */
async function faceOf(sc: Scene, text: string): Promise<{ ref: BodyRef; words: string; normal: number[] | null; warnings: string[] }> {
  const { hit } = await selectOne(sc, text, 'face', 'face');
  const h = hit as FaceHit;
  const words = faceLabel(sc, h) ?? hitWords(sc, h);
  if (h.topo.type !== 'plane') throw new ToolError('not_flat', `face: ${words} is curved: extrude takes a flat face or sketch regions.`, { detail: { field: 'face' } });
  const r = await faceRefOf(sc, h);
  return { ref: { body: r.body, ref: r.ref }, words, normal: (h.topo.normal as number[] | undefined) ?? null, warnings: h.warnings };
}

/** The axis an extrude goes along (the panel's Along). */
async function directionOf(sc: Scene, text: string): Promise<{ ref: AxisRef; words: string; dir: number[] }> {
  const { hit } = await selectOne(sc, text, 'axis', 'direction');
  const a = hit as AxisHit;
  return { ref: await axisRefOf(sc, a), words: a.words, dir: [...a.dir] };
}

/** Where the extrude goes, in words ("blind 6 mm along +Z"). */
function extentWords(services: AppServices, plan: { extent: Extent; distance: string; distance2: string; flip: boolean; toWords: string }, n: readonly number[] | null): string {
  const along = n ? axisWords(plan.flip ? n.map((x) => -x) : n) : 'the normal';
  const against = n ? axisWords(plan.flip ? n : n.map((x) => -x)) : 'against it';
  const both = n ? `±${axisWords(n).slice(1)}` : 'both ways';
  const d = valueWords(services, plan.distance, 'length');
  switch (plan.extent) {
    case 'blind':
      return `blind ${d} along ${along}`;
    case 'symmetric':
      return `symmetric ${d} in all, half each side, along ${both}`;
    case 'two':
      return `${d} along ${along}, ${valueWords(services, plan.distance2, 'length')} along ${against}`;
    case 'through':
      return `through every body along ${along}`;
    case 'through_both':
      return `through every body both ways (${both})`;
    case 'to':
      return `up to ${plan.toWords}${plan.distance ? `, then ${d} further` : ''}`;
  }
}

const extrudeTool: EditTool<Plan> = {
  async plan(ctx) {
    const { services } = ctx;
    const s = services.doc.state.get();
    const input = ctx.input;
    const extent = input.extent as Extent;
    const distance = str(input.distance);
    const distance2 = str(input.distance2);
    const to = str(input.to);
    const regions = strings(input.regions);
    const faceSel = str(input.face);
    const dirSel = str(input.direction);
    const problems: string[] = [];
    if (!EXTENTS.includes(extent)) problems.push('extent: blind, symmetric, two, through, through_both or to');
    if (faceSel) {
      if (str(input.sketch)) problems.push('sketch: "" with face (the face is the profile)');
      if (regions.length) problems.push('regions: [] with face');
    } else {
      if (!str(input.sketch)) problems.push('sketch: the sketch (or face: a flat face to extrude with no sketch)');
      if (!regions.length) problems.push('regions: at least one ("all", "r1" or "at(u, v)")');
    }
    if (regions.length > REGIONS_MAX) problems.push(`regions: at most ${REGIONS_MAX}`);
    regions.forEach((t, i) => {
      if (!t) problems.push(`regions[${i}]: a region, not ""`);
    });
    if ((extent === 'blind' || extent === 'symmetric' || extent === 'two') && !distance) problems.push(`distance: the length (${extent === 'symmetric' ? 'in all, half each side' : 'along the sketch normal'}), such as "10 mm" or "t"`);
    if ((extent === 'through' || extent === 'through_both') && distance) problems.push(`distance: "" with ${extent} (it goes past every body)`);
    if (extent === 'two' && !distance2) problems.push('distance2: the length against the sketch normal');
    if (extent !== 'two' && distance2) problems.push('distance2: only with extent two; send ""');
    if (extent === 'to' && !to) problems.push('to: the face or vertex to extrude up to');
    if (extent !== 'to' && to) problems.push('to: only with extent to; send ""');
    const op = readOp(input, problems);
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });

    const editing = editTarget(services, input.edit, ['extrude'], 'extrude') as ExtrudeFeature | null;
    const name = nameFor(services, input.name, editing);
    const sketch = faceSel ? null : sketchFor(services, input.sketch, editing);
    const own = editing && editing.op === 'new' ? editing.creates : null;
    checkBodyName(services, op.bodyName, own);

    const self = editing?.id ?? null;
    const r = await withScene(ctx, { before: self, sketch: sketch?.id ?? null, self }, async (sc) => {
      const reg = sketch ? await regionsOf(sc, sketch, regions, 'extrude') : { refs: [], words: '' };
      const face = faceSel ? await faceOf(sc, faceSel) : null;
      const direction = dirSel ? await directionOf(sc, dirSel) : null;
      const scope = op.op === 'new' ? { ids: [], words: '' } : await scopeOf(sc, op.bodies);
      const target = extent === 'to' ? await targetOf(sc, to) : null;
      return { reg, face, direction, scope, target };
    });

    const units = services.doc.units;
    const d = distance ? storeExpr(distance, 'length', units) : '';
    const d2 = distance2 ? storeExpr(distance2, 'length', units) : '';
    // The last blind distance an extent keeps (going back to Blind in the panel gives it back).
    const keep = (editing?.extent && 'distance' in editing.extent ? editing.extent.distance : null) ?? DEFAULT_DISTANCE[units.units().length] ?? '10 mm';
    let ext: ExtrudeExtentDef;
    if (extent === 'blind' || extent === 'symmetric') ext = { kind: extent, distance: d };
    else if (extent === 'two') ext = { kind: 'two', distance: d, distance2: d2 };
    else if (extent === 'through' || extent === 'through_both') ext = { kind: 'through_all', both: extent === 'through_both', distance: keep };
    else ext = { kind: 'to', target: r.target!.ref, offset: d || '0 mm', distance: keep };
    const fields: Partial<ExtrudeFeature> = { profiles: r.reg.refs, extent: ext, flip: input.flip === true, op: op.op, scope: r.scope.ids };
    // A face and a direction are written only when given, or to clear the ones an edit's feature has (the person's records have none otherwise).
    if (r.face || editing?.face) fields.face = r.face?.ref ?? null;
    if (r.direction || editing?.direction) fields.direction = r.direction?.ref ?? null;
    // The dry run: the extrude as its type checks it (a bad distance is refused before anything changes).
    const def = services.doc.features.get('extrude')!;
    const draft = { ...(editing ?? def.create(s.doc, {})), ...fields } as Feature;
    const why = def.incomplete(draft, units);
    if (why) throw extentError(why);

    const out = sketch ? (s.rebuild.outputs[sketch.id] as SketchOutput | undefined) : undefined;
    const n = r.direction?.dir ?? (r.face ? r.face.normal : out?.type === 'sketch' ? out.plane.normal : null);
    const resolved: Record<string, string> = {
      ...(sketch ? { sketch: sketch.name, regions: r.reg.words } : { face: r.face!.words }),
      extent: extentWords(services, { extent, distance: d, distance2: d2, flip: input.flip === true, toWords: r.target?.words ?? '' }, n),
      op: opWords(op.op, r.scope.words),
    };
    if (r.direction) resolved.direction = r.direction.words;
    if (r.target) resolved.to = r.target.words;
    if (editing) resolved.edit = editing.name;
    return {
      part: partOf(services, 'extrude', name ?? editing?.name ?? 'Extrude', !!editing),
      value: false,
      own: editing?.id ?? null,
      feature: editing?.id ?? null,
      resolved,
      edit: editing?.id ?? null,
      name,
      fields,
      op: op.op,
      bodyName: op.bodyName,
      color: op.color,
      sketchName: sketch?.name ?? '',
      faceWords: r.face?.words ?? '',
      warnings: [...(r.face?.warnings ?? []), ...(r.target?.warnings ?? [])],
      late: [],
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { services } = ctx;
    const editName = plan.edit ? services.doc.state.get().doc.features.find((f) => f.id === plan.edit)?.name : null;
    const label = plan.name ?? editName ?? 'Extrude';
    const id = await fillSwept(ctx, plan, { edit: plan.edit, type: 'extrude', fields: (plan.name ? { ...plan.fields, name: plan.name } : plan.fields) as Partial<Feature>, label });
    plan.late = await checkScoped(ctx, id);
    if (plan.op === 'new') await nameNewBody(ctx, id, plan.bodyName, plan.color);
    const made = services.doc.state.get().doc.features.find((f) => f.id === id);
    if (made) plan.part = partOf(services, 'extrude', made.name, !!plan.edit);
  },

  sealed(plan, ctx) {
    if (!plan.edit && plan.own) runtimeOf(ctx.services)?.madeBy.add(plan.own);
  },

  reply(plan, data: EditData, ctx): ToolReply {
    const s = ctx.services.doc.state.get();
    const id = plan.own!;
    const f = s.doc.features.find((g) => g.id === id);
    const created = createdLabels(ctx.services, id);
    const body = bodyWords(data);
    const name = partOf(ctx.services, 'extrude', f?.name ?? plan.name ?? 'Extrude', false);
    const text = `${name} ${data.feature?.state ?? 'ok'}${plan.edit ? ' (replaced)' : ''}${body ? ` · ${body}` : ''}`;
    return {
      text,
      summary: text,
      data: {
        ...data,
        created: created.labels,
        ...(created.more ? { created_more: created.more } : {}),
        warnings: [...plan.warnings, ...plan.late, ...data.warnings].slice(0, 20),
      },
    };
  },
};

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx: CallCtx) => runEdit(ctx, extrudeTool),
};

// ------------------------------------------------------------------ get_model full and edit_feature

/** An Up to target as a selector: a face's label, or a point on the body. */
function targetText(services: AppServices, t: BodyRef | null, at: RefBodies | null): string {
  if (!t) return '';
  const s = services.doc.state.get();
  if (t.ref.signature.kind === 'vertex') return `${bodyText(s, t.body)} vertex at (${[...t.ref.signature.at].map((v) => len(v)).join(', ')})`;
  return faceText(s, t.body, t.ref, at);
}

registerFeatureIo('extrude', {
  tool: 'extrude',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as ExtrudeFeature;
    if ((!g.face && !g.profiles.length) || g.profiles.length > REGIONS_MAX) return null;
    const s = services.doc.state.get();
    const sketch = g.face ? null : (s.doc.features.find((x) => x.id === g.profiles[0].sketch) as SketchFeature | undefined);
    if (!g.face && !sketch) return null;
    const e = g.extent;
    const base = { distance: '', distance2: '', to: '' };
    const extent =
      e.kind === 'blind' || e.kind === 'symmetric'
        ? { extent: e.kind, ...base, distance: e.distance }
        : e.kind === 'two'
          ? { extent: 'two', ...base, distance: e.distance, distance2: e.distance2 }
          : e.kind === 'through_all'
            ? { extent: e.both ? 'through_both' : 'through', ...base }
            : { extent: 'to', ...base, distance: e.offset, to: targetText(services, e.target, at) };
    return {
      edit: g.name,
      name: '',
      sketch: sketch?.name ?? '',
      regions: g.face ? [] : regionTexts(s, g.profiles),
      face: g.face ? faceText(s, g.face.body, g.face.ref, at) : '',
      direction: g.direction ? axisText(s, g.direction, at) : '',
      ...extent,
      flip: !!g.flip,
      op: g.op,
      bodies: g.op === 'new' ? [] : scopeTexts(services, g.scope),
      body_name: '',
      color: '',
    };
  },
  values(f) {
    const e = (f as ExtrudeFeature).extent;
    if (e.kind === 'blind' || e.kind === 'symmetric') return [{ field: 'distance', expr: e.distance }];
    if (e.kind === 'two') return [{ field: 'distance', expr: e.distance }, { field: 'distance2', expr: e.distance2 }];
    if (e.kind === 'to') return [{ field: 'distance', expr: e.offset }];
    return [];
  },
  pathOf(f, field, services) {
    const e = (f as ExtrudeFeature).extent;
    const map: Record<string, string> =
      e.kind === 'blind' || e.kind === 'symmetric' ? { distance: 'extent.distance' } : e.kind === 'two' ? { distance: 'extent.distance', distance2: 'extent.distance2' } : e.kind === 'to' ? { distance: 'extent.offset' } : {};
    return pathIn(services, f, field, map);
  },
});
