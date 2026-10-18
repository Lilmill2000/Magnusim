// sketch: make a sketch, or replace one's content (CAD tools spec §3.2.7, §6), in one step. The
// input is checked and solved before anything changes: where it lies (sketch/support.ts), the
// shapes, joins, inferred relations and refs (sketch/compile.ts), then the solver on its own
// (sketch/solve.ts): a conflict or a duplicate is refused naming the constraints, a sketch with no
// solution or one that collapses too, and an under-defined one is kept with a warning and what
// still moves. Then, inside the step, an offset plane when `on` asks for one and the sketch itself
// through the person's own sketch mode (sketch/write.ts); an edited sketch's new plane goes above
// it in the history (the rebuild reads a sketch's plane from the features before it). The answer:
// the state, dof, free and moved points, the plane in numbers and words, the regions (r1, r2, ...
// by area) with what bounds them, open ends, joins, inferred relations and warnings (an inferred
// relation left out says what it repeated or could not hold with).
// get_model reads a sketch back in this tool's input form (sketch/describe.ts, registered here).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { toModel, ydirOf } from '../../features/sketch/plane';
import { nextName } from '../../lib/ids';
import { isDimension } from '../../sketch/model';
import type { EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { FeatureId, SketchDimension, SketchFeature, SketchSupport } from '../../types/doc';
import type { SketchOutput } from '../../types/sketch';
import { ToolError } from '../errors';
import { registerFeatureIo } from '../features-io';
import { featureByName, frameWords, supportWords } from '../model';
import { dir, jsonBytes, sig6, vec } from '../numbers';
import { runtimeOf } from '../runtime';
import { compileSketch, type Compiled, type ConstraintIn, type EntityIn } from '../sketch/compile';
import { describeSketch, TOO_BIG_WORDS } from '../sketch/describe';
import { regionRows } from '../sketch/regions';
import { solveSketch, type Solved } from '../sketch/solve';
import { planSupport, type SupportPlan } from '../sketch/support';
import { writePlane, writeSketch } from '../sketch/write';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';

interface Plan extends EditPlan {
  name: string;
  edit: SketchFeature | null;
  support: SupportPlan;
  compiled: Compiled;
  solved: Solved;
  /** The sketch made or replaced (set by apply). */
  made: FeatureId | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const sameSupport = (a: SketchSupport, b: SketchSupport) => JSON.stringify(a) === JSON.stringify(b);

const sketchTool: EditTool<Plan> = {
  async plan(ctx) {
    const { services } = ctx;
    const s = services.doc.state.get();
    const names = s.doc.features.map((f) => f.name);
    const editName = str(ctx.input.edit);
    let edit: SketchFeature | null = null;
    if (editName) {
      const f = featureByName(s, editName);
      if (!f) throw new ToolError('not_found', `edit: no feature is called "${editName}". Features: ${names.length ? names.slice(0, 30).join(', ') : 'none yet'}.`, { detail: { field: 'edit', names: names.slice(0, 30) } });
      if (f.type !== 'sketch') throw new ToolError('wrong_feature_type', `edit: ${f.name} is a ${f.type}, not a sketch: change it with its own tool or edit_feature.`, { detail: { field: 'edit', type: f.type } });
      edit = f;
      const form = describeSketch(f, s, { budget: ctx.budgets.sketch });
      if (form.unsupported) throw new ToolError('unsupported_sketch', `${f.name} has ${form.unsupported}.`, { detail: { feature: f.name } });
      if (form.tooBig) throw new ToolError('too_big', `${f.name} is ${TOO_BIG_WORDS}.`, { detail: { feature: f.name } });
    }
    const want = str(ctx.input.name);
    const name = want || edit?.name || nextName('Sketch', names);
    const clash = s.doc.features.find((f) => f.id !== edit?.id && f.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new ToolError('name_taken', `name: another feature is already called ${clash.name}.`, { detail: { field: 'name' } });
    const support = await planSupport(ctx, str(ctx.input.on), { edit, sketchName: name });
    const compiled = compileSketch(
      {
        entities: (Array.isArray(ctx.input.entities) ? ctx.input.entities : []) as EntityIn[],
        constraints: (Array.isArray(ctx.input.constraints) ? ctx.input.constraints : []) as ConstraintIn[],
        infer: ctx.input.infer === true,
      },
      { units: services.doc.units, stored: edit },
    );
    const solved = await solveSketch(ctx, { ...compiled, geometry: compiled.draft });
    return {
      part: `Sketch ${name}`,
      // A sketch replace is structural: what it breaks downstream is kept and listed.
      value: false,
      own: edit?.id ?? null,
      feature: edit?.id ?? null,
      resolved: { on: support.words },
      name,
      edit,
      support,
      compiled,
      solved,
      made: null,
    };
  },

  async apply(plan, ctx: EditCtx) {
    const sp = plan.support;
    const edit = plan.edit;
    let support: SketchSupport | null = null;
    if (sp.kind === 'direct') support = sp.support;
    else if (sp.kind === 'offset') {
      const plane = sp.reuse ?? (await writePlane(ctx, sp.update ? { kind: 'update', id: sp.update, name: sp.planeName, distance: sp.distance, flip: sp.flip } : { kind: 'create', name: sp.planeName, plane: sp.plane, distance: sp.distance, flip: sp.flip }));
      // A plane made for an edited sketch opens at the end: it goes above the sketch, in this step.
      const { doc } = ctx.services;
      const features = doc.state.get().doc.features;
      const at = edit ? features.findIndex((f) => f.id === edit.id) : -1;
      if (at >= 0 && features.findIndex((f) => f.id === plane) > at) {
        const r = ctx.step.run(() => doc.move(plane, at));
        if (!r.ok) throw new ToolError('bad_input', `on: the plane ${sp.planeName} cannot go above ${edit!.name}: ${r.reason}.`, { detail: { field: 'on' } });
      }
      support = { kind: 'feature', feature: plane };
    }
    // The watch path draws each entity where the model put it, and names it by its kind.
    const kinds: Record<string, string> = {};
    for (const e of (Array.isArray(ctx.input.entities) ? ctx.input.entities : []) as EntityIn[]) if (e && typeof e.id === 'string') kinds[e.id] = String(e.kind);
    const watch = { drawn: plan.compiled.draft, kinds };
    let id: FeatureId;
    if (!edit) {
      id = await writeSketch(ctx, { target: { kind: 'new', support: support!, name: plan.name }, geometry: plan.solved.geometry, ...watch }, plan.compiled.refOf);
      runtimeOf(ctx.services)?.madeBy.add(id);
    } else {
      const patch: Partial<SketchFeature> = {};
      if (plan.name !== edit.name) patch.name = plan.name;
      if (support && !sameSupport(support, edit.support)) {
        patch.support = support;
        const frame = sp.kind === 'keep' ? edit.plane : sp.frame;
        patch.plane = { origin: [...frame.origin], normal: [...frame.normal], xdir: [...frame.xdir] } as SketchFeature['plane'];
      }
      id = await writeSketch(ctx, { target: { kind: 'edit', id: edit.id, name: plan.name, patch: Object.keys(patch).length ? patch : null }, geometry: plan.solved.geometry, ...watch }, plan.compiled.refOf);
    }
    plan.made = id;
    plan.own = id;
    plan.feature = id;
  },

  reply(plan, data: EditData, ctx): ToolReply {
    const s = ctx.services.doc.state.get();
    const id = plan.made!;
    const f = s.doc.features.find((g) => g.id === id) as SketchFeature | undefined;
    const out = s.rebuild.outputs[id] as SketchOutput | undefined;
    const { refOf, words } = plan.compiled;
    const solved = plan.solved;
    const plane = out?.type === 'sketch' ? out.plane : (f?.plane ?? null);
    const on = f ? supportWords(s, f) : plan.support.words;
    const regions =
      out?.type === 'sketch'
        ? regionRows(out).map((r) => ({
            id: r.id,
            area_mm2: r.area_mm2,
            at: r.at,
            ...(plane ? { at_mm: vec(toModel(plane, r.at)) } : {}),
            holes: r.holes,
            depth: r.depth,
            bbox_uv: r.bbox_uv,
            bounded_by: r.entities.map(refOf).slice(0, 40),
          }))
        : [];
    const constraint = (cid: string) => plan.compiled.draft.constraints.find((c) => c.id === cid);
    const dropped = solved.dropped.map((cid) => (constraint(cid) ? words(constraint(cid)!) : cid));
    const inferred = plan.compiled.inferred.filter((cid) => !solved.dropped.includes(cid)).map((cid) => words(constraint(cid)!));
    const warnings = [...plan.compiled.warnings, ...plan.support.warnings, ...data.warnings];
    if (solved.state === 'under') {
      const free = solved.free.slice(0, 6).map((x) => `${x.of} (${x.moves.join(', ')})`);
      warnings.push(`${plan.name} is under-defined (dof ${solved.dof})${free.length ? `: ${free.join(', ')} still move` : ''}; add relations or dimensions until dof is 0`);
    }
    if (dropped.length) {
      // Why each went, in the model's words: what it fought or repeated.
      const named = (cid: string) => {
        const c = constraint(cid);
        if (!c) return cid;
        if (plan.compiled.own.has(cid)) return plan.compiled.own.get(cid)!;
        if (plan.compiled.inferred.includes(cid)) return `inferred ${words(c)}`;
        return `${cid} (${words(c)})`;
      };
      const why = solved.dropped.map((cid) => {
        const w = solved.droppedWhy[cid] ?? { fought: false, with: [] };
        const others = w.with.slice(0, 4).map(named);
        const list = others.length <= 1 ? others.join('') : `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}`;
        const what = w.fought ? `it could not hold with ${list || 'the other constraints'}` : `it repeated ${list || 'another constraint'}`;
        return `${constraint(cid) ? words(constraint(cid)!) : cid}: ${what}`;
      });
      warnings.push(`left out inferred ${why.join('; ')}`);
    }
    if (out?.type === 'sketch' && !out.regions.length && out.open.length) warnings.push(`${plan.name} is not closed: ${plural(out.open.length, 'open end')}; join them (help sketch)`);
    const row: Record<string, unknown> = {
      ...data,
      plane: plane ? { on, origin_mm: vec(plane.origin), normal: dir(plane.normal), u: dir(plane.xdir), v: dir(ydirOf(plane)), words: frameWords(plane) } : null,
      solver: { state: solved.state, dof: solved.dof, free: solved.free, moved: solved.moved, dropped_inferred: dropped },
      joined: plan.compiled.joined.slice(0, 40),
      inferred: inferred.slice(0, 60),
      regions,
      open: out?.type === 'sketch' ? out.open.slice(0, 40).map((o) => ({ at: vec(o.at), entity: refOf(o.entity), point: o.point ? refOf(o.point) : null })) : [],
      dangling: out?.type === 'sketch' ? out.dangling.slice(0, 40).map(refOf) : [],
      warnings: warnings.slice(0, 30),
    };
    // Within the sketch reply's room: the regions' boundaries go first, then half the regions at a time.
    const budget = ctx.budgets.sketch;
    if (jsonBytes(row) > budget) row.regions = regions.map(({ bounded_by: _b, ...r }) => r);
    while (jsonBytes(row) > budget && Array.isArray(row.regions) && (row.regions as unknown[]).length > 1) {
      const r = row.regions as unknown[];
      row.regions_more = (Number(row.regions_more) || 0) + Math.ceil(r.length / 2);
      row.regions = r.slice(0, Math.floor(r.length / 2));
    }
    const state = solved.state === 'fully' ? 'fully defined' : `under-defined (dof ${solved.dof})`;
    const n = regions.length;
    const area = n ? ` (${n === 1 ? '' : 'largest '}${sig6(regions[0].area_mm2)} mm²)` : out?.type === 'sketch' && out.open.length ? ` (not closed: ${plural(out.open.length, 'open end')})` : '';
    const text = `Sketch "${plan.name}" on ${on}: ${state}, ${plural(n, 'region')}${area}${data.broke.length ? ` · ${plural(data.broke.length, 'feature')} broke` : ''}`;
    return { text, data: row, summary: text };
  },
};

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx) => runEdit(ctx, sketchTool),
};

// get_model full and get_model feature read a sketch in this tool's input form.
registerFeatureIo('sketch', {
  tool: 'sketch',
  inputsOf: (f, services) => describeSketch(f as SketchFeature, services.doc.state.get()).inputs,
  values: (f) => (f as SketchFeature).constraints.filter((c): c is SketchDimension => isDimension(c) && c.driving).map((c) => ({ field: c.id, expr: c.expr })),
});
