# Handoff: STL mesh quality and finished-mesh UI attach

> **Note (2026-09-24):** moved here from the deleted `Magnusim V0.1.1/` folder. The evidence projects and logs it references were deleted with that folder; reproduce by importing the vortex geometry as STL and as STEP in the live app.

> **Status (2026-09-25, "Step 2"):** the STL mesh part is fixed differently from the plan below. A closed STL/OBJ/PLY is no longer an OCC solid of one plane per facet for the mesher:
> - Import groups its facets into surfaces by a 30° feature angle (`cfddesk/cad/face_groups.py`). Those surfaces are the geometry's face ids, e.g. 8 faces for the 24k-facet vortex instead of 24k.
> - The Standard mesher meshes those surfaces as discrete gmsh geometry (`gmsh_standard.import_grouped_triangles`). Beforehand it collapses sliver-cap edges, splits CAD needle strips and flips/smooths them in their plane (`cfddesk/mesh/stl_refine.py`), and merges wall surfaces under half the mesh size into a neighbour. There is no OCC heal, face matching or rollback on this path.
> - Results: every vortex STL meshes (4k to 118k facets, hex core on and off) and checkMesh passes. On the 24k STL: 0-3 faces over 70° and max skewness 3.0-3.6, against the 2053 faces and 17.6 above.
> - The opt-in `e2e/stl-vortex-solve.spec.js` (MAGNUSIM_E2E_HEAVY=1) solves the ports case and checks the flow direction.
> - The finished-mesh UI attach bug below is a separate issue and is not covered by this.

Date of investigation: 2026-09-21. No code was changed. This note is for the maintainer’s agent. Fix both bugs below. Do not treat the STEP mesh as a failed generate, and do not “fix” the STL solve by adding non-orthogonal correctors. The STEP solve is the reference. The STL solve is bad because the mesh is bad.

Geometry is the same vortex body in both projects (SimScale-style cyclone / vortex tube, bounding-box diagonal about 0.92 m). Same air, same pressure ports, same Standard mesh settings, same SIMPLE run. STEP results are a steady through-flow. STL results are unconverged and running the wrong way through both ports.

## Projects (evidence, do not delete)

Both live under `Magnusim V0.1.1/magnusim-web/projects/`.

| | Test STL | Test STEP |
|---|---|---|
| Project id | `test-stl-20260921220303-4000e3` | `test-step-20260921221539-7333ff` |
| Geometry | `geometries/Geometry_Vortex_CFD_Test` | same folder name |
| Source the mesher loaded | `source.step` built from the STL | native `source.step` |
| Mesh | `.../meshes/Mesh_1` | `.../meshes/Mesh_1` |
| Generate log | `magnusim-web/.cache/jobs/snappy/generate-92bb47a3.log` | `magnusim-web/.cache/jobs/snappy/generate-6b2b3821.log` |
| Case log | `Mesh_1/case/log.standard_generate.txt` and `log.gmsh_host.txt` | same names |
| Run | `simulation_runs/Run_1`, id `6296be64` | `simulation_runs/Run_1`, id `d1f3b796` |

CAD face summaries are in each geometry’s `cad_preview.json`. Mesh job records are `Mesh_1/mesh.json`. Solver excerpts are in each `Run_1/run.json` (`log_excerpt`).

## Shared setup (these are not the bug)

Both simulations:

- Incompressible, steady, `simpleFoam`, k-omega SST, 200 iterations, `writeInterval` 50.
- `n_non_orth_correctors`: 0. Leave this. It is fine on the STEP mesh.
- Air: density 1.196 kg/m³, kinematic viscosity 1.529e-5 m²/s.
- Pressure 1: fixed 0 Pa. Pressure 2: fixed −15000 Pa.
- Those values are written to OpenFOAM as kinematic pressure. Both logs show `areaAverage(pressure_2) of p = -12541.806` because 15000 / 1.196 ≈ 12541.8. The BCs match.
- Standard mesh, fineness 5, automatic sizing, physics-based meshing on, hex element core on, 3 boundary layers, gap refinement factor 0.05, gradation 1.22.
- Surface size about 0.006033 m. Small-feature suppression length about 9.2e-5 m (`_SFS_PER_DIAG = 1e-4` times the 0.92 m diagonal). Layer thickness about 0.00241 m.

