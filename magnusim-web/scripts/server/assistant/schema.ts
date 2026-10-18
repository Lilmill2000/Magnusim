/**
 * The tool schemas the Assistant accepts, checks and sends (Foundation spec 7.2).
 *
 * Pages (workspace tools) and host tools describe their input in one small strict subset
 * of JSON Schema; nothing else is accepted, no schema is compiled into code, and every
 * constraint is checked here before a tool runs:
 *
 *   type (object, string, number, integer, boolean, array), properties, required,
 *   additionalProperties: false (on every object), items, enum (≤ 64), const,
 *   minimum/maximum, minLength/maxLength, minItems/maxItems, description, title.
 *
 * Refused, with the reason: $ref, oneOf/anyOf/allOf, pattern, format, patternProperties,
 * default, type arrays and any other keyword. Depth ≤ 6, ≤ 64 properties per object,
 * ≤ 16 KB in all.
 *
 * Each provider is sent a copy (emitSchema). The two strict dialects keep only the
 * keywords both cloud providers accept in strict tools (STRICT_KEEP) and move every
 * other limit into the property's description as plain words ("integer from -100 to
 * 100"); the model then sees the limits only as words, and validateInput() still
 * enforces them. The second cloud dialect also wants every property listed in
 * `required`, so its optional properties become nullable, and stripNullOptionals()
 * removes the nulls again before validation. The local-server dialect gets the schema
 * as validated, not strict (local grammars may use the limits).
 *
 * validateInput() reports every problem with an input at once (up to INPUT_MAX_PROBLEMS,
 * in at most INPUT_ERROR_MAX characters), so a model fixes them in one round. For a local
 * model's call of a workspace tool, the runner first gives fillLocalDefaults() the input:
 * required fields left out or sent as null get "", [] or false when their type has such
 * an empty value; nothing else is guessed.
 */
import type { JsonSchemaObject, ProviderId } from './types.ts';

export const SCHEMA_MAX_DEPTH = 6;
export const SCHEMA_MAX_PROPERTIES = 64;
export const SCHEMA_MAX_ENUM = 64;
export const SCHEMA_MAX_BYTES = 16 * 1024;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type SchemaNode = Record<string, unknown>;

const TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);
const COMMON = ['type', 'description', 'title', 'enum', 'const'];
const BY_TYPE: Record<string, string[]> = {
  object: [...COMMON, 'properties', 'required', 'additionalProperties'],
  string: [...COMMON, 'minLength', 'maxLength'],
  number: [...COMMON, 'minimum', 'maximum'],
  integer: [...COMMON, 'minimum', 'maximum'],
  boolean: [...COMMON],
  array: [...COMMON, 'items', 'minItems', 'maxItems'],
};
const REFUSED_REASON: Record<string, string> = {
  $ref: 'references are not supported; write the schema out',
  $defs: 'definitions are not supported; write the schema out',
  definitions: 'definitions are not supported; write the schema out',
  oneOf: 'alternatives (oneOf) are not supported',
  anyOf: 'alternatives (anyOf) are not supported',
  allOf: 'combined schemas (allOf) are not supported',
  not: '"not" is not supported',
  pattern: 'patterns are not supported; describe the format in the description and check it in the tool',
  format: 'formats are not supported; describe the format in the description and check it in the tool',
  patternProperties: 'patternProperties is not supported',
  default: 'defaults are not supported; say the default in the description',
};

/**
 * The keywords each strict dialect is sent; every other limit goes into the description.
 * Both lists are the same on purpose: the intersection of what both providers accept in
 * a strict tool, so neither is sent a keyword it might refuse.
 */
