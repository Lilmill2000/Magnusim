/**
 * What every read and edit tool shares (Core host tools spec 2): the tool definition's
 * extra fields, which project and study a call means, the outcome shapes and error codes,
 * the `values: [{key, value}]` forms checked against a registry or plugin schema, the
 * face checks, and the ui_sync a write emits.
 *
 * HostToolDef is a ToolDef whose `contexts` are always given (spec 15); the runner reads its
 * `escalate`, `gateText` and `projectOf` (C3, C5).
 */
import type { GateDetail } from '../gates.ts';
import type { ChatHistory } from '../history.ts';
import { HostCallError, type HostCall, type HostCallOptions } from '../host-call.ts';
import { HOST_STALL_MS, type Assessed, type AssessContext, type Place, type ToolCtx, type ToolDef, type ToolOutcome, type ToolRunContext, type TurnUse } from '../registry.ts';
import { cleanText, TEXT_CAPS } from '../sanitize.ts';
import type { JsonSchemaObject } from '../types.ts';
import { uiSyncOrigin, type UiSyncEmitter, type UiSyncInput, type UiSyncKind } from '../../ui-sync.ts';
import { siUnitLabel } from '../../../../src/plugin-ui/units.ts';

export type { Assessed, AssessContext, Place };

/** A host tool with the fields the core host tools spec gives it (2.1). */
export interface HostToolDef extends ToolDef {
  contexts: readonly Place[];
  escalate?(input: Record<string, unknown>, rt: AssessContext): Promise<Assessed | null>;
  gateText?(input: Record<string, unknown>, a: Assessed | null): { title: string; copy: string; detail?: GateDetail[] };
  projectOf?(input: Record<string, unknown>, ctx: ToolCtx): string | null;
}

/** Where the turn's window is (ToolCtx.place; a caller that predates places: from its tab and project). */
export const placeOf = (ctx: ToolCtx): Place =>
  ctx.place === 'home' || ctx.place === 'workbench' || ctx.place === 'workspace' ? ctx.place : ctx.tab ? 'workspace' : ctx.projectId ? 'workbench' : 'home';
/** This turn's own message (the typed-path rule); null for MCP and agents. */
export const promptOf = (ctx: ToolCtx): string | null => (typeof ctx.prompt === 'string' ? ctx.prompt : null);
/** The turn's conversation (attachments are bound to it). */
export const conversationOf = (ctx: ToolCtx): string | null => (typeof ctx.conversation === 'string' ? ctx.conversation : null);
/** The turn's spend and steps so far (app_status), when the turn lends them. */
export const usedOf = (ctx: ToolCtx): TurnUse | null => {
  try {
    return typeof ctx.used === 'function' ? ctx.used() : null;
  } catch {
    return null;
  }
};

/**
 * Whether the runner asks for another project's consent before a call reads it (the runner's
 * `privacyFor`, core host tools spec 9.2, 9.3): the loop, agent turns and MCP each ask about the
 * project a tool's projectOf names (the project list: LIST_CONSENT_KEY) before the call runs, so
 * a tool that reaches here was allowed. With it off, a cloud turn could read only its own project.
 */
export const PER_CALL_PRIVACY = true;

// ---------------------------------------------------------------- ui_sync (scripts/server/ui-sync.ts)

export type SyncKind = UiSyncKind;

// ---------------------------------------------------------------- attachments (lane F)

export interface OpenedAttachment {
  name: string;
  bytes: number;
  stream: NodeJS.ReadableStream;
}
export interface Attachments {
  /** The stored file of `id` when it is bound to conversation `conv` (or unbound), else null. */
  open(id: string, conv: string | null): Promise<OpenedAttachment | null>;
}

