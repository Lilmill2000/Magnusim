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

Both report commands also exit 1, and say which, when a locked value fails its band (Rules, below).

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
   with the citation, the error, the band and the verdict (`model.verdict_of`); the mesh (cells, checkMesh, wall
   layers asked and applied: RH2's mesh facts), the pre-run check, the run (iterations,
   convergence, time, ranks, numerics as written) and its health (RH1); the app's commit,
   OpenFOAM's version and WSL's load. A run that cannot produce its numbers (a setup the app
   refuses, a mesh or solve that fails, layers asked and not applied) fails the test, and so
   does a steady run that stops at its iteration limit while its monitors still move
   (`not_settled`: more than the case's `SETTLE_DRIFT` over the last 10 % of iterations), and
   a transient run whose periodic signal never settles within it (`not_settled`: case 5's
   shedding, `extract.settled_window`).
4. **Report** (`python -m magnusim_validation report`): every committed value judged by the locks
   (`locks.py`, Rules below), then `VALIDATION.md`, `docs/validation/`
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
| `magnusim_validation/model.py` | References, tolerances (locked, or report-only with why), the comparison and its verdict |
| `magnusim_validation/locks.py` | Every committed value judged against its case's band now; what fails the report and its check |
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
- The tolerances were locked on 2026-11-07, after Daniel reviewed the second full run of the
  whole set (below). Every band is `Tolerance(locked=True)` but those of case 2's k-omega SST
  on Standard (f and f_tau), which are report-only until that limit is fixed
  (`c2_turbulent_pipe.REPORT_ONLY`, `Tolerance(report_only=...)` with why: still compared and
  shown with their band, error and the case's note, "report only: known limit of k-omega SST on
  Standard's tetrahedra", with no pass or fail; taking the variant out of `REPORT_ONLY` locks
  them). The lock changed no band. A locked value outside its band, or with no value, fails the
  run (`npm run test:validation`: a verdict `fail` in its result), the report and its check
  (`npm run validation:report`, `-- --check`: `locks.py` judges every committed value against its
  case's band now; a locked value from a run that did not end ok reads FAIL with why, and a band
  or a reference changed since its run fails too), so it blocks a release; a
  report-only value never fails. `results/` holds the second full run of all six cases and every
  variant (2026-11-07, commit 977c1480 with no changes, OpenFOAM v2606, 8 cores, one run at a
  time, 71.9 minutes), after the two fixes below (Standard's laminar friction and k-omega SST at
  the wall), with Heat Transfer's own set run from the same commit after it: 46 of its 48
  compared values inside their bands (the 46 locked), the two outside k-omega SST's friction on
  Standard (f -14.25 % and f_tau -17.05 %: a limitation, below; the two report-only). Its
  `result.json` files keep the verdicts their evaluation gave before the lock (`report_only`); the
  report and the page show the locks' (`verdict_at_run` beside it in the page's `results.json`).
  Heat Transfer's own set has no bands and stays report-only. The
  first full run (2026-11-06, commit aaabb531, 57.7 minutes; in git's history) had 43 of its 48
  inside. Against it the second moved case 1's Standard f Re from +15.99 to +0.03 % (its
  development length from -5.53 to -0.19 %), case 2's k-omega SST on Hex-dominant from f
  -13.17 % and f_tau -12.79 % to -4.14 and -3.06 %, on Standard from -25.13 and -26.46 % to
  -14.25 and -17.05 %, and case 2's Standard k-epsilon from -3.79 and -2.98 % to -0.97 and
  +0.34 %; case 1 on Hex-dominant moved by at most 0.8 % (its development length, f Re -0.14 %),
  case 2's Hex-dominant k-epsilon by 0.2 % (f), and cases 3 to 6 by at most 0.82 % (case 5 at
  Re 100: its CL rms -0.82 % and mean Cd -0.43 %, both nearer their references; the sphere's Cd
  -0.25 %; the rest 0.16 % or less). Meshes are not exactly the same from one generate to the
  next (snappyHexMesh and gmsh in parallel): case 1's Hex-dominant mesh had 128 704 cells in the
  first full run and 128 706 in the second (two mesh probes in a row gave the same two), its
  Standard mesh 139 228 and 139 148, and case 2's Standard pipe 69 436 and 69 543 (two mesh
  probes before gave 69 543 twice, and 69 568 before that); between the first full run and the
  runs before it, cases 3 to 6 moved by at most 0.03 %, case 1's development length on
  Hex-dominant by 1 % and case 2's Standard friction by 0.6 to 0.75 %. Probes of every case
  and variant at 4 cores before and after the fixes: before them, cases 3 to 6 read within
  0.01 % of the first full run (case 3 at Re 1000's profile differences within 0.25 % of
  themselves, about 1e-5 U) and the Hex-dominant pipes within 0.5 % (case 1's development
  length -0.49 %, f Re +0.09 %; case 2's f -0.42 % with k-epsilon and -0.25 % with k-omega SST,
  its f_tau within 0.04 %), so the probes compare like with like; case 2's Standard f from the
  pressure drop read 2.1 and 2.5 % above the first full run's (its f_tau within 0.3 %), as its
  meshes differ from one generate to the next.
