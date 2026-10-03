# Testing

Magnusim has unit tests (Vitest, `node --test`, pytest) and browser tests
(Playwright, "e2e"). The browser tests include real meshing and solving in WSL,
which is slow. A full run on 2026-10-01 took 47 minutes: core 13.7 min, CAD
6.2 min and Incompressible Flow 27.2 min, nearly all of it in the tests that mesh
and solve. The core suite without them takes about 8 minutes. So which tests you
run depends on what you are doing.

## Which tests to run when

| When | Run | Time |
|---|---|---|
| While you work on something | `npm run typecheck`, the unit tests for that area, and the e2e specs for what you touched | seconds to minutes |
| Before a local commit | `npm run test:e2e:changed`: the suites your change can affect, without WSL meshes and solves | minutes |
| Before a push, and nightly | `npm run test:e2e`: every suite, with real meshes and solves | about 47 min |

The full run is the gate before a push. It is not needed for every commit.

| Command | What it runs |
|---|---|
| `npm run test:e2e -- <spec path>` | One spec, in the suite that holds it (`e2e/...` or `bundled-plugins/<key>/e2e/...`). Set `MAGNUSIM_E2E_WSL=0` when it doesn't mesh or solve. |
| `npx playwright test e2e/<spec>.js` | One core spec, directly. |
| `npm run test:e2e:changed` | The fast tier of the suites the changed files affect (see below). `-- --full` adds WSL. |
| `npm run test:e2e:fast` | Every suite, without WSL meshes and solves. |
| `npm run test:e2e` | Every suite, with WSL meshes and solves when WSL with OpenFOAM is on the PC. |
| `npm run test:e2e:core` | The core suite only (`playwright test`). |
| `npm run test:e2e -- --suite incompressible_flow` | One suite (`core`, `cad`, `incompressible_flow`; repeatable). |

`test:e2e:changed` reads the changed files from `git status` (staged,
unstaged and untracked). In a shared checkout that includes other people's
uncommitted work, so it may run more than your change needs, never less. Name
your own files with `-- --files a,b,c` (also the way to use it in a snapshot
without `.git`). `-- --base origin/master` adds the commits a push would send;
`-- --plan` prints what it would run and why, and runs nothing.

## Suites

