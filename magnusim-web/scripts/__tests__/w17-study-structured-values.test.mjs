import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

// Host API 1.8: the study update route keeps arrays and objects for a key of the
// analysis's settings schema (the registry row's `schema`, as registry.describe and the
// committed dump carry it), as plain JSON within limits in that key's shape (a vector3 is
// three finite numbers): a custom gravity direction is saved and a copy carries it; null
// clears such a key. A value of the wrong shape is refused with the reason; arrays and
// objects under other keys are left out as before; scalars are kept as before.
const root = mkdtempSync(join(tmpdir(), 'cfd-w17-structured-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;

const { createGeometryFolder, writeJsonAtomic } = await import('../project-layout.js');
const { STUDY_VALUE_LIMITS, handleW17Api, settingsProperties, studyPhysicsFrom, studyValue } = await import('../w17-simulation.js');
const { loadCommittedRegistry, resetRegistryCache, setLiveRegistry } = await import('../registry-defaults.js');

after(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => resetRegistryCache());

const SCHEMA = {
  type: 'object',
  properties: {
    gravity: { type: 'string', default: '-z', enum: ['-z', 'custom'], title: 'Gravity' },
    gravity_vector: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, default: [0, 0, -1], title: 'Gravity direction' },
    sources: { type: 'object', title: 'Sources' },
    k: { type: 'number', default: 1, title: 'Conductivity' },
  },
};

/** A one-analysis plugin row with a vector3 setting and an object setting. */
function installAnalysis() {
  const row = {
    key: 'vec_steady',
    label: 'Vector settings',
    plugin: 'vec',
    time_dependency: 'steady',
    category: 'HEAT',
    algorithm_label: 'SIMPLE',
    family: { key: 'vec', label: 'Vec', study_name: 'Vec' },
    // The registry dump's shape (cfddesk.registry describe): the settings schema is `schema`.
    schema: SCHEMA,
    study_defaults: {
      analysis_type: 'vec_steady',
      analysis: 'Vec',
      analysis_title: 'Vector settings',
      category: 'HEAT',
      time_dependency: 'Steady-state',
      algorithm: 'SIMPLE',
      gravity: '-z',
      gravity_vector: [0, 0, -1],
      k: 1,
    },
  };
  const committed = loadCommittedRegistry();
  assert.ok(setLiveRegistry({ ...committed, analysis: [...committed.analysis, row] }));
}

function seedProject(projectId) {
  const dir = join(root, projectId);
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, 'project.json'), { id: projectId, active_geometry_id: 'geom-1', geometries: [{ id: 'geom-1', name: 'Box' }] });
  createGeometryFolder(dir, { id: 'geom-1', name: 'Box', original_filename: 'box.step' });
  return dir;
}

async function call(parts, body) {
  const out = {};
  await handleW17Api({ method: 'POST' }, { setHeader() {} }, new URL(`http://x/${parts.join('/')}`), parts, {
    readJsonBody: async () => body,
    sendJson: (_res, status, json) => Object.assign(out, { status, json: JSON.parse(JSON.stringify(json)) }),
  });
  return out;
}

const create = (body) => call(['api', 'simulation'], body);
const update = (body) => call(['api', 'simulation', 'update'], body);

function savedRow(dir, sid) {
  return JSON.parse(readFileSync(join(dir, 'simulations.json'), 'utf8')).simulations.find((s) => s.id === sid);
}

