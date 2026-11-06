# The validation set

Textbook flows with published answers, run through the app itself and compared with their
reference values. The report is `VALIDATION.md` here and the public page in
`docs/validation/` at the repository's root (built, not published: publishing is turning on
GitHub Pages for `docs/` and a push).

```bash
npm run test:validation                                   # every case and variant, then the report
npm run test:validation -- --case c1 --variant standard --cores 4
npm run test:validation -- --coarse                       # coarse runs into results-coarse/ (not committed)
npm run test:validation -- --case c1 --mesh-only          # a mesh probe: mesh and its facts only (results-probe/)
npm run test:validation -- --case c1 --variant standard --mesh '{"hex_element_core":false}'
                                                          # mesh settings changed by hand (results-probe/)
npm run test:validation -- --case c1 --variant standard --study '{"grad_limiter":"none"}'
                                                          # study settings changed by hand (results-probe/)
npm run validation:report                                 # VALIDATION.md and docs/validation/ from results/
npm run validation:report -- --check                      # exit 1 when they are out of date
```

It needs WSL with OpenFOAM v2606 (the app's Setup). `MAGNUSIM_E2E_PORT` picks the app
server's port; `MAGNUSIM_E2E_LOCK=0` runs it beside another WSL test run (keep `--cores` low
then). No default browser suite and no CI job runs it (`scripts/e2e-suites.mjs`); the harness's
own tests run in `npm run test:py` (`tests/`) and `npm run test:server`
(`scripts/__tests__/validation-driver.test.mjs`).

## How one run goes

