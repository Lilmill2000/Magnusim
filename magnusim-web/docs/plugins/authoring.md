# Writing a Magnusim plugin

A plugin adds or replaces one aspect of the workbench. Drop a folder in `plugins/` or install a wheel that publishes a `cfddesk.plugins` entry point, then restart. The host loads `register(hub)` for Python and, when the manifest names a UI bundle, `register(host)` for the page.

Copy `templates/plugin/` to start. That folder has `pyproject.toml`, `manifest.toml`, `register()`, and a pytest that loads the copy from a temporary `plugins/` directory.

## Manifest 1.6

```toml
key = "my-plugin"
name = "My plugin"
version = "0.1.0"
api_version = "1.6"
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

**Your own environment's packages.** A plugin with a `[python]` environment (below) may also import the packages its lock pins, but only in code that runs on that environment:

- its service module;
- its job tools registered with `python="plugin"`;
- its own modules that only those two import.

Code the host loads keeps the rule above: `plugin.py`, every module it imports (with `from pkg import *`, the submodules `pkg.__all__` names), every log parser module a `LogParserRef` names (the core imports it on its own Python), and job tools that run on the core's Python. A module that both sides import counts as host code. The check places a job only when `JobKind(...)` goes straight into `hub.register_job(...)` with its tool path and `python=` as plain strings, and a log parser only when its module is a plain string. If host code registers a job or names a log parser any other way (a variable, a loop, `dataclasses.replace`, an alias of `JobKind`, `setattr`), nothing counts as environment code.

To know what a lock provides, the check reads the built environment's `top_level.txt` and `RECORD` files. Without a built environment, it uses each package's normalized name plus a short table of known differences (`scikit-learn` is `sklearn`, `pillow` is `PIL`: `IMPORT_NAMES` in `tools/plugin_boundary.py`). A lock never provides `cfddesk`.

`importlib.import_module("x")` and `__import__("x")` count as `import x`, whether called by those names, through `from importlib import import_module as im` or `from importlib import *`, or as `<anything>.import_module(...)`. A relative name is read against `import_module`'s `package` (a string or `__package__`) or, for `__import__`, the file's own package. These are errors, because the check cannot tell what they load: such a call whose module name, package, level, globals or fromlist is not written out; an import function used other than as a direct call (`im = importlib.import_module`, `getattr(importlib, "import_module")`); `exec`, `eval` and `compile`; `runpy.run_module`/`run_path`; and a loader's `exec_module`. Relative imports in `plugin.py` are errors too: the host runs it as `cfddesk._bundled.<folder>`, so `.` and `..` there are the core's packages. Elsewhere, a relative import that climbs above the plugin's top-level package is an error. Nothing turns the check off for a line.

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

An `AnalysisType` needs only `key`, `label`, `category`, `time_dependency` and `fields` (API 1.4; the other fields default to empty). It tells the core everything else through optional contract fields (`cfddesk.registry.contract`), so the core never reaches into its physics. Keep a choice such as a turbulence model in your own `settings_schema`: its defaults fill the new-study settings that `study_defaults` leaves out.

- `family`: the Create Simulation title, description and tags, shared with a sibling analysis (steady and transient of the same physics).
- `study_defaults(time_dependency)`, `algorithm_label`, `residual_keys`, `x_axis`, `ui`.
- `validate_ready(ctx)`: what still blocks a run, as `[{"message", "fix"}]`. The Run panel shows the message.
- `run_model`: run settings defaults, clean-up and the preview numbers (for example the time step).
- `write_case(ctx)`: writes the case; `ctx.simulation` holds the study's settings.
- `launch` (or the default solver's `SolverApp`): the program, which frames to keep (`all` or `latest`), the process names Stop looks for, and `frame_fields` (fields that mark a written frame).
- `launch` (API 1.5) may also say `serial_below_cells` (the cell count under which a run is serial; `None` keeps 200000 steady and 50000 transient) and `prepare_job`: the key of your own `JobKind` that writes a run's case into `MAGNUSIM_CASE_DIR` (`""` lets the builtin `solve.prepare` call your `write_case`). Such a job reaches the core through `cfddesk.registry.run_case`: `case_dir_problem` (refuse any folder but the run's own case folder), `run_inputs`, `ready_context`, `write_case` and `stamp_prepare_report`. Print `stage` event lines as it goes and exit 3 when the run is not ready.
- `live_metrics` (API 1.5): the per-step numbers the Run panel's progress line shows after the time, as `{key, label, format: "time" | "sig2", max_key?}` rows (for example `{"key": "co_mean", "label": "Co", "format": "sig2", "max_key": "co_max"}`). Leave it `None` to keep the Δt and Co text of a transient run.
- `log_parser`: `module:factory` of the parser that turns the solver's output into job events.
- `kinematic_fields` (API 1.4): the fields your cases store divided by density (pressure in an incompressible case), shown times `rho`. The core writes them in the case's `w27-case.json` unless `write_case` listed its own; leave it `None` to say nothing (a case with no list is read as `["p"]`).
- `monitor_quantities` (API 1.4) and `run_monitors(case_dir)`: what the Graphs panel's monitors show. Each `MonitorQuantity` reads one value of the series points (`sample`) and gives its label, unit and colour, and whether it is plotted, listed in a monitor's details, shown as a headline or exported as a CSV column. `run_monitors` returns the monitor rows (each with a `key`, a `default_quantity` and series points `{t, <sample>: value}`) and a `summary` line. The page formats and plots only what these say. A `MonitorType` with `user_creatable=True` is offered in the Monitors dialog.
- `result_fields`: what your runs' results show, as `ResultField(key, label, unit_quantity, kind, unit, magnitude_label)` rows. Every results tool (colouring, iso surface and volume, plot over path, cutting planes, particle trace, inspect, views, legends) lists these in your order, those the frame wrote, with your labels and units; nothing else is shown for your runs. Give a velocity vector `unit_quantity="velocity"`: particle trace and vector glyphs follow the first one, and are off for a case without one. A case you write yourself can carry the list as `result_fields` in its `w27-case.json` (the core adds it after `write_case` when it is missing).

`python/tests/fixtures/plugins/stub-analysis` is a complete example: a steady scalar-diffusion analysis on `laplacianFoam`, written with `magnusim_sdk` only.

## Boundary conditions and materials (1.4)

The Boundary Conditions and Materials panels show what the registry holds, so a plugin can add its own.

A BC has two parts. A `BcTypeSpec` (kind `bc`) is one variant the case writer knows: its `semantic` (`inlet`, `outlet` or `wall`), its `patch_type` and its writers for `U` and `p`. A `BcFamily` (kind `bc_family`) is what the user picks: its `label`, `hint` and `color`; the `record_type` a saved BC stores in `bc_type`, and older `aliases`; its `variants` (BC type keys, the first the default); a new BC's `defaults` per unit system; the `values` rows that say which fields carry units; the `fields` of its generic editor; the `ui` component that replaces that editor; and `resolve`, which turns a saved BC into its variant key and SI settings for the case writer. Each variant names its `family` and the record values that select it (`match`).

```python test
from cfddesk.registry import BcFamily, BcTypeSpec, validate_bc_families
from cfddesk.registry.discovery import RegistryHub
from cfddesk.registry.schema import SchemaField


