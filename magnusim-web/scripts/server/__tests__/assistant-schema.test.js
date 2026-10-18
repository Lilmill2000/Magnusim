// The tool-schema subset (Foundation spec 7.2, 10.1): what is accepted and refused (with
// the reason), the size caps, validation of every constraint, the two strict emitters
// keeping only STRICT_KEEP with the other limits in words, the second dialect's nullable
// optionals and their stripping, and the local-server dialect's copy as validated. Every
// problem with an input at once (12 named, 2000 characters, the rest counted), and the
// local fill: "", [] and false for required strings, lists and booleans, nothing else.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-schema-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { checkSchema, validateInput, emitSchema, stripNullOptionals, fillLocalDefaults, STRICT_KEEP, limitWords, SCHEMA_MAX_DEPTH, INPUT_MAX_PROBLEMS, INPUT_ERROR_MAX } =
  await import('../assistant/schema.ts');

const obj = (properties, required = Object.keys(properties), extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra });

/** The demo workspace's tools (python/tests/fixtures/assistant-plugins/ai-demo), as a page would send them. */
const ADD = obj({ by: { type: 'integer', minimum: -100, maximum: 100, description: 'How much to add.' } });
const RICH = obj(
  {
    label: { type: 'string', minLength: 1, maxLength: 64, title: 'Label' },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 20 },
    mode: { type: 'string', enum: ['fast', 'fine'] },
    fixed: { type: 'string', const: 'x' },
    scale: { type: 'number', minimum: 0.5 },
    flag: { type: 'boolean' },
    nested: obj({ depth: { type: 'integer', maximum: 3 } }, []),
  },
  ['label'],
);

describe('checkSchema: the subset', () => {
  it('accepts every allowed keyword', () => {
    assert.deepEqual(checkSchema(ADD), { ok: true });
    assert.deepEqual(checkSchema(RICH), { ok: true });
    assert.deepEqual(checkSchema(obj({})), { ok: true });
  });

  it('refuses each unsupported keyword with its reason', () => {
    const cases = [
      [{ $ref: '#/x' }, /references/],
      [{ oneOf: [] }, /oneOf/],
      [{ anyOf: [] }, /anyOf/],
      [{ allOf: [] }, /allOf/],
      [{ pattern: '^a' }, /patterns are not supported/],
      [{ format: 'date' }, /formats are not supported/],
      [{ default: 'a' }, /defaults are not supported/],
      [{ examples: ['a'] }, /"examples" is not supported for type string/],
      [{ minimum: 1 }, /"minimum" is not supported for type string/],
    ];
    for (const [extra, re] of cases) {
      const r = checkSchema(obj({ x: { type: 'string', ...extra } }));
      assert.equal(r.ok, false, JSON.stringify(extra));
      assert.match(r.error, re, JSON.stringify(extra));
      assert.equal(r.path, 'x');
    }
    assert.match(checkSchema(obj({ x: { type: ['string', 'null'] } })).error, /list of types/);
    assert.match(checkSchema({ type: 'object', properties: {}, patternProperties: {}, additionalProperties: false }).error, /patternProperties/);
    assert.match(checkSchema({ type: 'object', properties: {} }).error, /additionalProperties": false/);
    assert.match(checkSchema(obj({ inner: { type: 'object', properties: {} } })).error, /inner: every object needs/);
    assert.match(checkSchema({ type: 'string' }).error, /must be an object schema/);
    assert.match(checkSchema(obj({ x: { type: 'string' } }, ['y'])).error, /names "y", which is not a property/);
    assert.match(checkSchema(obj({ x: { type: 'integer', minimum: 5, maximum: 1 } })).error, /"minimum" is above "maximum"/);
    assert.match(checkSchema(obj({ x: { type: 'string', enum: ['a', 1] } })).error, /every "enum" value must be a string/);
    assert.match(checkSchema(obj({ x: { type: 'array' } })).error, /needs "items"/);
    assert.match(checkSchema(obj({ x: { type: 'date' } })).error, /"type" must be/);
  });

  it('caps depth, properties, enum length and size', () => {
    let deep = { type: 'string' };
    for (let i = 0; i < SCHEMA_MAX_DEPTH - 1; i += 1) deep = obj({ d: deep });
    assert.deepEqual(checkSchema(deep), { ok: true }, 'six deep is fine');
    assert.match(checkSchema(obj({ d: deep })).error, /nest at most 6 deep/);
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, { type: 'boolean' }]));
    assert.match(checkSchema(obj(many, [])).error, /at most 64 properties/);
    assert.match(checkSchema(obj({ e: { type: 'integer', enum: Array.from({ length: 65 }, (_, i) => i) } })).error, /at most 64 values/);
    const big = obj({ s: { type: 'string', description: 'x'.repeat(17 * 1024) } });
    assert.match(checkSchema(big).error, /larger than 16 KB/);
  });
});