| Suite | Where | What it covers |
|---|---|---|
| core | `e2e/` (`playwright.config.js`) | Home, projects, geometry import, meshing, the compute queue, panels, and the plugin host, tested with small test plugins from `python/tests/fixtures/`. |
| incompressible_flow | `bundled-plugins/incompressible_flow/e2e/` (its `playwright.config.js`, on the core's Playwright and app server) | Its studies and run settings, every steady and transient solve, and the results views, monitors and exports those solves feed. |
| cad | `bundled-plugins/cad/e2e/`, run by `npm run test:e2e` in that folder (its own toolchain) | The Part workspace, against this checkout's app. |

**What a change runs** (`scripts/e2e-suites.mjs`). A plugin sits on top of the
core, so a core change can break a plugin without touching it, but a plugin
change cannot change the core.

| Changed | Runs |
|---|---|
| Documentation (`*.md`, `*.txt`, `docs/`), unit tests (`*.test.*`, `__tests__/`, `python/tests/` except `fixtures/`, a plugin's `tests/`), the plugin template, files outside `magnusim-web/` | nothing |
| `bundled-plugins/<key>/` | that plugin's suite, plus the core specs that check how the core meets its bundled plugins (`h5-plugins`, `h8-contract`); never another plugin's suite |
| Only core spec files (`e2e/*.spec.js`) | those specs |
| Anything else in the app (`src/`, `scripts/`, `python/`, `e2e/support/`, fixtures, config, dependencies) | the core suite, Incompressible Flow's suite, and CAD's suite when the file is one CAD reaches (below) |

Incompressible Flow's studies run through the whole core (meshing, BCs,
materials, the run panel, results), so every core change runs its suite. CAD
reaches the app only through the plugin host, so a core change runs CAD's suite
only when it touches what CAD uses. That list is `HOST_PATHS.cad` in
`scripts/e2e-suites.mjs` (until CAD declares `"magnusim": {"e2eHostPaths": [...]}` in
its `package.json`): the workspace host, the plugin SDK and API, the UI kit, the app shell,
the tree, Settings, the dialogs, the Node server, the registry and worker, the
project tree and plugin data writes, `magnusim_sdk`, the e2e harness, the
build config and dependencies. A change elsewhere (`runtime.js`, the panels,
the viewer, the mesh and solve scripts, the meshers) still runs the core suite,
whose plugin-host specs (`h5`, `h11`, `h13`, `g1`, `g7`, `g11`) check the
same host with test plugins.

## Python package boundaries

`python/tools/core_layers.py` (CI job `plugin-boundary`) fixes which
`cfddesk` packages may import which (`ALLOWED` in that file). A new
cross-package import fails until it is added to `ALLOWED` on purpose, and an
entry nothing uses any more fails too, so the graph only shrinks unnoticed,
never grows. The graph started as it was on 2026-10-01. That graph is not
layered: eight pairs of packages import each other (nine on 2026-10-01; the
report lists them under `cycles`), so a change in one of those packages can still reach the other.
Removing a cycle is how a package becomes safe to change on its own.

## Real meshes and solves (WSL)

Every test runs by default, including real meshing and solving, whenever WSL
with OpenFOAM is on the PC; without it those tests skip and say why (GitHub CI
has no WSL, so CI never meshes or solves).

- `MAGNUSIM_E2E_WSL=0` skips them on purpose.
- `MAGNUSIM_E2E_HEAVY=0` skips only the long solves.
- `MAGNUSIM_E2E_WSL=1` fails the run if the toolchain is missing.
- `npm run test:e2e` is the full tier, so it sets `MAGNUSIM_E2E_FULL=1` for
  every suite. A test whose prerequisite is missing fails there instead of
  skipping (the Airfoil plugin's environment, built for its lock). Naming spec
  paths, `--fast`, `--changed` and `MAGNUSIM_E2E_WSL=0` are not the full tier.
- `e2e/phase1-land9-solve.spec.js` checks a public deployment and runs only
  with `MAGNUSIM_PUBLIC_E2E=1` and its URL settings.

**One WSL run at a time.** Two runs that mesh and solve at once share WSL's
CPU, and each takes about twice as long. A core run that may mesh or solve
waits for the PC's WSL test lock, `%LOCALAPPDATA%\Magnusim\e2e-wsl.lock`
(`e2e/global-setup.js`). It prints who holds the lock once a minute while it
waits. A run that can't reach a WSL test doesn't wait: `MAGNUSIM_E2E_WSL=0`, or
only specs that never mesh or solve. A lock left by a process that has ended is
ignored.

- `MAGNUSIM_E2E_LOCK_WAIT_MS` bounds the wait (default 4 hours).
- `MAGNUSIM_E2E_LOCK=0` skips the lock.

## Writing tests

- **Every bug fixed gets a browser test in a suite that runs by default.** It
  asserts what the user sees, after the action and after a reload. It runs in
  every full run, and whenever a change can affect its suite.
- **A plugin's tests go in its own suite**, not in `e2e/`.
- **A test that needs WSL** says so with `test.skip(!WSL, NO_WSL)` from
  `e2e/toolchain.js`, so the fast tier skips it cleanly. Setup that needs no
  solver (copying settings, editing refinements, picking engines) belongs in a
  test without that guard, so the fast tier and CI still check it.
- **A second app server** (other plugins, another projects root, other
  settings) comes from `startHost()` in `e2e/support/host-server.mjs`. It picks
  a free port and gives the server its own temp projects root, prefs and
  plugins folder. Don't pick `MAGNUSIM_E2E_PORT + N` by hand.

  ```js
  const host = await startHost({ name: 'g1', pluginsFrom: 'python/tests/fixtures/workspace-plugins' });
  try {
    await page.goto(`${host.base}/#/p/...`);
  } finally {
    host.stop();
  }
  ```

  Its options cover:
  - another bundled folder (`bundledDir`);
  - turning on bundled plugins that ship off (`enablePlugins`);
  - extra settings and environment (`prefs`, `env`);
  - a caller-filled temp folder (`tmp`, `projects`, `pluginsDir`, from `e2eTemp()`);
  - a private Vite cache (`viteCacheDir`);
  - another checkout (`webRoot`);
  - reusing a live server (`lock`).

  The header of `e2e/support/host-server.mjs` lists them all.

## A bundled plugin's own suite

A bundled plugin keeps its browser tests in `bundled-plugins/<key>/e2e/`, in
one of two forms. `npm run test:e2e` and `test:e2e:changed` find both.

- **On the core's Playwright** (Incompressible Flow): an
  `e2e/playwright.config.js` that exports
  `appSuiteConfig({ name: '<key>', testDir, seed })`. Its specs get the same
  app server, seeded projects, WSL toolchain and lock as the core suite.
  - **One seam.** Its specs, seed module and config import from the core only
    `../../../e2e/support/plugin-suite.js` (`appSuiteConfig`, `NO_WSL`,
    `NO_HEAVY`, `wslPathExists`, `waitSlotFree`, the two-plates helpers
    `setup`, `createStudy`, `addAir`, `addBc`, `PYTHON` and
    `seedElbowProject`); `scripts/__tests__/e2e-suites.test.mjs` fails on any
    other import from outside the plugin.
  - **Its own projects.** `seed` is a module (absolute path) whose default
    export gets the projects root and seeds the suite's projects, after
    `e2e/prepare-projects.js` has seeded the core's
    (`e2e/support/seed-suite.js`). Incompressible Flow's is
    `bundled-plugins/incompressible_flow/e2e/seed.js`; it exports the ids its
    specs open. `seedElbowProject(root, id, title)` copies a fresh elbow
    sample there, replacing one already seeded.
- **With its own toolchain** (CAD): a `package.json` whose `test:e2e` script
  builds the plugin and runs its tests against this checkout's app, started
  with `startHost()`. Most plugins ship off, so pass
  `enablePlugins: ['<key>']`.
  - A plugin whose folder has no `node_modules` yet stops the run with "run
    npm ci in bundled-plugins/<key>" instead of being skipped.
  - Spec paths given to the runner reach its script after `--`, relative to
    the plugin folder.
- **Host paths.** A plugin that reaches the app only through the plugin host
  can list the core paths it depends on in its `package.json`
  (`"magnusim": {"e2eHostPaths": [...]}`), so other core changes don't run its
  suite. Without a list, every core change runs it.
  - **Added by the manifest.** A plugin with a list also depends on the host
    features its `manifest.toml` opts into, with no plugin named in the core:
    a `[[start_actions]]` table adds `START_ACTION_HOST_PATHS` (Home, the New
    Project dialog, the header and empty-project buttons and their host
    elements, the create-then-open path in `runtime.js`, the tree's kind rows
    and the STUDIES rule, the manifest checks),
    and a study kind with `links_geometry = true` adds `LINK_HOST_PATHS` (the
    linked geometry's writers and readers). Both lists are in
    `scripts/e2e-suites.mjs`; `discoverPluginSuites` adds them by a plain line
    test of the manifest, so a commented-out example adds nothing
    (`scripts/__tests__/e2e-suites.test.mjs`, `gate:l1-suites`).
- **Fast tier.** A plugin's tests that mesh or solve must skip when
  `MAGNUSIM_E2E_WSL=0`.
