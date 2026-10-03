// Build the workspace: the page (vite.config.ts) and every worker module (below).
//   node scripts/build.mjs          build into workspace/
//   node scripts/build.mjs --check  build into .cache/build-check/ and compare
//                                   byte for byte with workspace/ (CI: the
//                                   committed workspace/ must be reproducible)
// Only files this script generates are removed or compared; the kernel and
// solver artifacts in workspace/kernel/ and workspace/solver/ come from
// kernel-build/ and solver-build/.
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { acquireLock } from './lock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const OUT = check ? join(ROOT, '.cache', 'build-check') : join(ROOT, 'workspace');

/**
 * Worker modules started with ws.spawnWorker(). Each is one self-contained ES
 * module (no bare imports: import maps do not apply inside workers). Areas add
 * their worker here (VIEWPORT: the picking worker; P3: the solver worker).
 */
export const WORKERS = [
  { entry: 'src/kernel-worker/kernel-worker.ts', out: 'kernel/kernel-worker.js' },
  // VIEWPORT: builds picking BVHs off the main thread (three-mesh-bvh).
  { entry: 'src/viewport/pick-worker.ts', out: 'pick/pick-worker.js' },
  // P3-SKETCH: the sketch solver (PlaneGCS), next to planegcs.mjs/.wasm in workspace/solver/.
  { entry: 'src/solver-worker/solver-worker.mjs', out: 'solver/solver-worker.js' },
];

/** Everything the page build writes (relative to the output folder). */
const PAGE_OUTPUTS = ['index.html', 'app.js', 'app.css', 'chunks', 'assets'];

function clean() {
  if (check) rmSync(OUT, { recursive: true, force: true });
  for (const p of [...PAGE_OUTPUTS, ...WORKERS.map((w) => w.out)]) rmSync(join(OUT, p), { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
}

async function buildPage() {
  await build({ configFile: join(ROOT, 'vite.config.ts'), root: join(ROOT, 'src'), build: { outDir: OUT } });
}

async function buildWorker({ entry, out }) {
  await build({
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    publicDir: false,
    esbuild: { legalComments: 'none' },
    build: {
      outDir: join(OUT, dirname(out)),
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: false,
      minify: 'esbuild',
      reportCompressedSize: false,
      lib: { entry: join(ROOT, entry), formats: ['es'], fileName: () => out.split('/').pop() },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}

function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

function generated(dir) {
  const outs = new Set(WORKERS.map((w) => w.out));
  return listFiles(dir).filter((f) => outs.has(f) || PAGE_OUTPUTS.some((p) => f === p || f.startsWith(p + '/')));
}

// One writer of workspace/ at a time. scripts/e2e.mjs holds this lock for its
// whole run (build + tests) and tells its own child build so.
const heldByParent = process.env.CAD_BUILD_LOCK_HELD && Number(process.env.CAD_BUILD_LOCK_HELD) === process.ppid;
const release = check || heldByParent ? () => {} : await acquireLock(join(ROOT, '.cache', 'build.lock'), 600_000);
try {
  clean();
  await buildPage();
  for (const w of WORKERS) await buildWorker(w);
} finally {
  release();
}

if (check) {
  const built = generated(OUT).sort();
  const committed = generated(join(ROOT, 'workspace')).sort();
  const problems = [];
  for (const f of new Set([...built, ...committed])) {
    const a = join(OUT, f);
    const b = join(ROOT, 'workspace', f);
    if (!existsSync(b)) problems.push(`missing in workspace/: ${f}`);
    else if (!existsSync(a)) problems.push(`not produced by the build: ${f}`);
    else if (!readFileSync(a).equals(readFileSync(b))) problems.push(`differs: ${f}`);
  }
  if (problems.length) {
    console.error(`workspace/ is not the build of src/ (run npm run build):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`workspace/ matches the build (${built.length} files)`);
} else {
  console.log(`built ${generated(OUT).length} files into workspace/`);
}