1. **Plan** (`python -m magnusim_validation plan <case> <variant>`): the case's geometry as
   a STEP in mm (OCP), its face table as the app numbers it, the face selectors resolved to
   labels, and every request the run sends, in `results/<case>/<variant>/plan.json`. A
   Hex-dominant plan also says what its mesh will be (`mesh.estimate`, `mesh_plan.py`, from the
   mesher's own sizing functions): the background block, the wall cell on each axis, each
   custom size's level, the layer stack against the wall cell and a rough cell count. The
   driver refuses to Generate a plan estimated over `MAGNUSIM_VALIDATION_MAX_CELLS` (2 000 000).
   Only a full run of the case's own settings goes to `results/`; a coarse run goes to
   `results-coarse/`, a mesh-only run or one with mesh or study settings changed by hand to
   `results-probe/`, and the report never reads either.
2. **Drive** (`e2e/driver.mjs`, from the opt-in spec `e2e/validation.spec.js`): the plan sent
   to a real app server over the routes the page and the Assistant use: project, STEP upload,
   the face table checked against the plan's, study, fluid, BCs, mesh and refinements,
   Generate, run settings, the Start gate, the pre-run check, Start, then monitors, run
   health, the solver log, the saved times and Plot over path. Every write is read back;
   every answer is saved in `raw/` (not committed).
3. **Evaluate** (`python -m magnusim_validation evaluate <dir>`): first the values no route
   gives, read from the run's case folder while it is there (`sampling.py`: cell values by
   the app's own volume loader, or a line sampled as Plot over path samples it with a
   vector's components kept, `app_sampling`; a patch field the run saved, `case_file`),
   kept in `raw/sample_<key>.json`; then `result.json`, the
   compared values with their source (`route:<path>`, `app_sampling`), how each was measured, its reference
   with the citation, the error and the proposed band; the mesh (cells, checkMesh, wall
   layers asked and applied: RH2's mesh facts), the pre-run check, the run (iterations,
   convergence, time, ranks, numerics as written) and its health (RH1); the app's commit,
   OpenFOAM's version and WSL's load. A run that cannot produce its numbers (a setup the app
   refuses, a mesh or solve that fails, layers asked and not applied) fails the test, and so
   does a steady run that stops at its iteration limit while its monitors still move
   (`not_settled`: more than the case's `SETTLE_DRIFT` over the last 10 % of iterations), and
   a transient run whose periodic signal never settles within it (`not_settled`: case 5's
   shedding, `extract.settled_window`).
4. **Report** (`python -m magnusim_validation report`): `VALIDATION.md`, `docs/validation/`
   (`index.html`, `results.json`) and the figures (`docs/validation/img/`, matplotlib), with
   Heat Transfer's own validation set after the cases (`heat_transfer.py`: its committed
   `bundled-plugins/heat_transfer/validation/results.json`, not run again; its runs go through
   the plugin's own Python path, not the app's routes, and the report says so).

Two variants of a case may share a mesh (`MESH_FROM`: case 2's k-epsilon run on its k-omega
SST run's mesh). The plan carries a hash of its geometry, fluid, BCs and mesh (`mesh_key`);
the driver reuses the earlier run's mesh only when that run is beside it with the same key
and its project is still on the server, and otherwise meshes its own.

## Files

| Path | What it is |
|---|---|
| `magnusim_validation/cases/` | One module per case: geometry, face selectors, requests per variant, references with citations, tolerances, extraction, figures |
| `magnusim_validation/model.py` | References, tolerances, the comparison (report-only until locked) |
| `magnusim_validation/geometry.py`, `faces.py`, `plan.py` | The STEP, the app's face table and selectors, `plan.json` |
| `magnusim_validation/evaluate.py`, `extract.py`, `result.py` | `result.json` and its checker, the numerics |
| `magnusim_validation/sampling.py`, `mesh_plan.py` | Reads of the run's case folder; what a Hex-dominant plan's mesh will be (one cell across too) |
| `magnusim_validation/refs.py`, `refs/*.csv` | Reference tables, each with its citation, where in the source, conditions, kind and confidence in its header |
| `magnusim_validation/heat_transfer.py` | Heat Transfer's own set on the report and the page |
| `magnusim_validation/report.py`, `site.py`, `plots.py` | `VALIDATION.md`, the public page, the figures |
| `e2e/driver.mjs`, `e2e/validation.spec.js`, `playwright.config.js` | The HTTP driver and the opt-in suite (only the bundled plugins load) |
| `results/<case>/<variant>/` | `plan.json` and `result.json` of the committed runs |
| `tests/` | pytest of the harness (no WSL) |

## Rules

- A value is what the app produced through its own routes; nothing is tuned per case and no
  number is typed in. Every compared value names its source and how it was measured.
- Every reference carries its citation (authors, year, journal, the table, figure or
  equation) and the conditions it holds for, with how it was checked (CONFIRMED, SECONDARY).
  The values and bands come from the reference-data check of 2026-11-04 (each value's
  source read, or two transcriptions compared); where the harness's design proposed other
  bands, the reference data win.
- Report-only until the first full run is reviewed; then the tolerances are locked
  (`Tolerance(locked=True)`) and a locked quantity outside its band fails the run.
- Hex-dominant for every case; the two pipe cases on Standard as well. Where layers are asked
  the run asserts they were applied.

## Before the next cases

What the reference data set for cases 2 to 6, where it differs from the first plan of them,
and what the app lacks for them. Each case module carries its own references and bands with
their citations; this list is what those modules must start from.

| Case | What the reference data set |
|---|---|
| 2, turbulent pipe, Re 5e4 | Built (`c2_turbulent_pipe.py`). f = 0.0211 (McKeon et al. 2005, eq. 3.5), band ±10 % with wall functions (±5 % if y+ < 1). The reference data ask for f at least 40 D from the inlet (turbulent development is about 20 D), or a cyclic or mapped inlet. This case meets neither: the app has no cyclic inlet (G9) and Hex-dominant cannot mesh a pipe much longer than 30 D cleanly (below), so the pipe is 30 D and f is read over x/D 20 to 25, with the slope over 15 to 20 beside it; a run whose two differ by more than 1 % carries a warning (still developing there, f above its developed value). |
| 3, lid-driven cavity, Re 100 and 1000 | Built (`c3_lid_cavity.py`, one cell across). Ghia et al. (1982) Tables I and II (`refs/ghia_1982_*.csv`, with the one correction at x = 0.9063, Re 1000: -0.51550); extrema within 3 % of Botella and Peyret (1998, `refs/botella_peyret_1998_extrema.csv`), the profiles' largest difference at most 0.03 U, the primary vortex centre within 0.01 L and psi_min within 2 % of Marchi et al. (2009, `refs/marchi_2009_vortex.csv`). |
| 4, backward-facing step | Built (`c4_backward_step.py`, one cell across). Re_D 100 on Armaly et al.'s expansion ratio 1.942 against their Fig. 14, x1/S = 3.00, ±10 % (the flow turns three-dimensional near Re 400, so not the design's Re 389; `refs/armaly_1983_fig14_x1.csv`); Re_D 800 on expansion ratio 2 against Gartling (1990), x_r/S = 12.20, ±7 %, and the top wall's bubble (9.70 and 20.96 S, ±10 %; `refs/gartling_1990_re800.csv`), the literature's scatter beside it (`refs/bfs_re800_scatter.csv`); the outlet 30 H after the step; a uniform inlet with an upstream channel of 10 h or 10 H (no profile inlet). Read from the wall shear stress the run saved on the floor and the top, U_x 0.02 S from the wall as the cross-check. Re_D 800 solves with SIMPLEC: with SIMPLE it never settled. |
| 5, cylinder | Built (`c5_cylinder.py`, one cell across). Re 20 and 40 steady against Cd 2.02 and 1.50 and L/D 0.93 and 2.24 (±5 %, `refs/cylinder_re20_re40.csv`; the literature's spread in `refs/cylinder_steady_scatter.csv`); Re 100 transient against St 0.164 (±3 %), the mean Cd 1.33 (±5 %), CL rms 0.23 (±15 %) and the mean L/D 1.41 (±10 %, as information; `refs/cylinder_re100.csv`, `refs/cylinder_re100_scatter.csv`). The domain the reference data ask for: 40 D wide (blockage 2.5 %), 15 D upstream and 30 D downstream, one Freestream round it; a Forces monitor on the cylinder with the study's reference values; 300 D/U of run, the shedding read by the harness over whole periods after the transient (at least 20; G8). How much a coarser and a finer mesh (the probes of 2026-11-06) move the reported values: the case's notes in `VALIDATION.md`, worked out from its results. |
| 6, sphere, Re 100 | Built (`c6_sphere.py`, 3D). Cd 1.09 ±5 % (the mean of the Schiller-Naumann and Clift, Grace & Weber correlations, 1.0917 and 1.0870; Johnson & Patel's computed 1.08 beside it; `refs/sphere_re100_cd.csv`) and L/D 0.88 ±7 % (Johnson & Patel, Taneda's measured 0.89 beside it; `refs/sphere_re100.csv`), the literature's spread in `refs/sphere_re100_scatter.csv`; the separation angle read from the wall shear stress the run saved and shown without a band. The box the reference data ask for: 15 D to each side and 15 D downstream (upstream the design's 8 D), one Freestream on all six sides; a Forces monitor on the sphere with the study's reference values (area pi D² / 4). Hex-dominant at fineness 4 with three custom sizes on the sphere, each with a Refine out to (D/32 out to 0.25 D, D/16 out to 1.5 D, D/8 out to 3 D: cells of D/42, D/21 and D/10.5) and 4 wall layers, 0.06 D in all, asserted applied. How much fineness 3 and 5 with the same sizes (the probes of 2026-11-06) move Cd and L/D: the case's notes in `VALIDATION.md`, worked out from its results (L/D grows towards a finer mesh). |

App gaps found so far, and what they block:

- **Closed domain** (case 3), fixed: a moving or rotating wall counts as what drives the flow,
  no pressure boundary is asked for when nothing flows in or out, the SIMPLE and PIMPLE
  dictionaries carry `pRefCell 0; pRefValue 0;` (read only when no boundary holds the
  pressure), and the case's speed is the wall's
  (`bundled-plugins/incompressible_flow/e2e/closed-domain.spec.js`, `tests/test_closed_domain.py`).
- **Signed profiles** (cases 3 to 6): Plot over path gives a vector's magnitude only; the
  harness reads cell values with the app's own loader (`sampling.cells`) or samples a line as
  the route does with the components kept (`sampling.line`, checked against the route's own
  program in `tests/test_sampling.py`, and against its answer in every cavity run).
- **Long thin parts on Hex-dominant** (case 2): its background block keeps at least 8 and 12
  cells across the part's two small axes while its cells along the long one grow with the
  length, so the cells near the wall come out long and flat. A 55 D pipe at fineness 6 had
  25 196 faces over 65 degrees non-orthogonal before snapping and failed checkMesh (8 cells
  of negative volume) although Generate finished; a 40 D pipe at fineness 7 kept 0.03 of its
  two wall layers. A 30 D pipe at fineness 6 meshes (its worst face at 65 degrees). In 2D
  (case 4, a channel 35 to 40 times longer than high) the same rule keeps 8 background cells
  across the height while the cells along it come from the diagonal: 5 to 6 times longer than
  high at fineness 5 (54 × 8), 1.7 to 1.9 at fineness 10 (170 × 8), so the step meshes at
  fineness 10, and both meshes pass checkMesh (their worst faces in `VALIDATION.md`). The smallest fix:
  size the background block's cells from the smallest of the part's extents (or keep them
  square) instead of a fixed minimum count across it.
- **Point probes**, fixed: they read the value at the point (`interpolationScheme cellPoint`),
  not the value of the cell that holds it.
- **Refine out to** (cases 4 to 6), added: Surface custom sizing's "Refine out to" keeps the
  faces' size out to a distance from them on Hex-dominant (Standard and cfMesh say they ignore it;
  `e2e/mesh-refine-reach.spec.js`, `python/tests/unit/test_refine_reach.py`); `mesh_plan.py` counts
  its band. There is still no box refinement: a band is a distance from its faces, so case 5's
  wake is refined by three rings round the whole cylinder (upstream too), cheap in 2D (about
  71 000 cells), dearer in 3D: case 6's near-wake band (D/21 out to 1.5 D) is a spherical shell of
  about 290 000 of the mesh's about 670 000 cells, half of it upstream of the sphere's centre, where
  a box along the wake 2.5 D long and 1.5 D across at the same size would be about 51 000, or
  could be a level finer for about 410 000. The sphere's recirculation length is the value
  the mesh moves most (below). The smallest fix: a box (region) refinement with a size, in the
  Mesh panel's refinements beside Surface custom sizing, and in the Assistant's.
