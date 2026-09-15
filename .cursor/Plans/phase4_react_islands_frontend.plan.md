---
name: "Phase 4: React + TypeScript Frontend as Islands"
overview: "Migrate the 25,790-line src/main.js to a React + TypeScript application incrementally: first a typed vtk.js viewer module and a store both old and new code share, then convert each #panel-* flyout to a React island rendering backend JSON Schemas, then the tree, toolbar, filters panel, results, and home. main.js shrinks with every panel and is deleted at the end. Panel chrome (Done/Delete, persist on change) is preserved exactly."
todos:
  - id: p4-scaffold
    content: "Add React 18, TypeScript, Zustand, @rjsf/core + validator, TanStack Query; vite.config.ts react plugin; src/app/ shell mounted beside legacy main.js"
    status: pending
  - id: p4-viewer-module
    content: "src/viewer/: typed imperative wrapper over vtk.js (scene, layers, pick, lut, camera, capture) extracted from main.js L657-1258 and users; legacy code calls it"
    status: pending
  - id: p4-store-and-api
    content: "src/store/ (project, ui, jobs) + src/api/ typed client from /api/registry and route table; SSE job subscription"
    status: pending
  - id: p4-schema-form
    content: "src/forms/SchemaForm.tsx: renders x-cfddesk JSON Schema (units, groups, depends_on, advanced) with rjsf; unit conversion via prefs"
    status: pending
  - id: p4-island-bridge
    content: "src/islands.tsx: mountIsland(panelId, Component); legacy openTreeDetail calls it; shared events for Done/Delete"
    status: pending
  - id: p4-panels-wave1
    content: "Convert Simulation picker/hub, Mesh form, Mesh hub, BC editor/picker/hub, Materials panels"
    status: pending
  - id: p4-panels-wave2
    content: "Convert Refinements, Result controls (Area average), Sim control (Run), Run results/graphs/media, Geometry panel"
    status: pending
  - id: p4-tree-toolbar
    content: "Convert left tree, top toolbar, job chip, iterations scrubber, filters panel (cut/pt/iso/animation) to React"
    status: pending
  - id: p4-home-wizard
    content: "Convert dashboard.js home + setup-wizard.js to React routes"
    status: pending
  - id: p4-delete-mainjs
    content: "Delete main.js/dashboard.js/setup-wizard.js; strict TS; eslint clean; publish @cfddesk/plugin-ui types"
    status: pending
isProject: false
---

# Phase 4: React + TypeScript Frontend as Islands

## Why React + TypeScript (decision recorded)

- Most plugins ship **no UI**: settings are JSON Schema from Python; the frontend renders them. Only rich plugins write components.
- React has the largest pool of third-party contributors and mature schema-form tooling (`@rjsf`). vtk.js is framework-agnostic and is wrapped imperatively.
- TypeScript gives plugin authors a typed `PluginUiApi` discoverable by autocomplete.
- Islands allow panel-by-panel migration with the app working at every commit.

## Findings this phase is built on

### Frontend today

