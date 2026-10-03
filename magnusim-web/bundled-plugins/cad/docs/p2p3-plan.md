# P2 + P3 plan: STEP editing slice and sketcher

Architect's plan for the four builders who work in parallel (KERNEL,
P2-FEATURES, P3-SKETCH, P3-PROFILES), then INTEGRATE. Read this file, then
`ARCHITECTURE.md`, then the contracts in `src/types/`. Where this file and the
proposal (`CAD Plugin/00 - Research and proposal.md`) disagree, this file wins;
where it and Daniel's decisions (`01 - Decisions 2026-09-30.md`) disagree, the
decisions win.

**What is already in place (written by the architect, tests green):** every
contract below in `src/types/`; the extension-point plumbing (module discovery,
feature hooks, outputs, parent keys, sketch isolation, overlays and tools,
mode-aware shortcuts, primary toolbar button, module panels, tools, chips and
context-menu items, Delete-faces hook); schema 2 with its migration; the naming
layer in `src/naming/` with names flowing through Box, Cylinder and their
booleans. So a builder **only adds files in its own folders** (§4); nobody
edits a shared file. If you need a shared change, write it in
`<scratchpad>/cad/p2p3/requests-<builder>.md` and code against the contract
meanwhile; INTEGRATE merges requests.

Verified: `npm run typecheck` clean; `npx vitest run` 291 passed / 1 skipped
(the 267 of P1.5, all still green, + 24 new in `tests/arch/`); `npm run
build:check` matches; the whole existing e2e suite (`node scripts/e2e.mjs`,
bundled Chromium, port 8210, the shared server lock) 57 passed, 1 skipped (the
opt-in 553k-triangle perf test) in 5.6 min, against the changed viewport,
toolbar, keyboard, UI shell and schema.

Contents: §1 schema · §2 kernel ops (API 3) · §3 extension points · §4
ownership · §5 e2e scenarios · §6 order of work and definition of done · §7
open questions and risks · §8 contract changes during the build.