describe('validateInput: every constraint', () => {
  it('numbers, strings, lists, enums, consts, required and unknown fields', () => {
    assert.deepEqual(validateInput(ADD, { by: 100 }), { ok: true });
    assert.match(validateInput(ADD, { by: 101 }).error, /by must be at most 100/);
    assert.match(validateInput(ADD, { by: -101 }).error, /by must be at least -100/);
    assert.match(validateInput(ADD, { by: 1.5 }).error, /by must be a whole number/);
    assert.match(validateInput(ADD, { by: '2' }).error, /by must be a whole number/);
    assert.equal(validateInput(ADD, {}).error, 'the input is missing by.');
    assert.match(validateInput(ADD, { by: 1, extra: 2 }).error, /unknown field "extra"/);
    const good = { label: 'ok', tags: ['a'], mode: 'fast', fixed: 'x', scale: 1, flag: true, nested: { depth: 3 } };
    assert.deepEqual(validateInput(RICH, good), { ok: true });
    assert.match(validateInput(RICH, { ...good, label: '' }).error, /label must be at least 1 characters/);
    assert.match(validateInput(RICH, { ...good, label: 'x'.repeat(65) }).error, /at most 64 characters/);
    assert.deepEqual(validateInput(RICH, { ...good, label: '😀'.repeat(64) }), { ok: true }, 'lengths count characters, not UTF-16 units');
    assert.match(validateInput(RICH, { ...good, tags: [] }).error, /at least 1 items/);
    assert.match(validateInput(RICH, { ...good, tags: Array(21).fill('a') }).error, /at most 20 items/);
    assert.match(validateInput(RICH, { ...good, tags: ['c'] }).error, /tags\[0\] must be one of "a", "b"/);
    assert.match(validateInput(RICH, { ...good, mode: 'slow' }).error, /mode must be one of/);
    assert.match(validateInput(RICH, { ...good, fixed: 'y' }).error, /fixed must be "x"/);
    assert.match(validateInput(RICH, { ...good, scale: 0.1 }).error, /at least 0.5/);
    assert.match(validateInput(RICH, { ...good, flag: 'yes' }).error, /flag must be a boolean/);
    assert.match(validateInput(RICH, { ...good, nested: { depth: 4 } }).error, /nested.depth must be at most 3/);
    assert.match(validateInput(RICH, { ...good, nested: null }).error, /nested must be an object/);
    assert.match(validateInput(ADD, [1]).error, /the input must be an object/);
  });
});

/** A CAD-like tool: every field required, "" / [] / false when unused (the spec's example). */
const EDGE = obj({
  distance: { type: 'string', maxLength: 40 },
  distance2: { type: 'string', maxLength: 40 },
  to: { type: 'array', items: { type: 'string' }, maxItems: 8 },
  body_name: { type: 'string', maxLength: 64 },
  color: { type: 'boolean' },
  entities: { type: 'array', items: obj({ kind: { type: 'string', enum: ['line', 'arc'] }, at: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }) },
});
const ENTITY = { kind: 'line', at: [0, 0] };

