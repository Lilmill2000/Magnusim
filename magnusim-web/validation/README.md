# The validation set

Textbook flows with published answers, run through the app itself and compared with their
reference values. The report is `VALIDATION.md` here and the public page in
`docs/validation/` at the repository's root (built, not published: publishing is turning on
GitHub Pages for `docs/` and a push).

```bash
npm run test:validation                                   # every case and variant, then the report
npm run test:validation -- --case c1 --variant standard --cores 4
npm run test:validation -- --coarse                       # coarse runs into results-coarse/ (not committed)
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
   labels, and every request the run sends, in `results/<case>/<variant>/plan.json`.
2. **Drive** (`e2e/driver.mjs`, from the opt-in spec `e2e/validation.spec.js`): the plan sent
   to a real app server over the routes the page and the Assistant use: project, STEP upload,
   the face table checked against the plan's, study, fluid, BCs, mesh and refinements,
   Generate, run settings, the Start gate, the pre-run check, Start, then monitors, run
   health, the solver log, the saved times and Plot over path. Every write is read back;
   every answer is saved in `raw/` (not committed).
3. **Evaluate** (`python -m magnusim_validation evaluate <dir>`): `result.json`, the
   compared values with their source (`route:<path>`), how each was measured, its reference
   with the citation, the error and the proposed band; the mesh (cells, checkMesh, wall
   layers asked and applied: RH2's mesh facts), the pre-run check, the run (iterations,
   convergence, time, ranks, numerics as written) and its health (RH1); the app's commit,
   OpenFOAM's version and WSL's load. A run that cannot produce its numbers (a setup the app
   refuses, a mesh or solve that fails, layers asked and not applied) fails the test.
4. **Report** (`python -m magnusim_validation report`): `VALIDATION.md`, `docs/validation/`
   (`index.html`, `results.json`) and the figures (`docs/validation/img/`, matplotlib).

## Files

| Path | What it is |
|---|---|
| `magnusim_validation/cases/` | One module per case: geometry, face selectors, requests per variant, references with citations, tolerances, extraction, figures |
| `magnusim_validation/model.py` | References, tolerances, the comparison (report-only until locked) |
| `magnusim_validation/geometry.py`, `faces.py`, `plan.py` | The STEP, the app's face table and selectors, `plan.json` |
| `magnusim_validation/evaluate.py`, `extract.py`, `result.py` | `result.json` and its checker, the numerics |
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