- **The sphere's recirculation length** (case 6): Cd is converged in the mesh (1.0914, 1.0925
  and 1.0929 on 326 107, 669 786 and 1 359 124 cells: fineness 3, 4 and 5 with the same custom
  sizes, the probes and the first full run of 2026-11-06), the length behind it is not quite:
  L/D 0.8487, 0.8573 and 0.8636, still growing by 0.7 % at the finest step, about 2.6 % under
  its reference on the first full run's mesh (inside its ±7 %). The case's notes work these
  out again from the reported run. A finer wake costs a whole shell round the sphere (Refine out to, above); the run at
  fineness 5 took 1009 s on 4 cores. Not a bug: recorded with its numbers.
- **A one-cell 2D slab** (cases 3 to 5), added: Hex-dominant's "One cell across (2D)" meshes
  a slab whose two end faces carry a Symmetry one cell deep (`cfddesk/mesh/two_d.py`; the panel's
  note and Generate say why a part can't be; `e2e/mesh-one-cell-across.spec.js`,
  `python/tests/unit/test_two_d_mesh.py`). Without it Hex-dominant puts at least 8 cells across
  y and 12 across z, refined near every surface, so a slab costs millions of cells. Its two ends
  are solved empty, fixed after case 3's first runs: as mirror planes OpenFOAM still solved the
  velocity across the depth, whose residual (0.035 to 0.068) never settled, so a steady run never
  met its targets and Run health said the U residual had stopped falling
  (`bundled-plugins/incompressible_flow/tests/test_two_d_solve.py`, the WSL test of
  `e2e/mesh-one-cell-across.spec.js`).
