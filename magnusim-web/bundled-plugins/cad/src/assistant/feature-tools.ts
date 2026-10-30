// What the tools that make or replace one feature share (modify, pattern and combine; CAD tools
// spec §3.2.11-13, §7.3, §7.5, §7.7):
//   - `edit`: "" makes a new feature; a name replaces that feature's inputs, which needs its type
//     (wrong_feature_type otherwise). `name`: "" for the next free name (an edit keeps its own);
//     any other name must be free (name_taken), and the facade passes it only after that check;
//   - the fill: the person's own panel (openForAssistant with every field at once, or
//     openEditForAssistant and one update with every top-level field whole), read-only for the
//     person, its live rebuild, then an honest Done. The call's own feature failing before its
//     Done is the call's failure (feature_failed with the feature's own message and actions, or
//     kernel_failed when the kernel stopped it); a Done that keeps nothing says why (incomplete);
//   - the faces the feature made, as labels (EditData.created);
//   - the words get_model full writes a stored reference in, so a feature's inputs can be sent
//     back with edit: a face's label with its ~k as the bodies just before the feature number it
//     (where a resend reads it: refBodiesOf; the shown bodies when those cannot be built), so a
//     label that several faces share (a mirror copy's, a pattern copy's, a trimmed side) names the
//     one face, and a fillet face's number counts there; "<body> face at (x, y, z)" when it has
//     none, or is a split face; an edge as "<label A> & <label B>" (or "<body> edge at (x, y, z)"),
//     axes and planes as selectors, bodies by their names.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { storedBodyName } from '../doc/features/body-ids';
import { splitEdgeName } from '../naming/edges';
import { splitMerged, splitSuffix } from '../naming/names';
import type { AppServices } from '../types/app';
import type { BodyId, Feature, FeatureId, FeatureType, PersistentRef, Vec3 } from '../types/doc';
import type { DocState } from '../types/doc-service';
import type { AxisRef, PlaneRef } from '../types/references';
import { uiFor } from '../ui/controller';
import { heartbeat } from './busy';
import { ToolError } from './errors';
import { featureIoOf } from './features-io';
import type { JudgedPlan } from './judge';
import { baseLabel, LabelIndex, modelId, parsePart, quoteName, type LabelBody, type LabelNames } from './labels';
import { featureByName, stateWord } from './model';
import { len } from './numbers';
import { macrotask } from './pace';
import type { EditCtx } from './step';
import { closestName, closestWords } from './closest';

/** A feature name's longest (the Part's own rename rule). */
export const NAME_MAX = 40;

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);

