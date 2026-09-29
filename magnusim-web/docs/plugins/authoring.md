# Writing a Magnusim plugin

A plugin adds or replaces one aspect of the workbench. Drop a folder in `plugins/` or install a wheel that publishes a `cfddesk.plugins` entry point, then restart. The host loads `register(hub)` for Python and, when the manifest names a UI bundle, `register(host)` for the page.

Copy `templates/plugin/` to start. That folder has `pyproject.toml`, `manifest.toml`, `register()`, and a pytest that loads the copy from a temporary `plugins/` directory.

## Manifest 1.1

```toml
key = "my-plugin"
name = "My plugin"
version = "0.1.0"
api_version = "1.1"
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

Plugins that ship with the app live in `bundled-plugins/` and add `tier = "bundled"`, `required = true|false` and `protected = ["kind:key", ...]` (specs other plugins may not drop). A required plugin cannot be turned off. See `compatibility.md` for what changed in each API version.

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

`host` is `{ React, ReactDOM, pluginUi, scope }`. `scope` is the open project's scope id. There is no import map. A thrown `register` or a thrown panel is a Plugins-tab row and a toast. Builtins stay loaded.

`pluginUi` can register a panel, replace a host panel, add a filter widget, add a schema field widget, or add a tree transform. Tree nodes must carry the current project scope or the tree drops them.

A panel's `place` is `"filters"` (the Filters panel) or `"prefs"` (your row in Settings → Plugins). Those are the only places the app draws. The older names `tree`, `toolbar`, `results` and `geometry` were never shown; registering there now fails and your plugin shows an error row.

`registerFieldWidget(name, Component)` renders any schema field whose `x-cfddesk.widget` is `name` with your component.

Everything your `register(host)` adds is recorded under your plugin key. Disabling the plugin removes it at once, and reloading replaces it instead of adding a second copy.

## Plugins tab

Settings → Plugins lists each plugin's key, name, version, source (`local` or `entry_point`), and status (`enabled`, `disabled`, `incompatible`, `missing requirement`, or `error`). Enable and Disable call the plugin routes and reload the registry. Reload runs `registry.reload` and loads UI bundles again.

## License

Magnusim is GPL-3.0-or-later. A plugin runs inside the Magnusim Python worker and page, so a distributed plugin is part of a GPL-3.0-or-later combined work. License it under GPL-3.0-or-later or a GPL-compatible license such as MIT, BSD, Apache-2.0, or LGPL-3.0. The template declares GPL-3.0-or-later.

## Registry reference

`docs/plugins/registry.json` lists the keys Magnusim itself registers: analysis, solver, mesher, boundary condition, material, monitor, and filter. It holds builtins only; your plugin's keys never appear in it, and the app reads them from the live registry while it runs. `npm run gen:registry` (from `magnusim-web/`) regenerates it together with `scripts/generated/registry.json`.
