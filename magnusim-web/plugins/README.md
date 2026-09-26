# Plugins

Magnusim loads plugins from this folder. Each plugin is one subfolder with a
`manifest.toml` and a `plugin.py`. A plugin can also have a `ui/` folder for
its panels.

Start a new plugin by copying `templates/plugin/` here and renaming it. The
authoring guide is `docs/plugins/authoring.md`. Turn plugins on or off in
**Settings → Plugins**.

Magnusim ships with no plugins, so this folder starts empty.