Files the architect changed (for INTEGRATE's review; nothing outside the plugin):
| Area | Files |
|---|---|
| Contracts | `src/types/{doc,doc-service,kernel-protocol,kernel,selection,commands,app,viewport,docstore,events,index}.ts`; new `src/types/{modules,naming,sketch,files}.ts` |
| Plumbing | new `src/modules.ts`; `src/app/{bootstrap,commands,keyboard}.ts`; `src/doc/{service,rebuild,schema,params}.ts`; new `src/doc/features/{hooks,body-ids}.ts`; `src/doc/features/{body-op,primitives}.ts` (names); `src/kernel/timeouts.ts` (API 3 ops) |
| Naming | new `src/naming/{names,resolve,refs,result,index}.ts` |
| UI shell | `src/ui/{controller.ts,LeftStack.tsx,Toolbar.tsx,StatusDock.tsx,commands.ts,ui.css}`; `src/ui/panels/FeaturePanel.tsx` (type narrowing only) |
| Viewport | `src/viewport/viewport.ts` (layers, tools, rays), `src/viewport/commands.ts` (Fit and views in both modes) |
| Tests | new `tests/arch/{p2p3-plumbing,naming,ui-extension}.test.ts(x)`; `tests/ui/fake-doc.ts`, `tests/doc/{service,rebuild}.test.ts` (schema 3 is now "newer"; a type narrowing); `e2e/cad-p1-doc-storage.spec.ts` (new models are schema 2) |
| Docs | this file, `ARCHITECTURE.md` (§2 ownership rows, §5 API 3 table, §6 schema 2, §9 downloads, §10 extension points) |
A copy of `src/` and `tests/` before these changes is in
`<scratchpad>/cad/p2p3/arch-backup/`.

---

## 1. Document schema 2 (`src/types/doc.ts`)

`DOC_SCHEMA = 2`. **Migration 1 -> 2 changes no field** (box and cylinder are
unchanged); the bump only makes a schema-1 reader refuse a schema-2 file ("saved
by a newer Magnusim CAD"), because a P1.5 build would drop imported and split
bodies' names and colours on its next save (its body clean-up knows only
`creates`). `readDoc` reads 1 and 2 (`DOC_SCHEMAS_READ`) and writes 2. The study
pointer keeps `schema: 1`: it is the pointer's own format, not the model's (the
model file carries its schema). New Parts write `doc.schema = 2`
(`e2e/cad-p1-doc-storage.spec.ts` updated to say so).

### 1.0 Rules every new feature type follows

Each type is a `FeatureTypeDef` (`src/types/doc-service.ts`) in its module and
MUST give, besides create/resolve/incomplete/parents/build:

| Hook | Why |
|---|---|
| `exprs(f)` + `mapExprs(f, fn)` | The P1 default walks every string field; references, region keys and file paths are strings, so a parameter rename would rewrite them. Every P2/P3 type lists its expressions. |
| `uses(f)` | Bodies the build reads or changes: the rebuild cache key and the parent/child guard ("Combine 1 uses Body 2 of Split 1"). |
| `ownsBody(f, id)` when it makes bodies other than `creates` | Keeps their BodyDefs alive; makes it the parent of features using them. |
| `newBodies(f, doc)` when it brings names/colours | Import. |
| `isolateWhileEditing` | Sketch only. |

Builds always: honour `valid` (an invalid result is `ok:false` with the
kernel's reason and `actions: ['repair']` when a repair path exists; never a
silent pass); free every kernel shape they made and do not return
(`ctx.release`); return `names` for every body they make or change (§3.6);
words: "<Feature> failed: <why>".

### 1.1 Persistent references (§4.5 point 4)

```ts
PersistentRef = { name: string; semantic?: { feature?, role? }; signature: RefSignature }
RefSignature  = { kind: 'face'|'edge'|'vertex'; type; size?; at: Vec3; dir?; radius?; bbox? }
BodyRef       = { body: BodyId; ref: PersistentRef }
```
Made with `refOfFace(lookup, shape, names, index)` when the user picks (the only
re-anchoring point); resolved with `resolveFace` at every rebuild (§3.6). A
feature never rewrites its stored refs during a rebuild.

### 1.2 `import` (P2-FEATURES)

```ts
ImportFeature {
  source: StoredFileRef & { fileName, unit? }   // studies/<sid>/imports/<sha256>/source.step
  brep:   StoredFileRef & { occt }              // studies/<sid>/imports/<sha256>/healed-<tolKey>.brep (BinTools)
  heal:   { tolerance /*mm, default 0.001*/, sew }
  items:  { body, index, stepName, stepColor, kind: 'solid'|'shell', valid, reason? }[]
  diagnostics?: { problemsBefore, problemsAfter, fixed, sewn?, freeEdges? }
}
```
- Name: "Imported 1 (flange.step)". Bodies: one per solid (or open shell kept as
  a surface body), ids fixed at import; BodyDefs from the STEP name and colour
  (`newBodies`), default `#bdc9db`.
- Build: `ctx.files.read(f.brep)` (sha256 checked by DocService) -> kernel
  `brep_read` (bytes) -> one shape per item, **never** `import_step` or `heal`
  (a reopen never re-heals). Validity per body from `items[].valid` (the same
  bytes were checked when written). Output `ImportOutput {type:'import', from:
  'brep', bytes, ms}`. Names: `indexedNames(f.id, 'import', faces, item.index)`
  = `F:<f>:import:<item>:<i>`. `ctx.files === null` (host 1.1): "Imported 1
  failed: importing needs Magnusim's file storage (host API 1.2)".
- `uses` []; `parents` []; `exprs` [] (no expressions; tolerance is a plain
  number set by the panel).
- Re-heal with another tolerance writes a new BREP from the kept `source` (no
  new upload); the feature's `brep`/`heal`/`items`/`diagnostics` change in one
  session (one undo step). An OCCT version change (`brep.occt` differs from the
  kernel's) re-heals from `source` with a warning "Imported 1 was healed again
  with OCCT x.y: check later references".

### 1.3 `delete_faces` (P2-FEATURES)

`{ body, faces: PersistentRef[] }`. Kernel `defeature {id, faces}`
(BRepAlgoAPI_Defeaturing, exists, history). The body keeps its id. Names via
`namesFromResult(f.id, result, inputs, {role: 'heal'})` (modified faces keep
names; faces only generated get `F:<f>:heal...`). Invalid -> red + Try repair (ShapeFix via `repair`, kept only if
valid and the volume moved < 1e-3). A reference not found -> "Delete faces 1
failed: Face not found after rebuild" (no partial delete).

### 1.4 `press_pull` (P2-FEATURES)

`{ body, faces: PersistentRef[], distance: Expr, repair? }`. Planar faces only.
Kernel `press_pull` (§2.4). Positive adds material, negative removes it. Names:
moved faces keep their names (history `modified`); side faces
`F:<f>:side:E:<a>&<b>` from the input edge's two face names (P2 passes
`edgeFaces` from a `topo` of those edges). Repair as booleans (fuzzy steps,
then ShapeFix). Validation: "Distance must not be 0".

### 1.5 `split` (P2-FEATURES)

```ts
SplitFeature { targets: BodyId[]; tool: {kind:'plane', plane: OriginPlaneRef, offset: Expr}
                                       | {kind:'face', body, face: PersistentRef}
                                       | {kind:'body', body, keepTool: boolean} }
```
- Kernel `split` (exists): by plane (`{id, plane:{origin, normal}}`; a face tool
  passes the face's plane from `topo`, planar faces only) or by tool body
  (`{id, tool}`). Pieces ordered by the kernel (along the normal; largest volume
  first for a tool body).
- Piece 0 keeps the target id; piece k >= 1 is `deriveBodyId(f.id, target, k)`
  (`src/doc/features/body-ids.ts`), named "<target name> (k+1)" in the target's
  colour through the build result's `name`/`color` (no BodyDef until the user
  renames or recolours it: DocService then stores one). `ownsBody(f, id)` =
  `parseDerivedBodyId(f.id, id) != null`.
- Tool body with `keepTool: false` -> `removed: [tool]`.
- Names: per piece from `history.pieces[k].faces` with the input's names; cut
  faces (no history) get role `cut` -> `F:<f>:cut#k`.
- Invalid piece -> red + Try repair (ShapeFix on the invalid pieces).
- `uses` = targets (+ tool body).

### 1.6 `combine` (P2-FEATURES; decision 2026-09-30, MVP)

`{ op: 'join'|'cut'|'intersect', targets: BodyId[], tools: BodyId[], keepTools, repair? }`.
Kernel `combine` (§2.6). Join: everything fuses into the first target, the
other targets are removed; Cut/Intersect: each target with the union of the
tools; an empty result removes that target ("Body 2 was removed completely",
amber). Tools are removed unless `keepTools`. Works on imported and native
bodies alike (they are all just bodies). Invalid -> red + Try repair (fuzzy
0.001, 0.01, then ShapeFix: the body-op path in `src/doc/features/body-op.ts`
shows the pattern). Large inputs: `timeoutForFaces('combine', faces)`.
`uses` = targets + tools. Validation: "Pick at least one target", "Pick at
least one tool", "A body cannot be a target and a tool".

### 1.7 `sketch` (P3-PROFILES builds it; P3-SKETCH edits it)

```ts
SketchFeature {
  support: {kind:'plane', plane: OriginPlaneRef} | {kind:'face', body, face: PersistentRef}
  plane:   PlaneFrame                 // snapshot at the last successful resolve (§4.5 point 5)
  points:  Record<SketchPointId, Vec2>  // solved coordinates, mm; SKETCH_ORIGIN ('origin') implicit at [0,0], fixed
  entities: (point | line{p,centerline?} | circle{c, r} | arc{c,a,b,ccw?}) & {id, construction?, parent?}
  constraints: (SketchRelation | SketchDimension)[]
  solved: { values: Record<constraintId, number>, dof, state: 'under'|'fully'|'over'|'unsolved' }
}
SketchRelation  { id, kind: coincident|horizontal|vertical|parallel|perpendicular|tangent|equal|midpoint|
                  symmetric|point_on_line|point_on_circle|concentric|collinear|fix, refs, value?, inferred? }
SketchDimension { id, kind: distance|distance_x|distance_y|radius|diameter|angle, refs, expr, driving, at? }
```
- Ids: `pt_`, `e_`, `c_` (`newId`). Lineage: trim/split keeps `e_1` on one
  piece and makes `e_1.b`, `e_1.c` with `parent: 'e_1'` (§4.5 point 1).
- Solved coordinates are the stored geometry: circles keep `r`, arcs their
  three points. `solved.values` = each **driving** dimension's value the stored
  geometry satisfies.
- Build (P3-PROFILES, `src/features/sketch/`):
  1. Plane: an origin plane -> `ORIGIN_PLANES`; a face -> `resolveFace` on the
     support body, planar check, frame = (origin: the global origin projected on
     the face's plane; normal: the face's outward normal; xdir: global X
     projected, or Y when X is within 1 degree of the normal). Lost face -> the
     stored `plane`, `output.supportLost = true`, warning "Sketch 2 lost its
     face: it stays where it was".
  2. Geometry: evaluate every driving dimension (`ctx.units`). All equal to
     `solved.values` (1e-9 relative) -> stored geometry (`source: 'stored'`).
     Else `ctx.solver.solveFeature(f, values)` from the stored coordinates
     (`'solved'`); solver failure -> red "Sketch 1 failed: the dimensions cannot
     all hold (conflicting: d3, d7)"; `ctx.solver === null` -> stored geometry
     with the warning "Sketch 1 shows its last solved shape: the sketch solver
     is not running" (`'stored-unsolved'`). Driven dimensions are measured in
     JS from the geometry used (never PlaneGCS `driving:false`, [D] solver.md).
  3. Regions: kernel `sketch_regions(plane, curves)` with the non-construction
     line/arc/circle entities (`SketchCurve`, §2.8), giving regions (key, area,
     sample, triangles), open ends, dangling entities.
  4. Result: `{ok:true, bodies:[], removed:[], output: SketchOutput}`.
- `isolateWhileEditing: true` (the rebuild stops after it while its panel
  session is open). `parents` = []; `uses` = face support ? [support.body] : [];
  `exprs` = the dimensions' `expr`.
- Tree (P3-PROFILES): prefix "(-)" under, none fully, "(+)" over, "(?)"
  unsolved, from `solved.state`; a lock glyph when fully defined; an eye that
  calls `doc.setSketchVisibility` (a sketch shows in model mode until a later
  feature uses it, unless the user chose).

### 1.8 `extrude` (P3-PROFILES)

```ts
ExtrudeFeature extends BodyMaking {   // op new|join|cut|intersect, creates, scope, repair?
  profiles: RegionRef[]   // {sketch, region: key, entities: sorted boundary entity ids, sample: Vec2}
  extent: {kind:'blind', distance} | {kind:'symmetric', distance /*whole length*/} | {kind:'two', distance, distance2}
  flip: boolean
}
```
- All profiles from one sketch (MVP; "Pick profiles from one sketch").
- Build: the sketch's `SketchOutput` from `ctx.outputs` (absent: "Extrude 1
  failed: Sketch 1 did not build"). Each RegionRef: exact key -> fine; else the
  unique region with the same boundary entity set -> warning "Profile repaired ·
  check"; several such -> the one containing `sample`, warning; none ->
  **"Profile lost"** (red: "Extrude 1 failed: Profile lost: the region of
  Sketch 1 it used is gone"). Kernel `extrude_regions(plane, curves, keys,
  extent, flip)` -> tool shape with history -> `applyBodyOp(f, f.name, {shape,
  valid, names}, ctx)` (New/Join/Cut/Intersect, repair, the P1.5 operation rules
  and messages come with it).
- Names: sides `F:<f>:side:<sub-segment token>` (namesAfter maps `seg` sources),
  caps `F:<f>:start` / `F:<f>:end` with one profile; with several, each cap is
  named by its profile's index in `profiles` from `history.caps` (`F:<f>:start:<n>`,
  merged regions take the lowest n), never by position, because two caps are
  planes with the same normal and a `#k` swap would resolve cleanly to the wrong one.
- `parents` = [sketch]; the rebuild's parent keys rebuild the extrude when the
  sketch changes. `exprs` = extent distances. Distance validation: "Distance
  must not be 0"; two-sided "The two distances must not add up to 0".

### 1.9 View state

`CadView.sketches?: Record<FeatureId, 'shown'|'hidden'>` (eye in the tree;
`DocService.setSketchVisibility`). Read by `readView`; not undoable.

---

## 2. Kernel operations, API 3 (KERNEL; `src/types/kernel-protocol.ts`)

Conventions unchanged (CONTRACT.md, ARCHITECTURE §5): JSON in/out, shape ids,
bytes in as `params.ptr/len`, buffers out, mm and degrees, `valid` on every op
that makes a shape, work copies for every mutating op, `{check:false}`.
**New for every shape result: `faces` (TopExp::MapShapes count)** so the naming
layer needs no extra `props` call (Box/Cylinder/booleans already use it when
present). `version` answers `api: 3` when every op below exists. Timeouts are in
`src/kernel/timeouts.ts` (heal 300 s, brep_read/brep_write 120 s, measure 60 s).

### 2.1 `import_step` (extended)
Params add `diagnose?: boolean` (default true). Result adds `unit` (the file's
length unit name) and `diagnostics: ShapeDiagnostics` = per shape
`{id, valid, problems (first 40, BRepCheck), problem_counts, problem_total,
free_edges (ShapeAnalysis_FreeBounds), closed}` + `total`, all on the shapes **as
read** when `heal:false`. Shapes add `faces`. P2 calls it with `heal:false`
for files up to 50 MB (raw shapes stay alive for "Heal all" again), and with
`heal:true` above 50 MB (the 113 MB part: no second copy in a 1.24 GB heap; a
re-heal re-reads `source`).

### 2.2 `heal` (new)
`{ids, tol?=0.001, sew?: boolean|'auto'='auto', sew_tol?=tol, diagnose?=true, check?}`
-> work copies; `ShapeFix_Shape` (precision = max tolerance = tol); with sewing
(`BRepBuilderAPI_Sewing(sew_tol)` over every face not in a closed valid solid,
then `ShapeFix_Shell`/`ShapeFix_Solid` to make closed shells solids =
"knit"); one output per closed solid or remaining open shell, input order.
Result `{shapes: [{id, from, name, color, type, faces, valid, reason?}], fixed,
sewn, free_edges, diagnostics, history (input faces -> output faces), timings}`.
Fixtures (KERNEL makes them natively with OCP 7.9.3 from the core venv, the
generator kept in `<scratchpad>/cad/p2p3/kernel/`, never as a `.py` in the
plugin; outputs into `fixtures/kernel/` with their README rows):
`box20-faces.step` (the 20 mm cube written as 6 unsewn faces: sew -> 1 valid
solid, volume 8000) and `box20-gap.step` (one face moved 0.005 mm: heal 0.01
closes it, 0.001 does not -> `free_edges > 0`).

### 2.3 `brep_write` / `brep_read` (new)
`brep_write {ids}` -> buffer `brep` (u8: `BinTools::Write` of a TopoDS_Compound of
the shapes, in order, no triangulation, to an `std::ostringstream`; FILESYSTEM=0
is fine) + `{bytes, occt, timings}`. `brep_read {check?=false}` (bytes in) ->
`{shapes: [{id, type, faces, valid?, reason?}], occt, timings}`, one shape per
compound child, **same face/edge/vertex indices** as written (BinTools keeps the
structure; the test checks topo signatures index by index). Round trip test:
volume and face count exact on Vortex and flange; time and size on the 113 MB
part (opt-in `CAD_KERNEL_BIG_STEP`).

### 2.4 `press_pull` (new) and the choice of approach
`{id, faces, d, fuzzy?, check?}` -> `ShapeResult & {moved, sides, op, empty, solids}`.
**Approach: a prism of each selected planar face along its own outward normal
(BRepPrimAPI_MakePrism, `d` > 0) or against it (`|d|`, d < 0), all prisms in
one boolean with the body (`BRepAlgoAPI_Fuse` for d > 0, `BRepAlgoAPI_Cut` for
d < 0; no glue: a prism can reach another wall of a non-convex body), then
`ShapeUpgrade_UnifySameDomain(faces true, edges true)`, history merged at every
step (prism Generated/FirstShape/LastShape, boolean History, unify History).**
- Why not `BRepOffsetAPI_MakeOffsetShape` / `BRepOffset_MakeOffset` with
  per-face offsets (Fusion's Offset Face): on OCCT 7.9.3 it fails on many
  imported shapes (the proposal files non-planar offset under V1-M "may fail"),
  and its history for the moved face is incomplete; and not `BRepFeat_MakePrism`
  (it wants the sketch face apart from the base and its gluing has the same
  overlap hazard as `glue`). The prism + boolean path is exactly the P0-gated
  boolean path (box minus Vortex within 8.9e-9), so it is the robust choice.
- Behaviour to document in the panel: a face whose neighbours are
  perpendicular grows or shrinks exactly (the CFD case: extend an outlet by
  `10*D`); a slanted neighbour is not extended (a step forms) - Offset Face that
  extends neighbours is V1-M.
- `moved[i]`: result index of the face where input face `faces[i]` now lies
  (the prism's far cap, through boolean + unify); `sides`: result face per
  boundary edge of a moved face, key `"<input face>:<input edge>"` (absent where
  it merged with an existing coplanar neighbour). Nothing left -> ok:false
  "press-pull would remove the whole body". Non-planar -> InputError "press_pull
  needs planar faces: face 3 is a cylinder".
- `history` is against the input id: a moved face is reported `modified` from
  its input face (so it keeps its name); a side face `generated` from the input
  edge it was swept from (`{shape, edge, how: 'generated'}`); faces the boolean
  and unify only changed are `modified` / `same` as usual.
- Tests: box 20 face +5 -> 20x20x25 (volume 10000), -5 -> 7500; flange top
  +10 -> 2 x 96,858.41 (the prism keeps the holes); the same after Delete
  faces of the holes -> 200,000; a Vortex planar face (the inlet cap F9, plane
  x = 5 in) +50.8 mm -> volume + pi*25.4^2*50.8 (it extends the inlet pipe);
  `moved` names the right face (its centroid moved by d along the normal).

### 2.5 `split` (exists)
By plane and by tool body as today. P2 passes a face's plane for face tools.
Add `faces` per piece (API 3). Tests: Vortex by the Top plane z = 0 -> 2 pieces
whose volumes sum to the whole within 1e-9.

### 2.6 `combine` (new)
`{op: 'join'|'cut'|'intersect', targets, tools, fuzzy?, unify?=true, check?}` ->
`{results: [{target, id, empty, solids, valid, reason?, problems?, history,
faces, warning_text?}], timings}`. All inputs copied together (shared sub-shapes
stay shared). Join: one result (`target` = targets[0]) fusing everything;
cut/intersect: one result per target, `BRepAlgoAPI_Cut/Common(target, tools)`.
Tests: 2 targets + 1 tool cut (volumes analytic), join of 3 boxes, intersect;
Vortex fluid box (`reference.json` `fluid_box`) cut -> 213,286,252.06 mm³ (1e-6
relative), common -> 44,798,524.14, the `fuse_box_side` join -> 49,269,787.87.

### 2.7 `measure` (new)
`{a: MeasureTarget, b?: MeasureTarget}`; targets are a sub-shape of a stored
shape (`{id, face?|edge?|vertex?}`), a whole shape, a point, an origin plane or
axis. One target: `{kind, type, area | length | volume, radius, center, dir,
point}` (BRepGProp, BRepAdaptor). Two: `distance` (BRepExtrema_DistShapeShape,
minimum), `p1`, `p2`, `delta`, `angle_deg` (planes/lines/axes, 0..90),
`parallel`, `center_distance` (circles/cylinders/spheres). Tests with analytic
answers: two parallel box faces 20, face to edge, vertex to vertex sqrt(3)*20,
angle between a box face and a 30 degree wedge face 30, cylinder radius 10,
Vortex outlet disk area pi*25.4².

### 2.8 `sketch_regions` (new) and the region key
`{plane: PlaneFrame, curves: SketchCurve[], tol?, tess?=true, deflection?}` ->
`{regions: KernelRegion[], open, dangling, timings}` + buffers `tri_uv` (f32 u,v),
`tri_idx` (u32), `tri_ranges` (u32 per region: [start in tri_idx, count]).
```ts
SketchCurve = {id,kind:'line',a,b,pa?,pb?} | {id,kind:'arc',c,r,a0,a1,ccw,pa?,pb?,pc?}
            | {id,kind:'circle',c,r,pc?} | {id,kind:'point',p,pid?}      // points accepted, ignored
KernelRegion = {key, loops: string[][], entities: string[], area, sample: Vec2, bbox}
```
Algorithm (all in the facade, one call):
1. One `TopoDS_Edge` per curve on the plane (arcs from a0 to a1 in their own
   direction; degrees from xdir, ccw about the normal). Zero length or r <= 0:
   InputError naming the entity ("line e_3 has no length").
2. `BOPAlgo_Builder` (general fuse) over all edges, fuzzy = `tol` (default
   1e-7 x the sketch's extent): edges split at every crossing, touching and
   overlap; `Modified(edge)` gives each curve's pieces; origins give each piece's
   curve.
3. `BOPAlgo_BuilderFace` (or `BRepAlgoAPI_Splitter`) splits a planar face
   covering every curve (bounding box x 2) by the pieces; faces that touch the
   covering face's own boundary are outside; the others are the regions.
4. Each region: wires with `BRepTools::OuterWire` first; every piece becomes a
   **sub-segment token**, the loop is written so the region is on the left (outer
   counter-clockwise about the normal, holes clockwise), see the grammar below;
   `area` (`BRepGProp::SurfaceProperties`); `sample` = centroid of its largest
   triangle (always inside); triangles from `BRepMesh_IncrementalMesh`
   (deflection default 1e-3 x extent), nodes mapped back to u/v.
5. `open`: vertices of the split pieces used by exactly one piece (degree 1),
   with the entity and the sketch point id there, if any. `dangling`: entities
   none of whose pieces bound a region.

**Region key grammar** (§4.5 point 2; nothing numeric, so a dimension change
keeps the key):
- split point: `p:<pointId>` when a sketch point is there (`pa`/`pb`/`pc`/`pid`
  of any curve, within tol), else `x:<E>|<F>#<k>`: the crossing of entities
  E < F (string order; a crossing of three or more is named by its two smallest
  ids) and a **pair-canonical ordinal** k: line x line: 0; line x arc/circle:
  order along the line from `a` to `b`; arc/circle x arc/circle (distinct
  centres): 0 = left of the directed line centre(E) -> centre(F), 1 = right;
  a tangent touch: 0.
- sub-segment: `<E>[<from>><to>]` along E's own direction (line a -> b; arc in
  its direction; circle counter-clockwise about the normal); a whole circle
  with no split point: `<E>[]`; a circle touched once: `<E>[X>X]`.
- loop: signed tokens (`+` along E's direction, `-` against it) joined by one
  space, rotated so the smallest token (JS string order) comes first.
- key: the outer loop, then each hole loop sorted, joined by `" / "`.
- Example, a rectangle e_1..e_4 through pt_1..pt_4 drawn counter-clockwise:
  `+e_1[p:pt_1>p:pt_2] +e_2[p:pt_2>p:pt_3] +e_3[p:pt_3>p:pt_4] +e_4[p:pt_4>p:pt_1]`.
  Two overlapping circles c_1 (left), c_2: 3 keys; the lens is
  `+c_1[x:c_1|c_2#1>x:c_1|c_2#0] +c_2[x:c_1|c_2#0>x:c_1|c_2#1]` up to rotation;
  changing a radius keeps all three.
- Tests (KERNEL, Node): rectangle (1 region); two overlapping circles (exactly 3
  regions, 3 distinct keys, the same keys after r 20 -> 25); slot with an inner
  circle (1 region with a hole); rectangle with a line across (2); open chain (0
  regions, 2 open ends, the chain dangling); a T-junction named by the point;
  lineage: trimming e_1 into e_1 + e_1.b changes only the keys that used the
  trimmed part; region area against analytic (lens area formula).

### 2.9 `extrude_regions` (new)
`{plane, curves, regions: keys, extent: ExtrudeExtent, flip?, taper_deg?, tol?, check?}`
-> `ShapeResult & {from, to, direction, solids}`. Re-derives the regions (§2.8),
refuses a missing key (InputError "region not found: <key>"), merges the
selected faces that touch (`BOPAlgo_Builder` then `ShapeUpgrade_UnifySameDomain`
with faces on, **edges off**, so each side keeps one sub-segment), then the
P1 prism code per merged face (blind / symmetric / two / through_all / to_face,
flip, taper), fused when several. History: `faces` entries with `seg` =
unsigned token for sides and `cap` for caps; `sides` (token -> face), `caps`
(region key -> {start, end}), `start`/`end` (the first region's). Tests: the two
middle-lens extrude (volume = lens area x d); both halves of a
rectangle split by a line (one solid with no internal face; the two sides the
line meets stay two coplanar faces each, their shared edges flagged
`same_domain` and hidden); flip; symmetric.

---

## 3. Extension points (in place; `src/types/`)

### 3.1 Modules (`src/types/modules.ts`, `src/modules.ts`)
Each feature or area is a folder with `index.ts` whose **default export** is a
`CadModule`:
```ts
{ id, features?: FeatureTypeDef[], panels?: {[type]: Component<FeaturePanelProps>},
  tools?: ToolDef[], contextMenu?(services, pick), chips?: Component[], install?(services) }
```
`src/modules.ts` finds `src/features/*/index.ts(x)` and `src/sketch/index.ts(x)`
with `import.meta.glob` (sorted, so the build stays reproducible), registers
feature types in `doc.features` before the Part loads, gives the registry to the
UI (`services.modules`), and calls every `install` after the UI shell's
(bootstrap). No list to edit. Duplicate ids/types/panels/tools throw at start.
- Feature panels render inside the shell's Flyout: use `PanelChrome`, `Field`,
  `NumberUnitInput`, `Select`, `DisabledReason` from `src/ui/kit` (read-only use
  of UI-SHELL's kit), the conventions of `src/ui/panels/FeaturePanel.tsx` (live
  apply through `session.update`, Done in the foot, Delete only when removable,
  no header tick, errors "<Feature> failed: <why>" in the foot with the fix
  buttons, "Not applied: ..." for typed changes that cannot apply).
- Open panels with `uiFor(services).openNew(type, init)` (init = select-first
  fields), `openEdit(id)`, `openTool(id)`; close with `closePanel()`.
- Tool panels (`ToolDef`, not features, not undoable): Measure, Mass
  properties, Check, Export.
- `chips`: status-dock chips after the shell's (sketch DOF chip).
- `contextMenu`: items after the shell's, behind a separator.

### 3.2 Feature hooks, outputs, files, solver (`src/types/doc-service.ts`)
- Hooks (§1.0) are honoured by DocService and the rebuild
  (`src/doc/features/hooks.ts`).
- `FeatureBuildResult.output` -> `RebuildState.outputs[id]` and later
  features' `ctx.outputs`; bodies may carry `names`, and a derived body a
  default `name`/`color`.
- **Parent keys**: a feature's cache key includes its parents' keys, so an
  extrude rebuilds when its sketch changes (and only then).
- `ctx.files.read(ref)` (sha256-checked), `ctx.solver` (null until sketch mode's
  module publishes it), `ctx.featureName(id)`.
- `isolateWhileEditing`: while a panel session edits such a feature, the
  rebuild stops after it (later features show "rolled back"; the saved rollback
  bar does not move). Commit or discard rebuilds everything.
- DocService adds `setSketchVisibility`; `renameBody`/`setBodyColor` accept a
  derived body (they store its BodyDef); `repair` works for any feature whose
  status offers `repair` (it sets `repair.fuzzy` on the feature).

### 3.3 Viewport overlays, tools, selection (`src/types/viewport.ts`, `selection.ts`)
- `handle.addLayer(id, {order})` -> `{group (three.js, model mm), html (div over
  the canvas, pointer-events none), setVisible, changed, dispose}`. LineMaterial
  resolutions in layers are set by the viewport every frame. Layer orders:
  regions 20, sketch geometry 30, dimensions/glyphs (html) 40, manipulators 50,
  measure markers 60.
- `handle.pushTool(tool)` -> pop. Tools see `down/move/up/click/dblclick/
  contextmenu/leave` (`ViewportPointer`, with the model ray) newest first,
  before the camera and the selection; consuming `down` captures the gesture
  (`click` follows `up` within 5 px). Unconsumed events get the P1 behaviour.
  Sketch tools consume left presses (not Alt, not middle/right), so middle drag
  pans, wheel and right drag zoom, Alt+left orbits (§3.2 left-drag rule).
- `rayAt`, `toPlane(clientX, clientY, plane) -> {p, uv}`, `pixelSize(at)` (8 px
  pick radius = `8 * pixelSize`), `onFrame` (re-place html), `project`.
- Selection kinds added: `{kind:'sketch', feature, id, what: 'point'|'entity'|
  'constraint'}` and `{kind:'region', feature, key}`; their owners draw their
  highlight (the viewport ignores them); the UI keeps them while their sketch /
  region exists.

### 3.4 Sketch mode (`src/types/sketch.ts` `SketchModeApi`, P3-SKETCH)
- Entered when a panel session opens on a `sketch` (new or edit): sketch mode's
  module gives the `sketch` panel (`panels: {sketch}`), watches
  `doc.state.session`, sets `services.mode` to `'sketch'`, turns the camera
  (`lookAt(plane.normal, up)`), pushes its tool, adds its layers, emits
  `sketch:mode`. Left when the session closes (Finish sketch = `closePanel`).
- Publishes `apis.sketch` (state: feature, tool, status, analyzing, typing) and
  `apis.solver`.
- Toolbar in sketch mode: DRAW / CONSTRAIN / DIMENSION / MODIFY (`mode:
  'sketch'` commands) + **Finish sketch** (`primary: true`, Enter) + VIEW (Fit
  and the standard views are `mode: 'any'`) + EDIT = `sketch.undo` /
  `sketch.redo` (ids in `WELL_KNOWN_COMMANDS`). `activeWhen: {sketchTool}` draws
  the active tool pressed.
- Keys are mode-aware (`bindCommandShortcuts` with the mode): register sketch
  shortcuts as `mode: 'sketch'` commands (L, R, C, A, D, T, X, Delete, Escape,
  Enter, Ctrl+Z, Ctrl+Y); in model mode they pass through to the shell's own
  Delete/Escape. Escape cancels the tool, then clears the selection; it never
  finishes the sketch. Command shortcuts do not fire while an input has focus,
  and the shell's own Escape (it does) closes the open panel, which for a sketch
  would finish it: so sketch mode also binds `keyboard.bind({combo: 'Escape',
  inInputs: true, run})` in its install, returning `false` (pass on) outside
  sketch mode, and keeps its on-canvas value boxes in its html layer (outside
  `[data-cad-panel]`).
- Undo inside sketch mode: a local stack of drafts within the session
  (`session.update(previousDraft)`); the whole session is one document undo step.
- Drags: solver `dragStart/Move/End` (moves coalesced in the worker); the draft
  is updated once at drag end (one undo step); a fully defined point refuses the
  drag (`not-allowed` cursor).
- Region shading in sketch mode comes from P3-PROFILES' layer (it reads
  `rebuild.outputs[sketch]`, which the isolated rebuild refreshes after each
  draft update).
- Status chip (`chips`): "Under defined · 2 DOF" / "Fully defined" / "Over
  defined · 1 conflicting"; entity colours under `--cad-sketch-under`
  (`--mg-primary`), fully `--cad-sketch-full` (`#101828`), over
  `--cad-sketch-over`; driven dimensions `--mg-text-muted` in parentheses.
- On Finish sketch the draft's `solved` = the last analysis (values, dof, state),
  `plane` = the resolved plane.

### 3.5 Solver client (`SketchSolverClient`, P3-SKETCH)
`src/sketch/solver-client.ts` over `workspace/solver/solver-worker.js` (append
`{entry: 'src/solver-worker/solver-worker.mjs', out: 'solver/solver-worker.js'}`
to `WORKERS` in `scripts/build.mjs`, the one allowed line there), started with
`bridge.spawnWorker`, ready handshake, one queue, drag moves coalesced.
`solveFeature(f, values)` builds the solver sketch itself (`toSolverSketch` in
`src/sketch/model.ts`: SKETCH_ORIGIN fixed, collinear -> two point_on_line,
driven dimensions as `driving:false`) and is what the rebuild calls. Budget:
drag <= 4 ms at 200 entities, analysis of an over-defined 1,000-parameter sketch
<= 300 ms off the main thread (P0 decision 2).

### 3.6 Naming layer (`src/naming/`, `src/types/naming.ts`)
- `BuiltBody.names` / `BodyInfo.names`: `FaceNames {faces: string[]}`.
- Grammar (`names.ts`): `F:<feature>:<role>[:<detail>]`, split `#k` (by
  centroid), merged `A|B`, edges `E:<a>&<b>`.
- `namesAfter(input, edgeFaces?)` / `namesFromResult(feature, result, inputs,
  opts)`: names from a kernel result's history; returns null (unnamed) when the
  result has no `faces`/`history` or an input is unnamed, so no unstable name is
  ever stored.
- `indexedNames(feature, role, faces, detail?)`: import (`import:<item>`) and
  primitives (`primitive`).
- `refOfFace(lookup, shape, names, index)`: a stored reference at pick time.
- `resolveFace({ref, shape, names, lookup})`: name + same kind (type; plane
  normal / axis within 1 degree) -> clean, whatever moved (a dimension change is
  not a repair); split / merged / kind changed -> nearest with "Reference
  repaired · check"; no name -> signature only if the runner-up is >= 50%
  worse, else "Face not found after rebuild". `kernelLookup(kernel)` gives the
  `topo` lookups. Callers show a resolution warning as the feature's amber
  message and a miss as its red error.
- `describeFace(name, featureName)`: words for panels ("End face (Extrude 1)",
  "Face 12 (Imported 1)").
- Box and Cylinder name their faces (`F:<f>:primitive:<i>`, stable index order
  of OCCT primitives) and `applyBodyOp` carries names through Join/Cut/Intersect
  once the kernel reports `faces` and `history`.

### 3.7 Files in and out (`src/types/files.ts`, P2-FEATURES `src/files/`)
`FileTransfer` = `pick(accept)` (a hidden `<input type=file>` appended to the
frame's body, `.click()` from the command's user gesture; works with
`allow-scripts` alone [S]), `onDrop(accept, fn)` (document-level dragover/drop,
a drop hint overlay), `store(rel, data, {onProgress, signal, sha256})` (ws.files
`write` with `ifMatch: null`: create-only; an existing file with the same sha256
is reused; host codes in words: too_large, quota "the project's CAD files are at
their 4096 MB limit", disk_full, plugin_off), `read(ref, {onProgress})` (ranges
of 16 MB for progress), `sha256` (crypto.subtle), `download(data, name, mime)`
(blob URL on a temporary `<a download>`, revoked after the click; the frame is
`sandbox="allow-scripts allow-downloads"`, `src/workspace/WorkspaceOverlay.tsx:478`
in the snapshot, and the P0 spike confirmed blob downloads work). Published as
`apis.files`. Size check before any upload: above `MAX_FILE_BYTES` (512 MB)
"This STEP is 600 MB. Parts can store files up to 512 MB." Files live in
`importFolder(studyId, sha256)`; discarding a new import deletes its folder
unless another import of the Part uses the same sha256.

### 3.8 Toolbar and command ids
| Group | Commands (id, shortcut) | Owner |
|---|---|---|
| SKETCH | Sketch `sketch.new` | P3-SKETCH |
| SOLID | Box, Cylinder (shell); Extrude `solid.extrude` (E) | P3-PROFILES |
| MODIFY | Parameters (shell); Press-pull `modify.press-pull` (Q); Delete faces `modify.delete-faces` (Delete on faces); Split `modify.split`; Combine `modify.combine` | P2-FEATURES |
| INSPECT | Measure `inspect.measure`; Mass properties `inspect.mass`; Check `inspect.check` | P2-FEATURES |
| FILE | Import STEP `file.import-step`; Export STEP `file.export-step` | P2-FEATURES |
| VIEW / EDIT | shell (Fit and views in both modes) | - |
| DRAW (sketch) | Line (L), Rectangle (R), Center rectangle, Circle (C), 3-point arc (A), Tangent arc, Point, Centerline, Construction (X) | P3-SKETCH |
| CONSTRAIN | Coincident, Horizontal, Vertical, Parallel, Perpendicular, Tangent, Equal, Midpoint, Symmetric, Concentric, Collinear, Fix | P3-SKETCH |
| DIMENSION | Dimension (D) | P3-SKETCH |
| MODIFY (sketch) | Trim (T), Extend | P3-SKETCH |
| primary | Finish sketch (Enter) | P3-SKETCH |
Each command: `enabled` returns the reason ("Select a planar face or a plane",
"Select faces of one body"), `activeWhen` for its panel, icons as in
`src/ui/Icon.tsx` (outline, 24 viewBox, stroke 1.7). Only commands that work end
to end are registered; the proposal's other MVP sketch rows (spline, offset,
mirror, sketch fillet, project) are not in P3: they go to the root ROADMAP
"come back to" list, not into the UI.

### 3.9 Delete on faces
The shell's Delete key with only faces selected runs `modify.delete-faces` when
it is registered and enabled. P2-FEATURES' command: faces of an **imported or
P2 feature** -> opens Delete faces with them; faces of a native feature (Box,
Extrude, ...) -> an in-frame `<dialog>` "Delete feature Box 1" / "Delete faces
and heal" / Cancel (§2.8 proposal), focus on Cancel, Enter/Escape cancel.

---

## 4. Ownership map

Nobody edits a file owned by another area. The architect's plumbing files are
frozen for the build phase (requests -> INTEGRATE).

| Builder | Owns (writes) |
|---|---|
| **KERNEL** | `kernel-build/**` (facade.cpp, scripts, SOURCES), `workspace/kernel/mk32.*`, `src/kernel-worker/**`, `tests/kernel/**`, `fixtures/kernel/**` (new synthetic fixtures + reference values from OCP 7.9.3), `e2e/cad-p2-kernel-*.spec.ts`. May correct field names in `src/types/kernel-protocol.ts` **only** to match the C++ JSON, and must then append the change to §8 of this file (others read it). |
| **P2-FEATURES** | `src/features/{import,delete_faces,press_pull,split,combine}/**` (feature modules), `src/features/{measure,mass,check,export}/**` (tool modules), `src/files/**`, `tests/features/{import,delete_faces,press_pull,split,combine,measure,mass,check,export}/**`, `tests/files/**`, `e2e/cad-p2-features-*.spec.ts`. |
| **P3-SKETCH** | `src/sketch/**` (module: sketch mode, panel for `sketch`, tools, overlay layers for geometry/glyphs/dimensions, constraint and dimension UI, DOF colours, drag, trim/extend, solver client, `model.ts`), `src/solver-worker/**`, `solver-build/**`, `workspace/solver/*`, the `WORKERS` line in `scripts/build.mjs`, `tests/sketch/**`, `tests/solver/**`, `e2e/cad-p3-sketch-*.spec.ts`. |
| **P3-PROFILES** | `src/features/sketch/**` (the sketch feature type: build, plane resolution, regions, region overlay layer in both modes, profile picking tool, finished-sketch display in model mode), `src/features/extrude/**` (feature, panel, command, arrow handle), `src/ui/tree/**` (sketch row prefix, lock, eye; the only shell files a builder may edit), `tests/features/{sketch,extrude}/**`, `tests/ui/tree*` updates, `e2e/cad-p3-profiles-*.spec.ts`. |
| **INTEGRATE** (after) | Everything else, the phase gates `e2e/cad-p2-step.spec.js`, `e2e/cad-p3-sketch.spec.js`, `e2e/cad-large-step.spec.js`, ARCHITECTURE/README/manifest description, merging requests. |
| Frozen now (architect's) | `src/types/**`, `src/modules.ts`, `src/naming/**`, `src/app/**`, `src/doc/**`, `src/kernel/**`, `src/lib/**`, `src/ui/**` except `src/ui/tree/**`, `src/viewport/**`, `tests/arch/**`, existing tests, `scripts/**` except the WORKERS line, configs. |

Cross-builder seams (code against the contract; integrate as they land):
- P2/P3 features call kernel ops that KERNEL is writing: run `npm run
  test:kernel` and use the real op as soon as it lands; until then, unit-test
  with `tests/doc/fake-kernel.ts`-style fakes in your own test folder.
- P3-PROFILES needs `apis.solver.solveFeature` (P3-SKETCH) only for sketches
  whose dimensions changed through a parameter; with `null` it shows the stored
  shape with the warning (§1.7), so it is testable alone.
- P3-SKETCH needs region shading (P3-PROFILES' layer) only for looks; sketch
  mode works without it.
- Shared UI building blocks a builder writes for itself stay in its folder
  (e.g. a selection-list field); INTEGRATE may lift one into `src/ui/kit` later.

---

## 5. e2e scenarios (INTEGRATE writes the gates; builders draft their parts)

Daniel's STEP files are read by path, never copied: `CAD_E2E_VORTEX_STEP`
(default `C:\Users\drmil\Desktop\3D\Step Files\Vortex CFD Test.step`),
`CAD_E2E_BIG_STEP` (opt-in, `...\8m0119333_V12.step`). A test that needs one
and does not find it fails with the path in its message (it is not skipped
silently); the opt-in big test is skipped with a visible reason when the
variable is unset. The native check uses `CAD_E2E_PYTHON` (the core venv's
python with cadquery-ocp 7.9.3) running inline code (`python -c`), because the
plugin may hold no `.py` file but `plugin.py`. Tests click "Leave" in the host's
leave dialog, never press Enter. Every asserted number below comes from
`fixtures/kernel/reference.json` (native OCP 7.9.3) or is analytic.

### 5.1 `e2e/cad-p2-step.spec.js` (P2 exit, proposal §7 adjusted)
1. Import `fixtures/kernel/flange.step` (file picker and drag-drop both) ->
   panel "0 problems"; tree "Imported 1 (flange.step)"; Bodies (1) with the
   STEP's body name; 10 faces; volume 96,858.41 mm³ (chip "96,858.4 mm³").
2. Select the 4 hole faces, Delete -> Delete faces 1 -> Mass properties says
   6 faces, volume 100,000 mm³ (+4·pi·5²·10, ±0.1%).
3. Press-pull the top face +10 mm -> the Mass properties bounding box grows
   10 -> 20 mm in Z; volume 200,000.
4. Split by the Right plane -> 2 bodies, "<STEP body name>" and "<STEP body
   name> (2)", 100,000 mm³ each; renaming the second stores its name.
5. Vortex: import -> 17 faces, 44,798,524.11 mm³; Box corner (-252.4, -252.4,
   -608) size 504.8 x 504.8 x 1012.8000123617928 (100 mm margin) -> Combine
   Cut, target the box, tool Vortex -> 213,286,252.06 mm³ (exact value from
   `doc.measure` within 1e-6 relative; the chip shows 6 significant digits:
   "213,286,000 mm³"), 22 faces, valid; Keep tools on -> the Vortex
   body stays; Intersect -> 44,798,524.14; Join with the `fuse_box_side` box ->
   49,269,787.87.
6. Measure two parallel faces of a 20 mm box -> "20 mm"; a hole's radius -> "5
   mm".
7. Export the fluid body (AP214) -> the download starts `ISO-10303-21;`,
   re-imports in the core's "+ Add geometry" with 22 faces (drive the core
   page), and natively (`CAD_E2E_PYTHON`) to 213,286,252.06 mm³ (reference
   `step_roundtrip_cut`).
8. Reopen the Part -> the same face names (`BodyInfo.names` equal before and
   after), the import's output says `from: 'brep'`, and no `import_step` or
   `heal` call reaches the kernel worker (spy as `cad-p15-review1` does).
9. A 600 MB file (an in-page `File` of zeros, dropped on the frame) -> "This
   STEP is 600 MB. Parts can store files up to 512 MB." and nothing uploads.
10. Contention: while the Vortex import uploads and autosaves, the core's
    project tree answers (P0 gate-10 harness, `<scratchpad>/cad/harness`) with
    p95 < 3x idle and no `project.tree` / `runs.upsert` timeouts.
11. A surface-only STEP (`fixtures/kernel/box20-faces.step`) -> diagnostics
    "6 faces not in a solid", Heal all with sewing -> 1 solid, 8,000 mm³.

### 5.2 `e2e/cad-p3-sketch.spec.js` (P3 exit, proposal §7)
1. Sketch on Top, rectangle from the origin -> "Under defined · 2 DOF".
2. Two dimensions (40, 20) -> "Fully defined"; line pixels `#101828`.
3. A diagonal dimension -> "Make it driven?" -> Accept -> grey "(44.72)".
4. Drag a fully defined corner -> it does not move (cursor `not-allowed`).
5. Delete the 20 dimension -> "Under defined · 1 DOF"; the corner drags.
6. Two overlapping circles (r 20 at 0,0 and 30,0) -> 3 shaded regions.
7. Extrude the lens 10 mm -> volume = lens area x 10 (analytic); radius 20 ->
   25 -> the extrude still uses the lens (green), volume follows the new lens.
8. Trim the arc that bounds the lens -> Extrude 1 red "Profile lost".
9. An open L of two lines -> the open-profile markers at both ends and the chip
   says "Open profile: 2 open ends".
10. Sketch on the top face of a 40 x 40 x 20 box, circle d 10, Extrude Cut,
    blind 20 mm flipped into the box -> volume 32,000 - pi·25·20 = 30,429.2.
11. Undo inside the sketch steps back one entity; Finish sketch; Ctrl+Z removes
    the whole sketch session; Ctrl+Y brings it back.

### 5.3 Daniel's flows (in the two gates)
- **Vortex fluid domain**: §5.1 items 5 and 7 together, as one story:
  import -> Box with 100 mm margin -> Combine Cut -> export -> core re-import
  and native volume.
- **Rectangle + circle**: sketch on Top a 100 x 60 rectangle and a circle d 20
  inside -> extrude the plate region (rectangle minus circle) 10 mm -> volume
  (6000 - 100·pi)·10 = 56,858.41; sketch on its top face a circle d 10 ->
  Extrude Cut 10 mm -> 56,858.41 - 250·pi.
- **Vortex bin** (no revolve: Revolve is P4a, not trivial here): Sketch on Top,
  circle d `D_bin` = 12 in, Extrude -20 in (flip) in an inch Part -> volume
  pi·6²·20 in³ = 2,261.95 in³ (37,066,665.5 mm³; the chip reads "2261.95 in³").

### 5.4 `e2e/cad-large-step.spec.js` (opt-in `CAD_E2E_BIG_STEP`)
Import through the UI: the panel shows upload percent, then "Reading
8m0119333_V12.step · 12 s" counting, then healing and storing; 11,776 faces;
volume 12,284.18 mm³ on request; the host header answers within 50 ms
throughout (its Back button's hover style or a host ping); the BREP is stored;
Back and reopen -> no `import_step`/`heal`, the body is back (time recorded in
`<scratchpad>/cad/p2p3/integrate.md`).

---

## 6. Order of work and definition of done

1. All four start at once from this plan. First commit of each: the module's
   `index.ts` exporting a `CadModule` with nothing registered that does not
   work yet (honest UI from the first build).
2. KERNEL lands ops in this order (others wait on them): `faces` on shape
   results, `sketch_regions`, `extrude_regions`, `combine`, `brep_write/read`,
   `import_step` diagnose + `heal`, `press_pull`, `measure`. Each with Node tests
   against `reference.json` or analytic values; `kernel-build/build.sh`
   reproducible (`repro-check.sh`); `version` api 3 at the end.
3. Each builder is done when: its feature works end to end in the frame
   (clicked through in the e2e host, screenshots in
   `<scratchpad>/cad/p2p3/<builder>/`), `npm run typecheck`, `npx vitest run`,
   `npm run test:kernel` (KERNEL), `npm run build:check` and the P1/P1.5 e2e
   specs it could affect are green, its e2e drafts pass, and its summary lists
   paths, commands and real failures.
4. Every bug fixed gets a test that fails without the fix (e2e when visible).

---

## 7. Open questions and risks

- **Vortex inlet blend (Fillet 2) is not needed in P2/P3**; the from-scratch
  Vortex is not a P3 gate (no revolve, no fillet yet).
- **Region keys under trim**: a trim renames split points of the trimmed
  entity; a region that keeps its entity set resolves with "Profile repaired ·
  check" (amber), one that loses it is "Profile lost". Expected; not silent.
- **`#k` split suffixes** are ordered by centroid. A reference stored to `A#1`
  resolves by name and kind, so if a later change reorders the pieces it can
  pick the other piece without a warning. P3 avoids it where it matters (extrude
  caps are named per profile, §1.8); the general fix (split pieces named by
  what split them) is P4a naming work.
- **Memory**: raw + healed shapes of a 113 MB import would double the heap, so
  files above 50 MB heal in the same call (§2.1).
- **A press-pull on a face whose neighbours are slanted** makes a step, not an
  extension (documented in its panel help; Offset Face is V1-M).
- `fixtures/kernel/vortex-cfd-test.step` was a copy of Daniel's file committed in
  P1. Review round 3 removed it: the kernel tests and both kernel-ops e2e specs
  read his file by path (`CAD_E2E_VORTEX_STEP`) and are skipped with the path in
  their names when it is not there; `tests/arch/user-files.test.ts` fails on any
  copy of his files in the plugin.
- Host: nothing new is needed. If a builder finds a host bug, it goes to
  `<scratchpad>/cad/p2p3/host-issues.md`.

## 8. Contract changes during the build (append-only)

| Date | Builder | Change | Why |
|---|---|---|---|
| | | | |
| 2026-10-01 | KERNEL | `version` answers `api: 3`: every op of §2 exists (`e2e/cad-p1-kernel-ops.spec.ts` now expects 3). | §2 done. |
| 2026-10-01 | KERNEL | `split` result adds `faces: number[]` (face count per piece, order of `ids`); `history.pieces[k].faces` stays the history. | §2.5 "faces per piece" without clashing with the history's `faces`. |
| 2026-10-01 | KERNEL | `import_step`: `diagnostics` describe the shapes **returned** (as read with `heal:false`, healed with `heal:true`: their ids and index spaces); shapes add `faces`, `valid`, `reason`; `fixed` (shapes ShapeFix changed) with `heal`. A STEP product without solids is **one** surface body (`type: 'shell'`, its shells together; an OPEN_SHELL whose faces share no edge reads back as one shell per face), and faces beside solids under one product become one more surface body instead of being dropped. | One diagnostics block that matches the bodies P2 stores (P2 already reads it so); one body per product, nothing silently dropped. |
| 2026-10-01 | KERNEL | `heal`: each output carries its own `history` (+ `faces`, validity); the top-level `history` is replaced by `deleted` (input faces in no output). Sewing runs over all inputs together; `sew: true` = `'auto'` (only faces outside valid closed solids are sewn). Per input the faces left open are one surface body. The STEP name and colour come from the input (`import_step` keeps them with the shape id). | Several outputs cannot share one `out` index space. |
| 2026-10-01 | KERNEL | `press_pull` and `combine`: UnifySameDomain runs on a copy and is checked; when the merged result is invalid and the unmerged one valid it keeps the unmerged one and says `unified: false` (both results add `unified`; `combine.results[]` adds `faces`). `press_pull` takes kernel-only `glue: 'off'|'shift'` and `unify`. | OCCT 7.9.3 merges the Vortex inlet pipe with its press-pulled extension (coincident cylinders, different seams) into an invalid face, natively too; UnifySameDomain also changed its input in place, so the fallback needs the copy. |
| 2026-10-01 | KERNEL | `props` takes `volume_eps` (adaptive integration) and returns `volume_error`. | The default integration is off by ~1.5e-7 on the Vortex (its B-spline faces; native too): §2.5's 1e-9 split sum holds only with `volume_eps`. |
| 2026-10-01 | KERNEL | `sketch_regions` returns `tol`. Key grammar additions: a curve end with no point id and no other curve is `v:<E>#<0|1>`; two split points that would share a name (degenerate overlaps) get `~1`, `~2` in (u, v) order; a circle's own seam vertex is not a split point (OCCT splits a closed edge there; the pieces on both sides are one sub-segment, and `extrude_regions` merges them into one side face). | Names had to exist for every vertex; seam splits would have made keys depend on where OCCT puts a circle's seam. |
| 2026-10-01 | KERNEL | Plan numbers corrected by measurement: §2.4 box 20 top face -5 mm is 20 x 20 x 15 = **6,000** mm³ (not 7,500); §2.5 split sum within 1e-9 only with `volume_eps` (default integration: 1.59e-8, the same natively). | Analytic / native. |
| 2026-10-01 | KERNEL | `split` adds `lost_faces` (input faces in no piece); any loss makes `valid` false with "split lost part of the body: N of its faces are in no piece (OCCT's splitter)", even with `check:false`. | OCCT's Splitter (and a half-space Common, natively too) drops one half of the 113 MB part at its middle X plane without an error: before, `split` returned one valid piece of half the volume. |
| 2026-10-01 | KERNEL | `measure`: a whole body reports volume, area and centroid only when it is the one target (with a second target it is only geometry). | Those integrations take tens of seconds on a large part and a distance needs none. |
| 2026-10-01 | INTEGRATE | `DeleteFacesFeature.repair?` and `SplitFeature.repair?` (`{fuzzy}`), as the other P2 features; `ImportOutput.from: 'brep' \| 'source'`; `ImportDiagnosticsSummary.healedOnRead?`. | P2-FEATURES requests 1, 2, 6: the casts are gone, and a reopened Part still says "Large file: healed while it was read". |
| 2026-10-01 | INTEGRATE | `BodyInfo.solids?` (from `props`): 0 = a surface body. The volume chip says "Surface body: no volume" and leaves surface bodies out of totals; Mass properties too. A Size chip (exact bounding box) sits beside the volume chip. | P2-FEATURES request 9 (an open shell read "8000 mm³"); proposal §7 P2 "the bounding-box chip grows by 10 mm". |
| 2026-10-01 | INTEGRATE | `createDocService({onSolverChange})`: the part rebuilds when the sketch solver starts; a sketch's cache key carries "no solver" while it is not running. | P3-PROFILES request 2 (a sketch built before the solver ran kept its stale shape). |
| 2026-10-01 | INTEGRATE | The Split feature checks `lost_faces` first: red with the kernel's reason, no Try repair. | KERNEL request 4 (it read one piece as "does not cut"). |
| 2026-10-02 | SD (P2/P3 polish) | `ViewportHandle.addLayer(id, {frame})`: `frame` may be a function giving the box that counts (`FrameBox`, model mm), so sketch mode's layer frames the sketch, not its grid; framing takes bodies and sketches together and the origin planes' extent only when neither is drawn; the view's own refits leave the sketch being edited out. `ViewportHandle.reframe()`: the last framing again with what is drawn now, unless the camera moved since. | Review round 4 blocker: a reopened sketch was framed on later bodies the rollback hid (and Fit too); a sketch-only part was framed on the planes. |
| 2026-10-02 | SD (P2/P3 polish) | `ValueBox.along?: [Vec2, Vec2]` (the segment a box measures: the box sits beside it); `Boxes.render(now, at, problems, along)`. | Review round 4: a vertical line's boxes sat on the line. |
| 2026-10-02 | SD (P2/P3 polish) | Combine Intersect with several tools keeps what each target shares with **all** the tools (one extra `combine` call per extra tool, what the tools share first); a Cut or Intersect that leaves a target in more pieces than it had warns "<body> is now in N separate pieces"; the volume chip says "<body> · N pieces". | Review round 4: it was target ∩ (tool 1 ∪ tool 2), with no word of the 2 pieces. |
| 2026-10-02 | SD (sketch-driven + Enclosure) | Box and Cylinder removed (decision 2026-10-01): `BoxFeature` / `CylinderFeature` leave the `Feature` union, `createBuiltinRegistry()` registers nothing, the shell's FeaturePanel and the `solid.box` / `solid.cylinder` commands are gone. A stored `box` / `cylinder` row is kept and rebuilt red, "This part uses a removed feature (Box 1)" (`REMOVED_FEATURE_TYPES`, `src/doc/features/removed.ts`); Delete takes it away. | Daniel's decision: solids come only from sketches and STEP. |
| 2026-10-02 | SD (sketch-driven + Enclosure) | `EnclosureFeature` (`type: 'enclosure'`, schema 2, no migration) and `EnclosureOutput` in `FeatureOutput`; `ModelGroup` `cfd` ("CFD PREP", after construct); `FaceRole` `enclosure` (`F:<id>:enclosure:<side>`, "+X face of Enclosure 1"). | The Enclosure (ARCHITECTURE §10). |
| 2026-10-02 | SD (sketch-driven + Enclosure) | An extrude's reason names the field as its panel does: Two sides "Distance 1: ...", Symmetric "Total distance: ..." (both said "Distance"). | Found rewriting the P1.5 unknown-parameter test on an extrude. |
| 2026-10-02 | SD (Kit) | The host UI kit (`@magnusim/plugin-ui`, host API 1.3; `manifest.toml` `api_version = "1.3"`): `Select` takes `options` and `onChange(value)` (the kit's), `field` / `attrs` for its data-* hooks; `Field` takes a string `label` (and `help`), no `axis`; `DisabledReason` takes a string; `Hint` takes `tone`; `ButtonVariant` adds `fix`, and `buttonClass(variant)` gives a button made outside React the kit's classes. Markup: `mgk-*` classes in place of the core copies (`.mat-panel*`, `.fp-btn`, `.js-btn`, `.mat-clear-link`, `.bc-input`, `.bc-select`, `.mat-assign-hint`, `.sim-run-hint-msg`, `.switch`); tests address `[data-field="op"] select`, `[data-switch="knit"] input`, `.mgk-panel-head`, `.mgk-reason-msg`. 31 `--cad-*` tokens that copied a `--mg-*` one are gone. | Adopt the kit (H14) instead of CAD's copies of the core recipes. |
| 2026-10-02 | SD (review round 1) | `FeatureTypeDef.seeThrough?(f, body)` and `ViewportBody.seeThrough`: a body drawn translucent (no depth writes, polygon offset behind coplanar faces), whose faces a click picks only where nothing opaque is behind; its edges and vertices hide nothing. The Enclosure's body is see-through. | Review round 1: the Enclosure hid the part and z-fought with it at Zero padding. |
| 2026-10-02 | SD (review round 1) | `PanelChrome` `deleteBlock` (the foot says "Delete is off: <reason>" when a later feature uses the feature; `usePanelDeleteBlock`); `NumberUnitInput` `unit` (a plain number's own unit, drawn where a length's unit is); `PickList` / `useBodyField` `empty` (what an empty list means, in the list). Enclosure faces in Measure and pick lists: `naming` `placeWords` ("+Z face of Enclosure 1"); a cylinder about X / Y names its ends `+x-end` / `-x-end`. | Review round 1 polish. |
| 2026-10-02 | SD (review round 1) | The removed-feature row reads "This part uses a removed feature (Box 1)" (`removedFeatureMessage`); Edit and a double-click add "Solids come from sketches now: delete it, then sketch the shape and extrude it". A new Combine whose first target is an Enclosure's body turns Keep the tool bodies on unless the user set it. | Review round 1: the brief's wording; the fluid needs the part kept. |
| 2026-10-02 | SD (review round 2) | `src/lib/pendingEdits.ts`: a `NumberUnitInput` holding typed text it has not applied registers it; the doc service counts it as unsaved work (`nav.setDirty`, "Changes to <Part> are not saved yet.", or "...: the value typed in <field> is not applied. <reason>." for a refused one) and applies it (`commitPendingEdits`) before every save on leaving (pointer out of the frame, frame blur, leave keys, side buttons, pagehide / hidden). | Review round 2 blocker: in real Chrome the frame runs out of process, its field's blur came after the host closed the workspace, and Back dropped the typed value without a word. |
| 2026-10-02 | SD (review round 2) | `FeatureBuildResult` failure may carry `output` (published in `RebuildState.outputs`); a failed Enclosure publishes its bodies and bbox (no box / cylinder). `enclosureShape` failures name their `sides`; `NumberUnitInput` `problem` shows a reason from outside the field under it. One amber note for every side into the part (`[data-side-note]` lists their keys). Escape during an Enclosure or Extrude arrow drag restores the value. The arrow's value uses U+2212. The Delete reason names a body once when it has its feature's name. | Review round 2 polish. |
