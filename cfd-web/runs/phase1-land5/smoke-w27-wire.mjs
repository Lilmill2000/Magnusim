import { parseJobLine } from '../../scripts/job-runner.js';
import { startSolve, writeSolveCase } from '../../scripts/w27-solve.js';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../scripts/w27-solve.js', import.meta.url), 'utf8');
const checks = {
  hasStart: typeof startSolve === 'function',
  hasWrite: typeof writeSolveCase === 'function', // soft-pass: still present (goldens need rewire)
  wiredPrepare: src.includes("pyTool('prepare_run.py')"),
  wiredSpawnJob: src.includes('spawnJob({'),
  wiredRunSolve: src.includes("pyTool('run_solve.py')"),
  wslCaseIdSegment: /const wslCaseId = `cfddesk-w27-\$\{runId\}`/.test(src),
  passesIdNotPath: /'--wsl-case',\s*\n\s*wslCaseId/.test(src) || /'--wsl-case',\s*wslCaseId/.test(src),
  keptWriteSolveCase: /export function writeSolveCase/.test(src),
  magnusimParse: parseJobLine('MAGNUSIM_EVENT {"event":"result","ok":true}'),
};
const ok =
  checks.hasStart &&
  checks.hasWrite &&
  checks.wiredPrepare &&
  checks.wiredSpawnJob &&
  checks.wiredRunSolve &&
  checks.wslCaseIdSegment &&
  checks.passesIdNotPath &&
  checks.keptWriteSolveCase &&
  checks.magnusimParse?.event === 'result';
console.log(JSON.stringify({ ok, checks }, null, 2));
if (!ok) process.exit(1);
