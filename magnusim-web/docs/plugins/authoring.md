# Writing a Magnusim plugin

A plugin adds or replaces one aspect of the workbench. Drop a folder in `plugins/` or install a wheel that publishes a `cfddesk.plugins` entry point, then restart. The host loads `register(hub)` for Python and, when the manifest names a UI bundle, `register(host)` for the page.

Copy `templates/plugin/` to start. That folder has `pyproject.toml`, `manifest.toml`, `register()`, and a pytest that loads the copy from a temporary `plugins/` directory.

## Manifest 1.0

```toml
key = "my-plugin"
name = "My plugin"
version = "0.1.0"
api_version = "1.0"
description = "What this plugin adds"
authors = "Your Name"
ui = "ui"
ui_entry = "index.js"
```

`api_version` must share the host major version (`1`). A different major is listed as `incompatible` and is not registered. `authors` is a comma-separated list when you have more than one. Omit `ui` when the plugin has no browser bundle.

`overrides` is a comma-separated list of `kind:key` tokens. A plugin may replace a protected builtin only when that token is listed. New keys do not need an override.

A wheel's entry point belongs in `pyproject.toml` once the register function is importable:

```toml
[project.entry-points."cfddesk.plugins"]
my-plugin = "my_plugin:register"
```

Folder discovery loads `plugins/<folder>/plugin.py` and does not need that table.

## Register

`register(hub)` runs after the builtins. Clone a spec that is already on the hub and register it under a new key:

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

Do not import `cfddesk.builtin`, `scripts`, or `src.workbench`. Those are host internals. The public surface is `cfddesk.registry`.

## UI

Build the browser bundle with `react`, `react-dom`, and `@cfddesk/plugin-ui` marked external. The host passes one React and one plugin-ui object:

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

`pluginUi` can register a panel, replace a host panel, add a filter widget, or add a tree transform. Tree nodes must carry the current project scope or the tree drops them.

## Plugins tab

Preferences lists each plugin's key, name, version, source (`local` or `entry_point`), and status (`enabled`, `disabled`, `incompatible`, `missing requirement`, or `error`). Enable and Disable call the plugin routes and reload the registry. Reload runs `registry.reload` and loads UI bundles again.

## License

Magnusim is GPL-3.0-or-later. A plugin runs inside the Magnusim Python worker and page, so a distributed plugin is part of a GPL-3.0-or-later combined work. License it under GPL-3.0-or-later or a GPL-compatible license such as MIT, BSD, Apache-2.0, or LGPL-3.0. The template declares GPL-3.0-or-later.

## Registry reference

`docs/plugins/registry.json` is the committed `registry_dump` output: analysis, solver, mesher, boundary condition, material, monitor, and filter keys, plus the loaded plugin manifests. Regenerate it with `npm run gen:registry` from `magnusim-web/` after a plugin changes `describe()`, then copy that file here.
