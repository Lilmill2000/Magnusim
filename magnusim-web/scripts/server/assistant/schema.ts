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

export type InputCheck = { ok: true } | { ok: false; error: string; path: string };

const chars = (s: string) => [...s].length;
const show = (v: unknown) => {
  const t = JSON.stringify(v);
  return t && t.length > 40 ? `${t.slice(0, 37)}...` : String(t);
};

/**
 * Whether `input` satisfies `schema` (a schema checkSchema() accepted), every constraint
 * included. The error names the path and says what is wrong in plain words.
 */
export function validateInput(schema: JsonSchemaObject | SchemaNode, input: unknown): InputCheck {
  return validateNode(schema as SchemaNode, input, '');
}

function validateNode(s: SchemaNode, v: unknown, path: string): InputCheck {
  const where = path || 'the input';
  const bad = (error: string): InputCheck => ({ ok: false, error: `${where} ${error}`, path });
  const type = String(s.type);
  if (!matchesType(type, v)) return bad(`must be ${type === 'integer' ? 'a whole number' : type === 'array' ? 'a list' : type === 'object' ? 'an object' : `a ${type}`}.`);
  if (hasOwn(s, 'const') && v !== s.const) return bad(`must be ${show(s.const)}.`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === v)) return bad(`must be one of ${s.enum.map(show).join(', ')}.`);
  if (type === 'number' || type === 'integer') {
    const n = v as number;
    if (isFiniteNumber(s.minimum) && n < (s.minimum as number)) return bad(`must be at least ${s.minimum}.`);
    if (isFiniteNumber(s.maximum) && n > (s.maximum as number)) return bad(`must be at most ${s.maximum}.`);
  }
  if (type === 'string') {
    const len = chars(v as string);
    if (isCount(s.minLength) && len < (s.minLength as number)) return bad(`must be at least ${s.minLength} characters.`);
    if (isCount(s.maxLength) && len > (s.maxLength as number)) return bad(`must be at most ${s.maxLength} characters.`);
  }
  if (type === 'array') {
    const list = v as unknown[];
    if (isCount(s.minItems) && list.length < (s.minItems as number)) return bad(`must hold at least ${s.minItems} items.`);
    if (isCount(s.maxItems) && list.length > (s.maxItems as number)) return bad(`must hold at most ${s.maxItems} items.`);
    for (let i = 0; i < list.length; i += 1) {
      const r = validateNode(s.items as SchemaNode, list[i], `${path || 'input'}[${i}]`);
      if (!r.ok) return r;
    }
  }
  if (type === 'object') {
    const obj = v as Record<string, unknown>;
    const props = (isRecord(s.properties) ? s.properties : {}) as Record<string, SchemaNode>;
    for (const key of Object.keys(obj)) {
      if (!hasOwn(props, key)) return { ok: false, error: `${where} has an unknown field "${key.slice(0, 40)}".`, path };
    }
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    for (const r of required) {
      if (!hasOwn(obj, r) || obj[r] === undefined) return { ok: false, error: `${where} is missing "${r}".`, path };
    }
    for (const key of Object.keys(obj)) {
      const r = validateNode(props[key], obj[key], path ? `${path}.${key}` : key);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
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
    out[k] = hasOwn(props, k) ? stripNode(props[k], x) : x;
  }
  return out;
}
