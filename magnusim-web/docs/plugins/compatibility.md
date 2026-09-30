# Plugin API compatibility

The host loads a plugin whose `api_version` has the same major version as its own (`cfddesk.registry.API_VERSION`). A minor version adds things; it never removes or changes what an older minor version offered, so a `1.0` plugin loads unchanged on a `1.1` host.

## 1.1

**Analysis contract** (`cfddesk.registry.contract`). Optional fields on `AnalysisType`; the core falls back to a neutral default for any left out, and a plugin that clones a builtin with `dataclasses.replace` keeps the builtin's:

| Field | What the core does with it |
|---|---|
| `family` (`AnalysisFamily`) | Create Simulation title, description, tags; the study's name |
| `study_defaults(time_dependency)` | A new study's settings (published in `registry.describe` as `study_defaults`) |
| `algorithm_label`, `x_axis` | The study panel's Algorithm row; the run's progress axis (`seconds` / `iterations`): the residual and monitor plots, the results timeline, and progress and time left in the Run panel, the job chip and the Home card |
| `residual_series` | The residual plot: per series `key`, `label`, `color`, `fields` (solver-log fields a point takes the largest of), `always` (in the legend before it has values), `dashed` (a per-step metric such as the Courant number, with `max_key`), `swatch` (a legend class). Defaults to one series per `residual_keys` entry |
| `ui` | `study_settings` / `run_settings`: the names of the components the plugin's UI registers for the study and run panels' settings slots (below) |
| `run_monitors(case_dir)` | A run's monitor results for the Graphs panel: `{rho, monitors, custom, balance}` |
| `plan_case(ctx)` | What `write_case` would report, without writing (`prepare_run --validate-only`) |
| `validate_ready(ctx)` | What blocks a run: `[{"message", "fix"}]`. The Run panel's Start button stays off with the first issue as its reason (`GET /api/run/ready`), and it is checked again before the run is marked running |
| `run_model` (`RunModel`) | Run settings: `defaults()` (a new run's, `run_defaults`), `normalize()` (every save of a run's settings is stored as it returns them, `analysis.run_normalize`; the core keeps no limits of its own; a value it rejects falls back to its default), `preview()` (the Run panel preview) |
| `result_fields` (`ResultField`) | What results colour by, in order: `key`, `label`, `unit_quantity`, `kind` (`scalar` / `vector`). A scalar is shown by its name, a vector `X` by its magnitude `magX` (label "<label> Magnitude"). The Coloring picker lists those the run wrote (a laminar run has no `k`); results open on the first. Names are plain identifiers (a letter, then letters, digits or `_`, 64 at most) |
| `launch` (returns `LaunchSpec`) | Program, `keep_frames` (`all` / `latest`), `process_names`, `stop_strategy`, `frame_fields`, `log_parser` |
| `log_parser` (`LogParserRef`) | The one solver-output parser; Node only aggregates its events |
| `frame_fields` | Fields that mark a written result frame (default: `fields`) |

Worker RPCs: `analysis.describe`, `analysis.defaults`, `analysis.validate_ready`, `analysis.run_normalize`, `analysis.run_preview`, `analysis.launch_spec`, `analysis.run_monitors`. `run.transient_preview` is gone; `analysis.run_preview` replaces it.

