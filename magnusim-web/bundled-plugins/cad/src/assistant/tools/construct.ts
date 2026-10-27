// construct: a construction plane, axis or point in one step, the same records the person's
// CONSTRUCT panels make (src/features/refgeom/). edit "" makes one; edit "<name>" replaces that
// construction feature's inputs (its kind must be the method's). method names the kind:
//   plane  offset (refs [plane], value the distance), angle ([plane, axis], value the angle),
//          three_points ([p1, p2, p3]), midplane ([plane, plane2]), normal_to_curve ([curve]
//          with value the position "50 %", or [curve, point]); flip is the panel's Reverse;
//   axis   two_points ([p1, p2]), cylinder ([round face]), edge ([straight or round edge]),
//          two_planes ([plane, plane2]); flip reverses it;
//   point  vertex ([point]), center ([round edge or spherical face]), on_edge ([curve], value
//          "25 %" or a length along it, from_end from its other end), edge_plane ([edge, plane]),
//          coordinates (xyz, three lengths).
// What a ref field takes is the person's pick rule (refgeom/refs.ts refFromItem): planes are
// origin planes, construction planes or flat faces; axes origin axes, construction axes, sketch
// lines, straight or round edges or "axis of <round face>"; points "origin", a construction point,
// a vertex selector or a sketch point "<sketch>.<id>[.start|.end|.center]"; curves an edge or a
// sketch curve "<sketch>.<id>". Selectors read the bodies built now, or for an edit the bodies just
// before the feature; what this feature or a later one made is refused. The person's own panel
// opens read-only, filled, and its Done keeps the feature; one that does not build changes nothing.
// get_model full shows construction features as this tool's input (registerFeatureIo).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { CallCtx, EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { ExprVec3, Feature, FeatureId, FeatureType, RefAxisFeature, RefPlaneFeature, RefPointFeature, SketchFeature } from '../../types/doc';
import type { DocState } from '../../types/doc-service';
import type { AxisRef, CurveRef, EdgeRef, FaceRef, GeomRef, PlaneRef, PointRef } from '../../types/references';
import { ToolError } from '../errors';
import { axisText, bodyText, edgeText, editTarget, faceText, fillFeature, nameFor, partOf, planeText, str, strings, type RefBodies } from '../feature-tools';
import { registerFeatureIo } from '../features-io';
import { modelId, storedId } from '../labels';
import { featureByName } from '../model';
import { dir, len, vec } from '../numbers';
import { runtimeOf } from '../runtime';
import { axisRefOf, edgeRefOf, faceRefOf, planeRefOf, vertexRefOf } from '../selectors/refs';
import { candidates, edgeLabel, faceLabel, hitWords, selectAny, selectOne, withScene, type AxisHit, type EdgeHit, type FaceHit, type PlaneHit, type Scene, type VertexHit } from '../selectors/resolve';
import { storeExpr } from '../sketch/compile';
import { partsOfEntity } from '../sketch/names';
import { isConic } from '../../sketch/tools/conic';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';

type ConstructType = 'ref_plane' | 'ref_axis' | 'ref_point';
type Method = RefPlaneFeature['method'] | RefAxisFeature['method'] | RefPointFeature['method'];

/** What one ref slot takes (the person's pick rule for that field). */
type Slot = 'plane' | 'axis' | 'point' | 'curve' | 'edge' | 'axis_edge' | 'round' | 'center';

interface MethodSpec {
  type: ConstructType;
  /** The ref slots in order; `optional` slots from that index on may be left out. */
  slots: Slot[];
  optionalFrom?: number;
  /** What `value` is: a length, an angle, a position (percent) or a length/percent along; none when "". */
  value: 'length' | 'angle' | 'percent' | 'along' | 'none';
}

