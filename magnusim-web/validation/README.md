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
   (`not_settled`: more than the case's `SETTLE_DRIFT` over the last 10 % of iterations).
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
| 2, turbulent pipe, Re 5e4 | Built (`c2_turbulent_pipe.py`). f = 0.0211 (McKeon et al. 2005, eq. 3.5), band ±10 % with wall functions (±5 % if y+ < 1). Read f at least 40 D from the inlet (turbulent development is about 20 D), or check that the slopes over two stretches agree: Hex-dominant cannot mesh a pipe much longer than 30 D cleanly (below), so the pipe is 30 D, f is read over x/D 20 to 25 and the slope over 15 to 20 is shown beside it. |
| 3, lid-driven cavity, Re 100 and 1000 | Built (`c3_lid_cavity.py`, one cell across). Ghia et al. (1982) Tables I and II (`refs/ghia_1982_*.csv`, with the one correction at x = 0.9063, Re 1000: -0.51550); extrema within 3 % of Botella and Peyret (1998, `refs/botella_peyret_1998_extrema.csv`), the profiles' largest difference at most 0.03 U, the primary vortex centre within 0.01 L and psi_min within 2 % of Marchi et al. (2009, `refs/marchi_2009_vortex.csv`). |
| 4, backward-facing step | Re_D 100 against Armaly et al. (1983) Fig. 14, x1/S = 3.00, ±10 % (the flow turns three-dimensional near Re 400, so not Re 389); Re_D 800 against Gartling (1990), 12.20, ±7 %; outlet at least 30 H downstream. |
| 5, cylinder | Cd ±5 % at Re 20 and 40; at Re 100 St ±3 %, mean Cd ±5 %, CL rms ±15 %. A domain at least 40 D wide (blockage at most 2.5 %), about 15 D upstream and 30 D or more downstream; averages over at least 20 shedding periods after the transient (about 200 D/U or more of run). |
| 6, sphere, Re 100 | Cd 1.09 ±5 %, L/D 0.88 ±7 %; at least 15 D to each side and about 15 D downstream. |

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
  two wall layers. A 30 D pipe at fineness 6 meshes (its worst face at 65 degrees).
- **Point probes**, fixed: they read the value at the point (`interpolationScheme cellPoint`),
  not the value of the cell that holds it.
- **Refine out to** (cases 4 to 6), added: Surface custom sizing's "Refine out to" keeps the
  faces' size out to a distance from them on Hex-dominant (Standard and cfMesh say they ignore it;
  `e2e/mesh-refine-reach.spec.js`, `python/tests/unit/test_refine_reach.py`); `mesh_plan.py` counts
  its band. There is still no box refinement.
- **A one-cell 2D slab** (cases 3 to 5), added: Hex-dominant's "One cell across (2D)" meshes
  a slab whose two end faces carry a Symmetry one cell deep (`cfddesk/mesh/two_d.py`; the panel's
  note and Generate say why a part can't be; `e2e/mesh-one-cell-across.spec.js`,
  `python/tests/unit/test_two_d_mesh.py`). Without it Hex-dominant puts at least 8 cells across
  y and 12 across z, refined near every surface, so a slab costs millions of cells.
- **A custom size's level** comes from the diagonal's base size while the block's cells on a
  thin axis are smaller, so on a thin part the cells come out finer and flatter than asked
  (`mesh_plan.py` shows it before Generate).
- **No profile inlet** (case 4): the step needs an upstream channel.
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

