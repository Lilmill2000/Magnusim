# Magnusim CAD

A parametric part modeler (SolidWorks and Fusion style) that runs as
Magnusim's **Part** workspace. It is an optional bundled plugin that ships
on (Daniel's D33); Settings > Plugins turns it off (Disable), and then nothing
of it runs. A new Part starts from **Design a part** on an empty project or in
the New Project dialog's "Start from", from **New design** on Home (New Project
with "Untitled Part N", one Create), or from the header's **CAD** button (its
menu lists the project's Parts and makes a new one); once a project has a Part,
its STUDIES section lists it and offers **+ New Part**. A Part opens in its own
full-page workspace over the workbench. Today (phases P1-P3 and the SD pass) a
Part is made of sketches (lines, rectangles, circles, arcs; dimensions and
constraints solved as you draw) extruded as new bodies or joined, cut or
intersected, and of imported STEP files (healed, with their names and colours)
edited directly: delete faces, press-pull, split, Combine (join, cut,
intersect), measure, mass properties, check, and export to STEP. Solids come
only from sketches and STEP: there is no one-click Box or Cylinder (decision
2026-10-01; a Part saved with one opens with that row red, "This part uses a
removed feature (Box 1)", and Delete takes it away). For CFD, **Enclosure** (the
toolbar's CFD PREP group) makes a box or cylinder body around the part's exact
bounding box, with zero, percent or fixed padding and its own value per side
(typed, or dragged by the arrows in the view; Escape during a drag puts it back).
A side may go into the part (one amber note names those sides: the fluid will
leave the cut-off part out) but never past its far side (refused under the
field, and the arrow stops there; also when the part later shrinks under it). It follows the part when the part changes,
it is drawn see-through (a click picks the part inside it), its faces are named
by side ("+X face of Enclosure 1", "Top face"; a cylinder about X has a "+X end"),
and Combine Cut with it as the target (Keep the tool bodies comes on) then gives
the fluid domain. Named parameters drive
any number. Revolve, fillet and the rest of the modeling breadth are later
phases. The description in `manifest.toml` (shown in
Settings > Plugins) names only what ships: update it as features land.

It needs Magnusim's host API 1.6: a Part's design becomes a geometry of its
project (`ws.project.linkGeometry`, the Part study kind's `links_geometry`, 1.5),
and its panels are drawn with the host's UI kit (`@magnusim/plugin-ui`, 1.3).
Each body has an "Include in simulation" toggle (its Bodies row and its menu),
on for every solid body; a body left out is not part of the project's geometry.
The sync runs when the user leaves the Part (the host's exit hook, `ws.nav.onLeave`,
1.6): every way out (Back, the browser's Back, another project, Home, Open in 3D)
saves the Part, brings its geometry up to date and lands in the simulation
viewport with the Part's camera; ARCHITECTURE.md §11 has the export, the face
names and the exit hook. From 1.2
it uses `ws.files` to save a Part's model (etag-checked writes, so two tabs
never overwrite each other) and asks before leaving the workspace while a
change is not saved yet. (The document still falls back to `ws.data` on a 1.1
host; the unit tests' fake host uses that path.)

Everything runs in the browser, in the workspace's sandboxed frame: the OCCT
7.9.3 modeling kernel and FreeCAD's PlaneGCS sketch solver are WebAssembly
modules in the page's own workers. There is no Python backend (`plugin.py`
registers nothing; `manifest.toml` declares the workspace and the study kind).

Licence: GPL-3.0-or-later. Third-party licences: `LICENSES/`.

## Layout

| Path | What |
|---|---|
| `manifest.toml`, `plugin.py` | What the host reads. `plugin.py` is the only Python file in the plugin. |
| `src/` | TypeScript source of the workspace page and its workers. |
| `workspace/` | **Built output only** (what the host serves to the frame): `index.html`, `app.js`, `app.css`, `kernel/` (kernel worker + `mk32.mjs/.wasm`), `solver/` (`planegcs.mjs/.wasm`). Never edit by hand. |
| `kernel-build/` | OCCT + facade build (pinned sources, patches, scripts). See `kernel-build/SOURCES.md`. |
| `solver-build/` | PlaneGCS build (pinned upstream, our patch, script). See `solver-build/SOURCES.md`. |
| `tests/` | Unit tests (vitest; kernel and solver tests load the real wasm in Node). |
| `e2e/` | Playwright tests against the host app (`e2e/host-server.mjs` starts it with the app's `startHost()`). |
| `scripts/` | `build.mjs` (page + workers), `e2e.mjs` (build + e2e under a lock). |
| `ARCHITECTURE.md` | Areas, contracts and rules for anyone changing the code. |

## Build and test

The plugin has its own toolchain; the core's lint, typecheck and tests never
see `src/`, and the core's `npm test` does not run these: run them here
before every commit. The repository's CI job `cad-plugin` runs them too, and the
core's `npm run test:e2e` (`scripts/e2e-suites.mjs`) runs this suite through
`npm run test:e2e` here when a file of the plugin, or a host file in
`package.json` `magnusim.e2eHostPaths`, changed.

```
cd bundled-plugins/cad
npm ci                 # own node_modules (gitignored)
npm run typecheck      # tsc: src, tests, e2e
npm test               # vitest (unit; the kernel and solver in Node)
npm run build          # src/ -> workspace/ (page + worker modules)
npm run build:check    # workspace/ must be exactly the build of src/ (run before every commit)
npm run test:e2e       # build, start the host app on a free port, run e2e/ (bundled Chromium)
CAD_E2E_CHANNELS=chrome,msedge npm run test:e2e   # also real Chrome and Edge
npm run test:e2e -- e2e/cad-p1-document.spec.js   # the P1 exit gate only
npm run test:e2e -- e2e/cad-p2-step.spec.js e2e/cad-p3-sketch.spec.js   # the P2 and P3 exit gates
CAD_E2E_VORTEX_STEP=<path> npm run test:e2e   # with the Vortex part: its tests run instead of being skipped
CAD_E2E_BIG_STEP=<path> npm run test:e2e -- e2e/cad-large-step.spec.js  # the 113 MB STEP (opt-in)
npm run test:kernel    # the kernel gates in Node (fixtures/kernel)
npm run test:gate:l2-cad   # LINK: the export against the app's own checker, and the link e2e; fails (never skips) without the app's Python
CAD_E2E_VORTEX_STEP=<path> npm run test:gate:l3-cad   # exit sync (L3): the exit hook's unit tests and e2e/cad-link-exit.spec.ts; fails (never skips) without the app's Python or the Vortex, on a stray .only, and on any test missing from or added to its census (every test is expected to pass; none is marked test.fail(): see ARCHITECTURE.md §11)
```

- `npm run test:e2e` starts the host app from this checkout with the app's
  own `startHost()` (`e2e/host-server.mjs` over
  `magnusim-web/e2e/support/host-server.mjs`: a temp projects root and prefs,
  no user plugins, a free port from 8170 (or `CAD_E2E_PORT_FROM`) with
  +11..+13 also free, a private Vite dependency cache in `.cache/host-vite`, no
  WSL meshes or solves and no sweep of WSL's cases). CAD ships on: the server
  starts with CAD at its manifest default, the tests turn it on again (as
  Settings' Enable does) when a test turned it off, and the P1 gate's first test
  forgets the choice and checks it is On on a fresh install, then Disable and
  Enable. `e2e/cad-start.spec.ts` clicks each place the start action is offered. Set
  `CAD_E2E_BASE_URL` to use a server that is already running, or
  `CAD_E2E_LOCK=<file>` to share one server between several runs (a live
  server named in the lock is reused, and its prefs file comes from the lock).
- The real-part STEP files are not in the repository: tests read them where they
  are, by path, and only from environment variables. `CAD_E2E_VORTEX_STEP` (the
  Vortex part: every test that needs it, the P2 gate's and the kernel tests
  included, is skipped without it and says so, and fails with the path when the
  variable names no file), `CAD_E2E_BIG_STEP` and `CAD_KERNEL_BIG_STEP` (the
  113 MB part, opt-in). `tests/arch/user-files.test.ts` fails if a copy of one is
  in the plugin.
  The P2 gate's native check runs the core venv's python with cadquery-ocp 7.9.3
  inline (`CAD_E2E_PYTHON`, default `../../python/.venv/Scripts/python.exe`).
- Kernel and solver binaries are rebuilt only when their sources change, on
  Linux or WSL: `kernel-build/build.sh`, `solver-build/build.sh`. Commit
  `workspace/**/*.wasm` only on version bumps.

## Separation rules

- The core never imports the plugin, and the plugin never imports core code:
  the page talks to the app only through `@magnusim/workspace` (the bridge),
  wrapped in `src/lib/bridge.ts`.
- `plugin.py` is the only `.py` file (`python/tools/plugin_boundary.py` checks
  every `.py` in the plugin; `node_modules/` holds none today).
- React, React DOM, the bridge and the UI kit (`@magnusim/plugin-ui`) come
  from the host's import map; they are never bundled. The unit tests run the
  kit's own source (`vitest.config.ts` alias). Workers get no import map: worker modules are self-contained.
- The frame has no localStorage, IndexedDB or cookies, no `/api/`, no popups
  and no `alert`/`confirm`. Saved state goes through the bridge.
- No change in the core is needed to build or run the plugin. The host
  features it uses (plugin files with etags, unsaved-work questions, frame
  focus, off-by-default plugins, the UI kit) are generic host API 1.2 and
  1.3, listed in `ARCHITECTURE.md` §9.
- Dependencies must be GPL-3.0-compatible; code from AGPL projects or
  jsketcher is never copied.