export const CONSTRUCT_METHODS: Readonly<Record<Method, MethodSpec>> = {
  offset: { type: 'ref_plane', slots: ['plane'], value: 'length' },
  angle: { type: 'ref_plane', slots: ['plane', 'axis'], value: 'angle' },
  three_points: { type: 'ref_plane', slots: ['point', 'point', 'point'], value: 'none' },
  midplane: { type: 'ref_plane', slots: ['plane', 'plane'], value: 'none' },
  normal_to_curve: { type: 'ref_plane', slots: ['curve', 'point'], optionalFrom: 1, value: 'percent' },
  two_points: { type: 'ref_axis', slots: ['point', 'point'], value: 'none' },
  cylinder: { type: 'ref_axis', slots: ['round'], value: 'none' },
  edge: { type: 'ref_axis', slots: ['axis_edge'], value: 'none' },
  two_planes: { type: 'ref_axis', slots: ['plane', 'plane'], value: 'none' },
  vertex: { type: 'ref_point', slots: ['point'], value: 'none' },
  center: { type: 'ref_point', slots: ['center'], value: 'none' },
  on_edge: { type: 'ref_point', slots: ['curve'], value: 'along' },
  edge_plane: { type: 'ref_point', slots: ['edge', 'plane'], value: 'none' },
  coordinates: { type: 'ref_point', slots: [], value: 'none' },
};

const SLOT_WORDS: Record<Slot, string> = {
  plane: 'a plane (Top, a construction plane) or a flat face',
  axis: 'an axis, a sketch line, a straight or round edge, or "axis of <round face>"',
  point: '"origin", a construction point, a vertex or a sketch point "<sketch>.<id>[.start|.end|.center]"',
  curve: 'an edge or a sketch curve "<sketch>.<id>"',
  edge: 'an edge',
  axis_edge: 'a straight or round edge',
  round: 'a cylindrical or conical face',
  center: 'a round edge (arc, circle) or a spherical face',
};

const KIND_WORD: Record<ConstructType, string> = { ref_plane: 'construction plane', ref_axis: 'construction axis', ref_point: 'construction point' };

interface Plan extends EditPlan {
  type: ConstructType;
  method: Method;
  edit: FeatureId | null;
  name: string | null;
  fields: Partial<Feature>;
  warnings: string[];
}

const PERCENT = /^(.*\S)\s*%$/;

/** A sketch named at the start of `text` ("<sketch>.<rest>"), the longest name first, or null. */
function sketchPrefix(s: DocState, text: string): { sketch: SketchFeature; rest: string } | null {
  let best: { sketch: SketchFeature; rest: string } | null = null;
  for (const f of s.doc.features) {
    if (f.type !== 'sketch') continue;
    const head = `${f.name.toLowerCase()}.`;
    if (text.toLowerCase().startsWith(head) && text.length > head.length && (!best || f.name.length > best.sketch.name.length)) best = { sketch: f, rest: text.slice(head.length) };
  }
  return best;
}

/** The stored point of a sketch a model part names ("l1.start", "c1.center", "p1"), or null. */
function sketchPointOf(sk: SketchFeature, rest: string): string | null {
  const whole = sk.entities.find((e) => e.id.toLowerCase() === storedId(rest).toLowerCase());
  if (whole?.kind === 'point') return whole.p;
  const m = /^(.+)\.(start|end|center|major|minor|focus|vertex|top)$/i.exec(rest);
  if (m) {
    const e = sk.entities.find((x) => x.id.toLowerCase() === storedId(m[1]).toLowerCase());
    const part = m[2].toLowerCase();
    // The Ellipse group: its parts as the sketch tool names them.
    if (e && isConic(e)) return partsOfEntity(e).find(([p]) => p === part)?.[1] ?? null;
    if (e?.kind === 'line') return part === 'start' ? e.p[0] : part === 'end' ? e.p[1] : null;
    if (e?.kind === 'circle') return part === 'center' ? e.c : null;
    if (e?.kind === 'arc') {
      const ccw = e.ccw !== false;
      return part === 'center' ? e.c : part === 'start' ? (ccw ? e.a : e.b) : ccw ? e.b : e.a;
    }
    return null;
  }
  return Object.prototype.hasOwnProperty.call(sk.points ?? {}, rest) ? rest : null;
}

/** A sketch point as "<sketch>.<part>" (the reverse of sketchPointOf). */
function sketchPointText(sk: SketchFeature, point: string): string {
  for (const e of sk.entities) {
    const id = modelId(e.id);
    if (e.kind === 'point' && e.p === point) return `${sk.name}.${id}`;
    if (e.kind === 'line' && e.p[0] === point) return `${sk.name}.${id}.start`;
    if (e.kind === 'line' && e.p[1] === point) return `${sk.name}.${id}.end`;
    if ((e.kind === 'circle' || e.kind === 'arc') && e.c === point) return `${sk.name}.${id}.center`;
    if (e.kind === 'arc' && (e.a === point || e.b === point)) {
      const start = e.ccw !== false ? e.a : e.b;
      return `${sk.name}.${id}.${point === start ? 'start' : 'end'}`;
    }
    if (isConic(e)) {
      const part = partsOfEntity(e).find(([, p]) => p === point)?.[0];
      if (part) return `${sk.name}.${id}.${part}`;
    }
  }
  return `${sk.name}.${point}`;
}