- The quick physics checks (`npm run test:physics`, docs/TESTING.md) are the set's fast
  companion: the case writer on three blockMesh grids (the cavity at Re 100 against Ghia et al.,
  the laminar pipe's f Re and U_cl / U_b, the cylinder's Cd at Re 20), in under a minute, first
  in the full test tier before a push.
- Hex-dominant for every case; the two pipe cases on Standard as well. Where layers are asked
  the run asserts they were applied.

## Before the next cases

What the reference data set for cases 2 to 6, where it differs from the first plan of them,
and what the app lacks for them. Each case module carries its own references and bands with
their citations; this list is what those modules must start from.

| Case | What the reference data set |
|---|---|
| 2, turbulent pipe, Re 5e4 | Built (`c2_turbulent_pipe.py`). f = 0.0211 (McKeon et al. 2005, eq. 3.5), band ±10 % with wall functions (±5 % if y+ < 1). The reference data ask for f at least 40 D from the inlet (turbulent development is about 20 D), or a cyclic or mapped inlet. This case meets neither: the app has no cyclic inlet (G9), and when the case was built Hex-dominant could not mesh a pipe much longer than 30 D cleanly (below; fixed 2026-11-07 and 2026-11-08, but the case keeps the 30 D its bands were locked on), so the pipe is 30 D and f is read over x/D 20 to 25, with the slope over 15 to 20 beside it; a run whose two differ by more than 1 % carries a warning (still developing there, so not yet its developed value; from the Auto inlet it reads below it: Development at 20 to 25 D, below). |
| 3, lid-driven cavity, Re 100 and 1000 | Built (`c3_lid_cavity.py`, one cell across). Ghia et al. (1982) Tables I and II (`refs/ghia_1982_*.csv`, with the one correction at x = 0.9063, Re 1000: -0.51550); extrema within 3 % of Botella and Peyret (1998, `refs/botella_peyret_1998_extrema.csv`), the profiles' largest difference at most 0.03 U, the primary vortex centre within 0.01 L and psi_min within 2 % of Marchi et al. (2009, `refs/marchi_2009_vortex.csv`). |
| 4, backward-facing step | Built (`c4_backward_step.py`, one cell across). Re_D 100 on Armaly et al.'s expansion ratio 1.942 against their Fig. 14, x1/S = 3.00, ±10 % (the flow turns three-dimensional near Re 400, so not the design's Re 389; `refs/armaly_1983_fig14_x1.csv`); Re_D 800 on expansion ratio 2 against Gartling (1990), x_r/S = 12.20, ±7 %, and the top wall's bubble (9.70 and 20.96 S, ±10 %; `refs/gartling_1990_re800.csv`), the literature's scatter beside it (`refs/bfs_re800_scatter.csv`); the outlet 30 H after the step; a uniform inlet with an upstream channel of 10 h or 10 H (no profile inlet). Read from the wall shear stress the run saved on the floor and the top, U_x 0.02 S from the wall as the cross-check. Re_D 800 solves with SIMPLEC: with SIMPLE it never settled. |
| 5, cylinder | Built (`c5_cylinder.py`, one cell across). Re 20 and 40 steady against Cd 2.02 and 1.50 and L/D 0.93 and 2.24 (±5 %, `refs/cylinder_re20_re40.csv`; the literature's spread in `refs/cylinder_steady_scatter.csv`); Re 100 transient against St 0.164 (±3 %), the mean Cd 1.33 (±5 %), CL rms 0.23 (±15 %) and the mean L/D 1.41 (±10 %; `refs/cylinder_re100.csv`, `refs/cylinder_re100_scatter.csv`). The domain the reference data ask for: 40 D wide (blockage 2.5 %), 15 D upstream and 30 D downstream, one Freestream round it; a Forces monitor on the cylinder with the study's reference values; 300 D/U of run, the shedding read by the harness over whole periods after the transient (at least 20; G8). How much a coarser and a finer mesh (the probes of 2026-11-06) move the reported values: the case's notes in `VALIDATION.md`, worked out from its results. |
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
- **Long thin parts on Hex-dominant** (case 2), fixed 2026-11-07 and 2026-11-08: its background block kept at
  least 8 and 12 cells across the part's two small axes while its cells along the long one grew
  with the length, so the cells near the wall came out long and flat. A 55 D pipe at fineness 6
  had 25 196 faces over 65 degrees non-orthogonal before snapping and failed checkMesh (8 cells
  of negative volume) although Generate finished; a 40 D pipe at fineness 7 kept 0.03 of its
  two wall layers. Now every background cell is at most 3 times as long as it is wide, and a
  Hex-dominant mesh that fails checkMesh ends Generate failed with its failed checks named: the
  55 D pipe at fineness 6 gets a 147 × 8 × 12 block and passes checkMesh (its worst face at
  65.1 degrees). Case 2 stays 30 D, the length its bands were locked on; its Hex-dominant block
  went from 67 × 8 × 12 to 80 × 8 × 12. On that block snappyHexMesh first left the pipe's inlet
  and outlet off their planes (the third full run, 2026-11-08): their centres 1.26 mm inside the
  pipe and a slanted ring round each, 344.3 mm² for the disc's 314.2, so the Normal to face
  inlet let in 9.6 % more and f read 23 % high. The background cells along the pipe are 3 times
  their side across, and snappyHexMesh's patch smoothing pulled a face that landed inside the
  pipe past the reach its snap has, which the short side across sets. Since 2026-11-08 the block
  keeps its counts but its ends along the lengthened axis sit just outside the part's two planes
  there, so the ends snap onto them: 314.0 mm² on the 30 D and the 55 D pipe (the 55 D pipe's
  were 312.4), the wall and the cross-section within 0.15 %. The cap is not needed for it: a
  pipe whose block the cap leaves alone has cells up to 3 times their side across too (a 25 D
  pipe at fineness 6 with physics-based meshing off: its ends 334.7 mm², +6.5 %; case 1's pipe
  at fineness 4: 0.6 % small), so since then the ends move along any axis whose cells are more
  than 1.06 times the side across (1.79 at fineness 1 to 3), and both come out 314.0 mm². Case
  1's Hex-dominant block is one: it keeps its 67 × 8 × 12, its ends 0.34 mm outside the pipe's
  planes, and its committed result is from the mesh before. In 2D (case 4, a channel 35 to 40 times longer than
  high) the block keeps 8 background cells across the height, with the cells along it now at
  most 3 times longer than high (fineness 5: 94 to 107 × 8, where it was 54 × 8 and 5 to 6
  times); at fineness 10 (170 × 8, 1.7 to 1.9 times) it is unchanged, so the step's meshes are
  the same, and both pass checkMesh (their worst faces in `VALIDATION.md`).
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
  (`precheck.check_inputs`, `e2e/mesh-one-cell-across.spec.js`, `tests/test_if_precheck.py`). That
  rule alone read a 2D tunnel's inlet as a channel: a cylinder at Re_D 100 in a box 40 D high fed
  by a velocity inlet read "Re ≈ 8,000 is turbulent; a laminar model will not settle" (found in
  review); Re is on the study's reference length whenever it sets one now, with an
  inlet or without, and on the inlet's only when it sets none (a study that sets a reference
  length for a pipe then reads Re on it, against the external-flow limit). A
  wide rectangular inlet in 3D still takes the circle of its area (Armaly's real 18:1 channel at
  Re_D 800 would read Re ≈ 2 700 and a laminar warning): the smallest fix is 4A/P with the face's
  perimeter from its CAD edges (the mesher's feature sizing reads them; the run's face table does
  not carry them yet).
