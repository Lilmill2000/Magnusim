# Writing a Magnusim plugin

A plugin adds or replaces one aspect of the workbench. Drop a folder in `plugins/` or install a wheel that publishes a `cfddesk.plugins` entry point, then restart. The host loads `register(hub)` for Python and, when the manifest names a UI bundle, `register(host)` for the page.

Copy `templates/plugin/` to start. That folder has `pyproject.toml`, `manifest.toml`, `register()`, and a pytest that loads the copy from a temporary `plugins/` directory.

## Manifest 1.2

```toml
key = "my-plugin"
name = "My plugin"
version = "0.1.0"
api_version = "1.2"
license = "GPL-3.0-or-later"
description = "What this plugin adds"
authors = "Your Name"
requires_plugins = ["incompressible_flow>=1.0"]
ui = "ui"
ui_entry = "index.js"
```

`api_version` must share the host major version (`1`). A different major is listed as `incompatible` and is not registered. `authors` is a comma-separated list when you have more than one. Omit `ui` when the plugin has no browser bundle. `license` is an SPDX identifier and is shown in Settings → Plugins. The manifest `key` may differ from the folder name; the UI is still served from the folder.

`overrides` is a comma-separated list of `kind:key` tokens. A plugin may replace a protected builtin only when that token is listed. New keys do not need an override.

`requires_plugins` lists the plugins yours builds on, as `key` or `key>=version`. They load first; when one is missing, off, or too old, your plugin is not loaded and Settings → Plugins says which one it needs. Declare `incompressible_flow` when you clone or extend `incompressible_steady` / `incompressible_transient`: those simulation types come from the bundled Incompressible Flow plugin, not from the core.

Plugins that ship with the app live in `bundled-plugins/` and add `tier = "bundled"`, `required = true|false` and `protected = ["kind:key", ...]` (specs other plugins may not drop). A required plugin cannot be turned off. An optional one can ship off with `default_enabled = false`: nothing of it runs, and existing projects look unchanged, until someone turns it on in Settings → Plugins. See `compatibility.md` for what changed in each API version.

A wheel's entry point belongs in `pyproject.toml` once the register function is importable:

```toml
[project.entry-points."cfddesk.plugins"]
my-plugin = "my_plugin.plugin:register"
```

Use your own package name (the template maps its folder to `magnusim_plugin_template`). A bare `plugin:register` would collide with every other plugin built the same way.

Folder discovery loads `plugins/<folder>/plugin.py` and does not need that table.

## Register

`register(hub)` runs after the builtins and the bundled plugins. Clone a spec that is already on the hub and register it under a new key:

```python
from dataclasses import replace

from cfddesk.registry.manifest import PluginManifest


def register(hub):
    steady = hub.registry("analysis").get("incompressible_steady")
    spec = replace(steady, key="my_steady", label="My steady")
    hub.registry("analysis").register(spec, plugin="my-plugin")
    return PluginManifest(key="my-plugin", name="My plugin", version="0.1.0")
```

Hooks use the same module. `get_hooks().on("case.written", fn, plugin="my-plugin")` runs after the case files exist. `ctx.out_dir` is the case directory.

Do not import `cfddesk.builtin`, `scripts`, or `src.workbench`. Those are host internals. The public surface is `cfddesk.registry` and `magnusim_sdk` (OpenFOAM dictionary and field writers, units, job events, gmsh helpers, the MSH 2.2 writer, and `run_exe` for programs with a timeout). `tools/plugin_boundary.py` checks this.

The check reads every `.py` and `.pyw` file of the plugin except those in `tests/`, `node_modules/`, `__pycache__/`, `site-packages/`, dot folders (`.venv`, `.git`, caches), `*.egg-info`, any virtualenv (a folder holding `pyvenv.cfg`), and `build/` or `dist/` at the plugin root, so a plugin may carry a JavaScript toolchain or a local venv. Plugin code must not import from those folders: the check follows each import segment by segment and reports one that reaches a skipped folder, and its report lists what it skipped. A compiled `.pyc` outside `__pycache__/` is refused (ship sources), and a file that is not valid Python 3 is reported, not skipped. A plugin's own ruff config may use `extend-exclude`, never `exclude` (that would replace the default list and lint `node_modules`).

## Own environment and service (1.1)

