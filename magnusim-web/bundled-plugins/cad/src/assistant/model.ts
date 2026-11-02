// The Part as text for the model (CAD tools spec §4, get_model): everything in `data` as compact
// JSON (text whitespace collapses on the way), names first, values evaluated (mm, mm², mm³, deg),
// every list capped with a count of the rest, within the reply budgets (§3.1):
//   brief  names, states, sizes; older features collapse ({"earlier": 42, "states": {...}})
//          above 80 features (30 on a local turn) or past the budget;
//   full   also each feature's inputs in its tool's fields (inputs: null and a summary for a type
//          no tool writes yet) and its expression fields; cut at the budget, the rest brief with
//          "more": "get_model feature <name>"; a red Delete faces also its `rest` (the faces its
//          panel's Add the rest adds, as face selectors);
//   one feature  in full; a sketch with its plane, the solver's state now, its regions in short
//          (sketch/regions.ts shortRegions; regions full: each of them, 60, with its place, depth,
//          box and bounds), its open ends and dangling entities, by the sketch tool's names (r.top,
//          l1.start), and its inputs in the sketch tool's form (sketch/describe.ts; null when it
//          cannot be resent). Brief rows list a sketch's regions in short too. Each reply says
//          what the person copied in a sketch (clipboard: the copy row's "from clipboard"), if anything.
// The whole Part (brief or full) also lists `parts`: every body in one short row (name, volume, the
// size and middle of its box, its colour when set, the feature that made it, hidden, see_through), never halved
// with the budgets (up to PARTS_MAX, the app's cap on a list's items, within PARTS_BYTES), so every
// part of an assembly can be checked against the request. It comes first in the reply, and the rest
// fits what the app's result cap (RESULT_DATA_BYTES) leaves: a cut never takes a part's row.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { storedBodyName } from '../doc/features/body-ids';
import { bodyMaker, isBodyMaking } from '../doc/features/hooks';
import { moveWords } from '../features/move_body/words';
import { seeThroughOf } from '../viewport/bind';
import { DEFAULT_BODY_COLOR } from '../doc/schema';
import { toModel, ydirOf } from '../features/sketch/plane';
import { userSelection } from '../lib/selection';
import { describeFace, isCopyRole, splitMerged } from '../naming/names';
import { statusOf } from '../sketch/dof';
import { evaluateDimensions } from '../sketch/model';
import { clipWords } from '../sketch/tools/clip';
import { heldClip } from '../sketch/tools/paste';
import type { AppServices } from '../types/app';
import type { CallCtx, ReplyBudgets, ToolReply, TurnFacts } from '../types/assistant';
import type { Feature, FeatureStatus, OriginRef, PlaneFrame, SketchFeature } from '../types/doc';
import type { DocState, RebuildState } from '../types/doc-service';
import type { BodyInfo } from '../types/kernel';
import type { SelectionItem } from '../types/selection';
import type { SketchOutput } from '../types/sketch';
import { uiFor } from '../ui/controller';
import { heartbeat, personBusy } from './busy';
import { ToolError } from './errors';
import { axisText, faceText, refBodiesOf, type RefBodies } from './feature-tools';
import { choicesOf } from './choices';
import { inputsNameRefs, inputsOf, summaryOf, valuesOf } from './features-io';
import { enclosureKept, KEPT_WORDS } from '../features/enclosure/kept';
import { LabelIndex } from './labels';
import { madeWith } from './made-with';
import { dir, jsonBytes, len, sig6, vec } from './numbers';
import { runtimeOf } from './runtime';
import { describeSketch, supportSelector, TOO_BIG_WORDS } from './sketch/describe';
import { freeRows } from './sketch/solve';
import { fitRegions, regionRows, shortRegions } from './sketch/regions';
import { BRIEF_HARD_CAP } from './turn-info';
import { closestName, closestWords } from './closest';
import { personSection } from './view';