export interface HostToolDeps {
  /** The routes call (C1: an entry id of HOST_ROUTES). */
  hostCall: HostCall;
  /** The default provider and model as Settings has them. */
  assistant(): Promise<{ provider: string; model: string }>;
  version(): Promise<string>;
  plugins(): Array<Record<string, unknown>>;
  /** The Assistant's own settings, read only: effort, privacy mode, caps. */
  assistantSettings?(): Promise<{ effort: string; privacy: string; caps: Record<string, number>; provider_log?: boolean }>;
  /** Today's spend (the ledger). */
  spentToday?(): Promise<number>;
  /** The ui_sync emitter (scripts/server/ui-sync.ts uiSync). */
  uiSync?: Pick<UiSyncEmitter, 'emit'>;
  attachments?: Attachments;
  /** A typed path's file, if it is one (import_file). */
  statFile?(path: string): Promise<{ size: number; file: boolean } | null>;
  /** The export jobs a turn started (lane D), for read_results {kind:'exports'}. */
  knownExports?(turn: string | null): string[];
  /** The saved chats chat_history reads (tests: their own; else the Assistant home's, history.ts). */
  history?: () => ChatHistory;
}

// ---------------------------------------------------------------- small helpers

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
export const text = (v: unknown, max: number = TEXT_CAPS.name): string | null => (typeof v === 'string' ? cleanText(v, max) : typeof v === 'number' ? String(v) : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const bool = (v: unknown): boolean => v === true;
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const records = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
/** A record's rev (C2), or null before revs exist. */
export const revOf = (r: Record<string, unknown> | null | undefined): number | null => (r && typeof r.rev === 'number' && Number.isFinite(r.rev) ? r.rev : null);
export const quoted = (s: unknown): string => `"${cleanText(typeof s === 'string' && s ? s : 'untitled', 80)}"`;

export function hostTool(def: Omit<HostToolDef, 'source' | 'localName' | 'stallMs' | 'workerBacked'> & { workerBacked?: boolean; stallMs?: number }): HostToolDef {
  return { ...def, localName: def.name, source: { kind: 'host' }, stallMs: def.stallMs ?? HOST_STALL_MS, workerBacked: def.workerBacked ?? false };
}

/** `available` for a tool offered in `contexts`, with its own further check. */
export function offeredIn(contexts: readonly Place[], more?: (ctx: ToolCtx) => true | string): (ctx: ToolCtx) => true | string {
  return (ctx) => {
    const place = placeOf(ctx);
    if (!contexts.includes(place)) return `Not offered ${place === 'home' ? 'on Home' : place === 'workspace' ? 'in a workspace' : 'in the workbench'}.`;
    return more ? more(ctx) : true;
  };
}

// ---------------------------------------------------------------- outcomes

export interface Done {
  done: string;
  ids?: Record<string, string>;
  rev?: number | null;
  revs?: Record<string, number>;
  hint?: string;
  detail?: unknown;
}
export function okDone(d: Done, summary?: string): ToolOutcome {
  const data: Record<string, unknown> = { done: d.done, ids: d.ids ?? {}, hint: d.hint ?? '' };
  if (d.rev !== undefined && d.rev !== null) data.rev = d.rev;
  if (d.revs && Object.keys(d.revs).length) data.revs = d.revs;
  if (d.detail !== undefined) data.detail = d.detail;
  return { ok: true, data, summary: cleanText(summary ?? d.done, 160) };
}
export function okData(data: unknown, summary: string): ToolOutcome {
  return { ok: true, data, summary: cleanText(summary, 160) };
}
export function fail(code: string, message: string, hint?: string, detail?: unknown): ToolOutcome {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}), ...(detail !== undefined ? { detail } : {}) }, summary: cleanText(message, 160) };
}

/** A thrown failure carried to the tool's answer. */
export class ToolFail extends Error {
  outcome: ToolOutcome;
  constructor(outcome: ToolOutcome) {
    super(outcome.error?.message ?? 'failed');
    this.outcome = outcome;
  }
}
export const refuse = (code: string, message: string, hint?: string, detail?: unknown): never => {
  throw new ToolFail(fail(code, message, hint, detail));
};

