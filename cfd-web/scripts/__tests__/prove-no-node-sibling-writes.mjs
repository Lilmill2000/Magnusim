/**
 * Phase 2 land14 prove:
 * 1) Guard PASS on clean scripts tree
 * 2) Guard FAIL when --scan planted forbidden fixture
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const guard = join(__dirname, 'test_no_node_sibling_writes.js');
const plant = join(__dirname, 'fixtures', 'land14-forbidden-write.plant.js');

function run(args) {
  const r = spawnSync(process.execPath, [guard, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: r.status == null ? 1 : r.status,
    out: String(r.stdout || ''),
    err: String(r.stderr || ''),
  };
}

const clean = run([]);
if (clean.status !== 0) {
  console.error('FAIL prove: clean tree should PASS');
  console.error(clean.err || clean.out);
  process.exit(1);
}
console.log('ok: clean tree PASS');

const planted = run(['--scan', plant]);
if (planted.status === 0) {
  console.error('FAIL prove: planted forbidden write should FAIL guard');
  console.error(planted.out);
  process.exit(1);
}
if (!/FAIL Phase 2 land14/.test(planted.err + planted.out)) {
  console.error('FAIL prove: expected land14 FAIL banner');
  console.error(planted.err || planted.out);
  process.exit(1);
}
console.log('ok: planted forbidden pattern FAIL (as required)');
console.log('PASS land14 prove: lint fails on forbidden sibling write plant; clean tree green');
