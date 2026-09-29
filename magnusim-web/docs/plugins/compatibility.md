# Plugin API compatibility

The host loads a plugin whose `api_version` has the same major version as its own (`cfddesk.registry.API_VERSION`). A minor version adds things; it never removes or changes what an older minor version offered, so a `1.0` plugin loads unchanged on a `1.1` host.

## 1.1

**Analysis contract** (`cfddesk.registry.contract`). Optional fields on `AnalysisType`; the core falls back to a neutral default for any left out, and a plugin that clones a builtin with `dataclasses.replace` keeps the builtin's:

| Field | What the core does with it |
|---|---|
| `family` (`AnalysisFamily`) | Create Simulation title, description, tags; the study's name |
| `study_defaults(time_dependency)` | A new study's settings (published in `registry.describe` as `study_defaults`) |
| `algorithm_label`, `residual_keys`, `x_axis`, `ui` | What the study and run panels show |
| `validate_ready(ctx)` | What blocks a run: `[{"message", "fix"}]`, checked before the run is marked running |
| `run_model` (`RunModel`) | Run settings `defaults()`, `normalize()`, `preview()` (the Run panel preview) |
| `launch` (returns `LaunchSpec`) | Program, `keep_frames` (`all` / `latest`), `process_names`, `stop_strategy`, `frame_fields`, `log_parser` |
| `log_parser` (`LogParserRef`) | The one solver-output parser; Node only aggregates its events |
| `frame_fields` | Fields that mark a written result frame (default: `fields`) |

Worker RPCs: `analysis.describe`, `analysis.defaults`, `analysis.validate_ready`, `analysis.run_preview`, `analysis.launch_spec`. `run.transient_preview` is gone; `analysis.run_preview` replaces it.

`prepare_run` reports `app` as the program to run (the solver's `application`, not its registry key), plus `launch` and the boundary-to-patch mapping `bcs`. It refuses a run that is not ready (`{"ok": false, "not_ready": true, "error", "fix"}`) and writes nothing.

**Bundled tier.** `bundled-plugins/` ships with the app and loads after the core builtins and before entry points and user plugins, in dependency order. New manifest fields: `tier = "bundled"`, `required`, `requires_plugins` (also for user plugins), `protected`. A required plugin that does not load blocks creating and running simulations with a message (`registry.describe` → `required_missing`); it cannot be turned off. Incompressible Flow (`incompressible_steady`, `incompressible_transient`, `simpleFoam`, `pimpleFoam`, `simpleFoam_amgx`) is the required bundled plugin; the keys are unchanged, so projects need no migration. `MAGNUSIM_BUNDLED_DIR` moves the bundled folder (tests); `MAGNUSIM_PLUGINS_DIR` still moves only the user plugins.

**`magnusim_sdk`** (`python/sdk`, standard library only): `events`, `units`, `foam`, `gmsh_helpers`, `msh22` (numpy imported when used), `proc`. Plugins may import `magnusim_sdk` and `cfddesk.registry` only (`tools/plugin_boundary.py`).

## 1.0

The first plugin host API: `register(hub)`, `manifest.toml`, registry kinds (analysis, solver, mesher, bc, material, monitor, filter, job), hooks, UI panels in `filters` and `prefs`, plugin methods at `/api/plugin/<key>/<method>`.
