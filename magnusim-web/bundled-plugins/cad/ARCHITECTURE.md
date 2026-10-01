# Magnusim CAD: architecture and working rules

This is the map for everyone changing the plugin: what runs where, which area
owns which files, the contracts between areas (`src/types/`), and the rules
every change follows. Plans and decisions live in the project's plan folder
(`CAD Plugin/00 - Research and proposal.md`, `01 - Decisions 2026-09-30.md`,
`02 - P0 results and decisions.md`, `p0/CONTRACT.md`); where they disagree,
the decisions win.

## 1. Runtime topology

```
Host page (Magnusim)                      Sandboxed frame: /plugins/cad/workspace/index.html
 WorkspaceOverlay (44 px header:          (opaque origin, host CSP, import map: react,
 Back · "Magnusim CAD › Part 1" ·          react-dom/client, react/jsx-runtime, @magnusim/workspace)
 Queue · Settings)  <== MessagePort ==>    main thread: React UI, three.js viewport, DocService
 /api/plugin-studies, /api/plugin-data,      (model, rebuild, undo, autosave), KernelAdapter
 /api/plugin-files (host API 1.2)
                                             (watchdog), selection, commands, keyboard
                                                 | {type:"call"}         ^ {type:"result"} + buffers
                                                 v                       |
                                           kernel worker  workspace/kernel/kernel-worker.js
                                             -> mk32.mjs + mk32.wasm (OCCT 7.9.3 + facade, C ABI)
                                           picking worker workspace/pick/pick-worker.js (VIEWPORT,
                                             three-mesh-bvh BVH builds for bodies >= 40k triangles)
                                           solver worker  (P3, PlaneGCS)               [later]
```

- Workers start with `ws.spawnWorker(url)` (a classic blob worker that
  `import()`s the module). Import maps do not apply in workers, so every worker
  module is one self-contained ES module (`scripts/build.mjs` `WORKERS`).
- The kernel worker posts `{type:"ready"}` first; the adapter queues calls until
  then (the SDK also holds early messages now; the handshake stays).
- Z is up, as in the core viewer. Lengths are mm and angles degrees everywhere
  inside; the document has display units.

## 2. Folders and ownership

Each area edits **only its own files**. Shared files are frozen or append-only
as marked. If you need a change in a file you do not own, ask its owner (or
INTEGRATE for frozen files) and wait; never edit it yourself.