/** One sketch read with regions full shows at most this many regions. */
export const SKETCH_REGIONS = 60;
/** Bodies listed (the rest counted). */
export const BODIES_MAX = 50;
/** Rows of the parts list at most (the app keeps the first 200 items of a list). */
export const PARTS_MAX = 200;
/** The app's cap on a tool result's data (bytes; scripts/server/assistant/sanitize.ts JSON_CAPS.bytes). */
export const RESULT_DATA_BYTES = 32 * 1024;
/** Kept for the result's shell and text beside the data (bytes). */
const RESULT_MARGIN = 2 * 1024;
/** The rest of a whole-Part reply always has this much room (bytes). */
const REST_MIN = 4 * 1024;
/** The parts rows never take more than this (bytes): the rest past it are counted. */
export const PARTS_BYTES = RESULT_DATA_BYTES - RESULT_MARGIN - REST_MIN;
/** Selection items in words. */
export const SELECTION_MAX = 20;
/** Names listed when a feature is not found. */
export const NAMES_MAX = 30;
/** Above this many faces a body's properties are not computed with every rebuild (measure gives them). */
export const EAGER_FACES = 2000;
/** The pointer to the CAD notes, on the first get_model of each key. */
export const GUIDE_NOTE = 'If you have no notes from the CAD workspace, read help guide';

type Row = Record<string, unknown>;

const ORIGIN_WORD: Record<OriginRef, string> = {
  'origin:point': 'origin',
  'origin:top': 'Top',
  'origin:front': 'Front',
  'origin:right': 'Right',
  'origin:x': 'X axis',
  'origin:y': 'Y axis',
  'origin:z': 'Z axis',
};

/** A feature's state in the model's words. */
export function stateWord(st: FeatureStatus | undefined): string {
  if (!st) return 'pending';
  return st.state === 'rolled-back' ? 'rolled_back' : st.state;
}

const featureNamer = (s: DocState) => {
  const names = new Map(s.doc.features.map((f) => [f.id, f.name]));
  return (id: string) => names.get(id) ?? null;
};

const bodyName = (s: DocState, id: string) => s.rebuild.bodies.find((b) => b.id === id)?.name ?? s.doc.bodies[id]?.name ?? 'a removed body';

/** Where a sketch lies as a selector the tools read back (a face by its label), else in words. */
export function supportText(s: DocState, f: SketchFeature): string {
  return supportSelector(f, s) || supportWords(s, f);
}

/** Where a sketch lies, in words: Top, Front, Right, a construction plane's name, or a face. */
export function supportWords(s: DocState, f: SketchFeature): string {
  const sup = f.support;
  if (sup.kind === 'plane') return ORIGIN_WORD[sup.plane] ?? sup.plane;
  if (sup.kind === 'feature') return featureNamer(s)(sup.feature) ?? 'a deleted plane';
  const body = s.rebuild.bodies.find((b) => b.id === sup.body);
  return `${describeFace(sup.face.name, featureNamer(s), body?.names?.faces ?? null)} on ${bodyName(s, sup.body)}`;
}

/** "u runs +X, v runs -Z, origin (0, 0, 6)": a frame in model words. */
export function frameWords(plane: PlaneFrame): string {
  const axis = (v: readonly number[]) => {
    const i = [0, 1, 2].reduce((best, k) => (Math.abs(v[k]) > Math.abs(v[best]) ? k : best), 0);
    if (Math.abs(Math.abs(v[i]) - 1) > 1e-6) return `(${dir(v).join(', ')})`;
    return `${v[i] > 0 ? '+' : '-'}${'XYZ'[i]}`;
  };
  const o = vec(plane.origin);
  return `u runs ${axis(plane.xdir)}, v runs ${axis(ydirOf(plane))}, origin (${o.join(', ')})`;
}