/** Why `self` cannot keep feature `id` (refgeom's rule: itself, or later in the history), or null. */
function laterError(sc: Scene, id: FeatureId, field: string): ToolError | null {
  if (!sc.self) return null;
  const features = sc.state.doc.features;
  const at = features.findIndex((f) => f.id === sc.self);
  const i = features.findIndex((f) => f.id === id);
  if (at < 0 || i < 0) return null;
  if (i === at) return new ToolError('self_reference', `${field}: that is this feature itself.`, { detail: { field } });
  if (i > at) return new ToolError('later_feature', `${field}: ${features[i].name} comes after ${features[at].name} in the history: pick something made before it.`, { detail: { field, feature: features[i].name } });
  return null;
}

const wrong = (field: string, slot: Slot, what: string) => new ToolError('bad_selector', `${field}: ${what} is not ${SLOT_WORDS[slot]}.`, { detail: { field } });

/** One ref of the method, as the person's pick of that field keeps it, with its words. */
async function refOf(sc: Scene, text: string, slot: Slot, field: string): Promise<{ ref: GeomRef; words: string; warnings: string[] }> {
  const s = sc.state;
  if (slot === 'plane') {
    const { hit } = await selectOne(sc, text, 'plane', field);
    const p = hit as PlaneHit;
    if (p.offset) throw new ToolError('bad_selector', `${field}: "${text}" is a plane with an offset: make that plane first (method offset), or name the plane itself.`, { detail: { field } });
    return { ref: await planeRefOf(sc, p), words: p.words, warnings: p.warnings };
  }
  if (slot === 'axis') {
    const { hit } = await selectOne(sc, text, 'axis', field);
    const a = hit as AxisHit;
    if (a.source.s === 'normal') throw wrong(field, slot, `"${text}" (a plane's normal)`);
    return { ref: await axisRefOf(sc, a), words: a.words, warnings: a.warnings };
  }
  if (slot === 'point') {
    if (/^origin$/i.test(text.trim())) return { ref: { kind: 'origin', point: 'origin:point' }, words: 'the origin', warnings: [] };
    const f = featureByName(s, text);
    if (f && f.type === 'ref_point') {
      const later = laterError(sc, f.id, field);
      if (later) throw later;
      if (!s.rebuild.outputs[f.id]) throw new ToolError('not_found', `${field}: ${f.name} is not built: fix it first.`, { detail: { field } });
      return { ref: { kind: 'feature', feature: f.id }, words: f.name, warnings: [] };
    }
    if (f) throw wrong(field, slot, f.name);
    const sp = sketchPrefix(s, text.trim());
    if (sp) {
      const point = sketchPointOf(sp.sketch, sp.rest);
      if (!point) throw new ToolError('not_found', `${field}: ${sp.sketch.name} has no point "${sp.rest}" (a point's id, or a line's .start or .end, a circle's or arc's .center).`, { detail: { field } });
      const later = laterError(sc, sp.sketch.id, field);
      if (later) throw later;
      const out = s.rebuild.outputs[sp.sketch.id];
      if (!out || out.type !== 'sketch' || !out.points[point]) throw new ToolError('not_found', `${field}: that point of ${sp.sketch.name} is not built.`, { detail: { field } });
      return { ref: { kind: 'sketch-point', sketch: sp.sketch.id, point }, words: `${sp.rest} of ${sp.sketch.name}`, warnings: [] };
    }
    const { hit } = await selectOne(sc, text, 'vertex', field);
    const v = hit as VertexHit;
    const r = await vertexRefOf(sc, v);
    return { ref: { kind: 'vertex', body: r.body, ref: r.ref }, words: hitWords(sc, v), warnings: v.warnings };
  }
  if (slot === 'curve') {
    const sp = sketchPrefix(s, text.trim());
    if (sp) {
      const e = sp.sketch.entities.find((x) => x.id.toLowerCase() === storedId(sp.rest).toLowerCase());
      if (!e || e.kind === 'point') throw new ToolError('not_found', `${field}: ${sp.sketch.name} has no curve "${sp.rest}".`, { detail: { field } });
      const later = laterError(sc, sp.sketch.id, field);
      if (later) throw later;
      return { ref: { kind: 'sketch-curve', sketch: sp.sketch.id, entity: e.id }, words: `${sp.rest} of ${sp.sketch.name}`, warnings: [] };
    }
  }
  let hit: EdgeHit | FaceHit;
  if (slot === 'center') {
    // A round edge or a spherical face: whichever one thing the selector names.
    const sel = await selectAny(sc, text, field);
    const hits = sel.hits.filter((h): h is EdgeHit | FaceHit => h.kind === 'edge' || h.kind === 'face');
    if (!hits.length) throw new ToolError('nothing_selected', `${field}: "${text}" names no edge or face.`, { detail: { field, candidates: [] } });
    if (hits.length > 1) throw new ToolError('selector_ambiguous', `${field}: "${text}" names ${hits.length} edges or faces; this field takes one: narrow it, or use one of the candidates' handles.`, { detail: { field, count: hits.length, candidates: await candidates(sc, hits) } });
    hit = hits[0];
  } else if (slot === 'round') hit = (await selectOne(sc, text, 'face', field)).hit as FaceHit;
  else hit = (await selectOne(sc, text, 'edge', field)).hit as EdgeHit;
  if (hit.kind === 'edge') {
    const e = hit;
    const words = edgeLabel(sc, e) ?? hitWords(sc, e);
    if (slot === 'axis_edge' && e.topo.type !== 'line' && e.topo.type !== 'circle') throw new ToolError('bad_selector', `${field}: ${words} is neither straight nor round: pick ${SLOT_WORDS.axis_edge}.`, { detail: { field } });
    if (slot === 'center' && e.topo.type !== 'circle') throw new ToolError('bad_selector', `${field}: ${words} is not an arc or a circle: pick ${SLOT_WORDS.center}.`, { detail: { field } });
    const r = await edgeRefOf(sc, e);
    const ref: EdgeRef = { kind: 'edge', body: r.body, ref: r.ref };
    return { ref, words, warnings: e.warnings };
  }
  const fh = hit;
  const words = faceLabel(sc, fh) ?? hitWords(sc, fh);
  const t = fh.topo.type;
  if (slot === 'round' && t !== 'cylinder' && t !== 'cone') throw new ToolError('bad_selector', `${field}: ${words} is not a cylinder or a cone: pick ${SLOT_WORDS.round}.`, { detail: { field } });
  if (slot === 'center' && t !== 'sphere') throw new ToolError('bad_selector', `${field}: ${words} is not a sphere: pick ${SLOT_WORDS.center}.`, { detail: { field } });
  const r = await faceRefOf(sc, fh);
  const ref: FaceRef = { kind: 'face', body: r.body, ref: r.ref };
  return { ref, words, warnings: fh.warnings };
}

