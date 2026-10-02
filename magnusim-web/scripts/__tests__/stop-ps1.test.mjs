// H15: stop.bat leaves plugin cases running: a relay is never a seed of the Vite tree it kills.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(HERE, '..', '..', 'stop.ps1'), 'utf8').replace(/\r\n/g, '\n');

describe('stop.ps1 seed loop', () => {
  it('its first test skips run_foam_case.py command lines', () => {
    const start = text.indexOf('$cl = [string]$_.CommandLine');
    assert.ok(start > 0, 'the seed loop reads each command line');
    const loop = text.slice(start, text.indexOf('\n}', start));
    const tests = loop.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('if '));
    assert.ok(tests.length >= 2, loop);
    assert.equal(tests[0], "if ($cl -match 'run_foam_case\\.py') { return }");
    // It comes before the test that makes a Vite-like command line a seed.
    assert.ok(loop.indexOf('run_foam_case') < loop.indexOf('(vite|@esbuild)'));
  });
});