- **A custom size's level** comes from the diagonal's base size while the block's cells on a
  thin axis are smaller, so on a thin part the cells come out finer and flatter than asked
  (`mesh_plan.py` shows it before Generate).
- **No profile inlet** (case 4, G10): the step needs an upstream channel (10 h at Re_D 100,
  10 H at 800); the profile it delivers at x = -1 h is within 0.011 and 0.014 U_b of the
  parabola (shown with each run). The smallest fix: a "Profile: developed (parabolic)" choice
  on Velocity inlet for a flat rectangular or circular face.
- **SIMPLE at Re_D 800** (case 4): with the default SIMPLE (0.7 / 0.3) the step's coarse run
  never settled (a wave train along the channel, the U residual flat near 0.05; Run health
  said the pressure residual had stalled); the study's SIMPLEC setting met its targets in
  1131 iterations on the same mesh. Not an app bug: Run health read it right and the setting
  is there; the case uses it and says so.
- **No mean or frequency over a time window** (case 5, G8): the app's Graphs show a monitor's
  history only, so the harness reads the shedding from the Forces monitor's history
  (`extract.settled_window`, `spectrum_peak`, `time_mean`, `time_rms`, tested on synthetic
  signals in `tests/test_extract.py`). The smallest fix: "mean, rms and frequency over a time
  window" on a Graphs card (and the Assistant's monitors tool).
