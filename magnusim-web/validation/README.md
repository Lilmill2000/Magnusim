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
   the app's own volume loader, `app_sampling`; a patch field the run saved, `case_file`),
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
   (`index.html`, `results.json`) and the figures (`docs/validation/img/`, matplotlib).

## Files

| Path | What it is |
|---|---|
| `magnusim_validation/cases/` | One module per case: geometry, face selectors, requests per variant, references with citations, tolerances, extraction, figures |
| `magnusim_validation/model.py` | References, tolerances, the comparison (report-only until locked) |
| `magnusim_validation/geometry.py`, `faces.py`, `plan.py` | The STEP, the app's face table and selectors, `plan.json` |
| `magnusim_validation/evaluate.py`, `extract.py`, `result.py` | `result.json` and its checker, the numerics |
| `magnusim_validation/sampling.py`, `mesh_plan.py` | Reads of the run's case folder; what a Hex-dominant plan's mesh will be |
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
| 2, turbulent pipe, Re 5e4 | f = 0.0211 (McKeon et al. 2005, eq. 3.5), band ±10 % with wall functions (±5 % if y+ < 1). Read f at least 40 D from the inlet (turbulent development is about 20 D): a pipe of about 55 D, or check that the slopes over two stretches agree. |
| 3, lid-driven cavity, Re 100 and 1000 | Ghia et al. (1982) Tables I and II; extrema within 3 % of Botella and Peyret (1998), the profiles' largest difference at most 0.03 U, the primary vortex centre within 0.01 L and psi_min within 2 %: absolute bands and a reference of zero (`Tolerance(abs_tol=...)`), and a reference table per profile. |
| 4, backward-facing step | Re_D 100 against Armaly et al. (1983) Fig. 14, x1/S = 3.00, ±10 % (the flow turns three-dimensional near Re 400, so not Re 389); Re_D 800 against Gartling (1990), 12.20, ±7 %; outlet at least 30 H downstream. |
| 5, cylinder | Cd ±5 % at Re 20 and 40; at Re 100 St ±3 %, mean Cd ±5 %, CL rms ±15 %. A domain at least 40 D wide (blockage at most 2.5 %), about 15 D upstream and 30 D or more downstream; averages over at least 20 shedding periods after the transient (about 200 D/U or more of run). |
| 6, sphere, Re 100 | Cd 1.09 ±5 %, L/D 0.88 ±7 %; at least 15 D to each side and about 15 D downstream. |

App gaps found so far, and what they block:

- **Closed domain** (case 3): the Start check does not count a moving wall as what drives the
  flow, and no `pRefCell` is written for a domain with no pressure boundary.
- **Signed profiles** (cases 3 to 6): Plot over path gives a vector's magnitude only; the
  harness reads cell values with the app's own loader instead (`sampling.cells`).
- **Point probes** take the value of the cell that holds the point (no interpolation).
- **Refine out to** (cases 4 to 6): a custom size refines only about three target cells out
  from its faces, and there is no box refinement.
- **A one-cell 2D slab** (cases 3 to 5): Hex-dominant puts at least 8 cells across y and 12
  across z, refined near every surface, so a slab costs millions of cells.
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
  wait for it.

Mesh probes first: `--mesh-only` for each new case (into `results-probe/`), with its plan's
estimate checked, before any solve.