def write_symmetry(name, settings, ctx):
    return "        type            symmetryPlane;\n"


def register_bcs(hub):
    hub.registry("bc").register(
        BcTypeSpec(
            key="symmetry_plane",
            label="Symmetry",
            semantic="wall",
            patch_type="patch",
            write_U=write_symmetry,
            write_p=write_symmetry,
            family="symmetry",
        ),
        plugin="my-plugin",
    )
    hub.registry("bc_family").register(
        BcFamily(
            key="symmetry",
            label="Symmetry",
            record_type="Symmetry",
            hint="Mirror plane: no flow through it",
            variants=("symmetry_plane",),
            defaults={"metric": {"mirror": "Plane"}, "imperial": {"mirror": "Plane"}},
            fields=(SchemaField("mirror", "Mirror", "choice", default="Plane", choices=("Plane", "Wedge")),),
            resolve=lambda record: ("symmetry_plane", {}),
        ),
        plugin="my-plugin",
    )


hub = RegistryHub()
register_bcs(hub)
validate_bc_families(hub)  # the check the host runs once every plugin has registered
(row,) = hub.registry("bc_family").describe()
assert row["record_type"] == "Symmetry" and row["variants"] == ["symmetry_plane"], row
```

After every plugin has registered, each family's variants must be registered BC types and each BC type's `family` a registered family; a plugin that breaks this is unloaded with the reason on its Settings row. An analysis offers BCs through its `bc_types`: clone one as in Register and add your variant (`python/tests/fixtures/bc-plugins/example-extra-bc` does both). Its studies' BC panel then lists every family with a variant among them. With `ui` empty, the editor is a form built from `fields`. For an editor of your own, name it in `ui` and register the component from your UI:

```javascript
host.pluginUi.registerBcSettings("my-plugin.bc", MyBcEditor, { facesNote: MyFacesNote });
```

It gets `BcSettingsProps` (`src/plugin-api/slots.ts`): the saved `bc`, its `family` row, `imperial`, the assigned `faces`, `save(patch)` and `flowBasis(faces)` (one face's mean area and the fluid's density). `facesNote` is optional and is drawn under the assigned faces. Incompressible Flow's seven BC types and four families are protected: build on them, never drop them. `cfddesk.case.bc_registry` and `cfddesk.case.bc_menu` are 1.x shims kept for older code; read the registry instead.

A `MaterialModel` (kind `material`) gives the Materials panel its fluids and fields: `properties_schema` (the number rows; a field's `quantity` gives its Imperial unit), `library` (the presets, rows of `key`, `name`, `values`, `library`, `codes`, `names` and optional `legacy_values`), `record_keys` (the record keys that hold each property), `record_constants` (what every record carries) and `custom_preset` (the preset a record has once the user types their own values). An analysis names its model in `material_models`. A saved material keeps its numbers; `compatibility.md` (1.4) has the rule that matches a record to its preset. Incompressible Flow's `newtonian_incompressible` (`bundled-plugins/incompressible_flow/incompressible_flow/materials.py`) is a complete example.

## UI

The page has no import map, so how a UI gets React and the UI kit depends on its `ui_entry`:

- **A prebuilt `.js` UI imports nothing bare.** Bundle your own files into it, and use `host.React`, `host.ReactDOM` and `host.pluginUi.kit` for React and the kit.
- **A `.tsx`, `.ts` or `.jsx` UI** is bundled by the host. It may import `react`, `react/jsx-runtime`, `@magnusim/plugin-ui` and its own files in `ui/`; the host resolves `react` and the kit to the page's own copies.

Either way the host passes one React and one plugin API object:

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

`registerFieldWidget(name, Component)` renders any schema field whose `x-cfddesk.widget` is `name` with your component. `registerStudySettings`, `registerRunSettings` and `registerBcSettings` fill the study, run and BC editors' settings slots (above, and `compatibility.md`).

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

- **Imports.** The host puts an import map in your page for `react`, `react-dom/client`, `react/jsx-runtime`, `@magnusim/workspace` and `@magnusim/plugin-ui` (the UI kit, below). Import those names; do not ship your own React. If you bundle your code, mark them external and emit ES modules. The versions are in `docs/plugins/plugin-sdk.json`. For types, copy `docs/plugins/workspace-sdk.d.ts` (and `docs/plugins/plugin-ui.d.ts` for the kit) into your plugin.
- **Styles.** `/plugin-sdk/theme.css` is loaded before your own CSS: use its `--mg-*` tokens (colours, type, spacing, radii, shadows) so the page matches the app. `/plugin-sdk/plugin-ui.css`, the kit's styles, is loaded after `theme.css`.
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

  Your service and jobs reach the same files through `magnusim_sdk.data.PluginData` (`from_scope(scope)` in a service method, `from_env()` in a job): `read_bytes`, `write_bytes`, `atomic_path` (a temp path for a mesher or exporter, replaced in one step), `list_files`, `delete_file` and `file_info`, whose `etag` matches the workspace's. Paths follow one set of rules everywhere (`compatibility.md`); a study's own `study.json` changes only through `ws.study`. The output of your OpenFOAM cases (1.3: frames, logs, `postProcessing`, the mesh) lands in the same folder and counts toward `max_total_mb` too; a run is not cut short at the limit, but later writes and submits are refused until you delete old cases.
- **Unsaved work (1.2).** Call `ws.nav.setDirty(true, 'Sketch 2 is not saved')` on the first change that is not saved yet, and `ws.nav.setDirty(false)` once it is. While it is set, and while a `ws.files.write` is on its way, every way out of the workspace asks the user first, with your plugin's name and your message, and closing the browser tab shows the browser's own prompt. `ws.nav.back()` resolves `false` when the user stays; clear the flag first to leave without a question. Never reload your own page while dirty: a reload clears the flag and loses the work. If your page accepts dropped files, call `preventDefault()` on `dragover` and `drop`, or the browser opens the file in place of the app.
- **Keyboard and full screen (1.2).** Your page has the keyboard when it connects and again after the app's dialogs and Settings close; listen on `window` or `document`. `document.documentElement.requestFullscreen()` from a click or key handler covers the whole screen; Esc always leaves, and the app leaves full screen before it shows a dialog. The app's toasts are not seen over a full-screen page.

`python/tests/fixtures/workspace-plugins/ws-demo` is a complete example (modules, React, WebAssembly, a worker, service calls, data and study saves), driven by `e2e/h13-workspace.spec.js`. To start a workspace plugin of your own, copy `templates/plugin-workspace/`.

### OpenFOAM cases and solve hooks (1.3)

A workspace can run an OpenFOAM case it wrote in its study's folder: the host runs it in WSL on the app's one compute slot (it may wait in the queue behind a mesh or a solve), streams its progress to the page, and can show its results in the project's 3D view.

```javascript
const ws = await connect();
// Write the case with ws.files (or your service) under studies/<sid>/cases/c1, then:
const { id } = await ws.compute.submitOpenFOAM({
  caseRel: 'cases/c1',                       // inside this study's folder; a case runs once
  app: 'pimpleFoam',                         // a registered solver, as controlDict names it
  pre: [{ tool: 'blockMesh' }],              // WSL steps before the solver
  results: { kinematicFields: ['p'], rho: 1.2 },
});
ws.compute.events(id, (ev) => {
  if (ev.event === 'progress') plot.add(ev.points);
  if (ev.event === 'end' && ev.status === 'done') ws.results.openIn3D('cases/c1');
});
```

`compatibility.md` (1.3) has the rules: the calls, the case and `controlDict` rules, the table of WSL steps and their arguments (meshing utilities and parallel spans included), the events, Stop, what happens when the plugin is turned off or the app restarts, and the codes. `python/tests/fixtures/foam-plugins/foam-demo` is a complete example, driven by `e2e/h15-submit-openfoam.spec.js`.

Your plugin's Python can also follow every solve, core runs included: `solve.prepare`, `solve.parse_line` (batches of solver output lines) and `solve.stop`, registered with `get_hooks().on(name, fn, plugin=KEY)` in `register(hub)`. They run inside the solve's relay process, never slow the solve, and are dropped for the run when they take too long or raise; `compatibility.md` lists what they are told and their limits.

## Start actions (1.4)

A study kind with a workspace can have a **start action**: a button that creates a study of that kind and opens it in its workspace. The host draws it in up to four places, the same way for every plugin:

| Place | What the user sees | At most |
|---|---|---|
| `empty_project` | A button under Add geometry in a project with no geometry, with your `hint` below it | 3 |
| `header` | A button in the project header, left of Workspaces. Its menu lists the project's studies of the kind (read-only ones marked), then "New <Kind>" | 3 |
| `new_project` | A radio under "Start from" in the New Project dialog, beside "Import geometry". A long list scrolls; the dialog opens at once and adds the radios when the app has read them | no limit |
| `home` | A button on Home, left of New project. It opens the New Project dialog with your action chosen and a title "Untitled <Kind> N" filled in, so one Create click makes the project and the study | 3 |

```toml
[[workspaces]]
key = "sketch"
title = "Sketch"
entry = "workspace/index.html"

