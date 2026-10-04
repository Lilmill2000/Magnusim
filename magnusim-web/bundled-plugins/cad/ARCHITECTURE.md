# Magnusim CAD: architecture and working rules

This is the map for everyone changing the plugin: what runs where, which area
owns which files, the contracts between areas (`src/types/`), and the rules
every change follows. Plans and decisions live in the project's plan folder
(`CAD Plugin/00 - Research and proposal.md`, `01 - Decisions 2026-09-30.md`,
`02 - P0 results and decisions.md`, `p0/CONTRACT.md`); where they disagree,
the decisions win. The P2 (STEP editing) and P3 (sketcher) build follows
`docs/p2p3-plan.md`: its schema, kernel API 3, extension points (§10 here) and
ownership map (§2 here) are binding for the builders.

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
                                           solver worker  workspace/solver/solver-worker.js (P3,
                                             PlaneGCS: drags, DOF analysis, the rebuild's re-solves;
                                             started lazily on the first sketch edit or re-solve)
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
| `src/lib/**` | frozen (INTEGRATE) | State store + hook, event bus, bridge wrapper, services context, ids, selection helpers, in-frame modals (`modal.ts`), what floats over the view and where HTML in the view can go clear of it (`chrome.ts`). |
| `src/types/index.ts`, `app.ts`, `commands.ts`, `state.ts`, `selection.ts` | frozen (INTEGRATE) | Cross-area contracts. |
| `src/types/events.ts` | append-only | Add events **only in your own section**; never change another section. |
| `src/ui/**`, `src/styles/tokens.css`, `tests/ui/**` | UI-SHELL | Design-language components, design tree, rollback bar, panels (flyout feature panels, parameters), toolbar, context menu, chips, dialogs. |
| `src/viewport/**`, `src/types/viewport.ts`, `tests/viewport/**` | VIEWPORT | three.js viewport, camera/controls, bodies + edges, origin display, BVH picking in a worker, highlight, fit/standard views, triad/XYZ/Fit chrome. |
| `src/doc/**`, `src/kernel/**`, `src/types/{doc,doc-service,docstore,undo,units,kernel}.ts`, `tests/doc/**`, `tests/kernel/worker-client.test.ts` | DOC-CORE | Schema v1, feature registry (built-in types: none since the SD pass; removed types read as "Removed feature", `doc/features/removed.ts`), rebuild engine + cache, parameters + expressions, undo/redo, DocStore (WsFilesStore on host API 1.2, WsDataStore on a 1.1 host), conflicts, unsaved work (`nav.setDirty`); KernelAdapter, watchdog, respawn + rebuild. |
| `kernel-build/**`, `workspace/kernel/mk32.*`, `src/kernel-worker/**`, `src/types/kernel-protocol.ts`, `tests/kernel/kernel-*` (tests, `kernel-lib.ts`, `kernel-oom-worker.mjs`), `fixtures/kernel/**` (P2/P3 added `box20-faces.step`, `box20-gap.step`, `box10-sheet.step`, generated natively; README rows there), `e2e/cad-p1-kernel-*.spec.ts`, `e2e/cad-p2-kernel-*.spec.ts` | KERNEL-HARDENING | Facade, OCCT build, `valid` on every op, deep copies, repair, per-op behaviour, memory. `npm run test:kernel`. |
| `solver-build/**`, `workspace/solver/*`, `src/solver-worker/**`, `tests/solver/**` | P3 (sketcher) | Built and tested now; not wired into the page until P3. |
| `src/modules.ts`, `src/naming/**`, `src/doc/features/{hooks,body-ids}.ts`, `tests/arch/**`, `docs/p2p3-plan.md` | INTEGRATE (P2/P3 architect) | Module discovery, the naming layer, the feature-type hooks; frozen during the P2/P3 build (requests to INTEGRATE). Builders append only to the plan's §8 contract-change table. |
| `src/features/{import,delete_faces,press_pull,split,combine,measure,mass,check,export}/**`, `src/files/**` + their tests, `e2e/cad-p2-features-*.spec.ts` | P2-FEATURES | One module per folder (`index.ts` default export, plan §3.1). |
| `src/features/p2/**` | P2-FEATURES | P2's shared building blocks (selection list, viewport picker, stored-face refs, Try repair helpers, in-frame dialog, icons, `p2.css`). No `index.ts`, so module discovery skips it. Its colours are `--cad-p2-*` in `src/styles/tokens.css`. |
| `src/sketch/**`, the solver worker's `WORKERS` line in `scripts/build.mjs` + their tests | P3-SKETCH | Sketch mode, tools, dimensions and constraints UI, solver client. |
| `src/features/{sketch,extrude}/**`, `src/ui/tree/**` + their tests | P3-PROFILES | The sketch feature (regions), extrude, sketch rows in the tree. |
| `src/features/enclosure/**`, `tests/features/enclosure/**`, `tests/doc/blocks.ts`, `e2e/cad-sd-enclosure.spec.ts`, `e2e/cad-sd-review1.spec.ts` | SD pass (sketch-driven) | The Enclosure (CFD PREP); sketched blocks and cylinders for tests (`tests/doc/blocks.ts`, `e2e/helpers.ts` `addSketch` / `addSolid` / `drawRectangle` / `drawBlock`). |
| `scripts/build.mjs` | frozen, `WORKERS` append-only | Add your worker entry to `WORKERS`; nothing else. |
| `e2e/helpers.ts` | append-only | Add helpers at the end; do not change existing ones. |
| `e2e/playwright.config.ts`, `global-setup.ts`, `host-server.mjs` (the app's `startHost()`, `magnusim-web/e2e/support/host-server.mjs`), `png.ts`, `manifest-guard.mjs` | frozen (INTEGRATE) | |
| `e2e/cad-p1-<area>-*.spec.ts` | the area in the name | One spec file per area at least; name tests `cad:p1-<area>-<what>`. |
| `e2e/cad-p<n>-<gate>.spec.js` (`cad-p1-document.spec.js`, `cad-p2-step.spec.js`, `cad-p3-sketch.spec.js`), `e2e/cad-large-step.spec.js` | INTEGRATE | A phase's exit gate, named as in the proposal §7: one test per exit bullet. The large-STEP spec is opt-in (`CAD_E2E_BIG_STEP`). |
| `e2e/cad-p1-review-polish.spec.ts`, `cad-p1-review2.spec.ts`, `cad-p1-review3.spec.ts`, `cad-p15-review1.spec.ts`, `cad-p2p3-review1.spec.ts`, `cad-p2p3-review1-polish.spec.ts`, `cad-p2p3-review2.spec.ts`, `cad-p2p3-review3.spec.ts`, `cad-p2p3-review4.spec.ts`, `tests/arch/user-files.test.ts` | INTEGRATE | Review rounds' findings (P1 rounds 1-3, P1.5 round 1, P2+P3 rounds 1-4), one test per finding. |
| `e2e/cad-sd-kit.spec.ts` | UI-SHELL | The host UI kit in CAD's panels (§7 "UI kit"): each adopted control against the kit's own component, property by property. |
| `src/link/**`, `src/doc/source-record.ts`, `tests/link/**`, `tests/kernel/kernel-link.test.ts`, `e2e/cad-link.spec.ts`, `e2e/cad-link-plugins.spec.ts`, `e2e/cad-link-carry.spec.ts`, `e2e/cad-link-exit.spec.ts`, `scripts/gate-l2-cad.mjs`, `scripts/gate-l3-cad.mjs` | LINK | The Part's design as a project geometry (host API 1.5 and 1.6, §11): the export, the face-name sidecar, the link controller, the study record's `source_version`, the exit hook and its camera; gate:l2-cad, gate:l3-cad. |
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
   Undo takes back that panel's changes as one step, which Redo brings back).
   Both bind Ctrl+Shift+Z to
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
  0 and are stable per shape id. `version` returns `api: 3` (the contract below plus
  the API 3 table at the end of this section).
- Worker protocol: `ready` | `fatal` | `result` (worker -> main), `call`
  (main -> worker, `bytes` transferred as `params.ptr/len`). Buffers come back
  as ArrayBuffers in the transfer list.
- `KernelAdapter` (`src/kernel/`): one call in flight, wall-clock watchdog
  (20 s default; `import_step` 300 s, `props`/`topo` 120 s, `tessellate` 60 s:
  `src/kernel/timeouts.ts`). On a watchdog stop, a trap or a crash it
  terminates and respawns the worker; the call rejects with kind `watchdog` /
  `trap` / `crash`, queued calls with `restarted`; `onRespawn` listeners (the
  rebuild engine) rebuild from the document, because every shape id died.
  A call may carry an `AbortSignal` (`KernelCallOptions.signal`): aborting drops
  it from the queue, or, while the worker runs it, terminates and respawns the
  worker at once (a kernel op cannot be interrupted); it rejects with kind
  `cancelled` (name `AbortError`). An import's read, heal and BREP write carry
  the panel's signal, so its Cancel frees the kernel at once (P2+P3 review
  round 1: the next action waited 36 s for the 113 MB read).
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
- **API 3 (P2/P3; `docs/p2p3-plan.md` §2 is the full contract, the typed one is
  `src/types/kernel-protocol.ts`)**. Same conventions (JSON, shape ids, bytes as
  `ptr/len`, buffers out, `valid` + work copies on every shape-making op).
  | Op | Params -> result (abridged) |
  |---|---|
  | every shape result | adds `faces` (TopExp::MapShapes count), so names need no `props` call |
  | `import_step` | + `diagnose` -> + `unit`, `diagnostics` (per shape: BRepCheck problems, free edges, closed) of the shapes as read |
  | `heal` | `{ids, tol=0.001, sew='auto', sew_tol}` -> work copies, ShapeFix + Sewing (knit) + solids from closed shells; `{shapes, fixed, sewn, free_edges, diagnostics, history}` |
  | `brep_write` / `brep_read` | `{ids}` -> buffer `brep` (BinTools compound, format version 4: pinned, the app's OCP 7.9.3 reads it) / bytes -> `{shapes}` with the same indices |
  | `link_export` (LINK) | `{ids}` -> buffer `brep`: one BinTools (format 4) compound of the SOLIDS of the shapes, in order; with the app's face numbering: `visit_body` / `visit_face` per TopExp_Explorer(FACE) visit over the compound (no de-duplication: a face two solids share is visited once per solid), `solids` (`src`, `piece`, `faces`), `empty` (shapes with no solid) (§11) |
  | `press_pull` | `{id, faces, d, fuzzy}` -> prism of each planar face along +-normal, fuse (d > 0) or cut (d < 0), unify, history; `{moved, sides, op, empty}` |
  | `combine` | `{op: join|cut|intersect, targets, tools, fuzzy, unify}` -> `{results: [{target, id, empty, solids, valid, history}]}` |
  | `measure` | `{a, b?}` (sub-shapes, shapes, points, planes, axes) -> one entity's length/area/radius/centre/direction, or distance (BRepExtrema) + delta + angle |
  | `sketch_regions` | `{plane, curves}` -> regions with canonical keys (cyclic oriented sub-segments, split points named by sketch point or crossing pair + ordinal), area, sample, triangles (`tri_uv`, `tri_idx`, `tri_ranges`), open ends, dangling entities |
  | `extrude_regions` | `{plane, curves, regions (keys), extent, flip}` -> the extrude of those regions (adjacent ones merged) with `sides` per sub-segment token and `caps` per region |
  `version` answers `api: 3` once all exist. Timeouts: heal 300 s, brep_read /
  brep_write 120 s, measure 60 s (`src/kernel/timeouts.ts`); press_pull, split and
  combine on inputs of more than 2,000 faces get 120 s (`timeoutForFaces`).
- API 3 behaviour worth knowing (measured; `docs/p2p3-plan.md` §8 has every
  contract change):
  - UnifySameDomain after `combine` / `press_pull` runs on a copy and is checked:
    a merged result that is invalid while the unmerged one is valid is not kept
    (`unified: false`). Seen on the Vortex inlet cap +50.8 mm (natively the merged
    face is invalid too).
  - `split` counts the input faces in no piece (`lost_faces`); any loss is
    `valid: false` with the reason, even with `check: false`. OCCT's splitter drops
    half of the 113 MB part at its middle X plane without an error; the Split
    feature shows that reason in red ("Split 1 failed: <body>: split lost part of
    the body ..."), never "does not cut".
  - Known OCCT failure, reported invalid (natively too): the Vortex roof
    (z = 304.8, the face the inlet pipe is tangent to) pushed down 10 mm.
  - The default volume integration is about 1.5e-7 off on the Vortex (B-spline
    faces); `props {volume_eps}` integrates to a given error.
  - The 113 MB part (Node, wasm32): `import_step {heal: true, diagnose: true}`
    36.6-38.7 s (the diagnosis 6-8 s of it); `brep_write` 0.2-0.4 s -> 68.3 MB;
    `brep_read` 0.4-0.7 s, same counts, the native volume within 9e-15; combine
    21.6 s, press-pull 19.4 s, split 17.3 s. `sketch_regions`: a sketch of a few
    dozen curves 2-30 ms; 225 overlapping circles (841 regions) 0.53 s.
  - `kernel-build/ship.mjs` replaces the shipped kernel only while holding
    `.cache/build.lock` (e2e runs hold it), so a build never lands mid-run.

## 6. Document

- **Schema v1** (`src/types/doc.ts`): `CadDoc` = units, params, bodies (id ->
  name/colour), features (P1: `box`, `cylinder`, removed by decision 2026-10-01; origin is implicit:
  `OriginRef`, `ORIGIN_PLANES`). Body-making features carry
  `op: new|join|cut|intersect`, `creates` (a body id fixed when the feature is
  made) and `scope`. Every numeric field is an expression string.
- **Schema v2** (P2/P3, `docs/p2p3-plan.md` §1): adds `import`, `delete_faces`,
  `press_pull`, `split`, `combine`, `sketch`, `extrude`, stored references
  `{name, semantic, signature}` and `CadView.sketches`. Migration 1 -> 2 changes
  no field; a schema-1 build refuses a v2 file instead of dropping the bodies it
  does not know (imports, split pieces). The study pointer keeps `schema: 1`
  (its own format). Box and Cylinder rows (P1's only features, removed by
  decision 2026-10-01: solids come from sketches and STEP) are still read and
  kept; the rebuild marks each red, "This part uses a removed feature (Box 1)",
  Edit says to delete it and sketch the shape, and Delete takes it
  away (`REMOVED_FEATURE_TYPES` in `src/types/doc.ts`). The SD pass adds
  `enclosure` (§10). A feature type declares what it reads and makes and which
  fields are expressions (FeatureTypeDef `uses`, `ownsBody`, `newBodies`,
  `exprs`/`mapExprs`, `isolateWhileEditing`; `src/doc/features/hooks.ts` holds
  the P1 defaults). Builds may publish an `output` (a sketch's regions) that
  later features read; a feature's cache key holds its parents' keys. Every body
  carries face names (`src/naming/`).
- **Include in simulation** (LINK, §11): `BodyDef.simulation === false` leaves
  a body out of the project's geometry (absent = included). It is a model change
  (one undo step: "Leave Body 1 out of the simulation"), so it is saved and is a
  new version of the design. A derived body (a split piece) gets its BodyDef
  then, as a rename does.
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
    runs the exit hook first (host API 1.6, §11), which saves (the leave waits
    for a save on its way, "Saving Part 1" in the app's header) and links; the
    app asks "Leave without saving?" only when the page is still dirty after it
    (a value typed and not applied), and "Couldn't update the project" when the
    save or the link is refused. Turning CAD off in Settings runs no hook and
    asks as before, and F5 or closing the tab gets the browser's own prompt. The page never reloads itself. A value
    typed in a panel field and not applied yet (NumberUnitInput commits on
    Enter or blur) counts too (`src/lib/pendingEdits.ts`, SD review round 2:
    in a real browser the frame runs in its own process and the field's blur
    came after the host had closed the workspace, so Back lost it): the page
    is dirty while it waits ("Changes typed in <field> of <Part> are not applied
    yet.", and the save chip says "Not applied: press Enter", so it agrees with
    the app's unsaved dot), and one the field refused keeps the page dirty with
    "...: the value typed in <field> is not applied. <reason>.". Since LINK's
    polish (SD final review) the signals apply it as follows: the leave keys (F5,
    Ctrl+R / Ctrl+W, the side buttons) as Enter would; the pointer leaving the
    frame only a whole value the field takes that was not typed in the last
    800 ms (`commitPendingEdits('quiet')`: "-" on its way to "-5" stays typed,
    and no refusal shows); the frame losing focus (the app's header, its dialogs,
    another window) and the page going apply nothing, so the app's "Leaving
    discards them" is true and Stay finds the text still typed. Since the LINK
    UX review (U1) focus coming back to the window with nothing focused puts
    the keyboard back in the field holding typed text (caret at the end), and an
    Enter with nothing focused applies typed text (`installPendingEditKeys`), so
    "press Enter" is true after Stay. A panel's Done applies what is typed; one a
    field refuses keeps the panel open on that field.
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
    While an Enclosure arrow is dragged, model writes are held
    (`DocService.holdSaves()`): the drag applies live and one write follows
    the release (flush and leaving still write).
- **Conflicts**: a save refused because another tab wrote -> save state
  `conflict`, edits paused, chip "Changed in another tab" with two choices
  (Daniel, 2026-10-02): "Reload (discard my change)" reads the other tab's
  version (a toast names what this tab lost), and "Keep mine (replace the other
  tab's save)" asks in the app's own dialog first ("Replace the other tab's
  save?", what is lost), then writes this tab's model on top of the stored one
  (`Autosave.keepMine`: the stored etag, the counter past both); the other tab is
  told when it saves next. A tab with NO change of its own whose model another
  tab saved over finds out when its window gets the focus back
  (`Autosave.checkStored()`: the stored etag is no longer this tab's): save state
  `updated`, chip "Updated in another tab" with Reload only, edits paused, and it
  is not unsaved work (not dirty, no unsaved dot; L3 review B1: it used to be the
  `conflict` state, which reported dirty and offered Keep mine over the other
  tab's real work). Its exit reads the newer model in place and links (or skips)
  without asking (§11). So an overwritten tab never says "Saved" (UX review). A rename in the host header arrives as
  `bridge.onStudy` with a new rev: adopt it silently (the pointer field is
  untouched).
- **The design's version** (LINK, §11): every model write carries a save counter
  (`source_version` in `model.json`), one more than the version it replaces, so it
  never goes down (at load: the file's, or the study record's when that is
  newer). `DocState.sourceVersion` is the stored design's. While the study links
  a geometry, each save also goes into the study record's reserved
  `source_version` (`src/doc/source-record.ts`: the first at once, then at most
  one write per 1.5 s, never down), so the app's geometry row can say "Not up to
  date with Part 1.". Not before a link: no row shows it then, and each record
  write moves the record's rev, which refused a rename the app's header had
  started on the old rev (e2e: a new Part's first save, then a header rename).
  Since host cb62201 the header reads a stale rev again once and renames, so
  such a rename goes through (`cad:link-names` renames a linked Part while its
  page writes; the refused first call's 409 is the one console line it allows,
  and it must be there); not writing before a link is kept (no row needs it).
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
  incomplete inputs is not saved and Done says why. `removeBlock(id)` says why
  a feature cannot be removed (a later feature uses it) without changing
  anything; `remove()` checks it before it touches an open session on that
  feature, so a refused Delete keeps the panel's work (P2+P3 review round 1: it
  discarded the open sketch's edits first). `changed` says whether Done would
  keep a step: Undo with a panel open commits that step and undoes it at once,
  so Redo brings the panel's work back (round 2: it was discarded, and a new
  feature could not be brought back). This holds with the keyboard still in a
  panel field after Enter: a field with nothing typed carries
  `data-undo-to-app`, and the keyboard hands it Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
  (never the browser's text undo); typed and not applied, Ctrl+Z first puts
  the applied value back (round 3: the field showed the old value while the
  model kept the new one, and Done then stored the old one).

## 7. UI rules (Daniel's, non-negotiable)

- **Honest UI.** Only commands that work end to end are registered; nothing
  greyed "for later", no "coming soon", no `TODO` in copy. A disabled control
  says why (`CommandDef.enabled` returns the reason). Empty states read
  "No X yet". Errors read "<Action> failed: <why>".
- **Panel chrome**: flyouts close with **Done** in the foot; **Delete** only
  when something can be removed (on a new feature it discards it; an existing
  feature a later one uses shows none: `usePanelDelete`, `src/ui/panel-delete.ts`); **no tick or
  checkmark** in any header; valid field changes apply live.
- `ws.ui.confirm` (the host's, always a red button) only for destructive
  actions; other choices use an in-frame `<dialog>` (`showModal`,
  `aria-modal`). Tab and Shift+Tab go round its buttons and never leave it,
  and while one is open the workspace keyboard runs no shortcut (a Tab that
  reaches the page outside it goes back into it): `src/lib/modal.ts` (P2+P3
  review round 2: one Tab sent the keyboard out of the frame, then Enter ran
  Finish sketch, 1 the Front view and Delete a second dialog behind the open
  one). Toasts through `bridge.toast`.
- A Delete that would be refused is offered disabled with the reason (the
  tree's menu as the panel's foot). After a Delete, later features that built
  before and fail without it are named in a toast with the way back ("Deleted
  Combine 1: Press-pull 1 fails without it. Undo (Ctrl+Z) brings Combine 1
  back."), and a stored face that is gone is named ("Start face of Extrude 2 not
  found on Body 1 after rebuild"; a merged one by what it was made of, "End face
  of Extrude 1 merged with End face of Extrude 2"). Its row in the feature's panel is marked: red,
  "not found", the way back in its tooltip (round 3: it looked found).
- A context menu's highlight follows the pointer: hovering an item gives it the
  keyboard, hovering a disabled one gives it to the menu, so at most one item
  looks active (round 3: Edit kept its focus ring beside the hovered Delete).
- An exported STEP names itself: FILE_NAME carries the file name, a blank author
  and organization and "Magnusim CAD" (`src/features/export/header.ts`; round 3:
  OCCT's 'Open CASCADE Shape Model' and 'Author'). Reload after "Changed in another tab" says what
  of this tab it dropped ("Enclosure 1, made in this tab and not saved, is
  gone").
- **UI kit (host API 1.3, H14).** Panels are drawn with the host's
  `@magnusim/plugin-ui` and its stylesheet `/plugin-sdk/plugin-ui.css` (the
  kit's `mgk-*` classes; the kit's own gate, core `e2e/h14-kit.spec.js`, holds
  them equal to the core's controls). CAD ships no copy of those recipes.
  - The kit's components as they are: `Field`, `Select`, `Hint`,
    `DisabledReason`, `EmptyState` (outside the tree), `Toggle` (`Switch`) and
    `formatSci`. CAD wraps them only in a box carrying data-* test hooks
    (`[data-field="op"] select`, `[data-switch="knit"] input`,
    `[data-run-reason] .mgk-reason-msg`), because the kit's components take none.
  - CAD's own, drawn with the kit's classes: `Button` (the kit's disables
    natively, so a disabled button would take no focus and no hover and its
    reason could not be read; CAD's stays focusable with `aria-disabled`),
    `PanelChrome` (rename from the head, Done disabled with a reason, the note
    line, the accent bar) and `NumberUnitInput` (expressions against the
    parameters, "= 12.5 mm", the reason under the field, Ctrl+Z to the app).
  - No kit counterpart: `IconButton`, `Icon` (sizes 11 and `className`),
    `Flyout`, `FieldGroup`, the tree, `ContextMenu`, `Tooltip`, `Chip`, rename,
    the import progress bar (not the kit's `StatusBlock` clock), the tree's
    empty row (`.sim-empty`, the core tree's own).
  - Toasts stay `ws.ui.toast` (`bridge.toast`), as the kit's docs say for a
    frame; the kit's `Toast` is for a page that draws its own.
  - `e2e/cad-sd-kit.spec.ts` compares each adopted control with the kit's
    component rendered in the same frame, and fails on a CAD rule that copies a
    kit recipe (`.fp-btn`, `.bc-select`, `.mat-panel`, ...).
- Design language: `research/design-language.md`. Colours only through
  `var(--mg-*)` / `var(--cad-*)` (`src/styles/tokens.css`): the `--mg-*` token
  wherever the core value has one (host 1.3 named many: `--mg-divider`,
  `--mg-card-border`, `--mg-control-border`, `--mg-link`, ...), `--cad-*` only
  for values with none and CAD's own roles. Class names follow the core recipes
  (`tree-row`, `geo-head`, `tb-btn`, ...). Tree rows take
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
    changes tenfold in one rebuild or, while nobody has orbited, panned or
    zoomed since the last framing, when a body reaches out of the framed view
    (the Vortex's fluid-domain Box was cut off until F; never while a tool
    holds the pointer, such as the extrude arrow being dragged: one check at the
    release, since a camera moving under a still pointer ran the dragged value
    away), framing that takes in the shown sketches as well as the bodies
    (layers added with `frame`), the sketch being edited included (its curves,
    points and dimensions, not its grid), and the origin planes' extent only when
    neither a body nor a sketch is drawn (P2+P3 review round 4: a reopened sketch
    was framed on a later body the rollback hid, and a 35 mm sketch-only part sat
    small in the planes' 100 mm; a reopened sketch frames again once its rebuild
    has rolled the later bodies back, `reframe()`), a framing on its way that frames the
    bodies a rebuild just made (the first body's own framing does not cut it
    short), a new extrude seen straight along its direction turning the view
    to Isometric once (its arrow pointed at the viewer), framing that centres
    the part in what the tree and the open panel leave free (elements marked
    `[data-view-cover]`; at 1280 px a new sketch's plane sat half under them),
    origin planes in Auto hidden while a sketch is shown or sketch mode is on
    (`setPlanesBusy`; sketches are not bodies, and the Top plane's square sat
    under the sketch in the blue of its regions), and the core's context-menu items first
    (Normal to, Orbit around this face / edge / point, model center, origin;
    Hide face and Show all faces are not offered: CAD does not hide faces).
- Keyboard: the host gives the page the keyboard when it connects and again
  after its own dialogs and Settings close (host API 1.2), so keys work with no
  click in the part. A click on the host's header takes the keyboard away; the
  dock then shows "Click here to use keyboard shortcuts" (proposal §3.4 hint)
  until the frame has focus again. Escape with nothing open lets go of the
  selection; F2 on a face, edge, point, body or plane says what it does in a
  toast instead of doing nothing. Delete with only faces selected runs Delete
  faces (P2): faces of an import or a P2 edit open its panel with them; faces
  of a native feature (Extrude, Enclosure) ask first in the frame (Delete
  feature / Delete faces and heal / Cancel, focus on Cancel).
- Readouts: volumes group digits from 10,000 up (a metric part of a cubic
  metre or more reads in m³); with nothing selected the chip totals the shown
  bodies and says so ("Total of 3 bodies", "Total of 1 shown body"); a hidden
  body leaves the selection. A surface body (no solid: an open shell, e.g. an
  import before knitting) has no volume: "Surface body: no volume", and in a
  total it is not counted ("(1 surface body not counted)"). The Size chip
  beside it gives the same bodies' exact bounding box ("100 mm × 100 mm × 20
  mm"; proposal §7 P2: press-pull grows it). Tree labels end in an ellipsis inside the card,
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
  join: Extrude 2 shares no face with a body made before it" (an edge or a corner
  in common is not enough), and "Nothing to cut: Extrude 2 does not overlap any
  body made before it (touching is not enough)", the same for Intersect.
  A feature's error names its fields in the panel's words: an extrude's Two
  sides reason says "Distance 1: ..." under the field "Distance 1", Symmetric
  "Total distance: ...".

## 8. Tests

- Unit (`npm test`): jsdom by default; `// @vitest-environment node` for the
  real wasm. `@magnusim/workspace` is aliased to `tests/fakes/workspace-sdk.ts`
  (`createFakeWorkspace`, `setFakeConnection`); `tests/fakes/fake-worker.ts`
  scripts a kernel worker. three's `WebGLRenderer` needs WebGL, which jsdom
  lacks: mock `src/viewport/viewport` in DOM tests that mount the app.
- e2e (`npm run test:e2e [spec]`): builds, then runs Playwright against the
  host (`e2e/host-server.mjs`, which starts it with the app's `startHost()`,
  CAD turned on; host files the suite depends on: `package.json`
  `magnusim.e2eHostPaths`). Drive the frame with
  `page.frameLocator('#workspace-frame')`; assert what the user sees (visible
  text, computed styles, pixel colours via `e2e/png.ts`, download bytes).
  `window.__CAD__.snapshot()` is for state checks only. Every bug gets its own
  e2e test.
- Phase exit gates: `e2e/cad-p1-document.spec.js` is P1's (proposal §7, one
  test per bullet), against host API 1.2: CAD is On on a fresh install (it
  ships on since D33; `resetCadToDefault()` forgets the choice in the server's
  prefs), then turned off and on in Settings; every other spec turns it on again
  through the same endpoint when a test turned it off (`newProject()` calls
  `ensureCadOn()`). A fresh project has no STUDIES section while CAD's kind
  opens from its header button, so `newPartFromTree()` makes the first Part from
  the header's "CAD" menu (and renames it when the test wants another title). Review round 1 added its blockers
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
  P2+P3 review round 1 is `cad-p2p3-review1.spec.ts` (its blockers, the tools
  and constraints no test clicked, and the polish; one opt-in test with the
  113 MB STEP), `cad-p2p3-review2.spec.ts` (round 2: dialogs that keep the
  keyboard, the arrow drag in Isometric, typed lengths that keep their snap,
  value boxes that never overlap, and the polish), `cad-p2p3-review3.spec.ts`
  (round 3 at 1280 x 800: value boxes clear of the panel, the dock, the bottom
  edge and a typed 0; dimension labels after a reopen and a zoom; Ctrl+Z in a
  field; a lost face's row; the menu highlight; the STEP header; plane labels
  clear of the cards), `cad-p2p3-review4.spec.ts` (round 4, the SD pass: a reopened sketch, Fit
  and Look at frame the sketch and never bodies the rollback hides; a vertical line's boxes
  beside it; Extrude Cut from a face into the body; Split keeping its plane; the import's
  words; a fixed tree card width; Combine Intersect with several tools and pieces; the
  Sketch panel's face name; Home and End in menus) and
  `cad-p2p3-review1-polish.spec.ts` (the layout at 1280 px,
  refit, origin planes, model-mode sketch colours, face names, and e2e checks for
  the fixes that first had unit tests only: dimension placement, Symmetric on
  one place, trim relations, OCCT words). The smaller findings are in `cad-p1-review-polish.spec.ts`,
  `cad-p1-review2.spec.ts`, `cad-p1-review3.spec.ts` and P1.5's
  `cad-p15-review1.spec.ts`. The SD pass (decision 2026-10-01: no one-click
  Box or Cylinder) rewrote every test that made one: unit tests make sketched
  blocks and cylinders with `tests/doc/blocks.ts` (`block`, `cylinder`,
  `blockPair`; `BlockKernel` answers sketches and extrudes with toy boxes),
  e2e specs with `e2e/helpers.ts` `addSketch` / `addSolid` (fully defined
  sketches and their extrudes through the document, for set-up) or
  `drawRectangle` / `drawBlock` (as a user draws them, where the drawing is
  what is tested). `e2e/cad-sd-enclosure.spec.ts` is the Enclosure's (greyed
  with no body, zero padding = the exact bbox, percent and fixed, a dragged +X
  arrow, following an edited body, a cylinder about Z, Combine Cut with Keep
  tools, Daniel's Vortex by `CAD_E2E_VORTEX_STEP`) and the removed-feature row;
  `e2e/cad-sd-review1.spec.ts` holds SD review round 1's findings (sides past
  the part, cylinder sides and axes, two bodies and the fluid following, a
  removed Box a Combine uses, the panel's layout, see-through). `addSketch`
  leaves the camera as it was (a sketch session's Look at is held off while it
  commits): a sketch set up "as made earlier" must not turn the view.
  No test is marked PENDING-HOST any more, and none
  depends on when an automatic save retry comes (a refusal is kept up until the
  moment the test clicks Retry).
  P2's gate is `e2e/cad-p2-step.spec.js` and P3's `e2e/cad-p3-sketch.spec.js`
  (proposal §7 adjusted by `docs/p2p3-plan.md` §5; one test per bullet; the
  builders' drafts `cad-p2-features-step`, `cad-p3-sketch-mode`,
  `cad-p3-profiles-*` stay as area specs). The P2 gate reads the Vortex STEP
  by path (`CAD_E2E_VORTEX_STEP`, never copied; its Vortex tests are skipped
  without it, saying so) and checks the exported STEP
  natively with the core venv's OCP 7.9.3 (`CAD_E2E_PYTHON`, inline `python -c`)
  and in the core's own "+ Add geometry". `e2e/cad-large-step.spec.js` is the
  113 MB part (opt-in `CAD_E2E_BIG_STEP`).
  The broken-manifest test breaks `manifest.toml` in place for that one test;
  `e2e/manifest-guard.mjs` keeps the real file in `.cache/` and every run's
  global setup puts it back if a run stopped mid-test.
- Real Chrome/Edge (`CAD_E2E_CHANNELS=chrome,msedge`) for anything about load
  time or process isolation: bundled Chromium caches sandboxed frames and does
  not isolate their process.
- Verify for real: a panel mounting or an API answering is not a pass; only
  the end-to-end behaviour is.

- **gate:l2-cad** (`npm run test:gate:l2-cad`, LINK): `tests/kernel/kernel-link.test.ts`
  (the real kernel and the app's own checker, `python -m magnusim_sdk.link check`
  from the core venv or `CAD_E2E_PYTHON`, on CAD exports: two bodies sharing a
  face, a body with an internal face; every face visit's body and centroid against
  the app's `face_visits`; the sidecar byte for byte against
  `magnusim_sdk.link.write_face_names`; format 4; a fresh kernel's export of the
  same design byte-identical), `tests/link/` (the controller against every answer
  of the app; the sidecar's words), `e2e/cad-link.spec.ts` (create, update in
  place, the no-change skip and a byte-identical re-export after a reopen, the
  app's question answered Keep editing / Overwrite / Save as new, a stale second
  tab, the include toggle) and `e2e/cad-link-plugins.spec.ts` (plugin_needed, on
  its own app server with the app's link test plugins). After Keep editing the
  specs allow no console line (the host's uncaught `BridgeError: You kept
  editing.` is gone since cb62201). `e2e/cad-link-carry.spec.ts`
  holds the carry-overs (two tabs: Reload or Keep mine; Finish sketch keeps the
  camera).

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
- Host API 1.5 (L2): `ws.project.linkGeometry` / `linkedGeometry`, the
  `geometry` event, the study record's reserved `source_version`, and the
  manifest's `links_geometry = true` on the Part study kind (§11).
- Host API 1.6 (L3): the exit hook `ws.nav.onLeave` and the camera it returns
  (`ViewState`, §11). `manifest.toml` declares `api_version = "1.6"`.
- Host API 1.4 start actions, CAD on by default (Daniel's D33, after gate:l3-cad;
  the core half is 60bb971): no `default_enabled = false`, and one
  `[[start_actions]]` for the Part kind: "Design a part" on the empty project and
  in New Project's "Start from", "New design" on Home, and the header button
  "CAD" (all four places). The header button takes the kind out of the
  Workspaces menu, and STUDIES shows once the project has a Part
  (`e2e/cad-start.spec.ts`; the app's `e2e/start-actions-bundled.spec.js` reads
  the manifest).
- After a leave that linked nothing (a refused link answered "Leave anyway", or
  no body included) the app reads its tree again (host fix 253d6a4): the
  geometry's row says "Not up to date with Part 1." at once, with no tick
  (`cad:l3-behind-row-refused`, `cad:l3-behind-row-no-body`, no reload).
- The app's update report (host fix 253d6a4) names only what a setup holds: no
  dialog when nothing of it changed, a toast for a mesh left out of date, and a
  dialog naming each record and face (by CAD's labels) that was lost, split or
  moved far (`cad:l3-report`, `cad:link-names`). A large part lands with the
  view as given (`cad:large-step-exit-camera`, opt-in).
- Host API 1.3 (H14): the UI kit `@magnusim/plugin-ui` in the frame's import
  map and `/plugin-sdk/plugin-ui.css` linked after `theme.css`, before the
  page's own CSS (so CAD's rules win a tie). `manifest.toml` declares
  `api_version = "1.6"` since L3 (above).
- In the host since 42e38c6 (API 1.2): **G1** `ws.files` with etags,
  **G7** focus on connect and `nav.setDirty`, **G11** `default_enabled` (CAD
  shipped off with it until D33), **G12** the boundary checker skips
  `node_modules` and dot folders.
- CAD ships on, so the generated registry (`docs/plugins/registry.json`,
  `scripts/generated/registry.json`) has a `cad` row: `npm run gen:registry`
  writes it, in the same commit as the flip. The core tests that count plugins,
  kinds or header buttons run against the required plugins only (the core half
  60bb971: `requiredBundledDir`, `bundled_manifests.py`), so they pass with CAD
  on. The plugin's first commit still adds CI jobs (`cad-plugin`, `core-without-cad`),
  the root `ROADMAP.md` entries (the "come back to later" list) and
  `THIRD_PARTY_NOTICES.md`.
- The workspace frame is `sandbox="allow-scripts allow-downloads"`
  (the host's `src/workspace/WorkspaceOverlay.tsx:478`): a blob URL on an `<a download>`
  saves a file (STEP export), and a hidden `<input type=file>` opens the picker.

## 10. Extension points (P2/P3; `docs/p2p3-plan.md` §3)

- **Modules.** A feature or area is a folder whose `index.ts` default-exports a
  `CadModule` (`src/types/modules.ts`): feature types, panels per feature type,
  tool panels (not features), status chips, context-menu items, and an
  `install(services)` for commands, keys, bus handlers and viewport layers.
  `src/modules.ts` finds `src/features/*/index.ts` and `src/sketch/index.ts`
  with `import.meta.glob` (sorted: reproducible builds), registers the feature
  types before the Part loads, and installs the modules after the UI shell. No
  shared list is edited to add one; duplicates throw at start-up.
- **Services.** `services.modules` (panels, tools) and `services.apis`
  (`sketch`, `solver`, `files`: one writer each). `services.mode` is written by
  sketch mode only.
- **Panels.** Every feature panel comes from a module (the shell's own
  Box/Cylinder panel went with them in the SD pass); a feature type no module
  gives a panel for is not opened (a toast says this version cannot edit it, or,
  for a removed Box or Cylinder, to delete it and sketch the shape) instead of
  crashing the flyout.
- **Enclosure** (`src/features/enclosure/`, SD pass, decision 2026-10-01). The
  toolbar's CFD PREP group (after the modelling groups; `ModelGroup` `cfd`)
  has Enclosure, greyed "Add or import a body first" until a body exists. It
  makes one new body, "Enclosure 1", and never cuts (no Operation row): Shape Box
  | Cylinder (Axis X / Y / Z), Bodies to enclose (default: every solid body
  before it but other enclosures; `uses: 'all'`, so any body change rebuilds it),
  Padding Zero (default) | Percent of part size | Fixed distance, and a value per
  side (+X −X +Y −Y +Z −Z; Radius, Top, Bottom, or "+X end" / "−X end" about X
  or Y) that overrides the padding; "Use padding" gives a side back to it, and
  changing Padding keeps the sides set on their own. A side may go into the part
  (one amber note names every such side: Combine Cut will leave the cut-off part
  out of the fluid) but never as far as its far side (`geometry.ts` `sideMin`:
  refused with the reason under the field, and the arrow stops there). When the
  part shrinks under a side already set, the Enclosure fails with the reason, and
  its panel shows it under that side (`enclosureShape` names the sides; a failed
  build still publishes the bodies and bbox it found, so Bodies keeps its count).
  Escape during an arrow drag (Enclosure or Extrude) puts the value back and
  keeps the panel open. The size comes from the kernel's exact bbox
  (`props {bbox: 'exact'}`) every rebuild, so it follows the part and keeps the
  user's per-side values. Arrows in the view drag a side live
  (`handles.ts`; the release applies the pointer's last spot, so a fast drag
  stores where it ended). Faces are named by side (`F:<id>:enclosure:+x` ->
  "+X face of Enclosure 1", in Measure and the pick lists too (`naming`
  `placeWords`); OCCT's box faces come −X, +X, −Y, +Y, −Z, +Z, a cylinder's
  side, top, bottom, named `+x-end` / `-x-end` about X). Its body is drawn
  see-through (`FeatureTypeDef.seeThrough` -> `ViewportBody.seeThrough`:
  translucent, no depth writes, pushed back so a coplanar part face wins whole;
  a click through it picks the opaque body behind). The fluid domain is Combine
  Cut, the enclosure the target (a new Combine then turns Keep the tool bodies
  on), the part the tool. A cylinder enclosure is round about the bbox's
  corners (radius half the cross diagonal), not about round parts.
- **Commands.** `primary: true` draws the mode's primary button (Finish sketch);
  `activeWhen` draws a command pressed while its panel, tool or sketch tool is
  in use; `canRun(id)` asks without running. Shortcuts are mode-aware: a key runs
  the newest command of the current mode with that shortcut (`mode: 'any'`
  matches both), and passes to older bindings when none matches (the shell's
  Delete and Escape). Fit and the standard views work in both modes. In sketch
  mode EDIT shows `sketch.undo` / `sketch.redo`. Delete with only faces selected
  runs `modify.delete-faces` when it is registered and enabled.
- **Viewport.** `addLayer` (three.js group + html element over the canvas;
  `frame: true` makes what it draws count when the view frames the part, a
  function `frame: () => box` only the box it gives: sketch mode's layer counts
  the sketch, not its grid), `reframe()` (the last framing again with what is
  drawn now, unless the camera was moved since),
  `pushTool` (pointer events before the camera and the selection; a consumed
  press captures the gesture), `rayAt`, `toPlane`, `pixelSize`, `onFrame`,
  `lineResolution`, `setPlanesBusy(owner, busy)` (whatever draws something
  other than bodies keeps Auto's origin planes hidden: the profile overlay does,
  while a sketch is shown or sketch mode is on). A floating panel over the left
  of the view carries `data-view-cover` (the left stack does): fit, the
  standard views and Look at centre the part in the rest, re-aimed during the
  transition when a panel opens with it. They move the image's centre
  (`CameraRig.shift`, three's view offset; every projection, ray and pick goes
  through the same camera), not the camera: a camera moved sideways saw a top
  view's walls in perspective. The shift is not saved with the Part's camera. Selection kinds `sketch` and `region`, highlighted by their
  owners. Value boxes: Enter that places the shape lets go of the box (a line
  chain's next segment starts with empty boxes that follow the pointer; the
  next digit goes into Length, A reaches the tool); a typed value the shape
  cannot take keeps the box and the keyboard, with the reason under it
  ("Radius must be at least 20 mm"); each box sits below what it measures where
  that is free (a box that measures a segment, a line's Length or a rectangle's
  Width and Height, beside it across from its middle, as Fusion does: round 4,
  a vertical line's boxes sat on the line), else at the nearest free spot inside the viewport
  (`freeSpot`, `src/lib/chrome.ts`): never under the pointer, the points and
  lines being drawn, another box, or what floats over the view (the tree card and the open
  panel, children of `[data-view-cover]`; the dock's chips; the view buttons and
  triad; round 3: boxes sat under the Sketch panel and the dock, and at the
  bottom edge or for a typed 0 the Angle box sat under the Length box). The
  origin planes' labels keep clear of the same chrome ("Right" showed as "ght"
  beside a panel; the viewport draws again when the chrome changes size).
  Dimension labels and arrows are laid out again whenever the view's scale
  changes (a framing, a zoom, a resize), not only on the next render (round 3: a
  reopened sketch's labels jumped on the first click, so a double-click missed). With no box
  focused, digits go into the first box and Tab to the next (Fusion: Length is
  the active box); a pointer move over a box still reaches the tool; a line
  typed with a length only keeps the direction its preview snapped to, with
  that relation (horizontal, vertical, parallel, perpendicular, tangent). The
  extrude arrow shows a grab hand (closed while dragged). Constraint
  glyphs and dimension labels are buttons (Tab, Space selects, Enter edits a
  dimension). The toolbar fits the frame from 1280 px: VIEW and EDIT, then every
  group but the primary action, show icons only when the labels do not fit
  (`useFitLevel` in `src/ui/Toolbar.tsx`; the label stays in the tooltip).
  HTML in a layer that takes the pointer (sketch value boxes, labels)
  never sits under it while a tool draws: a small circle's Diameter box once took
  the rim click, so no circle was made (`src/sketch/overlay.ts` moves the boxes
  out from under the pointer on every move).
- **Document.** Feature-type hooks (§6), outputs, parent keys, `ctx.files`,
  `ctx.solver`, `isolateWhileEditing` (the rebuild stops after a sketch while it
  is edited), `setSketchVisibility`, derived body ids
  (`src/doc/features/body-ids.ts`). A sketch built while the solver was not
  running shows its stored shape with a warning; its cache key says so, and
  DocService rebuilds when the solver starts (`onSolverChange`), so it is then
  solved.
- **Face names in panels.** A P2 face list names a face as Measure does:
  "Face N of <body>", N its number on the body as shown when the panel first
  showed it (kept while the panel is open, so the live result renumbering or
  removing faces does not rename it); the tooltip adds where it came from
  ("Face 3 of flange, from Face 3 of Imported 1 (flange.step)"). A face the
  shown body no longer has is named by its history. The Sketch panel names the
  face a sketch lies on the same way ("Face 6 of Body 1", from "End face of
  Extrude 1"; round 4: it said "Face of Body 1").
- **Sketch colours in model mode.** Each line in its own definition colour, as
  sketch mode draws it: sketch mode's analysis stores an under-defined sketch's
  fully defined entities in `solved.fully` (optional; absent on sketches not
  analysed since), the profile overlay draws those in `--mg-text`, the rest
  in the accent blue (red for an over-defined sketch).
- **Naming.** `src/naming/`: names after every op from its history (null, not
  unstable names, when a result or an input cannot be named), references made at
  pick time and resolved at rebuild (name and same kind -> clean; moved kind,
  split, merged or signature only -> "Reference repaired · check"; nothing ->
  "Face not found after rebuild"; the P2 features say which face, in the
  panels' words: "Start face of Extrude 2 not found on Body 1 after rebuild").
  Extrude and Enclosure name their faces; booleans
  carry names once the kernel reports `faces` and `history`.

## 11. Linking a geometry (LINK, host API 1.5; exit sync 1.6)

A Part is live-linked to one project geometry (decision 2026-10-01): its design
becomes a geometry the simulation side uses, updated in place when the design
changes. The host's contract is `docs/plugins/authoring.md` "Linking a geometry
(1.5)" and `compatibility.md` "1.5"; this is CAD's side.

- **Who runs it.** `src/link/controller.ts` (`createLinkController`). Leaving the
  workspace runs it: the exit hook (`src/link/leave.ts`, below). There is no
  "Sync" button (Daniel: the sync happens on exit). Tests also reach it through
  `window.__CAD__.link.sync()`.
- **Save, then link.** Typed values are applied (the exit hook keeps them
  instead, below), the model is stored
  (`doc.flush()`), the app is told the page is clean (`bridge.setDirtyNow(false)`:
  a link while dirty is refused `unsaved`), then the export and `linkGeometry`
  with `sourceVersion` (the stored design's counter, §6) and `basedOnRev`
  (`linkedGeometry().rev`, null before the first link). A refused save (another
  tab, the disk) stops it with the reason.
- **The design linked is the one saved** (link review L2). The saved state, the
  model and its `sourceVersion` are taken together right after the save; after
  every wait (`linkedGeometry()`, `setDirtyNow(false)`, `bodiesAtEnd()`) they are
  checked again (still saved, the same model object, the same counter, nothing
  typed), and an edit in between goes back to the save (4 rounds, then "Part 1
  kept changing while it was being added to the project. Try again."). The app
  hears "clean" only while the state is saved. Unit: `controller.test.ts` (the
  review's race, ported).
- **Never a partial design** (link review L1). A feature of the history that
  failed or was stopped (`bodiesAtEnd().failed`) refuses the link: "Combine 1
  failed to build, so <Geometry> keeps its last update. Fix, retry or suppress it
  first."; so does an included body the kernel calls invalid ("Body 2 is not a
  valid solid, ... Repair it, or leave it out of the simulation, first."). So the
  no-change rule below never pins a design the Part could not build whole. A
  removed feature type (Box, Cylinder of an old P1 Part) has its own words, since
  it cannot be fixed or retried: "Old box is a removed feature (Box). Suppress or
  delete it, then leave." (L3 review B2). Such a Part says so when it opens: the
  dock's notice "This Part uses a removed feature: Old box · Suppress it"
  (`DocService.suppressRemoved()`: every one suppressed in one undo step, their
  data kept).
- **No change, no work.** When `sourceVersion` equals
  `linkedGeometry().sourceVersion` nothing is exported or written (the common
  "opened, looked, left"). When the geometry has a newer design (another tab's),
  it is refused as stale at once, with the app's words, without exporting.
- **Another tab's newer save** (L3 review B1). Before the link, a tab with no
  change of its own (saved, nothing typed) asks whether the stored model is still
  its own (`DocService.checkStored()`); when another tab saved over it, it reads
  that model in place (`DocService.reload()`, "Reading Part 1 as another tab saved
  it") and links it, or skips when the geometry has it already. Nothing asks.
  When both tabs changed it (`conflict`), the link is refused with the chip's
  words: "Part 1 was also changed in another tab. Choose Reload (this tab's
  changes are lost) or Keep mine (the other tab's changes are lost), then leave."
- **A refused save** (the disk is full): refused with the reason alone ("Saving
  failed: the disk is full."; the app's question names the geometry next). When
  nothing would be linked anyway (never linked, no included body: a sketch-only
  Part) it is not a failed update (`nothingLinked`): the exit hook tells the app
  the page's unsaved state again and returns ok, so the app asks its own "Leave
  without saving?" with the reason (L3 review polish 1).
- **The export** (`src/link/export.ts`): the bodies at the END of the history
  (`DocService.bodiesAtEnd()`: the rollback bar ignored, built through the
  rebuild cache without telling the page), in the Bodies folder's order, minus the
  bodies left out by "Include in simulation"; hidden bodies are included (hiding
  is a view). The kernel's `link_export` writes one BinTools compound (format
  version 4, pinned) of their solids, in mm, with no transform; a surface body has
  no solid and is never sent; a body of several solids sends each (ids
  `<body id>#2`, ..., named "Bar · piece 2"). With none included, nothing is linked and it says "No body
  is included in the simulation; <Geometry> keeps its last update.".
- **face_names.json** (`src/link/sidecar.ts`), exactly the app's canonical form
  (sorted keys, no whitespace, rows by index, one line; byte for byte what
  `magnusim_sdk.link.write_face_names` writes for the same rows; no per-save
  field): faces in the app's order (every TopExp_Explorer(FACE) visit over the
  compound, no de-duplication: a face two bodies share is listed once per body),
  each with `body`, `name` (the persistent face name without its internal `#k`
  split suffix; a name longer than 200 characters keeps its start and a hash of
  the whole) and `label` ("Extrude 1 · Side 3", "Enclosure 1 · +X face",
  "Imported 1 · Face 12", "... · part 2" for a split piece, "A + B" for a merged
  face; at most 120 characters); bodies with `index`, `id` (the stable body id),
  `name` (unique in the export: "Body 1 (2)"), `label`, `color`; and
  `shape_sha256`. Both files go to `studies/<sid>/export/` through `ws.files`,
  and the link passes the sha256 values `ws.files.write` returned.
- **Byte-identical.** The same saved design exports the same bytes (the kernel is
  deterministic; BinTools writes indices, not pointers; the sidecar is canonical),
  so a re-export after a reload is a `change: 'none'` link (`kernel-link.test.ts`
  in a fresh kernel; `cad-link.spec.ts` after a reopen).
- **The app's answers.** `stale`: re-read, and try once more only when this
  design is newer than the linked one (else the app's message: "Part 1 changed in
  another tab. Reload to continue."); `changed`: write both files again and try
  again (twice at most); `superseded`: nothing to do; `cancelled` (the app's
  question answered "Keep editing", or the update removed from the Queue): stay,
  show nothing; `busy` (a "Save as new" of this study is being added): try again
  shortly (4 times), only when the app answers so at the call (a `busy` after it
  reported a stage is how the job ended: its message, no retry); `unsaved`: tell the app the page is clean again, once;
  `gone` (the geometry was removed): link again as a first link, once;
  `plugin_needed` and every other refusal: the app's message as it is. "Save as
  new" resolves with `created` and the new geometry id; `linkedGeometry()` names
  it from then on. The app's question itself is the app's dialog over the page;
  the call waits while it is open.
- **The study record.** `source_version` after each save while a geometry is
  linked (§6), so the geometry's row can say "Not up to date with Part 1." while
  the saved design is newer. A deliberate difference from `authoring.md`
  ("Write the reserved study key `source_version` after each save"): before the
  first link CAD writes it nowhere but `model.json`. No row shows it then, and
  every study-record write moves the record's rev, which made the app's header
  rename (sent with the rev it read) fail after a new Part's first save. The
  first link passes `sourceVersion` itself, and from then on the record follows.
- **One sync at a time.** A second `sync()` with the same options while one runs
  gets the same answer; one with other options (its own signal, progress or
  notify) runs after it, except when the running one was stopped by its signal
  and still waits (a leave the user cancelled while a save was on its way): the
  new call takes it over (its signal, its progress, which hears the last step
  again), so the next exit says "Saving Part 1" too and links once.
- **The exit hook** (host API 1.6, L3; `src/link/leave.ts`, registered in
  `app/bootstrap.ts` once the page has connected; `bridge.onLeave` is null on an
  older host, and a refusal `not_allowed` registers nothing). The app runs it on
  every way out it owns (its Back, the browser's Back or a link, another project,
  Home, Open in 3D); turning CAD off, closing or reloading the tab run nothing.
  It runs the controller with the leave's `signal` (checked between steps: a
  stopped leave ends quietly) and `progress` (the controller's words, then the
  app's link stages, said again every 5 s so the app's 30 s stall clock never
  fires during a long export) and returns `{ ok: true, view }`:
  - `view` is the camera the user left with (`viewStateOf`): position, target
    and up in model mm (the export has no transform), Z up, `fovDeg` the
    vertical field of view (30, three.js `fov`), or `height` the full visible
    height of an orthographic view at the target. Also when nothing changed
    (the no-change rule: no export, the app lands on the same geometry with the
    camera). The same view goes on `linkGeometry` (`SyncOptions.view`): after
    "Continue in background" the page closes before the hook returns, so only
    the link's view lands (host 1.6, `cad:l3-background-camera`).
  - No body included: no link; the plain message ("No body is included in the
    simulation; Part 1 keeps its last update.") as the leave's progress line in
    the app's header, held 3 s so it is read (Cancel there keeps the Part). No
    page toast: it said the same twice and covered the view controls (L3 review
    polish 3), and it closes with the workspace anyway. An empty Part that was
    never linked leaves at once.
  - A save still on its way: the exit waits for it ("Saving Part 1", Cancel).
    After 25 s (`SAVE_STUCK_MS`) it gives up with CAD's own words, "Part 1 is
    still saving after 25 seconds.", before the app's 30 s stall question would
    say "it did not answer" (L3 review polish 2); Stay keeps the Part, its save
    goes on, and the next leave takes the same sync over.
  - "Keep editing" in the app's question (`cancelled`) or a stopped leave:
    `{ ok: true }` at once; the app has ended the leave and the Part stays.
  - A refused link (a failed or stopped feature, an invalid body, the app's
    refusals such as `plugin_needed`, `unsaved`, `stale`) throws CAD's reason
    alone (`brief`: "Split 1 failed to build. Fix, retry or suppress it
    first."); the app asks "Couldn't update the project" with it and adds what
    became of the geometry ("Part 1 keeps its last update.").
  - Typed text (a value typed in a field, no Enter) is not applied by the hook
    (`typed: 'keep'`): the saved design is linked (the app hears "clean" for the
    link, then the page's own state again, `DocService.retellDirty()`), and the
    app's "Leave without saving?" question after the hook asks about the text,
    as it always did ("Leaving discards them" stays true; Stay finds the text).
  - A Part that never loaded (still loading, or unreadable): nothing to sync.
  - The Part has no page-level "Done" (a panel's Done closes the panel); one
    would call `nav.back()` (`bridge.back`) and the hook does the sync.
  `window.__CAD__.leave` (`hook`, `runs`, `last`) is for the tests.
- **The gates.** `npm run test:gate:l3-cad` is `scripts/gate-l3-cad.mjs`, built
  like the L2 gate: it fails at once without the app's Python or the Vortex
  (`CAD_E2E_VORTEX_STEP`), runs `L3_UNIT` (`tests/link/leave.test.ts`,
  `controller.test.ts`, `tests/app/bootstrap.test.tsx`, `tests/doc/service.test.ts`,
  `tests/ui/panels.test.tsx`) with `--allowOnly=false`, then
  `e2e/cad-link-exit.spec.ts` with `CAD_L3_REQUIRE=1` and `--forbid-only` (its own
  app server with the app's slot-hold test hook, `MAGNUSIM_TEST_SLOT_HOLD=1`, for
  "Continue in background"), and fails on any skipped test, on a unit file that
  ran no test, and on a census miss (`L3_E2E_CENSUS`: exactly the expected e2e
  tests by id, each expected to pass). Its landings are strict: a report dialog
  only where the setup needs one (its title, and its lines where the test gives
  them), any other dialog fails (never clicked through), and the app's record of
  the landing must agree (a dialog, a toast with its words, or nothing). No test
  is marked `test.fail()`: the host defects the L3 reviews found (the row's tick
  after a leave that linked nothing, a bogus "moved far" report, the large part's
  camera) were fixed in 253d6a4 and their markers removed; a unit test checks
  that none is left.
  `npm run test:gate:l2-cad` is `scripts/gate-l2-cad.mjs`: it fails
  at once without the app's Python, runs the unit tests with
  `CAD_LINK_REQUIRE_PYTHON=1` (a missing Python fails them instead of skipping),
  and fails on any skipped unit or e2e test in the JSON reports (link review L3).