The two pressure ports are the same physical openings. Face ids differ only because the STL grouping numbers faces differently.

| Port | STL face | STEP face | Area | Centroid (mm) | Normal |
|---|---|---|---|---|---|
| Pressure 1 (0 Pa) | face 2 | face 10 | ~2012–2027 mm² | (127, 93.9, 279.4) | (1, 0, 0) |
| Pressure 2 (−15 kPa) | face 8 | face 13 | ~2012–2027 mm² | (0, 0, 304.8) | (0, 0, 1) |

## What the two solves actually produced

Iteration 200, from the run `log_excerpt` fields.

Test STEP (good):

- `pressure_1` velocity (−97.21, 0, 0) m/s. Face normal is +X, so this is inflow at 97 m/s.
- `pressure_2` velocity (1.32, −2.17, 97.31) m/s. Face normal is +Z, so this is outflow at 97 m/s.
- Continuity: sum local 0.029, global about 4e-5, cumulative about 1e-4.
- `limitVelocity` limited 0 cells.
- Residuals: U about 0.004, Uz 0.013, p about 0.022.

Test STL (bad):

- `pressure_1` velocity (26.91, −1.96, −6.64) m/s. Dot with the +X normal is about +27, so the 0 Pa port is an outflow, and the vector is not even normal to the port. The value was still swinging (about 30 m/s, then 29, then 27).
- `pressure_2` velocity (−0.47, 0.05, −26.12) m/s. Dot with the +Z normal is about −26, so the −15 kPa port is an inflow.
- Continuity: sum local 0.78, global 0.022, cumulative −0.12.
- `limitVelocity` limited about 350 cells every iteration, cap 1583.78 m/s.
- Residuals: Ux 0.26, Uy 0.15, Uz 0.11, p about 0.10. Not converged.

Flow must enter the 0 Pa port and leave the −15 kPa port at the same speed. STEP does that. STL is reversed, about a quarter of the speed, and still moving when the 200 iterations end.

## Why the STL mesh is the cause

`checkMesh` on the STEP mesh: Mesh OK. 9 faces over 70° non-orthogonal, max skewness 3.91, max aspect ratio 120, minimum cell volume 3.4e-11 m³. Layers reached 97.5% of target thickness on 99.9% of wall faces. 677,780 cells.

`checkMesh` on the STL mesh: failed (1 highly skew face). 2053 faces over 70° non-orthogonal, max skewness 17.57, max aspect ratio 713, minimum face area 1.5e-10 m², minimum cell volume 1.4e-15 m³. Layers reached 83.8% of target and were dropped on about 10% of wall faces (70241 of 78012 faces extruded). 740,478 cells. snappy reported 3174 illegal faces during layer addition.

Zero non-orthogonal correctors can live with 9 bad faces. It cannot live with 2053. Those cells hit the velocity limit every iteration, SIMPLE never settles, and the field at iteration 200 is not a physical solution. Do not paper over this in the solver.

### What the STL solid actually is

`cad_preview.json`:

- STEP: 17 analytic faces (cones, cylinders, a torus, B-splines, planes), 34 edges. `tessellated: false`.
- STL: 21 planar groups, 3619 edges, 331 edge polylines, 2780 display triangles. Grouping is `cfddesk/cad/face_groups.py` (`FEATURE_SPLIT_ANGLE_DEG = 30`). Analytic STEP faces are left alone. An STL becomes one triangle per original facet, then neighbors within 30° share a selectable face id.

The nozzle, around z = 256–305 mm, is a cluster of sliver faces. Areas in mm² from the STL preview:

- face 17: 0.39, centroid about (5.3, 117.6, 270.4)
- face 18: 0.00, centroid about (2.3, 118.1, 271.9)
- also faces 3, 4, 9–13, 16, 19–21, areas from 0.01 to 8.4 mm², same neighborhood

Face 18 is degenerate. Faces 17 and 18 are the two ids in the mesher log.