/** A failed app call as the tool's answer: the spec's codes (2.6), the app's text for a refusal. */
export function failed(err: unknown, notFoundHint?: string): ToolOutcome {
  if (err instanceof ToolFail) return err.outcome;
  if (err instanceof HostCallError) {
    const appCode = err.appCode;
    if (err.code === 'stale_record' || appCode === 'stale_record') {
      return fail('stale_record', 'This was changed elsewhere since it was read.', 'Read it again with read_setup; the person or another window changed it.', err.detail ?? undefined);
    }
    if (err.code === 'geometry_changed') return fail('geometry_changed', err.message, "Read the faces again with read_setup {what:'faces'}.");
    if (err.code === 'geometry_updating') return fail('geometry_updating', err.message, 'The geometry is updating; wait, then try again.');
    if (err.code === 'http') {
      if (err.status === 404) return fail('not_found', err.message, notFoundHint);
      if (appCode === 'busy') return fail('busy', err.message);
      if (err.status !== null && err.status >= 500) return fail('app_error', err.message);
      return fail('refused', err.message);
    }
    return fail(err.code, err.message);
  }
  return fail('failed', 'The app could not be reached.');
}

/** How long a tool's own steps wait for the turn's call rate, at most, before failing rate_limited. */
const PACE_MAX_MS = 15_000;

/**
 * The routes call with its rate (host-call.ts: 5 calls and 2 writes a second per turn) waited
 * out: a tool whose steps are several writes (a study, its name, its Run 1) or many probes waits
 * for its slot instead of failing half done. A Stop ends the wait.
 */
