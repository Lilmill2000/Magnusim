// sweep_loft: a sweep or a loft in one step (CAD tools spec §3.2.10). edit "" makes one; edit
// "<name>" replaces that feature's inputs (its type must be the kind's).
//   - sweep: profiles are regions of ONE sketch ("<sketch>" is its even-odd regions, as a ring;
//     "<sketch> r2", "<sketch> at(u, v)"), path "<sketch>" (every curve of it that is not
//     construction) or "<sketch>: l1, a2" (those curves, end to end; a macro's id takes all its
//     pieces: "p" for a polyline's sides), in another sketch; orientation follow (the profile turns
//     with the path) or fixed;
//   - loft: two or more profiles, one region per sketch, in order; ruled for flat sides; path "".
//   - op, bodies, body_name and color as extrude has them: op new makes a body (body_name and color
//     set after the panel's Done, in the same step; "" for Body N and the default colour), join,
//     cut and intersect change bodies ([] every body it meets).
// Field rules are checked before anything opens, every problem in one message. The person's own
// Sweep or Loft panel opens read-only, filled, the Part rebuilds, and its Done keeps the feature.
// One the kernel cannot make (a path with a gap, a loft profile with a hole) changes nothing and
// answers feature_failed with CAD's own words. The faces it made come back as labels: sweep sides
// by the profile's entity and the path's (Pipe.side(o@a2)), loft sides by the first profile's
// (Loft 1.side(r.top)), the caps start and end.
// get_model full shows these features as this tool's input (registerFeatureIo): regions as
// "<sketch> at(u, v)", the path as "<sketch>: l1, a2". They have no expression fields.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { isBodyMaking } from '../../doc/features/hooks';
import type { AppServices } from '../../types/app';
import type { CallCtx, EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { BodyId, BodyOp, Feature, FeatureId, LoftFeature, RegionRef, SketchFeature, SweepFeature } from '../../types/doc';
import type { DocState, EditResult } from '../../types/doc-service';
import type { SketchCurve } from '../../types/kernel-protocol';
import type { SketchOutput } from '../../types/sketch';
import { ToolError } from '../errors';
import { andList, bodyText, createdLabels, editTarget, fillFeature, nameFor, partOf, str, strings } from '../feature-tools';
import { registerFeatureIo } from '../features-io';
import { bodyWords } from '../judge';
import { modelId, quoteName, storedId } from '../labels';
import { stateWord } from '../model';
import { len } from '../numbers';
import { regionPointNow } from '../region-tools';
import { runtimeOf } from '../runtime';
import { regionRefOf } from '../selectors/refs';
import { echo, selectSet, withScene, type RegionHit } from '../selectors/resolve';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';
import { closestName, closestWords } from '../closest';

type Kind = 'sweep' | 'loft';
const KINDS: readonly Kind[] = ['sweep', 'loft'];
const OPS: readonly BodyOp[] = ['new', 'join', 'cut', 'intersect'];
const ORIENTATIONS: readonly SweepFeature['orientation'][] = ['follow', 'fixed'];
/** The schema's most profiles, and so the most get_model writes back. */
const PROFILES_MAX = 12;
const BODY_NAME_MAX = 40;
const COLOR = /^#[0-9a-f]{6}$/i;

/** One profile as the answer gives it. */
interface ProfileRow {
  sketch: string;
  region: string;
  area_mm2: number;
  holes: number;
}

interface Plan extends EditPlan {
  kind: Kind;
  edit: FeatureId | null;
  name: string | null;
  fields: Partial<Feature>;
  op: BodyOp;
  /** op new: the body's name and colour, set after the Done (null keeps them). */
  bodyName: string | null;
  color: string | null;
  profiles: ProfileRow[];
  /** A sweep's path: its sketch and its curves (the model's ids). */
  path: { sketch: string; curves: string[] } | null;
  warnings: string[];
}

const sketches = (s: DocState) => s.doc.features.filter((f): f is SketchFeature => f.type === 'sketch');
const indexOf = (s: DocState, id: FeatureId) => s.doc.features.findIndex((f) => f.id === id);

/** The words of a refused one-shot body edit (the body tool's rule). */
function refused(field: string, r: EditResult): ToolError {
  const reason = r.ok ? '' : r.reason;
  if (/already called/.test(reason)) return new ToolError('name_taken', `${field}: ${reason}.`, { detail: { field } });
  return new ToolError('bad_input', `${field}: ${reason}.`, { detail: { field } });
}

// ------------------------------------------------------------------ the path

/** "<sketch>" or "<sketch>: l1, a2" (the sketch's name may be in quotes): the sketch, and the ids listed (null: all). */
function splitPath(s: DocState, text: string): { sketch: SketchFeature; list: string[] | null } {
  const all = sketches(s);
  let sketch: SketchFeature | undefined;
  let rest = '';
  let head = text;
  if (text.startsWith('"')) {
    let name = '';
    let i = 1;
    for (; i < text.length && text[i] !== '"'; i++) name += text[i] === '\\' && i + 1 < text.length ? text[++i] : text[i];
    if (i >= text.length) throw new ToolError('bad_input', 'path: a quote is not closed.', { detail: { field: 'path' } });
    head = name;
    sketch = all.find((f) => f.name.toLowerCase() === name.toLowerCase());
    rest = text.slice(i + 1);
  } else {
    const lower = text.toLowerCase();
    // The longest sketch name the text starts with, followed by its end, a space or ':'.
    sketch = all
      .filter((f) => {
        const n = f.name.toLowerCase();
        return lower.startsWith(n) && (lower.length === n.length || /[\s:]/.test(lower[n.length]));
      })
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (sketch) rest = text.slice(sketch.name.length);
    else head = text.split(':')[0].trim();
  }
  if (!sketch) {
    const names = all.map((f) => f.name);
    const near = closestName(head, names);
    throw new ToolError('not_found', `path: no sketch is called "${head}".${closestWords(near)} Sketches: ${names.length ? names.slice(0, 30).join(', ') : 'none yet'}.`, { detail: { field: 'path', names: names.slice(0, 30), ...(near ? { closest: near } : {}) } });
  }
  rest = rest.trim();
  if (!rest) return { sketch, list: null };
  if (!rest.startsWith(':')) {
    throw new ToolError('bad_input', `path: "${text}" reads as the sketch ${sketch.name}, then "${rest}": write "<sketch>" (all its curves) or "<sketch>: l1, a2".`, { detail: { field: 'path' } });
  }
  const list = rest
    .slice(1)
    .split(',')
    .map((x) => x.trim());
  if (list.some((x) => !x)) throw new ToolError('bad_input', `path: name the curves after ":" separated by commas (${quoteName(sketch.name)}: l1, a2), or leave ":" off for every curve of it.`, { detail: { field: 'path' } });
  return { sketch, list };
}

/** The curves of a built sketch a path takes: every one (null), or those listed (a macro's id takes its pieces). */
function pathCurves(s: DocState, sketch: SketchFeature, list: string[] | null): SketchCurve[] {
  const out = s.rebuild.outputs[sketch.id] as SketchOutput | undefined;
  if (!out || out.type !== 'sketch') {
    throw new ToolError('not_found', `path: ${sketch.name} is not built (it is ${stateWord(s.rebuild.features[sketch.id])}): fix it first.`, { detail: { field: 'path', feature: sketch.name } });
  }
  const curves = out.curves.filter((c) => c.kind !== 'point');
  if (!curves.length) throw new ToolError('bad_input', `path: ${sketch.name} has no curves for a path (construction lines and points are not one).`, { detail: { field: 'path' } });
  if (list === null) return curves;
  const names = curves.map((c) => modelId(c.id));
  const picked: SketchCurve[] = [];
  const missing: string[] = [];
  const notCurves: string[] = [];
  for (const id of list) {
    const want = [id.toLowerCase(), storedId(id).toLowerCase()];
    const exact = curves.filter((c) => want.includes(c.id.toLowerCase()));
    const parts = exact.length ? exact : curves.filter((c) => c.id.toLowerCase().startsWith(`${want[0]}__`));
    if (parts.length) {
      for (const c of parts) if (!picked.includes(c)) picked.push(c);
    } else if (sketch.entities.some((e) => want.includes(e.id.toLowerCase()))) notCurves.push(id);
    else missing.push(id);
  }
  if (missing.length) {
    throw new ToolError('not_found', `path: ${sketch.name} has no curve ${andList(missing)}. Its curves: ${names.slice(0, 40).join(', ')}.`, { detail: { field: 'path', curves: names.slice(0, 40) } });
  }
  if (notCurves.length) {
    throw new ToolError('bad_input', `path: ${andList(notCurves)} of ${sketch.name} ${notCurves.length === 1 ? 'is' : 'are'} construction or a point, not a curve of a path. Its curves: ${names.slice(0, 40).join(', ')}.`, { detail: { field: 'path', curves: names.slice(0, 40) } });
  }
  return picked;
}

const sweepLoft: EditTool<Plan> = {
  async plan(ctx) {
    const { services } = ctx;
    const s = services.doc.state.get();
    const kind = ctx.input.kind as Kind;
    const op = ctx.input.op as BodyOp;
    const problems: string[] = [];
    if (!KINDS.includes(kind)) problems.push('kind: sweep or loft');
    if (!OPS.includes(op)) problems.push('op: new, join, cut or intersect');
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });
    const editing = editTarget(services, ctx.input.edit, [kind], kind, (f) => (KINDS.includes(f.type as Kind) ? `send kind ${f.type} to change it` : null));
    const name = nameFor(services, ctx.input.name, editing);
    const profilesIn = strings(ctx.input.profiles);
    const pathIn = str(ctx.input.path);
    const orientation = (ctx.input.orientation ?? 'follow') as SweepFeature['orientation'];
    const ruled = ctx.input.ruled === true;
    const bodiesIn = strings(ctx.input.bodies);
    const bodyName = str(ctx.input.body_name);
    const color = str(ctx.input.color).toLowerCase();
    if (kind === 'sweep') {
      if (!profilesIn.length) problems.push('profiles: the region to sweep ("<sketch>", "<sketch> r2" or "<sketch> at(u, v)")');
      if (!pathIn) problems.push('path: the curves to sweep along, in another sketch ("<sketch>" or "<sketch>: l1, a2")');
      if (!ORIENTATIONS.includes(orientation)) problems.push('orientation: follow or fixed');
      if (ruled) problems.push('ruled: only a loft has flat sides; send false');
    } else {
      if (profilesIn.length < 2) problems.push('profiles: a loft takes two or more regions, one per sketch, in order');
      if (pathIn) problems.push('path: "" for a loft (it goes through its profiles; a path is a sweep\'s)');
    }
    if (profilesIn.length > PROFILES_MAX) problems.push(`profiles: at most ${PROFILES_MAX}`);
    profilesIn.forEach((t, i) => {
      if (!t) problems.push(`profiles[${i}]: a region, not ""`);
    });
    bodiesIn.forEach((t, i) => {
      if (!t) problems.push(`bodies[${i}]: a body, not ""`);
    });
    if (op === 'new' && bodiesIn.length) problems.push('bodies: [] with op new (only join, cut and intersect act on bodies)');
    if (op !== 'new' && bodyName) problems.push('body_name: only op new makes a body; send ""');
    if (op !== 'new' && color) problems.push('color: only op new makes a body; send ""');
    if (color && !COLOR.test(color)) problems.push(`color: "${color}" is not #rrggbb`);
    if (bodyName.length > BODY_NAME_MAX) problems.push(`body_name: at most ${BODY_NAME_MAX} characters`);
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });
    // A body name another body has (a feature's name is allowed: the grammar tells them apart).
    const own = editing && isBodyMaking(editing) ? editing.creates : null;
    if (bodyName) {
      const taken = [...Object.entries(s.doc.bodies).map(([id, b]) => ({ id, name: b.name })), ...s.rebuild.bodies.map((b) => ({ id: b.id, name: b.name }))].find((b) => b.id !== own && b.name.toLowerCase() === bodyName.toLowerCase());
      if (taken) throw new ToolError('name_taken', `body_name: another body is already called ${taken.name}.`, { detail: { field: 'body_name' } });
    }

    // The path first (its words need no geometry), then the profiles and bodies on one scene.
    const path = kind === 'sweep' ? splitPath(s, pathIn) : null;
    const self = editing?.id ?? null;
    const r = await withScene(ctx, { before: self, self }, async (sc) => {
      const refs: RegionRef[] = [];
      const rows: ProfileRow[] = [];
      const echoes: string[] = [];
      const warnings: string[] = [];
      const sketchOf: { sketch: SketchFeature; field: string }[] = [];
      for (const [i, t] of profilesIn.entries()) {
        const field = `profiles[${i}]`;
        const sel = await selectSet(sc, t, 'region', field);
        const hits = sel.hits.filter((h): h is RegionHit => h.kind === 'region');
        if (!hits.length) throw new ToolError('bad_selector', `${field}: "${t}" names no region: write "<sketch>", "<sketch> r2" or "<sketch> at(u, v)".`, { detail: { field, selector: t } });
        if (kind === 'loft' && hits.length > 1) {
          const sk = quoteName(hits[0].sketch.name);
          throw new ToolError('bad_input', `${field}: "${t}" names ${hits.length} regions of ${hits[0].sketch.name} (${hits.map((h) => h.row.id).join(', ')}): a loft takes one region per sketch; name one ("${sk} ${hits[0].row.id}" or "${sk} at(u, v)").`, {
            detail: { field, regions: hits.slice(0, 30).map((h) => ({ id: h.row.id, area_mm2: h.row.area_mm2, at: h.row.at, holes: h.row.holes })) },
          });
        }
        for (const h of hits) {
          const ref = regionRefOf(sc, h);
          if (refs.some((x) => x.sketch === ref.sketch && x.region === ref.region)) continue;
          refs.push(ref);
          rows.push({ sketch: h.sketch.name, region: h.row.id, area_mm2: h.row.area_mm2, holes: h.row.holes });
        }
        sketchOf.push({ sketch: hits[0].sketch, field });
        echoes.push(echo(sc, sel));
        for (const w of sel.warnings) if (!warnings.includes(w)) warnings.push(w);
      }
      const scope: BodyId[] = [];
      for (const [i, t] of bodiesIn.entries()) {
        const sel = await selectSet(sc, t, 'body', `bodies[${i}]`);
        for (const h of sel.hits) if (h.kind === 'body' && !scope.includes(h.body.id)) scope.push(h.body.id);
      }
      const scopeNames = scope.map((id) => sc.bodies.find((b) => b.id === id)?.name ?? id);
      return { refs, rows, echoes, warnings, sketchOf, scope, scopeNames };
    });

    const resolved: Record<string, string> = { profiles: r.echoes.join('; ') };
    let fields: Partial<SweepFeature> | Partial<LoftFeature>;
    let pathOut: Plan['path'] = null;
    if (kind === 'sweep') {
      const inSketches = [...new Set(r.sketchOf.map((x) => x.sketch.name))];
      if (inSketches.length > 1) throw new ToolError('bad_input', `profiles: a sweep's profiles are regions of one sketch; these are in ${andList(inSketches)}.`, { detail: { field: 'profiles', sketches: inSketches } });
      const profileSketch = r.sketchOf[0].sketch;
      const p = path!;
      if (p.sketch.id === profileSketch.id) throw new ToolError('bad_input', `path: ${p.sketch.name} holds the profile: draw the path in another sketch.`, { detail: { field: 'path' } });
      if (editing && indexOf(s, p.sketch.id) > indexOf(s, editing.id)) {
        throw new ToolError('later_feature', `path: ${p.sketch.name} comes after ${editing.name} in the history: pick a sketch made before it.`, { detail: { field: 'path', feature: p.sketch.name } });
      }
      const curves = pathCurves(s, p.sketch, p.list);
      pathOut = { sketch: p.sketch.name, curves: curves.map((c) => modelId(c.id)) };
      // A B-spline is a spline, or the ellipse, parabola or conic it stands for.
      const kinds = curves.map((c) => (c.kind === 'bspline' ? (p.sketch.entities.find((x) => x.id === c.id)?.kind ?? 'spline') : c.kind));
      resolved.path = `${pathIn} -> ${curves.length === 1 ? `${kinds[0]} ${pathOut.curves[0]}` : `${curves.length} curves (${pathOut.curves.map((c, i) => `${kinds[i]} ${c}`).join(', ')})`} of ${p.sketch.name}`;
      resolved.orientation = orientation === 'follow' ? 'follow (the profile turns with the path)' : 'fixed (the profile keeps its orientation)';
      fields = { profiles: r.refs, path: { sketch: p.sketch.id, entities: curves.map((c) => c.id) }, orientation, op, scope: op === 'new' ? [] : r.scope };
    } else {
      const seen = new Map<FeatureId, string>();
      for (const x of r.sketchOf) {
        const was = seen.get(x.sketch.id);
        if (was) throw new ToolError('bad_input', `profiles: a loft takes one region per sketch; ${x.sketch.name} is in ${was} and ${x.field}.`, { detail: { field: x.field, sketch: x.sketch.name } });
        seen.set(x.sketch.id, x.field);
      }
      resolved.ruled = ruled ? 'true (flat sides)' : 'false (smooth sides)';
      fields = { sections: r.refs, ruled, op, scope: op === 'new' ? [] : r.scope };
    }
    resolved.op = op === 'new' ? `new body${bodyName ? ` ${bodyName}` : ''}` : `${op} ${r.scope.length ? andList(r.scopeNames) : 'every body it meets'}`;
    if (editing) resolved.edit = editing.name;
    // The dry run: the feature as its type checks it, before anything changes.
    const def = services.doc.features.get(kind)!;
    const draft = { ...(editing ?? def.create(s.doc, {})), ...fields } as Feature;
    const why = def.incomplete(draft, services.doc.units);
    if (why) throw new ToolError('bad_input', `${why}.`);
    const label = def.label ?? kind;
    return {
      part: partOf(services, kind, name ?? editing?.name ?? label, !!editing),
      value: false,
      own: editing?.id ?? null,
      feature: editing?.id ?? null,
      resolved,
      kind,
      edit: editing?.id ?? null,
      name,
      fields: fields as Partial<Feature>,
      op,
      bodyName: op === 'new' && bodyName ? bodyName : null,
      color: op === 'new' && color ? color : null,
      profiles: r.rows,
      path: pathOut,
      warnings: r.warnings,
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { services } = ctx;
    const { doc } = services;
    const editName = plan.edit ? doc.state.get().doc.features.find((f) => f.id === plan.edit)?.name : null;
    const label = plan.name ?? editName ?? services.doc.features.get(plan.kind)?.label ?? plan.kind;
    const id = await fillFeature(ctx, plan, { edit: plan.edit, type: plan.kind, fields: plan.name ? { ...plan.fields, name: plan.name } : plan.fields, label });
    const made = doc.state.get().doc.features.find((f) => f.id === id);
    if (made) plan.part = partOf(services, plan.kind, made.name, !!plan.edit);
    // op new: the body's name and colour, the Part's own one-shot edits, in this same step.
    const body = made && isBodyMaking(made) && made.op === 'new' ? made.creates : null;
    if (!body || (plan.bodyName === null && plan.color === null)) return;
    await ctx.checkpoint({ hold: 'between-opens', label });
    const now = doc.state.get().doc.bodies[body];
    if (plan.bodyName !== null && now?.name !== plan.bodyName) {
      const r = ctx.step.run(() => doc.renameBody(body, plan.bodyName!));
      if (!r.ok) throw refused('body_name', r);
    }
    if (plan.color !== null && now?.color?.toLowerCase() !== plan.color) {
      const r = ctx.step.run(() => doc.setBodyColor(body, plan.color!));
      if (!r.ok) throw refused('color', r);
    }
    await ctx.checkpoint({ label });
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
    const name = f?.name ?? plan.name ?? plan.kind;
    const regions = (rows: ProfileRow[]) => rows.map((p) => `${p.sketch} ${p.region}`);
    const what = plan.kind === 'sweep' ? `${andList(regions(plan.profiles))} along ${plan.path!.sketch} (${plan.path!.curves.join(', ')})` : `through ${regions(plan.profiles).join(', ')}`;
    const text = `${name} ${data.feature?.state ?? 'ok'}${plan.edit ? ' (replaced)' : ''}: ${what}${body ? ` · ${body}` : ''}`;
    return {
      text,
      summary: text,
      data: {
        ...data,
        created: created.labels,
        ...(created.more ? { created_more: created.more } : {}),
        warnings: [...plan.warnings, ...data.warnings].slice(0, 20),
        kind: plan.kind,
        profiles: plan.profiles,
        ...(plan.path ? { path: plan.path } : {}),
      },
    };
  },
};

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx: CallCtx) => runEdit(ctx, sweepLoft),
};

