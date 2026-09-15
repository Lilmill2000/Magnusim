import { parseJobLine } from '../../scripts/job-runner.js';
import { startSolve, writeSolveCase, parseSolveProgress } from '../../scripts/w27-solve.js';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../scripts/w27-solve.js', import.meta.url), 'utf8');
const checks = {
  hasStart: typeof startSolve === 'function',
  hasWrite: typeof writeSolveCase === 'function', // soft-pass: still present
  hasParse: typeof parseSolveProgress === 'function',
  wiredPrepare: src.includes("pyTool('prepare_run.py')"),
  wiredSpawnJob: src.includes('spawnJob({'),
  wiredRunSolve: src.includes("pyTool('run_solve.py')"),
  keptWriteSolveCase: /export function writeSolveCase/.test(src),
  keptBuildSolveScript: /function buildSolveScript/.test(src),
  magnusimParse: parseJobLine('MAGNUSIM_EVENT {"event":"result","ok":true}'),
  aliasParse: parseJobLine('CFDDESK_EVENT {"event":"stage","stage":"solve"}'),
};
const ok =
  checks.hasStart &&
  checks.hasWrite &&
  checks.wiredPrepare &&
  checks.wiredSpawnJob &&
  checks.wiredRunSolve &&
  checks.keptWriteSolveCase &&
  checks.keptBuildSolveScript &&
  checks.magnusimParse?.event === 'result' &&
  checks.aliasParse?.event === 'stage';
console.log(JSON.stringify({ ok, checks }, null, 2));
if (!ok) process.exit(1);
