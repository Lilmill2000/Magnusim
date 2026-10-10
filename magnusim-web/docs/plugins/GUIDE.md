# Building a Magnusim plugin

This guide takes you from an empty folder to a plugin that works end to end. It gives the rules as numbered lists, so you can check your work against them.

Where to look next:

- [API.md](API.md) is the reference. It is generated from the app's code, so it is always current.
- [authoring.md](authoring.md) has the long form of each feature (analysis contract, linking a geometry, exit sync, start actions, the UI kit).
- [compatibility.md](compatibility.md) says what each host API version added.
- [DESIGN.md](DESIGN.md) says how a plugin must look and read.

Code blocks marked `test` in these docs are run by `npm run test:docs`. If one of them stops working, the build fails.

## 1. Quick start

Every command here runs in the app folder, `magnusim-web/`, the folder with `package.json`. You need no copy of the app: a plugin is one folder in `plugins/`.

1. Make a plugin:

   ```
   npm run plugin:new -- hello-workspace --workspace --service --venv --study-kind "Wing section"
   ```

2. It is written to `plugins/hello-workspace/`. Use `--out <folder>` to put it somewhere else, and give that path to the commands below. It gets the GPL text as `LICENSE` from the app's own `LICENSE` (in `magnusim-web/` or the folder above it); without one, `plugin:new` stops and says so.
3. Check it:

   ```
   npm run plugin:check -- plugins/hello-workspace
   ```

4. Build its page after each change to `src/`. The host serves `workspace/`, never `src/`, so an edit shows only after a build. `plugin:new` built it once already. In the plugin folder:

   ```
   npm install
   npm run build
   ```

   `npm install` is needed once. `npm run typecheck` checks the page against the bridge's and the kit's types.

5. Start the app with `npm run dev` (or double-click `run.bat`). It serves http://127.0.0.1:8082, or the port saved in Settings. Open **Settings → Plugins**, click **Reload plugins**, then **Install dependencies** on your plugin's row.
6. Open a project. In the header's **Workspaces** menu, click **New Wing section**. Keep the name it offers ("Wing section 1") or type your own. Your page opens.
7. Run its browser test. It starts a second app server of its own, so your app may keep running:

   ```
   npx playwright test -c plugins/hello-workspace/tests/e2e/playwright.config.js
   ```

8. Read the `GUIDE.md` the scaffold wrote into your plugin. It has the hard rules in short.

### A second app server of your own

To try your plugin away from your own projects and settings, start a second server with its own settings file, projects folder, plugins folder and port. In PowerShell, from the app folder:

```
$dev = "$env:TEMP\magnusim-dev"
New-Item -ItemType Directory -Force "$dev\projects", "$dev\plugins" | Out-Null
Set-Content "$dev\settings.json" '{"wizard_completed": true, "units": "Metric"}'
$env:MAGNUSIM_LOCAL_JSON = "$dev\settings.json"
$env:MAGNUSIM_PROJECTS_ROOT = "$dev\projects"
$env:MAGNUSIM_PLUGINS_DIR = "$dev\plugins"
$env:MAGNUSIM_PORT = "9250"
npm run dev
```

1. `MAGNUSIM_LOCAL_JSON` is the settings file it reads and writes. Your own settings are not touched. Without `wizard_completed`, the first-run wizard shows once.
2. A port saved in that settings file wins over `MAGNUSIM_PORT`. So give each server a settings file of its own.
3. `MAGNUSIM_PLUGINS_DIR` replaces `plugins/`. Put your plugin folder there, or make it there: `npm run plugin:new -- <key> --out $env:TEMP\magnusim-dev\plugins`.
4. Stop it with Ctrl+C in that window. `stop.bat` stops only the app on the port of its own settings file (`.magnusim-local.json`), never this server.

## 2. Kinds of plugin

A plugin can do one or more of these things.

| Kind | What the user sees | Code runs in | Start with |
| --- | --- | --- | --- |
| **Workspace** | A full page of its own, opened from one of its studies | A sandboxed frame (page), plus Python (backend) | `npm run plugin:new -- <key> --workspace` |
| **Analysis** | A new simulation type in Create Simulation, run by the core's Run panel | The app's Python worker; its settings panels in the app's page | `npm run plugin:new -- <key> --analysis` |
| **Panel** | A widget in the app's own panels: a schema field, a BC editor, study or run settings, the Filters panel, a row in Settings → Plugins | The app's own page | A `ui/` folder with `register(host)` (section 8) |

How to choose:

1. Your tool has its own screens (a sketcher, a polar bench, an optimiser): make a **workspace**.
2. You add a physics model that the core meshes, runs and shows like its own: make an **analysis**.
3. You change one control or panel inside the workbench: make a **panel**.
4. You need both: one plugin may hold all three. Incompressible Flow is an analysis with panels. Airfoil is a workspace that runs OpenFOAM cases.

Worked examples in the app:

| Example | What it shows |
| --- | --- |
| `bundled-plugins/airfoil` | A workspace plugin: own environment, service, jobs, OpenFOAM cases, start actions, its own e2e suite |
| `bundled-plugins/incompressible_flow` | An analysis plugin: the analysis contract, BC families, a material model, settings panels |
| `python/tests/fixtures/plugins/stub-analysis` | The smallest complete analysis, on `laplacianFoam` |
| `python/tests/fixtures/kit-plugins/kit-demo` | A schema field widget drawn with the UI kit |
| `python/tests/fixtures/workspace-plugins/ws-demo` | A workspace with modules, React, WebAssembly and a worker |
| `python/tests/fixtures/foam-plugins/foam-demo` | A workspace that submits an OpenFOAM case |

## 3. Hard rules

`npm run plugin:check` checks most of these. The rest are checked by review and by your tests.