export const STRICT_KEEP: Readonly<Record<'anthropic' | 'openai', readonly string[]>> = Object.freeze({
  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
  // (read 2026-10-16): strict tools refuse minimum/maximum/multipleOf, minLength/maxLength and
  // array limits beyond minItems 0 or 1; additionalProperties must be false on objects.
  anthropic: Object.freeze(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description']),
  // https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas
  // (read 2026-10-16): additionalProperties false on every object, every field in required,
  // optional fields as a union with null; no string length keywords are listed.
  openai: Object.freeze(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description']),
});

export type SchemaCheck = { ok: true } | { ok: false; error: string; path: string };

function isRecord(v: unknown): v is SchemaNode {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isFiniteNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

function matchesType(type: string, v: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return isRecord(v);
    default:
      return false;
  }
}

/**
 * Whether `schema` is in the subset, with the first reason it is not. A tool's input
 * schema must be an object schema.
 */
export function checkSchema(schema: unknown): SchemaCheck {
  let text: string;
  try {
    text = JSON.stringify(schema);
  } catch {
    return { ok: false, error: 'The schema is not plain JSON.', path: '' };
  }
  if (typeof text !== 'string') return { ok: false, error: 'The schema is missing.', path: '' };
  if (Buffer.byteLength(text, 'utf8') > SCHEMA_MAX_BYTES) {
    return { ok: false, error: `The schema is larger than ${SCHEMA_MAX_BYTES / 1024} KB.`, path: '' };
  }
  if (!isRecord(schema) || schema.type !== 'object') return { ok: false, error: 'A tool input schema must be an object schema.', path: '' };
  return checkNode(schema, '', 1);
}

function checkNode(node: unknown, path: string, depth: number): SchemaCheck {
  const bad = (error: string, p = path): SchemaCheck => ({ ok: false, error: `${p || '(root)'}: ${error}`, path: p });
  if (!isRecord(node)) return bad('each schema must be an object.');
  if (depth > SCHEMA_MAX_DEPTH) return bad(`schemas nest at most ${SCHEMA_MAX_DEPTH} deep.`);
  const type = node.type;
  if (Array.isArray(type)) return bad('a list of types is not supported; use one type.');
  if (typeof type !== 'string' || !TYPES.has(type)) return bad('"type" must be object, string, number, integer, boolean or array.');
  const allowed = new Set(BY_TYPE[type]);
  for (const key of Object.keys(node)) {
    if (allowed.has(key)) continue;
    const reason = REFUSED_REASON[key];
    if (reason) return bad(`"${key.slice(0, 40)}": ${reason}.`);
    return bad(`"${key.slice(0, 40)}" is not supported for type ${type}.`);
  }
  if (hasOwn(node, 'description') && typeof node.description !== 'string') return bad('"description" must be text.');
  if (hasOwn(node, 'title') && typeof node.title !== 'string') return bad('"title" must be text.');
  if (hasOwn(node, 'enum')) {
    const e = node.enum;
    if (!Array.isArray(e) || e.length === 0) return bad('"enum" must be a non-empty list.');
    if (e.length > SCHEMA_MAX_ENUM) return bad(`"enum" holds at most ${SCHEMA_MAX_ENUM} values.`);
    for (const v of e) {
      if (!isPrimitive(v) || !matchesType(type, v)) return bad(`every "enum" value must be a ${type}.`);
    }
    if (new Set(e.map((v) => JSON.stringify(v))).size !== e.length) return bad('"enum" values must differ.');
  }
  if (hasOwn(node, 'const')) {
    if (!isPrimitive(node.const) || !matchesType(type, node.const)) return bad(`"const" must be a ${type}.`);
  }
  for (const [lo, hi, check, what] of [
    ['minimum', 'maximum', isFiniteNumber, 'numbers'],
    ['minLength', 'maxLength', isCount, 'whole numbers from 0'],
    ['minItems', 'maxItems', isCount, 'whole numbers from 0'],
  ] as const) {
    for (const k of [lo, hi]) if (hasOwn(node, k) && !check(node[k])) return bad(`"${k}" must be ${what}.`);
    if (hasOwn(node, lo) && hasOwn(node, hi) && (node[lo] as number) > (node[hi] as number)) return bad(`"${lo}" is above "${hi}".`);
  }
  if (type === 'object') {
    if (node.additionalProperties !== false) return bad('every object needs "additionalProperties": false.');
    const props = node.properties ?? {};
    if (!isRecord(props)) return bad('"properties" must be an object.');
    const names = Object.keys(props);
    if (names.length > SCHEMA_MAX_PROPERTIES) return bad(`an object has at most ${SCHEMA_MAX_PROPERTIES} properties.`);
    if (hasOwn(node, 'required')) {
      const req = node.required;
      if (!Array.isArray(req) || !req.every((r) => typeof r === 'string')) return bad('"required" must be a list of property names.');
      if (new Set(req).size !== req.length) return bad('"required" names a property twice.');
      for (const r of req as string[]) if (!hasOwn(props, r)) return bad(`"required" names "${r.slice(0, 40)}", which is not a property.`);
    }
    for (const name of names) {
      if (!name || name.length > 64) return bad('property names are 1 to 64 characters.');
      if (name === '__proto__') return bad('a property may not be called "__proto__".');
      const r = checkNode(props[name], path ? `${path}.${name}` : name, depth + 1);
      if (!r.ok) return r;
    }
  }
  if (type === 'array') {
    if (!hasOwn(node, 'items')) return bad('an array needs "items".');
    const r = checkNode(node.items, `${path}[]`, depth + 1);
    if (!r.ok) return r;
  }
  return { ok: true };
}

// ---------------------------------------------------------------- validation

/** The most problems one input's error names; the others are counted ("and N more problems"). */
export const INPUT_MAX_PROBLEMS = 12;
/** The most characters (UTF-16 units) an input's error takes: the model's cap for a message (TEXT_CAPS.other). */
export const INPUT_ERROR_MAX = 2000;
/** Room kept at the end of a cut error for "; and N more problems.". */
const ERROR_TAIL = 40;

/** `problems`: how many there are in all (the error names up to INPUT_MAX_PROBLEMS); `path` is the first one's. */
export type InputCheck = { ok: true } | { ok: false; error: string; path: string; problems: number };

interface Found {
  /** The first INPUT_MAX_PROBLEMS, in the order found: depth first, in the schema's order. */
  list: { path: string; text: string }[];
  total: number;
}

const chars = (s: string) => [...s].length;
const show = (v: unknown) => {
  const t = JSON.stringify(v);
  return t && t.length > 40 ? `${t.slice(0, 37)}...` : String(t);
};
/** A schema's property name as an error shows it: bare when it is a plain word, else quoted. */
const fieldName = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name));
const typeWords = (type: string) => (type === 'integer' ? 'a whole number' : type === 'array' ? 'a list' : type === 'object' ? 'an object' : `a ${type}`);

