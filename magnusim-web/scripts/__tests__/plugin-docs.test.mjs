// npm run gen:plugin-docs(:check) (scripts/gen-plugin-docs.mjs) and npm run test:docs
// (scripts/doc-tests.mjs): the reference is generated from the code and checked, and
// every code block tagged `test` runs, failing when its code is wrong.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { codeBlocks, runBlock, runFiles, testBlocks } from '../doc-tests.mjs';
import { dtsExports, generate, pythonFacts } from '../gen-plugin-docs.mjs';
import { WEB_ROOT } from '../python-env.js';

const TMP = mkdtempSync(join(tmpdir(), 'magnusim-plugin-docs-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const DOCS = join(WEB_ROOT, 'docs', 'plugins');
const GEN = join(WEB_ROOT, 'scripts', 'gen-plugin-docs.mjs');

const block = (lang, code) => ({ lang, tags: [lang, 'test'], code, line: 1 });

describe('the generated reference', () => {
  test('API.md and manifest.schema.json in docs/plugins are up to date (gate:h16-docs-in-sync)', () => {
    const r = spawnSync(process.execPath, [GEN, '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('--check fails on a stale file, and writing makes it pass', () => {
    const w = spawnSync(process.execPath, [GEN, '--out-dir', TMP], { encoding: 'utf8' });
    assert.equal(w.status, 0, w.stderr);
    assert.equal(spawnSync(process.execPath, [GEN, '--check', '--out-dir', TMP]).status, 0);
    const api = join(TMP, 'API.md');
    writeFileSync(api, readFileSync(api, 'utf8').replace('## 6. Hooks', '## 6. Hooks (edited by hand)'));
    const r = spawnSync(process.execPath, [GEN, '--check', '--out-dir', TMP], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /docs\/plugins\/API\.md out of date; run npm run gen:plugin-docs/);
  });

  test('it says what the code says: every manifest key, bridge call, kit export, SDK module and hook', () => {
    const { api, schema } = generate();
    const facts = pythonFacts();
    const s = JSON.parse(schema);
    for (const key of Object.keys(s.properties)) assert.ok(api.includes(`| \`${key}\` |`), `manifest key ${key}`);
    for (const def of Object.values(s.$defs)) for (const key of Object.keys(def.properties)) assert.ok(api.includes(`| \`${key}\` |`), `table key ${key}`);
    const bridge = dtsExports(join(DOCS, 'workspace-sdk.d.ts'), '@magnusim/workspace');
    assert.ok(bridge.some((r) => r.name === 'connect' && r.kind === 'function'));
    const ws = bridge.find((r) => r.name === 'Workspace');
    for (const call of ['study.update', 'jobs.start', 'files.write', 'compute.submitOpenFOAM']) {
      assert.ok(ws.members.some((m) => m.text.startsWith(call + '(')), call);
      assert.ok(api.includes(`\`${call}(`), call);
    }
    const kit = dtsExports(join(DOCS, 'plugin-ui.d.ts'), '@magnusim/plugin-ui');
    for (const name of ['Button', 'NumberUnitInput', 'PanelChrome', 'formatSci']) {
      assert.ok(kit.some((r) => r.name === name), name);
      assert.ok(api.includes(`#### ${name}\n`), name);
    }
    for (const m of facts.sdk) assert.ok(api.includes(`### ${m.module}\n`), m.module);
    for (const h of facts.hooks.fired) assert.ok(api.includes(`\`${h}\``), h);
    for (const f of facts.contract.analysis_type_fields) assert.ok(api.includes(`| \`${f.name}\` |`), f.name);
    assert.match(api, new RegExp(`Host API \\*\\*${facts.api_version.replace('.', '\\.')}\\*\\*`));
    // Its examples are tests (npm run test:docs runs them).
    assert.deepEqual(testBlocks(api).map((b) => b.lang), ['toml', 'ts', 'python']);
  });
});

describe('code blocks', () => {
  test('fences of either kind; only blocks tagged test are tests', () => {
    const md = '```python test\nx = 1\n```\n\n~~~ts\nlet y = 2;\n~~~\n\n````toml test\nkey = "a"\n```\n````\n';
    const all = codeBlocks(md);
    assert.deepEqual(all.map((b) => [b.lang, b.line]), [['python', 1], ['ts', 5], ['toml', 9]]);
    assert.equal(all[2].code, 'key = "a"\n```\n');
    assert.deepEqual(testBlocks(md).map((b) => b.lang), ['python', 'toml']);
  });

  test('python runs, with magnusim_sdk and cfddesk.registry; a failing one fails', () => {
    assert.equal(runBlock(block('python', 'from magnusim_sdk.events import EVENT_PREFIX\nimport cfddesk.registry\nassert EVENT_PREFIX\n')), null);
    assert.match(runBlock(block('python', 'assert 1 + 1 == 3, "arithmetic"\n')), /AssertionError: arithmetic/);
  });

  test('py is python too', () => {
    assert.equal(runBlock(block('py', 'import cfddesk.registry\n')), null);
    assert.match(runBlock(block('py', 'raise SystemExit(4)\n')), /exit 4/);
  });

  test("a python block gets scratch settings in its own folder, never this PC's", () => {
    const code = [
      'import os',
      'here = os.path.realpath(os.getcwd())',
      'for name in ("MAGNUSIM_LOCAL_JSON", "CFDDESK_LOCAL_JSON"):',
      '    path = os.path.realpath(os.environ[name])',
      '    assert os.path.dirname(path) == here, (name, path, here)',
      '    assert os.path.basename(here).startswith("magnusim-doc-test-py-"), here',
      '',
    ].join('\n');
    assert.equal(runBlock(block('python', code)), null);
  });

  test('ts and tsx are type-checked against the published bridge, kit and React types', () => {
    const ok = "import { connect } from '@magnusim/workspace';\nconst ws = await connect();\nconst s = await ws.study.get();\nawait ws.study.update({ a: 1 }, s.rev);\nexport {};\n";
    assert.equal(runBlock(block('ts', ok)), null);
    assert.match(runBlock(block('ts', ok.replace(', s.rev', ''))), /Expected 2 arguments/);
    assert.match(runBlock(block('ts', "import { connect } from '@magnusim/workspace';\nconst ws = await connect();\nws.study.remove();\nexport {};\n")), /remove/);
    const tsx = "import { Button } from '@magnusim/plugin-ui';\nimport { useState } from 'react';\nexport function A() {\n  const [n, setN] = useState(0);\n  return <Button onClick={() => setN(n + 1)}>Add one</Button>;\n}\n";
    assert.equal(runBlock(block('tsx', tsx)), null);
    assert.match(runBlock(block('tsx', tsx.replace('<Button onClick', '<Button colour="red" onClick'))), /colour/);
  });

  test('js and jsx are type-checked too (checkJs)', () => {
    const js = "import { connect } from '@magnusim/workspace';\nconst ws = await connect();\nconst s = await ws.study.get();\nawait ws.study.update({ a: 1 }, s.rev);\nexport {};\n";
    assert.equal(runBlock(block('js', js)), null);
    assert.match(runBlock(block('js', js.replace(', s.rev', ''))), /Expected 2 arguments/);
    const jsx = "import { Button } from '@magnusim/plugin-ui';\nexport function A() {\n  return <Button onClick={() => {}}>Add one</Button>;\n}\n";
    assert.equal(runBlock(block('jsx', jsx)), null);
    assert.match(runBlock(block('jsx', jsx.replace('<Button onClick', '<Button colour="red" onClick'))), /colour/);
  });

  test('toml is a whole manifest the host must load', () => {
    const good = 'key = "doc-demo"\nname = "Doc demo"\nversion = "0.1.0"\napi_version = "1.4"\nlicense = "GPL-3.0-or-later"\n\n[[workspaces]]\nkey = "pad"\ntitle = "Pad"\n\n[[study_kinds]]\nkey = "pad"\ntitle = "Pad"\nworkspace = "pad"\n';
    assert.equal(runBlock(block('toml', good)), null);
    assert.match(runBlock(block('toml', good.replace('GPL-3.0-or-later', 'Proprietary'))), /^license: /m);
    assert.match(runBlock(block('toml', good.replace('workspace = "pad"', 'workspace = "elsewhere"'))), /^load: .*'elsewhere' is not declared/m);
    assert.match(runBlock(block('toml', good.replace('name = "Doc demo"\n', ''))), /^manifest: .*needs name/m);
    // A misspelt key is only a warning in plugin:check (the host ignores it); in an example it fails.
    const typo = good.replace('license = ', 'descripton = "misspelt"\nlicense = ').replace('title = "Pad"\n\n[[study_kinds]]', 'title = "Pad"\nicn = "M1 1"\n\n[[study_kinds]]');
    const why = runBlock(block('toml', typo));
    assert.match(why, /^manifest warning: descripton is not a manifest key/m);
    assert.match(why, /^manifest warning: workspaces\[0\]\.icn is not a manifest key/m);
    // So does a key newer than the api_version it declares.
    assert.match(runBlock(block('toml', good.replace('api_version = "1.4"', 'api_version = "1.1"').replace('[[workspaces]]', '[files]\nmax_file_mb = 8\n\n[[workspaces]]'))), /^api_version warning: files needs host API 1\.2/m);
  });

  test('a test block in a language with no runner fails; files report each block', () => {
    assert.match(runBlock(block('sh', 'echo hi\n')), /no runner for `sh test` blocks/);
    const md = join(TMP, 'doc.md');
    writeFileSync(md, '# Doc\n\n```python test\nassert True\n```\n\n```python\nraise SystemExit(1)\n```\n\n```python test\nraise SystemExit(3)\n```\n');
    const { passed, failed } = runFiles([md]);
    assert.equal(passed, 1);
    assert.deepEqual(failed.map((f) => [f.line, f.lang]), [[11, 'python']]);
    assert.match(failed[0].why, /exit 3/);
  });
});
