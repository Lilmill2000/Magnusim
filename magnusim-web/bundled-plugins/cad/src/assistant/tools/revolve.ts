// revolve: turn regions of one sketch about an axis in one step (CAD tools spec §3.2.9). edit ""
// makes one; edit "<name>" replaces that revolve's inputs (send all of them). The axis is an axis
// selector (X axis, a sketch line "Profile.ax", one straight edge, "axis of <round face>", a
// construction axis), read on the bodies built now, or for an edit on the bodies just before the
// revolve. The extents map to the feature's own:
//   full        {kind: one, angle: 360 deg}   a whole turn (no end faces)
//   one         {kind: one, angle}            right hand about the axis (flip: the other way)
//   symmetric   {kind: symmetric, angle}      in all, half each side of the sketch
//   two         {kind: two, angle, angle2}    one way and the other
// Regions, op, bodies, body_name and color as in extrude (region-tools.ts). The person's own
// Revolve panel opens read-only, filled, and its Done keeps the feature. A profile across the axis,
// or an axis normal to the sketch, fails with CAD's words and changes nothing; a join, cut or
// intersect that meets nothing says which way it missed (diagnose.ts).
// get_model full shows revolves as this tool's input (registerFeatureIo); edit_feature sets angle
// and angle2.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { CallCtx, EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { Feature, FeatureId, RevolveExtentDef, RevolveFeature, SketchFeature } from '../../types/doc';
import { ToolError } from '../errors';
import { axisText, createdLabels, editTarget, nameFor, partOf, pathIn, str, strings } from '../feature-tools';
import { registerFeatureIo } from '../features-io';
import { bodyWords } from '../judge';
import { len } from '../numbers';
import { checkBodyName, checkScoped, fillSwept, nameNewBody, opWords, readOp, regionsOf, regionTexts, scopeOf, scopeTexts, sketchFor, type Op } from '../region-tools';
import { runtimeOf } from '../runtime';
import { axisRefOf } from '../selectors/refs';
import { selectOne, withScene, type AxisHit } from '../selectors/resolve';
import { storeExpr } from '../sketch/compile';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';

type Extent = 'full' | 'one' | 'symmetric' | 'two';
const EXTENTS: readonly Extent[] = ['full', 'one', 'symmetric', 'two'];
const FULL = '360 deg';
const REGIONS_MAX = 40;

interface Plan extends EditPlan {
  edit: FeatureId | null;
  name: string | null;
  fields: Partial<RevolveFeature>;
  op: Op;
  bodyName: string;
  color: string;
  warnings: string[];
  late: string[];
}

/** A dry-run refusal of the angles as the field it came from (CAD's own words). */
function extentError(why: string): ToolError {
  const field = /^Angle 2/.test(why) ? 'angle2' : 'angle';
  const reason = /^(Angle|Angle 1|Angle 2|Total angle): /.test(why) ? 'expr_error' : 'bad_input';
  return new ToolError(reason, `${field}: ${why}.`, { detail: { field } });
}

/** An angle and, when it is no plain number, what it comes to: "a (90 deg)". */
function angleWords(services: AppServices, expr: string): string {
  const r = services.doc.units.evaluate(expr, 'angle');
  if (!r.ok || /^[-+]?[\d.]+\s*(deg|°)?$/.test(expr.trim())) return expr;
  return `${expr} (${len(r.value)} deg)`;
}

/** A full turn as the feature keeps it ("360 deg", as this tool writes it). */
const isFull = (e: RevolveExtentDef) => e.kind === 'one' && /^\s*360\s*(deg|°)?\s*$/.test(String(e.angle));