type Empty = '""' | '[]' | 'false';
const EMPTY_ORDER: readonly Empty[] = ['""', '[]', 'false'];

/**
 * The value meaning "unused" for a field of schema `s`, as JSON: "" for a string, [] for a
 * list, false for a boolean; null for anything else (numbers, objects, enums, consts) and
 * when the schema refuses that empty value (a minLength or minItems above 0).
 */
function emptyOf(s: unknown): Empty | null {
  if (!isRecord(s) || hasOwn(s, 'enum') || hasOwn(s, 'const')) return null;
  if (s.type === 'string') return isCount(s.minLength) && (s.minLength as number) > 0 ? null : '""';
  if (s.type === 'array') return isCount(s.minItems) && (s.minItems as number) > 0 ? null : '[]';
  if (s.type === 'boolean') return 'false';
  return null;
}
const emptyValue = (e: Empty): unknown => (e === '""' ? '' : e === '[]' ? [] : false);

/** ' (send "", [] or false when unused)', naming only the empty values of the fields it follows. */
function emptyNote(empties: ReadonlySet<Empty>): string {
  const forms = EMPTY_ORDER.filter((e) => empties.has(e));
  if (!forms.length) return '';
  const list = forms.length === 1 ? forms[0] : `${forms.slice(0, -1).join(', ')} or ${forms[forms.length - 1]}`;
  return ` (send ${list} when unused)`;
}

