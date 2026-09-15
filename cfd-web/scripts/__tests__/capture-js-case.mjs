/**
 * Dev-only: capture w27/w30 case writer output into Python golden fixtures.
 * Usage: node scripts/__tests__/capture-js-case.mjs
 *
 * Uses CFDDESK_PROJECTS_ROOT against a copied sample project (with polyMesh).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '../..');
const SAMPLE_ID = 'sample-project-steady-state-20260914220621-a75ad1';
const SAMPLE_SRC = join(WEB_ROOT, 'projects', SAMPLE_ID);
const GOLDEN_ROOT = join(WEB_ROOT, 'python', 'tests', 'fixtures', 'golden');

const GOLDEN_NAMES = new Set([
  'controlDict', 'fvSchemes', 'fvSolution',
  'transportProperties', 'turbulenceProperties',
  'U', 'p', 'k', 'omega', 'nut', 'epsilon', 'T',
]);

function normalize(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => {
      const s = line.trim();
      if (s.startsWith('// *') || /^\/\*|\*\/$/.test(s)) return false;
      if (/^\/\*|\*$/.test(s) && setOfStars(s)) return false;
      if (/Date:/i.test(line) || /timestamp/i.test(line)) return false;
      return true;
    })
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim() + '\n';
}

function setOfStars(s) {
  return [...s].every((c) => '/* '.includes(c));
}

function copyGoldenFromCase(caseDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  const roots = [
    join(caseDir, 'system'),
    join(caseDir, 'constant'),
    join(caseDir, '0'),
  ];
  let n = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (!GOLDEN_NAMES.has(name)) continue;
      const src = join(root, name);
      if (!statSync(src).isFile()) continue;
      const text = normalize(readFileSync(src, 'utf8'));
      writeFileSync(join(outDir, name), text, 'utf8');
      n += 1;
      console.log('wrote', join(outDir, name).replace(WEB_ROOT + '\\', '').replace(WEB_ROOT + '/', ''));
    }
  }
  return n;
}

function stageProjectsRoot() {
  if (!existsSync(SAMPLE_SRC)) {
    throw new Error(`Sample project missing: ${SAMPLE_SRC}`);
  }
  const root = mkdtempSync(join(tmpdir(), 'cfddesk-js-capture-'));
  const dest = join(root, SAMPLE_ID);
  console.log('Staging sample ->', dest);
  // Copy essentials + polyMesh (needed by writeSolveCase)
  mkdirSync(dest, { recursive: true });
  for (const f of [
    'project.json', 'materials.json', 'boundary_conditions.json', 'mesh.json',
    'simulation.json', 'simulation_control.json',
  ]) {
    const src = join(SAMPLE_SRC, f);
    if (existsSync(src)) cpSync(src, join(dest, f));
  }
  // geometry preview (face props)
  const geoSrc = join(SAMPLE_SRC, 'geometry');
  if (existsSync(geoSrc)) {
    cpSync(geoSrc, join(dest, 'geometry'), {
      recursive: true,
      filter: (src) => {
        const base = src.replace(/\\/g, '/');
        // skip large VTPs / step optional for solve writer — keep cad_preview.json + step
        if (/\.(vtp|vtu|png|stl)$/i.test(base)) return false;
        return true;
      },
    });
  }
  // mesh run polyMesh only
  const meshRun = join(SAMPLE_SRC, 'mesh', 'run-b7cb1aa8');
  if (!existsSync(join(meshRun, 'constant', 'polyMesh'))) {
    throw new Error(`polyMesh missing under ${meshRun}`);
  }
  mkdirSync(join(dest, 'mesh', 'run-b7cb1aa8', 'constant'), { recursive: true });
  cpSync(join(meshRun, 'constant', 'polyMesh'), join(dest, 'mesh', 'run-b7cb1aa8', 'constant', 'polyMesh'), { recursive: true });
  // copy any mesh sidecar json next to run if present
  for (const f of readdirSync(meshRun)) {
    const p = join(meshRun, f);
    if (statSync(p).isFile() && f.endsWith('.json')) {
      cpSync(p, join(dest, 'mesh', 'run-b7cb1aa8', f));
    }
  }
  // minimal runs catalog
  mkdirSync(join(dest, 'runs'), { recursive: true });
  writeFileSync(
    join(dest, 'runs', 'catalog.json'),
    JSON.stringify({ version: 1, active_id: null, runs: [] }, null, 2) + '\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'active.json'),
    JSON.stringify({ project_id: SAMPLE_ID, updated_at: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  return { root, projectId: SAMPLE_ID };
}

async function main() {
  const { root, projectId } = stageProjectsRoot();
  process.env.CFDDESK_PROJECTS_ROOT = root;

  // Dynamic import AFTER env is set (modules read PROJECTS_ROOT at load time)
  const w27 = await import('../w27-solve.js');
  const { TRANSIENT_DEFAULTS, normalizeTransient, resolveTransientControl } = await import('../w30-transient.js');

  const ready = w27.validateSolveReady(projectId, {});
  if (!ready.ok) {
    console.error('validateSolveReady failed', ready);
    process.exit(1);
  }
  console.log('ready ok; n_cells', ready.mesh && ready.mesh.n_cells, 'patches', (ready.mesh.patches || []).length);

  // --- steady ---
  const steadyOut = join(root, '_out_steady');
  mkdirSync(steadyOut, { recursive: true });
  w27.writeSolveCase(steadyOut, ready, {
    endTime: 200,
    writeInterval: 50,
    nProcs: 1,
    transient: null,
  });
  const nSteady = copyGoldenFromCase(steadyOut, join(GOLDEN_ROOT, 'js_steady'));
  if (nSteady < 5) throw new Error(`js_steady too few files: ${nSteady}`);

  // --- transient ---
  const transient = normalizeTransient(TRANSIENT_DEFAULTS);
  const ctrl = resolveTransientControl
    ? resolveTransientControl(ready, transient)
    : transient;
  const transOut = join(root, '_out_transient');
  mkdirSync(transOut, { recursive: true });
  w27.writeSolveCase(transOut, ready, {
    endTime: transient.end_time,
    writeInterval: 50,
    nProcs: 1,
    transient: ctrl || transient,
  });
  const nTrans = copyGoldenFromCase(transOut, join(GOLDEN_ROOT, 'js_transient'));
  if (nTrans < 5) throw new Error(`js_transient too few files: ${nTrans}`);

  console.log('CAPTURE OK', { nSteady, nTrans, projectsRoot: root });
  // leave temp for debugging; OS will clean tmp
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
