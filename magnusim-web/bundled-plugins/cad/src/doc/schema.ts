// Document schema (v2, src/types/doc.ts): empty documents, the default view,
// reading stored documents (validation + migration from v1) and freezing snapshots.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import { DOC_SCHEMA, DOC_SCHEMAS_READ, type CadDoc, type CadView, type Feature, type Param, type SavedCamera, type ScaleModelPlace, type Vec3 } from '../types/doc';
import type { DocUnits, LengthUnit } from '../types/units';
import { newId } from '../lib/ids';

export const PLUGIN_VERSION = '0.2.0-dev';
export const DEFAULT_BODY_COLOR = '#bdc9db';
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** New documents: mm for a metric app, inches for imperial (proposal §4.11). */
export function defaultUnits(system: 'metric' | 'imperial'): DocUnits {
  return { length: system === 'imperial' ? 'in' : 'mm', angle: 'deg' };
}

export function emptyDoc(system: 'metric' | 'imperial', now: Date = new Date()): CadDoc {
  return {
    schema: DOC_SCHEMA,
    units: defaultUnits(system),
    params: [],
    bodies: {},
    features: [],
    meta: { created_at: now.toISOString(), written_by: PLUGIN_VERSION },
  };
}

export function emptyView(): CadView {
  return { rollback: null, hiddenBodies: [], expanded: ['origin'] };
}

/** Freeze a snapshot all the way down (undo keeps snapshots; nobody may change them). */
export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** A stored document could not be used; `message` says why in words. */
export class DocReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocReadError';
  }
}

const LENGTHS: LengthUnit[] = ['mm', 'cm', 'm', 'in', 'ft'];
const PARAM_QUANTITIES: Param['quantity'][] = ['length', 'angle', 'scalar'];

/** 'parameter "w"', or "parameter 2" when it has no name: one entry of the file, in messages. */
function nth(what: string, i: number, name: unknown): string {
  return typeof name === 'string' && name.trim() ? `${what} "${name.trim()}"` : `${what} ${i + 1}`;
}

/**
 * The document's parameters. Nothing is left out without a word (P1.5 review
 * round 1: a parameter with no id was dropped, and the Part then saved without
 * it): a missing id is given one (expressions use the name, never the id), and
 * an entry that cannot be read is a DocReadError naming it.
 */
function readParams(raw: unknown): Param[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new DocReadError('its parameters are not a list');
  return raw.map((p, i) => {
    if (!p || typeof p !== 'object') throw new DocReadError(`${nth('parameter', i, null)} is not a parameter`);
    const q = p as Partial<Param>;
    if (typeof q.name !== 'string' || !q.name.trim()) throw new DocReadError(`${nth('parameter', i, null)} has no name`);
    if (typeof q.expr !== 'string') throw new DocReadError(`${nth('parameter', i, q.name)} has no expression`);
    if (!PARAM_QUANTITIES.includes(q.quantity as Param['quantity'])) throw new DocReadError(`${nth('parameter', i, q.name)} does not say whether it is a length, an angle or a number`);
    return typeof q.id === 'string' && q.id ? (p as Param) : ({ ...q, id: newId('p') } as Param);
  });
}

/** The document's features, read as readParams reads parameters: a missing id is given one; anything else unreadable is said. */
function readFeatures(raw: unknown): Feature[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new DocReadError('its features are not a list');
  return raw.map((f, i) => {
    if (!f || typeof f !== 'object') throw new DocReadError(`${nth('feature', i, null)} is not a feature`);
    const g = f as Partial<Feature>;
    if (typeof g.name !== 'string' || !g.name.trim()) throw new DocReadError(`${nth('feature', i, null)} has no name`);
    if (typeof g.type !== 'string' || !g.type) throw new DocReadError(`${nth('feature', i, g.name)} has no type`);
    return typeof g.id === 'string' && g.id ? (f as Feature) : ({ ...g, id: newId('f') } as Feature);
  });
}

/**
 * A stored document as schema v1 (older schemas are migrated here as they
 * appear). Throws DocReadError when it is not a Part document, was written by
 * a newer version, or has a parameter or feature it cannot read: it is then
 * never overwritten (nothing in it is dropped without a word).
 */
