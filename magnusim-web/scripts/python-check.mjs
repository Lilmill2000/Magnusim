// The Python checks CI runs (.github/workflows/ci.yml, python job), with the app's own
// Python. `npm run check:py` runs ruff then mypy; `npm run test:py` runs pytest.
// Both are part of `npm test`. Pass step names to pick: node scripts/python-check.mjs mypy
import { spawnSync } from 'node:child_process';
import { PY_ROOT, PYTHON } from './python-env.js';

const STEPS = {
  ruff: ['-m', 'ruff', 'check', 'cfddesk', 'tools', 'tests'],
  mypy: ['-m', 'mypy', 'cfddesk'],
  pytest: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'],
};

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : ['ruff', 'mypy'];
for (const name of names) {
  const args = STEPS[name];
  if (!args) {
    console.error(`unknown step ${name} (have: ${Object.keys(STEPS).join(', ')})`);
    process.exit(2);
  }
  console.log(`> ${name}`);
  const r = spawnSync(PYTHON, args, { cwd: PY_ROOT, stdio: 'inherit', windowsHide: true });
  if (r.error) {
    console.error(`${name}: could not run ${PYTHON}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`${name} failed (exit ${r.status})`);
    process.exit(r.status || 1);
  }
}
