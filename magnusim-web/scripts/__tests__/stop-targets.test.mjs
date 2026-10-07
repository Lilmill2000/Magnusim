// stop.bat ends only this folder's app on its own port (scripts/stop-targets.ps1), fed
// made-up process lists. It once ended other sessions' e2e runs: a snapshot's esbuild,
// reached through a junction to this node_modules, named this folder, and the walk up its
// parents took the snapshot's whole Playwright run with it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(WEB, 'scripts', 'stop-targets.ps1');

/** Windows PowerShell, else PowerShell 7 (pwsh), else none. */
function powershell() {
  for (const exe of process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh']) {
    if (spawnSync(exe, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0) return exe;
  }
  return null;
}
const PS = powershell();

const HERE = 'C:\\Users\\dev\\CFD\\magnusim-web';
const LAUNCHER = 'C:\\Users\\dev\\CFD\\run.bat';
const SNAP = 'C:\\Users\\dev\\AppData\\Local\\Temp\\mwsnap-1\\magnusim-web';

/** Get-StopRoots over `procs` with these listeners on the app's port. */
function roots(procs, listeners) {
  const dir = mkdtempSync(join(tmpdir(), 'stop-targets-'));
  try {
    const data = join(dir, 'procs.json');
    writeFileSync(data, JSON.stringify(procs));
    const run = join(dir, 'run.ps1');
    writeFileSync(
      run,
      [
        `. '${SCRIPT.replace(/'/g, "''")}'`,
        // Windows PowerShell 5.1 hands a JSON array on as one item: unroll it.
        `$procs = @((Get-Content -Raw '${data.replace(/'/g, "''")}' | ConvertFrom-Json) | ForEach-Object { $_ })`,
        `$r = @(Get-StopRoots -Procs $procs -Here '${HERE}' -Listeners @(${listeners.join(',') || ''}) -Launcher '${LAUNCHER}')`,
        `Write-Output ('ROOTS ' + (($r | Sort-Object) -join ','))`,
      ].join('\r\n'),
    );
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', run], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('ROOTS'));
    return line.slice(6).split(',').filter(Boolean).map(Number);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const p = (ProcessId, ParentProcessId, Name, CommandLine) => ({ ProcessId, ParentProcessId, Name, CommandLine });

/** Daniel's app: run.bat (the launcher) -> npm run dev -> cmd /c vite -> vite (port 8082) -> esbuild. */
const app = [
  p(10, 1, 'explorer.exe', 'C:\\WINDOWS\\Explorer.EXE'),
  p(11, 10, 'cmd.exe', `C:\\WINDOWS\\system32\\cmd.exe /c ""${LAUNCHER}" "`),
  p(12, 11, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev'),
  p(13, 12, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c vite --host 127.0.0.1 --strictPort'),
  p(14, 13, 'node.exe', `"node"   "${HERE}\\node_modules\\.bin\\\\..\\vite\\bin\\vite.js" --host 127.0.0.1 --strictPort`),
  p(15, 14, 'esbuild.exe', `${HERE}\\node_modules\\@esbuild\\win32-x64\\esbuild.exe --service=0.25.0 --ping`),
];

/** Another session's e2e run in a snapshot: its esbuild resolves through the junction to HERE. */
const snapshot = [
  p(40, 39, 'node.exe', `"C:\\Program Files\\nodejs\\node.exe" ${SNAP}\\node_modules\\@playwright\\test\\cli.js test e2e/x.spec.js`),
  p(41, 40, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "node e2e/prepare-projects.js && npm run dev"'),
  p(42, 41, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev'),
  p(43, 42, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c vite --host 127.0.0.1 --strictPort'),
  p(44, 43, 'node.exe', `"node"   "${SNAP}\\node_modules\\.bin\\\\..\\vite\\bin\\vite.js" --host 127.0.0.1 --strictPort`),
  p(45, 44, 'esbuild.exe', `${HERE}\\node_modules\\@esbuild\\win32-x64\\esbuild.exe --service=0.25.0 --ping`),
];

/** Another session's e2e server started from this very folder, on a port of its own (8797). */
const sameFolderE2e = [
  p(60, 59, 'node.exe', `"C:\\Program Files\\nodejs\\node.exe" ${HERE}\\node_modules\\@playwright\\test\\cli.js test`),
  p(61, 60, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "node e2e/prepare-projects.js && npm run dev"'),
  p(62, 61, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev'),
  p(63, 62, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c vite --host 127.0.0.1 --strictPort'),
  p(64, 63, 'node.exe', `"node"   "${HERE}\\node_modules\\.bin\\\\..\\vite\\bin\\vite.js" --host 127.0.0.1 --strictPort`),
];

describe('stop.bat targets', { skip: PS ? false : 'no PowerShell here (stop.bat runs on Windows)' }, () => {
  it("ends the app on its port from the top of run.bat's chain, and nothing of a snapshot or another folder's server", () => {
    assert.deepEqual(roots([...app, ...snapshot, ...sameFolderE2e], [14]), [11]);
  });

  it("a snapshot's esbuild that names this folder (a junction) is never a target, nor its Playwright run", () => {
    assert.deepEqual(roots([...snapshot], []), []);
    // Even when the snapshot listens on the app's port, it is not this folder's Vite.
    assert.deepEqual(roots([...snapshot], [44]), []);
  });

  it("this folder's e2e server on another port stays: only the port's listener is the app", () => {
    assert.deepEqual(roots([...sameFolderE2e], []), []);
    assert.deepEqual(roots([...app, ...sameFolderE2e], [14]), [11]);
  });

  it('a plugin case relay (run_foam_case.py) is never a target, even naming this folder and Vite (H15)', () => {
    const relay = [
      p(90, 1, 'node.exe', `"node" "${HERE}\python\tools\run_foam_case.py" --spec ${HERE}\.cache\vite\bin\vite.js`),
      p(91, 1, 'python.exe', `"${HERE}\python\.venv\Scripts\python.exe" "${HERE}\python\tools\run_foam_case.py" --spec x.json`),
    ];
    assert.deepEqual(roots(relay, [90, 91]), []);
  });

  it('the walk stops at what is not its own wrapper: an agent shell, Explorer, another folder with a similar name', () => {
    const agent = [
      p(70, 1, 'powershell.exe', 'powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive -File C:\\t\\ps-script-1.ps1'),
      p(71, 70, 'cmd.exe', `cmd.exe /d /c "${HERE}\\run.bat"`),
      p(72, 71, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev'),
      p(73, 72, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c vite --host 127.0.0.1 --strictPort'),
      p(74, 73, 'node.exe', `"node"   "${HERE}\\node_modules\\.bin\\\\..\\vite\\bin\\vite.js" --host 127.0.0.1 --strictPort`),
    ];
    assert.deepEqual(roots(agent, [74]), [71]);
    const sibling = [p(80, 1, 'node.exe', `"node" "${HERE}-old\\node_modules\\vite\\bin\\vite.js"`)];
    assert.deepEqual(roots(sibling, [80]), []);
  });
});