[[study_kinds]]
key = "sketch"
title = "Sketch"
workspace = "sketch"            # a start action needs a kind with a workspace

[[start_actions]]
study_kind = "sketch"           # required: one of your kinds that has a workspace
label = "Start a sketch"        # required, 1-40 characters
hint = "Draw it here, then simulate it"   # optional, up to 120 characters
icon = "M4 8l8-4 8 4"           # optional, one SVG path; the default is the kind's icon
places = ["empty_project", "header", "new_project", "home"]   # optional; the default is all four
home_label = "New sketch"       # optional, 1-40 characters: Home's button text (default: label)
header_label = "Sketch"         # optional, 1-24 characters: the header button's text
```

- **The study.** A click makes a study named with the first "<Kind title> N" that no study of any plugin in the project, and no geometry, already has. There is no name prompt; the user renames it from the workspace header. The workspace then opens at `#/p/<project>/ws/<plugin>/<workspace>/<study>`. A button stays disabled from the click until the workspace opens or a notice shows. If the study cannot be made (your plugin was turned off meanwhile), the user sees "Could not create the study"; the project stays open (from the New Project dialog, the new project opens without the study).
- **Rules.** At most one start action per kind, and at most one `header` action per workspace. Texts are one line of plain text, with no control or bidirectional-override characters, and the manifest check never shortens them: a text that is too long is an error. On Home, in a window too narrow for every button, a start button's text ends in "…" and its tooltip has the whole text; New project always stays in view. The header button shows `header_label`, or else the workspace title, which must then be 24 characters or fewer. `header_label` needs `"header"` in `places`. A bad table fails only your plugin, with "manifest [[start_actions]]: …" on its Settings row.
- **Places a later host may add.** A name in `places` this host does not know is ignored, with a warning on your plugin's Settings row ("place 'toolbar' is not known to this app; ignored"), so a plugin written for a later host still loads. The table is an error only when no known place is left. Keys this host does not know are ignored.
- **Order and caps.** Places list actions in plugin load order (bundled plugins first, then the user's plugins folder), then manifest order, each place cut at its cap. A kind whose header button was cut stays in the Workspaces menu, and STUDIES shows it. A kind shown as a header button leaves the Workspaces menu. STUDIES stays hidden in a project that has no plugin study while every kind is a header button.
- **When nothing shows.** A plugin that is off, missing, needs setup or failed to load shows its actions nowhere. They come back without a reload once it is turned on in Settings → Plugins.
- **Older hosts.** A 1.3 host ignores `[[start_actions]]`: your kinds still open from the Workspaces menu and STUDIES. Set `api_version = "1.4"`.
- **`links_geometry` (parsed in 1.4, used from 1.5).** `links_geometry = true` on a study kind says its studies may link one project geometry ("Linking a geometry (1.5)" below). It must be `true` or `false`, and the kind must have a workspace.

`templates/plugin-workspace/` is a working starting point: a kind, a workspace page, and commented-out `[[start_actions]]` and `links_geometry` lines. `python/tests/fixtures/start-plugins/` has two complete examples, driven by `e2e/start-actions.spec.js`.

## Linking a geometry (1.5)

A study kind with `links_geometry = true` (and a workspace) can link **one project geometry per study**: its design becomes a geometry the simulation side uses like an imported part, and later saves of the design update it. The host does the same for every plugin; nothing in it knows what your plugin is.

**What your plugin does.** Export the saved design as one compound of solids in mm, as an OCCT BREP (binary, BinTools, or text, BRepTools), write it with `ws.files.write` (it returns the sha256), optionally write a face-name sidecar, then call `ws.project.linkGeometry`:

```ts test
import { connect } from '@magnusim/workspace';

const ws = await connect();
const sid = ws.context.study.id;
const shape = await ws.files.write(`studies/${sid}/export/part.bbrep`, new Uint8Array([1, 2, 3]));
const names = await ws.files.write(`studies/${sid}/export/face_names.json`, '{}');
const linked = await ws.project.linkedGeometry();
const study = await ws.study.get();
const sourceVersion = (Number(study.source_version) || 0) + 1;
await ws.study.update({ source_version: sourceVersion }, study.rev);
try {
  const r = await ws.project.linkGeometry({
    shape: { rel: shape.rel, format: 'brep', sha256: shape.sha256 },
    faceNames: { rel: names.rel, sha256: names.sha256 },
    sourceVersion,
    basedOnRev: linked ? linked.rev : null,
    onProgress: (p) => console.log(p.stage, p.ahead ?? ''),
  });
  console.log(r.change, r.rev, r.lost.length, r.claimedTwice.length);
} catch (e) {
  // "cancelled": the user kept editing (the app's question), or removed the update from
  // the Queue. Stay as you are; show no error.
  if ((e as { code?: string }).code !== 'cancelled') throw e;
}
ws.on('geometry', (g) => console.log('the linked geometry is now rev', g.rev));
```

**A file your plugin's Python wrote.** Each file is given by `sha256` (what `ws.files.write` returned) **or** by `etag`, exactly one of the two. A file your backend wrote (`magnusim_sdk.data`, with the sidecar from `magnusim_sdk.link.write_face_names`) never passes through the page: read its etag with `ws.files.stat` and link it by that. If the file changes between the stat and the link, the call is refused with `changed`.

```ts test
import { connect } from '@magnusim/workspace';

const ws = await connect();
const sid = ws.context.study.id;
// Your backend's own method wrote both files into the study's folder.
const out = (await ws.service('export', { study_id: sid })) as { shape: string; faceNames: string };
const shape = await ws.files.stat(out.shape);
const names = await ws.files.stat(out.faceNames);
if (!shape || !names) throw new Error('the export is missing');
const linked = await ws.project.linkedGeometry();
const study = await ws.study.get();
const sourceVersion = Math.max(Number(study.source_version) || 0, linked ? linked.sourceVersion : 0) + 1;
await ws.study.update({ source_version: sourceVersion }, study.rev);
await ws.project.linkGeometry({
  shape: { rel: out.shape, format: 'brep', etag: shape.etag },
  faceNames: { rel: out.faceNames, etag: names.etag },
  sourceVersion,
  basedOnRev: linked ? linked.rev : null,
});
```

- **The first call creates the geometry** (named after the study, or `name`). It is made like an import: it never waits for a running mesh or solve.
- **A later call** with the same bytes changes nothing (`change: 'none'`, at once). One that changes only names or labels updates it in place (`names`, the rev kept). One that changes the shape is an **update**: a queued job on the app's one compute slot (the page gets stage `queued` with the jobs `ahead` of it while a mesh, a solve or a plugin case runs), then `shape`, the rev + 1.
- **The app's question.** When the **shape** changed and a simulation study on the geometry has saved setup (a boundary condition, material, monitor or refinement, a generated mesh, a run with results), the app asks the user, in its own dialog over your page, the same for every plugin: **"Save as new geometry"** adds the part as a new geometry ("<Geometry> v2", "v3", ...) and can copy each study's setup onto it, faces matched by name; the old geometry and its studies, meshes and results stay exactly as they were and become a plain geometry. **"Overwrite <Geometry>"** is the update below. **"Keep editing"** changes nothing. Your call stays pending while the dialog is open. You write no code for it and cannot skip it: `linkGeometry` has no mode. After "Save as new" the result has `created: true` and a new `geometryId`, and `linkedGeometry()` names the new geometry. After "Keep editing" the call rejects with `cancelled`: **the user kept editing**, so stay as you are and show no error. A geometry nothing uses yet, a change of names only, and the first link never ask. If your page closes before the user answers, the geometry's row says "Waiting for your choice" with "Choose…".
- **An update rewrites the simulation setup once, at its commit.** Every boundary condition, material, refinement, monitor and run that can still start (every run but a finished one) of the geometry's studies keeps its faces by **name**, then by shape. The fields of your own BC families, BC kinds, monitor kinds and meshers that hold faces or bodies (widget `faces`, `patch` or `body`, or `holds`) are rewritten the same way: a face split in two keeps its boundary condition on both halves; a face that is gone stays listed on its record under "Lost faces" (with its label) and comes back when a later design has a face of that name again. Two boundary conditions whose faces merged into one keep neither until the user picks (`claimedTwice`). Bodies pair by `id`, then name, then index, so a body the user renames keeps its material. Generated meshes are out of date. The result lists all of it, and the host shows the user a report.
- **Save, then link.** `sourceVersion` names one saved design: a whole number that only goes up and is never shared by two designs. `basedOnRev` is the geometry rev the page last read (`linkedGeometry().rev`, `null` before the first link). An older design is refused (`stale`), and so is a call while the page says it has unsaved work (`unsaved`: call `nav.setDirty(false)` after saving). Write the reserved study key `source_version` after each save: the geometry's row says "Not up to date with <study>." while the saved design is newer than the linked one.
- **Byte-identical exports.** Two exports of one design must be byte-identical (the BREP and the sidecar), so a link that changed nothing costs nothing. `magnusim_sdk.link.write_face_names` writes the sidecar that way.
- **Refusals** carry `.code`: `unsaved`, `stale`, `changed` (a file's bytes or etag differ from what you passed), `outside_study`, `unsupported_format`, `bad_brep` (not a BREP this app reads, or a face outside every solid), `empty` (no solid), `bad_face_names` (the message says which rule), `preview_failed`, `plugin_needed` (a record of the geometry's studies belongs to a plugin that is off or not installed: the update would not know which of its fields hold faces), `busy`, `gone` (the geometry was removed), `superseded` (a newer link of the study replaced a queued one, or a question still open), `cancelled` (the user kept editing, or removed the update from the Queue: show no error), `failed`, `not_allowed`.
- **Nothing stops an update from a page.** `ws.jobs.stop` answers `not_allowed` for it; the user can remove a queued update from the Queue (`cancelled`).
- **Events.** `ws.on('geometry', fn)` tells the page of its own study when the geometry changed (this page's link or another tab's). A page of another study hears nothing.

**Formats.** 1.5 reads one: `format: 'brep'`, an OCCT BREP, binary or text, told apart by its header (OCCT 7.8 or later reads it; this app has 7.9.3). Any other value is refused with `unsupported_format`. A plugin with no OCCT (a scan, an STL/OBJ/PLY generator) cannot link in 1.5; a mesh format, whose faces are the app's own face groups, is the first follow-up.

**Face numbering** (the one rule; `compatibility.md` "1.5" states it per format). A face's `index` is its 1-based position in `TopExp_Explorer(shape, TopAbs_FACE)` over the whole compound, counting every visit: a face two touching solids share is visited once per solid, so it has one index per solid, each with its own `body`. A body's `index` is its 1-based `TopExp_Explorer(shape, TopAbs_SOLID)` order. A Python plugin calls `magnusim_sdk.link.face_visits(shape)`, the function the app itself uses.

**The face-name sidecar** (`face_names.json`, format `magnusim.face-names` version 1): `length_unit` must be `"mm"`; `shape_sha256` (the shape file's sha256, recommended) ties it to one export; `bodies` lists every solid once (`index`, optional `id`, `name`, `label`, `color`), with names and ids unique; `faces` lists every face visit once (`index`, `body`, optional `name`, `label`). `name` (1-200 characters) is the match key and is never shown when a `label` (1-120 characters) exists; several faces may share a name (the pieces of one split face). Faces and bodies are shown as "Label (face 12)" and "Label (Body2)".

```python test
import json
import tempfile
from pathlib import Path

from magnusim_sdk.link import check, face_visits, write_face_names
from OCP.BinTools import BinTools
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

box = BRepPrimAPI_MakeBox(10.0, 20.0, 30.0).Shape()
out = Path(tempfile.mkdtemp())
BinTools.Write_s(box, str(out / "part.bbrep"))
import hashlib

sha = hashlib.sha256((out / "part.bbrep").read_bytes()).hexdigest()
faces = [{"index": i, "body": b, "name": f"F:{i}", "label": f"Side {i}"} for i, b, _f in face_visits(box)]
write_face_names(out / "face_names.json", [{"index": 1, "id": "b1", "name": "Body 1", "label": "Fluid"}], faces, sha)
assert check(out / "part.bbrep", out / "face_names.json") == []
assert json.loads((out / "face_names.json").read_text(encoding="utf-8"))["faces"][0]["label"] == "Side 1"
```

From a shell (the same checks the app runs; exit code 0 when it would accept the pair): `python -m magnusim_sdk.link check part.bbrep face_names.json`.

**Schema fields that hold faces.** A boundary-condition kind's, monitor kind's or mesher's `SchemaField` with `widget="faces"`, `"patch"` or `"body"` is rewritten by an update like the host's own face lists; a field with your own widget says so with `holds="faces"` or `holds="body"` (published as `x-cfddesk.holds`). Its value is read from the record's top level or its `settings` (a mesher's from `settings.mesher_settings`). Study-level settings with these widgets are not supported in 1.5.

## Exit sync (1.6)

A linking page registers an **exit hook**: the app runs it on every way out of the workspace that it owns, so the geometry gets the design the user leaves with. The contract is **save, then link**: the handler saves unsaved work, calls `nav.setDirty(false)`, links with `ws.project.linkGeometry`, and returns. A page's own "Done" button just calls `ws.nav.back()`; the hook does the sync.

```ts test
import { connect } from '@magnusim/workspace';

const ws = await connect();
const sid = ws.context.study.id;
// An older host refuses onLeave with code "not_allowed": link from your own button then.
await ws.nav.onLeave(async ({ reason, signal, progress }) => {
  progress(null, 'Saving the design');
  // ...save unsaved work here, then:
  await ws.nav.setDirty(false);
  if (signal.aborted) return;
  progress(0.5, 'Exporting the design');
  const shape = await ws.files.write(`studies/${sid}/export/part.bbrep`, new Uint8Array([1, 2, 3]));
  const linked = await ws.project.linkedGeometry();
  const study = await ws.study.get();
  const sourceVersion = Number(study.source_version) || 0;
  try {
    await ws.project.linkGeometry({
      shape: { rel: shape.rel, format: 'brep', sha256: shape.sha256 },
      sourceVersion,
      basedOnRev: linked ? linked.rev : null,
    });
  } catch (e) {
    // "Keep editing" in the app's question: the leave is over and the workspace stays open.
    if ((e as { code?: string }).code === 'cancelled') return;
    throw e;
  }
  console.log('left by', reason);
  // The camera the project's viewport lands with (optional).
  return { view: { position: [400, 0, 100], target: [0, 0, 0], up: [0, 0, 1], projection: 'perspective', fovDeg: 30 } };
});
document.getElementById('done')?.addEventListener('click', () => void ws.nav.back());
```

- **Every way out the app owns runs it,** with its `reason`: the header's Back (`back`), your page's `nav.back()` (`frame-back`), the browser's Back or Forward and a typed link (`history`), opening another project (`project`), Home (`home`), and `results.openIn3D` (`results`). **None of these run it:** turning your plugin off in Settings (only the usual question about unsaved work), closing or reloading the tab, and a page that crashed or does not answer. The geometry then keeps its last update, and its row says "Not up to date with <study>." while the saved design is newer.
- **Order.** The app leaves full screen, checks that your page answers, runs the hook, then asks about unsaved work only if the page is still dirty, then leaves. Nothing is drawn for a hook quicker than 400 ms; after that the workspace header shows `progress`'s label (or the link's stage: "Queued behind 2 jobs (see Queue)", "Waiting for your choice"), with Cancel, and your page is covered so nothing is edited after the snapshot. Once the link's job exists the button reads "Stay here": the job goes on whatever the user does (it is not stopped), and the workspace stays open.
- **The app's question** ("Save as new geometry", "Overwrite", "Keep editing", see "Linking a geometry (1.5)") shows inside the leave, over your page: your `linkGeometry` stays pending. "Keep editing" rejects it with `cancelled`, ends the leave and keeps the workspace open with no further question: return at once.
- **Long work.** The leave waits while a bridge call made during it is in flight (an upload, the link) and while the link's job is queued. The call that started the leave (your `nav.back()` or `results.openIn3D`, which wait for it) does not count. A hook with no `progress` and no call for **30 s** has stalled (the clock stops while an app dialog is open); a worker that exports for long must post progress at least every 10 s. Once the link's job exists (5 s after, or at once when it is queued) the header offers **"Continue in background"**: the workspace closes and the update goes on in the app.
- **When it fails** (a throw, a stall, a refused link such as `unsaved`, your page gone), the app asks once: "Couldn't update the project", with your message, Stay (the default) or "Leave anyway". It says what became of the link: "<Geometry> keeps its last update." when none reached the app, "The update of <Geometry> goes on." when the app took it (its job runs on, whatever your page does), "<Geometry> was updated." when it went through (the update's report shows if the user stays). `signal` aborts when the user cancels, stays or the hook stalls.
- **A script that cannot ask** (`openProject` with `askToLeave: false`) runs the hook with no question: the app's link question is answered "Overwrite", and the leave goes on once the server has the link.
- **One leave at a time.** During a leave, Back is disabled and `nav.back()` answers `false`, also from inside the handler.
- **`setDirty` keeps its meaning,** "would be lost": a saved design that is not linked yet is not dirty.
- **The camera** (`ViewState`, optional, from the hook's result or `linkGeometry`'s `view`; the last one wins) is model mm in the frame of your export, Z up like the app's viewport: `position`, `target`, `up`, `projection` (`perspective` with the vertical angle `fovDeg`, or `orthographic` with the full visible `height` in mm). The app's window has another width, so the sides crop differently. A view with a number that is not finite, the position on the target, or `up` along the view direction is dropped. It is applied when the user goes Back to the project (the header's or your `nav.back()`) and the part shows (stage geometry or setup), also when the hook linked nothing because the design did not change: the project then shows the study's geometry with that camera.

## UI kit (1.3)

`@magnusim/plugin-ui` holds components and helpers that look like the app's own panels, drawn with the `--mg-*` tokens. In the page use `host.pluginUi.kit`, or import it from a `.tsx` UI the host bundles; in a workspace frame import `@magnusim/plugin-ui`. Both run the same code, so a panel looks the same in either place. The types are in `docs/plugins/plugin-ui.d.ts` (also served as `/plugin-sdk/plugin-ui.d.ts`), and the kit's version is `PLUGIN_UI_API_VERSION`.

```javascript
// workspace/main.js
import { connect } from '@magnusim/workspace';
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, PanelChrome, Toggle } from '@magnusim/plugin-ui';

const ws = await connect();
function Bench() {
  const [on, setOn] = useState(false);
  return h(PanelChrome, { title: 'Bench', card: true, onDone: () => ws.nav.back() },
    h(Toggle, { label: 'Viscous', checked: on, onChange: setOn }),
    h(Button, { variant: 'primary', onClick: () => ws.ui.toast('Saved', { kind: 'success' }) }, 'Save'));
}
createRoot(document.getElementById('root')).render(h(Bench));
```

The components, each as the core draws it today:

- `Button`: `primary`, `secondary` (the default), `neutral` (Done), `link`, `fix` and `danger`; `block` for the full width.
- `NumberUnitInput`: a number in a unit, kept in SI. `onCommitSi` runs on blur and Enter, Escape puts the value back, and `quantity` with `units` picks the unit shown. `width` is `narrow`, `wide` or `fill`.
- `Select`: the BC and Materials panels' select.
- `Toggle`: a switch (a real checkbox, so Space works) or the ON/OFF pill of schema forms.
- `Field`: a settings row, the label (with an optional help tip) on the left and the control on the right.
- `Hint` (a note under a control), `DisabledReason` (why something cannot run, with an optional fix) and `EmptyState` (an empty list or chart).
- `Icon`: `pencil`, `trash`, `back`, `document`, or your own 24 x 24 path.
- `PanelChrome`: a title, the body and a foot with Delete and Done, and no header buttons. `card` draws the card, for a frame; in the app's flyout the host draws it.
- `StatusBlock`, `Elapsed` and `useElapsed`: the progress block of the Mesh and Run panels.
- `Toast`, and `PanelError`, the card a failed panel shows.
- `LinePlot`: a small line chart, log or linear, with a hover readout and a legend. Its x axis is iterations, simulated seconds, or `kind: 'linear'`: a number axis with round ticks that may lie below zero, drawn in row order (a drag polar turns back). `ColorLegend`: a colour scale with its range.
- Helpers: `formatSci`, `parseSci`, `formatSimTime`, `formatElapsed` and `formatEta`; the unit tables and conversions (`UNITS`, `toSi`, `fromSi`, `convertQuantity`, `fieldUnit`, `fieldQuantity`, ...); the colour maps `rainbow`, `viridis`, `balance` and `curl` (`COLORMAPS`, `colormapRgb`, `colormapGradient`).

How they fit the app:

- **Done.** `PanelChrome` needs `onDone`: pass `pluginUi.panelDone` in the page and `() => ws.nav.back()` in a frame. The kit's Done sends only `cfd:panel-done`; the core's own Done handling (such as saving a refinement) does not run for it.
- **Toasts.** `pluginUi.toast(message, { kind })` shows an app toast at the bottom right; up to three stack, newest last, and while the pointer is on any of them none closes. In a frame, `ws.ui.toast` shows one inside the workspace, one at a time. Info and success close after 3.8 s and errors after 9 s; the time stops while the pointer or the focus is on a toast. A `Toast` of your own takes `paused` to hold its time the same way.
- **Units.** `pluginUi.unitSystem()` in the page and `ws.context.units` in a frame are `metric` or `imperial`; pass it to `NumberUnitInput`'s `units`.
- **Field widgets.** `SchemaField(widget="my-plugin.rate")` in Python puts `x-cfddesk.widget` on the field's schema, and `pluginUi.registerFieldWidget('my-plugin.rate', Rate)` draws that field with your component, typed `ComponentType<FieldWidgetProps>`. Render only the control (the form draws the row), and use `NumberUnitInput` with `width="fill"` for the form's width. A widget registered after a form opened replaces the core control at once. `python/tests/fixtures/kit-plugins/kit-demo` is a complete example, driven by `e2e/h14-kit.spec.js`.
- **Selects.** A kit `Select` looks like the BC and Materials panels' selects (`.bc-select`), not like a schema form's own selects. In a schema form pass `width="fill"` for the form's width; inside the study panel the core's `.sim-study-panel .schema-form select` restyles it.
- **Shared tables.** `UNITS`, `IMPERIAL_DEFAULT`, `SI_DEFAULT` and `COLORMAPS` are frozen: the app reads the same tables.
- **Older hosts.** A 1.2 host cannot load a frame that imports the kit: the module does not resolve, and the page shows "didn't start". Declare `api_version = "1.3"` in a plugin that uses the kit.

## Plugins tab

Settings → Plugins lists each plugin's name (or key), version, source (`bundled` from `bundled-plugins/`, `local` from `plugins/`, or `entry_point` for a wheel), and status:

- `enabled`, shown as On, or as Required for a required plugin, which has no Disable button.
- `disabled`, shown as Off. An optional bundled plugin that ships off (`default_enabled = false`) is listed this way with "Ships with Magnusim and stays off until you turn it on."
- `needs setup`: its own environment is not installed on this PC yet; the row has **Install dependencies**.
- `missing requirement`: a WSL program or Python package in its `requires` is not found; its page UI and workspaces do not load. A missing GPU is only a note on an `enabled` row.
- `incompatible`: its `api_version` has a different major.
- `error`, shown as Failed to load, with the message (a manifest or `register` failure, a missing required plugin, or a UI bundle that failed in the page).

Enable and Disable call the plugin routes, reload the registry, and load or remove the plugin's UI at once. **Reload plugins** runs `registry.reload` and loads UI bundles again. It also stops every running plugin OpenFOAM case ("Stopped: plugins were reloaded") and takes every queued one off the queue. Disable, and removing a plugin's environment, stop only that plugin's cases; Enable and installing an environment stop nothing.

## License

Magnusim is GPL-3.0-or-later. A plugin runs inside the Magnusim Python worker and page, so a distributed plugin is part of a GPL-3.0-or-later combined work. License it under GPL-3.0-or-later or a GPL-compatible license such as MIT, BSD, Apache-2.0, or LGPL-3.0. The template declares GPL-3.0-or-later.

## Registry reference

`docs/plugins/registry.json` lists the keys Magnusim itself registers: analysis, solver, mesher, boundary condition, material, monitor, and filter. It holds builtins only; your plugin's keys never appear in it, and the app reads them from the live registry while it runs. `npm run gen:registry` (from `magnusim-web/`) regenerates it together with `scripts/generated/registry.json`.