/** `s` cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function cutUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = /[\uD800-\uDBFF]/.test(s.charAt(max - 1)) ? max - 1 : max;
  return s.slice(0, end);
}

/**
 * Whether `input` satisfies `schema` (a schema checkSchema() accepted), every constraint
 * included. The error names every problem at once, in plain words, each with its path:
 * missing fields (a null on a required field is one, marked "(null)"), unknown fields,
 * types, enums, consts, ranges and sizes, at every depth, for example
 * `the input is missing to, body_name (send "" or [] when unused); entities[3].at must
 * hold at least 2 items.` It names up to INPUT_MAX_PROBLEMS (an object's missing fields are
 * one problem, and its unknown ones another) in at most INPUT_ERROR_MAX characters, and
 * counts the rest.
 */
export function validateInput(schema: JsonSchemaObject | SchemaNode, input: unknown): InputCheck {
  const found: Found = { list: [], total: 0 };
  validateNode(schema as SchemaNode, input, '', found);
  if (!found.total) return { ok: true };
  return { ok: false, error: inputError(found), path: found.list[0].path, problems: found.total };
}

/** The problems as one message, "a; b; c.", cut to INPUT_ERROR_MAX with the rest counted. */
function inputError(found: Found): string {
  const room = INPUT_ERROR_MAX - ERROR_TAIL;
  let text = '';
  let named = 0;
  for (const p of found.list) {
    const next = text ? `${text}; ${p.text}` : p.text;
    if (next.length > room) {
      if (!text) {
        text = `${cutUnits(p.text, room - 1)}…`;
        named = 1;
      }
      break;
    }
    text = next;
    named += 1;
  }
  const more = found.total - named;
  return more > 0 ? `${text}; and ${more} more problem${more === 1 ? '' : 's'}.` : `${text}.`;
}

