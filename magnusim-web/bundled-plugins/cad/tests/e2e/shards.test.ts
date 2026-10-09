// @vitest-environment node
// The e2e suite's shards and the file-to-shard map (scripts/e2e-shards.mjs), the runner's
// planning (scripts/e2e.mjs), and the smoke and serial tags in the specs:
//   - every spec of e2e/ is in exactly one shard, and every shard's spec exists;
//   - a changed file maps to the shards that test it (shared code to every shard);
//   - the smoke set is 10-15 tests, one path through every area, none of them @serial;
//   - package.json has a script per shard, smoke and changed.
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RULES, SERIAL_TAG, SHARD_NAMES, SHARDS, SMOKE_TAG, shardOfSpec, shardsForFile, shardsForFiles, specsOf } from '../../scripts/e2e-shards.mjs';
import { changedFromGit, parseArgs, planRun, playwrightArgs, withoutOptions } from '../../scripts/e2e.mjs';

const PLUGIN = fileURLToPath(new URL('../../', import.meta.url));
const specFiles = readdirSync(join(PLUGIN, 'e2e'))
  .filter((f) => /\.spec\.[jt]s$/.test(f))
  .map((f) => `e2e/${f}`)
  .sort();
const AREAS = ['shell', 'sketch', 'solids', 'step', 'link'];
const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
const HOST: string[] = pkg.magnusim.e2eHostPaths;

/** The tests of a spec file with their tags, read from the source: [{title, tags}]. */
function taggedTests(file: string): { title: string; tags: string[] }[] {
  const src = readFileSync(join(PLUGIN, file), 'utf8');
  const out: { title: string; tags: string[] }[] = [];
  // test('title', { tag: '@a' } | { tag: ['@a', '@b'] }, async ...
  const re = /\btest\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*\{\s*tag:\s*(\[[^\]]*\]|'[^']*'|"[^"]*")\s*\}/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ title: m[2], tags: [...m[3].matchAll(/@[a-z-]+/g)].map((t) => t[0]) });
  return out;
}

describe('shards', () => {
  it('every spec of e2e/ is in exactly one shard', () => {
    const where: Record<string, string[]> = {};
    for (const [shard, specs] of Object.entries(SHARDS)) for (const s of specs) (where[s] ||= []).push(shard);
    const inNone = specFiles.filter((f) => !where[f]);
    const inTwo = Object.entries(where).filter(([, s]) => s.length > 1).map(([f, s]) => `${f}: ${s.join(', ')}`);
    expect(inNone, 'specs in no shard (add each to one in scripts/e2e-shards.mjs)').toEqual([]);
    expect(inTwo, 'specs in two shards').toEqual([]);
    for (const f of specFiles) expect(shardOfSpec(f)).toBe(where[f][0]);
  });

  it("every shard's spec exists, once", () => {
    const listed = Object.values(SHARDS).flat();
    expect(listed.filter((s) => !existsSync(join(PLUGIN, s))), 'listed specs that are not in e2e/').toEqual([]);
    expect(new Set(listed).size).toBe(listed.length);
    expect(SHARD_NAMES).toEqual(['shell', 'sketch', 'solids', 'step', 'link', 'big']);
    // The opt-in shard: Daniel's 113 MB part (P4b SELECT fix round 1 adds the box timed on it).
    expect(SHARDS.big).toEqual(['e2e/cad-large-step.spec.js', 'e2e/cad-p4b-select-big.spec.ts']);
    expect(specsOf(['link', 'solids'])).toEqual([...SHARDS.solids, ...SHARDS.link]);
  });

  it('package.json runs each shard, the smoke set and the changed shards', () => {
    for (const s of SHARD_NAMES) expect(pkg.scripts[`test:e2e:${s}`]).toBe(`node scripts/e2e.mjs --shard ${s}`);
    expect(pkg.scripts['test:e2e']).toBe('node scripts/e2e.mjs');
    expect(pkg.scripts['test:e2e:smoke']).toBe('node scripts/e2e.mjs --smoke');
    expect(pkg.scripts['test:e2e:changed']).toBe('node scripts/e2e.mjs --changed');
  });
});

