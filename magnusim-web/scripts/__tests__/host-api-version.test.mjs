// The host API version is written in two places, the workspace bridge and the
// Python registry, and documented in docs/plugins/compatibility.md and the
// manifest example in docs/plugins/authoring.md. A bump in one place only would
// tell plugins the wrong version, so all of them must agree.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(APP, rel), 'utf8');

function one(text, re, what) {
  const m = text.match(re);
  assert.ok(m, `${what} not found`);
  return m[1];
}

const bridge = read('src/workspace/bridge.ts');
const hostVersion = one(bridge, /^export const HOST_API_VERSION = '([^']+)';/m, 'HOST_API_VERSION in src/workspace/bridge.ts');
const apiVersion = one(
  read('python/cfddesk/registry/__init__.py'),
  /^API_VERSION = "([^"]+)"/m,
  'API_VERSION in python/cfddesk/registry/__init__.py',
);
const doc = read('docs/plugins/compatibility.md');
const authoring = read('docs/plugins/authoring.md');

describe('host API version', () => {
  it('is a major.minor number', () => {
    assert.match(hostVersion, /^\d+\.\d+$/);
  });

  it('is the same in the workspace bridge and the Python registry', () => {
    assert.equal(hostVersion, apiVersion);
  });

  it('has its own section in docs/plugins/compatibility.md, the newest one', () => {
    const sections = [...doc.matchAll(/^## (\d+\.\d+)\s*$/gm)].map((m) => m[1]);
    assert.ok(sections.includes(hostVersion), `no "## ${hostVersion}" section; sections: ${sections.join(', ')}`);
    assert.equal(sections[0], hostVersion, 'the newest version is listed first');
  });

  it('is the manifest version in docs/plugins/authoring.md', () => {
    const heading = one(authoring, /^## Manifest (\S+)\s*$/m, '"## Manifest" section in docs/plugins/authoring.md');
    assert.equal(heading, hostVersion, `"## Manifest ${heading}" should be "## Manifest ${hostVersion}"`);
    const example = one(
      authoring,
      /^## Manifest .*\r?\n\s*```toml\r?\n([\s\S]*?)```/m,
      'manifest example under "## Manifest" in docs/plugins/authoring.md',
    );
    const declared = one(example, /^api_version = "([^"]*)"/m, 'api_version in the manifest example');
    assert.equal(declared, hostVersion);
  });
});