/** A stored point as a ref text. */
function pointText(s: DocState, p: PointRef, at: RefBodies | null): string {
  switch (p.kind) {
    case 'origin':
      return 'origin';
    case 'feature':
      return s.doc.features.find((f) => f.id === p.feature)?.name ?? p.feature;
    case 'sketch-point': {
      const sk = s.doc.features.find((f) => f.id === p.sketch) as SketchFeature | undefined;
      return sk ? sketchPointText(sk, p.point) : p.point;
    }
    case 'vertex':
      return `${bodyText(s, p.body)} vertex at (${[...p.ref.signature.at].map((v) => len(v)).join(', ')})`;
  }
  void at;
  return '';
}

/** A stored curve as a ref text. */
function curveText(s: DocState, c: CurveRef, at: RefBodies | null): string {
  if (c.kind === 'sketch-curve') {
    const sk = s.doc.features.find((f) => f.id === c.sketch);
    return `${sk?.name ?? c.sketch}.${modelId(c.entity)}`;
  }
  return edgeText(s, c.body, c.ref, at);
}

const construct: EditTool<Plan> = {
  async plan(ctx) {
    const { services } = ctx;
    const s = services.doc.state.get();
    const units = services.doc.units;
    const method = ctx.input.method as Method;
    const spec = CONSTRUCT_METHODS[method];
    const refs = strings(ctx.input.refs);
    const value = str(ctx.input.value);
    const xyz = strings(ctx.input.xyz);
    const flip = ctx.input.flip === true;
    const fromEnd = ctx.input.from_end === true;
    const problems: string[] = [];
    if (!spec) throw new ToolError('bad_input', `method: one of ${Object.keys(CONSTRUCT_METHODS).join(', ')}.`, { detail: { field: 'method' } });
    const min = spec.optionalFrom ?? spec.slots.length;
    if (refs.length < min || refs.length > spec.slots.length) {
      const list = spec.slots.map((sl, i) => `${SLOT_WORDS[sl]}${i >= min ? ' (or leave it out)' : ''}`);
      problems.push(spec.slots.length ? `refs: ${method} takes ${min === spec.slots.length ? spec.slots.length : `${min} or ${spec.slots.length}`}: ${list.join('; then ')}` : `refs: [] with coordinates (xyz holds the point)`);
    }
    refs.forEach((t, i) => {
      if (!t) problems.push(`refs[${i}]: a selector, not ""`);
    });
    const percentOnly = method === 'normal_to_curve' && refs.length === 2;
    if (spec.value === 'length' || spec.value === 'angle') {
      if (!value) problems.push(`value: the ${spec.value === 'length' ? 'distance ("10 mm", "t")' : 'angle ("30 deg")'}`);
    } else if (spec.value === 'none' || percentOnly) {
      if (value) problems.push(`value: "" with ${method}${percentOnly ? ' through a point' : ''}`);
    }
    if (method === 'coordinates') {
      if (xyz.length !== 3 || xyz.some((x) => !x)) problems.push('xyz: three lengths, x, y and z ("0 mm", "w/2", "12")');
    } else if (xyz.length) problems.push('xyz: [] except with coordinates');
    if (flip && spec.type === 'ref_point') problems.push('flip: false for a point (only planes and axes turn round)');
    if (fromEnd && method !== 'on_edge') problems.push('from_end: false except with on_edge');
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });

    const type = spec.type;
    const editing = editTarget(services, ctx.input.edit, [type], KIND_WORD[type], (f) => (f.type === 'ref_plane' || f.type === 'ref_axis' || f.type === 'ref_point' ? `send a ${KIND_WORD[f.type as ConstructType].split(' ')[1]} method to change it` : null));
    const name = nameFor(services, ctx.input.name, editing);
    const self = editing?.id ?? null;
    const r = await withScene(ctx, { before: self, self }, async (sc) => {
      const out: { ref: GeomRef; words: string }[] = [];
      const warnings: string[] = [];
      for (const [i, t] of refs.entries()) {
        const one = await refOf(sc, t, spec.slots[i], `refs[${i}]`);
        out.push({ ref: one.ref, words: one.words });
        for (const w of one.warnings) if (!warnings.includes(w)) warnings.push(w);
      }
      return { refs: out, warnings };
    });
    const g = r.refs.map((x) => x.ref);
    let fields: Partial<Feature>;
    let percentExpr: string | null = null;
    if (spec.value === 'percent' || spec.value === 'along') {
      const m = PERCENT.exec(value);
      percentExpr = m ? m[1].trim() : null;
    }
    if (type === 'ref_plane') {
      const f: Partial<RefPlaneFeature> = { method: method as RefPlaneFeature['method'], flip };
      if (method === 'offset') Object.assign(f, { plane: g[0] as PlaneRef, distance: storeExpr(value, 'length', units) });
      else if (method === 'angle') Object.assign(f, { plane: g[0] as PlaneRef, axis: g[1] as AxisRef, angle: storeExpr(value, 'angle', units) });
      else if (method === 'three_points') f.points = g as PointRef[];
      else if (method === 'midplane') Object.assign(f, { plane: g[0] as PlaneRef, plane2: g[1] as PlaneRef });
      else {
        f.edge = g[0] as CurveRef;
        f.points = g.slice(1) as PointRef[];
        if (!percentOnly) {
          if (value && percentExpr === null && !/^\s*[-+]?[\d.]+\s*$/.test(value) && !featureParam(services, value)) {
            throw new ToolError('bad_input', 'value: the position along the curve as a percent ("50 %"), or "" for the middle.', { detail: { field: 'value' } });
          }
          f.percent = percentExpr ?? (value || '50');
        }
      }
      fields = f as Partial<Feature>;
    } else if (type === 'ref_axis') {
      const f: Partial<RefAxisFeature> = { method: method as RefAxisFeature['method'], flip };
      if (method === 'two_points') f.points = g as PointRef[];
      else if (method === 'cylinder') f.face = g[0] as FaceRef;
      else if (method === 'edge') f.edge = g[0] as EdgeRef;
      else f.planes = g as PlaneRef[];
      fields = f as Partial<Feature>;
    } else {
      const f: Partial<RefPointFeature> = { method: method as RefPointFeature['method'], fromEnd };
      if (method === 'vertex') f.vertex = g[0] as PointRef;
      else if (method === 'center') Object.assign(f, g[0].kind === 'edge' ? { edge: g[0] as EdgeRef, face: null } : { face: g[0] as FaceRef, edge: null });
      else if (method === 'on_edge') {
        f.edge = g[0] as CurveRef;
        if (percentExpr !== null) Object.assign(f, { along: 'percent', percent: percentExpr });
        else if (value) Object.assign(f, { along: 'distance', distance: storeExpr(value, 'length', units) });
        else Object.assign(f, { along: 'percent', percent: '50' });
      } else if (method === 'edge_plane') Object.assign(f, { edge: g[0] as EdgeRef, plane: g[1] as PlaneRef });
      else f.xyz = xyz.map((x) => storeExpr(x, 'length', units)) as ExprVec3;
      fields = f as Partial<Feature>;
    }
    // The dry run: the feature as its type checks it (a value out of range is refused before anything changes).
    const def = services.doc.features.get(type)!;
    const draft = { ...(editing ?? def.create(s.doc, {})), ...fields } as Feature;
    const why = def.incomplete(draft, units);
    if (why) {
      const field = /^(Distance|Angle|Position|X|Y|Z)\b/.test(why) ? (/^[XYZ]\b/.test(why) ? 'xyz' : 'value') : 'refs';
      throw new ToolError(/: /.test(why) ? 'expr_error' : 'bad_input', `${field}: ${why}.`, { detail: { field } });
    }
    const label = def.label;
    const resolved: Record<string, string> = { method, refs: r.refs.map((x) => x.words).join('; ') || '(none)' };
    if (value) resolved.value = value;
    if (method === 'coordinates') resolved.xyz = xyz.join(', ');
    if (editing) resolved.edit = editing.name;
    return {
      part: partOf(services, type, name ?? editing?.name ?? label, !!editing),
      value: false,
      own: editing?.id ?? null,
      feature: editing?.id ?? null,
      resolved,
      type,
      method,
      edit: editing?.id ?? null,
      name,
      fields,
      warnings: r.warnings,
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { services } = ctx;
    const editName = plan.edit ? services.doc.state.get().doc.features.find((f) => f.id === plan.edit)?.name : null;
    const label = plan.name ?? editName ?? services.doc.features.get(plan.type)?.label ?? 'Construct';
    const id = await fillFeature(ctx, plan, { edit: plan.edit, type: plan.type, fields: (plan.name ? { ...plan.fields, name: plan.name } : plan.fields) as Partial<Feature>, label });
    const made = services.doc.state.get().doc.features.find((f) => f.id === id);
    if (made) plan.part = partOf(services, plan.type, made.name, !!plan.edit);
  },

  sealed(plan, ctx) {
    if (!plan.edit && plan.own) runtimeOf(ctx.services)?.madeBy.add(plan.own);
  },

  reply(plan, data: EditData, ctx): ToolReply {
    const s = ctx.services.doc.state.get();
    const f = s.doc.features.find((g) => g.id === plan.own);
    const out = plan.own ? s.rebuild.outputs[plan.own] : undefined;
    const built: Record<string, unknown> = {};
    let where = '';
    if (out?.type === 'plane') {
      Object.assign(built, { origin_mm: vec(out.frame.origin), normal: dir(out.frame.normal), u: dir(out.frame.xdir) });
      where = `through (${vec(out.frame.origin).join(', ')}), normal (${dir(out.frame.normal).join(', ')})`;
    } else if (out?.type === 'axis') {
      Object.assign(built, { origin_mm: vec(out.origin), dir: dir(out.dir) });
      where = `through (${vec(out.origin).join(', ')}), along (${dir(out.dir).join(', ')})`;
    } else if (out?.type === 'point') {
      built.point_mm = vec(out.p);
      where = `at (${vec(out.p).join(', ')})`;
    }
    const name = f?.name ?? plan.name ?? 'Construct';
    const text = `${name} ${data.feature?.state ?? 'ok'}${plan.edit ? ' (replaced)' : ''}: ${KIND_WORD[plan.type]} by ${plan.method}${where ? ` ${where}` : ''}`;
    return { text, summary: text, data: { ...data, built, warnings: [...plan.warnings, ...data.warnings].slice(0, 20) } };
  },
};

