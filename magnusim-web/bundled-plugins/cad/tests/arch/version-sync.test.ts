// The plugin's version is stated in four places: the manifest (what the host shows and the
// registry lists), package.json and its lock, and PLUGIN_VERSION (what a saved Part records
// as written_by). They must agree.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_VERSION } from '../../src/doc/schema';

const ROOT = join(__dirname, '..', '..');

describe('plugin version', () => {
  it('manifest, package.json, package-lock.json and PLUGIN_VERSION agree', () => {
    const manifest = /^version = "([^"]+)"/m.exec(readFileSync(join(ROOT, 'manifest.toml'), 'utf8'))?.[1];
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
    expect(manifest).toBeTruthy();
    expect(pkg).toBe(manifest);
    expect(lock.version).toBe(manifest);
    expect(lock.packages[''].version).toBe(manifest);
    expect(PLUGIN_VERSION).toBe(manifest);
  });
});