- **A Freestream all round a body**, fixed: its flow monitor reads the net flow through it, which
  is the solve's round-off (-3.9e-13 m³/s on the cylinder at Re 20), and the Graphs panel's flow
  balance read "Flow in 3.910e-10 L/s · out 0 L/s · imbalance 100.00 %", as a warning, for a
  flow that loses nothing. When every monitored opening's mean normal velocity is at most a
  millionth of its mean speed, nothing flows through them and there is no balance line; when one
  carries flow, every one counts as it reads, since a large far field's real outflow (a jet's,
  leaving through it) is as small against its own speed (a first version of the fix took each
  such boundary as carrying nothing, and a jet into a Freestream box read "imbalance 100 %").
  Only openings count (inlets, outlets, pressure boundaries, freestreams): an Area average on the
  body's faces monitors its wall's patch too, and that wall (no flow, not read as round-off) made
  the far field's round-off count again, "imbalance 100 %" (found in review,
  fixed 2026-11-06); an opening at rest (a 0 m/s inlet) carries no flow either
  (`incompressible_flow.results.round_off_flow`, `is_opening`,
  `bundled-plugins/incompressible_flow/e2e/freestream-balance.spec.js`, `tests/test_results.py`).
- **Before you start on a Freestream** (cases 5 and 6), fixed: the case's speed took a
  Freestream's only above 1 m/s, so a 1 m/s stream round a body read "No time-step estimate: no
  inlet speed or pressure difference sets a flow speed" with no Re, and below 1 m/s the case
  (its starting turbulence, its velocity limit, the time step and a blank reference speed, so
  the force coefficients) used 1 m/s. The stream's own speed is the case's now, and Re is on the
  study's reference length when it has one, the body's (`incompressible_flow.writer.reference_speed`,
  `precheck.check_inputs`, `bundled-plugins/incompressible_flow/e2e/freestream-precheck.spec.js`,
  `tests/test_if_precheck.py`).
- **Re on a 2D mesh** (case 4), fixed: Before you start took the inlet's hydraulic diameter as the
  circle of its area, which on a mesh one cell across grows with the arbitrary depth: the step
  read "Re ≈ 55" at Re_D 100 and "Re ≈ 450" at 800, and a deeper slab could read as turbulent.
  On a mesh one cell across it is a 2D channel's now, twice the inlet's height in the plane
  (`precheck.check_inputs`, `e2e/mesh-one-cell-across.spec.js`, `tests/test_if_precheck.py`). A
  wide rectangular inlet in 3D still takes the circle of its area (Armaly's real 18:1 channel at
  Re_D 800 would read Re ≈ 2 700 and a laminar warning): the smallest fix is 4A/P with the face's
  perimeter from its CAD edges (the mesher's feature sizing reads them; the run's face table does
  not carry them yet).
- **Standard's laminar friction** (case 1): the friction factor on Standard reads well above
  the exact value and the wall shear stress the run saved carries the same excess, so it is
  the solution, not the reading. Probes changing one setting at a time
  (`--mesh '{"hex_element_core":false}'`, `--mesh '{"automatic_boundary_layers":false}'`,
  `--mesh '{"fineness":8}'`, `--study '{"grad_limiter":"none"}'`,
  `--study '{"momentum_convection":"first_order"}'` and `"second_order_limited"`) point at
  the momentum convection scheme's numerical diffusion on Standard's cells, which are not
  aligned with the flow (a cell Péclet number U h / nu of order 10 here): first-order
  convection makes it much worse, a finer mesh helps only slowly, and the gradient limiter,
  the hex core and the layers do not explain it. Under investigation; case 2's Standard runs
  are in the set beside it, read the same way.

Mesh probes first: `--mesh-only` for each new case (into `results-probe/`), with its plan's
estimate checked, before any solve.

