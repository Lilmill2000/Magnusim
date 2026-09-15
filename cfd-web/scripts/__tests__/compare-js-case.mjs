/**
 * Assert writeSolveCase / transient output matches golden fixtures.
 * Wired into npm test / CI — fails when writer output drifts.
 *
 * Hermetic: builds a synthetic `ready` + tiny polyMesh (no live sample / WSL).
 * Usage: node scripts/__tests__/compare-js-case.mjs
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '../..');
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
      if (/^\/\*|\*$/.test(s) && [...s].every((c) => '/* '.includes(c))) return false;
      if (/Date:/i.test(line) || /timestamp/i.test(line)) return false;
      return true;
    })
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim() + '\n';
}

function writeTinyPolyMesh(dir) {
  mkdirSync(dir, { recursive: true });
  // Minimal files so cpSync has a polyMesh; writer uses ready.mesh.patches for names.
  writeFileSync(
    join(dir, 'boundary'),
    `FoamFile
{
    version     2.0;
    format      ascii;
    class       polyBoundaryMesh;
    object      boundary;
}
3
(
    walls
    {
        type            wall;
        nFaces          1;
        startFace       0;
    }
    velocity_inlet_1
    {
        type            patch;
        nFaces          1;
        startFace       1;
    }
    pressure_1
    {
        type            patch;
        nFaces          1;
        startFace       2;
    }
)
`,
    'utf8',
  );
  writeFileSync(join(dir, 'points'), 'FoamFile { version 2.0; format ascii; class vectorField; object points; }\n0\n()\n', 'utf8');
  writeFileSync(join(dir, 'faces'), 'FoamFile { version 2.0; format ascii; class faceList; object faces; }\n0\n()\n', 'utf8');
  writeFileSync(join(dir, 'owner'), 'FoamFile { version 2.0; format ascii; class labelList; object owner; }\n0\n()\n', 'utf8');
  writeFileSync(join(dir, 'neighbour'), 'FoamFile { version 2.0; format ascii; class labelList; object neighbour; }\n0\n()\n', 'utf8');
}

function collectCaseGoldens(caseDir) {
  const out = {};
  for (const root of [join(caseDir, 'system'), join(caseDir, 'constant'), join(caseDir, '0')]) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (!GOLDEN_NAMES.has(name)) continue;
      const src = join(root, name);
      if (!statSync(src).isFile()) continue;
      out[name] = normalize(readFileSync(src, 'utf8'));
    }
  }
  return out;
}

function assertMatchesGolden(gotMap, goldenDir, label) {
  if (!existsSync(goldenDir)) throw new Error(`missing golden dir ${goldenDir}`);
  const names = readdirSync(goldenDir).filter((n) => GOLDEN_NAMES.has(n));
  if (names.length < 5) throw new Error(`${label}: golden dir too sparse (${names.length})`);
  const missing = [];
  const mismatched = [];
  for (const name of names) {
    const want = normalize(readFileSync(join(goldenDir, name), 'utf8'));
    const got = gotMap[name];
    if (got == null) {
      missing.push(name);
      continue;
    }
    if (got !== want) mismatched.push(name);
  }
  if (missing.length || mismatched.length) {
    const detail = [
      missing.length ? `missing: ${missing.join(',')}` : null,
      mismatched.length ? `mismatch: ${mismatched.join(',')}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    throw new Error(`${label} golden assert failed — ${detail}`);
  }
  return names.length;
}

function buildReady(polyMeshPath) {
  // Face 10 area matches sample cad_preview (mm² → m²) used when goldens were captured.
  const faceProps = {
    'face 10@Body1': {
      area: 0.002026829916389991,
      centroid: [0.127, 0.09389807552983325, 0.2794],
      normal: [1, 0, 0],
    },
  };
  const inletBc = {
    id: 'bc-inlet',
    name: 'Velocity inlet 1',
    bc_type: 'Velocity inlet',
    faces: ['face 10@Body1'],
    face: 'face 10@Body1',
    velocity_type: 'Fixed',
    value: 50,
    unit: 'm/s',
    direction: 'Normal to face',
    vector: [0, 0, 1],
  };
  const pressureBc = {
    id: 'bc-pressure',
    name: 'Pressure 1',
    bc_type: 'Pressure',
    faces: ['face 13@Body1'],
    face: 'face 13@Body1',
    pressure_type: 'Fixed value',
    value: 0,
    unit: 'Pa',
  };
  return {
    ok: true,
    project_id: 'js-golden-fixture',
    mesh: {
      mesh_path: polyMeshPath,
      case_dir: dirname(dirname(polyMeshPath)),
      patches: [
        { name: 'walls', type: 'wall' },
        { name: 'velocity_inlet_1', type: 'patch' },
        { name: 'pressure_1', type: 'patch' },
      ],
      n_cells: 1000,
      n_points: 100,
      bounds: [0, 0.1, 0, 0.1, 0, 0.1],
    },
    air: { nu: 0.00001529, rho: 1.196, assigned: true },
    mapped: [
      { bc: pressureBc, patch: 'pressure_1' },
      { bc: inletBc, patch: 'velocity_inlet_1' },
    ],
    wallDefault: 'No-slip',
    aa: null,
    faceProps,
  };
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'cfddesk-js-compare-'));
  const polyMesh = join(work, 'polyMesh');
  writeTinyPolyMesh(polyMesh);
  const ready = buildReady(polyMesh);

  const w27 = await import('../w27-solve.js');
  const { TRANSIENT_DEFAULTS, normalizeTransient, resolveTransientControl } = await import('../w30-transient.js');

  // --- steady ---
  const steadyOut = join(work, 'out_steady');
  mkdirSync(steadyOut, { recursive: true });
  w27.writeSolveCase(steadyOut, ready, {
    endTime: 200,
    writeInterval: 50,
    nProcs: 1,
    transient: null,
  });
  const steadyGot = collectCaseGoldens(steadyOut);
  const nSteady = assertMatchesGolden(steadyGot, join(GOLDEN_ROOT, 'js_steady'), 'js_steady');

  // --- transient (same deltaT path as capture: no mesh estimate → writeInterval/100) ---
  const transient = normalizeTransient(TRANSIENT_DEFAULTS);
  const ctrl = resolveTransientControl(transient, {});
  const transOut = join(work, 'out_transient');
  mkdirSync(transOut, { recursive: true });
  w27.writeSolveCase(transOut, ready, {
    endTime: transient.end_time,
    writeInterval: 50,
    nProcs: 1,
    transient: ctrl,
  });
  const transGot = collectCaseGoldens(transOut);
  const nTrans = assertMatchesGolden(transGot, join(GOLDEN_ROOT, 'js_transient'), 'js_transient');

  console.log('COMPARE OK', { nSteady, nTrans, work });
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* tmp leftover ok */
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