- `index.html` 2017 lines: `#home` L23-87, `#app.workbench` L89-1616 (`#top-header` 90-104, `#toolbar` 106-177, `#tree-float-stack`/`#left-tree` 180-208, `#tree-detail` 223-1059 hosting 23 `#panel-*` divs, `#job-debug-drawer` 1063-1090, `.viewport-wrap` 1092 with `#viewer` 1109 and `#viewer-b` 1113, `#viewport-job-chip` 1137, `#filters-panel` 1179-1526, `#legend*` 1528+, `#right-chrome`/`#iterations-panel` 1590-1614), `#setup-wizard` 1617-1667, modals 1668-2010.
- `src/main.js` 25790 lines, 962 top-level functions, 818 `getElementById`. Section map (from banners): VTK bootstrap 657-1067; filter states 551-705; inspect/field/glyphs 1068-2626; particle pulses 2627-3184; colour scale 3185-4709; modal helpers 4710-6108; mode-aware filters + mesh inspect 6109-8099; compare 8100-8855; mesh section 8856-9125; filter sets 9126-9385; saved views 9386-10404; animation 10405-11002; PT animation 11003-11319; inspect point 11320-11615; job status 11616-12318; W16 project/CAD 12319-13895 (tree detail API 12843-13054: `TREE_DETAIL_IDS`, `openTreeDetail`, `hideAllTreeDetails`, `dismissTreeDetail`); W17 simulations 13896-15001; W18 materials 15002-18934; BC defaults/editor 18553-19328; W20 mesh form 19329-20249; refinements 20250-20809; generate 20810-21444; W22 AA ~20948-21442; sim control 21445-21470; W30 transient/solve 21471-22859; live results 22860-23235; monitors 23236-23503; media 23504-23837; capture 23838-24818; graphs 24819-25150; job drawer + tree wiring 25151-25790.
- Module state: `caseDir/currentTime` L86-113, `cutState` 551, `ptState` 567, `popState/isoState/ivState` 600-632, `inspectState` 637, `compareState` 686, `animState` 10409, `jobState` 11617, `w16State` 12721, `treeUi` 12874, `w17State` 13907, `w18State` 15016, `w19State` 18553, `w20State` 19353, `w26State` 20256, `w22State` 20959, `w27State` 21446, `captureState` 23840.
- vtk.js imports L7-40 (`vtkFullScreenRenderWindow`, actors/mappers, `vtkCellPicker`, `vtkHardwareSelector`, `vtkCutter`, `vtkTubeFilter`, `vtkGlyph3DMapper`, manipulators, `vtkOrientationMarkerWidget`, ...). Renderer L657-674, triad 722-746, compare viewer `ensureCompareViewer` 7529-7591, pickers 1108/12341/12404/17286, LUT 1241-1258, planes `addResultPlane` 2151 / `addMeshPlane` 7175, capture 23838-24637 (`canvas.toBlob`, `MediaRecorder`).
- Persistence pattern: `saveMeshSettingsClient` 19964 on `change`; `persistActiveBc` 19014; `persistActiveRef` 20594; `persistSimControl` 22706; `persistRunSettings` 21800; Done = delegated click on `.tree-panel-done` L25731 -> `dismissTreeDetail()`; Delete = per-panel ids.
- Polling: `startJobPoll` 12141 (750 ms `/api/case`), `startSimPoll` 22913 (1500 ms `/api/run/status`) — Phase 3 provides SSE `/api/jobs/:id/events`.
- Units: no conversion library; `unitsForVelocity` 18658, `formatCadLength` 15836, CAD in mm vs results in m with `applyMeshDisplayScale` 6934 / `captureRelativeCamera` 6328.
- `dashboard.js` 1030 lines: hash router (`parseHomeRoute`), home grid, project CRUD. `setup-wizard.js` 236 lines: prefs + hardware check.
- Workspace rule: flyouts use **Done** and **Delete** only; no checkmark in headers; settings persist on Apply/Generate/field change.

## Step 1: Scaffold

- Dependencies: `react`, `react-dom`, `typescript`, `@vitejs/plugin-react`, `zustand`, `@tanstack/react-query`, `@rjsf/core`, `@rjsf/validator-ajv8`, `@rjsf/utils`, `clsx`. Dev: `@types/react`, `@types/react-dom`, `vitest`, `@testing-library/react`, `jsdom`.
- `vite.config.ts` adds `react()`. `tsconfig.json` for `src/` with `strict: true`, `jsx: react-jsx`, `allowJs: true` (main.js is imported as-is).
- `src/app/main.tsx`: creates React root into a new `<div id="react-root">` appended to `index.html` body; renders `<AppShell/>` that initially renders **nothing visible** except island portals. `index.html` script becomes `/src/app/main.tsx`, which `import "../main.js"` so legacy boots unchanged.
- Vitest for component tests; Playwright e2e continues.

## Step 2: Viewer module (the one thing both worlds share)

Extract from `main.js` into `src/viewer/`:

```
viewer/
  Viewer.ts          # class Viewer { constructor(container: HTMLElement); renderer, renderWindow, interactor; resize(); render(); dispose() }  <- L657-746
  layers.ts          # LayerId union ("cad","cad_edges","mesh_surface","surface_field","cut_plane:<id>","streamlines","iso","iso_volume","inspect_marker","bc_glyphs"); addLayer(id, polyData, style); setVisible; remove; setColorBy(field, lut)
  lut.ts             # createRainbowLut, setRange, presets  <- L1241-1258, 3185-4709 (scale edit logic stays UI, LUT ops here)
  pick.ts            # cell pick, hardware-select faces (vtkHardwareSelector L12404), point probe (vtkCellPicker L1108)
  camera.ts          # fit, preset views, relative camera capture/apply (L6328-6363), display scale mm<->m (L6899-6934)
  planes.ts          # client-side vtkCutter planes (L2151, 7175) as layers
  capture.ts         # screenshot(frame), startRecording/stopRecording (L23838-24637)
  loaders.ts         # fetchVtp(url) -> vtkPolyData with cache keyed by URL+stamp (from fieldFrameCache/ptFrameCache)
  index.ts           # createViewer(container): ViewerApi (public, typed) ; also window.__cfdViewer for legacy
```

Migration technique: move code verbatim into TS modules, export functions, and replace the bodies in `main.js` with calls into `window.__cfdViewer` (set by `src/app/main.tsx` before importing `main.js`). Do it per section (bootstrap, LUT, pick, camera, planes, capture). After each move, run Playwright smoke + a manual visual check of CAD, mesh, results, cut plane, particle trace, screenshot.