export function readDoc(raw: unknown): CadDoc {
  if (!raw || typeof raw !== 'object') throw new DocReadError('the model file is not a Part document');
  const d = raw as Partial<CadDoc> & { schema?: unknown };
  if (typeof d.schema !== 'number') throw new DocReadError('the model file has no schema version');
  if (d.schema > DOC_SCHEMA) throw new DocReadError(`it was saved by a newer Magnusim CAD (schema ${d.schema}); this one reads schema ${DOC_SCHEMA}`);
  if (!DOC_SCHEMAS_READ.includes(d.schema)) throw new DocReadError(`schema ${d.schema} is not known`);
  // Migrations, oldest first. 1 -> 2 (P2/P3): no field changes; schema 2 only tells a
  // schema-1 reader to leave the file alone. Box and Cylinder rows (removed by decision
  // 2026-10-01) are read as they are: the rebuild marks each "Removed feature".
  const units = d.units && typeof d.units === 'object' ? d.units : ({} as Partial<DocUnits>);
  const doc: CadDoc = {
    schema: DOC_SCHEMA,
    units: {
      length: LENGTHS.includes(units.length as LengthUnit) ? (units.length as LengthUnit) : 'mm',
      angle: units.angle === 'rad' ? 'rad' : 'deg',
    },
    params: readParams(d.params),
    bodies: {},
    features: readFeatures(d.features),
    meta: {
      created_at: typeof d.meta?.created_at === 'string' ? d.meta.created_at : new Date().toISOString(),
      written_by: typeof d.meta?.written_by === 'string' ? d.meta.written_by : 'unknown',
    },
  };
  if (d.bodies && typeof d.bodies === 'object') {
    for (const [id, b] of Object.entries(d.bodies)) {
      // A body entry is a name, a colour and (LINK) whether it is left out of the
      // simulation: one that cannot be read gets the defaults (included).
      const def: { name?: unknown; color?: unknown; simulation?: unknown } = b && typeof b === 'object' ? b : {};
      doc.bodies[id] = {
        name: typeof def.name === 'string' && def.name ? def.name : 'Body',
        color: typeof def.color === 'string' && COLOR_RE.test(def.color) ? def.color : DEFAULT_BODY_COLOR,
      };
      if (def.simulation === false) doc.bodies[id].simulation = false;
    }
  }
  return doc;
}

/** A stored view, or the default one for anything unusable. */
export function readView(raw: unknown, featureCount: number): CadView {
  const v = raw && typeof raw === 'object' ? (raw as Partial<CadView>) : {};
  const view = emptyView();
  if (typeof v.rollback === 'number' && Number.isInteger(v.rollback) && v.rollback >= 0 && v.rollback < featureCount) view.rollback = v.rollback;
  if (Array.isArray(v.hiddenBodies)) view.hiddenBodies = v.hiddenBodies.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(v.expanded)) view.expanded = v.expanded.filter((x): x is string => typeof x === 'string');
  if (v.planes === 'always') view.planes = 'always';
  const camera = readCamera(v.camera);
  if (camera) view.camera = camera;
  if (v.sketches && typeof v.sketches === 'object') {
    const sketches: NonNullable<CadView['sketches']> = {};
    for (const [id, mode] of Object.entries(v.sketches)) if (mode === 'shown' || mode === 'hidden') sketches[id] = mode;
    if (Object.keys(sketches).length) view.sketches = sketches;
  }
  // ux010 (TOOLBAR builder): the banana for scale, when shown (optional; older views have none),
  // and the taped banana per sketch.
  const sm = v.scaleModels && typeof v.scaleModels === 'object' ? (v.scaleModels as { banana?: unknown; sketch?: unknown }) : {};
  const banana = readScaleModelPlace(sm.banana);
  const sketch: Record<string, { at: [number, number] }> = {};
  if (sm.sketch && typeof sm.sketch === 'object') {
    for (const [id, e] of Object.entries(sm.sketch as Record<string, unknown>)) {
      const at = (e as { at?: unknown } | null)?.at;
      if (Array.isArray(at) && at.length === 2 && at.every((n) => typeof n === 'number' && Number.isFinite(n))) sketch[id] = { at: [at[0], at[1]] };
    }
  }
  if (banana || Object.keys(sketch).length) view.scaleModels = { ...(banana ? { banana } : {}), ...(Object.keys(sketch).length ? { sketch } : {}) };
  return view;
}

/** ux010: a stored scale model's place, or null when it is missing or unusable (then it is not shown). */
export function readScaleModelPlace(raw: unknown): ScaleModelPlace | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { at?: unknown; rot?: unknown };
  const at = vec3(r.at);
  if (!at) return null;
  const rot = typeof r.rot === 'number' && Number.isFinite(r.rot) ? ((r.rot % 360) + 360) % 360 : 0;
  return { at, rot };
}

const vec3 = (x: unknown): Vec3 | null => (Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [x[0], x[1], x[2]] : null);

/** A stored camera, or null when it is missing or unusable (then the viewport frames the part as usual). */
export function readCamera(raw: unknown): SavedCamera | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<SavedCamera>;
  const position = vec3(c.position);
  const target = vec3(c.target);
  const up = vec3(c.up);
  if (!position || !target || !up) return null;
  const dist = Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]);
  if (!(dist > 0) || !(Math.hypot(...up) > 0)) return null;
  const orthoHeight = typeof c.orthoHeight === 'number' && Number.isFinite(c.orthoHeight) && c.orthoHeight > 0 ? c.orthoHeight : dist;
  return { position, target, up, orthoHeight, projection: c.projection === 'orthographic' ? 'orthographic' : 'perspective' };
}
