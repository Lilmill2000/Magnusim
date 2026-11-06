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
// type counterbore or countersink adds, in the same sketch, a circle c1, c2... about each hole
// (on its centre point, so they move together), its diameter dimension dc on c1 and c2... equal
// to it (eqc2...), and before the cut "<name>" the cut "<name> counterbore" (each hole's disc and
// ring, blind cb_depth) or "<name> countersink" (blind the cone's depth (cs_diameter - diameter) /
// 2 / tan(cs_angle / 2), draft angle cs_angle / 2: a cone that narrows to the hole); "<name>" then
// cuts the discs only. Two counterbores or countersinks that would overlap are refused.
// tip drill (blind holes) ends each hole in a drill point: the sketch "<name> tip sketch" on the
// holes' bottom ("<name>.end", or "<name>.end(1)" with several holes: they lie in one plane), the
// same circles placed the same way, and the cut "<name> tip" (blind diameter / 2 /
// tan(tip_angle / 2), draft tip_angle / 2: to a point). Every size is an expression the features
// keep, so they follow parameters.
// size "M6" (or an inch size, "1/4-20", "#10-32 UNF") sizes the hole from a fastener
// (features/hole/sizes.ts): fit close, normal or loose gives the clearance hole (ISO 273, or
// ASME B18.2.8 for inch sizes), fit tapped the tap drill and a cosmetic thread on the
// hole's cut (ExtrudeFeature.thread: listed and drawn over the cut's own depth, the solid
// unchanged). With a clearance fit, a counterbore's cb_diameter and cb_depth left "" come from the
// ISO 4762 socket head screw's (DIN 974-1), a countersink's cs_diameter (at 90 deg) from the
// ISO 10642 countersunk head screw's.
// thread modelled (fit tapped) also cuts the thread into the wall: the feature "<name> thread"
// (features/hole/thread-def.ts) after the cuts, following the hole; cosmetic (the default) only
// records and draws it.
// points "<sketch>" puts a centre at each point of that sketch (its point entities and circle
// centres), seen along the face's normal; centers is then []. The holes follow those points: the
// holes' sketch (and a drill tip's) holds each centre with a link to that sketch's point
// (SketchLink source kind points, sketch/project/source.ts) instead of distance_x / distance_y, so
// moving a point moves its hole at the next rebuild. The holes are the points there were: a point
// added later gets none (the link never takes it in), and a point removed leaves its hole where it
// was (a lost reference warns). That sketch becomes the holes' sketch's parent: it is hidden in
// model view like any used sketch, and cannot be deleted while the holes follow it.
// A blind hole that turns out deeper than the body went through (its cut left no bottom): a
// warning says so, and a drill tip it asked for is left out (the reply then says so too).
// Every refusal comes before anything changes, each kind of problem all at once: the fields
// (bad_input), the expressions (expr_error), then where the centres are (bad_input: off the
// face's plane, outside the face, the same centre twice). A centre within half the diameter of the
// face that is off it, or nearer one of its edges than that, cuts a notch: a warning names it
// (measured against the face's edges, at most EDGE_MEASURES_MAX measures). A cut that removes
// nothing answers cut_removed_nothing with the diagnosis (region-tools.ts).
// get_model full shows the features it made (two to five) as sketch and extrude inputs, with
// made_by "hole"; the model changes them as such (edit_feature on the sketch's d changes every hole).
// The person's Hole panel (features/hole) runs this same plan (planHole) and stores the same
// features (plan.cuts, cutFields), so a hole either made is the other's: editable either way.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_DISTANCE, TAPER_MAX_DEG } from '../../features/extrude/def';
import { counterboreFor, COUNTERBORE_SIZES, countersinkFor, COUNTERSINK_SIZES, fastener, type ClearanceFit } from '../../features/hole/sizes';
import type { SketchOutput } from '../../types/sketch';
import { faceFrame, ydirOf } from '../../features/sketch/plane';
import { sketchPoints3d } from '../../sketch/project/source';
import { nextName } from '../../lib/ids';
import { isDimension } from '../../sketch/model';
import type { AppServices } from '../../types/app';
import type { CallCtx, EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { BodyId, ExtrudeExtentDef, Feature, FeatureId, HoleThread, PlaneFrame, RegionRef, SketchFeature, SketchSupport, Vec3 } from '../../types/doc';
import type { UnitsService } from '../../types/units';
import { heartbeat } from '../busy';
import { ToolError } from '../errors';
import { createdLabels, fillFeature, NAME_MAX, str } from '../feature-tools';
import { bodyWords } from '../judge';
import { quoteName } from '../labels';
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
const STEP_SUFFIX = { counterbore: ' counterbore', countersink: ' countersink' } as const;
const TIP_SKETCH_SUFFIX = ' tip sketch';
const TIP_SUFFIX = ' tip';
const THREAD_SUFFIX = ' thread';
/** The longest name of a simple hole: its sketch is "<name> sketch", within the Part's name rule (a counterbore, countersink or drill tip leaves less). */
export const HOLE_NAME_MAX = NAME_MAX - SKETCH_SUFFIX.length;
/** A countersink's and a drill tip's angles when "" is sent. */
export const CS_ANGLE_DEFAULT = '90 deg';
export const TIP_ANGLE_DEFAULT = '118 deg';

export type HoleType = 'simple' | 'counterbore' | 'countersink';
const TYPES: readonly HoleType[] = ['simple', 'counterbore', 'countersink'];
const FITS = ['close', 'normal', 'loose', 'tapped'] as const;

/** One cut a hole makes, in order: the counterbore or countersink, the hole, the drill tip. */
export interface HoleCut {
  role: 'step' | 'bore' | 'tip';
  name: string;
  /** Its regions as selectors of its sketch ("all", "at(u, v)"). */
  regions: string[];
  extent: ExtrudeExtentDef;
  /** The draft angle expression, or null. */
  taper: string | null;
  /** A tapped hole's cosmetic thread (the hole's own cut), or absent. */
  thread?: HoleThread;
}

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
  type: HoleType;
  /** The counterbore's or countersink's diameter and depth (mm), or null. */
  step: { diameter: number; depth: number; angle: number | null } | null;
  /** The cuts, in order (the hole's own is role bore). */
  cuts: HoleCut[];
  /** The drill tip: its sketch's name, compiled and solved (same frame as the hole's), or null. */
  tip: { sketchName: string; compiled: Compiled; solved: Solved; angle: number; depth: number } | null;
  /** "M6 clearance (normal fit)", "M6x1 tap drill", or "". */
  sizeWords: string;
  warnings: string[];
  /** Warnings found after the Done (a scoped cut that missed a body). */
  late: string[];
  /** The sketch made (set by apply). */
  sketch: FeatureId | null;
  /** Every feature made, in order (set by apply). */
  made: FeatureId[];
  /** The hole's own cut (role bore; set by apply). */
  bore: FeatureId | null;
  /** Whether the drill tip was made (apply leaves it out when the holes went through). */
  tipMade: boolean;
  /** Whether two holes overlap (they then share one bottom, so fewer bottoms is not "went through"). */
  overlap: boolean;
  /** A tapped hole's thread cut into the wall: the thread feature's name, or null (cosmetic only). */
  modelled: string | null;
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

/** The suffixes of the features a hole of this type makes besides "<name>" (" sketch" first). */
function suffixesOf(type: HoleType, tip: boolean, modelled: boolean): string[] {
  return [SKETCH_SUFFIX, ...(type === 'simple' ? [] : [STEP_SUFFIX[type]]), ...(tip ? [TIP_SKETCH_SUFFIX, TIP_SUFFIX] : []), ...(modelled ? [THREAD_SUFFIX] : [])];
}

/** The names the call makes: the hole's cut and every other feature it makes, all free (any case). */
function holeNames(services: AppServices, asked: unknown, type: HoleType = 'simple', tip = false, modelled = false): { name: string; sketch: string } {
  const features = services.doc.state.get().doc.features;
  const taken = (n: string) => features.find((f) => f.name.toLowerCase() === n.toLowerCase()) ?? null;
  const suffixes = suffixesOf(type, tip, modelled);
  const max = NAME_MAX - Math.max(...suffixes.map((x) => x.length));
  const want = str(asked);
  if (want) {
    if (want.length > max) throw new ToolError('bad_input', `name: at most ${max} characters (its other features are "<name>${suffixes.join('", "<name>')}").`, { detail: { field: 'name' } });
    const a = taken(want);
    if (a) throw new ToolError('name_taken', `name: another feature is already called ${a.name}.`, { detail: { field: 'name' } });
    for (const sfx of suffixes) {
      const b = taken(`${want}${sfx}`);
      if (b) throw new ToolError('name_taken', `name: the holes would make "${want}${sfx}", and another feature is already called ${b.name}.`, { detail: { field: 'name' } });
    }
    return { name: want, sketch: `${want}${SKETCH_SUFFIX}` };
  }
  let k = Number(nextName('Hole', features.map((f) => f.name)).slice('Hole '.length));
  while (taken(`Hole ${k}`) || suffixes.some((sfx) => taken(`Hole ${k}${sfx}`))) k++;
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

/** An angle expression's value (degrees), or null with the problem noted. */
function angleOf(units: UnitsService, text: string, field: string, problems: string[]): number | null {
  const r = units.evaluate(text, 'angle');
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

/** One cut's extrude fields for its sketch's regions: into the face's body only, into the material. */
export function cutFields(plan: HolePlan, cut: HoleCut, profiles: readonly RegionRef[]): Partial<Feature> {
  return { name: cut.name, profiles: [...profiles], extent: cut.extent, flip: true, op: 'cut', scope: [plan.body], ...(cut.taper ? { taper: cut.taper } : {}), ...(cut.thread ? { thread: cut.thread } : {}) } as Partial<Feature>;
}

/**
 * The points of a sketch in model coordinates: its point entities and its circles' centres (each
 * place once), for points "<sketch>". Refused: no such sketch, or one with no points.
 */
export function sketchPoints(services: AppServices, name: string): { name: string; feature: FeatureId; points: Vec3[]; keys: string[] } {
  const s = services.doc.state.get();
  const sketches = s.doc.features.filter((f): f is SketchFeature => f.type === 'sketch');
  const f = sketches.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (!f) throw new ToolError('not_found', `points: no sketch is called "${name}". Sketches: ${sketches.map((g) => g.name).join(', ') || 'none'}.`, { detail: { field: 'points' } });
  const out = s.rebuild.outputs[f.id] as SketchOutput | undefined;
  if (!out || out.type !== 'sketch') throw new ToolError('bad_input', `points: ${f.name} did not build, so its points are not known.`, { detail: { field: 'points' } });
  // Its points (sketch/project/source.ts: the walk its link reads them by), each place once.
  const points: Vec3[] = [];
  const keys: string[] = [];
  for (const q of sketchPoints3d(f, out)) {
    if (points.some((x) => Math.hypot(x[0] - q.at[0], x[1] - q.at[1], x[2] - q.at[2]) <= JOIN_TOL)) continue;
    points.push(q.at);
    keys.push(q.key);
  }
  if (!points.length) throw new ToolError('bad_input', `points: ${f.name} has no points or circles to put holes at.`, { detail: { field: 'points' } });
  if (points.length > CENTERS_MAX) throw new ToolError('bad_input', `points: ${f.name} has ${points.length} points; hole takes at most ${CENTERS_MAX} (call hole again for the rest).`, { detail: { field: 'points' } });
  return { name: f.name, feature: f.id, points, keys };
}

/**
 * A holes' sketch (solved with its centres placed by distance_x / distance_y) turned into one whose
 * centres follow another sketch's points: a point entity on each centre (l1, l2...) linked to that
 * sketch's point, and the centres' own placing dimensions taken out (the link holds them now).
 */
function followPoints(solved: Solved, from: { feature: FeatureId; keys: string[] }): Solved {
  const g = solved.geometry;
  // A new sketch keeps the ids the plan wrote (l1, h1x...): no stored sketch renames them.
  const linked = new Map<string, string>(from.keys.map((key, i) => [`l${i + 1}`, key]));
  const placing = new Set(from.keys.flatMap((_, i) => [`h${i + 1}x`, `h${i + 1}y`]));
  const link = { id: 'lk1', type: 'projected' as const, source: { kind: 'points' as const, feature: from.feature }, entities: [...linked].map(([entity, key]) => ({ key, entity })) };
  return {
    ...solved,
    geometry: {
      ...g,
      entities: g.entities.map((e) => (linked.has(e.id) ? { ...e, link: link.id } : e)),
      constraints: g.constraints.filter((c) => !placing.has(c.id)),
      links: [...(g.links ?? []), link],
    },
  };
}

/**
 * The labels of the bottoms the hole's own cut left: "<name>.end" for one hole, "<name>.end(1)",
 * "<name>.end(2)"... for several (the name quoted as labels quote it). A blind hole deeper than
 * the body leaves none.
 */
export function bottomsOf(services: AppServices, plan: HolePlan): string[] {
  if (!plan.bore) return [];
  const q = quoteName(plan.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${q}\\.end(\\(\\d+\\))?$`);
  return createdLabels(services, plan.bore, 500).labels.filter((l) => re.test(l));
}

/** The thread feature's fields: the hole's own cut and its body, the whole hole. */
export function threadFields(plan: HolePlan): Partial<Feature> {
  return { name: plan.modelled!, hole: plan.bore!, body: plan.body, length: '' } as Partial<Feature>;
}

/** Whether the hole's own cut left a bottom (a blind hole that went through left none). */
export const hasBottom = (services: AppServices, plan: HolePlan): boolean => !plan.bore || bottomsOf(services, plan).length > 0;

/** The warning for blind holes that went through: all of them, or some. */
export function throughWords(plan: HolePlan, bottoms = 0): string {
  const n = plan.centers.length;
  const some = bottoms > 0 && bottoms < n;
  return some
    ? `${n - bottoms} of the ${n} holes of ${plan.name} are deeper than ${plan.bodyName} there, so they go through (${len(plan.depth ?? 0)} mm deep)`
    : `${plan.name} is ${len(plan.depth ?? 0)} mm deep, deeper than ${plan.bodyName} there, so it goes through (set depth through, or a smaller distance)`;
}

/**
 * After the hole's own cut: the warning for blind holes that went through (all of them, when no
 * drill tip will say it; or some of them, unless the holes overlap and so share a bottom), or null.
 */
export function boreWarning(services: AppServices, plan: HolePlan): string | null {
  if (plan.depth === null) return null;
  const bottoms = bottomsOf(services, plan).length;
  if (bottoms === 0) return plan.tip ? null : throughWords(plan);
  if (bottoms < plan.centers.length && !plan.overlap) return throughWords(plan, bottoms);
  return null;
}

/** The hole's bottom as a sketch support (after its cut is made). */
export async function bottomOf(ctx: CallCtx, plan: HolePlan): Promise<SketchSupport> {
  return withScene(ctx, {}, async (sc) => {
    // Several holes' bottoms lie in one plane: the first one carries the tip's sketch.
    const label = bottomsOf(sc.services, plan).sort()[0] ?? `${quoteName(plan.name)}.end`;
    const { hit } = await selectOne(sc, label, 'face', 'face');
    if (hit.kind !== 'face') throw new ToolError('internal', `${label} is not one face.`);
    const ref = await faceRefOf(sc, hit);
    return { kind: 'face', body: ref.body, face: ref.ref };
  });
}

const holeTool: EditTool<Plan> = {
  async plan(ctx) {
    const { services } = ctx;
    const units = services.doc.units;
    const input = ctx.input;
    const faceIn = str(input.face);
    const depth = input.depth;
    const distance = str(input.distance);
    const size = str(input.size);
    const fit = str(input.fit);
    const type = (str(input.type) || 'simple') as HoleType;
    let cbDiameter = str(input.cb_diameter);
    let cbDepth = str(input.cb_depth);
    let csDiameter = str(input.cs_diameter);
    const pointsIn = str(input.points);
    const threadMode = str(input.thread) || 'cosmetic';
    const csAngle = str(input.cs_angle) || (type === 'countersink' ? CS_ANGLE_DEFAULT : '');
    const tip = (str(input.tip) || 'flat') as 'flat' | 'drill';
    const tipAngle = str(input.tip_angle) || (tip === 'drill' ? TIP_ANGLE_DEFAULT : '');
    const rows = (Array.isArray(input.centers) ? input.centers : []) as unknown[];

    // ---- the fields
    const problems: string[] = [];
    if (!faceIn) problems.push('face: one flat face facing along X, Y or Z ("Plate.end", "Body 1 faces >Z")');
    if (pointsIn && rows.length) problems.push('centers: [] with points (the sketch\'s points are the centres)');
    if (!pointsIn && !rows.length) problems.push('centers: at least one centre (or points: a sketch whose points are the centres)');
    if (rows.length > CENTERS_MAX) problems.push(`centers: at most ${CENTERS_MAX} (call hole again for more)`);
    // The diameter: given, or from a metric size (fit close, normal or loose: ISO 273; tapped: the tap drill).
    let diameter = str(input.diameter);
    let sizeWords = '';
    const screw = size ? fastener(size) : null;
    if (size || fit) {
      if (!size) problems.push('size: a size such as "M6" or "1/4-20" with fit');
      else if (!(FITS as readonly string[]).includes(fit)) problems.push('fit: close, normal or loose (a clearance hole for the bolt), or tapped (the tap drill)');
      else if (diameter) problems.push('diameter: "" with size (the size gives it)');
      else if (!screw) problems.push(`size: "${size}" is not a size Hole knows: metric coarse M1.6 to M64 ("M6", "M6x1"), or Unified inch #0 to 1 in ("1/4-20", "#10-32", "1/4-28 UNF")`);
      else if (fit === 'tapped') {
        diameter = screw.tap.expr;
        sizeWords = `${screw.thread} tap drill ${screw.tap.words} (its thread is drawn and listed${threadMode === 'modelled' ? ', and cut' : ', not modelled'})`;
      } else if (!screw.clearance) problems.push(`size: ASME B18.2.8 has no clearance hole for ${screw.size}; give the diameter`);
      else {
        diameter = screw.clearance[fit as ClearanceFit].expr;
        sizeWords = `${screw.size} clearance, ${fit} fit (${screw.system === 'metric' ? 'ISO 273' : 'ASME B18.2.8'}): ${diameter}`;
      }
    } else if (!diameter) problems.push('diameter: an expression such as "5 mm" or "hd" (or size and fit)');
    if (depth !== 'through' && depth !== 'blind') problems.push('depth: through or blind');
    if (!TYPES.includes(type)) problems.push('type: simple, counterbore or countersink');
    // A counterbore or countersink left "" with a clearance hole's size: the screw head's (sizes.ts).
    let headWords = '';
    let noTable = false;
    const clearance = fit === 'close' || fit === 'normal' || fit === 'loose';
    if (type === 'counterbore' && clearance && screw && (!cbDiameter || !cbDepth)) {
      const cb = counterboreFor(size);
      noTable = !cb;
      if (!cb) problems.push(`cb_diameter, cb_depth: the socket head screw table has ${COUNTERBORE_SIZES}${screw.system === 'unified' ? ' (metric only)' : ''}; give both for ${screw.size}`);
      else {
        const filled = !cbDiameter && !cbDepth ? '' : !cbDiameter ? 'its diameter ' : 'its depth ';
        cbDiameter ||= `${cb.diameter} mm`;
        cbDepth ||= `${cb.depth} mm`;
        headWords = `${filled ? `(${filled}` : ''}for an ${screw.size} socket head cap screw (ISO 4762, DIN 974-1)${filled ? ')' : ''}`;
      }
    }
    // The countersunk screw table is for 90 deg heads: an angle given must be 90 deg.
    const at90 = () => {
      if (!str(input.cs_angle)) return true;
      const r = units.evaluate(str(input.cs_angle), 'angle');
      return r.ok && Math.abs(r.value - 90) < 1e-9;
    };
    if (type === 'countersink' && clearance && screw && !csDiameter && at90()) {
      const cs = countersinkFor(size);
      noTable = !cs;
      if (!cs) problems.push(`cs_diameter: the countersunk screw table has ${COUNTERSINK_SIZES}${screw.system === 'unified' ? ' (metric only)' : ''}; give it for ${screw.size}`);
      else {
        csDiameter = `${cs.diameter} mm`;
        headWords = `for an ${screw.size} countersunk head screw (ISO 10642)`;
      }
    }
    if (type === 'counterbore' && !cbDiameter && !noTable) problems.push("cb_diameter: the counterbore's diameter, wider than the hole (or \"\" with a clearance size: the screw table's)");
    if (type === 'counterbore' && !cbDepth && !noTable) problems.push("cb_depth: the counterbore's depth (or \"\" with a clearance size: the screw table's)");
    if (type !== 'counterbore' && (cbDiameter || cbDepth)) problems.push('cb_diameter, cb_depth: only with type counterbore; send ""');
    if (type === 'countersink' && !csDiameter && !noTable) problems.push("cs_diameter: the countersink's diameter at the face, wider than the hole (or \"\" with a clearance size and a 90 deg angle: the screw table's)");
    if (type !== 'countersink' && (csDiameter || str(input.cs_angle))) problems.push('cs_diameter, cs_angle: only with type countersink; send ""');
    if (tip !== 'flat' && tip !== 'drill') problems.push('tip: flat or drill');
    if (threadMode !== 'cosmetic' && threadMode !== 'modelled') problems.push('thread: cosmetic or modelled');
    if (threadMode === 'modelled' && fit !== 'tapped') problems.push('thread: modelled only with fit tapped (a size\'s tapped hole)');
    if (tip === 'drill' && depth === 'through') problems.push('tip: drill only with depth blind (a through hole has no bottom)');
    if (tip !== 'drill' && str(input.tip_angle)) problems.push('tip_angle: only with tip drill; send ""');
    if (depth === 'through' && distance) problems.push(`distance: "" with depth through (the holes go through the face's body)`);
    if (depth === 'blind' && !distance) problems.push('distance: the depth, such as "6 mm" or "t"');
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });
    const names = holeNames(services, input.name, TYPES.includes(type) ? type : 'simple', tip === 'drill', threadMode === 'modelled');
    const fromSketch = pointsIn ? sketchPoints(services, pointsIn) : null;

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
      const cbD = type === 'counterbore' ? lengthOf(units, cbDiameter, 'cb_diameter', exprs) : null;
      const cbH = type === 'counterbore' ? lengthOf(units, cbDepth, 'cb_depth', exprs) : null;
      const csD = type === 'countersink' ? lengthOf(units, csDiameter, 'cs_diameter', exprs) : null;
      const csA = type === 'countersink' ? angleOf(units, csAngle, 'cs_angle', exprs) : null;
      const tipA = tip === 'drill' ? angleOf(units, tipAngle, 'tip_angle', exprs) : null;
      // A sketch's points: their model coordinates, the one along the face's normal left to the face.
      const asRows: unknown[] = fromSketch ? fromSketch.points.map((q) => Object.fromEntries(AXES.map((a, i) => [a, i === k ? '' : `${len(q[i])} mm`]))) : rows;
      const rowName = (r: number) => (fromSketch ? `points[${r}] (${fromSketch.name}'s point ${r + 1})` : `centers[${r}]`);
      const read = asRows.map((row, r) => {
        const cIn = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
        const p: (number | null)[] = [null, null, null];
        const texts = ['', '', ''];
        AXES.forEach((a, i) => {
          const text = str(cIn[a]);
          const field = `${rowName(r)}.${a}`;
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
      // The counterbore or countersink: wider than the hole, and (blind) shallower than it.
      let step: HolePlan['step'] = null;
      if (cbD !== null && cbH !== null) {
        if (!(cbD > D!)) where.push(`cb_diameter: wider than the hole (${len(cbD)} mm, the hole is ${len(D!)} mm)`);
        if (!(cbH > 0)) where.push(`cb_depth: more than 0 (it is ${len(cbH)} mm)`);
        else if (deep !== null && !(cbH < deep)) where.push(`cb_depth: less than the hole's depth (${len(cbH)} mm, the hole is ${len(deep)} mm deep)`);
        step = { diameter: cbD, depth: cbH, angle: null };
      }
      if (csD !== null && csA !== null) {
        if (!(csD > D!)) where.push(`cs_diameter: wider than the hole (${len(csD)} mm, the hole is ${len(D!)} mm)`);
        if (!(csA > 0 && csA <= 2 * TAPER_MAX_DEG)) where.push(`cs_angle: more than 0 and at most ${2 * TAPER_MAX_DEG} deg (it is ${len(csA)} deg)`);
        else {
          const h = (csD - D!) / 2 / Math.tan((csA * Math.PI) / 360);
          if (deep !== null && csD > D! && !(h < deep)) where.push(`cs_diameter: its cone is ${len(h)} mm deep, more than the hole's ${len(deep)} mm`);
          step = { diameter: csD, depth: h, angle: csA };
        }
      }
      if (tipA !== null && !(tipA > 0 && tipA <= 2 * TAPER_MAX_DEG)) where.push(`tip_angle: more than 0 and at most ${2 * TAPER_MAX_DEG} deg (it is ${len(tipA)} deg)`);
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
          if (Math.abs(off) > ON_PLANE_MM) where.push(`${rowName(r)}.${A}: ${len(p[k])} mm is not on ${label}, which lies at ${A} = ${len(c[k])} mm: send "" for ${A}`);
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
          if (where.some((w) => w.startsWith(`${rowName(r)}.`))) continue;
          const m = await sc.services.kernel.call('measure', { a: { id: hit.body.shape, face: hit.index }, b: { point: p } });
          const d = m.result.distance ?? Infinity;
          if (d >= D! / 2 - 1e-6) {
            where.push(`${rowName(r)} ${at(p)} is ${Number.isFinite(d) ? `${len(d)} mm` : 'far'} outside ${label} (a hole ${len(D!)} mm across needs its centre within ${len(D! / 2)} mm of the face)`);
            continue;
          }
          if (warnings.length >= 8) continue;
          // Within half the diameter but off the face, or on it nearer an edge than that: a notch, not a round hole.
          if (d > ON_PLANE_MM) {
            warnings.push(`${rowName(r)} ${at(p)} is ${len(d)} mm outside ${label}: the hole ${len(D!)} mm across breaks its edge (a notch)`);
            continue;
          }
          if (measures < edges.length) continue;
          measures -= edges.length;
          let near = Infinity;
          for (const e of edges) {
            const em = await sc.services.kernel.call('measure', { a: { id: hit.body.shape, edge: e.i }, b: { point: p } });
            near = Math.min(near, em.result.distance ?? Infinity);
          }
          if (near < D! / 2 - 1e-6) warnings.push(`${rowName(r)} ${at(p)} is ${len(near)} mm from an edge of ${label}: the hole ${len(D!)} mm across breaks that edge (a notch)`);
        }
      }
      let overlap = false;
      for (let a = 0; a < centers.length; a++) {
        for (let b = a + 1; b < centers.length; b++) {
          const gap = Math.hypot(...sub(centers[a], centers[b]));
          if (gap <= JOIN_TOL) where.push(`${rowName(b)} is the same centre as ${rowName(a)} ${at(centers[a])}`);
          else if (step && gap < step.diameter) where.push(`${rowName(a)} and ${rowName(b)} are ${len(gap)} mm apart: their ${type === 'counterbore' ? 'counterbores' : 'countersinks'} ${len(step.diameter)} mm across would overlap (keep the centres at least ${len(step.diameter)} mm apart)`);
          else if (D! > 0 && gap < D!) {
            overlap = true;
            if (warnings.length < 8) warnings.push(`${rowName(a)} and ${rowName(b)} overlap: ${len(gap)} mm apart, the holes are ${len(D!)} mm across`);
          }
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
      return { label, along, ref, frame, centers, uv, D: D!, deep, step, tipA, warnings, overlap, body: hit.body.id, bodyName: hit.body.name };
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
    // A counterbore or countersink: a circle about each hole, its diameter dc on c1, the others equal to it.
    const stepExpr = type === 'counterbore' ? cbDiameter : type === 'countersink' ? csDiameter : '';
    const rings: EntityIn[] = found.step ? found.uv.map((h, r) => ({ id: `c${r + 1}`, kind: 'circle', at: [h.u, h.v, found.step!.diameter / 2], construction: false })) : [];
    const ringConstraints: ConstraintIn[] = rings.length
      ? [
          { id: 'dc', kind: 'diameter', refs: ['c1'], value: storeExpr(stepExpr, 'length', units) },
          ...rings.slice(1).map((e) => ({ id: `eqc${e.id.slice(1)}`, kind: 'equal', refs: ['c1', e.id], value: '' })),
        ]
      : [];
    // Following a sketch's points: a point entity on each centre, linked once solved (followPoints).
    const anchors: EntityIn[] = fromSketch ? found.uv.map((h, r) => ({ id: `l${r + 1}`, kind: 'point', at: [h.u, h.v], construction: false })) : [];
    const compiled = compileSketch({ entities: [...entities, ...rings, ...anchors], constraints: [...constraints, ...ringConstraints], infer: false }, { units, stored: null });
    let solved = await solveSketch(ctx, { ...compiled, geometry: compiled.draft });
    if (solved.state !== 'fully') throw new ToolError('internal', `The holes' sketch is not fully defined (dof ${solved.dof}).`);
    if (fromSketch) solved = followPoints(solved, fromSketch);

    const D = storeExpr(diameter, 'length', units);
    const extent: ExtrudeExtentDef = depth === 'blind' ? { kind: 'blind', distance: storeExpr(distance, 'length', units) } : { kind: 'through_all', both: false, distance: DEFAULT_DISTANCE[units.units().length] ?? '10 mm' };
    const atText = (u: number, v: number) => `at(${len(u)}, ${len(v)})`;
    const discs = found.uv.map((h) => atText(h.u, h.v));
    const cuts: HoleCut[] = [];
    if (found.step) {
      // The ring of each hole: a point half way between the hole's circle and the step's.
      const ringsAt = found.uv.map((h) => atText(h.u + (found.D + found.step!.diameter) / 4, h.v));
      const S = storeExpr(stepExpr, 'length', units);
      const A = type === 'countersink' ? storeExpr(csAngle, 'angle', units) : '';
      cuts.push({
        role: 'step',
        name: `${names.name}${STEP_SUFFIX[type as 'counterbore' | 'countersink']}`,
        regions: [...discs, ...ringsAt],
        extent: { kind: 'blind', distance: type === 'counterbore' ? storeExpr(cbDepth, 'length', units) : `((${S}) - (${D})) / 2 / tan((${A}) / 2)` },
        taper: type === 'countersink' ? `(${A}) / 2` : null,
      });
    }
    const thread: HoleThread | undefined = fit === 'tapped' && screw ? { designation: screw.thread, major: screw.major, pitch: screw.pitch } : undefined;
    cuts.push({ role: 'bore', name: names.name, regions: found.step ? discs : ['all'], extent, taper: null, ...(thread ? { thread } : {}) });

    // The drill tip: the same circles on the hole's bottom (its frame turns the same way, so the same u and v), cut to a point.
    let tipPlan: HolePlan['tip'] = null;
    if (found.tipA !== null && found.deep !== null) {
      const T = storeExpr(tipAngle, 'angle', units);
      const tc = compileSketch({ entities: [...entities, ...anchors], constraints, infer: false }, { units, stored: null });
      let ts = await solveSketch(ctx, { ...tc, geometry: tc.draft });
      if (ts.state !== 'fully') throw new ToolError('internal', `The drill tip's sketch is not fully defined (dof ${ts.dof}).`);
      if (fromSketch) ts = followPoints(ts, fromSketch);
      tipPlan = { sketchName: `${names.name}${TIP_SKETCH_SUFFIX}`, compiled: tc, solved: ts, angle: found.tipA, depth: found.D / 2 / Math.tan((found.tipA * Math.PI) / 360) };
      cuts.push({ role: 'tip', name: `${names.name}${TIP_SUFFIX}`, regions: ['all'], extent: { kind: 'blind', distance: `(${D}) / 2 / tan((${T}) / 2)` }, taper: `(${T}) / 2` });
    }

    const n = found.centers.length;
    const resolved: Record<string, string> = {
      face: `${found.label} (faces ${axisName(found.along)})`,
      frame: frameWords(found.frame),
      centers: `${n} ${n === 1 ? 'centre' : 'centres'}: ${found.centers.slice(0, 4).map(at).join(', ')}${n > 4 ? ` and ${n - 4} more` : ''}`,
      diameter: sizeWords || valueWords(diameter, found.D),
      depth: found.deep === null ? `through ${found.bodyName}` : `blind ${valueWords(distance, found.deep)} into ${found.bodyName}`,
      op: `cut ${found.bodyName}`,
    };
    if (found.step && type === 'counterbore') resolved.counterbore = `${valueWords(cbDiameter, found.step.diameter)} across, ${valueWords(cbDepth, found.step.depth)} deep${headWords ? ` ${headWords}` : ''}`;
    if (found.step && type === 'countersink') resolved.countersink = `${valueWords(csDiameter, found.step.diameter)} across at ${len(found.step.angle!)} deg (${len(found.step.depth)} mm deep)${headWords ? ` ${headWords}` : ''}`;
    if (thread) resolved.thread = threadMode === 'modelled' ? `${thread.designation} thread cut into the wall ("${names.name}${THREAD_SUFFIX}", following the hole)` : `${thread.designation} cosmetic thread over the hole's depth (drawn and listed, not modelled)`;
    if (fromSketch) resolved.centers = `${n} at ${fromSketch.name}'s points, following them: ${resolved.centers.replace(/^\d+ centres?: /, '')}`;
    if (tipPlan) resolved.tip = `drill point ${len(tipPlan.angle)} deg (${len(tipPlan.depth)} mm past the hole's depth)`;
    return {
      part: partOf(names.name),
      value: false,
      own: null,
      feature: null,
      resolved,
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
      type,
      step: found.step,
      cuts,
      tip: tipPlan,
      sizeWords,
      warnings: found.warnings,
      late: [],
      sketch: null,
      made: [],
      bore: null,
      tipMade: false,
      overlap: found.overlap,
      modelled: thread && threadMode === 'modelled' ? `${names.name}${THREAD_SUFFIX}` : null,
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { services } = ctx;
    // 1. The sketch on the face, through the person's own sketch mode.
    const sketch = await writeSketch(ctx, { target: { kind: 'new', support: plan.support, name: plan.sketchName }, geometry: plan.solved.geometry }, plan.compiled.refOf);
    plan.sketch = sketch;
    plan.made.push(sketch);
    await heartbeat(ctx, services.doc.settled(ctx.signal), plan.sketchName);
    // 2. The cuts in order (counterbore or countersink, the hole, the drill tip on its own sketch).
    let on = sketch;
    let onName = plan.sketchName;
    for (const cut of plan.cuts) {
      if (cut.role === 'tip') {
        // The drill tip goes on the hole's bottom; a hole that went through has none.
        if (!hasBottom(services, plan)) {
          plan.late.push(`${throughWords(plan)}; the drill tip was left out`);
          break;
        }
        plan.tipMade = true;
        await ctx.checkpoint({ hold: 'between-opens' });
        const support = await bottomOf(ctx, plan);
        on = await writeSketch(ctx, { target: { kind: 'new', support, name: plan.tip!.sketchName }, geometry: plan.tip!.solved.geometry }, plan.tip!.compiled.refOf);
        onName = plan.tip!.sketchName;
        plan.made.push(on);
        await heartbeat(ctx, services.doc.settled(ctx.signal), onName);
      }
      // Between two features: a change of the person's here makes the step unclean.
      await ctx.checkpoint({ hold: 'between-opens' });
      const f = services.doc.state.get().doc.features.find((g) => g.id === on) as SketchFeature | undefined;
      if (!f) throw new ToolError('internal', `${onName} is not in the Part.`);
      const regions = await withScene(ctx, { sketch: on }, (sc) => regionsOf(sc, f, cut.regions, 'hole'));
      const id = await fillSwept(ctx, plan, { edit: null, type: 'extrude', fields: cutFields(plan, cut, regions.refs), label: cut.name });
      plan.made.push(id);
      if (cut.role === 'bore') plan.bore = id;
      plan.late.push(...(await checkScoped(ctx, id)));
      const through = cut.role === 'bore' ? boreWarning(services, plan) : null;
      if (through) plan.late.push(through);
    }
    // 3. A modelled thread: cut into the wall, following the hole.
    if (plan.modelled && plan.bore) {
      await ctx.checkpoint({ hold: 'between-opens' });
      const id = await fillFeature(ctx, plan, { edit: null, type: 'thread', fields: threadFields(plan), label: plan.modelled });
      plan.made.push(id);
    }
    // The reply speaks of the hole's own cut.
    plan.own = plan.bore;
  },

  sealed(plan, ctx) {
    const made = plan.made.length ? plan.made : [plan.sketch, plan.own].filter((x): x is FeatureId => !!x);
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
    const thread = plan.cuts.find((c) => c.thread)?.thread;
    const kind = `${plan.type === 'simple' ? '' : `${plan.type === 'counterbore' ? 'counterbored' : 'countersunk'} `}${thread ? `${thread.designation} tapped ${plan.modelled ? '(threaded) ' : ''}` : ''}`;
    const holes = `${kind}${n === 1 ? 'hole' : 'holes'}`;
    const what = `${n} ${holes} ${len(plan.diameter)} mm across, ${plan.depth === null ? 'through' : `${len(plan.depth)} mm deep${plan.tipMade ? ' with a drill point' : ''}`}, in ${plan.faceWords}`;
    const body = bodyWords(data);
    const text = `${f?.name ?? plan.name} ${data.feature?.state ?? 'ok'}: ${what}${body ? ` · ${body}` : ''}`;
    const dims = Object.fromEntries((sk?.constraints ?? []).filter(isDimension).map((c) => [c.id, c.expr]));
    return {
      text,
      summary: text,
      data: {
        ...data,
        made: plan.made.length ? plan.made.map((m) => s.doc.features.find((g) => g.id === m)?.name ?? '').filter(Boolean) : [sk?.name ?? plan.sketchName, f?.name ?? plan.name],
        centers_mm: plan.centers.map((p) => vec(p)),
        diameter_mm: len(plan.diameter),
        depth_mm: plan.depth === null ? null : len(plan.depth),
        ...(plan.type !== 'simple' && plan.step ? { [plan.type]: { diameter_mm: len(plan.step.diameter), depth_mm: len(plan.step.depth), ...(plan.step.angle != null ? { angle_deg: len(plan.step.angle) } : {}) } } : {}),
        ...(plan.tip && plan.tipMade ? { tip: { angle_deg: len(plan.tip.angle), depth_mm: len(plan.tip.depth) } } : {}),
        ...(plan.sizeWords ? { size: plan.sizeWords } : {}),
        ...(thread ? { thread: thread.designation } : {}),
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