- **Standard's laminar friction** (case 1), fixed after the first full run: Standard read f Re
  74.2 for 64 (+16 %), and the wall shear stress the run saved carried the same excess, so it
  was the solution. The cause was the app's schemes, not the convection's numerical diffusion:
  plain linear interpolation and Gauss linear gradients ignore a cell's skewness, which
  Standard's tetrahedra (between its hex core and its wall layers) have in every direction, so
  the mass flux from HbyA and the velocity gradient the viscous term reads (its non-orthogonal
  correction and its explicit part) were wrong there: in that tet shell the viscous stress
  carried 67 to 85 % of what the force balance needs (the hex core and the layers 98 to 101 %)
  and the pressure gradient a cell felt swung between 0.33 and 1.50 times the real one in 1 mm
  rings. Ruled out on the same mesh: convection (at Re 1 the excess stayed +11.5 %, central
  differencing read 74.3), 4 non-orthogonal correctors for 2 (74.85), SIMPLEC, the gradient
  limiter (None: 74.25), the hex core and the layers, the cross-section's faceting (area
  -0.22 %) and the reading (the centreline slope, the cross-section mean and the wall shear
  within 0.5 %). Both are skew-corrected now (`flux(HbyA) skewCorrected linear`, and `grad(U)`
  the study's gradient limiter on `Gauss skewCorrected linear`, steady and transient), but for
  k-omega SST on a Standard mesh (below): on the 4-core probes Standard reads f Re 64.13 (+0.21 %)
  (before 74.30, +16.1 %) and Hex-dominant 63.21 (-1.24 %) (before 63.35, -1.02 %); Standard's
  development length 5.70 D (-1.2 %, before -5.7 %). The first version of the fix (f7926eb0) wrote
  `grad(U)` never limited and put the limiter on a `limitedGradU` for linearUpwind; the limiter
  inside the skew-corrected gradient reads the same (2026-11-07, case 1's Standard mesh re-solved
  with only its fvSchemes changed: f Re 64.004 either way with Accurate, 64.247 against 64.237 with
  Robust; neither line alone is enough: the flux alone read 69.91, the gradient alone 68.90, the
  plain lines 74.24), so Strong limits what the viscous terms read again, as before the fix, and
  the app path reads 63.998 (Accurate); the second full run read f Re 64.02 (+0.03 %) on
  Standard and 63.20 (-1.25 %) on Hex-dominant. Cases 3 to 6 (Hex-dominant) moved by
  at most 1 %: case 5 at Re 100 its mean Cd -0.5 % and its CL rms -1.0 % (both nearer their
  references), St +0.09 %, the rest 0.25 % or less. Solves take longer. On the 4-core probes:
  on Hex-dominant from -2 % (case 3 at Re 1000) to +65 %
  (case 5 at Re 20, in fewer iterations), 8 of its 11 runs between +14 and +35 %; on Standard
  case 1's pipe +43 % (in 412 iterations against 319) and case 2's +9 and +19 %. Those probes
  ran beside other work (WSL's 1-minute load 1 to 8.4 while they solved, and some overlapped
  the investigation's own test runs), so their times are rough. The two full runs, each solve
  alone on 8 cores (WSL's 1-minute load 1 to 8.9 while they solved, their own 8 ranks), give
  the solver's own times: on Hex-dominant +17 % (case 1) to +70 % (case 6, 431 s against 254 s
  in 548 iterations against 549), 10 of its 11 runs between +17 and +50 %; on Standard case 1's
  pipe +33 % (in 380 iterations against 317), case 2's k-epsilon +23 % and its k-omega SST,
  written with the plain lines, +7 %; the whole set took 71.9 minutes against 57.7.
  Alone, one solve at a time, case 1's Standard pipe took 1.8
  times as long at fineness 6 (33 s against 18.6 s) and 1.4 times at fineness 8 (132 s
  against 95 s). A poor snapped mesh ran the Robust preset's new schemes to the end as it ran the
  old: OpenFOAM's motorBike tutorial meshed on 4 ranks (checkMesh: 12 highly skewed faces, one
  failed check), 300 iterations with the old schemes, the new ones, and the new ones with k-omega
  SST's new walls: all three reached iteration 300 with no k or omega bounded (their p residual at
  iteration 300 0.026, 0.031 and 0.040), the new schemes in 164 s against 134 s (22 % longer; 171 s
  with the new walls). Those runs did not save their drag coefficient, so they say nothing about
  Cd. Every
  steady and transient Incompressible Flow study writes them at a Start, or a Continue that takes
  the study's new numerics; "Numerics as written" shows them under Stays fixed
  (`bundled-plugins/incompressible_flow/tests/test_skew_and_walls.py`, `e2e/run-numerics.spec.js`).
  Heat Transfer's writers keep the plain schemes. Probed on its own validation meshes
  (2026-11-06, `bundled-plugins/heat_transfer/README.md`, "Validation"), the same lines with
  `grad(h)` skew-corrected too took its laminar pipe on Standard from Nu +13.1 % and f Re +15 % to
  +5.2 % and -1.1 %, but its turbulent pipe on Standard, whose wall cells are tetrahedra under
  wall functions (no layers), from Nu +0.3 % to -39 % and f +2 % to +101 %. This case's own pipe
  on Standard with its layers turned off (k-omega SST, Accurate, y+ 41 to 143) read the same
  way: f -31 % and f_tau -27 % with the schemes before the fix, -62 % and -65 % with the
  skew-corrected ones, on one mesh; so did k-omega SST on Standard with its layers, from the
  Auto inlet, so Incompressible Flow writes k-omega SST on a Standard mesh without them (two
  items below).