describe('validateInput: every problem at once', () => {
  it("names them all in one message, its path the first one's", () => {
    const r = validateInput(EDGE, { distance: '5', entities: [ENTITY, ENTITY, ENTITY, { kind: 'line', at: [1] }] });
    assert.deepEqual(r, {
      ok: false,
      error: 'the input is missing distance2, to, body_name, color (send "", [] or false when unused); entities[3].at must hold at least 2 items.',
      path: '',
      problems: 2,
    });
    const deep = validateInput(EDGE, { distance: '', distance2: '', to: [], body_name: '', color: false, entities: [{ kind: 'spline', at: [1, 'x'] }] });
    assert.deepEqual([deep.error, deep.path, deep.problems], ['entities[0].kind must be one of "line", "arc"; entities[0].at[1] must be a number.', 'entities[0].kind', 2]);
  });

  it('every kind: missing, null on a required field, unknown, type, const, enum, range and size, at every depth', () => {
    const input = { label: 'x'.repeat(65), tags: ['a', 'c', 1], mode: 'slow', fixed: 'y', scale: 0.1, flag: 'yes', nested: { depth: 4, odd: 1 }, more: 1, other: 2 };
    const r = validateInput(RICH, input);
    assert.equal(
      r.error,
      'the input has unknown fields "more", "other"; label must be at most 64 characters; tags[1] must be one of "a", "b"; tags[2] must be a string; ' +
        'mode must be one of "fast", "fine"; fixed must be "x"; scale must be at least 0.5; flag must be a boolean; nested has an unknown field "odd"; nested.depth must be at most 3.',
    );
    assert.deepEqual([r.path, r.problems], ['', 10]);
    // A null on a required field counts as missing (marked), beside the fields left out; its type is not checked too.
    const both = obj({ a: { type: 'integer' }, b: { type: 'string' }, c: { type: 'boolean' }, 'two words': { type: 'array', items: { type: 'string' } } });
    assert.equal(validateInput(both, { a: null, c: null }).error, 'the input is missing a (null), b, c (null), "two words" (send "", [] or false when unused).');
    // The note names only the empty values of the fields it follows: none for numbers, enums, consts, objects or refused empties.
    const kinds = obj({
      n: { type: 'number' },
      e: { type: 'string', enum: ['a'] },
      k: { type: 'boolean', const: true },
      o: obj({}),
      s: { type: 'string', minLength: 1 },
      l: { type: 'array', items: { type: 'string' }, minItems: 1 },
    });
    assert.equal(validateInput(kinds, {}).error, 'the input is missing n, e, k, o, s, l.');
    const some = obj({ s: { type: 'string' }, f: { type: 'boolean' }, n: { type: 'number' } });
    assert.equal(validateInput(some, {}).error, 'the input is missing s, f, n (send "" or false when unused).');
  });

  it(`names at most ${INPUT_MAX_PROBLEMS} problems and counts the rest`, () => {
    const many = obj({ rows: { type: 'array', items: { type: 'integer', maximum: 3 } } });
    const r = validateInput(many, { rows: Array.from({ length: 20 }, (_, i) => 10 + i) });
    assert.equal(r.problems, 20);
    const named = r.error.split('; ');
    assert.equal(named.length, INPUT_MAX_PROBLEMS + 1);
    assert.deepEqual(named.slice(0, 2), ['rows[0] must be at most 3', 'rows[1] must be at most 3']);
    assert.equal(named[INPUT_MAX_PROBLEMS - 1], 'rows[11] must be at most 3');
    assert.equal(named[INPUT_MAX_PROBLEMS], 'and 8 more problems.');
    const thirteen = validateInput(many, { rows: Array.from({ length: 13 }, () => 9) });
    assert.match(thirteen.error, /; rows\[11\] must be at most 3; and 1 more problem\.$/);
    const twelve = validateInput(many, { rows: Array.from({ length: 12 }, () => 9) });
    assert.match(twelve.error, /; rows\[11\] must be at most 3\.$/);
  });

  it(`stays within ${INPUT_ERROR_MAX} characters: whole problems while they fit, the rest counted; one too long alone is cut`, () => {
    const long = (i) => `f${i}_${'x'.repeat(300)}`;
    const wide = obj(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [long(i), { type: 'integer' }])));
    const r = validateInput(wide, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [long(i), 'x'])));
    assert.ok(r.error.length <= INPUT_ERROR_MAX, String(r.error.length));
    assert.equal(r.problems, 10);
    const shown = r.error.split('; ').filter((p) => p.endsWith('must be a whole number'));
    assert.ok(shown.length >= 5 && shown.length < 10, String(shown.length));
    assert.deepEqual(shown, Array.from({ length: shown.length }, (_, i) => `${long(i)} must be a whole number`), 'whole problems, in order');
    assert.ok(r.error.endsWith(`; and ${10 - shown.length} more problems.`), r.error.slice(-60));
    // One problem longer than the room by itself: cut, marked, never past the cap.
    const values = Array.from({ length: 64 }, (_, i) => `${i}${'v'.repeat(45)}`);
    const choice = obj({ pick: { type: 'string', enum: values }, n: { type: 'integer' } });
    const cut = validateInput(choice, { pick: 'none', n: 'x' });
    assert.ok(cut.error.length <= INPUT_ERROR_MAX, String(cut.error.length));
    assert.match(cut.error, /^pick must be one of "0v+\.\.\., .*…; and 1 more problem\.$/);
    assert.equal(cut.path, 'pick');
  });
});