describe('the file-to-shard map', () => {
  const all = AREAS;
  const cases: [string, string[]][] = [
    // Areas.
    ['src/sketch/mode.ts', ['sketch']],
    ['src/solver-worker/solver-worker.mjs', ['sketch']],
    ['solver-build/build.sh', ['sketch']],
    ['src/link/controller.ts', ['link']],
    ['src/doc/source-record.ts', ['link']],
    ['scripts/gate-l2-cad.mjs', ['link']],
    ['scripts/gate-l3-cad.mjs', ['link']],
    ['scripts/app-python.mjs', ['link', 'step']],
    ['src/features/revolve/build.ts', ['solids']],
    ['src/features/fillet/panel.tsx', ['solids']],
    ['src/features/refgeom/resolve.ts', ['solids']],
    ['src/features/solids/panel.tsx', ['solids']],
    ['src/features/revolve/index.ts', ['solids', 'shell']],
    ['src/features/combine/build.ts', ['step', 'sketch', 'link']],
    ['src/features/split/index.ts', ['step', 'sketch', 'link', 'shell']],
    ['src/features/measure/panel.tsx', ['step', 'sketch']],
    ['src/features/mass/panel.tsx', ['step']],
    ['src/features/import/pipeline.ts', ['step', 'sketch', 'link', 'big']],
    ['src/files/transfer.ts', ['step']],
    // P4b PATTERN.
    ['src/features/pattern/build.ts', ['solids']],
    ['src/features/pattern/index.ts', ['solids', 'shell']],
    ['e2e/cad-p4b-pattern.spec.ts', ['solids']],
    // P4b SELECT.
    ['src/features/selectcount/index.tsx', ['sketch', 'shell']],
    ['src/sketch/project/source.ts', ['sketch']],
    ['src/viewport/boxpick.ts', all],
    // Specs: their own shard.
    ['e2e/cad-p4a-solids.spec.ts', ['solids']],
    ['e2e/cad-link-exit.spec.ts', ['link']],
    ['e2e/cad-p1-document.spec.js', ['shell']],
    ['e2e/cad-large-step.spec.js', ['big']],
    // Shared code: every shard.
    ['src/doc/service.ts', all],
    ['src/ui/Toolbar.tsx', all],
    ['src/app/App.tsx', all],
    ['src/viewport/viewport.ts', all],
    ['src/naming/edges.ts', all],
    ['src/types/doc.ts', all],
    ['src/lib/bridge.ts', all],
    ['src/kernel/worker-client.ts', all],
    ['src/kernel-worker/kernel-api.ts', all],
    ['src/features/extrude/def.ts', all],
    ['src/features/sketch/regions.ts', all],
    ['src/features/enclosure/panel.tsx', all],
    ['src/features/p2/pick.ts', all],
    ['src/features/new_feature/index.ts', all],
    ['kernel-build/facade/facade.cpp', all],
    ['workspace/app.js', all],
    ['workspace/kernel/mk32.wasm', all],
    ['fixtures/kernel/box20-faces.step', all],
    ['e2e/helpers.ts', all],
    ['e2e/playwright.config.ts', all],
    ['e2e/cad-new-area.spec.ts', all],
    ['scripts/e2e.mjs', all],
    ['scripts/e2e-shards.mjs', all],
    ['scripts/build.mjs', all],
    ['manifest.toml', all],
    ['package.json', all],
    ['plugin.py', all],
    // No e2e test reads these.
    ['tests/doc/service.test.ts', []],
    ['README.md', []],
    ['ARCHITECTURE.md', []],
    ['docs/p2p3-plan.md', []],
    ['vitest.config.ts', []],
    // Host files: every shard when the suite depends on them (e2eHostPaths), else none.
    ['../../src/plugin-sdk/workspace.ts', all],
    ['../../scripts/prefs.js', all],
    ['../../e2e/support/host-server.mjs', all],
    ['../../package.json', all],
    ['../../src/workbench/runtime.js', []],
    ['../../python/cfddesk/mesh/generate_guard.py', []],
    ['../../bundled-plugins/incompressible_flow/manifest.toml', []],
    ['../../../.github/workflows/ci.yml', []],
  ];
  it.each(cases)('%s -> %j', (file, shards) => {
    expect(shardsForFile(file, HOST).shards.sort()).toEqual([...shards].sort());
  });

  it("names only real shards, and only Import STEP and its spec reach the opt-in shard", () => {
    for (const [, to] of RULES) if (Array.isArray(to)) for (const s of to) expect(SHARD_NAMES).toContain(s);
    const toBig = RULES.filter(([, to]) => Array.isArray(to) && to.includes('big')).map(([p]) => String(p));
    expect(toBig.every((p) => p.includes('import'))).toBe(true);
    expect(shardsForFile('src/doc/service.ts', HOST).shards).not.toContain('big');
  });

  it('a set of changed files: the shards in order, the files behind each, the files that need none', () => {
    const r = shardsForFiles(['src/link/leave.ts', 'src/sketch/tools.ts', 'README.md', 'src/sketch/mode.ts'], HOST);
    expect(r.shards).toEqual(['sketch', 'link']);
    expect(r.why).toEqual({ sketch: ['src/sketch/tools.ts', 'src/sketch/mode.ts'], link: ['src/link/leave.ts'] });
    expect(r.none).toEqual([{ file: 'README.md', why: 'docs' }]);
  });
});