1. Python code imports only `magnusim_sdk`, `cfddesk.registry`, the standard library and your own modules, and, in code that runs on your own environment (section 10), your lock's packages. Never `cfddesk.builtin`, `scripts` or `src`.
2. `register(hub)` only declares things. Import heavy packages (numpy, gmsh, OCP, scipy) inside the functions that use them.
3. The manifest's `key` is the folder name.
4. `api_version` is the host API you wrote for. It must be at least the version of every feature you use.
5. The licence is GPL-3.0-or-later, or a licence compatible with it.
6. Never bundle React. The host gives you one copy.
7. A workspace page has no `localStorage`, `sessionStorage`, IndexedDB or cookies. Keep state in the study, `ws.data` or `ws.files`; keep the user's own choices that should hold in every project (a toolbar layout, the last options used) in `ws.prefs` (host 1.7: check that `ws.prefs` is there).
8. A workspace page runs no inline `<script>` and loads nothing from another site.
9. Colours, sizes and fonts come from the design tokens (`var(--mg-…)`). No hex values outside a token.
10. Use only your own data folder in a project. Never write another plugin's files or the core's.
11. Job tools live inside your plugin folder.
12. A `[python]` lock pins every package with `==` and a `--hash`.
13. No placeholder copy. No "coming soon", `TODO` or "lorem" in anything that ships.
14. Every button works end to end. Every action tells the user what happened.

## 4. Folder layout

What `npm run plugin:new -- hello-workspace --workspace --service --venv` writes:

| Path | What it is |
| --- | --- |
| `manifest.toml` | What the host reads before it imports anything |
| `plugin.py` | `register(hub)`: declares the job kinds and in-process methods |
| `service/__init__.py` | The backend, run in the plugin's own environment |
| `tools/count.py` | A job tool; it reports progress with `magnusim_sdk.events.emit` |
| `requirements.lock` | The packages of its own environment, pinned and hashed |
| `src/main.tsx`, `src/index.html` | The workspace page's source |
| `workspace/` | What the host serves in the frame. `npm run build` writes it from `src/`; commit it |
| `vite.config.js`, `package.json`, `tsconfig.json`, `src/importmap.json` | The page's build: React, the bridge and the kit are external |
| `types/` | `workspace-sdk.d.ts` and `plugin-ui.d.ts`, copied from `docs/plugins/` (a panel plugin's `ui/` wants `plugin-api.d.ts` too: copy it from there) |
| `tests/test_plugin.py`, `tests/conftest.py` | pytest: loads the plugin through the host's loader |
| `tests/e2e/` | The browser test and its Playwright config |
| `GUIDE.md`, `LICENSE`, `.gitignore` | The rules in short, the GPL text (copied from the app's `LICENSE`), ignored files |

`plugin:check` checks `workspace/` as the host serves it. It cannot tell whether `workspace/` is older than `src/`: build before you check.

Where plugins live:

- `plugins/<key>/`: the user's own plugins (or the folder in `MAGNUSIM_PLUGINS_DIR`).
- `bundled-plugins/<key>/`: plugins that ship with the app. They add `tier = "bundled"`.
- A wheel with a `cfddesk.plugins` entry point also works ([authoring.md](authoring.md)).

## 5. The manifest

The host reads `manifest.toml` before it imports any code. API.md has every key, its type, its default and the API version that added it. [manifest.schema.json](manifest.schema.json) is its JSON Schema.

A workspace plugin with its own environment:

```toml test
key = "hello-workspace"
name = "Hello workspace"
version = "0.1.0"
api_version = "1.7"
license = "GPL-3.0-or-later"
description = "A wing section study with its own workspace"
authors = "Your Name"

# The page the host shows in a sandboxed frame.
[[workspaces]]
key = "wing_section"
title = "Wing section"
icon = "M4 5h16v14H4z M4 9h16"
entry = "workspace/index.html"

# A study of this kind opens in that workspace.
[[study_kinds]]
key = "wing_section"
title = "Wing section"
icon = "M5 19V5h14v14z"
workspace = "wing_section"
schema_version = 1
links_geometry = true

# A button that makes a study of this kind and opens it.
[[start_actions]]
study_kind = "wing_section"
label = "Start a wing section"
hint = "Draw it here, then simulate it"
places = ["empty_project", "header", "new_project", "home"]

# Its own Python environment and its backend.
[python]
requirements = "requirements.lock"
python = ">=3.10,<3.15"
service = "service"
```

A panel plugin with a TypeScript UI that the host bundles:

```toml test
key = "panel-demo"
name = "Panel demo"
version = "0.1.0"
api_version = "1.7"
license = "GPL-3.0-or-later"
description = "A field widget for the mesh panel"
authors = "Your Name"
ui = "ui"
ui_entry = "index.tsx"
```

Rules:

1. `key`, `name`, `version`, `api_version` and `license` are required.
2. `api_version` has the host's major version (`1`). A plugin with another major is shown as incompatible and is not loaded.
3. The host ignores a key it does not know. `plugin:check` warns about one, so a typo does not go unnoticed.
4. `requires_plugins = ["incompressible_flow>=1.0"]` loads those plugins first. Declare it when you build on their specs.
5. `[files]` sets how much a workspace may keep in one project (`max_file_mb`, `max_total_mb`).
6. Start actions have limits per place, and texts have length limits. [authoring.md](authoring.md), "Start actions (1.4)", has them all.

## 6. register, service and jobs

Your Python can run in three places. Pick by how long the work takes and what it imports.

| | `register(hub)` in `plugin.py` | A service method | A job |
| --- | --- | --- | --- |
| Runs | Once, when the app loads plugins | On each `ws.service(...)` call | On each `ws.jobs.start(...)` |
| Process | The app's Python worker | Your service process (your environment, or in-process methods in the worker) | A process of its own |
| Time | Milliseconds | Up to 30 s (`timeout_s` up to 600) | Minutes or hours |
| Imports | `magnusim_sdk`, `cfddesk.registry` only | Your lock's packages, if it runs in your environment | Your lock's packages, with `python="plugin"` |
| Reports | Errors on your Settings row | One answer, or an error message | `MAGNUSIM_EVENT` lines: progress, stages, a result |
| Use it for | Declaring specs, job kinds, hooks | Quick answers: a polar from a network, a check, an export | Long work: a solver, a mesher, a batch |

`register(hub)` declares a job kind. The tool path must be inside the plugin folder:

```python test
import tempfile
from pathlib import Path

from cfddesk.registry.discovery import RegistryHub
from cfddesk.registry.jobs import JobKind

PLUGIN = "hello-workspace"
HERE = Path(tempfile.mkdtemp())  # in plugin.py: Path(__file__).resolve().parent
(HERE / "tools").mkdir()
(HERE / "tools" / "count.py").write_text("print('hello')\n", encoding="utf-8")


def register(hub):
    # ws.jobs.start("hello_count", {"steps": 5}) runs tools/count.py --steps 5
    # on the plugin's own environment, in the plugin folder.
    hub.register_job(
        JobKind("hello_count", "tools/count.py", "project", ("steps",), python="plugin"),
        plugin=PLUGIN,
        package_dir=HERE,
    )


hub = RegistryHub()
register(hub)
assert hub.job_package("hello_count") == HERE
```

`JobKind(key, tool, scope, args_from_params, python)`, from `cfddesk.registry.jobs`:

| Field | What it is |
| --- | --- |
| `key` | What `ws.jobs.start(key, params)` names. Keys are shared by every plugin in the app: start yours with your plugin's key (`hello_count`) |
| `tool` | The tool, a path inside your plugin folder (`tools/count.py`) |
| `scope` | `"project"` for a plugin's job. `"study"` and `"geometry"` are the core's simulation and geometry scopes: a job of those scopes needs a `simulation_id` or `geometry_id` param, which `ws.jobs.start` does not add, so it is refused ("simulation_id required"). A page passes its own study's id as a param instead |
| `args_from_params` | The params passed to the tool, as `--<name> <value>` (rule 5) |
| `python` | `"plugin"`: your own environment, in your plugin folder (needs `[python]`). `"core"` (the default): the app's Python, in the app's folder |

`hub.register_job(spec, plugin=PLUGIN, package_dir=<your folder>)` declares it. `hub.register_method(PLUGIN, name, fn)` declares an in-process method (rule 1).

A service method gets the call's `params` and a `scope`, and returns something JSON can carry. Raise to fail the call: the message is what the page shows.

```python test
from magnusim_sdk.service import handle, method


@method("area")
def area(params, scope):
    width = float(params.get("width") or 0)
    height = float(params.get("height") or 0)
    if width <= 0 or height <= 0:
        raise ValueError("Width and height must be above 0")
    return {"area": width * height}


# How the host calls it: one JSON request, one answer.
ok = handle('{"id": 1, "method": "area", "params": {"params": {"width": 2, "height": 3}}}')
assert ok["result"] == {"area": 6.0}, ok
bad = handle('{"id": 2, "method": "area", "params": {"params": {"width": 0}}}')
assert bad["error"]["message"] == "Width and height must be above 0", bad
```

A job tool prints events. The page gets each one through `ws.jobs.events`:

```python test
import contextlib
import io

from magnusim_sdk.events import emit, parse_line


def main(steps):
    emit("start", steps=steps)
    for done in range(1, steps + 1):
        emit("progress", done=done, total=steps, fraction=done / steps)
    emit("result", ok=True, steps=steps)


out = io.StringIO()
with contextlib.redirect_stdout(out):
    main(3)
events = [parse_line(line) for line in out.getvalue().splitlines()]
assert [e.event for e in events] == ["start", "progress", "progress", "progress", "result"]
assert events[-2].fields["fraction"] == 1.0
```

Rules:

1. Without `--service`, in-process methods are registered in `register(hub)` with `hub.register_method(PLUGIN, "area", area)`. They run in the app's worker, so they import only what `register` may. They need no setup: use them for a backend that needs only the standard library and answers fast.
2. A service runs in your plugin's own environment. So `--service` gives the plugin a `[python]` table and a lock even without `--venv`, and the user clicks **Install dependencies** once. With an empty lock that only makes the environment (`magnusim_sdk`, no packages): no network, a few seconds.
3. Service calls run one at a time. A call that runs past its time ends the service and everything it started. The next call starts it again.
4. The service stops after 10 minutes without calls. Do not keep state in memory that you cannot rebuild.
5. Print freely in a service: its stdout goes to the log, not into replies.
6. A job's params reach its tool as `--<name> <value>` for each name in `args_from_params` that is set. `_` in a name becomes `-` (`n_procs` is `--n-procs`). A param not in `args_from_params` does not reach the tool.
7. Stopping a job ends its whole process tree. Closing the workspace does not stop it.
8. Jobs get `MAGNUSIM_PLUGIN_KEY`, `MAGNUSIM_JOB_ID`, `MAGNUSIM_PROJECT_ID` and `MAGNUSIM_PROJECT_DIR`. Use `PluginData.from_env()` for your folder. Your study's id is not passed: send it as a param.
9. A tool runs as a script. Python puts the tool's own folder (`tools/`) first on `sys.path`, not your plugin folder. To import your plugin's modules, add it: `sys.path.insert(0, str(Path(__file__).resolve().parents[1]))`. Find your files from `Path(__file__)`, not from the working folder.

## 7. magnusim_sdk

`magnusim_sdk` is the one library a plugin's Python imports from the app. It is standard library only at import, so it works in your own environment too. API.md, section 5, lists every function.

| Module | Use it for |
| --- | --- |
| `magnusim_sdk.data` | `PluginData`: your folder in a project, your studies (rev-checked), files and their etags |
| `magnusim_sdk.service` | `@method` for your backend |
| `magnusim_sdk.events` | `emit` in a job tool; `parse_line` to read events back |
| `magnusim_sdk.foam` | OpenFOAM dictionaries and fields |
| `magnusim_sdk.units` | SI conversions and unit labels |
| `magnusim_sdk.proc` | `run_exe`: run a program with a timeout, and stop its tree |
| `magnusim_sdk.gmsh_helpers`, `magnusim_sdk.msh22` | Gmsh set-up and the MSH 2.2 writer |
| `magnusim_sdk.link` | The face-name sidecar and face numbering for a linked geometry |
| `magnusim_sdk.study`, `magnusim_sdk.fluids`, `magnusim_sdk.progress` | BC record helpers, the fluid library, the solver-log parser engine |

Your data folder, from a service method or a job:

```python test
import tempfile

from magnusim_sdk.data import PluginData, StaleRevisionError

project_dir = tempfile.mkdtemp()  # a service method: PluginData.from_scope(scope)
data = PluginData(project_dir, "hello-workspace")
study = data.create_study("wing_section", "Wing section 1", plugin_name="Hello workspace")
saved = data.update_study(study["id"], {"width": 2.0}, study["rev"])
assert saved["rev"] == study["rev"] + 1
try:
    data.update_study(study["id"], {"width": 3.0}, study["rev"])  # a stale rev
    raise AssertionError("a stale rev was accepted")
except StaleRevisionError:
    pass
data.write_json(f"studies/{study['id']}/results/polar.json", {"cl": [0.1, 0.2]})
assert data.read_json(f"studies/{study['id']}/results/polar.json") == {"cl": [0.1, 0.2]}
assert str(data.root).endswith("plugins/hello-workspace") or str(data.root).endswith("plugins\\hello-workspace")
```

## 8. The in-page UI (panel plugins)

A panel plugin's `ui` entry exports `register(host)`. `host` is a `PluginHost` (API.md, section 4; types in [plugin-api.d.ts](plugin-api.d.ts)).

```ts test
import type { FieldWidgetProps, PluginHost } from '@magnusim/plugin-api';

export function register(host: PluginHost): void {
  const { kit } = host.pluginUi;
  const h = host.React.createElement;
  // Draw every schema field whose x-cfddesk.widget is "panel-demo.rate" with the kit's number input.
  host.pluginUi.registerFieldWidget('panel-demo.rate', (p: FieldWidgetProps) =>
    h(kit.NumberUnitInput, {
      label: p.label,
      id: p.id,
      width: 'fill',
      valueSi: typeof p.value === 'number' ? p.value : null,
      onCommitSi: (v: number) => p.onChange(v),
    }),
  );
  // A panel in your row of Settings → Plugins.
  host.pluginUi.registerPanel({
    key: 'panel-demo',
    title: 'Panel demo',
    place: 'prefs',
    Component: () => h(kit.Hint, null, 'Rates use the project units.'),
  });
}
```

Rules:

1. A `.tsx`, `.ts` or `.jsx` UI is bundled by the host. It may import `react`, `react/jsx-runtime`, `@magnusim/plugin-ui` and its own files. Type imports (`import type`) are free.
2. A prebuilt `.js` UI imports nothing bare. It uses `host.React` and `host.pluginUi.kit`.
3. A panel's `place` is `filters` or `prefs`. Any other place throws.
4. Everything `register` adds is recorded under your key. Turning the plugin off removes it at once.
5. An analysis draws its own settings with `registerStudySettings`, `registerRunSettings` and `registerBcSettings`. Its contract names the component ([authoring.md](authoring.md), "Simulation types").

## 9. The workspace bridge

A workspace page runs in a sandboxed frame. It talks to the app only through `@magnusim/workspace`. Call `connect()` as soon as the page loads: a page that has not connected after 5 s shows the user "<Plugin> didn't start." with Try again.

```ts test
import { connect, type StudyRecord } from '@magnusim/workspace';

const ws = await connect();
let study: StudyRecord = ws.context.study;
// A rename in the header, or another save, sends the new record. Save next with its rev.
ws.on('study', (s) => (study = s));

// Save a field with the rev you read. A stale rev is refused.
study = await ws.study.update({ width_m: 2 }, study.rev);

// Your backend.
const r = await ws.service<{ area: number }>('area', { width: 2, height: 3 });

// JSON in your folder of the project (8 MB a file).
await ws.data.write(`studies/${study.id}/area.json`, r);

// Any file, streamed, with an etag so another tab's version is never overwritten.
const old = await ws.files.stat(`studies/${study.id}/model.bin`);
await ws.files.write(`studies/${study.id}/model.bin`, new Uint8Array([1, 2, 3]), { ifMatch: old ? old.etag : null });

// A job, with its progress.
const { id } = await ws.jobs.start('hello_count', { steps: 5 });
const stop = ws.jobs.events(id, (ev) => {
  if (ev.event === 'progress') console.log(ev.done, 'of', ev.total);
  if (ev.event === 'end') {
    stop();
    void ws.ui.toast(ev.status === 'done' ? 'Run finished' : `Run failed: ${String(ev.error ?? ev.status)}`, {
      kind: ev.status === 'done' ? 'success' : 'error',
    });
  }
});
```

The groups of calls (API.md, section 2, has each one):

| Group | What it does | Host API |
| --- | --- | --- |
| `ws.context` | Plugin, project, study, units, theme, `hostVersion` | 1.1 |
| `ws.study` | Read and save this study (rev-checked) | 1.1 |
| `ws.service` | Your backend | 1.1 |
| `ws.data` | JSON files in your folder of the project | 1.1 |
| `ws.files` | Any file, streamed, with etags and size limits | 1.2 |
| `ws.prefs` | The user's preferences for your plugin, the same in every project (64 KB) | 1.7 (unreleased) |
| `ws.jobs` | Start, follow and stop your job kinds | 1.1 |
| `ws.ui` | The app's toast, question and name prompt | 1.1 |
| `ws.nav` | `back()`, `setDirty()`, `onLeave()` | 1.1, 1.2, 1.6 |
| `ws.compute` | Submit and follow an OpenFOAM case | 1.3 |
| `ws.results` | Show a finished case in the project's 3D view | 1.3 |
| `ws.project` | Project info, `linkGeometry`, `linkedGeometry` | 1.1, 1.5 |
| `ws.on` | `units`, `theme`, `study`, `geometry` events | 1.1, 1.5 |
| `ws.spawnWorker` | A worker running your module | 1.1 |

Rules:

1. Calls are allowed only for your plugin, this project and this study. Anything else is refused with "not allowed: …".
2. A call a newer host added is refused by an older host with code `not_allowed`. Check `ws.context.hostVersion` (compare the numbers) or catch the refusal.
3. Mark unsaved work with `ws.nav.setDirty(true, 'Sketch 2 is not saved')`. Clear it once saved. Every way out then asks the user first.
4. Never reload your own page while it is dirty. A reload clears the flag and loses the work.
5. Leave with `ws.nav.back()`. Do not draw your own Back button in the page: the header has one.
6. Keep study fields the user edits in the study record. Keep results and big data in `ws.data` or `ws.files`.

### Job events

`ws.jobs.events(id, fn)` first replays the job's events so far (its last 400), then sends each new one, so a page that subscribes after `ws.jobs.start` misses none. In order:

| `event` | Sent by | Its fields |
| --- | --- | --- |
| `start` | The host, when the tool starts | `job_id`, `kind`, `pid` |
| Each kind your tool emits | Your tool's `emit(kind, **fields)` | Your fields, as you sent them. `emit` takes only the kinds in `magnusim_sdk.events.KNOWN_KINDS` (API.md, section 5) |
| `result` or `error` | The host, when the tool exits: `result` on exit 0, `error` on a failure or a stop | `status`, `error`, and `result` (always `null` for a plugin job: send yours in your own `result` event) |
| `end` | The app, last | `status`: `done`, `failed` or `stopped`; `error`: `null` when done, else why (`exit 1`, `stopped`) |

1. Only the workspace that started a job can follow or stop it, while it stays open. Any other id is refused with "not allowed: …".
2. A page opened again cannot find a job that is still running. Have the job write its result in your folder (`PluginData`), and read it with `ws.data` when the page opens.

### OpenFOAM cases and results

A workspace can run an OpenFOAM case it wrote in its study's folder. The host runs it in WSL on the app's one compute slot. It may wait in the queue behind a mesh or a solve.

```ts test
import { connect } from '@magnusim/workspace';

const ws = await connect();
// Write the case under studies/<id>/cases/c1 first (ws.files, or your service), then:
const { id, ahead } = await ws.compute.submitOpenFOAM({
  caseRel: 'cases/c1',
  app: 'simpleFoam',
  pre: [{ tool: 'blockMesh' }],
  results: { kinematicFields: ['p'], rho: 1.2 },
});
console.log(ahead ? `Queued: ${ahead} ahead` : 'Starting');
ws.compute.events(id, (ev) => {
  if (ev.event === 'end' && ev.status === 'done') void ws.results.openIn3D('cases/c1');
});
```

[authoring.md](authoring.md), "OpenFOAM cases and solve hooks (1.3)", and [compatibility.md](compatibility.md), "1.3", have the case rules, the WSL steps and their arguments, the events and Stop.

### Start actions

A `[[start_actions]]` entry gives a study kind a button that makes a study and opens it. The host draws it in the empty project, the project header, the New Project dialog and Home. You write no UI for it. [authoring.md](authoring.md), "Start actions (1.4)", has the places, caps and texts.

### Linking a geometry and exit sync

A study kind with `links_geometry = true` can link one project geometry. Its design then becomes a geometry the simulation side uses like an imported part.

1. Save the design. Export it as one compound of solids in mm, as an OCCT BREP.
2. Write it with `ws.files.write`. Write a face-name sidecar with `magnusim_sdk.link.write_face_names` if your faces have names.
3. Call `ws.project.linkGeometry(...)` with the file's `sha256` (or `etag`), a `sourceVersion` and `basedOnRev`.
4. Register an exit hook with `ws.nav.onLeave(...)`. The app runs it on every way out it owns, so the geometry gets the design the user leaves with.
5. When the shape changed under simulation setup, the app asks the user ("Save as new geometry", "Overwrite", "Keep editing"). You write no code for it. "Keep editing" rejects your call with `cancelled`: stay as you are and show no error.

[authoring.md](authoring.md), "Linking a geometry (1.5)" and "Exit sync (1.6)", has the whole contract, with tested examples.

## 10. Environments

A plugin that needs Python packages the app does not ship declares its own environment.

```
[python]
requirements = "requirements.lock"   # pinned, with hashes
python = ">=3.10,<3.13"              # the interpreters it supports
service = "service"                  # its backend module (optional)
find_links = "wheels"                # wheels in the plugin, to install offline (optional)
```

Rules:

1. Make the lock with `pip-compile --generate-hashes`. pip installs it with `--require-hashes`, wheels only.
2. The plugin shows "Needs setup" until the user clicks **Install dependencies** in Settings → Plugins. Editing the lock shows "Needs setup" again.
3. The environment lives in `.cache/plugin-envs/<key>-<lock hash>/`. It has `magnusim_sdk` and nothing of the core: `import cfddesk` fails there.
4. Your lock's packages may be imported only by code that runs there: your service module, job tools with `python="plugin"`, and modules only those import. `register` runs in the core and cannot import them.
5. `plugin:check` reads which code runs where ([authoring.md](authoring.md), "Your own environment's packages").

## 11. Data scope and trust model

A plugin is trusted code. Its Python runs with the user's rights, like any program. The sandbox and the bridge protect the app from plugin bugs and crashes. They are not a defence against a plugin written to do harm. `SECURITY.md` at the root of the repository, section "Plugins", has the details.

What the host enforces:

1. **Your folder.** Each project has `plugins/<key>/` for you. `ws.data`, `ws.files` and `PluginData` reach only that folder. A path outside it is refused, links and junctions included.
2. **Your studies.** A study's record (`studies/<id>/study.json`) changes only through `ws.study.update` (your page) or `PluginData.update_study` (your service or job), with the current `rev`. Every other field name is yours, `times` included.
   - Through the page, the host keeps: `id`, `kind`, `plugin`, `plugin_name`, `plugin_version`, `schema_version`, `created_at`, `updated_at`, `rev`, `edits_geometry` (the project geometry a geometry action opened the study on).
   - Through `PluginData`, it keeps: `id`, `kind`, `plugin`, `created_at`, `rev`. It sets `updated_at`. Do not write the others from Python: the host sets `schema_version` and `plugin_version` when it stores what your `migrate_study` returned.
3. **The frame.** A workspace page has an opaque origin. It cannot read the app's page, call the app's API or use storage. Its Content-Security-Policy allows only `/plugin-sdk/` and your own `workspace/` folder.
4. **The bridge.** Each call is checked against your plugin, this project and this study. The rest is refused and logged.
5. **Cases.** A case's solver and WSL steps are checked against fixed lists. No free text from your case reaches a shell.
6. **Management.** Turning plugins on or off, reloading them and installing environments are allowed only from a browser on the same PC.
7. **Off means off.** A plugin that is off is never imported. Its pages are not served, and its files are refused.

What you must do:

1. Read and write only through these routes. Never open the core's project files.
2. Never put secrets in the study record or in your folder: they travel with the project.
3. Upgrade old studies in a `migrate_study` service method when you raise a kind's `schema_version`. The host calls it, rev-checked, in the background.

## 12. Testing

A plugin has three layers of tests:

1. **pytest** (`tests/`). `tests/conftest.py` gives each test scratch settings and a fresh registry. `tests/test_plugin.py` loads the plugin through the host's own loader, then calls its methods, its service and its job.
2. **Your own unit tests** for your logic. Python ones go in `tests/` beside them. For page logic, add a `test` script to `package.json` (vitest or `node --test`).
3. **A browser test** (`tests/e2e/`). It starts a second app server with only your plugin installed, opens a study in its workspace and checks what the user sees.

What `plugin:new` writes:

| Variant | pytest | Browser test |
| --- | --- | --- |
| `--workspace` | Loads the plugin; calls its method or its service; runs its job | Opens a study in its workspace: the form saves, the backend answers, the job reports progress |
| `--analysis` | Loads the plugin and checks the analysis it adds | None: write one when you add screens |

Your own unit tests are yours to write.

Run them, from the app folder:

```
npm run plugin:check -- plugins/hello-workspace          # every rule, then your pytest (and npm test)
python/.venv/Scripts/python -m pytest plugins/hello-workspace/tests
npx playwright test -c plugins/hello-workspace/tests/e2e/playwright.config.js
```

1. pytest runs on the app's Python (`python/.venv/Scripts/python`; `python/.venv/bin/python` on Linux), which has pytest. The generated `tests/conftest.py` puts the app's `python/` and `python/sdk/` on `sys.path`, so `cfddesk` and `magnusim_sdk` import from any folder.
2. The `tests` rule runs `npm test` only when `package.json` has a `test` script. `plugin:new` writes none. Run `npm install` in the plugin first.

### The browser test's harness

The browser test reaches the app's test harness through one module: `e2e/support/plugin-suite.js`. Import from it and from nowhere else in the app. The app can then change its harness behind that file without breaking your tests. What it gives you:

| Export | What it is |
| --- | --- |
| `startHost`, `e2eTemp` | A second app server of your own (your plugins, a private Vite cache), and a temp folder for it |
| `NO_GEOMETRY_PROJECT`, `prepareE2eProjectsRoot` | The core's seeded test projects |
| `seedElbowProject` | A fresh copy of the elbow sample (a study with mesh, Air and BCs) |
| `appSuiteConfig` | A Playwright config on the core's app server (bundled plugins) |
| `NO_WSL`, `NO_HEAVY`, `wslPathExists` | Whether WSL and OpenFOAM tests can run here |
| `settleE2eToolchain` | Looks for WSL and OpenFOAM once, in the runner, so every worker reads the same `NO_WSL` and `NO_HEAVY`. Call it in your `playwright.config.js` |
| `computeQueue`, `waitSlotFree`, `foamRecords`, `killFoamRelays`, `removeTestWslRoot` | The compute slot, for tests that run OpenFOAM |
| `acquireWslLock` | The machine's WSL test lock |
| `setup`, `createStudy`, `addAir`, `addBc` | The two-plates set-up helpers |
| `PYTHON` | The app's Python |

`scripts/__tests__/e2e-suites.test.mjs` fails when a file in a bundled plugin's `e2e/` folder imports anything else from the app. CAD alone is exempt: it runs its own Playwright and app server. `docs/TESTING.md` has the suite layout and the test tiers.

`startHost(options)` starts the server and resolves once it answers. Its options:

| Option | Default | What it does |
| --- | --- | --- |
| `name` | `'host'` | A label for its temp folder and log lines |
| `tmp` | A new `e2eTemp(name)` | The server's temp folder. `stop()` removes it, with everything in it |
| `projects` | `<tmp>/projects` | The projects folder. When missing, it is made and seeded with the core's test projects |
| `seed` | `true` | `false`: a missing projects folder is made empty |
| `pluginsDir` | `<tmp>/plugins` | The user plugins folder (`MAGNUSIM_PLUGINS_DIR`). Put your plugin there |
| `pluginsFrom` | None | A folder copied into `pluginsDir` first |
| `bundledDir` | The app's `bundled-plugins/` | Another bundled plugins folder |
| `enablePlugins` | `[]` | Bundled plugins that ship off, turned on before the first load |
| `prefs` | | More settings over `{wizard_completed: true, units: 'Metric', port}` |
| `env` | | More environment variables; `null` removes one |
| `webRoot` | This app | The app folder to run |
| `viteCacheDir` | Shared (a folder of `MAGNUSIM_E2E_VITE_CACHE_DIR` per server, when set) | A Vite cache of its own. Give one, so another test server never disturbs yours |
| `port` | The first free one from `portFrom` | A fixed port. The start fails when it is taken |
| `portFrom` | `MAGNUSIM_E2E_PORT` + 11 (8094) | The lowest port tried |
| `keepFree` | `[]` | Offsets above the port that must be free too |
| `lock` | None | A file naming a live server to reuse; written when this call starts one |
| `timeoutMs` | 120000 | How long to wait for the server |
| `log` | None | `(line) => void` for its progress lines |

It returns `{base, port, pid, reused, tmp, projects, prefs, pluginsDir, log(), stop()}`. `base` is the server's URL, `log()` its output so far, and `stop()` ends it and removes `tmp`.

1. `e2eTemp(name)` makes a new folder in the system temp folder, `magnusim-<name>-…`. Keep `projects` outside it when a test stops and starts servers on the same projects.
2. `NO_GEOMETRY_PROJECT` is the id `no-geometry-e2e`: a project with no geometry and no study, in the projects `startHost` seeds. Its units are the server's: Metric, so lengths show in mm. Pass `prefs: { units: 'Imperial' }` for inches.

A test may set up through these routes. Call them from the test, never from your page (the page has only the bridge):

| Route | What it does |
| --- | --- |
| `POST /api/plugin-studies/create` | Body `{project_id, plugin, kind, title}`. Answers `{study}`: a new study, as the Workspaces menu makes one |
| `GET /api/plugin-studies/get` | Query `project_id`, `plugin`, `study_id`. Answers `{study}`: the saved record, to check what the page saved |
| `POST /api/plugins/:key/env/install` | Builds the plugin's environment, as **Install dependencies** does. Answers 202 at once |
| `GET /api/plugins/:key/env` | Answers `{env: {state, error}}`. Poll until `state` is `ready` (or `failed`) |

Turning your plugin off and on is a user's action: test it through **Settings → Plugins**, as `togglePlugin` in `bundled-plugins/airfoil/e2e/airfoil.spec.js` does. Click `#wb-prefs`, then the **Plugins** step. In the row `[data-plugin-key="<key>"]`, click `[data-plugin-toggle="<key>"]` and wait for `data-plugin-status` to be `disabled` or `enabled`. Close with `#wiz-next`. To test a removed plugin, stop the server, remove its folder from `pluginsDir`, and start a server on the same `projects`.

Driving the kit's controls in a test:

| Control | Find it | Change it |
| --- | --- | --- |
| `NumberUnitInput` | `getByRole('textbox', { name: '<label>' })` | `fill('2000')`, then `press('Enter')` to commit. It commits only a value that changed |
| `Select` | `getByRole('combobox', { name: '<label>' })` | `selectOption('<value>')` |
| `Toggle` (switch) | `getByRole('checkbox', { name: '<label>' })` | `press('Space')`. Its input sits under the drawn switch, so `check()` waits for it to show and times out |
| `Toggle` (pill) | `getByRole('button', { name: '<label>' })` | `click()`; read `aria-pressed` |
| `Button`, `Toast`, `PanelError` | Your `attrs={{ 'data-…': '1' }}` | |
| A toast from `ws.ui.toast` | `page.locator('[data-ws-toast]')`: the app draws it over your frame, not in it | |
| The study's title | `page.locator('#workspace-overlay [data-ws-crumb]')`: the header's | |

For anything else, put a `data-…` attribute on an element of your own around the control (a `Field`'s wrapper). Never select the kit's inner markup: its classes and structure are not part of the API.

Rules:

1. Every bug you fix gets a test that fails without the fix. Prove it: undo the fix and watch the test fail.
2. Assert what the user sees: the text on screen, the saved record, the file on disk. Never only "no error".
3. A test that cannot run here (no WSL) is skipped and says why. It never passes without running.

## 13. plugin:check

```
npm run plugin:check -- <path>... [--json] [--no-tests]
```

It loads your plugin the way the host does, in a child process with scratch settings. It never touches this PC's settings. Exit 0: no errors (warnings allowed). Exit 1: an error. Exit 2: a path is not a plugin folder.

| Rule | Checks |
| --- | --- |
| `manifest` | Parses and matches the schema; `plugin.py` exists |
| `key` | `key` is the folder name; a copy with a bundled plugin's key is newer than the app's own (an update) |
| `api_version` | Same major as the host, not newer; features need their version |
| `license` | An SPDX expression compatible with GPL-3.0-or-later |
| `load` | The host's own loader loads it |
| `imports` | Only `magnusim_sdk`, `cfddesk.registry`, the standard library and your own code; your lock's packages too in code that runs on your environment |
| `register` | No heavy imports in `register()` or at load |
| `react` | No React bundled or listed as a dependency |
| `workspace` | Each entry page loads, connects through `@magnusim/workspace`, and runs no inline or remote script |
| `ui` | An in-page UI imports only what the host provides |
| `tools` | Every job's tool is inside the plugin and exists |
| `requirements` | Every lock line is pinned and hashed |
| `hooks` | No listener on a hook that never fires (warning) |
| `colours` | Hex colours outside a token (warning) |
| `copy` | No "coming soon", `TODO` or "lorem" in shipped text |
| `tests` | Your pytest passes, and `npm test` when `package.json` has a `test` script |

`--no-tests` skips the last rule and reports it as skipped, never as passed.

### Shipping a plugin, and updates (plugin:pack)

```
npm run plugin:pack -- <key or folder> [--out <folder>] [--no-tests] [--json]
```

It runs `plugin:check` (an error stops it), then writes `dist/<key>-v<version>.zip` (beside `magnusim-web/`, or in `--out`) and `<zip>.sha256`. A key is looked for in `bundled-plugins/`, then `plugins/`. The zip holds one folder named after the key, with the files git tracks in the plugin folder (all its files outside a git checkout), never `tests/`, `e2e/`, `node_modules/`, caches or bytecode. Keep the source of anything you ship built (GPL), as the bundled plugins do.

Whoever gets the zip installs it with **Settings → Plugins → Install plugin from zip…**: the app checks it, shows its name, version and authors and what installing does, and installs it into `plugins/<key>` only after **Install**. It refuses a zip that is not one plugin folder, has a name that leaves the folder or that Windows cannot hold, a link, two names that differ only in case, more than 20000 files or 2 GB, a manifest without a key or a version number, or another major `api_version`. Installing replaces that plugin's copies in `plugins/`, and keeps them aside until the new copy has loaded: one that fails to load is taken away again, with "<Name> <version> did not load (why); the previous version … is kept" (or "nothing was installed"). **Remove** deletes the copies. A key that differs from another plugin's only in case is refused (Windows folder names ignore case). When `plugins/` is on another drive than the app, the zip is unpacked beside it on that drive.

A zip with a bundled plugin's key is an **update**. The app uses whichever copy has the higher version, so an update installs only when it is newer than the copy that ships with the app. Versions compare as semantic versions: `0.2.0-dev` < `0.2.0` < `0.2.1`, and a tie goes to the app's own copy. A used update loads as the bundled plugin, from `plugins/<key>`: its tier stays bundled, and whether it is required or ships off stays the app copy's, whatever the update's manifest says. Settings shows "An update from the plugins folder, used in place of the version that ships with Magnusim (…)" and **Remove update**. When an update fails to load, the app uses its own copy and says why under the plugin; so does a copy that is not newer ("Not used: …"). When the app itself is updated to a version whose own copy is as new as the update, its own copy is used again.

Installing or removing stops that plugin's service, jobs and OpenFOAM cases first (for Incompressible Flow, every running core solve too, since they run its analyses); the confirm card names what runs and will stop, and queued cases are taken off the queue. It is refused while the plugin's workspace is open. A plugin with in-page screens asks for a page reload, since the page keeps the screens it loaded. A plugin with a native Python extension (`.pyd`, `.dll`, `.so` in its folder) cannot be moved while the app has it loaded: restart the app, then install. An entry-point plugin (a wheel) is not part of this: give it its own key.

## 14. Licensing

1. Magnusim is GPL-3.0-or-later. A plugin runs inside its process and page, so a distributed plugin is part of a GPL combined work.
2. License your plugin GPL-3.0-or-later, or a compatible licence: MIT, BSD, Apache-2.0, LGPL-3.0.
3. `plugin:check` refuses GPL-2.0-only, EPL, CDDL and `LicenseRef-*`.
4. Third-party code you ship keeps its own licence. Put it in its own folder with its `LICENSE` file, and list it in your README.
5. Put `SPDX-License-Identifier: GPL-3.0-or-later` (or your licence) in a comment at the top of each source file you write. `plugin:new` puts it in every source file it writes. The copied `types/` and the built `workspace/main.js` are not your source.

## 15. Definition of done

A plugin, or a change to one, is done only when all of these hold. "It should work" is not done.

1. The real flow works end to end in the app: from the button the user clicks to the result on screen and on disk.
2. `npm run plugin:check -- <your plugin>` passes, with its tests run.
3. Its browser test passes against the app, and asserts what the user sees.
4. Every bug found has a test that fails without the fix.
5. You have screenshots of each screen and state you changed, taken from the running app.
6. Turning the plugin off leaves no trace: no panel, no menu entry, no toast, no error.
7. Turning it back on brings everything back without a reload.
8. Removing the plugin folder keeps its studies. The tree still names them, and they come back when it is installed again.
9. Every button does what it says. A control that cannot work says why and how to fix it ([DESIGN.md](DESIGN.md)).
10. Nothing is left as "for later": no "coming soon", no dead button, no hint that lies.

## 16. Common mistakes

| Mistake | What happens | Fix |
| --- | --- | --- |
| `import numpy` at the top of `plugin.py` | `register` rule error; the app loads slowly | Import it inside the function that uses it |
| `from cfddesk.builtin import …` | `imports` rule error | Use `cfddesk.registry` or `magnusim_sdk` |
| React in `package.json` dependencies, or bundled into `workspace/` | `react` rule error; two Reacts break hooks | Mark `react`, `react-dom/client`, the bridge and the kit external |
| An inline `<script>` in `workspace/index.html` | It never runs (CSP); the page "didn't start" | Put code in a module file |
| `localStorage` in a workspace | It throws: the frame has no storage | Keep state in the study, `ws.data` or `ws.files` |
| `fetch('/api/…')` from a workspace | Blocked by the CSP | Use the bridge |
| `ws.study.update(patch)` with an old `rev` | Refused: "changed in another tab" | Save with the rev you last got; follow `ws.on('study')` |
| `connect()` after a slow import | "didn't start" after 5 s | Call `connect()` first |
| No `setDirty` while a design is unsaved | The user leaves and loses work | `setDirty(true, why)` on the first change; `false` after saving |
| An error toast for `cancelled` from `linkGeometry` | The user chose "Keep editing" and sees an error | Treat `cancelled` as no error |
| A Back button or title drawn in the page | Two Backs; the header already has one | Use the host's header; leave with `ws.nav.back()` |
| A tick in a panel header to close it | Not how the app closes panels | Done in the foot ([DESIGN.md](DESIGN.md)) |
| `#1570ef` in your CSS | `colours` warning; breaks with a theme change | `var(--mg-primary)` |
| A job tool outside the plugin folder | `tools` rule error; the host refuses it | Keep tools in the plugin |
| `numpy>=1.26` in the lock | `requirements` rule error | `pip-compile --generate-hashes` |
| `api_version = "1.1"` while using `[files]` or `[[start_actions]]` | A `plugin:check` `api_version` warning. An older host ignores a key it does not know, so the feature is missing there | Declare the version of the newest feature you use |
| A test that only checks "no error" | Passes while the feature is broken | Assert the text, the record and the file |