describe('fillLocalDefaults: the local fill', () => {
  it('fills required strings without enum, lists and booleans left out or sent as null, at every depth, and keeps every value given', () => {
    const input = { distance: '5', distance2: null, entities: [{ kind: 'arc', at: [1, 2] }] };
    const filled = fillLocalDefaults(EDGE, input);
    assert.deepEqual(filled, { distance: '5', distance2: '', to: [], body_name: '', color: false, entities: [{ kind: 'arc', at: [1, 2] }] });
    assert.deepEqual(validateInput(EDGE, filled), { ok: true });
    assert.deepEqual(input, { distance: '5', distance2: null, entities: [{ kind: 'arc', at: [1, 2] }] }, 'the input itself is not changed');
    const nested = obj({
      rows: { type: 'array', items: obj({ label: { type: 'string' }, on: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } } }) },
      inner: obj({ note: { type: 'string' } }),
    });
    assert.deepEqual(fillLocalDefaults(nested, { rows: [{}, { label: 'a', on: null }], inner: {} }), {
      rows: [
        { label: '', on: false, tags: [] },
        { label: 'a', on: false, tags: [] },
      ],
      inner: { note: '' },
    });
  });

  it('never guesses numbers, enums, consts or objects, nor an empty value the schema refuses, nor an optional field', () => {
    const kinds = obj({
      n: { type: 'number' },
      i: { type: 'integer' },
      e: { type: 'string', enum: ['a', ''] },
      c: { type: 'string', const: 'x' },
      k: { type: 'boolean', const: false },
      o: obj({ s: { type: 'string' } }),
      s: { type: 'string', minLength: 1 },
      l: { type: 'array', items: { type: 'string' }, minItems: 1 },
    });
    assert.deepEqual(fillLocalDefaults(kinds, { n: null }), { n: null });
    assert.deepEqual(fillLocalDefaults(kinds, {}), {});
    assert.equal(validateInput(kinds, fillLocalDefaults(kinds, {})).error, 'the input is missing n, i, e, c, k, o, s, l.');
    assert.deepEqual(fillLocalDefaults(RICH, {}), {}, "RICH's only required field has a minLength");
    assert.deepEqual(fillLocalDefaults(obj({ flag: { type: 'boolean' } }, []), {}), {}, 'an optional field stays out');
    // Wrong types and other values are left for validation, not replaced.
    const wrong = { distance: 5, to: 'a', entities: 'x', color: 'no', body_name: '', distance2: '' };
    assert.deepEqual(fillLocalDefaults(EDGE, wrong), wrong);
    assert.deepEqual(fillLocalDefaults(EDGE, [1]), [1], 'a non-object input is left as it is');
  });

  it('never sets a prototype: a "__proto__" key stays a key, and validation refuses it', () => {
    const note = obj({ note: { type: 'string' } });
    const filled = fillLocalDefaults(note, JSON.parse('{"__proto__":{"note":"x"}}'));
    assert.equal(Object.getPrototypeOf(filled), Object.prototype);
    assert.deepEqual(Object.keys(filled), ['__proto__', 'note']);
    assert.equal(filled.note, '');
    assert.match(validateInput(note, filled).error, /unknown field "__proto__"/);
  });
});

/** Every keyword in an emitted schema (property names excluded). */
function keywords(s, out = new Set()) {
  if (!s || typeof s !== 'object') return out;
  for (const [k, v] of Object.entries(s)) {
    out.add(k);
    if (k === 'properties') for (const sub of Object.values(v)) keywords(sub, out);
    if (k === 'items') keywords(v, out);
  }
  return out;
}