// ------------------------------------------------------------------ get_model full

/** A region a feature keeps as a profile selector: "<sketch> at(u, v)", at the point inside it now (region-tools.ts regionPointNow). */
function regionText(s: DocState, r: RegionRef): string {
  const sketch = s.doc.features.find((f) => f.id === r.sketch);
  const at = regionPointNow(s, r);
  return `${quoteName(sketch?.name ?? r.sketch)} at(${len(at[0])}, ${len(at[1])})`;
}

/** A sweep's path as the path field writes it: "<sketch>: l1, a2" ("<sketch>" for every curve of it). */
function pathText(s: DocState, p: NonNullable<SweepFeature['path']>): string {
  const name = quoteName(s.doc.features.find((f) => f.id === p.sketch)?.name ?? p.sketch);
  return p.entities.length ? `${name}: ${p.entities.map(modelId).join(', ')}` : name;
}

/** op, bodies, body_name and color as the tool takes them back. */
function opFields(services: AppServices, f: { op: BodyOp; scope: BodyId[] }) {
  const s = services.doc.state.get();
  return { op: f.op, bodies: f.op === 'new' ? [] : f.scope.map((id) => bodyText(s, id)), body_name: '', color: '' };
}

registerFeatureIo('sweep', {
  tool: 'sweep_loft',
  inputsOf(f, services) {
    const g = f as SweepFeature;
    const s = services.doc.state.get();
    if (!g.path || !g.profiles.length || g.profiles.length > PROFILES_MAX) return null;
    return { edit: g.name, name: '', kind: 'sweep', profiles: g.profiles.map((r) => regionText(s, r)), path: pathText(s, g.path), orientation: g.orientation, ruled: false, ...opFields(services, g) };
  },
  values: () => [],
  pathOf: () => null,
});

registerFeatureIo('loft', {
  tool: 'sweep_loft',
  inputsOf(f, services) {
    const g = f as LoftFeature;
    const s = services.doc.state.get();
    if (g.sections.length < 2 || g.sections.length > PROFILES_MAX) return null;
    return { edit: g.name, name: '', kind: 'loft', profiles: g.sections.map((r) => regionText(s, r)), path: '', orientation: 'follow', ruled: !!g.ruled, ...opFields(services, g) };
  },
  values: () => [],
  pathOf: () => null,
});