export function paced(call: HostCall, sleep: (ms: number, signal?: AbortSignal) => Promise<void> = realSleep): HostCall {
  return async (id, args, o) => {
    let waited = 0;
    for (;;) {
      try {
        return await call(id, args, o);
      } catch (err) {
        if (!(err instanceof HostCallError) || err.code !== 'rate_limited' || waited >= PACE_MAX_MS) throw err;
        await sleep(200, o.signal);
        waited += 200;
      }
    }
  };
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HostCallError('aborted', 'Stopped.'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new HostCallError('aborted', 'Stopped.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------- which project and study

export const NO_PROJECT = 'No project in this call: pass project_id from projects, or open one with core__show.';

/** The project a call means (2.3): its project_id, else the turn's. */
export function projectIdOf(input: Record<string, unknown>, ctx: ToolCtx): string | null {
  const given = str(input.project_id).trim();
  return given || ctx.projectId || null;
}

/**
 * Whether a cloud turn may send data the turn's own consent does not cover (another
 * project, the project list) before the runner asks for it per call: only when the person
 * chose Always allow. A local model is never asked.
 */
export async function mayReadBeyondTurn(ctx: ToolCtx, deps: HostToolDeps): Promise<boolean> {
  if (!ctx.cloud || PER_CALL_PRIVACY) return true;
  try {
    return (await deps.assistantSettings?.())?.privacy === 'allow';
  } catch {
    return false;
  }
}

/** The project to read, or a refusal: none at all, or another project a cloud turn may not send unasked. */
export async function readableProject(input: Record<string, unknown>, ctx: ToolCtx, deps: HostToolDeps): Promise<string> {
  const p = projectIdOf(input, ctx);
  if (!p) return refuse('no_project', NO_PROJECT, 'Pass project_id from projects, or open one with core__show.');
  if (p !== ctx.projectId && !(await mayReadBeyondTurn(ctx, deps))) {
    return refuse('privacy_declined', 'Reading a project other than the one open in this window needs the person to allow it first.', "Open it first: core__show {target:'project', project_id}.");
  }
  return p;
}

/** The project a write goes to: only the tab's (2.4). */
export async function writableProject(input: Record<string, unknown>, ctx: ToolCtx, call: HostCall, rt: ToolRunContext): Promise<string> {
  const given = str(input.project_id).trim();
  if (!ctx.projectId) return refuse('no_project', 'No project is open in this window.', "Open one first: core__show {target:'project', project_id}.");
  if (given && given !== ctx.projectId) {
    let title = '';
    try {
      const list = (await call('projects.list', {}, { signal: rt.signal, turn: rt.turn, tool: 'projects' })) as Record<string, unknown>;
      title = str(records(list.projects).find((p) => p.id === ctx.projectId)?.title);
    } catch {
      title = '';
    }
    return refuse(
      'not_this_project',
      `Changes go only to the project open in this window${title ? ` (${quoted(title)})` : ''}.`,
      `Open it first: core__show {target:'project', project_id:'${cleanText(given, 80)}'}, then call this again.`,
    );
  }
  return ctx.projectId;
}

export interface Studies {
  list: Record<string, unknown>[];
  activeId: string | null;
}
/** The project's studies and its active one (GET /api/simulation without a study: active_id is the real one). */
export async function studiesOf(call: HostCall, project: string, rt: { signal: AbortSignal; turn: string | null }, tool: string): Promise<Studies> {
  const sims = (await call('simulation.get', { project_id: project }, { signal: rt.signal, turn: rt.turn, tool })) as Record<string, unknown>;
  return { list: records(sims.simulations), activeId: str(sims.active_id) || null };
}

/** The study a call means (2.3): its simulation_id, else the tab's, else the project's active one. */
export async function studyIdOf(input: Record<string, unknown>, ctx: ToolCtx, project: string, call: HostCall, rt: ToolRunContext, tool: string): Promise<{ id: string; studies: Studies }> {
  const studies = await studiesOf(call, project, rt, tool);
  const given = str(input.simulation_id).trim();
  const id = given || (project === ctx.projectId ? ctx.simulationId : null) || studies.activeId || '';
  if (!id) return refuse('not_found', 'This project has no study yet.', "Create one with study_edit {action:'create'}.");
  if (!studies.list.some((s) => s.id === id)) return refuse('not_found', `No study ${quoted(id)} in this project.`, 'project_summary lists the studies.');
  return { id, studies };
}

// ---------------------------------------------------------------- values (2.2)

export const VALUES_MAX_PROBLEMS = 12;

export interface Field {
  key: string;
  type: string;
  label: string;
  unit: string;
  enum: unknown[] | null;
  min: number | null;
  max: number | null;
  items: string | null;
  min_items: number | null;
  max_items: number | null;
  description: string;
}

/** A JSON schema's fields, nested object properties as dotted keys (`advanced.mesh_engine`). */
export function flattenSchema(schema: unknown, prefix = '', depth = 0): Field[] {
  const props = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const out: Field[] = [];
  for (const [k, raw] of Object.entries(props)) {
    if (!isRecord(raw)) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (raw.type === 'object' && isRecord(raw.properties) && depth < 4) {
      out.push(...flattenSchema(raw, key, depth + 1));
      continue;
    }
    const x = isRecord(raw['x-cfddesk']) ? raw['x-cfddesk'] : {};
    const items = isRecord(raw.items) ? raw.items : {};
    out.push({
      key,
      type: typeof raw.type === 'string' ? raw.type : 'string',
      label: cleanText(raw.title ?? k, 120),
      // A field with a quantity and no unit of its own holds that quantity's SI unit (what the
      // editor converts from: a temperature in K, shown in °C or °F). Seen live: a Heat Transfer
      // wall temperature had no unit, and the model had to guess K from a default of 293.15.
      unit: cleanText(x.unit ?? (typeof x.quantity === 'string' ? siUnitLabel(x.quantity) : ''), 40),
      enum: Array.isArray(raw.enum) ? raw.enum.slice(0, 64) : null,
      min: num(raw.minimum),
      max: num(raw.maximum),
      items: typeof items.type === 'string' ? items.type : null,
      min_items: num(raw.minItems),
      max_items: num(raw.maxItems),
      description: cleanText(raw.description ?? '', 160),
    });
  }
  return out;
}

/** A field as the model reads it (catalog, read_setup): only what is set. */
export function fieldInfo(f: Field): Record<string, unknown> {
  return {
    key: f.key,
    type: f.type,
    label: f.label,
    ...(f.unit ? { unit: f.unit } : {}),
    ...(f.enum ? { enum: f.enum } : {}),
    ...(f.min !== null ? { min: f.min } : {}),
    ...(f.max !== null ? { max: f.max } : {}),
    ...(f.items ? { items: f.items } : {}),
    ...(f.min_items !== null ? { min_items: f.min_items } : {}),
    ...(f.max_items !== null ? { max_items: f.max_items } : {}),
    ...(f.description ? { description: f.description } : {}),
  };
}

/** What is wrong with `v` for `f`, or null. */
export function valueProblem(f: Field, v: unknown): string | null {
  if (v === null) return null;
  const range = (n: number) =>
    f.min !== null && n < f.min ? `at least ${f.min}` : f.max !== null && n > f.max ? `at most ${f.max}` : null;
  if (f.enum && !f.enum.some((e) => e === v)) return `one of ${f.enum.map((e) => JSON.stringify(e)).join(', ')}`;
  switch (f.type) {
    case 'number':
    case 'integer': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'a number';
      if (f.type === 'integer' && !Number.isInteger(v)) return 'a whole number';
      const r = range(v);
      return r ? `a number ${r}` : null;
    }
    case 'boolean':
      return typeof v === 'boolean' ? null : 'true or false';
    case 'string':
      return typeof v === 'string' ? null : 'text';
    case 'array': {
      if (!Array.isArray(v)) return 'a list';
      if (f.min_items !== null && v.length < f.min_items) return `a list of at least ${f.min_items}`;
      if (f.max_items !== null && v.length > f.max_items) return `a list of at most ${f.max_items}`;
      if ((f.items === 'number' || f.items === 'integer') && !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return 'a list of numbers';
      return null;
    }
    default:
      return null;
  }
}

export interface Problem {
  key: string;
  problem: string;
}

/**
 * The `values` pairs as {key: parsed value}, each checked against `fields` (by key): every
 * problem at once, at most VALUES_MAX_PROBLEMS. `extra` keys (a tool's own, outside the
 * schema) pass when their own check says so.
 */
export function parseValues(
  values: unknown,
  fields: readonly Field[],
  extra: Record<string, (v: unknown) => string | null> = {},
): { ok: true; values: Record<string, unknown> } | { ok: false; problems: Problem[] } {
  const byKey = new Map(fields.map((f) => [f.key, f] as const));
  const out: Record<string, unknown> = {};
  const problems: Problem[] = [];
  for (const pair of Array.isArray(values) ? values : []) {
    if (!isRecord(pair)) continue;
    const key = str(pair.key).trim();
    let v: unknown;
    try {
      v = JSON.parse(str(pair.value));
    } catch {
      problems.push({ key, problem: 'the value is not JSON text (a string is written "\\"text\\"")' });
      continue;
    }
    if (Object.hasOwn(out, key)) {
      problems.push({ key, problem: 'given twice' });
      continue;
    }
    const own = Object.hasOwn(extra, key) ? extra[key] : null;
    const f = byKey.get(key);
    if (!f && !own) {
      problems.push({ key, problem: 'not a field here' });
      continue;
    }
    const why = own ? own(v) : valueProblem(f as Field, v);
    if (why) {
      problems.push({ key, problem: own ? why : `must be ${why}` });
      continue;
    }
    out[key] = v;
  }
  if (problems.length) return { ok: false, problems: problems.slice(0, VALUES_MAX_PROBLEMS) };
  return { ok: true, values: out };
}

/** The bad_values refusal for `problems` (the H9 message shape). */
export function badValues(problems: Problem[], hint: string): never {
  const n = problems.length;
  const lines = problems.map((p) => `${p.key || '(no key)'}: ${p.problem}`).join('; ');
  return refuse('bad_values', `${n} value${n === 1 ? ' is' : 's are'} not right: ${lines}.`, hint, problems);
}

/** Dotted keys made nested: {"advanced.mesh_engine": "x"} → {advanced: {mesh_engine: "x"}}. */
export function nest(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(values)) {
    const parts = key.split('.');
    let at = out;
    for (const p of parts.slice(0, -1)) {
      if (!isRecord(at[p])) at[p] = {};
      at = at[p] as Record<string, unknown>;
    }
    at[parts[parts.length - 1]] = v;
  }
  return out;
}

/** A nested object's leaves as dotted keys (the inverse of nest), for reads. */
export function dotted(v: Record<string, unknown>, prefix = '', depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isRecord(x) && depth < 4) Object.assign(out, dotted(x, key, depth + 1));
    else out[key] = x;
  }
  return out;
}

