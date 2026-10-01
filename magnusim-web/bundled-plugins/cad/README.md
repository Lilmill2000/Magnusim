# Magnusim CAD

A parametric part modeler (SolidWorks and Fusion style) that runs as
Magnusim's **Part** workspace. It is an optional bundled plugin that ships
off (`default_enabled = false`): until someone turns it on in Settings >
Plugins (Enable), nothing of it runs and projects look as they did. Once on, a
project's STUDIES section offers **+ New Part**, and a Part opens in its own
full-page workspace over the workbench. Today (phase P1) a Part is made of boxes and
cylinders, joined, cut or intersected, with named parameters; sketches,
extrudes and STEP editing are later phases. The description in `manifest.toml`
(shown in Settings > Plugins) names only what ships: update it as features land.

It needs Magnusim's host API 1.2: a Part's model is saved with `ws.files`
(etag-checked writes, so two tabs never overwrite each other), and while a
change is not saved yet the app asks before leaving the workspace. On a 1.1
host it falls back to `ws.data`.

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
| `e2e/` | Playwright tests against the host app (`e2e/host-server.mjs` starts it). |
| `scripts/` | `build.mjs` (page + workers), `e2e.mjs` (build + e2e under a lock). |
| `ARCHITECTURE.md` | Areas, contracts and rules for anyone changing the code. |

## Build and test

The plugin has its own toolchain; the core's lint, typecheck and tests never
see `src/`, and the core's `npm test` does not run these: run them here
before every commit (they are not in the repository's CI yet).

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
npm run test:kernel    # the kernel gates in Node (fixtures/kernel)
```

- `npm run test:e2e` starts the host app from this checkout
  (`e2e/host-server.mjs`: a temp projects root and prefs, no user plugins, a
  free port from 8170 (or `CAD_E2E_PORT_FROM`) with +11..+13 also free, a
  private Vite dependency cache). CAD ships off: the tests turn it on the way
  Settings' Enable does, and the P1 gate's first test checks it is Off on a
  fresh install. Set
  `CAD_E2E_BASE_URL` to use a server that is already running, or
  `CAD_E2E_LOCK=<file>` to share one server between several runs (a live
  server named in the lock is reused).
- Kernel and solver binaries are rebuilt only when their sources change, on
  Linux or WSL: `kernel-build/build.sh`, `solver-build/build.sh`. Commit
  `workspace/**/*.wasm` only on version bumps.

## Separation rules

- The core never imports the plugin, and the plugin never imports core code:
  the page talks to the app only through `@magnusim/workspace` (the bridge),
  wrapped in `src/lib/bridge.ts`.
- `plugin.py` is the only `.py` file (`python/tools/plugin_boundary.py` checks
  every `.py` in the plugin; `node_modules/` holds none today).
- React, React DOM and the bridge come from the host's import map; they are
  never bundled. Workers get no import map: worker modules are self-contained.
- The frame has no localStorage, IndexedDB or cookies, no `/api/`, no popups
  and no `alert`/`confirm`. Saved state goes through the bridge.
- No change in the core is needed to build or run the plugin. The host
  features it uses (plugin files with etags, unsaved-work questions, frame
  focus, off-by-default plugins) are generic host API 1.2, listed in
  `ARCHITECTURE.md` §9.
- Dependencies must be GPL-3.0-compatible; code from AGPL projects or
  jsketcher is never copied.
