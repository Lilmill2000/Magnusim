# Workspace plugin template

A plugin whose study kind opens in its own full page (a workspace), for host API 1.4.

1. Copy this folder into the app's `plugins/` folder and rename it; change `key`, `name` and `PLUGIN` in `plugin.py` to your plugin's key.
2. Restart the app, then turn the plugin on in Settings → Plugins if it is off.
3. In a project, the header's Workspaces menu has "New Sketch".

Optional, in `manifest.toml`:
- `[[start_actions]]` (host 1.4): buttons that create a study and open it, in the empty project, the header, the New Project dialog and Home.
- `links_geometry = true` (host 1.5): the page may hand a design to the simulation as a project geometry (`workspace/main.js` has the call, commented out; `docs/plugins/authoring.md`, "Linking a geometry (1.5)", is its how-to).

`docs/plugins/authoring.md` describes every part; `python/tests/unit/test_start_actions.py` loads this template as it is and with its examples turned on.