/** Whether `text` is a parameter's name (a percent may be a plain number parameter). */
function featureParam(services: AppServices, text: string): boolean {
  return services.doc.state.get().doc.params.some((p) => p.name === text.trim());
}

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx: CallCtx) => runEdit(ctx, construct),
};

// ------------------------------------------------------------------ get_model full

const BLANK = { refs: [] as string[], value: '', xyz: [] as string[], flip: false, from_end: false };

registerFeatureIo('ref_plane', {
  tool: 'construct',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as RefPlaneFeature;
    const s = services.doc.state.get();
    const base = { edit: g.name, name: '', method: g.method, ...BLANK, flip: !!g.flip };
    switch (g.method) {
      case 'offset':
        return { ...base, refs: [planeText(s, g.plane, at)], value: g.distance };
      case 'angle':
        return { ...base, refs: [planeText(s, g.plane, at), axisText(s, g.axis, at)], value: g.angle };
      case 'three_points':
        return { ...base, refs: g.points.slice(0, 3).map((p) => pointText(s, p, at)) };
      case 'midplane':
        return { ...base, refs: [planeText(s, g.plane, at), planeText(s, g.plane2, at)] };
      case 'normal_to_curve':
        if (!g.edge) return null;
        return g.points.length ? { ...base, refs: [curveText(s, g.edge, at), pointText(s, g.points[0], at)] } : { ...base, refs: [curveText(s, g.edge, at)], value: `${g.percent} %` };
    }
    return null;
  },
});