Compare mode (`#viewer-b`) becomes a second `Viewer` instance from the same class.

## Step 3: Store and API client

- `src/api/client.ts`: `api.get/post` with typed routes generated from Phase 3 route table (`npm run gen:api` -> `src/api/routes.gen.ts` from `GET /api/_routes` — add that debug endpoint in Phase 3). Registry types generated from `GET /api/registry` (`src/api/registry.gen.ts`, `json-schema-to-typescript`).
- `src/store/project.ts` (Zustand): `project`, `activeSimId`, `activeGeometryId`, setters that call API and update; selectors `useSimulation()`, `useMesh()`, `useBcs()`.
- `src/store/ui.ts`: `openPanel: PanelKey | null`, `selection` (face ids, tree item), `filtersMode: "mesh"|"results"`, modals.
- `src/store/jobs.ts`: subscribes to `/api/jobs/:id/events` (EventSource); mirrors into `jobState`-compatible object for legacy via `window.__cfdJobs`.
- React Query for server data (`/api/registry` cached forever, `/api/project` invalidated on mutation).

## Step 4: SchemaForm

`src/forms/SchemaForm.tsx`: wraps `@rjsf/core` with a custom theme:

- Field widgets: number with unit select (`x-cfddesk.quantity` -> `UNITS[quantity]` from prefs; convert to SI on save via `to_si` equivalent in `src/units/convert.ts` ported from `cfddesk/units/convert.py` with a unit test that both tables agree — export the table from `/api/registry` to avoid drift), vector3, choice (select or segmented), bool (toggle), text, raw_dict (code area), face picker (custom `x-cfddesk.widget: "faces"` binding to viewer pick), body picker, patch picker.
- Layout: `group` -> collapsible sections; `advanced` -> "Advanced settings" disclosure (matches existing mesh form); `depends_on` -> conditional render.
- Persistence: `onChange` debounced 300 ms -> `onCommit(values)`; the panel decides whether commit hits the API (rule: field change saves).
- No submit/checkmark button. Footer slot renders **Done** (and **Delete** when `onDelete` given) with the existing `.tree-panel-done` classes so CSS is unchanged.

## Step 5: Island bridge

`src/islands.tsx`:

```ts
export function registerIsland(panelId: string, Component: React.FC<IslandProps>): void
export function mountIsland(panelId: string, props): void   // renders via portal into document.getElementById(panelId), replacing its static children
export function unmountIsland(panelId: string): void
```

- Legacy `openTreeDetail(key)` (main.js L12962) checks `islands.has(TREE_DETAIL_IDS[key])`; if so it shows the container div and calls `mountIsland` with `{ projectId, simId, itemId }` taken from `treeUi`/`w17State`, and skips its own DOM population.
- `dismissTreeDetail` (L12893) calls `unmountIsland`.
- Done/Delete from the island dispatch `window.dispatchEvent(new CustomEvent("cfd:panel-done"))` which legacy listens to alongside its `.tree-panel-done` handler until the tree is converted.
- After the tree is React (Step 8), `openTreeDetail` is gone and `ui.openPanel` drives rendering directly.

## Step 6: Panel wave 1 (registry-driven forms)

Order chosen so the registry work becomes visible first:

| Panel id | Component | Data / schema | Legacy removed |
|---|---|---|---|
| `panel-sim-hub`, create-sim modal | `SimulationHub`, `CreateSimulationDialog` | `GET /api/registry/analysis` -> list by category; create -> `sim.create {analysis_type}` | W17 block 13896-15001 |
| `panel-incompressible-defaults` -> generic `panel-sim-defaults` | `SimulationDefaults` | `analysis.settings_schema` + `numerics_schema` | same |
| `panel-mesh-hub`, `panel-mesh-form`, `panel-mesh-inspect` | `MeshHub`, `MeshForm`, `MeshInspect` | `GET /api/registry/mesher/:key.settings_schema`; engine select from mesher list; Generate -> `POST /api/jobs {kind:"mesh"}`; progress via SSE | W20 19329-20249, generate 20810-21444, job chip mapping 11757-11774 |
| `panel-bcs-hub`, `panel-bc-picker`, `panel-bc-editor`, `panel-bc-defaults`, BC type modal | `BcHub`, `BcPicker`, `BcEditor`, `BcDefaults` | `GET /api/registry/bc` (menu tree from `bc_menu`), `settings_schema` per key, faces widget | W19 18553-19328 |
| `panel-materials-hub`, `panel-material-picker`, `panel-air-material`, material library modal | `MaterialsHub`, `MaterialPicker`, `MaterialEditor` | `GET /api/registry/material` + library presets; body picker | W18 15002-18934 |

Each conversion: build component + vitest test with a fixture schema; wire island; delete the legacy section; run Playwright; commit.