Import already tries to drop unreadable triangles in `cfddesk/cad/io.py`, `_stl_without_slivers`. The cutoff is `10 * Precision.Confusion` on edge length, about 1e-6 in file units. The file is in millimetres, so that cutoff is about a millionth of a millimetre. The nozzle slivers are larger than that, so they become real CAD faces.

### The mesher builds a clean solid and then discards it

Pipeline is `cfddesk/mesh/standard_hexcore.py`, `generate_standard_mesh` (the `_import` closure around the `healShapes` call).

1. Import the STEP with `Geometry.OCCScaling` so the model is in metres.
2. If the suppression length is > 0, call `gmsh.model.occ.healShapes` on the volumes with `tolerance=heal_tol`, `fixDegenerated=True`, `fixSmallEdges=True`, `fixSmallFaces=True`, `sewFaces=False`, `makeSolids=False`.
3. Delete orphan surfaces that healing left behind (surfaces no longer bounding a volume).
4. Call `_match_occ_surfaces` in `cfddesk/mesh/gmsh_standard.py`. That requires every emitted CAD face id to match a Gmsh surface (centroid within `max(0.02 * diagonal, 2 * h, 1e-4)` metres, area within 25%, then a nearest-centroid fallback).
5. On any exception, if suppression was requested, log `small feature suppression skipped (...)`, `gmsh.model.remove()`, and import again with heal tolerance 0.

Observed logs:

- STEP generate `6b2b3821`: `removed 10 orphan surface(s)`, then `small feature suppression: features below 9.2e-05 m suppressed`. Surface mesh 58,482 triangles in 2.6 s. No gap-refinement line. Volume error 2.55e-4. Mesh OK.
- STL generate `92bb47a3`: `removed 70 orphan surface(s)`, then `small feature suppression skipped (Standard mesh: failed to match 2 CAD face(s) to gmsh surfaces (tol=0.0184 m). Missing face_ids: 17, 18)`. Surface mesh 78,590 triangles in 26.6 s, then `gap refinement: 43 surface triangles refined (factor 0.05)`, 78,732 triangles. Volume error ~0 (it matches the dirty CAD). This is the mesh that was solved.

Healing removed faces 17 and 18, which is what suppression is for. They are default wall faces, not the pressure ports. `_match_occ_surfaces` still demands every face id in `face_to_patch`, including those two, so it raises. The `except` treats that as a failed heal and remeshes the raw STL. The slivers stay.

Gap refinement then makes them worse. `_gap_sizes` in `standard_hexcore.py` finds opposing triangles closer than `gap_factor * h` (0.05 * 0.006033 m ≈ 0.30 mm) and sets their size to `gap_thickness / gap_factor`. A hairline crack between slivers is treated as a real gap. That is the 43 refined triangles and the 10⁻¹⁵ m³ cells. The STEP mesh never entered this path.

`sewFaces=False` on the heal call leaves the cracks between STL facets open, which is what gap refinement then measures.

The STL will still be faceted where the STEP has cones and a torus. A correct mesh will not reproduce the STEP velocity to the last metre per second. It should be a closed mesh that `checkMesh` accepts, with inflow at the 0 Pa port, outflow at the −15 kPa port, and a speed of the same order as 97 m/s.

## Fix the mesher (required)

Keep the healed solid when the only unmatched faces are ones suppression removed.

In the `_import` / `try` / `except` block in `standard_hexcore.py`:

- Do not roll back the whole heal because `_match_occ_surfaces` cannot find a face that `healShapes` deleted.
- A missing face may be ignored when its CAD area is below the suppression scale (edge or `sqrt(area)` below `small_feature_m`, with a small margin) and it is not an explicit user BC port. Faces 17 and 18 qualify: they are walls, and they are far below 9.2e-5 m. The pressure faces (STL 2 and 8, STEP 10 and 13) must still match. If a pressure face is missing, fail as now.
- Map the surfaces that remain. Orphan removal already drops surfaces that do not bound the volume. Do not require a Gmsh tag for a suppressed face id.
- Log that those face ids were suppressed, instead of `small feature suppression skipped` followed by a full reimport.
- Only reimport with heal tolerance 0 when healing itself fails, or when a face that must survive (a BC port, or a face larger than the suppression length) cannot be matched.

Also:

