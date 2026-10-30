// What a measure call's targets and section name (CAD tools spec §3.2.3, §5), on the bodies built
// now. The forms this file reads itself:
//   a body          its name (any case; quotes allowed) or id: in measure a name is the body's
//                   first (§5.2, "body lists in measure take the body");
//   a point         "(x, y, z)" in model mm;
//   selection       the one thing the person has selected (a face, edge, vertex, body, an origin
//                   plane or axis, a construction plane, axis or point);
//   a plane         Top, Front, Right (XY, XZ, YZ; "plane" may follow), a construction plane's
//                   name, each with " offset <length>" and " flip" (the offset the other way);
//   an axis         X, Y or Z (" axis" may follow), a construction axis's name;
//   a point         origin, a construction point's name.
// Everything else (faces, edges and vertices by selector, the handles find and view give, the
// selectors' planes and axes) goes to the selector resolver the measure tool registers
// (registerSelectorResolver, measure-selectors.ts). A text that is neither answers bad_selector
// with the selector's own words (and its column) and the forms that work.
// A target is one thing: none is nothing_selected, several selector_ambiguous with candidates.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { offsetPlane } from '../features/refgeom/geom';
import { userSelection } from '../lib/selection';
import type { CallCtx } from '../types/assistant';
import { ORIGIN_PLANES, type OriginPlaneRef, type OriginRef, type PlaneFrame, type Vec3 } from '../types/doc';
import type { DocState } from '../types/doc-service';
import type { BodyInfo } from '../types/kernel';
import type { ConstructOutput, PlaneRef } from '../types/references';
import { pickFace } from '../features/p2/refs';
import type { SelectionItem } from '../types/selection';
import { ToolError } from './errors';
import { selectionWords } from './model';
import { vec } from './numbers';

/**
 * One thing a measure target names, as built now. `words` says what it is ("face End face of Plate
 * on Body 1"); `warnings` what the selector warned of ("#f3 moved: check", a split face).
 */
export type Entity = (
  | { kind: 'body'; body: BodyInfo; words: string }
  | { kind: 'face'; body: BodyInfo; index: number; words: string }
  | { kind: 'edge'; body: BodyInfo; index: number; words: string }
  | { kind: 'vertex'; body: BodyInfo; index: number; words: string }
  | { kind: 'point'; p: Vec3; words: string }
  | { kind: 'plane'; frame: PlaneFrame; words: string }
  | { kind: 'axis'; origin: Vec3; dir: Vec3; words: string }
) & { warnings?: string[] };

/**
 * Resolves a selector of the selector language (faces, edges, vertices, handles) to what it names
 * on the bodies built now, or throws its ToolError (bad_selector with the column where the text
 * stops being a selector, nothing_selected, selector_stale, ...). Returns null for a text it does
 * not read. The measure tool registers measure-selectors.ts.
 */
export type SelectorResolver = (ctx: CallCtx, text: string, o: { field: string }) => Promise<readonly Entity[] | null>;

let selectorResolver: SelectorResolver | null = null;

/** The selector language's resolver (measure-selectors.ts), or null to take it away (tests). */
export function registerSelectorResolver(fn: SelectorResolver | null): void {
  selectorResolver = fn;
}

/** Most candidates an ambiguous target lists. */
export const CANDIDATES_MAX = 8;
/** Most names a target that names nothing lists. */
const NAMES_MAX = 30;

const ORIGIN_PLANE_WORDS: Record<string, OriginPlaneRef> = { top: 'origin:top', xy: 'origin:top', front: 'origin:front', xz: 'origin:front', right: 'origin:right', yz: 'origin:right' };
const PLANE_WORD: Record<OriginPlaneRef, string> = { 'origin:top': 'Top', 'origin:front': 'Front', 'origin:right': 'Right' };
const AXIS_DIRS: Record<string, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const ORIGIN_AXIS: Record<string, string> = { 'origin:x': 'x', 'origin:y': 'y', 'origin:z': 'z' };