describe('the study route keeps arrays and objects (API 1.8)', () => {
  it('seeds a new study with the vector default, saves a custom direction, and refuses a wrong shape', async () => {
    installAnalysis();
    const dir = seedProject('p-vec');
    const made = await create({ project_id: 'p-vec', analysis_type: 'vec_steady' });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const sid = made.json.simulation.id;
    assert.deepEqual(savedRow(dir, sid).gravity_vector, [0, 0, -1]);

    const ok = await update({ project_id: 'p-vec', simulation_id: sid, gravity: 'custom', gravity_vector: [1, 0, 0] });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(savedRow(dir, sid).gravity, 'custom');
    assert.deepEqual(savedRow(dir, sid).gravity_vector, [1, 0, 0]);

    for (const [bad, why] of [
      [[1, 0], 'Gravity direction takes 3 numbers.'],
      [[1, 0, 0, 0], 'Gravity direction takes 3 numbers.'],
      [[1, 'x', 0], 'Gravity direction takes numbers only.'],
      [{ x: 1 }, 'Gravity direction takes a list.'],
    ]) {
      const no = await update({ project_id: 'p-vec', simulation_id: sid, gravity_vector: bad, k: 5 });
      assert.equal(no.status, 400, JSON.stringify(bad));
      assert.equal(no.json.error, why);
      assert.equal(no.json.key, 'gravity_vector');
    }
    // Nothing of a refused update is saved (k stayed 1).
    assert.deepEqual(savedRow(dir, sid).gravity_vector, [1, 0, 0]);
    assert.equal(savedRow(dir, sid).k, 1);
    // Lists that only look like a direction are refused too, and change nothing.
    for (const bad of [[], ['1', '0', '0'], [1, null, 0], [1, true, 0], [[1], [0], [0]]]) {
      const no = await update({ project_id: 'p-vec', simulation_id: sid, gravity_vector: bad });
      assert.equal(no.status, 400, JSON.stringify(bad));
      assert.equal(no.json.key, 'gravity_vector');
      assert.deepEqual(savedRow(dir, sid).gravity_vector, [1, 0, 0], JSON.stringify(bad));
    }
    // Fractions and negatives in every component are kept as typed.
    const tilted = await update({ project_id: 'p-vec', simulation_id: sid, gravity_vector: [0.5, -1, -2] });
    assert.equal(tilted.status, 200, JSON.stringify(tilted.json));
    assert.deepEqual(savedRow(dir, sid).gravity_vector, [0.5, -1, -2]);
    const back = await update({ project_id: 'p-vec', simulation_id: sid, gravity_vector: [1, 0, 0] });
    assert.equal(back.status, 200);

    const scalarAsList = await update({ project_id: 'p-vec', simulation_id: sid, k: [1, 2] });
    assert.equal(scalarAsList.status, 400);
    assert.equal(scalarAsList.json.error, 'Conductivity takes a single value.');
  });

  it('keeps a small plain object, refuses one with __proto__ or too large, and a copy carries the schema values', async () => {
    installAnalysis();
    const dir = seedProject('p-obj');
    const sid = (await create({ project_id: 'p-obj', analysis_type: 'vec_steady' })).json.simulation.id;
    const sources = { 'mat-1': { mode: 'power', power_W: 10 } };
    assert.equal((await update({ project_id: 'p-obj', simulation_id: sid, sources, gravity: 'custom', gravity_vector: [0, -1, 0] })).status, 200);
    assert.deepEqual(savedRow(dir, sid).sources, sources);

    // __proto__ in a JSON body is an own key: refused for a schema key, left out otherwise.
    const evil = JSON.parse('{"__proto__": {"polluted": 1}, "a": 1}');
    const refused = await update({ project_id: 'p-obj', simulation_id: sid, sources: evil });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /^Sources: not a plain value/);
    assert.equal(({}).polluted, undefined);
    // Arrays and objects under keys the schema does not have are left out, as before.
    const extra = await update({ project_id: 'p-obj', simulation_id: sid, plugin_note: evil, other: { a: [1, 2] }, list: [1, 2] });
    assert.equal(extra.status, 200);
    for (const key of ['plugin_note', 'other', 'list']) assert.equal(key in savedRow(dir, sid), false, key);
    // A scalar for a list key, and text over the limit, are refused.
    const scalar = await update({ project_id: 'p-obj', simulation_id: sid, gravity_vector: 'x' });
    assert.equal(scalar.status, 400);
    assert.equal(scalar.json.error, 'Gravity direction takes a list.');
    const long = await update({ project_id: 'p-obj', simulation_id: sid, note: 'x'.repeat(STUDY_VALUE_LIMITS.chars + 1) });
    assert.equal(long.status, 400);
    assert.equal(long.json.key, 'note');

    const big = Object.fromEntries(Array.from({ length: STUDY_VALUE_LIMITS.keys + 1 }, (_v, i) => [`k${i}`, i]));
    assert.equal((await update({ project_id: 'p-obj', simulation_id: sid, sources: big })).status, 400);
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    assert.equal((await update({ project_id: 'p-obj', simulation_id: sid, sources: deep })).status, 400);
    assert.equal((await update({ project_id: 'p-obj', simulation_id: sid, gravity_vector: [1, 0, Infinity] })).status, 400);
    assert.deepEqual(savedRow(dir, sid).sources, sources);

    // A copy carries the schema's structured settings, not other objects.
    const copy = await create({ project_id: 'p-obj', analysis_type: 'vec_steady', copy_from: sid });
    assert.equal(copy.status, 201, JSON.stringify(copy.json));
    const row = savedRow(dir, copy.json.simulation.id);
    assert.deepEqual(row.gravity_vector, [0, -1, 0]);
    assert.equal(row.gravity, 'custom');
    assert.deepEqual(row.sources, sources);
    assert.equal('other' in row, false);
  });

  it('studyValue and studyPhysicsFrom: scalars as before, structured values only in shape', () => {
    installAnalysis();
    const props = SCHEMA.properties;
    assert.deepEqual(studyValue('k', 3, props), { value: 3 });
    assert.deepEqual(studyValue('free', 'x', props), { value: 'x' });
    assert.deepEqual(studyValue('k', null, props), { clear: true });
    assert.deepEqual(studyValue('free', null, props), { skip: true });
    assert.deepEqual(studyValue('free', { a: 1 }, {}), { skip: true });
    assert.deepEqual(studyValue('free', { a: () => 1 }, {}), { skip: true });
    assert.deepEqual(studyValue('free', new Date(0), {}), { skip: true });
    const counts = { counts: { type: 'array', title: 'Counts', items: { type: 'integer' } } };
    assert.deepEqual(studyValue('counts', [1, 2], counts), { value: [1, 2] });
    assert.deepEqual(studyValue('counts', [1, 1.5], counts), { error: 'Counts takes whole numbers only.' });
    const out = studyPhysicsFrom({ id: 's1', k: 2, gravity_vector: [1, 2, 3], defaults: { k: 1 }, junk: { a: 1 } }, 'vec_steady');
    assert.deepEqual(out, { k: 2, gravity_vector: [1, 2, 3] });
  });

  it('null clears a schema key (a blanked value), and leaves other keys alone', async () => {
    installAnalysis();
    const dir = seedProject('p-null');
    const sid = (await create({ project_id: 'p-null', analysis_type: 'vec_steady' })).json.simulation.id;
    assert.equal((await update({ project_id: 'p-null', simulation_id: sid, gravity_vector: [1, 0, 0], k: 3, note: 'n' })).status, 200);
    const cleared = await update({ project_id: 'p-null', simulation_id: sid, gravity_vector: null, k: null, note: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    const row = savedRow(dir, sid);
    assert.equal('gravity_vector' in row, false);
    assert.equal('k' in row, false);
    assert.equal(row.note, 'n');
  });
});

describe('against the committed registry rows (scripts/generated/registry.json)', () => {
  it('Heat Transfer: a new study has the default gravity direction, a wrong one is refused, a copy keeps a custom one', async () => {
    resetRegistryCache();
    const props = settingsProperties('heat_transfer_steady');
    assert.deepEqual(props.gravity_vector.minItems, 3);
    const dir = seedProject('p-ht');
    const made = await create({ project_id: 'p-ht', analysis_type: 'heat_transfer_steady' });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const sid = made.json.simulation.id;
    assert.deepEqual(savedRow(dir, sid).gravity_vector, [0, 0, -1]);
    const no = await update({ project_id: 'p-ht', simulation_id: sid, gravity_vector: [1, 0] });
    assert.equal(no.status, 400);
    assert.equal(no.json.error, 'Gravity direction takes 3 numbers.');
    // Its turbulence model is a choice: an object there is refused.
    assert.equal((await update({ project_id: 'p-ht', simulation_id: sid, turbulence_model: { a: 1 } })).status, 400);
    assert.equal((await update({ project_id: 'p-ht', simulation_id: sid, gravity: 'custom', gravity_vector: [1, 0, 0] })).status, 200);
    const copy = await create({ project_id: 'p-ht', analysis_type: 'heat_transfer_steady', copy_from: sid });
    assert.equal(copy.status, 201, JSON.stringify(copy.json));
    const row = savedRow(dir, copy.json.simulation.id);
    assert.equal(row.gravity, 'custom');
    assert.deepEqual(row.gravity_vector, [1, 0, 0]);
  });

  it('Incompressible Flow: the centre of rotation and the directions are saved, cleared by null, and copied', async () => {
    resetRegistryCache();
    const dir = seedProject('p-if');
    const made = await create({ project_id: 'p-if', analysis_type: 'incompressible_steady' });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const sid = made.json.simulation.id;
    // Optional with no default: a new study has none.
    assert.equal('ref_cofr' in savedRow(dir, sid), false);
    const saved = await update({ project_id: 'p-if', simulation_id: sid, ref_cofr: [0.25, 0, 0], ref_drag_dir: [1, 0, 0], ref_lift_dir: [0, 0, 1] });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(savedRow(dir, sid).ref_cofr, [0.25, 0, 0]);
    assert.equal((await update({ project_id: 'p-if', simulation_id: sid, ref_cofr: [1, 2] })).status, 400);
    assert.equal((await update({ project_id: 'p-if', simulation_id: sid, turbulence_model: { a: 1 } })).status, 400);
    const copy = await create({ project_id: 'p-if', analysis_type: 'incompressible_steady', copy_from: sid });
    assert.equal(copy.status, 201, JSON.stringify(copy.json));
    const row = savedRow(dir, copy.json.simulation.id);
    assert.deepEqual([row.ref_cofr, row.ref_drag_dir, row.ref_lift_dir], [[0.25, 0, 0], [1, 0, 0], [0, 0, 1]]);
    // Blanking the centre of rotation clears it (the reader then uses the origin).
    assert.equal((await update({ project_id: 'p-if', simulation_id: sid, ref_cofr: null })).status, 200);
    assert.equal('ref_cofr' in savedRow(dir, sid), false);
    assert.deepEqual(savedRow(dir, sid).ref_drag_dir, [1, 0, 0]);
  });
});