- In `_gap_sizes`, ignore gaps thinner than the suppression length. A crack of a few microns is a tessellation defect. Dividing it by 0.05 is what forces the tiny cells. Pass `small_feature_m` in, or skip pairs whose separation is below that length.
- Call `healShapes` with sewing enabled at the same suppression tolerance (`sewFaces=True`, or an equivalent sew before heal). That closes the cracks gap refinement is measuring. Do not sew at a tolerance large enough to move the pressure ports or the real nozzle. The existing suppression length is the right scale.
- Optional backup, in `_stl_without_slivers`: the edge cutoff `10 * Precision.Confusion` does not see these slivers. Dropping triangles whose edges or area are below the suppression length, in part units, stops them becoming CAD faces the matcher has to find. Do this in addition to keeping the healed solid, not instead of it. The rollback is what made this mesh bad.

After the change, regenerate Test STL with the same settings (fineness 5, hex core, 3 layers, physics-based, gap factor 0.05). Expect the log to say suppression stayed on, no “Missing face_ids: 17, 18”, and no gap refinement of dozens of sliver triangles. `checkMesh` should look like the STEP mesh: on the order of tens of non-orthogonal faces, skewness under about 4, aspect ratio on the order of 100, no 10⁻¹⁵ m³ cells. Then a 200-iteration `simpleFoam` run should show inflow at pressure 1 and outflow at pressure 2.

Do not change `n_non_orth_correctors`. Do not special-case this project id. The same rollback will hit the next STL that has a sliver smaller than the suppression length.

## Fix the finished-mesh UI attach (required)

The STEP mesh did finish. The UI did not update. Separate bug from the STL mesh.

STEP generate `6b2b3821` ended `ok: true`, 677,780 cells, 296,104 points, exit code 0, `finished_at` 2026-09-21T22:17:15Z. `Mesh_1/mesh.json` has `generated: true`, `live_mesh_result.status: "done"`, `error: null`. `checkMesh` said Mesh OK.

About six minutes later something attached that same mesh case folder. `GET /api/case?project_id=test-step-20260921221539-7333ff` then returned:

- `status: "attached"`
- `mode: "attach-only"`
- `mesh_id: null`, `generate_id: null`, `kick_id: null`, `path_kind: null`
- `n_cells: null`, `n_points: null`, `n_faces: null`
- `attached_at: "2026-09-21T22:23:49.481Z"`
- `case_dir` equal to the finished STEP `Mesh_1/case`
- note text: `W15/W15.1: attached existing case_dir; ... Attach path unchanged.`

The client copies that snap in `attachCaseDirClient` (`src/workbench/runtime.js`): `jobState.status = "attached"`, `path_kind = null`, `kick_id = null`, and `stopJobPoll()`. The mesh panel never receives “done” or the cell count from that attach, and the viewport stays on the CAD model.

### Why the attach drops the mesh fields

`attachCaseDir` in `scripts/vite-plugin-case-fields.js` only copies mesh metadata when `readActiveProjectMeshDoc().doc.live_mesh_result` exists, `status === "done"`, and `live.case_dir` string-equals the attached folder. On a match it would set `status: "done"`, `mode: "mesh"`, `path_kind`, `generate_id`, `kick_id`, and the cell counts.

`readActiveProjectMeshDoc` calls `assembleMeshDoc(id, sim.id)` with no mesh id.

`assembleMeshDoc` / `assembleMeshDocAt` in `scripts/study-io.js`:

```js
const want = wantId != null && String(wantId) !== '' ? String(wantId) : '';
const active = want ? meshes.find((m) => String(m.id) === want) || null : null;
// ...
live_mesh_result: active ? active.live_mesh_result || null : null,
```

With no mesh id, `active` is null, so `doc.live_mesh_result` is null even when `doc.meshes` contains the finished mesh. The `if (live && live.status === "done" && ...)` block never runs. Every attach of a finished mesh case becomes a bare attach.

The path compare in that block is also a no-op: `.replace(/\\\\/g, '\\')` looks for two backslash characters. Windows paths have one. Compare with a normalized path (`resolve` + case-fold, or replace both `/` and `\\`) so a forward-slash client path still matches.

### What to change

