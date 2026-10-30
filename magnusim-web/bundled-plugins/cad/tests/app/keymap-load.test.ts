// @vitest-environment node
// The build reads the keybinding registry without Node's type stripping (review: on Node 22.12 to
// 22.17, which the app's engines allowed then, an import of keymap.ts failed and the build stopped before
// workspace/commands.json): scripts/keymap-load.mjs, run here with type stripping turned off,
// gives the registry the build writes.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { commandsJson } from '../../src/app/keymap';

describe('the build loads the keybinding registry without type stripping', () => {
  it('scripts/keymap-load.mjs gives the registry where a plain .ts import is refused', () => {
    const run = (code: string) => spawnSync(process.execPath, ['--no-experimental-strip-types', '--input-type=module', '-e', code], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });
    const plain = run("import('./src/app/keymap.ts').then(() => console.log('loaded'), (e) => console.log(e.code))");
    expect(plain.stdout.trim()).toBe('ERR_UNKNOWN_FILE_EXTENSION');
    const loaded = run("const { loadKeymap } = await import('./scripts/keymap-load.mjs'); const k = await loadKeymap('keymap-test'); process.stdout.write(k.commandsJson());");
    expect(loaded.stderr).not.toMatch(/Error/);
    expect(loaded.stdout).toBe(commandsJson());
  });
});