// ---------------------------------------------------------------- faces

const FACE_LABEL = /^\s*face\s*(\d+)\s*(?:@\s*Body\s*(\d+))?\s*$/i;

/** "face 12@Body1" for a label the model wrote ("face 12", "Face 12@body1"), or null. */
export function normalFace(raw: unknown): string | null {
  const m = FACE_LABEL.exec(str(raw));
  return m ? `face ${Number(m[1])}@Body${Number(m[2] || 1)}` : null;
}

/** A face table row's label, as the page names faces (runtime.js faceLabel). */
export const rowLabel = (row: Record<string, unknown>): string => `face ${Number(row.id)}@Body${Number(row.body) || 1}`;

/**
 * Face ids checked against the geometry's face table (2.6, 4.10): every one exists, and none
 * is shared by two bodies (inside the part; the page refuses those when picked). Returns the
 * normalized labels, or refuses with every face that failed.
 */
export function checkFaces(faces: readonly unknown[], table: Record<string, unknown>[]): string[] {
  const rows = new Map(table.map((r) => [rowLabel(r), r] as const));
  const unknown: string[] = [];
  const inside: Array<{ face: string; shared_with: string }> = [];
  const out: string[] = [];
  for (const raw of faces) {
    const label = normalFace(raw);
    const row = label ? rows.get(label) : undefined;
    if (!label || !row) {
      unknown.push(cleanText(str(raw), 40));
      continue;
    }
    const other = row.shared_with ? table[Number(row.shared_with) - 1] : null;
    if (other) {
      inside.push({ face: label, shared_with: rowLabel(other) });
      continue;
    }
    if (!out.includes(label)) out.push(label);
  }
  if (unknown.length) {
    refuse('not_found', `${unknown.length === 1 ? 'This face is' : 'These faces are'} not on the study's geometry: ${unknown.slice(0, 12).join(', ')}.`, "read_setup {what:'faces'} lists them.", {
      faces: unknown.slice(0, 50),
    });
  }
  if (inside.length) {
    refuse(
      'inside_face',
      `A face two bodies share is inside the model, so it takes no boundary condition or refinement: ${inside.slice(0, 12).map((f) => f.face).join(', ')}.`,
      'A face two bodies share is inside the model; pick an outside face.',
      inside.slice(0, 50),
    );
  }
  return out;
}