When attaching a case directory, find the mesh whose `live_mesh_result.case_dir` (or `case_dir`) is that folder. `doc.meshes` from `assembleMeshDoc` already has those entries; use that list, or pass the mesh id into `assembleMeshDoc`. If that mesh is `done`, set the case snap the way the existing `meshExtra` block intends: `status: "done"`, `mode: "mesh"`, `path_kind`, `mesh_id`, `generate_id` / `kick_id`, `n_cells`, `n_points`, `n_faces`, `mesh_path`.

`attachCaseDirClient` must not wipe a finished mesh into `path_kind: null` and stop the poll before those fields are applied. After a successful generate, the panel should show the cell count and the viewport should be able to load the mesh surface.

There is a second gate in the generate-done poll in `runtime.js` (`startJobPoll`, the block that calls `showMeshInspect`). It only opens the mesh view when `stillOnThatMesh` is true: mesh inspect already open, or the tree panel is `mesh` / `mesh1`, or the selection is `meshid:<id>`. If the user is still looking at the CAD body when the job finishes, the 3D view stays on the CAD even after the job state is correct. Opening the finished mesh when the generate that just ended is the one on screen is part of “the UI updated.” Do not require the user to re-select the mesh.

`liveMeshForOpenProject` in the same file already knows how to pick a mesh out of `doc.meshes`. `readActiveProjectMeshDoc` does not. Do not “fix” this by marking the STEP job failed. The mesh on disk is valid.

### Do not chase this red herring

STEP `mesh.json` `fingerprint_after.n_cells` is 10 while `n_cells` is 677,780. `read_polymesh_counts` in `cfddesk/mesh/snappy_hexdominant.py` reads `constant/polyMesh/owner` as text. That file is binary, so the parsed cell count is garbage. The real count is in `w21-counts.json` and in `live_mesh_result.n_cells`. This did not cause the blank UI. Fix it only if you are already in that parser. Do not use `fingerprint_after.n_cells` to decide whether a mesh exists.

## Files

- `magnusim-web/python/cfddesk/mesh/standard_hexcore.py` — heal, suppression rollback, `_gap_sizes`, surface mesh.
- `magnusim-web/python/cfddesk/mesh/gmsh_standard.py` — `_match_occ_surfaces`, `_assign_faces_to_surfaces`, `_cad_match_targets`.
- `magnusim-web/python/cfddesk/cad/io.py` — `_stl_without_slivers`, `_load_stl`, `heal_to_solid` (sew tolerance 1e-6, separate from the Gmsh heal).
- `magnusim-web/python/cfddesk/cad/face_groups.py` — STL triangle grouping, 30°.
- `magnusim-web/scripts/vite-plugin-case-fields.js` — `readActiveProjectMeshDoc`, `attachCaseDir`, `caseSnapshot`.
- `magnusim-web/scripts/study-io.js` — `assembleMeshDoc` / `assembleMeshDocAt`.
- `magnusim-web/src/workbench/runtime.js` — `attachCaseDirClient`, `startJobPoll` generate-done path, `showMeshInspect`, `isGeneratedMeshReady`.
- `magnusim-web/src/workbench/jobQueueOrder.ts` — `snapMatchesLiveMeshJob`. A `/api/case` snap with no `mesh_id` and no `kick_id` does not match a live generate, so the poll will not finish the job from that snap. The mesh-list fallback can, but the attach path stops the poll first.

## Acceptance

1. Regenerating Test STL at fineness 5 keeps small-feature suppression on. The log does not say it skipped faces 17 and 18. `checkMesh` does not report a skew face above about 4, and minimum cell volume is not near 1e-15 m³.
2. A 200-iteration run on that mesh has inflow on pressure 1 and outflow on pressure 2, with continuity sum local on the order of the STEP run (hundredths, not ~1) and the velocity limiter not firing hundreds of cells per iteration.
3. Regenerating Test STEP still suppresses small features, still matches faces 10 and 13, and still `checkMesh` OK. Do not break the analytic STEP path while fixing the STL rollback.
4. When a finished mesh case is attached, `/api/case` returns `status: "done"`, the mesh id, `path_kind: "standard"`, and the real cell count. The workbench shows that count without a reload dance, including when the user was looking at the CAD body during generate.