## Step 7: Panel wave 2

| Panel id | Component | Notes |
|---|---|---|
| `panel-refs-hub`, `panel-ref-picker`, `panel-ref-editor` | `RefinementsHub/Picker/Editor` | `mesher.refinement_types`; schemas from `mesh_refinements.py` exported via registry |
| `panel-results-hub`, `panel-area-average` | `MonitorsHub`, `MonitorEditor` | `GET /api/registry/monitor`; patch/face target widget |
| `panel-sim-control` | `RunControl` | analysis `control_schema`; start/stop via jobs; residual sparkline from SSE `residual` events; transient preview via `POST /api/run/transient-preview` alias -> worker `sim_control.preview` |
| `panel-run-results`, `panel-run-graphs`, `panel-run-media`, `panel-run-mesh` | `RunResults`, `RunGraphs` (SVG charts ported from 24819-25150), `RunMedia`, `RunMesh` | monitors via `runs.monitors` RPC |
| `panel-geometry`, geom units/role modals, import flow | `GeometryPanel`, `ImportGeometryDialog` | `cad.import` job with progress; bodies with roles (Phase 2) |
| `#job-debug-drawer` | `JobDrawer` | reads `store/jobs` |

## Step 8: Tree, toolbar, filters, results chrome

- `LeftTree` replaces `syncSimulationTree` (L14129) and `#geometries-list`: pure render of `project` store; click -> `ui.openPanel`. Second click closes (matches `closeIfTreeItemOpen`).
- `TopToolbar` (`#toolbar` FILTERS/VIEW/CAPTURE) -> React; capture uses `viewer/capture.ts`.
- `ViewportChip` (`#viewport-job-chip`) from `store/jobs` (replaces `syncViewportJobChip` 11873 + ETA 11675).
- `FiltersPanel` (`#filters-panel`): Parts/Cut plane/Particle trace/Iso/Animation editors rendered from `GET /api/registry/filter/:key.params_schema` with `SchemaForm`; filter stack persisted via `runs.update {current_view}` as today (L9366). Legend (`#legend`) with editable range -> `Legend.tsx` using `viewer/lut.ts`.
- `IterationsScrubber` (`#iterations-panel`) + animation (10405-11002, 11003-11319) -> `Timeline.tsx`; times from `GET /api/times`.
- Compare mode (8100-8855) -> `CompareLayout` with two `<ViewerCanvas/>`.
- Saved views (9386-10404) -> `SavedViews.tsx`.
- Inspect point (11320-11615) -> `InspectPoint.tsx` using `viewer/pick.ts`.

## Step 9: Home and wizard

- `src/app/routes.tsx` hash router: `#/`, `#/recent`, `#/folder/:id`, `#/project/:id` (same formats as `dashboard.parseHomeRoute`).
- `Home` (grid, search, folders, detail pane, delete) and `SetupWizard` (units, hardware check, port) as React; API unchanged.

## Step 10: Delete legacy and publish plugin UI API

- Remove `src/main.js`, `src/dashboard.js`, `src/setup-wizard.js`; remove `window.__cfd*` bridges; `index.html` shrinks to `<div id="react-root">` + styles.
- `tsconfig` `strict: true`, `allowJs: false`; ESLint `--max-warnings 0`.
- `src/plugin-api/index.ts` exported as workspace package `@cfddesk/plugin-ui` (Phase 5 consumes): `registerPanel({key, title, place: "tree"|"toolbar"|"filters", Component})`, `registerFilterWidget(key, Component)`, `registerFieldWidget(xWidget, Component)`, hooks `useProject`, `useSimulation`, `useJob(id)`, `useRegistry(kind)`, `useViewer(): ViewerApi`, `usePrefs()`, and `SchemaForm`.
- CSS: keep `style.css` (4167 lines) as-is during migration; split per component only when touched; no visual redesign in this phase.

## Tests

- Vitest: `SchemaForm` renders every `SchemaField.kind`; unit select converts to SI; `depends_on` hides; `MeshForm` posts on change (msw mock); `LeftTree` opens panel.
- Playwright: existing smoke + solve smoke; add: create simulation from registry list, add BC via picker, change mesh engine, screenshot capture saved to media.
- Visual: Playwright `toHaveScreenshot` on CAD view, mesh view, results view with a fixed camera (tolerance 0.5%).

## Acceptance criteria

- `src/main.js` deleted; `npm run typecheck` strict passes; `eslint` zero warnings.
- Every panel is a React component; every settings form is schema-driven (no hand-written inputs except face/body/patch pickers and the viewer).
- Panel chrome identical: Done/Delete only, persist on change.
- All Playwright suites green; visual snapshots unchanged within tolerance.
- `@cfddesk/plugin-ui` type declarations build.