// ---------------------------------------------------------------- schemas

/** A strict-friendly object schema: every property required, no extra properties. */
export function objectSchema(properties: Record<string, unknown>): JsonSchemaObject {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } as unknown as JsonSchemaObject;
}
export const S = {
  id: (description: string, maxLength = 80) => ({ type: 'string', maxLength, description }),
  text: (maxLength: number, description?: string) => ({ type: 'string', maxLength, ...(description ? { description } : {}) }),
  enum: (values: readonly string[], description?: string) => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) }),
  values: (maxItems: number, valueMax: number, description: string) => ({
    type: 'array',
    maxItems,
    description,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'value'],
      properties: { key: { type: 'string', maxLength: 120 }, value: { type: 'string', maxLength: valueMax } },
    },
  }),
};

// ---------------------------------------------------------------- sync

/** Emits a write's ui_sync (2.8); a sync that fails never fails the write. */
export function emitSync(deps: HostToolDeps, rt: ToolRunContext, e: Omit<UiSyncInput, 'by' | 'turn'>): void {
  try {
    deps.uiSync?.emit({ ...e, ...uiSyncOrigin(rt) });
  } catch {
    /* the page reloads on its next switch */
  }
}

/** The call options for one tool step. */
export const via = (rt: { signal: AbortSignal; turn: string | null }, tool: string): HostCallOptions => ({ signal: rt.signal, turn: rt.turn, tool });

/** A linked geometry's rev, which face-carrying writes send (3.4); null for a plain import. */
export function geometryRevOf(project: Record<string, unknown>, geometryId: string | null): number | null {
  const g = records(project.geometries).find((x) => x.id === geometryId) ?? (isRecord(project.geometry) && project.geometry.id === geometryId ? project.geometry : null);
  const link = g && isRecord(g.link) ? g.link : null;
  return link && typeof link.rev === 'number' ? link.rev : null;
}
