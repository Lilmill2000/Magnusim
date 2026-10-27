// hole: round holes drilled into one flat face in one call (CAD tools spec §3.2.18). The face is
// one face selector whose outward normal runs along X, Y or Z (within 1 degree); the centres are
// model coordinates as expressions, "" for the one along the face's normal (or that coordinate
// as the face lies); each centre must lie within half the diameter of the face. In one step:
//   1. the sketch "<name> sketch" on the face (its frame: help sketch, planes and faces): circles
//      h1, h2, ... at the centres; the diameter on h1 (dimension d) and h2... equal to it (eq2...);
//      each centre placed from the sketch origin (the model origin projected onto the face) with
//      distance_x hkx and distance_y hky, each the model expression of the axis u or v runs along,
//      written "-(...)" where it runs against it (on a -X face v runs -Z, so z "b/2" is
//      hky "-(b/2)"). Fully defined, so the holes follow their parameters;
//   2. the extrude "<name>": all the circles cut into the face's body only, against the face's
//      outward normal (flip: into the material), through that body or blind `distance` deep.
// Every refusal comes before anything changes, each kind of problem all at once: the fields
// (bad_input), the expressions (expr_error), then where the centres are (bad_input: off the
// face's plane, outside the face, the same centre twice). A centre within half the diameter of the
// face that is off it, or nearer one of its edges than that, cuts a notch: a warning names it
// (measured against the face's edges, at most EDGE_MEASURES_MAX measures). A cut that removes
// nothing answers cut_removed_nothing with the diagnosis (region-tools.ts).
// get_model full shows the two features as sketch and extrude inputs, with made_by "hole"; the
// model changes them as such (edit_feature on the sketch's d changes every hole).
// The person's Hole panel (features/hole) runs this same plan (planHole) and stores the same two
// features (holeCutFields), so a hole either made is the other's: editable either way.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_DISTANCE } from '../../features/extrude/def';
import { faceFrame, ydirOf } from '../../features/sketch/plane';
import { nextName } from '../../lib/ids';
import { isDimension } from '../../sketch/model';
import type { AppServices } from '../../types/app';
import type { CallCtx, EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { BodyId, ExtrudeExtentDef, Feature, FeatureId, PlaneFrame, RegionRef, SketchFeature, SketchSupport, Vec3 } from '../../types/doc';
import type { UnitsService } from '../../types/units';
import { heartbeat } from '../busy';
import { ToolError } from '../errors';
import { createdLabels, NAME_MAX, str } from '../feature-tools';
import { bodyWords } from '../judge';
import { setMadeWith } from '../made-with';
import { frameWords } from '../model';
import { dir, len, vec } from '../numbers';
import { checkScoped, fillSwept, regionsOf } from '../region-tools';
import { runtimeOf } from '../runtime';
import { dot, sub, unit } from '../selectors/geometry';
import { faceRefOf } from '../selectors/refs';
import { faceLabel, hitWords, selectOne, withScene } from '../selectors/resolve';
import { compileSketch, storeExpr, type Compiled, type ConstraintIn, type EntityIn } from '../sketch/compile';
import { JOIN_TOL } from '../sketch/macros';
import { solveSketch, type Solved } from '../sketch/solve';
import { writeSketch } from '../sketch/write';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';

/** The schema's most centres. */
export const CENTERS_MAX = 24;
/** A face's normal (and its frame's u and v) within this of a model axis is along it. */
const COS1 = Math.cos(Math.PI / 180);
/** A centre's coordinate along the normal this close to the face's plane is on it (mm). */
export const ON_PLANE_MM = 1e-4;
/** The most kernel measures of centres against the face's edges (the notch warning); past it a centre is not checked. */
export const EDGE_MEASURES_MAX = 200;
const SKETCH_SUFFIX = ' sketch';
/** The longest name: its sketch is "<name> sketch", within the Part's name rule. */
export const HOLE_NAME_MAX = NAME_MAX - SKETCH_SUFFIX.length;

const AXES = ['x', 'y', 'z'] as const;

export interface HolePlan extends EditPlan {
  /** The extrude's name, and the sketch's ("<name> sketch"). */
  name: string;
  sketchName: string;
  support: SketchSupport;
  body: BodyId;
  bodyName: string;
  faceWords: string;
  frame: PlaneFrame;
  compiled: Compiled;
  solved: Solved;
  extent: ExtrudeExtentDef;
  /** The centres in model mm, as asked (on the face's plane). */
  centers: Vec3[];
  diameter: number;
  /** blind: the depth in mm; through: null. */
  depth: number | null;
  warnings: string[];
  /** Warnings found after the Done (a scoped cut that missed a body). */
  late: string[];
  /** The sketch made (set by apply). */
  sketch: FeatureId | null;
}

/** The model axis a direction runs along within 1 degree, and which way; or null. */
function axisOf(v: readonly number[]): { i: 0 | 1 | 2; sign: 1 | -1 } | null {
  const u = unit([...v]);
  for (const i of [0, 1, 2] as const) if (Math.abs(u[i]) >= COS1) return { i, sign: u[i] > 0 ? 1 : -1 };
  return null;
}

const axisName = (a: { i: number; sign: number }) => `${a.sign > 0 ? '+' : '-'}${AXES[a.i].toUpperCase()}`;

/** Whether the "(" at `open` closes at the last character of `t`. */
function wrapsAll(t: string, open: number): boolean {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') {
      depth--;
      if (depth === 0) return i === t.length - 1;
    }
  }
  return false;
}