describe('the runner', () => {
  it('reads its own options and passes the rest to Playwright', () => {
    const o = parseArgs(['--shard', 'sketch,link', '--shard=solids', '--smoke', '-g', 'revolve', 'e2e/x.spec.ts', '--reporter=list']);
    expect(o).toMatchObject({ shards: ['sketch', 'link', 'solids'], smoke: true, changed: false, pw: ['-g', 'revolve', 'e2e/x.spec.ts', '--reporter=list'] });
    expect(parseArgs(['--base', 'origin/master'])).toMatchObject({ changed: true, base: 'origin/master' });
    expect(parseArgs(['--files', 'a.ts,b.ts', '--files=c.ts'])).toMatchObject({ changed: true, files: ['a.ts', 'b.ts', 'c.ts'] });
    expect(() => parseArgs(['--shard', 'solid'])).toThrow(/no shard solid/);
    expect(withoutOptions(['--workers', '3', 'e2e/a.spec.ts', '--workers=2', '-j', '4', '--reporter=list'], ['--workers', '-j'])).toEqual(['e2e/a.spec.ts', '--reporter=list']);
  });

  it('plans the changed shards: some shards by their specs, every shard as the full suite, none as nothing', () => {
    const changed = (files: string[], extra: string[] = []) => planRun(parseArgs(['--changed', ...extra]), files, HOST);
    const some = changed(['src/sketch/mode.ts', 'src/features/revolve/build.ts']);
    expect(some).toMatchObject({ shards: ['sketch', 'solids'], specs: [...SHARDS.sketch, ...SHARDS.solids], nothing: false });
    expect(changed(['src/doc/service.ts'])).toMatchObject({ shards: AREAS, specs: null, nothing: false });
    expect(changed(['README.md', 'tests/x.test.ts'])).toMatchObject({ shards: [], nothing: true });
    // A shard named with --shard is added to the changed ones.
    expect(changed(['src/link/leave.ts'], ['--shard', 'step']).shards).toEqual(['step', 'link']);
    // Without --changed: the named shards' specs, or every spec.
    expect(planRun(parseArgs(['--shard', 'big']), [], HOST).specs).toEqual(SHARDS.big);
    expect(planRun(parseArgs([]), [], HOST).specs).toBeNull();
  });

  it('puts the shard specs before the passed-through args (--project takes every value up to the next option)', () => {
    const o = parseArgs(['--shard', 'solids', '--project', 'chrome', '--reporter=list']);
    expect(playwrightArgs(o, planRun(o, [], HOST))).toEqual([...SHARDS.solids, '--project', 'chrome', '--reporter=list']);
    expect(playwrightArgs(parseArgs(['-g', 'x']), { specs: null })).toEqual(['-g', 'x']);
  });

  it('lists the changed files from git: status (a rename both ways, untracked) and the diff from the base', () => {
    const calls: string[][] = [];
    const top = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/[\\/]$/, '');
    const fake = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return `${top}\n`;
      if (args[0] === 'status') return [' M magnusim-web/bundled-plugins/cad/src/sketch/mode.ts', 'R  magnusim-web/bundled-plugins/cad/src/link/new.ts', 'magnusim-web/bundled-plugins/cad/src/link/old.ts', '?? magnusim-web/src/plugin-sdk/x.ts', ''].join('\0');
      if (args[0] === 'merge-base') return 'abc123\n';
      if (args[0] === 'diff') return ['magnusim-web/bundled-plugins/cad/src/features/fillet/panel.tsx', ''].join('\0');
      throw new Error(args.join(' '));
    };
    expect(changedFromGit(null, fake)).toEqual(['src/sketch/mode.ts', 'src/link/new.ts', 'src/link/old.ts', '../../src/plugin-sdk/x.ts']);
    expect(calls.some((c) => c[0] === 'diff')).toBe(false);
    expect(changedFromGit('origin/master', fake)).toContain('src/features/fillet/panel.tsx');
    expect(calls).toContainEqual(['merge-base', 'origin/master', 'HEAD']);
    expect(calls).toContainEqual(['diff', '--name-only', '-z', 'abc123']);
  });
});

