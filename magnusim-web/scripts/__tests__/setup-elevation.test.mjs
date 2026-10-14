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
// Setup.ps1 is Windows PowerShell for Windows (Start-Process -Verb RunAs, wsl.exe, DISM):
// its tests run on Windows only. CI's Linux runners have PowerShell 7, where they cannot pass.
const PS = process.platform === 'win32' ? powershell() : null;

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
        `$LogDir = '${dir.replace(/'/g, "''")}'`,
        `Set-Content -LiteralPath (Join-Path $LogDir 'setup-elevated.log') -Value @('**********************', 'Windows PowerShell transcript start', 'Enabling Windows Subsystem for Linux', 'The operation completed successfully.') -Encoding utf8`,
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

describe('Setup asks Windows for Administrator', { skip: PS ? false : 'Setup runs on Windows only' }, () => {
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
    // The Administrator window's own log, shown here once it has closed (not its transcript header).
    assert.match(r.out, /The Administrator window ended \(exit 7\)\. Its last lines/);
    assert.match(r.out, / {4}Enabling Windows Subsystem for Linux\s+ {4}The operation completed successfully\./);
    assert.doesNotMatch(r.out, / {4}Windows PowerShell transcript start/);
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

// Turning WSL on (Ensure-WslUbuntu), run as Setup.ps1 has it against stand-ins for
// wsl.exe, dism.exe, the WSL services, the boot time and Administrator. On a Windows 10
// work laptop Setup asked for a restart after every restart: it took WSL as on only when
// "wsl --status" answered, which Windows 10 does not before a distro is installed.
const STUB_FUNCS = ['Test-Admin', 'Restart-Elevated', 'Get-BootTime', 'Invoke-Record', 'Get-DistroObservation', 'Test-VirtualizationOn'];

/** Ensure-WslUbuntu with the world `w` describes; {status, out, marker}. */
function ensureWsl(w) {
  const dir = mkdtempSync(join(tmpdir(), 'setup-wsl-'));
  try {
    if (w.marker !== undefined) writeFileSync(join(dir, 'reboot-required.txt'), `${String.fromCharCode(0xfeff)}${w.marker}\r\n`);
    const run = join(dir, 'run.ps1');
    const ps = (v) => `'${String(v).replace(/'/g, "''")}'`;
    writeFileSync(
      run,
      [
        '$ErrorActionPreference = "Stop"',
        `$LogDir = ${ps(dir)}`,
        `$LogPath = ${ps(join(dir, 'setup.log'))}`,
        `$errs = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile(${ps(SETUP)}, [ref]$null, [ref]$errs)`,
        `$skip = @(${STUB_FUNCS.map(ps).join(', ')})`,
        "foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {",
        '  if ($skip -notcontains $fn.Name) { . ([scriptblock]::Create($fn.Extent.Text)) }',
        '}',
        `function Test-Admin { ${w.admin ? '$true' : '$false'} }`,
        "function Restart-Elevated([string]$Why) { Write-Output \"ELEVATE $Why\"; exit 5 }",
        `function Get-BootTime { ${ps(w.boot || 'BOOT-NOW')} }`,
        'function Invoke-Record($a) { }',
        'function Get-DistroObservation { }',
        `function Test-VirtualizationOn { ${w.virt === false ? '$false' : '$true'} }`,
        `function Get-Service { param($Name, $ErrorAction) ${w.services ? `@(${w.services.map((s) => `[pscustomobject]@{ Name = ${ps(s)}; Status = 'Stopped' }`).join(', ')})` : '@()'} }`,
        'function wsl.exe {',
        '  $a = $args -join " "',
        '  Write-Output "WSLCALL $a" | Out-Host',
        `  switch -Regex ($a) {`,
        `    '^--status' { $global:LASTEXITCODE = ${w.statusCode ?? 1}; 'status text' }`,
        `    '^--install --no-distribution' { $global:LASTEXITCODE = ${w.installCode ?? 0}; 'install text' }`,
        `    '^--update' { $global:LASTEXITCODE = ${w.updateCode ?? 0}; ${ps(w.updateText ?? 'updated')} }`,
        `    '^--install -d \\S+ --no-launch' { $global:LASTEXITCODE = ${w.noLaunchCode ?? 0}; 'install no-launch text' }`,
        `    '^--install -d \\S+$' { $global:LASTEXITCODE = ${w.launchCode ?? 0}; 'install launch text' }`,
        `    '^-l -q' { $global:LASTEXITCODE = 0; ${ps((w.distros || []).join('\n'))} }`,
        "    default { $global:LASTEXITCODE = 0; '' }",
        '  }',
        '}',
        'function dism.exe {',
        '  $a = $args -join " "',
        '  Write-Output "DISM $a" | Out-Host',
        `  if ($a -match 'get-featureinfo') { if (${ps(w.vmp ?? '')}) { $global:LASTEXITCODE = 0; 'Feature Name : VirtualMachinePlatform'; ${ps(`State : ${w.vmp ?? ''}`)} } else { $global:LASTEXITCODE = 740; 'Elevated permissions are required' }; return }`,
        `  $global:LASTEXITCODE = ${w.dismCode ?? 3010}; 'dism text'`,
        '}',
        'try { $d = Ensure-WslUbuntu; Write-Output "DISTRO $d" } catch { Write-Output ("THROWN " + $_.Exception.Message) }',
      ].join('\r\n'),
    );
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', run], { encoding: 'utf8' });
    let marker = null;
    try {
      marker = readFileSync(join(dir, 'reboot-required.txt'), 'utf8').replace(/^\uFEFF/, '').trim();
    } catch {
      marker = null;
    }
    // Text written while wsl.exe's UTF-16 is read comes out as UTF-16 too.
    return { status: r.status, out: `${r.stdout}${r.stderr}`.split(String.fromCharCode(0)).join(''), marker };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Setup turns WSL on without asking for a restart forever', { skip: PS ? false : 'Setup runs on Windows only' }, () => {
  it("the laptop's state: WSL's service is there but --status fails (no distro yet): it goes on to install Ubuntu", () => {
    const r = ensureWsl({ marker: 'wsl-feature', services: ['LxssManager'], statusCode: 1, distros: [] });
    assert.match(r.out, /ELEVATE install Ubuntu-24\.04 in WSL/);
    assert.doesNotMatch(r.out, /needs a restart/);
    assert.equal(r.status, 5, r.out);
  });

  it('a restart note from before boot times were kept: turns WSL on again (as Administrator), never just "restart"', () => {
    const r = ensureWsl({ marker: 'wsl-feature', statusCode: 1 });
    assert.match(r.out, /ELEVATE turn on the Windows Subsystem for Linux \(WSL\)/);
    assert.equal(r.status, 5, r.out);
  });

  it('as Administrator: wsl --install fails, the Windows features are turned on instead, then one restart (boot noted)', () => {
    const r = ensureWsl({ admin: true, statusCode: 1, installCode: 1, dismCode: 3010, boot: 'BOOT-1' });
    assert.match(r.out, /WSLCALL --install --no-distribution/);
    assert.match(r.out, /DISM \/online \/enable-feature \/featurename:Microsoft-Windows-Subsystem-Linux \/all \/norestart/);
    assert.match(r.out, /DISM \/online \/enable-feature \/featurename:VirtualMachinePlatform \/all \/norestart/);
    assert.match(r.out, /Windows needs a restart to finish turning on WSL\./);
    assert.equal(r.status, 2, r.out);
    assert.equal(r.marker, 'wsl-feature|BOOT-1');
  });

  it('still off after a real restart: stops with what Windows reports and what to ask IT, no new restart', () => {
    const r = ensureWsl({ marker: 'wsl-feature|BOOT-1', boot: 'BOOT-2', statusCode: 1 });
    assert.match(r.out, /THROWN WSL is still not turned on after the restart\. What Windows reports:/);
    assert.match(r.out, /wsl --status \(exit 1\):/);
    assert.match(r.out, /WSL services: none/);
    assert.match(r.out, /To fix:/);
    assert.doesNotMatch(r.out, /ELEVATE|needs a restart/);
  });

  it('not restarted since it was asked: asks for the restart again, nothing else', () => {
    const r = ensureWsl({ marker: 'wsl-feature|BOOT-1', boot: 'BOOT-1', statusCode: 1 });
    assert.match(r.out, /Windows needs a restart to finish turning on WSL \(it has not restarted since\)\./);
    assert.doesNotMatch(r.out, /ELEVATE|DISM/);
    assert.equal(r.status, 2, r.out);
  });

  it('the Windows features cannot be turned on (a policy): says so instead of asking for a restart', () => {
    const r = ensureWsl({ admin: true, statusCode: 1, installCode: 1, dismCode: 5 });
    assert.match(r.out, /THROWN Windows did not turn on Microsoft-Windows-Subsystem-Linux \(DISM exit 5\)/);
    assert.doesNotMatch(r.out, /needs a restart/);
  });

  it("the laptop next: WSL's service is on but Virtual Machine Platform is off: Setup turns it on, then one restart", () => {
    const r = ensureWsl({ admin: true, services: ['LxssManager'], statusCode: -1, vmp: 'Disabled', boot: 'BOOT-1' });
    assert.match(r.out, /DISM \/online \/enable-feature \/featurename:VirtualMachinePlatform \/all \/norestart/);
    assert.match(r.out, /Windows needs a restart to finish turning on Virtual Machine Platform\./);
    assert.doesNotMatch(r.out, /WSLCALL --update|WSLCALL --install/);
    assert.equal(r.status, 2, r.out);
    assert.equal(r.marker, 'vmp|BOOT-1');
  });

  it("then WSL's download is blocked (0x80072efe) and the old wsl.exe cannot install Ubuntu: no restart, it says what to fix", () => {
    const r = ensureWsl({
      admin: true,
      services: ['LxssManager'],
      statusCode: -1,
      vmp: 'Enabled',
      marker: 'vmp|BOOT-1',
      boot: 'BOOT-2',
      updateCode: -1,
      updateText: ['Installing: Windows Subsystem for Linux', 'Error: 0x80072efe'].join('\n'),
      noLaunchCode: -1,
      launchCode: -1,
    });
    assert.match(r.out, /WSLCALL --update/);
    assert.match(r.out, /wsl --update did not finish \(exit -1\): it could not reach Microsoft \(a proxy or firewall\?\)/);
    assert.match(r.out, /THROWN Could not install Ubuntu-24\.04\. What Windows reports:/);
    assert.match(r.out, /wsl --update \(exit -1\): Installing: Windows Subsystem for Linux \/ Error: 0x80072efe/);
    assert.match(r.out, /Virtual Machine Platform: Enabled/);
    assert.match(r.out, /To fix:\s+- Let WSL download its update: .*usually a company proxy or firewall/);
    assert.doesNotMatch(r.out, /needs a restart|Turn on virtualization in the BIOS/);
    assert.equal(r.marker, 'vmp|BOOT-1');
  });

  it('virtualization off in the BIOS is named as the thing to fix', () => {
    const r = ensureWsl({ admin: true, services: ['LxssManager'], statusCode: -1, vmp: 'Enabled', virt: false, noLaunchCode: -1, launchCode: -1 });
    assert.match(r.out, /Virtualization \(BIOS\): off/);
    assert.match(r.out, /- Turn on virtualization in the BIOS\/UEFI settings/);
  });

  it('an install that said it worked but is not listed yet: one restart', () => {
    const r = ensureWsl({ admin: true, services: ['LxssManager'], statusCode: 0, vmp: 'Enabled', noLaunchCode: 0, boot: 'BOOT-3' });
    assert.match(r.out, /Windows needs a restart to finish installing Ubuntu-24\.04\./);
    assert.equal(r.marker, 'ubuntu|BOOT-3');
  });

  it('WSL on and Ubuntu there: carries on, and the restart note goes', () => {
    const r = ensureWsl({ marker: 'ubuntu|BOOT-1', boot: 'BOOT-2', statusCode: 0, distros: ['Ubuntu-24.04'] });
    assert.match(r.out, /DISTRO Ubuntu-24\.04/);
    assert.equal(r.marker, null);
  });
});
