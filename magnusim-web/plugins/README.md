# Plugins

Magnusim loads plugins from this folder. Each plugin is one subfolder with a
`manifest.toml` and a `plugin.py`. A plugin can also have a `ui/` folder for
its panels and a `workspace/` folder for a page of its own.

Start a new plugin with `npm run plugin:new -- <key>` (from `magnusim-web/`);
it is written here. Check it with `npm run plugin:check -- plugins/<key>`. The
plugin docs start at `docs/plugins/INDEX.md`. Turn plugins on or off in
**Settings → Plugins**.

A plugin someone sends you as a zip (made with `npm run plugin:pack`) is
installed with **Settings → Plugins → Install plugin from zip…**, which puts
it here. A newer version of a plugin that ships with the app is an update: it
is used in place of the app's own copy, and **Remove update** goes back.

The plugins that ship with the app are in `bundled-plugins/`, so this folder
starts empty.