A plugin that needs Python packages the app does not ship (NeuralFoil, a CAD kernel, ...) declares its own environment. Its backend then runs there, in its own process, and never in the core:

```toml
[python]
requirements = "requirements.lock"   # pinned, with hashes
python = ">=3.10,<3.13"              # the interpreters it supports
service = "my_plugin_service"        # its backend module (optional)
find_links = "wheels"                # a folder of wheels in the plugin, to install offline (optional)
```

- **The lock** lists every package, pinned and hashed (`pip-compile --generate-hashes`, or `name==1.2.3 --hash=sha256:...` lines); pip installs it with `--require-hashes`, wheels only. Editing the lock changes its hash, and the plugin shows "Needs setup" again.
- **Settings → Plugins** shows the plugin as "Needs setup" until someone clicks **Install dependencies** (on this PC only). The environment is built from the app's interpreter into `.cache/plugin-envs/<key>-<lock hash>/` and gets `magnusim_sdk` and nothing of the core: `import cfddesk` fails there, and the app's own packages never change. `Setup.bat -Plugins` builds the environments of bundled plugins that are on.
- **The service module** registers its methods; the page reaches them at `/api/plugin/<key>/<method>`:

```python
from magnusim_sdk.data import PluginData
from magnusim_sdk.service import method


@method("polar", timeout_s=120)
def polar(params, scope):
    data = PluginData(scope["project_dir"], scope["plugin"])  # its own folder in the project
    ...
    return {"cl": cl}
```

  A method gets the request's `params` and a `scope` (`plugin`, `project_id`, `project_dir`, `simulation_id`, `geometry_id`), returns something JSON can carry, and raises to fail the call with its message. Calls run one at a time; each has 30 s unless `timeout_s` says otherwise (600 at most). A call that runs longer ends the service and everything it started; a crash is reported and the next call starts it again; it stops after 10 minutes without calls. Print freely: the service's stdout goes to the log, not into replies.
- **Jobs** run on the plugin's environment when their `JobKind` says `python="plugin"` (in the plugin's folder); filter tools of a plugin with an environment run there too. Stopping a job stops everything its tool started.
- **Studies**: when a `[[study_kinds]]` entry's `schema_version` goes up, a service method `migrate_study` gets `{"study", "from_version", "to_version"}` for each older study and returns the upgraded record; the host stores it (rev-checked) with the new `schema_version`. It runs in the background: the tree shows the study as it was until the upgrade lands.
- **register()** still runs in the core, to declare specs, jobs and study kinds. Keep it free of your environment's packages: they are not importable there.

## Simulation types (analysis contract 1.1)

An `AnalysisType` tells the core everything it needs through optional contract fields (`cfddesk.registry.contract`), so the core never reaches into its physics:

- `family`: the Create Simulation title, description and tags, shared with a sibling analysis (steady and transient of the same physics).
- `study_defaults(time_dependency)`, `algorithm_label`, `residual_keys`, `x_axis`, `ui`.
- `validate_ready(ctx)`: what still blocks a run, as `[{"message", "fix"}]`. The Run panel shows the message.
- `run_model`: run settings defaults, clean-up and the preview numbers (for example the time step).
- `write_case(ctx)`: writes the case; `ctx.simulation` holds the study's settings.
- `launch` (or the default solver's `SolverApp`): the program, which frames to keep (`all` or `latest`), the process names Stop looks for, and `frame_fields` (fields that mark a written frame).
- `log_parser`: `module:factory` of the parser that turns the solver's output into job events.

`python/tests/fixtures/plugins/stub-analysis` is a complete example: a steady scalar-diffusion analysis on `laplacianFoam`, written with `magnusim_sdk` only.

## UI

Build the browser bundle with `react`, `react-dom`, and `@cfddesk/plugin-api` marked external. The host passes one React and one plugin API object:

```javascript
export function register(host) {
  const React = host.React;
  host.pluginUi.registerPanel({
    key: "my-plugin",
    title: "My plugin",
    place: "prefs",
    Component() {
      return React.createElement("p", null, "Hello");
    },
  });
}
```

`host` is `{ React, ReactDOM, pluginUi, scope }`. `scope` is the open project's scope id. In-page UI has no import map (workspaces do, below). A thrown `register` or a thrown panel is a Plugins-tab row and a toast. Builtins stay loaded.

`pluginUi` can register a panel, replace a host panel, add a filter widget, add a schema field widget, or add a tree transform. Tree nodes must carry the current project scope or the tree drops them.

A panel's `place` is `"filters"` (the Filters panel) or `"prefs"` (your row in Settings → Plugins). Those are the only places the app draws. The older names `tree`, `toolbar`, `results` and `geometry` were never shown; registering there now fails and your plugin shows an error row.

`registerFieldWidget(name, Component)` renders any schema field whose `x-cfddesk.widget` is `name` with your component.

Everything your `register(host)` adds is recorded under your plugin key. Disabling the plugin removes it at once, and reloading replaces it instead of adding a second copy.

## Workspaces (1.1)

A panel fits in the workbench; a tool with its own screens (an airfoil polar bench, a sketcher) gets a **workspace**: a full page you draw yourself, opened from one of your study kinds. The app keeps the header (Back to project, `<Your plugin> › <Study>` with rename, Queue, Settings) and puts your page under it, over the project's workbench.

```toml
[[workspaces]]
key = "bench"
title = "Bench"
icon = "M4 5h16v14H4z M4 9h16"      # one SVG path, 24 x 24
entry = "workspace/index.html"      # an .html file in workspace/

[[study_kinds]]
key = "bench_case"
title = "Bench case"
icon = "M5 19V5h14v14z"
workspace = "bench"                 # a study of this kind opens there
```

The host serves your `workspace/` folder, and only that folder, to the frame. The study's row in the tree opens it, and so does the header's Workspaces menu (New Bench case). The link `#/p/<project>/ws/<plugin>/<workspace>/<study>` reopens it after a reload.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="./bench.css" />
    <script type="module" src="./main.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
```

```javascript
// main.js
import { connect } from '@magnusim/workspace';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

const ws = await connect();                     // context: plugin, project, study, units, theme
const study = await ws.study.get();
createRoot(document.getElementById('root')).render(createElement('h1', null, study.title));
const polar = await ws.service('polar', { alpha: 4 });  // your backend
await ws.data.write(`studies/${study.id}/polar.json`, polar);
await ws.study.update({ last_alpha: 4 }, study.rev);   // refused if another tab saved first
```

- **Imports.** The host puts an import map in your page for `react`, `react-dom/client`, `react/jsx-runtime` and `@magnusim/workspace`. Import those names; do not ship your own React. If you bundle your code, mark them external and emit ES modules. The versions are in `docs/plugins/plugin-sdk.json`. For types, copy `docs/plugins/workspace-sdk.d.ts` into your plugin.
- **Styles.** `/plugin-sdk/theme.css` is loaded before your own CSS: use its `--mg-*` tokens (colours, type, spacing, radii, shadows) so the page matches the app.
- **The sandbox.** The page runs in a sandboxed frame with an opaque origin. Its Content-Security-Policy allows scripts, styles, fonts, images and `fetch` only from `/plugin-sdk/` and your own `workspace/` folder, plus `data:` and `blob:` images:
  - No inline `<script>`: put code in module files.
  - No `/api/`: use `ws.service`, `ws.data`, `ws.study` and `ws.jobs`.
  - No `localStorage`, IndexedDB or cookies: keep state in `ws.data` (JSON, 8 MB a file), `ws.files` (any file, within your `[files]` limits) or the study.
  - Workers: `ws.spawnWorker(new URL('./worker.js', import.meta.url))`. You can post to it at once; messages are held until your module has loaded.
  - WebAssembly from your folder: `WebAssembly.instantiateStreaming(fetch(new URL('./x.wasm', import.meta.url)))`.
- **Bridge calls** are allowed only for your plugin, this project and this study; `compatibility.md` lists them all. Anything else is refused with "not allowed: …". `ws.on('units', fn)` follows the user's unit choice; `ws.on('study', fn)` gets the study after a rename in the header (save next with its `rev`, or with `ws.context.study.rev`, which follows); `ws.ui.toast`, `ws.ui.confirm` and `ws.ui.prompt` use the app's own; `ws.nav.back()` closes the workspace.
- **Starting.** Call `connect()` as soon as the page loads. A page that has not connected within 5 s shows the user "<Your plugin> didn't start." with Try again.
- **Checking the host (1.2).** Everything below needs host 1.2. Check `ws.context.hostVersion` (compare the numbers) and set `api_version = "1.2"`; a 1.1 host refuses the new calls with code `not_allowed`.
- **Big and binary files (1.2).** `ws.files` keeps any file in your plugin's folder of the project, the same folder `ws.data` and your Python see. A write is streamed in chunks and replaces the file only once every byte has arrived. Pass the `etag` you read as `ifMatch` so a write never overwrites a version saved from another tab (it rejects with code `changed`), or `ifMatch: null` to only create:

  ```toml
  [files]                 # what your workspace may keep in one project
  max_file_mb = 256       # one file (default 64)
  max_total_mb = 1024     # everything in your folder (default 512)
  ```

  ```javascript
  const model = await ws.files.stat(`studies/${study.id}/model.bin`);
  const saved = await ws.files.write(`studies/${study.id}/model.bin`, bytes, {
    ifMatch: model ? model.etag : null,
    onProgress: (done, total) => bar.set(done / total),
  });
  const back = await ws.files.read(`studies/${study.id}/model.bin`); // ArrayBuffer, or null
  ```

  Your service and jobs reach the same files through `magnusim_sdk.data.PluginData` (`from_scope(scope)` in a service method, `from_env()` in a job): `read_bytes`, `write_bytes`, `atomic_path` (a temp path for a mesher or exporter, replaced in one step), `list_files`, `delete_file` and `file_info`, whose `etag` matches the workspace's. Paths follow one set of rules everywhere (`compatibility.md`); a study's own `study.json` changes only through `ws.study`.
- **Unsaved work (1.2).** Call `ws.nav.setDirty(true, 'Sketch 2 is not saved')` on the first change that is not saved yet, and `ws.nav.setDirty(false)` once it is. While it is set, and while a `ws.files.write` is on its way, every way out of the workspace asks the user first, with your plugin's name and your message, and closing the browser tab shows the browser's own prompt. `ws.nav.back()` resolves `false` when the user stays; clear the flag first to leave without a question. Never reload your own page while dirty: a reload clears the flag and loses the work. If your page accepts dropped files, call `preventDefault()` on `dragover` and `drop`, or the browser opens the file in place of the app.
- **Keyboard and full screen (1.2).** Your page has the keyboard when it connects and again after the app's dialogs and Settings close; listen on `window` or `document`. `document.documentElement.requestFullscreen()` from a click or key handler covers the whole screen; Esc always leaves, and the app leaves full screen before it shows a dialog. The app's toasts are not seen over a full-screen page.

`python/tests/fixtures/workspace-plugins/ws-demo` is a complete example (modules, React, WebAssembly, a worker, service calls, data and study saves), driven by `e2e/h13-workspace.spec.js`.

## Plugins tab

Settings → Plugins lists each plugin's name (or key), version, source (`bundled` from `bundled-plugins/`, `local` from `plugins/`, or `entry_point` for a wheel), and status:

- `enabled`, shown as On, or as Required for a required plugin, which has no Disable button.
- `disabled`, shown as Off. An optional bundled plugin that ships off (`default_enabled = false`) is listed this way with "Ships with Magnusim and stays off until you turn it on."
- `needs setup`: its own environment is not installed on this PC yet; the row has **Install dependencies**.
- `missing requirement`: a WSL program or Python package in its `requires` is not found; its page UI and workspaces do not load. A missing GPU is only a note on an `enabled` row.
- `incompatible`: its `api_version` has a different major.
- `error`, shown as Failed to load, with the message (a manifest or `register` failure, a missing required plugin, or a UI bundle that failed in the page).

Enable and Disable call the plugin routes, reload the registry, and load or remove the plugin's UI at once. **Reload plugins** runs `registry.reload` and loads UI bundles again.

## License

Magnusim is GPL-3.0-or-later. A plugin runs inside the Magnusim Python worker and page, so a distributed plugin is part of a GPL-3.0-or-later combined work. License it under GPL-3.0-or-later or a GPL-compatible license such as MIT, BSD, Apache-2.0, or LGPL-3.0. The template declares GPL-3.0-or-later.

## Registry reference

`docs/plugins/registry.json` lists the keys Magnusim itself registers: analysis, solver, mesher, boundary condition, material, monitor, and filter. It holds builtins only; your plugin's keys never appear in it, and the app reads them from the live registry while it runs. `npm run gen:registry` (from `magnusim-web/`) regenerates it together with `scripts/generated/registry.json`.