| Path | Owner | Notes |
|---|---|---|
| `src/app/**`, `src/main.tsx`, `src/index.html`, `src/styles/app.css`, `tests/app/**` | INTEGRATE | Bootstrap, layout frame, command registry, keyboard, `window.__CAD__`. |
| `src/lib/**` | frozen (INTEGRATE) | State store + hook, event bus, bridge wrapper, services context, ids, selection helpers. |
| `src/types/index.ts`, `app.ts`, `commands.ts`, `state.ts`, `selection.ts` | frozen (INTEGRATE) | Cross-area contracts. |
| `src/types/events.ts` | append-only | Add events **only in your own section**; never change another section. |
| `src/ui/**`, `src/styles/tokens.css`, `tests/ui/**` | UI-SHELL | Design-language components, design tree, rollback bar, panels (flyout feature panels, parameters), toolbar, context menu, chips, dialogs. |
| `src/viewport/**`, `src/types/viewport.ts`, `tests/viewport/**` | VIEWPORT | three.js viewport, camera/controls, bodies + edges, origin display, BVH picking in a worker, highlight, fit/standard views, triad/XYZ/Fit chrome. |
| `src/doc/**`, `src/kernel/**`, `src/types/{doc,doc-service,docstore,undo,units,kernel}.ts`, `tests/doc/**`, `tests/kernel/worker-client.test.ts` | DOC-CORE | Schema v1, feature registry + box/cylinder, rebuild engine + cache, parameters + expressions, undo/redo, DocStore (WsFilesStore on host API 1.2, WsDataStore on a 1.1 host), conflicts, unsaved work (`nav.setDirty`); KernelAdapter, watchdog, respawn + rebuild. |
| `kernel-build/**`, `workspace/kernel/mk32.*`, `src/kernel-worker/**`, `src/types/kernel-protocol.ts`, `tests/kernel/kernel-*` (tests, `kernel-lib.ts`, `kernel-oom-worker.mjs`), `fixtures/kernel/**`, `e2e/cad-p1-kernel-*.spec.ts` | KERNEL-HARDENING | Facade, OCCT build, `valid` on every op, deep copies, repair, per-op behaviour, memory. `npm run test:kernel`. |
| `solver-build/**`, `workspace/solver/*`, `src/solver-worker/**`, `tests/solver/**` | P3 (sketcher) | Built and tested now; not wired into the page until P3. |
| `scripts/build.mjs` | frozen, `WORKERS` append-only | Add your worker entry to `WORKERS`; nothing else. |
| `e2e/helpers.ts` | append-only | Add helpers at the end; do not change existing ones. |
| `e2e/playwright.config.ts`, `global-setup.ts`, `host-server.mjs`, `host-vite.config.mjs`, `png.ts`, `manifest-guard.mjs` | frozen (INTEGRATE) | |
| `e2e/cad-p1-<area>-*.spec.ts` | the area in the name | One spec file per area at least; name tests `cad:p1-<area>-<what>`. |
| `e2e/cad-p<n>-<gate>.spec.js` (`cad-p1-document.spec.js`) | INTEGRATE | A phase's exit gate, named as in the proposal §7: one test per exit bullet. |
| `e2e/cad-p1-review-polish.spec.ts`, `cad-p1-review2.spec.ts`, `cad-p1-review3.spec.ts`, `cad-p15-review1.spec.ts` | INTEGRATE | Review rounds' smaller findings (P1 rounds 1-3, P1.5 round 1), one assertion per finding. |
| `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `manifest.toml`, `plugin.py`, `README.md`, `ARCHITECTURE.md`, `LICENSES/**` | frozen (INTEGRATE) | New dependency? Ask INTEGRATE: one `npm install` at a time (shared `node_modules`). |
| `workspace/**` (except `kernel/mk32.*`, `solver/planegcs.*`) | nobody by hand | Written only by `npm run build`. |

## 3. Start-up and the `install()` convention

`src/app/bootstrap.ts`:
1. `connect()` to the host (15 s). Outside the host: an error card, nothing else.
2. Creates the services (`src/types/app.ts` `AppServices`): `bridge`, `bus`,
   `commands`, `keyboard`, `kernel` (`createKernelAdapter`), `doc`
   (`createDocService`), `selection`, `mode`, `viewport` (a store the viewport
   host fills with its `ViewportHandle`).
3. Calls each area's `install(services)` (from `src/doc`, `src/viewport`,
   `src/ui` `index.ts`, in that order). **This is where an area registers its
   commands, key bindings and bus handlers.** It returns an uninstall.
   Registering an id that exists replaces it (the later install wins): DOC-CORE
   registers `edit.undo` / `edit.redo` as keyboard commands, and UI-SHELL
   replaces them with the toolbar versions (icons; with a feature panel open,
   Undo cancels that panel's changes). Both bind Ctrl+Shift+Z to
   `commands.run('edit.redo')`; the keyboard runs only the newest binding of a
   combo, so it runs once.
4. Binds command shortcuts, exposes `window.__CAD__` (tests only), renders
   `<App>` (`src/app/App.tsx`), starts the kernel in the background, then
   `await doc.load()`.

The layout (`App.tsx`) mounts exactly, in order: `Toolbar` (UI-SHELL, top
row), then in `.cad-stage`: `ViewportView` (VIEWPORT; its own chrome such as
the triad, XYZ key and Fit button renders inside it), `LeftStack` (UI-SHELL:
tree card + flyout panel), `StatusDock` (UI-SHELL: bottom-left chips; other
areas publish state, UI-SHELL shows it) and `Overlays` (UI-SHELL: context
menu, dialogs). An area that needs another mount point asks INTEGRATE; until
then, render inside your own mounted component.

Root attributes for tests: `[data-cad-app][data-kernel="starting|ready|restarting|failed"][data-doc="loading|ready|error"][data-viewport="ready|none"]`.

## 4. State and events

- **State lives in stores** (`src/lib/store.ts`: `createStateStore`,
  `useStateStore(store, selector)`). One writer per store:
  `kernel.status` (DOC-CORE), `doc.state` (DOC-CORE), `viewport` handle and
  `ViewportHandle.state` (VIEWPORT), `selection` (the viewport on picks, the
  UI on row clicks, both only through `src/lib/selection.ts`), `mode`
  (INTEGRATE; P3 sketch mode).
- **Events are one-off notifications** (`bus`, `src/types/events.ts`):
  `app:ready`, `app:escape`, `kernel:respawned`, `doc:rebuilt`,
  `viewport:contextmenu`, `viewport:dblclick`, `ui:edit-feature`. Add yours in
  your own section.
- The viewport **reads** bodies from `doc.state.rebuild.bodies` (with
  `tessKey` for change detection) and the selection from `selection`; nobody
  pushes meshes into it. Its binding (`src/viewport/bind.ts`) is the only
  caller of `ViewportHandle.setBodies` in the app (tests and perf runs call it
  directly); it also asks the kernel for vertex positions (`topo` with faces
  and edges `none`) so B-rep vertices are pickable. Picks go into `selection`
  (click replaces, Ctrl+click toggles, empty click clears; a right-click on an
  unselected item selects it before `viewport:contextmenu`).

## 5. Kernel

- Facade C ABI and ops: `p0/CONTRACT.md` and `src/types/kernel-protocol.ts`
  (`KernelOps` maps op -> params/result; the typed file is the one to read).
  Shape ids are integers owned by the worker; face/edge/vertex indices start at
  0 and are stable per shape id. `version` returns `api: 2` for the contract below.
- Worker protocol: `ready` | `fatal` | `result` (worker -> main), `call`
  (main -> worker, `bytes` transferred as `params.ptr/len`). Buffers come back
  as ArrayBuffers in the transfer list.
- `KernelAdapter` (`src/kernel/`): one call in flight, wall-clock watchdog
  (20 s default; `import_step` 300 s, `props`/`topo` 120 s, `tessellate` 60 s:
  `src/kernel/timeouts.ts`). On a watchdog stop, a trap or a crash it
  terminates and respawns the worker; the call rejects with kind `watchdog` /
  `trap` / `crash`, queued calls with `restarted`; `onRespawn` listeners (the
  rebuild engine) rebuild from the document, because every shape id died.
- **Every modelling op reports `valid`** (decision 3): box, cylinder, sphere,
  extrude, revolve, boolean, split (`valid` = every piece; `pieces_valid`),
  fillet, chamfer, defeature, shell, repair. It is BRepCheck on the stored
  result. When false the result also carries `reason` (one line: "invalid
  result (BRepCheck): UnorientableShape x1, ..."), `problems` (status, sub-shape
  type and index in the result's own index space, for highlighting) and
  `problem_counts`. An invalid result is still stored and returned (ok:true,
  valid:false) so the document can show a red feature and offer "Try repair";
  OCCT refusing outright is ok:false ("fillet failed ...; the body is
  unchanged"). `{check:false}` skips the analysis (then `checked:false`, and the
  adapter calls `check`).
- **`repair {id, tol?, unify?}`**: ShapeFix_Shape then UnifySameDomain on a
  copy, with history against the input; a new body with its own `valid`,
  `fixed`, face/edge counts before and after. A valid repair is not
  necessarily a right one: compare volume/faces before accepting it. Measured
  on the P0 known defect (Vortex fused with a 200 mm box on its top centre):
  the fuse is reported invalid (NotClosed + UnorientableShape on one face, and
  about 57,000 mm³ too little volume); repair makes it valid at the native
  ShapeFix volume, within 0.02 standard errors of an independent Monte Carlo
  estimate. A fuzzy value (1e-5 to 1e-2 mm) does not fix it.
- **Mutating ops run on deep copies** (BRepBuilderAPI_Copy under temporary ids;
  several inputs are copied together so shared sub-shapes stay shared): the
  input shape id is never changed, whatever happens. This covers boolean,
  split, fillet, chamfer, defeature, shell and repair. The P0 regression is a
  test (`tests/kernel/kernel-copies.test.ts`, and in the frame
  `e2e/cad-p1-kernel-ops.spec.ts`); a test build without copies fails it.
  `tessellate` stores the mesh on the shape (no geometry change).
- **Booleans**: `fuzzy` (mm, extra tolerance for nearly coincident geometry),
  `glue` ('off' default, 'shift', 'full': OCCT's gluing for bodies that only
  touch; on bodies that really overlap it returns a valid but wrong,
  un-subtracted result, so it must stay an explicit choice), `unify` (default
  true, with history), several targets and tools, `warning_text`.
- **Cheap by default** (decision 6): `props` returns counts and a fast
  bounding box (tolerance-padded, always enclosing) unless `volume: true`,
  `area: true` or `bbox: 'exact'` is asked for. `topo` computes signatures only
  for the faces/edges/vertices asked for (`[i...]`, `{start, count}`, 'none'),
  can skip the exact face bbox (`face_bbox: 'fast'`), face area/centroid and
  edge length, and returns `counts`; `src/kernel-worker/topo-chunks.ts`
  (`topoInChunks`) walks a large part in chunks with progress and abort.
  Measured on the 113 MB part (11,776 faces, Node, wasm32): import 34 s;
  props default 0.1 s (volume on request 12 s); topo one face 9 ms, a chunk
  of 500 faces 2.7 s exact / 0.55 s fast bbox, 1,000 edges 40 ms, the whole
  part chunked with fast bbox 15 s in 61 calls (longest 0.8 s; the old single
  call took 57 s); check 6.3 s; tessellate 4.7 s (edge flags 0.2 s);
  box-minus-part cut 22.4 s (copy 0.4, boolean 12.4, unify 1.0, check 8.3),
  valid, volume within 6e-10. Heap after all of it 1.9 GB.
  **A boolean on that part takes longer than the 20 s default watchdog**:
  big parts need a longer per-op timeout (DOC-CORE's `timeouts.ts`), or the op
  with `check:false` followed by a separate `check`.
- **Extrude**: `flip` reverses the direction (so does d < 0 for blind); taper
  keeps its sense when flipped. Kernel-only extents (not in the UI yet):
  `through_all {targets, both?}` and `to_face {target, face, offset?}` (planar
  faces, tilted or parallel; the end cap lies on the face's plane). Results say
  the span used: `from`, `to`, `direction`.
- **Edge flags**: `tessellate` returns `edge_flags` (u8 per edge index,
  `EDGE_FLAG` in kernel-protocol.ts): seam 1, degenerated 2, internal 4,
  same_domain 8, smooth 16, free 32. The viewport skips `EDGE_HIDDEN` (seam,
  degenerated, internal, same_domain) and may draw smooth (tangent) edges
  lighter. `hidden_edges` counts them.
- Memory: wasm memory never shrinks; recycle the worker above 1.2 GB at the
  next idle moment (once; no loop), rebuild from the cache. An out-of-memory
  op is ok:false with `oom: true` (and `low_memory` when the heap is nearly
  full); the kernel keeps working once memory is freed (gate 9 test).
- Only wasm32 ships. `kernel-build/build.sh` builds OCCT (when the libraries
  for the current pins are missing), then the facade, into `workspace/kernel/`,
  and writes the build record `kernel-build/mk32.build.txt`; the build is
  byte-for-byte reproducible (`kernel-build/SOURCES.md`).
- Tests: `npm run test:kernel` (P0 gates 2-5, 7, 9 and the checks above, against
  `fixtures/kernel/reference.json`); the 113 MB part is opt-in with
  `CAD_KERNEL_BIG_STEP=<path>`.

## 6. Document

- **Schema v1** (`src/types/doc.ts`): `CadDoc` = units, params, bodies (id ->
  name/colour), features (P1: `box`, `cylinder`; origin is implicit:
  `OriginRef`, `ORIGIN_PLANES`). Body-making features carry
  `op: new|join|cut|intersect`, `creates` (a body id fixed when the feature is
  made) and `scope`. Every numeric field is an expression string.
- **View state** (`CadView`: rollback index, hidden bodies, expanded tree
  nodes, the origin planes' mode and the camera) is saved but not undoable.
  The viewport's binding puts the planes mode back when the Part is read and
  the camera after its first rebuild (over the framing of the first bodies);
  user changes go back with `doc.setPlanes` / `doc.setCamera` (a camera move
  is reported once it has rested 400 ms).
- **Storage is outside the study record** (decision 1). The study record keeps
  only its host fields plus a tiny pointer under `doc` (`StudyPointer`,
  `src/types/docstore.ts`: `{rel, schema: 1, store: "files" | "data", view}`);
  the model lives in `studies/<sid>/model.json` and the view in
  `studies/<sid>/view.json` beside `study.json`, so deleting the study deletes
  them. `ws.data` and `ws.files` are two views of the same folder (the plugin's
  folder of the project), so `model.json` is the same file to both.
  - `WsFilesStore` (host API 1.2, `hostVersion` compared as numbers; a host that
    answers `not_allowed` falls back): the model is written with
    `ws.files.write(rel, json, {ifMatch})`, `ifMatch` = the etag of the last
    read or write (`null` creates only), and read with `stat` then
    `read({ifMatch: etag})` (one version). Another tab's save makes the host
    answer `changed` (409): `DocConflictError`, the "Changed in another tab ·
    Reload" chip. Any other refusal is a `DocSaveError` with a plain reason
    (`plainSaveReason`: too_large, quota, disk_full, plugin_off, busy,
    invalid_path, ...): the chip says "Not saved: <why>" with Retry. The view
    is a small last-write-wins file written with `ws.data` (one message on the
    host's plugin lane; it never makes the page dirty).
  - **Moving a P1 Part** (`src/doc/store/open.ts`): a pointer that says "data"
    on a 1.2 host is moved once, when the Part is opened. The P1 `model.json`
    (it carries `WsDataStore`'s own version token) is kept byte for byte as
    `studies/<sid>/model.p1.json` (create-only), then written again through
    `ws.files` on the etag it was read at, then the pointer says "files".
    Nothing is deleted. A failed move keeps `ws.data` for that session and is
    tried again next time.
  - **Reading a stored model** (`readDoc`, `src/doc/schema.ts`) never leaves
    part of it out without a word: a parameter or feature with no id is given
    one (expressions use names), and anything it cannot read (a parameter with
    no name, expression or quantity, a feature with no name or type) is a
    `DocReadError` naming it. The Part then shows "Could not read the part:
    <why>" with Try again, and nothing is written over the file: the P1 move
    reads before it copies or rewrites anything.
  - `WsDataStore` (only a 1.1 host): `ws.data` JSON files. No host conditional
    write: it stores a version token (counter + session) inside the file and
    re-reads it before each write; a mismatch is a `DocConflictError`. An
    etag this tab's session wrote is never a conflict.
  - **Unsaved work (G7, `nav.setDirty`)**: from the first change that is not
    stored until it is (waiting on the budget, being written, refused, or
    refused because another tab saved first) the service tells the host the
    page is dirty, with "Changes to <Part> are not saved yet." (or "...: <why>.",
    "...: it was changed in another tab."). Every way out of the workspace then
    asks "Leave without saving?" (the header's Back, Home, the browser's Back
    and Forward, the mouse's side buttons, a typed link) and F5 or closing the
    tab gets the browser's own prompt. The page never reloads itself.
  - **Autosave** (`src/doc/autosave.ts`): a model change is written at once;
    one write runs at a time and changes made meanwhile follow right after it,
    together. A budget spaces model writes: `SAVE_BURST` (6) back to back, then
    one per `SAVE_INTERVAL_MS` (1.5 s) (P0 gate 10 asked for it when every
    write ran on the core lane; re-measured in P1.5 with `ws.files`). View-only
    changes never spend it: the first is written at once, then at most one per
    `VIEW_INTERVAL_MS` (2 s); a model write that is due takes a waiting view
    along. Leaving: `flushNow()` (outside the budget) when the pointer leaves
    the frame, the frame loses focus or a panel's Done is pressed; `leaveNow()`
    on F5, Ctrl+R / Ctrl+W, the side buttons, the page hidden: with `ws.files`
    it is the same conditional write (the host asks before the page goes while
    it runs); on a 1.1 host it posts the model in one message
    (`WsDataStore.saveModelNow`, only while this tab confirmed the stored
    version less than 10 s ago). Undo back to the stored model drops a waiting
    write and says Saved. A reopened Part says Saved with the stored `saved_at`.
- **Conflicts**: a save refused because another tab wrote -> save state
  `conflict`, edits paused, chip "Changed in another tab · Reload". A rename in
  the host header arrives as `bridge.onStudy` with a new rev: adopt it silently
  (the pointer field is untouched).
- **Undo** (`src/types/undo.ts`): model snapshots only; one action, one drag or
  one panel session = one step; 100 steps; rollback, visibility, camera and
  selection are not undoable.
- **Rebuild**: each feature is a pure function of the bodies before it, its
  resolved parameters and references; cache by canonical feature JSON + inputs;
  rebuild from the first changed feature up to the rollback bar. A failed
  feature is a no-op marked red, and later features still try (Onshape
  semantics).
- **Panel sessions** (`EditSession`): live apply of every valid field change,
  Done = `commit()`, Delete on a new feature = `discard()`, whole session = one
  undo step (none when the session ends where it began); a new feature with
  incomplete inputs is not saved and Done says why.

## 7. UI rules (Daniel's, non-negotiable)

- **Honest UI.** Only commands that work end to end are registered; nothing
  greyed "for later", no "coming soon", no TODO in copy. A disabled control
  says why (`CommandDef.enabled` returns the reason). Empty states read
  "No X yet". Errors read "<Action> failed: <why>".
- **Panel chrome**: flyouts close with **Done** in the foot; **Delete** only
  when something can be removed (on a new feature it discards it); **no tick or
  checkmark** in any header; valid field changes apply live.
- `ws.ui.confirm` (the host's, always a red button) only for destructive
  actions; other choices use an in-frame `<dialog>`. Toasts through
  `bridge.toast`.
- Design language: `research/design-language.md`. Colours only through
  `var(--mg-*)` / `var(--cad-*)` (`src/styles/tokens.css`); class names follow
  the core recipes (`tree-row`, `geo-head`, `tb-btn`, ...). Tree rows take
  their text from `.tree-section` as the core's do (11 px / 600 / `#4a5160`;
  the card itself is 12 px), 24 px rows (28 px with a twisty), selected row
  `#d7e8ff`, panels 12 px, Done and Delete in the browser's own button font as
  in the core; outline icons (24 viewBox, stroke 1.7–1.8, `currentColor`).
  `e2e/cad-p1-document.spec.js` reads these from the core page and compares.
- Viewport: background `#f0f2f7`, body `#bdc9db` (Phong: ambient .16, diffuse
  .78, specular .22, power 28), edges `#0a0b0e` 2.4 px, pick `#2ec47e`, set
  `#4884eb`, hover `#b2ccff`. Mouse: left drag orbit, middle or Shift+left pan,
  wheel or right drag zoom, right click (<= 16 px) context menu, click <= 5 px;
  Ctrl+click toggles selection; empty click clears.
  - Sources (core `src/workbench/runtime.js` at cff8aaa): background 1031;
    manipulators 1051-1066 (vtk trackball rotate: 360 deg per viewport width
    about the view-up through the pivot; pan keeps the pivot-depth point under
    the pointer; wheel notch x1.1 via vtk.js `normalizeWheel`); orbit pivot =
    model centroid 9214-9310; default direction [-0.55, -0.75, 0.42] 9118;
    triad 1113-1133 (72 px, X/Y/Z [220,40,40] / [36,168,64] / [40,96,220]);
    body 17528-17538; edges 17544-17568; pick / set paint 17813-17826;
    selected body 17709; picked edge tube 17585 + 3.2 px 22804; picked vertex
    17597 + 11 px 22801; core pick radii 7 / 10 px 22802-22803 (the Part
    viewport uses 8 px for both, proposal §4.7). Shading: vtk.js headlight
    (`Rendering/OpenGL/PolyDataMapper.js:190`), reproduced in
    `src/viewport/materials.ts`; `src/viewport/colors.ts` carries every value
    with its line. A 20 mm cube in the core viewer measured the same face
    pixels as the formula within 1/255.
  - Additions (no core precedent): zoom to the cursor (wheel and right drag),
    a 320 ms view transition, hover pre-highlight, origin planes drawn on an
    empty part and while selected or hovered (views menu: Auto / Always),
    selection filter, section view with a capped cut (its slider spans the
    kernel's exact box), standard views on keys 1-7, Fit on F (keeps the
    direction, with a 1.2x margin; its toolbar glyph is a frame, not the house:
    the house button is the core's reset to the default direction), Normal to
    on N (a toast says why when nothing fits), a refit when the part's size
    changes tenfold in one rebuild, and the core's context-menu items first
    (Normal to, Orbit around this face / edge / point, model center, origin;
    Hide face and Show all faces are not offered: CAD does not hide faces).
- Keyboard: the host gives the page the keyboard when it connects and again
  after its own dialogs and Settings close (host API 1.2), so keys work with no
  click in the part. A click on the host's header takes the keyboard away; the
  dock then shows "Click here to use keyboard shortcuts" (proposal §3.4 hint)
  until the frame has focus again. Escape with nothing open lets go of the
  selection; F2 and Delete on a face, edge, point, body or plane say what they
  do in a toast instead of doing nothing.
- Readouts: volumes group digits from 10,000 up (a metric part of a cubic
  metre or more reads in m³); with nothing selected the chip totals the shown
  bodies and says so ("Total of 3 bodies", "Total of 1 shown body"); a hidden
  body leaves the selection. Tree labels end in an ellipsis inside the card,
  with the full name as the tooltip.
- Number fields (`NumberUnitInput`) read like the readouts when not focused
  ("1,000,000", "12.3457"); with focus they show every stored digit, all
  selected when the text changed ("12.3456789"), so an edit never drops digits.
  Commas are refused with a reason, as the core's `SciNumberInput` refuses them
  ("1,500" is never guessed); a comma between a function's arguments is fine.
  A stored expression that does not evaluate (an unknown parameter) keeps the
  unit after the field, so it stays in line with the others; the reason shows
  once, under the field: the feature panel's foot leaves out what a field
  already says, and says "Not applied: ..." only for a change typed in the
  panel that could not apply.
- The Operation row (New body / Join / Cut / Intersect) shows only when a body
  exists before the feature in history (`FeatureStatus.bodiesBefore` from the
  rebuild), or when the stored op is not New body (so it can be set back).
  Join also takes a body the tool only touches (a shared face): the fuse of the
  two is one solid. With nothing to act on, the words say what was missing,
  per Operation (`nothingToActOn` in `doc/features/body-op.ts`): "Nothing to
  join: Box 2 shares no face with a body made before it" (an edge or a corner
  in common is not enough), and "Nothing to cut: Box 2 does not overlap any
  body made before it (touching is not enough)", the same for Intersect.

## 8. Tests

- Unit (`npm test`): jsdom by default; `// @vitest-environment node` for the
  real wasm. `@magnusim/workspace` is aliased to `tests/fakes/workspace-sdk.ts`
  (`createFakeWorkspace`, `setFakeConnection`); `tests/fakes/fake-worker.ts`
  scripts a kernel worker. three's `WebGLRenderer` needs WebGL, which jsdom
  lacks: mock `src/viewport/viewport` in DOM tests that mount the app.
- e2e (`npm run test:e2e [spec]`): builds, then runs Playwright against the
  host (`e2e/host-server.mjs`). Drive the frame with
  `page.frameLocator('#workspace-frame')`; assert what the user sees (visible
  text, computed styles, pixel colours via `e2e/png.ts`, download bytes).
  `window.__CAD__.snapshot()` is for state checks only. Every bug gets its own
  e2e test.
- Phase exit gates: `e2e/cad-p1-document.spec.js` is P1's (proposal §7, one
  test per bullet), against host API 1.2: CAD is Off on a fresh install
  (`resetCadToDefault()` forgets the choice in the server's prefs) and turned
  on in Settings; every other spec turns it on through the same endpoint
  (`newProject()` calls `ensureCadOn()`). Review round 1 added its blockers
  there (save chip, leaving with a save on its way, keys, long names); round 2
  the side Back button, the twisty clicks and the Settings description; round 3
  the Operation row, the P1 move and the reload read with `ws.files`. Leaving
  while a save is on its way is made deterministic by holding the write's
  commit (`holdCommits()` in `e2e/helpers.ts`): the page is dirty for as long
  as the test needs, and the host's question is asserted word for word.
  `e2e/cad-p1-leave-f5.spec.js` is F5 with a save on its way (the browser's
  prompt; it launches Chromium with `--site-per-process`, which needs a file of
  its own), and a tab behind another one leaving by F5, the pointer or Back then
  Leave without replacing the other tab's save (its write held at its begin).
  The smaller findings are in `cad-p1-review-polish.spec.ts`,
  `cad-p1-review2.spec.ts`, `cad-p1-review3.spec.ts` and P1.5's
  `cad-p15-review1.spec.ts`. No test is marked PENDING-HOST any more, and none
  depends on when an automatic save retry comes (a refusal is kept up until the
  moment the test clicks Retry).
  The broken-manifest test breaks `manifest.toml` in place for that one test;
  `e2e/manifest-guard.mjs` keeps the real file in `.cache/` and every run's
  global setup puts it back if a run stopped mid-test.
- Real Chrome/Edge (`CAD_E2E_CHANNELS=chrome,msedge`) for anything about load
  time or process isolation: bundled Chromium caches sandboxed frames and does
  not isolate their process.
- Verify for real: a panel mounting or an API answering is not a pass; only
  the end-to-end behaviour is.

## 9. Host facts and gaps

- CSP: scripts/styles/fonts from `/plugin-sdk/` and `/plugins/cad/workspace/`
  only; `connect-src` own folder; `worker-src blob:`; `'wasm-unsafe-eval'`; no
  inline scripts (the build emits none).
- `ws.data` files up to 8 MB; `plugin_data.*` and `plugin_studies.*` run on the
  host's plugin worker lane (not the project tree's). `ws.files` streams in
  Node in 16 MB chunks; the manifest's `[files]` caps CAD at 512 MB a file and
  4096 MB a project.
- `ws.spawnWorker` holds messages posted before the module listens.
- Real Chrome/Edge request `/favicon.ico` on the host origin (404; not ours).
- A refused `ws.files` write (409 "changed", 507 "disk_full") is also logged by
  the browser as a failed resource load in the host page's console; the specs
  that cause one allow exactly that line.
- In the host since 42e38c6 (API 1.2): **G1** `ws.files` with etags,
  **G7** focus on connect and `nav.setDirty`, **G11** `default_enabled = false`
  (CAD ships off), **G12** the boundary checker skips `node_modules` and dot
  folders.
- CAD ships off, so the registry goldens (`npm run gen:registry:check`),
  `python/tests/unit/test_registry_dump.py` and the core h5 / h11 / h13 / g11
  specs pass unchanged with it in `bundled-plugins/` (checked in P1.5). The
  plugin's first commit still adds CI jobs (`cad-plugin`, `core-without-cad`),
  the root `ROADMAP.md` entries (the "come back to later" list) and
  `THIRD_PARTY_NOTICES.md`.
