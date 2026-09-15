---
name: "Phase 5: Plugin Loader End to End"
overview: "Prove the plugin seam with two in-repo demo plugins (one schema-only Python plugin, one with a custom React panel), define the plugin package layout and manifest, add a plugin manager UI, write the authoring guide and a template repository, and version the plugin API."
todos:
  - id: p5-manifest-spec
    content: "Finalize manifest.toml schema (key, version, api_version, requires, provides, ui) and PluginManifest validation"
    status: pending
  - id: p5-demo-schema-plugin
    content: "plugins/example-laminar: AnalysisType laminar_steady + MaterialModel preset; no UI code; runs a case end to end"
    status: pending
  - id: p5-demo-ui-plugin
    content: "plugins/example-probe-widget: ResultFilter with custom React panel loaded from /plugins/:key/ui/index.js"
    status: pending
  - id: p5-ui-loading
    content: "Frontend plugin loader: fetch /api/plugins, dynamic import ui entry, register via @cfddesk/plugin-ui; sandbox/error boundary"
    status: pending
  - id: p5-plugin-manager
    content: "Preferences > Plugins panel: list, enable/disable, missing requirements, reload"
    status: pending
  - id: p5-template-repo
    content: "cfddesk-plugin-template: cookiecutter/copier template with Python package, optional ui/, tests, CI"
    status: pending
  - id: p5-docs
    content: "docs/plugins/: authoring guide, registry reference (generated), UI API reference (typedoc), compatibility policy"
    status: pending
  - id: p5-api-versioning
    content: "cfddesk.registry.API_VERSION, @cfddesk/plugin-ui version; compatibility checks at load; deprecation path"
    status: pending
  - id: p5-tests
    content: "Plugin e2e: install both demos from wheel into venv, Playwright shows new analysis + panel"
    status: pending
isProject: false
---

# Phase 5: Plugin Loader End to End

## Goal

Someone who is not the author can create a plugin from a template, `pip install` it into the app's venv, restart, and see a new analysis type, mesher, BC, material, monitor, result filter, or UI panel, without touching core code.

## Prerequisites

- Phase 2 registries + discovery (`cfddesk/registry/discovery.py`, entry point group `cfddesk.plugins`, `plugins/` folder scan).
- Phase 3 `GET /api/plugins`, `/plugins/:key/ui/*`, `POST /api/plugins/:key/enable|disable`, registry reload.
- Phase 4 `@cfddesk/plugin-ui` API.

## Plugin package layout (normative)

```
cfddesk-<name>/
  pyproject.toml            # [project.entry-points."cfddesk.plugins"] <key> = "cfddesk_<name>:register"
  manifest.toml             # copied into wheel as package data
  src/cfddesk_<name>/
    __init__.py             # def register(hub: RegistryHub) -> PluginManifest
    analysis.py | meshers.py | bcs.py | materials.py | monitors.py | filters.py
    templates/*.sh          # optional WSL scripts
    tools/*.py              # optional CLI tools invoked as jobs
    ui/                     # optional prebuilt ESM bundle: index.js (+ assets); source lives in ui-src/
  ui-src/                   # optional: TS/React source, built with the template's vite config to ui/
  tests/
```

`manifest.toml`:

```toml
key = "example_laminar"
name = "Example: laminar steady flow"
version = "0.1.0"
api_version = "1"                 # cfddesk.registry.API_VERSION major
description = "..."
authors = ["..."]
[requires]
wsl_tools = ["simpleFoam"]        # checked via requirements.check_requirements
python = ">=3.10"
cfddesk = ">=0.3,<0.4"
[provides]
analysis = ["laminar_steady"]
material = []
[ui]                              # optional
entry = "ui/index.js"
panels = ["probe_widget"]         # keys registered by the bundle; informational
```

`PluginManifest` (Phase 2) gains `api_version`, `authors`, `description`, `cfddesk_spec`; `discovery.load_all()` refuses plugins whose `api_version` major != core and reports them under `incompatible` in `/api/plugins`.

## Step 1: Demo plugin A — schema-only (`plugins/example-laminar/`)

- `register(hub)`:
  - `hub.analysis.register(AnalysisType(key="laminar_steady", label="Laminar Fluid Flow (example)", category="FLUID DYNAMICS", time_dependency="steady", fields=("U","p"), turbulence_models=("laminar",), default_turbulence="laminar", bc_types=<subset of builtin keys>, material_models=("newtonian_incompressible",), solver_backends=("simpleFoam",), default_solver="simpleFoam", monitors=("area_average","flow_rate"), result_fields=(U, p), settings_schema=(SchemaField("re_hint","Target Reynolds number","float",...),), write_case=builtin.incompressible.write_case_with(turbulence="laminar"), validate=...))`.
  - `hub.material.add_preset("newtonian_incompressible", {"key":"glycerin", "nu":..., "rho":...})`.
- No `ui/`. The Simulation picker (Phase 4) lists it automatically; `SimulationDefaults` renders `re_hint`.
- Test: `tests/e2e/plugin_laminar.spec.ts` creates a simulation of this type on the sample project, meshes at F=1, runs 20 iterations, asserts `done`.

## Step 2: Demo plugin B — custom UI (`plugins/example-probe-widget/`)