- **k-omega SST at the wall** (case 2), fixed after the first full run: the app wrote
  `nutkWallFunction`, which takes the wall's friction from the first cell's k with a switch to
  the log law at y+ 11.53, and v2606's `omegaWallFunction`, whose default blending is binomial.
  On a clean mesh (a developed pipe as a 5 degree wedge, one cell along it, a mean-velocity
  source holding U_b, the app's schemes, the first cell's centre from y+ 1 to 100) that read f
  8 to 20 % low from y+ 12 to 35 and 5 to 7 % low above; the Hex-dominant pipe (y+ 35) read 13 %
  low, of which about 8 points were the wall treatment, 1.5 the mesh and 3 its development at
  20 to 25 D. The walls take Spalding's law (`nutUSpaldingWallFunction`) with stepwise omega
  now: on the wedge within -0.4 to +2.1 % from y+ 5 to 15 (smooth through the switch at
  11.53: +0.45, +0.24, 0.0 and -0.13 % at y+ 11.0, 11.5, 12.4 and 12.9), +4.4 % at y+ 20
  (+4.4 % on a finer stretch too), +0.4 % at 30 and -3.3 % at 100; Spalding's law with the
  default blending read 5 to 9 % high from y+ 5 to 12. Hex-dominant's pipe now reads f
  -4.10 % and f_tau -3.02 % (before -13.39 % and -12.82 %; the second full run -4.14 % and
  -3.06 %, the first -13.17 % and -12.79 %) and, with a mapped inlet holding the
  developed flow, -0.4 %. From y+ 35 up the wedge reads f lower as y+ grows (-0.6 % at 35,
  -2.2 % at 50, -3.3 % at 100), and these probes do not show why: with SST's stress limiter off
  (b1 0) the wedge read +3.4 % at y+ 35, an overshoot rather than the shortfall gone, so they do
  not tie it to the limiter. OpenFOAM's log law (E = 9.8) runs about 0.5 U+ above the inner
  layer there (Spalding's law at y+ 34.4 gives U+ 13.51 against the log law's 14.19), most
  likely why k-epsilon reads -4.2 to -4.9 % from y+ 11.6 up. k-epsilon keeps `nutkWallFunction`: Spalding's law read
  it 6 to 20 % high below y+ 20 (epsilon takes its log value at any y+), and below y+ 11 its
  log law reads 5 to 75 % high. So Standard's k-epsilon pipe reading near its reference (f
  -0.97 % and f_tau +0.34 % on the second full run, -0.96 and +0.34 % on the probe after the
  fixes, -3.8 and -3.0 % on the first full run) is most likely errors that cancel, not the best
  variant: its wall faces where f is read sit at y+ 11.8 to 12.5 (on the second full run and the
  probe; 11.4 to 12.3 on the first full run; the pre-run check estimated 9.7),
  just above the switch at 11.53, where the wedge jumps from +4.8 % at y+ 10.2 to -4.8 % at
  11.6, so its walls alone read f about 5 % low there and the rest (its tetrahedra and the
  still-developing flow, not probed apart) reads it 1 to 5 points high; a mesh whose wall cells
  sit on the other side of the switch can move f by up to about 10 points (case 2's notes work
  it out from the reported run). Heat Transfer takes the same walls: its turbulent pipe's Nu read
  -1.61 % (before -9.64 %) on Hex-dominant and +0.29 % (before -20.28 %) on Standard (the 4-core probes before and after;
  its whole set, run again on 2026-11-07 from the commit of the cases' second full run, at 8 ranks, read -1.61 % and
  +0.34 %, and its study panel's Standard note and pre-run check say so).
- **k-omega SST on Standard's tetrahedra** (case 2, a limitation, and the skew-corrected lines
  left out there): the 4-core probes of 2026-11-07 re-solved case 2's Standard meshes (from the
  Auto inlet, 2500 iterations, f at 20 to 25 D) with only their fvSchemes changed, the
  skew-corrected lines against the plain ones (f from the pressure drop, then f_tau from the wall
  shear):

  | Standard mesh, preset | Skew-corrected (f7926eb0) | Plain lines |
  |---|---|---|
  | With layers, Robust (the default preset) | -22.9 %, -21.0 % | -10.9 %, -13.8 % |
  | With layers, Accurate | -24.7 %, -15.1 % | -17.6 %, -17.2 % |
  | No layers, Robust | -50.4 %, -53.6 % | 0.0 %, -9.9 % |
  | No layers, Accurate (y+ 41 to 143) | -61.9 %, -65.3 % | -31.2 %, -27.7 % |

  With the limiter inside the skew-corrected gradient they read the same as f7926eb0's lines or
  further off (Robust with layers -24.3 %, -24.5 %). Developed (a mapped inlet, Accurate,
  fineness 8) the skew-corrected lines read better, f -9.2 % against -14.4 %, and the flux and
  the gradient each made the pipe without layers worse alone (f -43.6 % and -34.9 %, lane 2's
  probe). k-epsilon on Standard reads better with them (-1.0 % and +0.3 % against -1.9 % and
  -3.0 %, with layers), and Hex-dominant's SST pipe too (-4.2 % and -3.0 % against -6.6 % and
  -5.7 %). So k-omega SST on a Standard mesh (the mesh facts' mesher) is written with the plain
  lines and every other study with the skew-corrected ones
  (`incompressible_flow/writer.py` `skew_corrected`; "Numerics as written" says which). Through
  the app path, with that: Standard with layers f -14.3 % and f_tau -17.1 % (Accurate; the
  second full run, 69 543 cells: -14.25 % and -17.05 %, the two values outside its bands), -15.0 %
  and -14.0 % (Robust); without layers -18.8 % and -28.0 % (Accurate); one mesh each, and
  Standard's meshes of the same settings differ (these and the re-solves above are different
  meshes). Why the skew-corrected lines read k-omega SST's friction lower on tetrahedra from an
  inlet is not shown. Developed (a mapped inlet, 4000 iterations, both fixes, the skew-corrected
  lines) Standard read f -9.2 % at y+ 11.5, where the wedge reads +0.2 %, with U_cl / U_b 1.27
  against 1.17. The probes point at SST's stress limiter, nut = a1 k / max(a1 omega, b1 F2 S):
  with the limiter off (b1 0) Standard read +12.6 % against the wedge's +11.1 %, and Wilcox's
  k-omega (no limiter) +16.8 % against +16.1 %, so without it the tetrahedra read as the clean
  mesh does. How the limiter cuts nut there is inferred, not shown: the strain rate S comes from
  the cells' velocity gradient, which the tetrahedra may make uneven, and the max would turn that
  unevenness into a one-sided cut of nut. Ruled out: the mesh's fineness (fineness 8, with a hex
  core: -9.2 %), the turbulence fields' gradients (skew-corrected too: -8.3 %) and the wall
  distance (Poisson instead of meshWave: -9.3 %). No small fix: the Study panel's model help and
  the Assistant's guide say what a pipe read on each mesher, the pre-run check warns of a Standard
  mesh with no wall layers under a turbulent study (`wall_friction_mesh`: k-epsilon there read
  -12.8 % and -13.0 % with Robust and diverged with Accurate, with the skew-corrected lines or the
  plain), and Hex-dominant suits turbulent wall friction. Its two values are report-only until
  this is fixed (the lock of 2026-11-07, Rules above).