registerFeatureIo('ref_axis', {
  tool: 'construct',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as RefAxisFeature;
    const s = services.doc.state.get();
    const base = { edit: g.name, name: '', method: g.method, ...BLANK, flip: !!g.flip };
    switch (g.method) {
      case 'two_points':
        return { ...base, refs: g.points.slice(0, 2).map((p) => pointText(s, p, at)) };
      case 'cylinder':
        return g.face ? { ...base, refs: [faceText(s, g.face.body, g.face.ref, at)] } : null;
      case 'edge':
        return g.edge?.kind === 'edge' ? { ...base, refs: [edgeText(s, g.edge.body, g.edge.ref, at)] } : null;
      case 'two_planes':
        return { ...base, refs: g.planes.slice(0, 2).map((p) => planeText(s, p, at)) };
    }
    return null;
  },
});

registerFeatureIo('ref_point', {
  tool: 'construct',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as RefPointFeature;
    const s = services.doc.state.get();
    const base = { edit: g.name, name: '', method: g.method, ...BLANK };
    switch (g.method) {
      case 'vertex':
        return g.vertex ? { ...base, refs: [pointText(s, g.vertex, at)] } : null;
      case 'center':
        if (g.edge?.kind === 'edge') return { ...base, refs: [edgeText(s, g.edge.body, g.edge.ref, at)] };
        return g.face ? { ...base, refs: [faceText(s, g.face.body, g.face.ref, at)] } : null;
      case 'on_edge':
        return g.edge ? { ...base, refs: [curveText(s, g.edge, at)], value: g.along === 'distance' ? g.distance : `${g.percent} %`, from_end: !!g.fromEnd } : null;
      case 'edge_plane':
        return g.edge?.kind === 'edge' ? { ...base, refs: [edgeText(s, g.edge.body, g.edge.ref, at), planeText(s, g.plane, at)] } : null;
      case 'coordinates':
        return { ...base, xyz: [...(g.xyz ?? [])] };
    }
    return null;
  },
});

/** The feature types this tool writes (the help and the tests read them). */
export const CONSTRUCT_TYPES: readonly FeatureType[] = ['ref_plane', 'ref_axis', 'ref_point'];