describe('the smoke and serial tags', () => {
  const tagged = specFiles.flatMap((f) => taggedTests(f).map((t) => ({ ...t, file: f, shard: shardOfSpec(f) })));
  const smoke = tagged.filter((t) => t.tags.includes(SMOKE_TAG));
  const serial = tagged.filter((t) => t.tags.includes(SERIAL_TAG));

  it('the smoke set is 10-15 tests with one path through every area, none of them @serial', () => {
    expect(smoke.length, smoke.map((t) => t.title).join('\n')).toBeGreaterThanOrEqual(10);
    expect(smoke.length).toBeLessThanOrEqual(15);
    for (const area of AREAS) expect(smoke.filter((t) => t.shard === area).length, `smoke tests in ${area}`).toBeGreaterThan(0);
    expect(smoke.filter((t) => t.tags.includes(SERIAL_TAG))).toEqual([]);
  });

  it('a tag is written once per test, as { tag } (the runner and Playwright read only that form)', () => {
    for (const f of specFiles) {
      const src = readFileSync(join(PLUGIN, f), 'utf8');
      // A tag in a title ("... @smoke") would be matched by --grep too, but the test above would not see it.
      expect(src.match(/test\(\s*['"`][^'"`]*@(smoke|serial)/g), f).toBeNull();
      const all = (src.match(/@(smoke|serial)\b/g) || []).length;
      const known = taggedTests(f).reduce((n, t) => n + t.tags.filter((x) => x === SMOKE_TAG || x === SERIAL_TAG).length, 0);
      expect(all, `${f}: every @smoke / @serial is a test's { tag }`).toBe(known);
    }
  });

  it('@serial marks only the tests that change or read what every test on the server sees, or time the server or the browser', () => {
    expect(serial.map((t) => t.title.split(' ')[0]).sort()).toEqual([
      // CAD turned off, its manifest broken, its choice forgotten, Settings > Plugins > Disable.
      'cad:p1-document-broken-manifest',
      'cad:p1-document-leave-elsewhere',
      'cad:p1-document-open',
      'cad:p1-document-plugin-off',
      // Home lists every project the other workers are making.
      'cad:start-home',
      'cad:start-new-project',
      // Timings: the server's latency under CAD's load, frame rates, the 113 MB part's budgets.
      'cad:large-step',
      'cad:large-step-exit-camera',
      'cad:p1-viewport-perf',
      'cad:p2-step-contention',
      'cad:p2p3-review1-import-cancel-big',
      // P4b SELECT: the box over a 10,000-face part, timed.
      'cad:p4b-select-box-10k',
      // P4b SELECT fix round 1 (B-3): the box timed along the user's path, on the 10k grid and (opt-in) the 113 MB part.
      'cad:p4b-fix-b3-box-user-path',
      'cad:p4b-select-big-box',
      // P4b follow-up: the toolbar layout is the user's (ws.prefs): one file per plugin on the server.
      'cad:p4b-toolbar-customize',
      'cad:p4b-toolbar-migrate',
      'cad:p4b-toolbar-tabs',
      // ux010 TOOLBAR: dragging between More and the bar changes the same user layout.
      'cad:ux010-toolbar-model',
      'cad:ux010-toolbar-narrow',
      'cad:ux010-toolbar-sketch',
      // ux010 PANELS: the Sketch panel's collapse and Details, the tree's collapse: the user's prefs too.
      'cad:ux010-panels-collapse',
      'cad:ux010-panels-compact',
      'cad:ux010-panels-error-compact',
      'cad:ux010-panels-measure',
      'cad:ux010-panels-hint-line',
      'cad:ux010-panels-model-tree',
      'cad:ux010-panels-review-delete-head',
      'cad:ux010-panels-review-keyboard',
      'cad:ux010-panels-review-no-flash',
      'cad:ux010-panels-review-short-frame',
      'cad:ux010-panels-tool-card',
    ].sort());
  });
});