- **k-omega SST resolved to the wall** (case 2's wedge, a limitation): with the first cell's
  centre at y+ 1 to 3 every wall treatment tried read f 6 to 9 % low (Spalding's law, nutk,
  nutLowRe with k fixed at 0, Menter's omega on the wall face, kLowRe; a finer stretch, 1.05 and
  1.02, about 1 point better); with the centre at y+ 0.3 it read -1.5 % (one run, with
  nutkWallFunction). No other y+ below 1 was run, so where between 0.3 and 1 k-omega SST starts
  to resolve the wall is not known; the model help and the Assistant's guide give only the y+
  that were tested.
- **Development at 20 to 25 D** (case 2): from the Auto inlet (5 %, 0.07 D) the centreline speed
  overshoots (U_cl / U_b 1.19 against 1.16 developed) and f at 20 to 25 D reads below its
  developed value, not above it: on Hex-dominant 2.6 % (k-epsilon) and 3.6 % (k-omega SST)
  below a mapped inlet's 15 D downstream; from 10 % and 0.1 D it read above it. The warning
  says f is not yet its developed value, not which side. On Standard the 5 D pressure slopes
  moved about 2 % between two meshes of the same settings while the wall shear stress agreed
  within 0.2 %.

Mesh probes first: `--mesh-only` for each new case (into `results-probe/`), with its plan's
estimate checked, before any solve.

