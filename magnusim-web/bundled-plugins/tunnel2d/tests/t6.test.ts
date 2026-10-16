// T6: the shortcuts the help lists are the README's, and capture file names.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHORTCUTS } from '../src/app/shortcuts';
import { captureName } from '../src/app/capture';
import { gpuHelp } from '../src/app/gpuHelp';

describe('the keyboard shortcuts', () => {
  it("the README's table lists each one the help shows, and no other", () => {
    const md = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    const section = md.slice(md.indexOf('## Keyboard shortcuts'), md.indexOf('## Requirements'));
    const rows = section
      .split(/\r?\n/)
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Keys') && !l.startsWith('|---'))
      .map((l) => l.split('|')[1].trim());
    expect(rows.sort()).toEqual(SHORTCUTS.map((s) => s.keys).sort());
  });
});

describe('capture file names', () => {
  it('say what they are and when they were made', () => {
    expect(captureName('png', new Date(2026, 9, 14, 9, 5, 7))).toBe('tunnel-2026-10-14-0905-07.png');
    expect(captureName('webm', new Date(2026, 0, 2, 23, 59, 0))).toBe('tunnel-2026-01-02-2359-00.webm');
  });
});

describe('when the browser gives no GPU', () => {
  const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
  const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';
  const SOFT = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';

  it('graphics acceleration off: the setting and where it is, for the browser in use', () => {
    const e = gpuHelp(EDGE, SOFT);
    expect(e.cause).toBe('acceleration-off');
    expect(e.title).toBe('Graphics acceleration is turned off in this browser');
    expect(e.body).toContain('edge://settings/system');
    expect(e.body).toContain('"Use graphics acceleration when available"');
    expect(e.body).toContain('run.bat');
    expect(gpuHelp(CHROME, SOFT).body).toContain('chrome://settings/system');
    expect(gpuHelp(FIREFOX, 'Microsoft Basic Render Driver').body).toContain('Use hardware acceleration when available');
    // No WebGL at all: acceleration off too.
    expect(gpuHelp(EDGE, null).cause).toBe('acceleration-off');
  });

  it('a GPU the browser draws with but will not use for WebGPU: the driver and the GPU page', () => {
    const h = gpuHelp(EDGE, 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0, D3D11)');
    expect(h.cause).toBe('no-adapter');
    expect(h.body).toContain('edge://gpu');
  });
});
