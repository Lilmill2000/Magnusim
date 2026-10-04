// Stands in for the Python interpreter in node tests that start meshes and runs without
// a toolchain: the test sets MAGNUSIM_PYTHON to node and NODE_OPTIONS to
// `--import=<this file>`, so `node <tool>.py args...` runs this module first, and it
// exits before node would read the .py file.
//   generate_*.py      waits while $FAKE_PY_HOLD exists, then writes a small polyMesh and
//                      w21-counts.json into --case-dir and exits 0 (a done mesh); with
//                      --input-shape-sha256 its result reports the input it built
//                      (body1_sha256 'f' x 64, mesh_input_built), as prepare_input does
//   convert_step_to_stl.py  writes --out (a 120-byte STL) and exits 0
//   prepare_run.py     prints {"ok":false,"error":"fake prepare_run"} and exits 1
//   anything else      exits 3
import { existsSync, mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

const [, script = '', ...args] = process.argv;
const tool = basename(script);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (/^generate_.*\.py$/.test(tool)) {
    const hold = process.env.FAKE_PY_HOLD || '';
    const until = Date.now() + 60_000;
    while (hold && existsSync(hold) && Date.now() < until) await sleep(50);
    const caseDir = arg('--case-dir');
    const poly = join(caseDir, 'constant', 'polyMesh');
    mkdirSync(poly, { recursive: true });
    for (const name of ['points', 'faces', 'owner', 'neighbour', 'boundary']) writeFileSync(join(poly, name), `${name}\n`);
    const counts = { n_cells: 8, n_points: 27, n_faces: 36, generate_id: arg('--generate-id'), source: 'fake' };
    writeFileSync(join(caseDir, 'w21-counts.json'), JSON.stringify(counts));
    writeFileSync(join(caseDir, 'log.standard_generate.txt'), 'MESH_SCRIPT_OK\n');
    const built = args.includes('--input-shape-sha256') ? { body1_sha256: 'f'.repeat(64), mesh_input_built: true } : {};
    writeSync(1, `CFMESH_RESULT ${JSON.stringify({ ok: true, ...counts, ...built })}\n`);
    return 0;
  }
  if (tool === 'convert_step_to_stl.py') {
    const out = arg('--out');
    writeFileSync(out, Buffer.concat([Buffer.from('solid fake\n'), Buffer.alloc(120, 32)]));
    writeFileSync(out.replace(/\.stl$/i, '.json'), JSON.stringify({ cad_quality: true, bounds: { ntri: 9000 }, from: args.includes('--from-vtp') ? arg('--from-vtp') : arg('--step') }));
    return 0;
  }
  if (tool === 'prepare_run.py') {
    writeSync(1, `${JSON.stringify({ ok: false, error: 'fake prepare_run' })}\n`);
    return 1;
  }
  return 3;
}

// Written with writeSync: process.exit does not wait for a piped stdout.
process.exit(await main());