- Python: `ResultFilterSpec(key="probe_grid", label="Probe grid (example)", params_schema=(nx, ny, field), tool="cfddesk_example_probe/tools/export_probe_grid.py", output="json", cache_scope="case_time")`. Tool samples a grid of points with pyvista and returns JSON.
- UI (`ui-src/index.tsx` built to `ui/index.js`): `import { registerPanel, useViewer, useJob, SchemaForm } from "@cfddesk/plugin-ui"; registerPanel({ key: "probe_widget", title: "Probe grid", place: "filters", Component: ProbeGridPanel })`. The panel renders `SchemaForm` for params, calls `GET /api/filter/probe_grid`, draws spheres via `useViewer().addLayer("plugin:probe_grid", ...)`, shows a table.
- Build: `ui-src/vite.config.ts` with `build.lib` `formats: ["es"]`, `external: ["react","react-dom","@cfddesk/plugin-ui"]` and an import map in `index.html` (Phase 4 adds `<script type="importmap">` mapping `react`, `react-dom`, `@cfddesk/plugin-ui` to the app's own copies exposed at `/vendor/*.js`) so plugin bundles share the host React instance.

## Step 3: Frontend plugin loading

`src/plugins/loader.ts`:

1. `GET /api/plugins` -> enabled manifests with `ui.entry`.
2. For each: `await import(/* @vite-ignore */ \`/plugins/${key}/ui/index.js\`)` inside try/catch; errors surface as a toast + entry in Plugin Manager, never block app boot.
3. Registration calls from the bundle go into `src/plugin-api/registry.ts` (client-side registry of panels, widgets).
4. Places: `tree` (adds a node under the simulation), `toolbar` (button), `filters` (section), `results` (tab). Each place renders registered components inside an `ErrorBoundary` that shows plugin key + error.
5. Hot reload in dev: `POST /api/plugins/reload` then page reload.

## Step 4: Plugin Manager UI

Preferences (Phase 4 `SetupWizard`/Preferences) gains a **Plugins** tab: table of key, name, version, source (`entry_point` | `local`), status (`enabled`, `disabled`, `incompatible`, `missing requirements: cartesianMesh`), toggle, Reload button, link to plugin folder. Uses `GET /api/plugins`, `POST /api/plugins/:key/enable|disable`, `POST /api/plugins/reload`.

## Step 5: Template repository

`cfddesk-plugin-template/` (copier template) generating the layout above with:

- `pyproject.toml` with entry point, `cfddesk` dependency pin, `pytest`.
- `tests/test_register.py`: `load_all()` with the plugin registered; schemas validate defaults.
- Optional `ui-src/` with the shared vite lib config and a `HelloPanel`.
- GitHub Actions: ruff, pytest, `npm run build` for ui.
- `README.md` with install: `cfd-web\python\.venv\Scripts\pip install .` then restart app.

Publish as a folder in this repo (`templates/plugin/`) plus instructions; a separate GitHub repo only if the user asks.

## Step 6: Documentation

`docs/plugins/`:

- `authoring.md`: lifecycle, layout, manifest, `register()`, each spec type with a minimal example, requirements, testing, packaging, install paths (venv pip vs `plugins/` folder).
- `registry-reference.md`: **generated** by `tools/registry_dump.py --markdown` from spec dataclass docstrings and `SchemaField` metadata.
- `ui-api.md`: **generated** by typedoc from `src/plugin-api/`.
- `compatibility.md`: `API_VERSION` policy (major bump = breaking), deprecation warnings (`registry.warn_deprecated(key, since, removal)` surfaces in Plugin Manager), what core guarantees (event protocol, case layout, `CaseContext` fields).
- `examples.md`: walkthrough of both demo plugins.

`cfd-web/README.md` links to `docs/plugins/`.

## Step 7: API versioning

- `cfddesk/registry/__init__.py`: `API_VERSION = "1.0"`. `discovery` compares major.
- `@cfddesk/plugin-ui` `package.json` version `1.0.0`; exported `PLUGIN_UI_API_VERSION`; loader logs mismatch.
- Add `cfddesk/registry/compat.py` with `deprecated(...)` decorator producing structured warnings collected per plugin.
- Freeze `SchemaField`, `AnalysisType`, `MeshBackend`, `SolverBackend`, `BcTypeSpec`, `MaterialModel`, `MonitorType`, `ResultFilterSpec`, `CaseContext`, `Event` as the 1.0 surface; document in `compatibility.md`.

## Step 8: Tests

- `tests/unit/test_plugins_demo.py`: both demos register under `load_all()`; `check_requirements` OK given fake env; `ResultFilterSpec("probe_grid")` describe includes schema.
- Build both demo wheels in CI (`python -m build plugins/example-*`), install into a fresh venv with `cfddesk`, run `registry_dump.py` and assert keys present (proves entry-point discovery, not just folder scan).
- Playwright: with demos enabled, Simulation picker shows "Laminar Fluid Flow (example)"; Filters panel shows "Probe grid" and renders spheres (assert layer exists via `window.__cfdDebug.layers()` test hook); disabling the plugin in Plugin Manager and reloading removes both.
- Failure path: install a plugin whose `register()` raises; app boots, Plugin Manager shows the error, built-ins unaffected.

## Acceptance criteria

- Two demo plugins live in `plugins/`, install from wheel, and are visible in the UI with zero core edits.
- A plugin with a broken import or wrong `api_version` cannot break app startup.
- `docs/plugins/` complete; template generates a passing project.
- `API_VERSION` and `@cfddesk/plugin-ui` versions published and checked at load.