/** The faces of the bodies that `featureId` named, counted by role ({start: 1, end: 1, side: 4}). */
function faceRoles(bodies: readonly BodyInfo[], featureId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of bodies) {
    for (const name of b.names?.faces ?? []) {
      for (const part of splitMerged(name)) {
        const m = /^F:([^:]+):([^:#[]+)/.exec(part);
        if (!m || m[1] !== featureId) continue;
        const role = isCopyRole(m[2]) ? (m[2] === 'm' ? 'mirror' : 'copy') : m[2];
        out[role] = (out[role] ?? 0) + 1;
        break;
      }
    }
  }
  return out;
}

/** The bodies a feature makes, by name, among those built now. */
function madeBodies(services: AppServices, s: DocState, f: Feature): string[] {
  return s.rebuild.bodies.filter((b) => bodyMaker(services.doc.features, s.doc, b.id)?.id === f.id).map((b) => b.name);
}

/** One feature, brief. */
export function briefFeature(services: AppServices, s: DocState, f: Feature): Row {
  const st = s.rebuild.features[f.id];
  const row: Row = { name: f.name, type: f.type, state: stateWord(st) };
  if (st?.message) row.message = st.message;
  // What the tree shows as the row's info mark (a Join's pieces left apart): said, not warned.
  if (st?.note && (st.state === 'ok' || st.state === 'warning')) row.note = st.note;
  if (st?.actions?.length) row.actions = [...st.actions];
  if (runtimeOf(services)?.madeBy.has(f.id)) row.by = 'assistant';
  // A kept structural edit of the Assistant's turned it red, and it still fails.
  if (st?.state === 'error' && runtimeOf(services)?.brokenBy.has(f.id)) row.broken_by_you = true;
  if (f.type === 'sketch') {
    const out = s.rebuild.outputs[f.id] as SketchOutput | undefined;
    row.on = supportText(s, f);
    row.sketch = out?.source === 'stored-unsolved' ? 'unsolved' : f.solved.state;
    row.dof = f.solved.dof;
    if (out?.type === 'sketch') {
      const short = shortRegions(regionRows(out));
      row.regions = short.regions;
      if (short.more) row.regions_more = short.more;
      if (out.open.length) row.open = out.open.length;
    }
  } else if (isBodyMaking(f)) {
    row.op = f.op;
    const made = madeBodies(services, s, f);
    if (made.length) row.made = made;
    const faces = faceRoles(s.rebuild.bodies, f.id);
    if (Object.keys(faces).length) row.faces = faces;
  } else if (f.type === 'move_body') {
    // What it does, in words ("moved Body 1 by (20, 0, 0) mm"), and the copies it made.
    const bodyName = (id: string) => s.rebuild.bodies.find((b) => b.id === id)?.name ?? storedBodyName(s.doc, id) ?? 'a deleted body';
    row.does = moveWords(f, bodyName, (a) => axisText(s, a));
    const made = madeBodies(services, s, f);
    if (made.length) row.made = made;
  }
  return row;
}

/**
 * One feature, full: brief plus its inputs (or a summary) and its expression fields. `at`: the
 * bodies just before it, which its face and edge references are written against.
 */
export function fullFeature(services: AppServices, s: DocState, f: Feature, at: RefBodies | null = null): Row {
  const row = briefFeature(services, s, f);
  // A feature another tool made as part of its work (a hole's sketch and cut): edited as its own type.
  const by = madeWith(services, f.id);
  if (by) row.made_by = by;
  // Magnusim CAD keeps an Enclosure made in Magnusim as it is (no Enclosure command, its panel read-only):
  // nothing to resend or set, only what it is.
  if (enclosureKept(services, f)) {
    row.inputs = null;
    row.summary = summaryOf(f, services);
    row.kept = KEPT_WORDS;
    return row;
  }
  const inputs = inputsOf(f, services, at);
  row.inputs = inputs;
  if (!inputs) row.summary = summaryOf(f, services);
  // A red Delete faces: the faces that would make its pick whole, as its panel's Add the rest adds them
  // (kernel API 8; edit with faces + rest to add them).
  const out = s.rebuild.outputs[f.id];
  if (f.type === 'delete_faces' && out?.type === 'delete-faces' && out.restRefs.length && s.rebuild.features[f.id]?.state === 'error') row.rest = out.restRefs.map((r) => faceText(s, f.body, r, at));
  const values = valuesOf(f, services);
  if (values.length) row.values = values.slice(0, 200);
  // Its choice and on/off fields, as edit_feature sets them (choices.ts; help features has their words).
  const choices = choicesOf(f);
  if (choices.length) row.choices = Object.fromEntries(choices.map((c) => [c.field, c.value]));
  return row;
}

/** One feature, full, its references written against the bodies just before it (where a resend with edit reads them). */
async function fullFeatureNow(services: AppServices, s: DocState, f: Feature): Promise<Row> {
  return fullFeature(services, s, f, inputsNameRefs(f) ? await refBodiesOf(services, f.id) : null);
}

/** A body: what it is, how big, where; null properties above EAGER_FACES (measure gives them). */
export async function bodyRow(services: AppServices, s: DocState, b: BodyInfo): Promise<Row> {
  let { volume, solids, shells } = b;
  if ((volume === null || shells === null || shells === undefined) && b.faces <= EAGER_FACES) {
    try {
      const p = await services.doc.measure(b.id);
      volume = p.volume;
      solids = p.solids;
      shells = p.shells;
    } catch {
      // Not measurable now (a rebuild came in between): the row says null.
    }
  }
  const solidsN = typeof solids === 'number' ? solids : null;
  const shellsN = typeof shells === 'number' ? shells : null;
  const row: Row = {
    name: b.name,
    color: b.color,
    valid: b.valid,
    solids: solidsN,
    shells: shellsN,
    voids: solidsN !== null && shellsN !== null && solidsN > 0 ? Math.max(0, shellsN - solidsN) : null,
    volume_mm3: typeof volume === 'number' ? sig6(volume) : null,
    bbox_mm: [vec(b.bbox.slice(0, 3)), vec(b.bbox.slice(3, 6))],
    faces: b.faces,
    visible: b.visible,
  };
  // Magnusim CAD (projectLinks false) has no simulation: the person sees no such state, nor does the Assistant.
  if (services.bridge.projectLinks()) row.simulation = s.doc.bodies[b.id]?.simulation !== false;
  if (row.volume_mm3 === null && b.faces > EAGER_FACES) row.measure = 'use measure';
  const maker = bodyMaker(services.doc.features, s.doc, b.id);
  if (maker) row.made_by = maker.name;
  const last = featureNamer(s)(b.feature);
  if (last) row.last_changed_by = last;
  return row;
}

/**
 * Every body built now as one short row: name, volume (mm3; null above EAGER_FACES faces until
 * measured), the size and middle of its box, its colour when it is not the default, the feature that
 * made it, hidden when the person hid it, see_through when drawn see-through. Never halved: the first PARTS_MAX, the rest counted.
 */
export async function partRows(services: AppServices, s: DocState): Promise<{ parts: Row[]; more: number }> {
  const parts: Row[] = [];
  let size = 2;
  for (const b of s.rebuild.bodies.slice(0, PARTS_MAX)) {
    let volume = b.volume;
    if (volume === null && b.faces <= EAGER_FACES) {
      try {
        volume = (await services.doc.measure(b.id)).volume;
      } catch {
        // Not measurable now (a rebuild came in between): the row says null.
      }
    }
    const box = b.bbox;
    const row: Row = {
      name: b.name,
      mm3: typeof volume === 'number' ? sig6(volume) : null,
      size_mm: vec([box[3] - box[0], box[4] - box[1], box[5] - box[2]]),
      at_mm: vec([(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2]),
    };
    if (b.color && b.color.toLowerCase() !== DEFAULT_BODY_COLOR) row.color = b.color;
    const maker = bodyMaker(services.doc.features, s.doc, b.id);
    if (maker) row.by = maker.name;
    if (!b.visible) row.hidden = true;
    // Drawn see-through (the person's INSPECT > See-through or workspace see_through; an Enclosure's air).
    if (seeThroughOf(s, services, b.id)) row.see_through = true;
    size += jsonBytes(row) + 1;
    if (size > PARTS_BYTES) break;
    parts.push(row);
  }
  return { parts, more: Math.max(0, s.rebuild.bodies.length - parts.length) };
}

/** A selected thing in words ("face Plate.end on Body 1": a face by its label when it has one, else its words). */
export function selectionWords(s: DocState, item: SelectionItem, labels?: LabelIndex): string {
  const names = featureNamer(s);
  switch (item.kind) {
    case 'face': {
      const bi = s.rebuild.bodies.findIndex((x) => x.id === item.body);
      const b = s.rebuild.bodies[bi];
      const n = b?.names?.faces?.[item.index];
      const label = bi >= 0 ? labels?.of(bi, item.index).label : null;
      return n ? `face ${label ?? describeFace(n, names, b?.names?.faces ?? null)} on ${bodyName(s, item.body)}` : `a face of ${bodyName(s, item.body)}`;
    }
    case 'edge':
      return `an edge of ${bodyName(s, item.body)}`;
    case 'vertex':
      return `a vertex of ${bodyName(s, item.body)}`;
    case 'body':
      return `body ${bodyName(s, item.body)}`;
    case 'feature':
      return `feature ${names(item.feature) ?? 'a deleted feature'}`;
    case 'origin':
      if (item.ref === 'origin:point') return 'the origin';
      return item.ref === 'origin:x' || item.ref === 'origin:y' || item.ref === 'origin:z' ? ORIGIN_WORD[item.ref] : `${ORIGIN_WORD[item.ref]} plane`;
    case 'sketch':
      return `a ${item.what} of ${names(item.feature) ?? 'a sketch'}`;
    case 'region':
      return `a region of ${names(item.feature) ?? 'a sketch'}`;
  }
}

/** Collapse all but the newest `keep` features into one row of counts (errors named). */
function collapse(rows: Row[], keep: number): Row[] {
  if (keep >= rows.length) return rows;
  const earlier = rows.slice(0, rows.length - keep);
  const states: Record<string, number> = {};
  for (const r of earlier) states[String(r.state)] = (states[String(r.state)] ?? 0) + 1;
  const errors = earlier.filter((r) => r.state === 'error').map((r) => String(r.name));
  return [{ earlier: earlier.length, states, ...(errors.length ? { errors: errors.slice(0, 20) } : {}), more: 'get_model detail full, or get_model feature <name>' }, ...rows.slice(rows.length - keep)];
}

export interface ModelInput {
  detail: 'brief' | 'full';
  feature: string;
  /** One sketch's regions: short, or full (each with its place, depth, box and bounds). */
  regions: 'short' | 'full';
}

/** The Part-level facts every get_model has (everything but the features). */
async function partFacts(ctx: CallCtx, s: DocState): Promise<Row> {
  const { services } = ctx;
  const rt = runtimeOf(services);
  const block = uiFor(services).editBlock();
  const { rollback } = s.view;
  const rolled = rollback !== null && rollback < s.doc.features.length ? { after: rollback > 0 ? (s.doc.features[rollback - 1]?.name ?? null) : null, count: s.doc.features.length - rollback } : null;
  const bodies = await Promise.all(s.rebuild.bodies.slice(0, BODIES_MAX).map((b) => bodyRow(services, s, b)));
  const sel = userSelection(services.selection.get()).items;
  // The selected faces by their labels (selectors read them back).
  const labels = sel.some((i) => i.kind === 'face') ? new LabelIndex(s.rebuild.bodies, { featureName: featureNamer(s) }) : undefined;
  const out: Row = {
    part: rt?.title() ?? services.bridge.context.study.title,
    units: { length: s.doc.units.length, angle: s.doc.units.angle },
    editable: block === null,
    ...(block ? { why: block } : {}),
    rolled_back: rolled,
    person: personBusy(services),
    undo: { label: s.history.undoLabel, your_steps: rt ? rt.ledger.undoable(ctx.key, services.doc) : 0 },
    params: s.doc.params.slice(0, 200).map((p) => {
      const r = services.doc.units.evaluate(p.expr, p.quantity);
      return {
        name: p.name,
        kind: p.quantity === 'scalar' ? 'number' : p.quantity,
        expr: p.expr,
        ...(r.ok ? { value: p.quantity === 'scalar' ? sig6(r.value) : len(r.value) } : { error: r.error }),
        ...(p.comment ? { comment: p.comment } : {}),
      };
    }),
    bodies,
    ...(s.rebuild.bodies.length > BODIES_MAX ? { bodies_more: s.rebuild.bodies.length - BODIES_MAX } : {}),
    selection: sel.slice(0, SELECTION_MAX).map((i) => selectionWords(s, i, labels)),
  };
  // The person's section view while it is on (INSPECT > Section view; workspace section sets it), and its panel's note.
  const cut = personSection(services);
  if (cut) out.section = cut;
  // What the person copied (Ctrl+C in a sketch of any Part): the sketch tool's copy row pastes it ("from clipboard").
  const clip = await heldClip(services).catch(() => null);
  if (clip) out.clipboard = `${clipWords(clip)}, copied from ${clip.from}`;
  if (s.rebuild.message) out.rebuild = s.rebuild.message;
  // The pointer to help guide, on the first get_model of each key (a conversation may have kept another workspace's notes).
  if (rt && !rt.guideNoted.has(ctx.key)) {
    rt.guideNoted.add(ctx.key);
    out.notes = GUIDE_NOTE;
  }
  const limits = limitsOf(ctx.turn);
  if (limits) out.limits = limits;
  return out;
}

/** What one feature's reply keeps of the Part's facts (its row is the point). */
const FEATURE_BASE = ['part', 'units', 'editable', 'why', 'rolled_back', 'person', 'rebuild', 'notes', 'limits'];

/** Where the parameters a brief leaves out are (the comments, the expressions, the rest of the list). */
export const PARAMS_FULL = 'get_model detail full lists every parameter with its expression and comment';

/**
 * The Part's facts within `max` bytes, so the features keep the room: a long list of bodies is
 * halved first; then (a brief, `shed`) the parameters' comments go, then their expressions (each
 * keeps its name, kind and value: the names are what set_params and every expression use), said
 * in params_cut with where to read them; only a list whose names alone do not fit is halved (the
 * rest counted in params_more). Full keeps every parameter whole while the list fits its room.
 */
function fitBase(base: Row, max: number, shed: boolean): Row {
  let b = base;
  const cut = (what: string, extra: Row = {}) => ({ ...b, ...extra, params_cut: `${what}; ${PARAMS_FULL}` });
  for (let guard = 0; guard < 20 && jsonBytes(b) > max; guard++) {
    const bodies = b.bodies as Row[];
    const params = b.params as Row[];
    if (bodies.length > 5) {
      const keep = Math.ceil(bodies.length / 2);
      b = { ...b, bodies: bodies.slice(0, keep), bodies_more: (Number(b.bodies_more) || 0) + bodies.length - keep };
    } else if (shed && params.some((p) => 'comment' in p)) {
      b = cut('comments left out', { params: params.map(({ comment: _c, ...p }) => p) });
    } else if (shed && params.some((p) => 'expr' in p)) {
      b = cut('expressions and comments left out', { params: params.map(({ expr: _e, ...p }) => p) });
    } else if (params.length > 10) {
      const keep = Math.ceil(params.length / 2);
      const rest = { params: params.slice(0, keep), params_more: (Number(b.params_more) || 0) + params.length - keep };
      b = shed ? cut('expressions and comments left out', rest) : { ...b, ...rest };
    } else break;
  }
  return b;
}

/**
 * What is left of the turn's limits. A turn that counts no dollars (a coding agent bills the
 * person's own account: usdCap 0) has no usd_left: 0 would read as no money left. A coding
 * agent's turn has changes_left too: past its change limit its edits are refused while its reads
 * go on, so a build meets that limit long before its calls run out.
 */
function limitsOf(turn: TurnFacts | null): Row | null {
  if (!turn || turn.state !== 'running') return null;
  const u = turn.used;
  return {
    steps_left: Math.max(0, u.stepsCap - u.steps),
    ...(u.changesCap > 0 ? { changes_left: Math.max(0, u.changesCap - u.changes) } : {}),
    ...(u.usdCap > 0 ? { usd_left: Math.max(0, Math.round((u.usdCap - u.usd) * 100) / 100) } : {}),
  };
}

/** The whole Part, brief: the newest features kept while the reply is too large. */
function fitBrief(facts: Row, rows: Row[], budgets: ReplyBudgets): Row {
  const base = fitBase(facts, budgets.brief / 2, true);
  let keep = Math.min(rows.length, budgets.briefCollapse);
  let data: Row = { ...base, features: collapse(rows, keep) };
  while (keep > 1 && jsonBytes(data) > budgets.brief) {
    keep = Math.max(1, Math.floor(keep * 0.7));
    data = { ...base, features: collapse(rows, keep) };
  }
  // The hard cap: the sketches' regions go (get_model feature <sketch> lists them).
  if (jsonBytes(data) > BRIEF_HARD_CAP) {
    data = {
      ...data,
      features: (data.features as Row[]).map((r) => {
        if (!r.regions) return r;
        const { regions: _r, regions_more: _m, ...rest } = r;
        return rest;
      }),
    };
  }
  return data;
}

/** The whole Part, full: features in full while they fit, then brief with a pointer, then counted. */
async function fitFull(facts: Row, services: AppServices, s: DocState, budgets: ReplyBudgets): Promise<Row> {
  const features: Row[] = [];
  const data: Row = { ...fitBase(facts, budgets.full / 3, false), features };
  let size = jsonBytes(data);
  const list = s.doc.features;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const full = await fullFeatureNow(services, s, f);
    const fullBytes = jsonBytes(full) + 1;
    if (size + fullBytes <= budgets.full) {
      features.push(full);
      size += fullBytes;
      continue;
    }
    const brief = { ...briefFeature(services, s, f), more: `get_model feature ${f.name}` };
    const briefBytes = jsonBytes(brief) + 1;
    if (size + briefBytes <= budgets.full) {
      features.push(brief);
      size += briefBytes;
      continue;
    }
    const rest = list.slice(i);
    const states: Record<string, number> = {};
    for (const g of rest) {
      const w = stateWord(s.rebuild.features[g.id]);
      states[w] = (states[w] ?? 0) + 1;
    }
    features.push({ later: rest.length, states, more: 'get_model detail brief, or get_model feature <name>' });
    break;
  }
  return data;
}

/** One sketch in full: its plane, the solver's state now (headless), its regions (short or full), open ends. */
async function sketchDetail(ctx: CallCtx, s: DocState, f: SketchFeature, regionsFull: boolean): Promise<Row> {
  const { services } = ctx;
  const row = fullFeature(services, s, f);
  const out = s.rebuild.outputs[f.id] as SketchOutput | undefined;
  const plane = out?.type === 'sketch' ? out.plane : f.plane;
  row.plane = { on: supportText(s, f), origin_mm: vec(plane.origin), normal: dir(plane.normal), u: dir(plane.xdir), v: dir(ydirOf(plane)), words: frameWords(plane) };
  // Its input form within this reply's room (sketch/describe.ts): null when the tool cannot write it, or it is too big to resend.
  const form = describeSketch(f, s, { budget: ctx.budgets.sketch });
  row.inputs = form.inputs;
  delete row.summary;
  if (!form.inputs) row.summary = summaryOf(f, services);
  row.solver = await solverNow(ctx, f, form.refOf);
  row.entities = f.entities.length;
  row.constraints = f.constraints.length;
  if (form.unsupported) row.unsupported = form.unsupported;
  if (form.tooBig) row.too_big = TOO_BIG_WORDS;
  if (out?.type === 'sketch') {
    const regions = regionRows(out);
    if (regionsFull) {
      row.regions = regions.slice(0, SKETCH_REGIONS).map((r) => ({ id: r.id, area_mm2: r.area_mm2, at: r.at, at_mm: vec(toModel(plane, r.at)), holes: r.holes, depth: r.depth, bbox_uv: r.bbox_uv, bounded_by: r.entities.slice(0, 40).map(form.refOf) }));
      if (regions.length > SKETCH_REGIONS) row.regions_more = regions.length - SKETCH_REGIONS;
    } else {
      const short = shortRegions(regions);
      row.regions = short.regions;
      if (short.more) row.regions_more = short.more;
    }
    row.open = out.open.slice(0, 40).map((o) => ({ at: vec(o.at), entity: form.refOf(o.entity), point: o.point ? form.refOf(o.point) : null }));
    row.dangling = out.dangling.slice(0, 40).map(form.refOf);
    if (out.supportLost) row.support_lost = true;
  }
  // Within the sketch budget: the regions' boundaries go first, then regions themselves.
  fitRegions(row, ctx.budgets.sketch);
  return row;
}

/** The sketch's definition now, from the solver apart from sketch mode; the stored state when the solver is not running. */
async function solverNow(ctx: CallCtx, f: SketchFeature, refOf: (id: string) => string = (id) => id): Promise<Row> {
  const solver = ctx.services.apis.get().solver;
  const stored = { state: f.solved.state, dof: f.solved.dof, source: 'stored' };
  if (!solver) return stored;
  const ev = evaluateDimensions(f, ctx.services.doc.units);
  if (Object.keys(ev.errors).length) return { ...stored, errors: ev.errors };
  try {
    const { solve, analysis } = await heartbeat(
      ctx,
      solver.ready().then(() => solver.analyzeFeature(f, ev.values)),
      `Checking ${f.name}`,
    );
    const st = statusOf(solve, analysis);
    // By the sketch tool's own rule and names (sketch/solve.ts freeRows).
    const entityIds = new Set(f.entities.map((e) => e.id));
    const free = freeRows(analysis.dependentParams, (owner) => owner in f.points || entityIds.has(owner), refOf);
    return {
      state: st.state,
      dof: st.dof,
      free,
      conflicting: st.conflicting.map(refOf),
      redundant: st.redundant.map(refOf),
      source: 'solver',
    };
  } catch {
    // The solver could not start or answer: what is stored, said as such.
    return stored;
  }
}

/** A feature by its name (any case) or its internal id. */
export function featureByName(s: DocState, name: string): Feature | null {
  const want = name.trim().toLowerCase();
  return s.doc.features.find((f) => f.name.toLowerCase() === want) ?? s.doc.features.find((f) => f.id === name.trim()) ?? null;
}

/** get_model: the Part (or one feature) after the rebuild caught up. */
export async function readModel(ctx: CallCtx, input: ModelInput): Promise<ToolReply> {
  const { services } = ctx;
  const rebuild: RebuildState = await heartbeat(ctx, services.doc.settled(ctx.signal), 'Waiting for the rebuild');
  await ctx.hold('after-settled');
  ctx.checkAbort();
  const s = services.doc.state.get();
  const counts = (rows: readonly Feature[]) => {
    const states: Record<string, number> = {};
    for (const f of rows) {
      const w = stateWord(s.rebuild.features[f.id]);
      states[w] = (states[w] ?? 0) + 1;
    }
    return states;
  };
  if (input.feature.trim()) {
    const f = featureByName(s, input.feature);
    if (!f) {
      const names = s.doc.features.map((g) => g.name);
      const near = closestName(input.feature, names);
      throw new ToolError('not_found', `No feature is called "${input.feature.trim()}".${closestWords(near)} Features: ${names.slice(0, NAMES_MAX).join(', ') || 'none yet'}.`, {
        detail: { names: names.slice(0, NAMES_MAX), more: Math.max(0, names.length - NAMES_MAX), ...(near ? { closest: near } : {}) },
      });
    }
    const facts = await partFacts(ctx, s);
    const row = f.type === 'sketch' ? await sketchDetail(ctx, s, f, input.regions === 'full') : await fullFeatureNow(services, s, f);
    const data = { ...Object.fromEntries(FEATURE_BASE.filter((k) => k in facts).map((k) => [k, facts[k]])), feature: row };
    const state = String(row.state);
    return {
      text: `${f.name} (${f.type}): ${state}${row.message ? ` · ${String(row.message)}` : ''}${row.note ? ` · note: ${String(row.note)}` : ''}`,
      data,
      summary: `Read ${f.name}: ${state}`,
    };
  }
  const base = await partFacts(ctx, s);
  // Every body in one short row, whole and first: the rest of the reply fits the room the parts
  // leave (at least half the budget), within what the app's result cap leaves after them.
  const { parts, more } = await partRows(services, s);
  const listed: Row = { parts, ...(more ? { parts_more: more } : {}) };
  const room = jsonBytes(listed);
  const b = ctx.budgets;
  const cap = Math.max(REST_MIN, RESULT_DATA_BYTES - RESULT_MARGIN - room);
  const budgets = { ...b, brief: Math.min(cap, Math.max(b.brief / 2, b.brief - room)), full: Math.min(cap, Math.max(b.full / 2, b.full - room)) };
  const fitted = input.detail === 'full' ? await fitFull(base, services, s, budgets) : fitBrief(base, s.doc.features.map((f) => briefFeature(services, s, f)), budgets);
  const data: Row = { ...listed, ...fitted };
  const states = counts(s.doc.features);
  const bad = (states.error ?? 0) + (states.warning ?? 0);
  const nBodies = rebuild.bodies.length;
  const word = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const text = `Part "${String(base.part)}": ${word(s.doc.features.length, 'feature', 'features')}${bad ? ` (${[states.error ? `${states.error} failing` : '', states.warning ? `${states.warning} with warnings` : ''].filter(Boolean).join(', ')})` : ''}, ${word(nBodies, 'body', 'bodies')}`;
  return { text, data, summary: `Read the Part: ${word(s.doc.features.length, 'feature', 'features')}, ${word(nBodies, 'body', 'bodies')}` };
}
