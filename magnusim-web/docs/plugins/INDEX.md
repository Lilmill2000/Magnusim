# Plugin docs

Everything a plugin author needs is in this folder. Read it in this order.

| File | What it is |
| --- | --- |
| [GUIDE.md](GUIDE.md) | How to build a plugin end to end: the kinds, the rules, the layout, testing and the definition of done. Start here. |
| [DESIGN.md](DESIGN.md) | How a plugin must look and read: tokens, layout, the kit, copy, numbers, plots, icons, accessibility. |
| [API.md](API.md) | The reference, generated from the app's code: manifest keys, the workspace bridge, the UI kit, the in-page host API, `magnusim_sdk`, the analysis contract, hooks, the built-in registry. |
| [authoring.md](authoring.md) | The long form of each feature: register, environments, the analysis contract, BCs and materials, workspaces, OpenFOAM cases, start actions, linking a geometry, exit sync, the UI kit. |
| [compatibility.md](compatibility.md) | What each host API version added or changed, and what the 1.6 freeze promises. |
| [manifest.schema.json](manifest.schema.json) | The manifest's JSON Schema (generated). |
| [workspace-sdk.d.ts](workspace-sdk.d.ts) | The types of `@magnusim/workspace`, the bridge a workspace page imports (generated). Copy it into your plugin. |
| [plugin-ui.d.ts](plugin-ui.d.ts) | The types of `@magnusim/plugin-ui`, the UI kit (generated). Copy it into your plugin. |
| [plugin-api.d.ts](plugin-api.d.ts) | The types of `@magnusim/plugin-api`: the `host` an in-page UI's `register(host)` gets (generated, types only). A plugin with a `ui/` folder copies it beside `plugin-ui.d.ts`; a workspace page does not need it. |
| [plugin-sdk.json](plugin-sdk.json) | The bridge, kit and React versions, and the import map a workspace page gets (generated). |
| [registry.json](registry.json) | Every key the core and the bundled plugins that are on by default register, per kind (including `bc_family`), with schemas, `plugins` and `default_analysis` (generated). |
| `img/` | The pictures in DESIGN.md: screenshots of the app's UI kit sheet and the Airfoil plugin, and three "don't" specimens drawn on the app's own `theme.css` and kit CSS. |

Commands, from the app folder (`magnusim-web/`):

| Command | What it does |
| --- | --- |
| `npm run plugin:new -- <key> [--workspace\|--analysis] [--service] [--venv] [--study-kind <title>]` | Makes a new plugin that passes every check |
| `npm run plugin:check -- <path> [--json] [--no-tests]` | Checks a plugin against the rules and runs its tests |
| `npm run plugin:pack -- <key or folder> [--out <folder>] [--no-tests]` | Checks a plugin, then zips it as `dist/<key>-v<version>.zip` for Settings → Plugins → Install plugin from zip ([GUIDE.md](GUIDE.md), "Shipping a plugin, and updates") |
| `npm install`, then `npm run build`, in the plugin folder | Builds a workspace page from `src/` into `workspace/`, which the host serves |
| `npm run dev` (or `run.bat`) | Starts the app, at http://127.0.0.1:8082 unless Settings saved another port ([GUIDE.md](GUIDE.md), "Quick start", has a second server of your own) |
| `npx playwright test -c <plugin>/tests/e2e/playwright.config.js` | Runs a plugin's browser test on a test server of its own |
| `npm run test:docs` | Runs every code block marked `test` in these docs |
| `npm run gen:plugin-sdk` | Writes the three `.d.ts` files and `plugin-sdk.json` |
| `npm run gen:plugin-docs` | Writes `API.md` and `manifest.schema.json` |
| `npm run gen:registry` | Writes `registry.json` |

Generated files are never edited by hand. CI fails when one is out of date (`gen:plugin-sdk:check`, `gen:plugin-docs:check`, `gen:registry:check`).