/** "a", "a and b", "a, b and c". */
export function andList(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A feature type in words ("fillet", "linear pattern"). */
export function typeWord(services: AppServices, type: FeatureType): string {
  return (services.doc.features.get(type)?.label ?? type).toLowerCase();
}

/** "a fillet", "an extrude". */
const article = (w: string) => `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;

/**
 * The feature `edit` names, or null ("" makes a new one). Its type must be one of `types`; another
 * type answers wrong_feature_type with `how(f)` ("send kind chamfer") or the tool that changes it.
 */
export function editTarget(services: AppServices, edit: unknown, types: readonly FeatureType[], want: string, how?: (f: Feature) => string | null): Feature | null {
  const name = str(edit);
  if (!name) return null;
  const s = services.doc.state.get();
  const f = featureByName(s, name);
  if (!f) {
    const names = s.doc.features.map((g) => g.name);
    const near = closestName(name, names);
    throw new ToolError('not_found', `edit: no feature is called "${name}".${closestWords(near)} Features: ${names.length ? names.slice(0, 30).join(', ') : 'none yet'}.`, { detail: { field: 'edit', names: names.slice(0, 30), ...(near ? { closest: near } : {}) } });
  }
  if (!types.includes(f.type)) {
    const io = featureIoOf(f.type);
    const fix = how?.(f) ?? (io ? `change it with ${io.tool}, or with edit_feature` : 'change it with edit_feature');
    throw new ToolError('wrong_feature_type', `edit: ${f.name} is ${article(typeWord(services, f.type))}, not ${article(want)}: ${fix}.`, { detail: { field: 'edit', feature: f.name, type: f.type } });
  }
  return f;
}

/** The name `name` asks for, or null: the next free one (a new feature) or the feature's own (an edit). */
export function nameFor(services: AppServices, name: unknown, editing: Feature | null): string | null {
  const n = str(name);
  if (!n || (editing && n === editing.name)) return null;
  if (n.length > NAME_MAX) throw new ToolError('bad_input', `name: at most ${NAME_MAX} characters.`, { detail: { field: 'name' } });
  const clash = services.doc.state.get().doc.features.find((g) => g.id !== editing?.id && g.name.toLowerCase() === n.toLowerCase());
  if (clash) throw new ToolError('name_taken', `name: another feature is already called ${clash.name}.`, { detail: { field: 'name' } });
  return n;
}

/** The call's part in the undo label and the ledger: "Fillet 1", "Shell Cup", "Edit Fillet 1". */
export function partOf(services: AppServices, type: FeatureType, name: string, edit: boolean): string {
  const label = services.doc.features.get(type)?.label ?? type;
  const own = name.toLowerCase().startsWith(label.toLowerCase()) ? name : `${label} ${name}`;
  return edit ? `Edit ${name}` : own;
}

export interface FeatureFill {
  /** The feature an edit replaces, or null for a new one. */
  edit: FeatureId | null;
  type: FeatureType;
  /** Every field the call sets: a new feature's init, or an edit's top-level fields, each whole; the name when one is given. */
  fields: Partial<Feature>;
  /** The progress line ("Fillet 1"). */
  label: string;
}

/**
 * Make or replace one feature on the person's path inside the call's step (CAD tools spec §7.2,
 * §7.3): the panel opens read-only (a new feature with every field filled at once), the rebuild
 * follows, and the panel's honest Done keeps it. Sets the plan's own feature (the judge reads it),
 * and answers its id.
 */
export async function fillFeature(ctx: EditCtx, plan: JudgedPlan, fill: FeatureFill): Promise<FeatureId> {
  const { doc } = ctx.services;
  const ui = uiFor(ctx.services);
  const was = fill.edit ? stateWord(doc.state.get().rebuild.features[fill.edit]) : null;
  const s = fill.edit ? ui.openEditForAssistant(ctx.step, fill.edit) : ui.openForAssistant(ctx.step, fill.type, fill.fields);
  if (typeof s === 'string') throw new ToolError('bad_input', `${fill.label} cannot be opened here: ${s}.`);
  plan.own = s.feature;
  plan.feature = s.feature;
  // React draws the panel before the next step (its effects run on the person's own path).
  await macrotask();
  await ctx.checkpoint({ hold: 'after-open', pace: 'open', label: fill.label });
  if (fill.edit) s.update(fill.fields);
  ctx.wrote(s);
  await heartbeat(ctx, doc.settled(ctx.signal), fill.label);
  await ctx.checkpoint({ pace: 'commit', hold: 'before-commit', label: fill.label });
  // The feature's own state before its Done: a feature that does not build is the call's failure.
  const st = doc.state.get().rebuild.features[s.feature];
  if (st?.state === 'error' && was !== 'error') {
    const name = s.draft.name;
    const detail = { feature: name, message: st.message ?? null, actions: [...(st.actions ?? [])] };
    if (st.actions?.includes('retry')) throw new ToolError('kernel_failed', `The geometry kernel stopped ${name}: ${st.message ?? 'no answer'}`, { detail });
    throw new ToolError('feature_failed', `${name} fails: ${st.message ?? 'it did not build'}`, { detail });
  }
  const why = ui.doneForAssistant(ctx.step);
  if (why) throw new ToolError('incomplete', `${fill.label}: ${why}.`);
  return s.feature;
}

/** The Part's feature names as the labels read them. */
export function labelNames(s: DocState): LabelNames {
  const names = new Map(s.doc.features.map((f) => [f.id, f.name]));
  return { featureName: (id) => names.get(id) ?? null };
}

/** Face labels an edit's reply lists as created (created_more counts the rest). */
export const CREATED_MAX = 12;

/** The labels of the faces `feature` made on the bodies built now, each once (EditData.created), and how many more there are. */
export function createdLabels(services: AppServices, feature: FeatureId, max = CREATED_MAX): { labels: string[]; more: number } {
  const s = services.doc.state.get();
  const names = labelNames(s);
  const out = new Set<string>();
  for (const b of s.rebuild.bodies) {
    const list = b.names?.faces ?? [];
    for (const n of list) {
      for (const part of splitMerged(n)) {
        if (parsePart(splitSuffix(part).base)?.feature !== feature) continue;
        const lb = baseLabel(part, names, list);
        if (lb) out.add(lb.text);
        break;
      }
    }
  }
  const all = [...out];
  return { labels: all.slice(0, max), more: Math.max(0, all.length - max) };
}

// ------------------------------------------------------------------ stored references as selectors

const point = (p: Vec3 | readonly number[]) => `(${[...p].map((v) => len(v)).join(', ')})`;

function bodyName(s: DocState, id: BodyId): string {
  // A body no rebuild shows now (a Delete body's, a Combine's used-up tool): a split piece by the derived-name rule.
  return s.doc.bodies[id]?.name ?? s.rebuild.bodies.find((b) => b.id === id)?.name ?? storedBodyName(s.doc, id) ?? id;
}

/** A body by its name, as a body list writes it. */
export function bodyText(s: DocState, id: BodyId): string {
  return quoteName(bodyName(s, id));
}

const isSplit = (name: string) => splitMerged(name).some((p) => splitSuffix(p).k !== null);

/**
 * The bodies a feature's stored references are written against: those just before it (a resend
 * with edit reads its selectors there), with their labels.
 */
export interface RefBodies {
  bodies: readonly LabelBody[];
  labels: LabelIndex;
}

/** The bodies just before feature `id` with their labels, or null when they cannot be built now. */
export async function refBodiesOf(services: AppServices, id: FeatureId): Promise<RefBodies | null> {
  try {
    const eb = await services.doc.bodiesBefore(id);
    const bodies = eb.bodies.map((b) => ({ id: b.id, names: b.names }));
    return { bodies, labels: new LabelIndex(bodies, labelNames(services.doc.state.get())) };
  } catch {
    return null;
  }
}

const SHOWN = new WeakMap<object, RefBodies>();
/** The shown bodies with their labels (when the bodies before a feature are not at hand). */
function shownBodies(s: DocState): RefBodies {
  let r = SHOWN.get(s.rebuild);
  if (!r) {
    r = { bodies: s.rebuild.bodies, labels: new LabelIndex(s.rebuild.bodies, labelNames(s)) };
    SHOWN.set(s.rebuild, r);
  }
  return r;
}

/** The label (with its ~k) of the face a stored name names on `at`'s bodies, or null (no label, a split face, not found). */
function labelOn(at: RefBodies, body: BodyId, name: string): string | null {
  if (isSplit(name)) return null;
  const bi = at.bodies.findIndex((b) => b.id === body);
  if (bi < 0) return null;
  const faces = at.bodies[bi].names?.faces ?? [];
  let fi = faces.indexOf(name);
  if (fi < 0) {
    // A face merged since the pick carries the stored name among its parts.
    const parts = splitMerged(name);
    const hits = faces.flatMap((n, i) => (parts.every((p) => splitMerged(n).includes(p)) ? [i] : []));
    if (hits.length !== 1) return null;
    fi = hits[0];
  }
  const fl = at.labels.of(bi, fi);
  return fl.label && !fl.warning ? fl.label : null;
}

/** A stored face reference as a face selector: its label on `at`'s bodies (the shown ones by default), else a point on the body (its signature's centre). */
export function faceText(s: DocState, body: BodyId, ref: PersistentRef, at: RefBodies | null = null): string {
  const lb = labelOn(at ?? shownBodies(s), body, ref.name);
  return lb ?? `${bodyText(s, body)} face at ${point(ref.signature.at)}`;
}

/** A stored edge reference as an edge selector: "<label A> & <label B>" on `at`'s bodies, else a point on the body. */
export function edgeText(s: DocState, body: BodyId, ref: PersistentRef, at: RefBodies | null = null): string {
  const pair = splitEdgeName(ref.name);
  if (pair) {
    const where = at ?? shownBodies(s);
    const a = labelOn(where, body, pair[0]);
    const b = labelOn(where, body, pair[1]);
    if (a && b && a !== b) return `${a} & ${b}`;
  }
  return `${bodyText(s, body)} edge at ${point(ref.signature.at)}`;
}

const featureName = (s: DocState, id: FeatureId) => quoteName(s.doc.features.find((f) => f.id === id)?.name ?? id);

/** A plane reference as a plane selector ("" for none). */
export function planeText(s: DocState, p: PlaneRef | null, at: RefBodies | null = null): string {
  if (!p) return '';
  switch (p.kind) {
    case 'origin':
      return p.plane === 'origin:top' ? 'Top' : p.plane === 'origin:front' ? 'Front' : 'Right';
    case 'face':
      return faceText(s, p.body, p.ref, at);
    case 'feature':
      return featureName(s, p.feature);
  }
}

/** An axis reference as an axis selector ("" for none). */
export function axisText(s: DocState, a: AxisRef | null, at: RefBodies | null = null): string {
  if (!a) return '';
  switch (a.kind) {
    case 'origin':
      return `${a.axis.slice(-1).toUpperCase()} axis`;
    case 'sketch-line':
      return `${featureName(s, a.sketch)}.${modelId(a.entity)}`;
    case 'edge':
      return edgeText(s, a.body, a.ref, at);
    case 'face-axis':
      return `axis of ${faceText(s, a.body, a.ref, at)}`;
    case 'feature':
      return featureName(s, a.feature);
    case 'normal':
      return `normal of ${planeText(s, a.plane, at)}`;
  }
}

/**
 * A FeatureIo pathOf: the tool's field names (`map`), and the feature's own expression paths as
 * they are ("radius"), so a field get_model listed before a tool named it still works.
 */
export function pathIn(services: AppServices, f: Feature, field: string, map: Record<string, string>): string | null {
  if (Object.prototype.hasOwnProperty.call(map, field)) return map[field];
  const def = services.doc.features.get(f.type);
  return def?.exprs?.(f as never).some((x) => x.path === field) ? field : null;
}