**Case sidecar.** `write_case` writes `w27-case.json` in the case folder. Besides `rho`, it lists in `kinematic_fields` the fields the case stores divided by density (pressure in an incompressible case); every results view shows those times `rho`: surface, series range, cut plane, iso surface and plot over path. A case without the list is read as `["p"]` (cases written before 1.1). After `write_case`, the core adds `analysis_key` and `frame_fields` (the launch spec's): results list a saved time only when every frame field is written in it (`U` and `p` for cases without the list).

`prepare_run` reports `app` as the program to run (the solver's `application`, not its registry key), plus `launch` and the boundary-to-patch mapping `bcs`. It refuses a run that is not ready (`{"ok": false, "not_ready": true, "error", "fix"}`) and writes nothing.

**Bundled tier.** `bundled-plugins/` ships with the app and loads after the core builtins and before entry points and user plugins, in dependency order. New manifest fields: `tier = "bundled"`, `required`, `requires_plugins` (also for user plugins), `protected`. A required plugin that does not load blocks creating and running simulations with a message (`registry.describe` → `required_missing`); it cannot be turned off. Incompressible Flow (`incompressible_steady`, `incompressible_transient`, `simpleFoam`, `pimpleFoam`, `simpleFoam_amgx`) is the required bundled plugin; the keys are unchanged, so projects need no migration. `MAGNUSIM_BUNDLED_DIR` moves the bundled folder (tests); `MAGNUSIM_PLUGINS_DIR` still moves only the user plugins.

**`magnusim_sdk`** (`python/sdk`, standard library only): `events`, `units`, `foam`, `gmsh_helpers`, `msh22` (numpy imported when used), `proc`. Plugins may import `magnusim_sdk` and `cfddesk.registry` only (`tools/plugin_boundary.py`).

**Settings slots (in-page UI).** The study panel and the run panel are core chrome (title and rename, Done/Delete, the Start gate, progress, residuals, monitors). The analysis's settings sit inside, drawn by its plugin: `host.pluginUi.registerStudySettings(name, Component)` and `registerRunSettings(name, Component)`, named by the contract's `ui.study_settings` / `ui.run_settings`. A study-settings component gets `{study, row, rows, save, setTimeDependency}`, a run-settings component `{run, row, saveSteady, saveTransient}` (types: `src/plugin-api/slots.ts`). An analysis that names none gets a generic form from its `settings_schema`, `numerics_schema` and `control_schema`. Disabling the plugin removes its components.

**TypeScript UI.** A manifest's `ui_entry` may be `.tsx`/`.ts`/`.jsx`: the host bundles it when it serves it, into one ES module on the host's React (`react` and the JSX runtime resolve to the page's single copy). A plugin UI may import only `react` and files inside its `ui` folder; type-only imports of the host API types are erased. Bundled plugins' UI is served from `bundled-plugins/<folder>/<ui>`.

**Plugin data and studies.** Each plugin has a folder in each project, `projects/<pid>/plugins/<key>/`, created on first write. A plugin method gets it as `scope["data"]` (`cfddesk.registry.plugin_data.PluginData`: `read_json`, `write_json`, `delete`, and the study helpers), bound to the calling plugin and project; a path outside it is refused. These writes are the one exception to "only the worker writes project files".

A manifest's `[[study_kinds]]` (`key`, `title`, `icon` as one SVG path, `workspace`, `schema_version`) declares project-level studies the plugin owns, stored at `plugins/<key>/studies/<sid>/study.json` (`id, kind, title, schema_version, rev, plugin, plugin_name, plugin_version, created_at, updated_at`). The tree shows them in a STUDIES section in every stage, with New / Rename / Delete. RPCs `plugin_studies.list|create|rename|delete` (routes `/api/plugin-studies`); a rename with an old `rev` is refused with HTTP 409 ("This study changed in another tab. Reload to continue."). A study saved by a newer plugin version is read-only. A study whose plugin is off or missing stays on disk untouched, greyed in the tree ("Requires the <Name> plugin", with a link to Settings → Plugins); it can be deleted but not opened or renamed. Scope key: `p:<pid>/plugin:<key>/study:<sid>` (`plugin_study_scope` / `pluginStudyScope`).

**Own environment and service.** A manifest's `[python]` (`requirements` lock, pinned and hashed; `python` range; `service` module; `find_links` wheels folder) gives the plugin its own environment at `.cache/plugin-envs/<key>-<lock hash>/` (`MAGNUSIM_PLUGIN_ENVS_DIR` moves it), built from the core interpreter with `magnusim_sdk` and without `cfddesk`. Until it is built, `plugins.list` rows say `status = "needs setup"` with `python_env = {state: needs_setup | failed | ready, error, tail, lock_hash, service, python_version}`; Settings → Plugins offers Install dependencies (`POST /api/plugins/<key>/env/install`, polled at `GET /api/plugins/<key>/env`; `POST .../env/remove` deletes it; both local-operator only). `tools/plugin_env.py create|check|remove <key>` and `create-bundled` (`Setup.ps1 -Plugins`) do the same from a shell. With a `service`, `/api/plugin/<key>/<method>` answers from `python -I -m magnusim_sdk.service <module>` in the plugin folder: one process per plugin, 30 s per call unless the method sets `timeout_s` (600 max), killed with its children on a timeout, restarted after a crash, stopped after 10 minutes idle and when the plugin is turned off or reloaded. A plugin without a service keeps its in-process `hub.register_method` methods on the plugin lane. Worker RPCs: `plugins.env`, `plugins.env_remove`.

**Jobs and filters on the plugin's environment.** `JobKind.python = "plugin"` runs a job's tool on the plugin's environment in its folder (`jobs.describe` rows add `runtime`, `python`, `cwd`, and `python_error` while it needs setup: starting it answers 409). A plugin with an environment runs its filter tools there too. Stopping a job ends its whole process tree.

**Study migrations.** Plugin study rows add `schema_version`, `kind_schema_version` and `needs_migration`; the host upgrades older ones in the background through the service's `migrate_study` and `plugin_studies.get` / `plugin_studies.migrated` (rev-checked; the tree says `plugin_studies_migrating` meanwhile). A study of a plugin that needs setup is greyed with "<Name> needs setup".

**Requirements checked for real.** `wsl_tool` requirements are checked against a cached probe of the WSL toolchain (unknown until it answers, never reported missing then); `python` ones against the plugin environment's installed packages; `gpu` is reported as a note (`notes`) and never blocks.

**`magnusim_sdk` 1.1** adds `data` (`PluginData`, the one copy; `cfddesk.registry.plugin_data` re-exports it) and `service`.

**Workspaces.** A manifest's `[[workspaces]]` (`key`, `title`, `icon` as one SVG path, `entry`: an `.html` file in the plugin's `workspace/` folder, `workspace/index.html` by default) declares a full page the plugin draws. A study kind's `workspace` names one; it must be declared, or the plugin fails to load with that message. A study of that kind opens in it at `#/p/<pid>/ws/<plugin>/<workspace>/<sid>`, over the project's workbench: the tree and the active study stay as they were, and Back, reload, browser history and deep links work. The host draws the header: Back to project, `<Plugin> › <Study>` (click to rename), Queue and Settings. The header's Workspaces menu (shown only while an enabled plugin has a workspace) names a new study and opens it. `plugins.list` rows add `workspaces`; study kinds and study rows add `workspace` (`""` when there is none).

The page runs in a sandboxed frame (`sandbox="allow-scripts allow-downloads"`, an opaque origin), served from `/plugins/<key>/workspace/` while the plugin is on. Its Content-Security-Policy allows scripts, styles and fonts from `/plugin-sdk/` and its own folder, `fetch` to its own folder only, images and media from its own folder plus `data:` and `blob:`, workers from `blob:`, WebAssembly, and no inline script but the host's import map. It cannot reach the app's page, the app's API, `localStorage`, IndexedDB or cookies.

**Workspace SDK 1.0** (`/plugin-sdk/`). The host puts an import map and `/plugin-sdk/theme.css` (the `--mg-*` design tokens and base styles) first in every workspace page. The import map names `react`, `react-dom/client`, `react/jsx-runtime` and `react/jsx-dev-runtime` (the app's React as ES modules, one copy), and `@magnusim/workspace` (the bridge). `docs/plugins/plugin-sdk.json` gives the versions and the import map; `docs/plugins/workspace-sdk.d.ts` (also served as `/plugin-sdk/workspace.d.ts`) gives the bridge's types. `npm run gen:plugin-sdk` regenerates both, and CI checks they are current. `connect()` says hello and gets the context (plugin, workspace, project, study, units, theme) and a private port; every call then goes over that port, scoped to the plugin, the project and the study:

| Call | What it does |
|---|---|
| `service(method, params)` | Its own backend (`/api/plugin/<key>/<method>`), never another plugin's |
| `jobs.start(kind, params)`, `jobs.events(id, fn)`, `jobs.stop(id)` | Its own job kinds (a start that names another plugin's kind is refused, 403); events and Stop only for jobs this workspace started |
| `study.get()`, `study.update(patch, rev)` | Its study; a stale `rev` is refused. The host keeps `id`, `kind`, `plugin`, `plugin_name`, `plugin_version`, `schema_version`, `created_at`, `updated_at` and `rev` |
| `data.read(rel)`, `data.write(rel, doc)` | JSON in its own folder of the project (8 MB at most, the one request allowed past the app's 2 MB JSON limit). `..`, `:` and `~` are refused, and so is a study's record (`studies/<sid>/study.json`, any spelling) |
| `project.info()`, `call('prefs.units')`, `call('theme')` | Read-only project title and units, the theme |
| `ui.toast`, `ui.confirm`, `ui.prompt`, `nav.back` | The app's toast and dialogs; close the workspace |
| `on('units' \| 'theme' \| 'study', fn)` | Changes the host pushes while it is open. `study` carries the record after a rename in the header or a save, so the next `study.update` uses its `rev` (`context.study` follows too) |
| `spawnWorker(url)` | A worker running your module (the sandbox refuses `new Worker(url)`); messages posted before your module has loaded are held and delivered to it in order |

Anything else answers `not allowed: …`, and the host logs it. A page that has not connected 5 s after it started loading gets an error card (Open Settings → Plugins, Try again). A study deleted while it is open, or a link to one, shows "This study no longer exists." with Back to project. Worker RPCs `plugin_studies.get|update` and `plugin_data.read|write` (routes `/api/plugin-studies/get|update`, `/api/plugin-data/read|write`); a missing study answers 404 `study not found` (`magnusim_sdk.data.StudyNotFoundError`).

## 1.0

The first plugin host API: `register(hub)`, `manifest.toml`, registry kinds (analysis, solver, mesher, bc, material, monitor, filter, job), hooks, UI panels in `filters` and `prefs`, plugin methods at `/api/plugin/<key>/<method>`.