const revolveTool: EditTool<Plan> = {
  async plan(ctx) {
    const { services } = ctx;
    const s = services.doc.state.get();
    const input = ctx.input;
    const extent = input.extent as Extent;
    const angle = str(input.angle);
    const angle2 = str(input.angle2);
    const axis = str(input.axis);
    const regions = strings(input.regions);
    const problems: string[] = [];
    if (!EXTENTS.includes(extent)) problems.push('extent: full, one, symmetric or two');
    if (!regions.length) problems.push('regions: at least one ("all", "r1" or "at(u, v)")');
    if (regions.length > REGIONS_MAX) problems.push(`regions: at most ${REGIONS_MAX}`);
    regions.forEach((t, i) => {
      if (!t) problems.push(`regions[${i}]: a region, not ""`);
    });
    if (!axis) problems.push('axis: the axis to turn about ("Z axis", "Profile.ax", an edge, "axis of <round face>")');
    if (extent === 'full' && angle) problems.push('angle: "" with extent full (a whole turn)');
    if ((extent === 'one' || extent === 'symmetric' || extent === 'two') && !angle) problems.push(`angle: the angle${extent === 'symmetric' ? ' in all, half each side' : ''}, such as "90 deg"`);
    if (extent === 'two' && !angle2) problems.push('angle2: the angle the other way');
    if (extent !== 'two' && angle2) problems.push('angle2: only with extent two; send ""');
    const op = readOp(input, problems);
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });

    const editing = editTarget(services, input.edit, ['revolve'], 'revolve') as RevolveFeature | null;
    const name = nameFor(services, input.name, editing);
    const sketch = sketchFor(services, input.sketch, editing);
    checkBodyName(services, op.bodyName, editing && editing.op === 'new' ? editing.creates : null);

    const self = editing?.id ?? null;
    const r = await withScene(ctx, { before: self, sketch: sketch.id, self }, async (sc) => {
      const reg = await regionsOf(sc, sketch, regions, 'revolve');
      const ax = await selectOne(sc, axis, 'axis', 'axis');
      const hit = ax.hit as AxisHit;
      const ref = await axisRefOf(sc, hit);
      const scope = op.op === 'new' ? { ids: [], words: '' } : await scopeOf(sc, op.bodies);
      return { reg, axis: { ref, words: hit.words, warnings: [...hit.warnings, ...ax.selected.warnings] }, scope };
    });

    const units = services.doc.units;
    const a = angle ? storeExpr(angle, 'angle', units) : '';
    const a2 = angle2 ? storeExpr(angle2, 'angle', units) : '';
    const ext: RevolveExtentDef = extent === 'full' ? { kind: 'one', angle: FULL } : extent === 'two' ? { kind: 'two', angle: a, angle2: a2 } : { kind: extent, angle: a };
    const fields: Partial<RevolveFeature> = { profiles: r.reg.refs, axis: r.axis.ref, extent: ext, flip: input.flip === true, op: op.op, scope: r.scope.ids };
    // The dry run: the angles as the revolve's type checks them.
    const def = services.doc.features.get('revolve')!;
    const draft = { ...(editing ?? def.create(s.doc, {})), ...fields } as Feature;
    const why = def.incomplete(draft, units);
    if (why) throw extentError(why);

    const turn =
      extent === 'full'
        ? 'a full turn'
        : extent === 'one'
          ? `${angleWords(services, a)}${input.flip === true ? ', the other way' : ''}`
          : extent === 'symmetric'
            ? `${angleWords(services, a)} in all, half each side`
            : `${angleWords(services, a)} one way, ${angleWords(services, a2)} the other`;
    const resolved: Record<string, string> = { sketch: sketch.name, regions: r.reg.words, axis: r.axis.words, extent: turn, op: opWords(op.op, r.scope.words) };
    if (editing) resolved.edit = editing.name;
    return {
      part: partOf(services, 'revolve', name ?? editing?.name ?? 'Revolve', !!editing),
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
      warnings: [...new Set(r.axis.warnings)],
      late: [],
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { services } = ctx;
    const editName = plan.edit ? services.doc.state.get().doc.features.find((f) => f.id === plan.edit)?.name : null;
    const label = plan.name ?? editName ?? 'Revolve';
    const id = await fillSwept(ctx, plan, { edit: plan.edit, type: 'revolve', fields: (plan.name ? { ...plan.fields, name: plan.name } : plan.fields) as Partial<Feature>, label });
    plan.late = await checkScoped(ctx, id);
    if (plan.op === 'new') await nameNewBody(ctx, id, plan.bodyName, plan.color);
    const made = services.doc.state.get().doc.features.find((f) => f.id === id);
    if (made) plan.part = partOf(services, 'revolve', made.name, !!plan.edit);
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
    const name = partOf(ctx.services, 'revolve', f?.name ?? plan.name ?? 'Revolve', false);
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
  run: (ctx: CallCtx) => runEdit(ctx, revolveTool),
};

// ------------------------------------------------------------------ get_model full and edit_feature

registerFeatureIo('revolve', {
  tool: 'revolve',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as RevolveFeature;
    if (!g.axis || !g.profiles.length || g.profiles.length > REGIONS_MAX) return null;
    const s = services.doc.state.get();
    const sketch = s.doc.features.find((x) => x.id === g.profiles[0].sketch) as SketchFeature | undefined;
    if (!sketch) return null;
    const e = g.extent;
    const extent = isFull(e) ? { extent: 'full', angle: '', angle2: '' } : e.kind === 'two' ? { extent: 'two', angle: e.angle, angle2: e.angle2 } : { extent: e.kind, angle: e.angle, angle2: '' };
    return {
      edit: g.name,
      name: '',
      sketch: sketch.name,
      regions: regionTexts(s, g.profiles),
      axis: axisText(s, g.axis, at),
      ...extent,
      flip: !!g.flip,
      op: g.op,
      bodies: g.op === 'new' ? [] : scopeTexts(services, g.scope),
      body_name: '',
      color: '',
    };
  },
  values(f) {
    const e = (f as RevolveFeature).extent;
    return e.kind === 'two' ? [{ field: 'angle', expr: e.angle }, { field: 'angle2', expr: e.angle2 }] : [{ field: 'angle', expr: e.angle }];
  },
  pathOf: (f, field, services) => pathIn(services, f, field, (f as RevolveFeature).extent.kind === 'two' ? { angle: 'extent.angle', angle2: 'extent.angle2' } : { angle: 'extent.angle' }),
});
