// The plugin's version is stated in three places: the manifest (what the host shows and
// the registry lists), heat_transfer/__init__.py (__version__, what a written case
// records) and PLUGIN_VERSION here. They must agree.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_VERSION } from './version';

const ROOT = join(__dirname, '..');

describe('plugin version', () => {
  it('manifest, __version__ and PLUGIN_VERSION agree', () => {
    const manifest = /^version = "([^"]+)"/m.exec(readFileSync(join(ROOT, 'manifest.toml'), 'utf8'))?.[1];
    const python = /^__version__ = "([^"]+)"/m.exec(readFileSync(join(ROOT, 'heat_transfer', '__init__.py'), 'utf8'))?.[1];
    expect(manifest).toBeTruthy();
    expect(python).toBe(manifest);
    expect(PLUGIN_VERSION).toBe(manifest);
  });
});
