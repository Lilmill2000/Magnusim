// The dev server's file watcher must skip big local folders (projects, Python,
// a local OCCT build) and logs, and still see the app's own source. Git must
// leave the local OCCT tree and its logs untracked too.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { APP_ROOT, isViteWatchIgnored } = await import('../vite-watch-ignore.js');

const ROOT = 'C:\\Apps\\Magnusim\\magnusim-web';
const win = (rel, root = ROOT) => `${root}\\${rel.replace(/\//g, '\\')}`;
const posix = (rel, root = ROOT) => `${root.replace(/\\/g, '/')}/${rel}`;

// The same answer for a Windows path, a forward-slash path and a relative one.
const forms = (rel, root) => [win(rel, root), posix(rel, root), rel].map((p) => isViteWatchIgnored(p, root));
const ignored = (rel, root = ROOT) => forms(rel, root).every((x) => x);
const watched = (rel, root = ROOT) => forms(rel, root).every((x) => !x);

describe('Vite watch ignore', () => {
  it('skips a local OCCT source or build folder in the app folder', () => {
    for (const rel of [
      'occt-7.9.3',
      'occt-7.9.3/src/BRep/BRep_Builder.cxx',
      'occt-7.9.3/.git/HEAD',
      'occt-build/build.ninja',
      'OCCT-7.9.3/README.md',
    ]) {
      assert.ok(ignored(rel), rel);
    }
  });

  it('skips build and tool logs', () => {
    for (const rel of ['ninja.log', 'occt-clone.log', 'bundled-plugins/cad/kernel-build/build.log']) {
      assert.ok(ignored(rel), rel);
    }
  });

  it('still skips projects, Python, caches, dependencies and results', () => {
    for (const rel of [
      'projects/p1/project.json',
      'e2e/.tmp-projects/p1/project.json',
      'python/cfddesk/registry/__init__.py',
      'plugins/demo/.venv/Lib/site.py',
      'plugins/demo/__pycache__/x.pyc',
      'node_modules',
      'node_modules/react/index.js',
      '.cache/plugin-envs/x/pyvenv.cfg',
      'dist/index.html',
      'src/assets/logo.png',
      'templates/case/mesh.stl',
    ]) {
      assert.ok(ignored(rel), rel);
    }
  });

  it('watches the app itself and its source', () => {
    for (const rel of [
      'index.html',
      'vite.config.js',
      'src/app/main.tsx',
      'src/workbench/runtime.js',
      'src/style.css',
      'src/viewer/occt-faces.ts',
      'bundled-plugins/cad/kernel-build/occt-patches/0001-fix.patch',
      'bundled-plugins/cad/ui/index.tsx',
      'scripts/server/index.ts',
    ]) {
      assert.ok(watched(rel), rel);
    }
    assert.equal(isViteWatchIgnored(ROOT, ROOT), false);
    assert.equal(isViteWatchIgnored(APP_ROOT), false);
    assert.equal(isViteWatchIgnored(join(APP_ROOT, 'src', 'app', 'main.tsx')), false);
  });

  it('watches the app when its checkout sits under a projects, python or cache folder', () => {
    for (const root of [
      'C:\\Users\\me\\projects\\CFD\\magnusim-web',
      'D:\\python\\dist\\.cache\\CFD\\magnusim-web',
      'E:\\occt-7.9.3\\old.log\\magnusim-web',
    ]) {
      assert.equal(isViteWatchIgnored(root, root), false, root);
      assert.equal(isViteWatchIgnored(`${root}\\`, root), false, root);
      for (const rel of ['index.html', 'src/app/main.tsx', 'src/viewer/occt-faces.ts', 'src/occt-7.9.3/x.ts']) {
        assert.ok(watched(rel, root), `${root} ${rel}`);
      }
      for (const rel of ['projects/p1/project.json', 'python/cfddesk/x.py', 'occt-7.9.3/src/x.cxx', 'ninja.log']) {
        assert.ok(ignored(rel, root), `${root} ${rel}`);
      }
    }
    const root = '/home/me/projects/CFD/magnusim-web';
    assert.equal(isViteWatchIgnored(root, root), false);
    assert.equal(isViteWatchIgnored(`${root}/src/app/main.tsx`, root), false);
    assert.equal(isViteWatchIgnored(`${root}/projects/p1/project.json`, root), true);
  });

  it('still reads the whole path outside the app folder', () => {
    assert.equal(isViteWatchIgnored('C:\\Apps\\Magnusim\\projects\\p1\\project.json', ROOT), true);
    assert.equal(isViteWatchIgnored('C:\\Apps\\Magnusim\\python\\x.py', ROOT), true);
    assert.equal(isViteWatchIgnored('C:\\Apps\\Magnusim\\ROADMAP.md', ROOT), false);
    // A sibling whose name only starts like the app folder is outside it.
    const app = 'C:\\Users\\me\\projects\\CFD\\magnusim-web';
    assert.equal(isViteWatchIgnored(`${app}-old\\x.ts`, app), true);
  });

  it('places an occt- folder by the app folder, not by name alone', () => {
    assert.equal(isViteWatchIgnored(join(APP_ROOT, 'occt-7.9.3', 'src', 'x.cxx')), true);
    assert.equal(isViteWatchIgnored(join(APP_ROOT, 'src', 'occt-7.9.3', 'x.ts')), false);
    assert.equal(isViteWatchIgnored(join(APP_ROOT.toUpperCase(), 'OCCT-7.9.3', 'x.cxx')), true);
  });

  it('is the rule vite.config.js uses', () => {
    const config = readFileSync(join(APP_ROOT, 'vite.config.js'), 'utf8');
    assert.match(config, /import \{ isViteWatchIgnored \} from '\.\/scripts\/vite-watch-ignore\.js';/);
    assert.match(config, /ignored: \(filePath\) => isViteWatchIgnored\(filePath\)/);
    assert.doesNotMatch(config, /function isViteWatchIgnored/);
  });
});

// 0 = ignored, 1 = not ignored; anything else means git cannot answer here.
const gitIgnores = (rel) => spawnSync('git', ['check-ignore', '-q', rel], { cwd: APP_ROOT }).status;
const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: APP_ROOT, encoding: 'utf8' });
const inGit = !probe.error && probe.status === 0 && probe.stdout.trim() === 'true';

describe('git ignore', { skip: inGit ? false : 'needs git and a git checkout' }, () => {
  it('leaves a local OCCT source or build folder and its logs untracked', () => {
    for (const rel of ['occt-7.9.3/src/BRep/BRep_Builder.cxx', 'occt-build/x.ninja', 'ninja.log', 'occt-clone.log']) {
      assert.equal(gitIgnores(rel), 0, rel);
    }
  });

  it('still tracks the CAD plugin kernel patches and the app source', () => {
    for (const rel of [
      'bundled-plugins/cad/kernel-build/occt-patches/0001-fix.patch',
      'src/occt-7.9.3/x.ts',
      'src/viewer/occt-faces.ts',
      'src/app/main.tsx',
    ]) {
      assert.equal(gitIgnores(rel), 1, rel);
    }
  });
});