function validateNode(s: SchemaNode, v: unknown, path: string, found: Found): void {
  const where = path || 'the input';
  const note = (text: string) => {
    found.total += 1;
    if (found.list.length < INPUT_MAX_PROBLEMS) found.list.push({ path, text });
  };
  const bad = (error: string) => note(`${where} ${error}`);
  const type = String(s.type);
  // A value of the wrong type, const or enum has nothing more to check inside it.
  if (!matchesType(type, v)) return bad(`must be ${typeWords(type)}`);
  if (hasOwn(s, 'const') && v !== s.const) return bad(`must be ${show(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === v)) return bad(`must be one of ${s.enum.map(show).join(', ')}`);
  if (type === 'number' || type === 'integer') {
    const n = v as number;
    if (isFiniteNumber(s.minimum) && n < (s.minimum as number)) bad(`must be at least ${s.minimum}`);
    else if (isFiniteNumber(s.maximum) && n > (s.maximum as number)) bad(`must be at most ${s.maximum}`);
  }
  if (type === 'string') {
    const len = chars(v as string);
    if (isCount(s.minLength) && len < (s.minLength as number)) bad(`must be at least ${s.minLength} characters`);
    else if (isCount(s.maxLength) && len > (s.maxLength as number)) bad(`must be at most ${s.maxLength} characters`);
  }
  if (type === 'array') {
    const list = v as unknown[];
    if (isCount(s.minItems) && list.length < (s.minItems as number)) bad(`must hold at least ${s.minItems} items`);
    else if (isCount(s.maxItems) && list.length > (s.maxItems as number)) bad(`must hold at most ${s.maxItems} items`);
    for (let i = 0; i < list.length; i += 1) validateNode(s.items as SchemaNode, list[i], `${path || 'input'}[${i}]`, found);
  }
  if (type === 'object') {
    const obj = v as Record<string, unknown>;
    const props = (isRecord(s.properties) ? s.properties : {}) as Record<string, SchemaNode>;
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const missing: string[] = [];
    const empties = new Set<Empty>();
    for (const r of required) {
      const absent = !hasOwn(obj, r) || obj[r] === undefined;
      if (!absent && obj[r] !== null) continue;
      missing.push(absent ? fieldName(r) : `${fieldName(r)} (null)`);
      const e = emptyOf(props[r]);
      if (e) empties.add(e);
    }
    if (missing.length) note(`${where} is missing ${missing.join(', ')}${emptyNote(empties)}`);
    const unknown = Object.keys(obj).filter((k) => !hasOwn(props, k));
    if (unknown.length) {
      note(`${where} has ${unknown.length === 1 ? 'an unknown field' : 'unknown fields'} ${unknown.map((k) => `"${k.slice(0, 40)}"`).join(', ')}`);
    }
    for (const key of Object.keys(props)) {
      if (!hasOwn(obj, key) || obj[key] === undefined) continue;
      // A required field's null is named with the missing ones above.
      if (obj[key] === null && required.has(key)) continue;
      validateNode(props[key], obj[key], path ? `${path}.${key}` : key, found);
    }
  }
}

/**
 * The input with each required field it leaves out, or sends as null, given the value that
 * means "unused" when its type has one: "" for a string without enum or const, [] for a
 * list, false for a boolean (not when the schema refuses that value: a minLength or
 * minItems above 0). At every depth; numbers, enums, consts and objects are never guessed,
 * and everything else is left for validateInput(). The runner uses it only for a local
 * model's calls of workspace tools, whose schemas list every field as required.
 */
export function fillLocalDefaults(schema: JsonSchemaObject | SchemaNode, input: unknown): unknown {
  return fillNode(schema as SchemaNode, input);
}

function fillNode(s: SchemaNode, v: unknown): unknown {
  if (!isRecord(s)) return v;
  if (s.type === 'array' && Array.isArray(v)) return v.map((x) => fillNode(s.items as SchemaNode, x));
  if (s.type !== 'object' || !isRecord(v)) return v;
  const props = (isRecord(s.properties) ? s.properties : {}) as Record<string, SchemaNode>;
  const out: Record<string, unknown> = {};
  // Defined, not assigned, as stripNode keeps an own "__proto__" key a key.
  const put = (k: string, x: unknown) => Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true });
  for (const [k, x] of Object.entries(v)) put(k, hasOwn(props, k) ? fillNode(props[k], x) : x);
  for (const r of Array.isArray(s.required) ? (s.required as string[]) : []) {
    if (hasOwn(out, r) && out[r] !== null && out[r] !== undefined) continue;
    const e = emptyOf(props[r]);
    if (e) put(r, emptyValue(e));
  }
  return out;
}

// ---------------------------------------------------------------- emitters

const num = (n: number) => String(n);

/** The limits STRICT_KEEP leaves out, as plain words ("" when there are none). */
export function limitWords(s: SchemaNode): string {
  const type = String(s.type);
  const has = (k: string) => hasOwn(s, k) && typeof s[k] === 'number';
  if (type === 'number' || type === 'integer') {
    const kind = type === 'integer' ? 'integer' : 'number';
    if (has('minimum') && has('maximum')) return `${kind} from ${num(s.minimum as number)} to ${num(s.maximum as number)}`;
    if (has('minimum')) return `${kind}, at least ${num(s.minimum as number)}`;
    if (has('maximum')) return `${kind}, at most ${num(s.maximum as number)}`;
    return '';
  }
  if (type === 'string') {
    if (has('minLength') && has('maxLength')) {
      return s.minLength === s.maxLength ? `exactly ${s.maxLength} characters` : `${s.minLength} to ${s.maxLength} characters`;
    }
    if (has('maxLength')) return `at most ${s.maxLength} characters`;
    if (has('minLength')) return `at least ${s.minLength} characters`;
    return '';
  }
  if (type === 'array') {
    if (has('minItems') && has('maxItems')) {
      return s.minItems === s.maxItems ? `exactly ${s.maxItems} items` : `${s.minItems} to ${s.maxItems} items`;
    }
    if (has('maxItems')) return `at most ${s.maxItems} items`;
    if (has('minItems')) return `at least ${s.minItems} items`;
    return '';
  }
  return '';
}

function describe(s: SchemaNode): string | undefined {
  const words = limitWords(s);
  const desc = typeof s.description === 'string' ? s.description : '';
  if (!words) return desc || undefined;
  return desc ? `${desc} (${words})` : words.charAt(0).toUpperCase() + words.slice(1);
}

function strictNode(s: SchemaNode, dialect: 'anthropic' | 'openai', nullable: boolean): Record<string, Json> {
  const keep = new Set(STRICT_KEEP[dialect]);
  const type = String(s.type);
  const out: Record<string, Json> = {};
  out.type = nullable ? [type, 'null'] : type;
  const description = describe(s);
  if (description !== undefined && keep.has('description')) out.description = description;
  if (Array.isArray(s.enum) && keep.has('enum')) out.enum = nullable ? [...(s.enum as Json[]), null] : [...(s.enum as Json[])];
  if (hasOwn(s, 'const') && keep.has('const')) {
    // A nullable const has no strict form; an enum of the value and null says the same.
    if (nullable) out.enum = [s.const as Json, null];
    else out.const = s.const as Json;
  }
  if (type === 'array') out.items = strictNode(s.items as SchemaNode, dialect, false);
  if (type === 'object') {
    const props = (isRecord(s.properties) ? s.properties : {}) as Record<string, SchemaNode>;
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const outProps: Record<string, Json> = {};
    for (const [name, child] of Object.entries(props)) {
      const optional = !required.has(name);
      outProps[name] = strictNode(child, dialect, dialect === 'openai' && optional);
    }
    out.properties = outProps;
    const names = Object.keys(props);
    const req = dialect === 'openai' ? names : names.filter((n) => required.has(n));
    if (req.length || dialect === 'openai') out.required = req;
    out.additionalProperties = false;
  }
  return out;
}

/**
 * The schema as `provider` is sent it. `anthropic` and `openai`: strict (STRICT_KEEP,
 * limits in words, no title; `openai` lists every property in required and makes the
 * optional ones nullable). `openai_compatible`: a copy of the schema as validated.
 */
export function emitSchema(provider: ProviderId, schema: JsonSchemaObject | SchemaNode): Record<string, Json> {
  if (provider === 'openai_compatible') return structuredClone(schema) as Record<string, Json>;
  return strictNode(schema as SchemaNode, provider, false);
}

/**
 * The second cloud dialect sends optional fields it has no value for as null (every
 * field is required there). This removes those nulls, at every depth, so the input
 * validates against the original schema. Fields the schema requires keep their null
 * (validation then refuses it).
 */
export function stripNullOptionals(schema: JsonSchemaObject | SchemaNode, input: unknown): unknown {
  return stripNode(schema as SchemaNode, input);
}

function stripNode(s: SchemaNode, v: unknown): unknown {
  if (!isRecord(s)) return v;
  if (s.type === 'array' && Array.isArray(v)) return v.map((x) => stripNode(s.items as SchemaNode, x));
  if (s.type !== 'object' || !isRecord(v)) return v;
  const props = (isRecord(s.properties) ? s.properties : {}) as Record<string, SchemaNode>;
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null && hasOwn(props, k) && !required.has(k)) continue;
    // Defined, not assigned: an own "__proto__" key (JSON.parse makes one) stays a key that
    // validation refuses, instead of becoming the prototype a tool would read through.
    Object.defineProperty(out, k, { value: hasOwn(props, k) ? stripNode(props[k], x) : x, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