describe('emitSchema', () => {
  it('both strict dialects keep only STRICT_KEEP, with every other limit in words', () => {
    for (const dialect of ['anthropic', 'openai']) {
      const out = emitSchema(dialect, RICH);
      for (const k of keywords(out)) assert.ok(STRICT_KEEP[dialect].includes(k), `${dialect} sent "${k}"`);
      assert.equal(out.properties.label.description, '1 to 64 characters');
      assert.equal(out.properties.tags.description, '1 to 20 items');
      assert.equal(out.properties.scale.description, 'Number, at least 0.5');
      assert.equal(out.properties.nested.properties.depth.description, 'Integer, at most 3');
      assert.equal(emitSchema(dialect, ADD).properties.by.description, 'How much to add. (integer from -100 to 100)');
      assert.equal(out.additionalProperties, false);
      assert.equal(out.properties.nested.additionalProperties, false);
    }
  });

  it('the first strict dialect keeps optional fields optional; the second requires all and makes the optional ones nullable', () => {
    const a = emitSchema('anthropic', RICH);
    assert.deepEqual(a.required, ['label']);
    assert.equal(a.properties.mode.type, 'string');
    assert.equal(a.properties.nested.required, undefined);
    const o = emitSchema('openai', RICH);
    assert.deepEqual(o.required, ['label', 'tags', 'mode', 'fixed', 'scale', 'flag', 'nested']);
    assert.equal(o.properties.label.type, 'string');
    assert.deepEqual(o.properties.mode.type, ['string', 'null']);
    assert.deepEqual(o.properties.mode.enum, ['fast', 'fine', null]);
    assert.deepEqual(o.properties.fixed.enum, ['x', null], 'a nullable const becomes an enum with null');
    assert.equal(o.properties.fixed.const, undefined);
    assert.deepEqual(o.properties.nested.type, ['object', 'null']);
    assert.deepEqual(o.properties.nested.required, ['depth']);
    assert.deepEqual(o.properties.nested.properties.depth.type, ['integer', 'null']);
  });

  it('the local-server dialect gets a copy of the schema as validated', () => {
    const c = emitSchema('openai_compatible', RICH);
    assert.deepEqual(c, RICH);
    assert.notEqual(c, RICH);
  });

  it('stripNullOptionals removes the nulls the second dialect sends for optional fields, at every depth', () => {
    const sent = { label: 'a', tags: null, mode: null, fixed: null, scale: null, flag: null, nested: { depth: null } };
    const stripped = stripNullOptionals(RICH, sent);
    assert.deepEqual(stripped, { label: 'a', nested: {} });
    assert.deepEqual(validateInput(RICH, stripped), { ok: true });
    // A required field's null stays, and validation refuses it.
    const req = stripNullOptionals(RICH, { label: null });
    assert.deepEqual(req, { label: null });
    assert.equal(validateInput(RICH, req).error, 'the input is missing label (null).');
    const list = obj({ rows: { type: 'array', items: obj({ a: { type: 'integer' } }, []) } });
    assert.deepEqual(stripNullOptionals(list, { rows: [{ a: null }, { a: 1 }] }), { rows: [{}, { a: 1 }] });
  });

  it('stripNullOptionals never sets a prototype: a "__proto__" key stays a key, and validation refuses it', () => {
    const s = obj({ simulation_id: { type: 'string', maxLength: 80 } }, []);
    const long = 'x'.repeat(500);
    const raw = JSON.parse(`{"__proto__":{"simulation_id":"${long}"}}`);
    assert.match(validateInput(s, raw).error, /unknown field "__proto__"/);
    const stripped = stripNullOptionals(s, raw);
    assert.equal(Object.getPrototypeOf(stripped), Object.prototype);
    assert.equal(stripped.simulation_id, undefined, 'nothing reads through a prototype');
    assert.deepEqual(Object.keys(stripped), ['__proto__']);
    assert.match(validateInput(s, stripped).error, /unknown field "__proto__"/);
    // Deeper down, and where a tool reads a bounded number afterwards.
    const nested = obj({ inner: obj({ by: { type: 'integer', minimum: -100, maximum: 100 } }, []) }, []);
    const deep = stripNullOptionals(nested, JSON.parse('{"inner":{"__proto__":{"by":100000}}}'));
    assert.equal(deep.inner.by, undefined);
    assert.equal(validateInput(nested, deep).ok, false);
    // A schema may not name a property "__proto__" either.
    const named = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"additionalProperties":false}');
    assert.match(checkSchema(named).error, /__proto__/);
  });

  it('limitWords says each limit in plain words', () => {
    assert.equal(limitWords({ type: 'integer', minimum: -100, maximum: 100 }), 'integer from -100 to 100');
    assert.equal(limitWords({ type: 'array', minItems: 1, maxItems: 20 }), '1 to 20 items');
    assert.equal(limitWords({ type: 'string', maxLength: 64 }), 'at most 64 characters');
    assert.equal(limitWords({ type: 'string', minLength: 3, maxLength: 3 }), 'exactly 3 characters');
    assert.equal(limitWords({ type: 'boolean' }), '');
  });
});