/** An expression negated, as plainly as it reads: "12 mm" -> "-12 mm", "-(b/2)" -> "b/2", "w/2" -> "-(w/2)". */
export function negated(expr: string): string {
  const t = expr.trim();
  const num = /^([-+]?)\s*((?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(\s*[a-zA-Z]+)?$/.exec(t);
  if (num) {
    if (Number(num[2]) === 0) return `${num[2]}${num[3] ?? ''}`;
    return `${num[1] === '-' ? '' : '-'}${num[2]}${num[3] ?? ''}`;
  }
  if (t.startsWith('-(') && wrapsAll(t, 1)) return t.slice(2, -1).trim();
  return `-(${t})`;
}

/** The names the call makes: the extrude's and its sketch's, both free (any case). */
function holeNames(services: AppServices, asked: unknown): { name: string; sketch: string } {
  const features = services.doc.state.get().doc.features;
  const taken = (n: string) => features.find((f) => f.name.toLowerCase() === n.toLowerCase()) ?? null;
  const want = str(asked);
  if (want) {
    if (want.length > HOLE_NAME_MAX) throw new ToolError('bad_input', `name: at most ${HOLE_NAME_MAX} characters (its sketch is "<name>${SKETCH_SUFFIX}").`, { detail: { field: 'name' } });
    const a = taken(want);
    if (a) throw new ToolError('name_taken', `name: another feature is already called ${a.name}.`, { detail: { field: 'name' } });
    const b = taken(`${want}${SKETCH_SUFFIX}`);
    if (b) throw new ToolError('name_taken', `name: the holes' sketch would be "${want}${SKETCH_SUFFIX}", and another feature is already called ${b.name}.`, { detail: { field: 'name' } });
    return { name: want, sketch: `${want}${SKETCH_SUFFIX}` };
  }
  let k = Number(nextName('Hole', features.map((f) => f.name)).slice('Hole '.length));
  while (taken(`Hole ${k}`) || taken(`Hole ${k}${SKETCH_SUFFIX}`)) k++;
  return { name: `Hole ${k}`, sketch: `Hole ${k}${SKETCH_SUFFIX}` };
}

/** "Hole 1", "Holes Bolt circle": the call's part in the undo label and the ledger. */
const partOf = (name: string) => (/^holes?\b/i.test(name) ? name : `Holes ${name}`);

/** A length expression's value (mm), or null with the problem noted. */
function lengthOf(units: UnitsService, text: string, field: string, problems: string[]): number | null {
  const r = units.evaluate(text, 'length');
  if (!r.ok) {
    problems.push(`${field}: ${r.error}`);
    return null;
  }
  return r.value;
}

/** A value and, when it is no plain number, what it comes to: "hd (5 mm)". */
const valueWords = (text: string, mm: number) => (/^[-+]?[\d.]+\s*(mm)?$/.test(text.trim()) ? text.trim() : `${text.trim()} (${len(mm)} mm)`);

const at = (p: readonly number[]) => `(${p.map((v) => len(v)).join(', ')})`;

type Plan = HolePlan;

/** The cut extrude's fields for the holes' sketch regions: every circle, into the face's body only, into the material. */
export function holeCutFields(plan: HolePlan, profiles: readonly RegionRef[]): Partial<Feature> {
  return { name: plan.name, profiles: [...profiles], extent: plan.extent, flip: true, op: 'cut', scope: [plan.body] } as Partial<Feature>;
}

const holeTool: EditTool<Plan> = {
  async plan(ctx) {
    const { services } = ctx;
    const units = services.doc.units;
    const input = ctx.input;
    const faceIn = str(input.face);
    const depth = input.depth;
    const distance = str(input.distance);
    const diameter = str(input.diameter);
    const rows = (Array.isArray(input.centers) ? input.centers : []) as unknown[];

    // ---- the fields
    const problems: string[] = [];
    if (!faceIn) problems.push('face: one flat face facing along X, Y or Z ("Plate.end", "Body 1 faces >Z")');
    if (!rows.length) problems.push('centers: at least one centre');
    if (rows.length > CENTERS_MAX) problems.push(`centers: at most ${CENTERS_MAX} (call hole again for more)`);
    if (!diameter) problems.push('diameter: an expression such as "5 mm" or "hd"');
    if (depth !== 'through' && depth !== 'blind') problems.push('depth: through or blind');
    if (depth === 'through' && distance) problems.push(`distance: "" with depth through (the holes go through the face's body)`);
    if (depth === 'blind' && !distance) problems.push('distance: the depth, such as "6 mm" or "t"');
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });
    const names = holeNames(services, input.name);

    const found = await withScene(ctx, {}, async (sc) => {
      // ---- the face: one, flat, facing along an axis
      const { hit } = await selectOne(sc, faceIn, 'face', 'face');
      if (hit.kind !== 'face') throw new ToolError('bad_selector', `face: "${faceIn}" names ${hit.kind === 'body' ? 'a body' : `a ${hit.kind}`}, not one face.`, { detail: { field: 'face', selector: faceIn } });
      const label = faceLabel(sc, hit) ?? hitWords(sc, hit);
      const t = hit.topo;
      if (t.type !== 'plane' || !t.normal || !t.centroid) {
        throw new ToolError('not_flat', `face: ${label} is ${t.type === 'cylinder' ? 'round' : 'curved'}: hole drills into one flat face.`, { hint: 'Pick one flat face facing along X, Y or Z: find "<body> faces +Z" lists them.', detail: { field: 'face' } });
      }
      const n = unit([...t.normal]) as Vec3;
      const along = axisOf(n);
      if (!along) {
        throw new ToolError('bad_input', `face: ${label} faces (${dir(n).join(', ')}); hole needs a face facing along X, Y or Z: use sketch on it and extrude cut.`, {
          hint: 'Sketch the circles on that face (sketch on it), then extrude them with op cut and flip true.',
          detail: { field: 'face', normal: dir(n) },
        });
      }
      const ref = await faceRefOf(sc, hit);
      const c = [...t.centroid] as Vec3;
      const k = along.i;
      const A = AXES[k];
      const inPlane = AXES.filter((_, i) => i !== k);
      const facing = `${label} faces ${axisName(along)}: give ${inPlane.join(' and ')}, ${A} ""`;

      // ---- the centres, read: every missing coordinate, then every expression problem, at once
      const missing: string[] = [];
      const exprs: string[] = [];
      const D = lengthOf(units, diameter, 'diameter', exprs);
      const deep = depth === 'blind' ? lengthOf(units, distance, 'distance', exprs) : null;
      const read = rows.map((row, r) => {
        const cIn = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
        const p: (number | null)[] = [null, null, null];
        const texts = ['', '', ''];
        AXES.forEach((a, i) => {
          const text = str(cIn[a]);
          const field = `centers[${r}].${a}`;
          if (!text) {
            if (i !== k) missing.push(`${field}: the centre's ${a.toUpperCase()} is needed (${facing})`);
            return;
          }
          p[i] = lengthOf(units, text, field, exprs);
          texts[i] = storeExpr(text, 'length', units);
        });
        return { p, texts };
      });
      if (missing.length) throw new ToolError('bad_input', `${missing.slice(0, 12).join('; ')}.`, { detail: { field: missing[0].split(':')[0], problems: missing.slice(0, 12) } });
      if (exprs.length) throw new ToolError('expr_error', `${exprs.slice(0, 12).join('; ')}.`, { detail: { field: exprs[0].split(':')[0], problems: exprs.slice(0, 12) } });

      // ---- where they are: on the face's plane, on the face, each once
      const where: string[] = [];
      if (!(D! > 0)) where.push(`diameter: more than 0 (it is ${len(D!)} mm)`);
      if (deep !== null && !(deep > 0)) where.push(`distance: more than 0 (it is ${len(deep)} mm)`);
      const centers: Vec3[] = [];
      for (const [r, row] of read.entries()) {
        const p = row.p as number[];
        if (row.p[k] === null) {
          // On the face's plane: the coordinate along the normal from the other two.
          let rest = dot(n, c);
          for (const i of [0, 1, 2]) if (i !== k) rest -= n[i] * p[i];
          p[k] = rest / n[k];
        } else {
          const off = dot(n, sub(p as Vec3, c));
          if (Math.abs(off) > ON_PLANE_MM) where.push(`centers[${r}].${A}: ${len(p[k])} mm is not on ${label}, which lies at ${A} = ${len(c[k])} mm: send "" for ${A}`);
        }
        centers.push([p[0], p[1], p[2]]);
      }
      const warnings = [...hit.warnings];
      if (D! > 0) {
        // The face's own edges (its outer boundary and any hole in it), for a hole that breaks one.
        const t = await sc.cache.topo(hit.body.shape, { faces: hit.body.faces, signal: sc.signal });
        const edges = t.edges.filter((e) => e.type !== 'degenerate' && e.faces.includes(hit.index));
        let measures = EDGE_MEASURES_MAX;
        for (const [r, p] of centers.entries()) {
          if (where.some((w) => w.startsWith(`centers[${r}].`))) continue;
          const m = await sc.services.kernel.call('measure', { a: { id: hit.body.shape, face: hit.index }, b: { point: p } });
          const d = m.result.distance ?? Infinity;
          if (d >= D! / 2 - 1e-6) {
            where.push(`centers[${r}] ${at(p)} is ${Number.isFinite(d) ? `${len(d)} mm` : 'far'} outside ${label} (a hole ${len(D!)} mm across needs its centre within ${len(D! / 2)} mm of the face)`);
            continue;
          }
          if (warnings.length >= 8) continue;
          // Within half the diameter but off the face, or on it nearer an edge than that: a notch, not a round hole.
          if (d > ON_PLANE_MM) {
            warnings.push(`centers[${r}] ${at(p)} is ${len(d)} mm outside ${label}: the hole ${len(D!)} mm across breaks its edge (a notch)`);
            continue;
          }
          if (measures < edges.length) continue;
          measures -= edges.length;
          let near = Infinity;
          for (const e of edges) {
            const em = await sc.services.kernel.call('measure', { a: { id: hit.body.shape, edge: e.i }, b: { point: p } });
            near = Math.min(near, em.result.distance ?? Infinity);
          }
          if (near < D! / 2 - 1e-6) warnings.push(`centers[${r}] ${at(p)} is ${len(near)} mm from an edge of ${label}: the hole ${len(D!)} mm across breaks that edge (a notch)`);
        }
      }
      for (let a = 0; a < centers.length; a++) {
        for (let b = a + 1; b < centers.length; b++) {
          const gap = Math.hypot(...sub(centers[a], centers[b]));
          if (gap <= JOIN_TOL) where.push(`centers[${b}] is the same centre as centers[${a}] ${at(centers[a])}`);
          else if (D! > 0 && gap < D! && warnings.length < 8) warnings.push(`centers[${a}] and centers[${b}] overlap: ${len(gap)} mm apart, the holes are ${len(D!)} mm across`);
        }
      }
      if (where.length) throw new ToolError('bad_input', `${where.slice(0, 12).join('; ')}.`, { detail: { field: where[0].split(/[: ]/)[0], face: label, problems: where.slice(0, 12) } });

      // ---- the sketch's u and v: each runs along a model axis, its expression signed to match
      const frame = faceFrame(n, c);
      const uAx = axisOf(frame.xdir)!;
      const vAx = axisOf(ydirOf(frame))!;
      const signed = (texts: string[], ax: { i: number; sign: number }) => (ax.sign > 0 ? texts[ax.i] : negated(texts[ax.i]));
      const uv = centers.map((p, r) => {
        const d = sub(p, frame.origin as Vec3);
        return { u: dot(d, frame.xdir as Vec3), v: dot(d, ydirOf(frame)), hx: signed(read[r].texts, uAx), hy: signed(read[r].texts, vAx) };
      });
      return { label, along, ref, frame, centers, uv, D: D!, deep, warnings, body: hit.body.id, bodyName: hit.body.name };
    });

    // ---- the sketch, compiled and solved headless before anything changes
    const entities: EntityIn[] = found.uv.map((h, r) => ({ id: `h${r + 1}`, kind: 'circle', at: [h.u, h.v, found.D / 2], construction: false }));
    const constraints: ConstraintIn[] = [
      { id: 'd', kind: 'diameter', refs: ['h1'], value: storeExpr(diameter, 'length', units) },
      ...entities.slice(1).map((e) => ({ id: `eq${e.id.slice(1)}`, kind: 'equal', refs: ['h1', e.id], value: '' })),
      ...entities.flatMap((e, r) => [
        { id: `${e.id}x`, kind: 'distance_x', refs: ['origin', `${e.id}.center`], value: found.uv[r].hx },
        { id: `${e.id}y`, kind: 'distance_y', refs: ['origin', `${e.id}.center`], value: found.uv[r].hy },
      ]),
    ];
    const compiled = compileSketch({ entities, constraints, infer: false }, { units, stored: null });
    const solved = await solveSketch(ctx, { ...compiled, geometry: compiled.draft });
    if (solved.state !== 'fully') throw new ToolError('internal', `The holes' sketch is not fully defined (dof ${solved.dof}).`);

    const extent: ExtrudeExtentDef = depth === 'blind' ? { kind: 'blind', distance: storeExpr(distance, 'length', units) } : { kind: 'through_all', both: false, distance: DEFAULT_DISTANCE[units.units().length] ?? '10 mm' };
    const n = found.centers.length;
    return {
      part: partOf(names.name),
      value: false,
      own: null,
      feature: null,
      resolved: {
        face: `${found.label} (faces ${axisName(found.along)})`,
        frame: frameWords(found.frame),
        centers: `${n} ${n === 1 ? 'centre' : 'centres'}: ${found.centers.slice(0, 4).map(at).join(', ')}${n > 4 ? ` and ${n - 4} more` : ''}`,
        diameter: valueWords(diameter, found.D),
        depth: found.deep === null ? `through ${found.bodyName}` : `blind ${valueWords(distance, found.deep)} into ${found.bodyName}`,
        op: `cut ${found.bodyName}`,
      },
      name: names.name,
      sketchName: names.sketch,
      support: { kind: 'face', body: found.ref.body, face: found.ref.ref },
      body: found.body,
      bodyName: found.bodyName,
      faceWords: found.label,
      frame: found.frame,
      compiled,
      solved,
      extent,
      centers: found.centers,
      diameter: found.D,
      depth: found.deep,
      warnings: found.warnings,
      late: [],
      sketch: null,
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { services } = ctx;
    // 1. The sketch on the face, through the person's own sketch mode.
    const sketch = await writeSketch(ctx, { target: { kind: 'new', support: plan.support, name: plan.sketchName }, geometry: plan.solved.geometry }, plan.compiled.refOf);
    plan.sketch = sketch;
    await heartbeat(ctx, services.doc.settled(ctx.signal), plan.sketchName);
    // Between the sketch and the cut: a change of the person's here makes the step unclean.
    await ctx.checkpoint({ hold: 'between-opens' });
    // 2. The cut: every circle, into the face's body only.
    const f = services.doc.state.get().doc.features.find((g) => g.id === sketch) as SketchFeature | undefined;
    if (!f) throw new ToolError('internal', `${plan.sketchName} is not in the Part.`);
    const regions = await withScene(ctx, { sketch }, (sc) => regionsOf(sc, f, ['all'], 'hole'));
    const fields = holeCutFields(plan, regions.refs);
    const id = await fillSwept(ctx, plan, { edit: null, type: 'extrude', fields, label: plan.name });
    plan.late = await checkScoped(ctx, id);
  },

  sealed(plan, ctx) {
    const made = [plan.sketch, plan.own].filter((x): x is FeatureId => !!x);
    const rt = runtimeOf(ctx.services);
    for (const id of made) rt?.madeBy.add(id);
    setMadeWith(ctx.services, made, 'hole');
  },

  reply(plan, data: EditData, ctx): ToolReply {
    const s = ctx.services.doc.state.get();
    const id = plan.own!;
    const f = s.doc.features.find((g) => g.id === id);
    const sk = s.doc.features.find((g) => g.id === plan.sketch) as SketchFeature | undefined;
    const created = createdLabels(ctx.services, id);
    const n = plan.centers.length;
    const what = `${n} ${n === 1 ? 'hole' : 'holes'} ${len(plan.diameter)} mm across, ${plan.depth === null ? 'through' : `${len(plan.depth)} mm deep`}, in ${plan.faceWords}`;
    const body = bodyWords(data);
    const text = `${f?.name ?? plan.name} ${data.feature?.state ?? 'ok'}: ${what}${body ? ` · ${body}` : ''}`;
    const dims = Object.fromEntries((sk?.constraints ?? []).filter(isDimension).map((c) => [c.id, c.expr]));
    return {
      text,
      summary: text,
      data: {
        ...data,
        made: [sk?.name ?? plan.sketchName, f?.name ?? plan.name],
        centers_mm: plan.centers.map((p) => vec(p)),
        diameter_mm: len(plan.diameter),
        depth_mm: plan.depth === null ? null : len(plan.depth),
        dimensions: dims,
        created: created.labels,
        ...(created.more ? { created_more: created.more } : {}),
        warnings: [...plan.warnings, ...plan.late, ...data.warnings].slice(0, 20),
      },
    };
  },
};

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx: CallCtx) => runEdit(ctx, holeTool),
};

/** The hole tool's plan: every check, the sketch compiled and solved headless; nothing changes (the person's Hole panel runs it too). */
export function planHole(ctx: CallCtx): Promise<HolePlan> {
  return holeTool.plan(ctx);
}
