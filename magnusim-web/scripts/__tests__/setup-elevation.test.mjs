// Setup.ps1 asks Windows for Administrator (Restart-Elevated) only on a PC that
// lacks long paths or WSL, so a PC that already has them never runs it. It once
// failed on every such PC: a blank line after a backtick continuation ended the
// Start-Process line, and "-Verb" ran as a command ("The term '-Verb' is not
// recognized"). Here the function runs as Setup.ps1 has it, with Start-Process
// replaced by a stand-in, so no prompt ever shows.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETUP = join(WEB, 'setup', 'Setup.ps1');

/** Windows PowerShell, else PowerShell 7 (pwsh), else none. */
function powershell() {
  for (const exe of process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh']) {
    if (spawnSync(exe, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0) return exe;
  }
  return null;
}
const PS = powershell();

/** Run Restart-Elevated from Setup.ps1 with `startProcess` standing in for Start-Process. */
function elevate(startProcess) {
  const dir = mkdtempSync(join(tmpdir(), 'setup-elevation-'));
  try {
    const run = join(dir, 'run.ps1');
    writeFileSync(
      run,
      [
        '$ErrorActionPreference = "Stop"',
        `$errs = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile('${SETUP.replace(/'/g, "''")}', [ref]$null, [ref]$errs)`,
        'if ($errs.Count) { throw "Setup.ps1 does not parse: $($errs[0].Message)" }',
        "$fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Restart-Elevated' }, $true) | Select-Object -First 1",
        'if (-not $fn) { throw "no Restart-Elevated in Setup.ps1" }',
        'function Start-Process {',
        startProcess,
        '}',
        '$Plugins = $true',
        '. ([scriptblock]::Create($fn.Extent.Text))',
        'try { Restart-Elevated "turn on Windows long paths" } catch { Write-Output ("THROWN " + $_.Exception.Message) }',
      ].join('\r\n'),
    );
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', run], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Setup asks Windows for Administrator', { skip: PS ? false : 'no PowerShell here (Setup runs on Windows)' }, () => {
  it('starts itself elevated (RunAs, waiting for it) with -Elevated and -Plugins, and ends with its exit code', () => {
    const r = elevate(
      [
        '  param($FilePath, $Verb, $ArgumentList, [switch]$Wait, [switch]$PassThru)',
        '  [Console]::Out.WriteLine("VERB=$Verb WAIT=$Wait PASSTHRU=$PassThru FILE=$(Split-Path -Leaf $FilePath)")',
        '  [Console]::Out.WriteLine("ARGS=$ArgumentList")',
        '  [pscustomobject]@{ ExitCode = 7 }',
      ].join('\r\n'),
    );
    assert.doesNotMatch(r.out, /is not recognized/);
    assert.match(r.out, /Windows needs Administrator once to turn on Windows long paths\./);
    assert.match(r.out, /VERB=RunAs WAIT=True PASSTHRU=True FILE=powershell\.exe/);
    // The script's own path ($PSCommandPath: empty here, where the function is loaded on its own).
    assert.match(r.out, /ARGS=-NoProfile -ExecutionPolicy Bypass -File "[^"]*" -Elevated -Plugins/);
    assert.equal(r.status, 7, r.out);
  });

  it('a refused prompt says what it was for and what to do, on a work PC too', () => {
    const r = elevate("  throw 'The operation was canceled by the user.'");
    assert.match(r.out, /THROWN Windows did not give Setup Administrator rights \(The operation was canceled by the user\.\)/);
    assert.match(r.out, /Setup needs them once to turn on Windows long paths\./);
    assert.match(r.out, /ask IT to run Setup\.bat as Administrator once/);
  });
});

describe('PowerShell scripts', () => {
  it('no backtick line continuation is followed by a blank line (it ends the command there)', () => {
    const files = execFileSync('git', ['ls-files', '*.ps1', '*.psm1'], { cwd: join(WEB, '..'), encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    assert.ok(files.some((f) => f.endsWith('setup/Setup.ps1')), files.join(', '));
    const bad = [];
    for (const rel of files) {
      const lines = readFileSync(join(WEB, '..', rel), 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/`\s*$/.test(line) && i + 1 < lines.length && /^\s*$/.test(lines[i + 1])) bad.push(`${rel}:${i + 1}`);
      });
    }
    assert.deepEqual(bad, []);
  });
});