/** `"Body 1"` → `Body 1`: quotes around a whole name are allowed. */
export function unquote(text: string): string {
  const t = text.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).trim() : t;
}

const NUM = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?`;
const POINT = new RegExp(String.raw`^\(\s*(${NUM})\s*,\s*(${NUM})\s*,\s*(${NUM})\s*\)$`, 'i');

/** "(x, y, z)" in model mm, or null. */
export function parsePoint(text: string): Vec3 | null {
  const m = POINT.exec(text.trim());
  if (!m) return null;
  const p = [Number(m[1]), Number(m[2]), Number(m[3])] as Vec3;
  return p.every(Number.isFinite) ? p : null;
}

/** A plane selector's base and its " offset <length> [flip]" (§5.2 plane_sel). */
export function splitOffset(text: string): { base: string; offset: string | null; flip: boolean } {
  const m = /^(.*?)\s+offset\s+(.+?)(\s+flip)?\s*$/i.exec(text.trim());
  if (!m || !m[1].trim()) return { base: text.trim(), offset: null, flip: false };
  return { base: m[1].trim(), offset: m[2].trim(), flip: !!m[3] };
}

/** A body built now by its name (any case) or id. */
export function bodyNamed(s: DocState, name: string): BodyInfo | null {
  const want = unquote(name).toLowerCase();
  return s.rebuild.bodies.find((b) => b.name.toLowerCase() === want) ?? s.rebuild.bodies.find((b) => b.id === unquote(name)) ?? null;
}

/** A construction plane, axis or point by its feature's name (any case), with its built output. */
function constructNamed(s: DocState, name: string): { id: string; name: string; out: ConstructOutput | null } | null {
  const want = unquote(name).toLowerCase();
  const f = s.doc.features.find((g) => (g.type === 'ref_plane' || g.type === 'ref_axis' || g.type === 'ref_point') && g.name.toLowerCase() === want);
  if (!f) return null;
  const out = s.rebuild.outputs[f.id] as ConstructOutput | { type?: string } | undefined;
  return { id: f.id, name: f.name, out: out && (out.type === 'plane' || out.type === 'axis' || out.type === 'point') ? (out as ConstructOutput) : null };
}

/** A plane frame moved `offset` (an expression, the Part's units) along its normal; `flip` the other way. */
function offsetBy(ctx: CallCtx, frame: PlaneFrame, offset: string | null, flip: boolean, field: string): PlaneFrame {
  if (offset === null) return frame;
  const r = ctx.services.doc.units.evaluate(offset, 'length');
  if (!r.ok) throw new ToolError('expr_error', `${field}: offset "${offset}": ${r.error}`, { detail: { field } });
  return offsetPlane(frame, flip ? -r.value : r.value);
}

/** An origin plane, a construction plane, an axis or a point named by `text` (with an offset for planes), or null. */
function referenceGeometry(ctx: CallCtx, s: DocState, text: string, field: string): Entity | null {
  const { base, offset, flip } = splitOffset(text);
  const word = unquote(base).toLowerCase().replace(/\s+plane$/, '');
  const origin = ORIGIN_PLANE_WORDS[word];
  if (origin) {
    const p = ORIGIN_PLANES[origin];
    return { kind: 'plane', frame: offsetBy(ctx, { origin: [...p.origin], normal: [...p.normal], xdir: [...p.xdir] }, offset, flip, field), words: offset === null ? `${PLANE_WORD[origin]} plane` : text.trim() };
  }
  const built = constructNamed(s, base);
  if (built) {
    if (!built.out) throw new ToolError('nothing_selected', `${built.name} is not built now (it fails, is suppressed or rolled back).`, { detail: { field } });
    if (built.out.type === 'plane') return { kind: 'plane', frame: offsetBy(ctx, built.out.frame, offset, flip, field), words: offset === null ? `plane ${built.name}` : text.trim() };
    if (offset !== null) throw new ToolError('bad_selector', `${field}: only a plane takes an offset; ${built.name} is ${built.out.type === 'axis' ? 'an axis' : 'a point'}.`, { detail: { field } });
    if (built.out.type === 'axis') return { kind: 'axis', origin: [...built.out.origin], dir: [...built.out.dir], words: `axis ${built.name}` };
    return { kind: 'point', p: [...built.out.p], words: `point ${built.name}` };
  }
  if (offset !== null) return null;
  const axis = /^([xyz])(?:\s+axis)?$/i.exec(word);
  if (axis) return { kind: 'axis', origin: [0, 0, 0], dir: [...AXIS_DIRS[axis[1].toLowerCase()]], words: `${axis[1].toUpperCase()} axis` };
  if (word === 'origin') return { kind: 'point', p: [0, 0, 0], words: 'the origin' };
  return null;
}

/** One selected item as an entity, or null when measure cannot take it (a sketch entity, a region). */
function selectedEntity(s: DocState, item: SelectionItem): Entity | null {
  switch (item.kind) {
    case 'face':
    case 'edge':
    case 'vertex': {
      const body = s.rebuild.bodies.find((b) => b.id === item.body);
      return body ? { kind: item.kind, body, index: item.index, words: selectionWords(s, item) } : null;
    }
    case 'body': {
      const body = s.rebuild.bodies.find((b) => b.id === item.body);
      return body ? { kind: 'body', body, words: body.name } : null;
    }
    case 'origin': {
      const ref = item.ref as OriginRef;
      if (ref === 'origin:point') return { kind: 'point', p: [0, 0, 0], words: 'the origin' };
      if (ref in ORIGIN_PLANES) {
        const p = ORIGIN_PLANES[ref as OriginPlaneRef];
        return { kind: 'plane', frame: { origin: [...p.origin], normal: [...p.normal], xdir: [...p.xdir] }, words: `${PLANE_WORD[ref as OriginPlaneRef]} plane` };
      }
      const a = ORIGIN_AXIS[ref];
      return a ? { kind: 'axis', origin: [0, 0, 0], dir: [...AXIS_DIRS[a]], words: `${a.toUpperCase()} axis` } : null;
    }
    case 'feature': {
      const f = s.doc.features.find((g) => g.id === item.feature);
      if (!f) return null;
      const out = s.rebuild.outputs[f.id] as ConstructOutput | { type?: string } | undefined;
      if (out?.type === 'plane') return { kind: 'plane', frame: (out as Extract<ConstructOutput, { type: 'plane' }>).frame, words: `plane ${f.name}` };
      if (out?.type === 'axis') return { kind: 'axis', origin: [...(out as Extract<ConstructOutput, { type: 'axis' }>).origin], dir: [...(out as Extract<ConstructOutput, { type: 'axis' }>).dir], words: `axis ${f.name}` };
      if (out?.type === 'point') return { kind: 'point', p: [...(out as Extract<ConstructOutput, { type: 'point' }>).p], words: `point ${f.name}` };
      return null;
    }
    default:
      return null;
  }
}

/** The person's selection as entities (what measure cannot take is left out), and how many items it held. */
function selectionEntities(ctx: CallCtx, s: DocState): { entities: Entity[]; items: number } {
  const items = userSelection(ctx.services.selection.get()).items;
  const entities: Entity[] = [];
  for (const it of items) {
    const e = selectedEntity(s, it);
    if (e) entities.push(e);
  }
  return { entities, items: items.length };
}

/** A candidate as an ambiguous target lists it. */
export function candidateOf(e: Entity): Record<string, unknown> {
  const row: Record<string, unknown> = { words: e.words };
  if (e.kind === 'point') row.center_mm = vec(e.p);
  if (e.kind === 'plane') row.center_mm = vec(e.frame.origin);
  if (e.kind === 'axis') row.center_mm = vec(e.origin);
  return row;
}

/** Exactly one of `list`, else nothing_selected or selector_ambiguous. */
function one(list: readonly Entity[], text: string, field: string): Entity {
  if (list.length === 1) return list[0];
  if (!list.length) throw new ToolError('nothing_selected', `${field}: "${text}" matches nothing.`, { detail: { field } });
  throw new ToolError('selector_ambiguous', `${field}: "${text}" matches ${list.length} things; a target is one.`, {
    detail: { field, count: list.length, candidates: list.slice(0, CANDIDATES_MAX).map(candidateOf) },
  });
}

/** A selector's own syntax error (bad_selector with its column), or null. */
const syntaxError = (e: unknown): ToolError | null => (e instanceof ToolError && e.reason === 'bad_selector' && typeof e.detail.column === 'number' ? e : null);

/** What a selector's syntax error says, without its reason and field ("no body or feature is called ... (column 1 of ...)"). */
function syntaxWords(e: ToolError, field: string): string {
  let t = e.message.replace(/^bad_selector: /, '');
  if (t.startsWith(`${field}: `)) t = t.slice(field.length + 2);
  return t.replace(/\.$/, '');
}

/** The words of a target that names nothing measure reads, with what exists (and why it is no selector). */
function unknownTarget(s: DocState, text: string, field: string, parse: ToolError | null): ToolError {
  const bodies = s.rebuild.bodies.map((b) => b.name);
  const stored = Object.values(s.doc.bodies).map((b) => b.name);
  const want = unquote(text).toLowerCase();
  if (stored.some((n) => n.toLowerCase() === want)) {
    return new ToolError('nothing_selected', `${field}: ${unquote(text)} is not built now (removed by a later feature, or the rollback bar is above it).`, { detail: { field, bodies: bodies.slice(0, NAMES_MAX) } });
  }
  return new ToolError(
    'bad_selector',
    `${field}: "${text}" is not a body here${parse ? `, nor a selector (${syntaxWords(parse, field)})` : ''}. Use a body name, a face, edge or vertex selector (help selectors), "(x, y, z)", "selection" (what the person selected), Top, Front, Right (with "offset <length>"), an axis, or a construction plane. Bodies: ${bodies.slice(0, NAMES_MAX).join(', ') || 'none yet'}.`,
    { detail: { field, bodies: bodies.slice(0, NAMES_MAX), ...(parse ? { selector: text, column: parse.detail.column } : {}) } },
  );
}

/** One measure target (§3.2.3: "A body, a face, edge or vertex selector, or (x, y, z)"). */
export async function resolveTarget(ctx: CallCtx, s: DocState, text: string, field: string): Promise<Entity> {
  const raw = text.trim();
  if (!raw) throw new ToolError('bad_selector', `${field} is empty: give a body, a face, edge or vertex, or "(x, y, z)".`, { detail: { field } });
  const body = bodyNamed(s, raw);
  if (body) return { kind: 'body', body, words: body.name };
  const p = parsePoint(raw);
  if (p) return { kind: 'point', p, words: `the point (${vec(p).join(', ')})` };
  if (/^selection$/i.test(raw)) {
    const sel = selectionEntities(ctx, s);
    if (!sel.entities.length) {
      throw new ToolError('nothing_selected', sel.items ? `${field}: the selection holds nothing measure takes (a sketch entity or a region).` : `${field}: the person has nothing selected.`, { detail: { field } });
    }
    return one(sel.entities, raw, field);
  }
  const ref = referenceGeometry(ctx, s, raw, field);
  if (ref) return ref;
  let parse: ToolError | null = null;
  if (selectorResolver) {
    let list: readonly Entity[] | null = null;
    try {
      list = await selectorResolver(ctx, raw, { field });
    } catch (e) {
      // Neither a body nor a selector: say both (with the selector's column).
      parse = syntaxError(e);
      if (!parse) throw e;
    }
    if (list) return one(list, raw, field);
  }
  throw unknownTarget(s, raw, field, parse);
}

/** Where a section cuts, in model terms: its frame and the words for it. */
export interface SectionPlane {
  frame: PlaneFrame;
  words: string;
}

/**
 * The section's plane (§3.2.3 section: "Top offset 4 mm", a construction plane, a flat face; with
 * " offset <length>" and " flip"). `planeOfFace` turns a face into its plane (a flat face only).
 */
export async function resolveSectionPlane(ctx: CallCtx, s: DocState, text: string, planeOfFace: (e: Extract<Entity, { kind: 'face' }>) => Promise<PlaneFrame>): Promise<SectionPlane> {
  const field = 'section';
  const raw = text.trim();
  const ref = referenceGeometry(ctx, s, raw, field);
  if (ref) {
    if (ref.kind !== 'plane') throw new ToolError('bad_section', `section: ${ref.words} is not a plane.`, { detail: { field } });
    return { frame: ref.frame, words: ref.words };
  }
  const { base, offset, flip } = splitOffset(raw);
  let e: Entity | null = null;
  let parse: ToolError | null = null;
  if (/^selection$/i.test(base)) {
    const sel = selectionEntities(ctx, s);
    if (!sel.entities.length) throw new ToolError('nothing_selected', 'section: the person has no flat face or plane selected.', { detail: { field } });
    e = one(sel.entities, base, field);
  } else if (bodyNamed(s, base)) {
    throw new ToolError('bad_section', `section: ${unquote(base)} is a body; the section is a plane (Top offset 4 mm, a construction plane, a flat face).`, { detail: { field } });
  } else if (selectorResolver) {
    let list: readonly Entity[] | null = null;
    try {
      list = await selectorResolver(ctx, base, { field });
    } catch (err) {
      parse = syntaxError(err);
      if (!parse) throw err;
    }
    if (list) e = one(list, base, field);
  }
  if (!e) {
    throw new ToolError(
      'bad_section',
      `section: "${raw}" is not a plane here${parse ? ` (${syntaxWords(parse, field)})` : ''}. Use Top, Front or Right (with "offset <length>"), a construction plane, a flat face (with "offset <length>"), or "selection" with a flat face selected.`,
      { detail: { field, ...(parse ? { selector: base, column: parse.detail.column } : {}) } },
    );
  }
  if (e.kind === 'plane') return { frame: offsetBy(ctx, e.frame, offset, flip, field), words: offset === null ? e.words : raw };
  if (e.kind !== 'face') throw new ToolError('bad_section', `section: ${e.words} is not a plane or a flat face.`, { detail: { field } });
  const frame = await planeOfFace(e);
  return { frame: offsetBy(ctx, frame, offset, flip, field), words: offset === null ? e.words : `${e.words} offset ${offset}${flip ? ' flip' : ''}` };
}

// ------------------------------------------------------------------ the section view's plane

/**
 * A cut as the view tool's section and the workspace's section write it, read but not found yet:
 * "<plane> [offset <length> | middle] [flip]" (flip keeps the other side). null for "".
 */
export interface SectionText {
  base: string;
  offset: string | null;
  middle: boolean;
  flip: boolean;
}

export function splitSection(text: string): SectionText | null {
  const t = text.trim();
  if (!t) return null;
  const m = /^(.*?)(?:\s+offset\s+(.+?)|\s+(middle))?(?:\s+(flip))?\s*$/i.exec(t)!;
  return { base: m[1].trim(), offset: m[2]?.trim() ?? null, middle: !!m[3], flip: !!m[4] };
}

/** The forms a section takes, for its refusals. */
export const SECTION_FORMS = 'Top, Front or Right, a construction plane, a flat face or "selection" (a flat face or plane selected), then "offset <length>" or "middle", then "flip"';

/**
 * The plane a section's text names, as the section view keeps it (src/features/section): an origin
 * plane, a construction plane (its feature: the cut follows it), or a flat face (its stored reference:
 * the cut follows the face). The same forms as measure's section (resolveSectionPlane), read to what
 * they are rather than to where they are now. Anything else is bad_section in words.
 */
export async function resolveSectionRef(ctx: CallCtx, s: DocState, base: string, field = 'section'): Promise<PlaneRef> {
  const word = unquote(base).toLowerCase().replace(/\s+plane$/, '');
  const origin = ORIGIN_PLANE_WORDS[word];
  if (origin) return { kind: 'origin', plane: origin };
  const built = constructNamed(s, base);
  if (built) {
    if (!built.out) throw new ToolError('nothing_selected', `${field}: ${built.name} is not built now (it fails, is suppressed or rolled back).`, { detail: { field } });
    if (built.out.type !== 'plane') throw new ToolError('bad_section', `${field}: ${built.name} is ${built.out.type === 'axis' ? 'an axis' : 'a point'}, not a plane.`, { detail: { field } });
    return { kind: 'feature', feature: built.id };
  }
  if (bodyNamed(s, base)) throw new ToolError('bad_section', `${field}: ${unquote(base)} is a body; a section is a plane (${SECTION_FORMS}).`, { detail: { field } });
  let item: SelectionItem | null = null;
  let e: Entity | null = null;
  let parse: ToolError | null = null;
  if (/^selection$/i.test(base)) {
    const items = userSelection(ctx.services.selection.get()).items.filter((it) => it.kind === 'face' || it.kind === 'origin' || it.kind === 'feature');
    if (!items.length) throw new ToolError('nothing_selected', `${field}: the person has no flat face or plane selected.`, { detail: { field } });
    if (items.length > 1) throw new ToolError('selector_ambiguous', `${field}: the person has ${items.length} faces or planes selected; a section is one.`, { detail: { field, count: items.length } });
    item = items[0];
  } else if (base && selectorResolver) {
    let list: readonly Entity[] | null = null;
    try {
      list = await selectorResolver(ctx, base, { field });
    } catch (err) {
      parse = syntaxError(err);
      if (!parse) throw err;
    }
    if (list) e = one(list, base, field);
  }
  if (e?.kind === 'face') item = { kind: 'face', body: e.body.id, index: e.index };
  if (item?.kind === 'origin' && item.ref in ORIGIN_PLANES) return { kind: 'origin', plane: item.ref as OriginPlaneRef };
  if (item?.kind === 'feature') {
    const f = s.doc.features.find((g) => g.id === (item as { feature: string }).feature);
    const out = f ? (s.rebuild.outputs[f.id] as { type?: string } | undefined) : undefined;
    if (f && out?.type === 'plane') return { kind: 'feature', feature: f.id };
    throw new ToolError('bad_section', `${field}: ${f?.name ?? 'that'} is not a plane built now.`, { detail: { field } });
  }
  if (item?.kind === 'face') {
    const body = s.rebuild.bodies.find((b) => b.id === (item as { body: string }).body);
    if (!body) throw new ToolError('nothing_selected', `${field}: that face's body is not built now.`, { detail: { field } });
    const r = await pickFace(ctx.services, body, item.index, null);
    if (!r.ok) throw new ToolError('bad_section', `${field}: ${r.reason}.`, { detail: { field } });
    if (r.ref.signature.type !== 'plane') throw new ToolError('bad_section', `${field}: ${e?.words ?? 'that face'} is not flat (${r.ref.signature.type}); a section needs a plane or a flat face.`, { detail: { field } });
    return { kind: 'face', body: body.id, ref: r.ref };
  }
  throw new ToolError(
    'bad_section',
    `${field}: "${base}" is not a plane here${e ? ` (${e.words} is not a plane or a flat face)` : parse ? ` (${syntaxWords(parse, field)})` : ''}. Use ${SECTION_FORMS}.`,
    { detail: { field, ...(parse ? { selector: base, column: parse.detail.column } : {}) } },
  );
}
