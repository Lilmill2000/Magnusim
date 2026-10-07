# Airfoil

A bundled plugin that ships off. It adds the study kind **Airfoil analysis**,
opened in its own workspace: a 2D section (a NACA 4- or 5-digit designation,
its dimensions, or a Selig or Lednicer `.dat` file), its conditions (Reynolds number, Mach number,
α range, Ncrit, forced transition), and its lift, drag and moment polars from:

- **NeuralFoil** (MIT): a trained network, a polar in a fraction of a second,
  recomputed as the inputs change;
- **XFOIL** (GPL): the panel code, run as a job with progress per angle. Every
  angle that does not converge is listed ("α = 18°: did not converge"). The
  plugin ships MIT's own Windows build of XFOIL 6.99 with its source, so XFOIL
  runs on Windows only.
- **OpenFOAM 2D**: a RANS solve of one angle at a time (simpleFoam, k-ω SST,
  fully turbulent, incompressible) in the app's WSL OpenFOAM. The
  `openfoam_2d` job meshes the section with Gmsh (a structured C-mesh,
  `airfoil/cmesh.py`: y+ about 1 at the wall, lines leaving the wall at a right
  angle, the far field 20 chords out) and writes the case; the workspace queues
  it with `ws.compute.submitOpenFOAM`, on the app's one compute slot with its
  meshes and solves. The host runs the WSL steps `gmshToFoam`, `extrudeMesh`
  (one layer, `front` and `back` empty), `createPatch` (the wall) and
  `checkMesh`, then the solver; `forceCoeffs` writes Cl, Cd and Cm every
  iteration.

The workspace:

- **Section:** a NACA designation with its points per side and an open or
  closed trailing edge, or **Import .dat file** (Selig or Lednicer; repairs such
  as a reversed point order are reported). Its outline and measures follow.
  **Dimensions (% of chord)** edits the section directly: maximum thickness and
  where it is, maximum camber and where it is, and the leading-edge radius. They
  start from the NACA code's digits (or, approximately, from a measured
  section); an edit makes it a NACA four-digit-modified section
  (`airfoil/shape.py`: Abbott and von Doenhoff 6.4, NASA TM X-3284), whose
  thickness position and nose radius are free. Whole digits are named as that
  family names them ("NACA 2412-63"), any other section by its dimensions
  ("Custom t12.0@35 c2.0@40 r2.00"). The drawing marks the chord, the camber line
  and its maximum, the maximum thickness and the leading-edge circle.
  Inputs are saved once they pass the checks; a refused one says why, and
  the Run buttons' reasons link to the field to change.
- **Conditions and transition:** Reynolds number, Mach number, first and last
  α and the step, Ncrit, and **Forced transition** with a trip x/c per surface.
- **Engine:** a picker. NeuralFoil draws the polar again as the inputs change
  (the service warms up as the workspace opens). XFOIL is **Run XFOIL**, with
  the angle it is on and how many are done. OpenFOAM 2D is **Run OpenFOAM** at
  an angle and a mesh (coarse, medium or fine): the case waits in the queue
  ("Queued: 1 ahead"), then shows its iteration, elapsed time and residuals as
  it solves, with **Stop**. Each run is listed with its α, mesh, Cl, Cd, Cm and
  how it stands ("Steady · largest residual 6.0e−4 (p)", "Not steady: Cl
  moved …", "Failed: …", "Stopped"; the solver has no residual targets, so a
  run does every iteration of its mesh level and shows where the residuals
  ended),
  with **Open in 3D** (the case's last frame in the project's viewer) and
  **Delete** (its case folder; each case takes about 15 MB of the plugin's
  512 MB in the project). Its polar is the latest finished run at each angle
  of the same section, Reynolds number and mesh. It runs for a Reynolds
  number from 1e5 to 5e7 and says so otherwise; Mach and the transition
  settings are not its (it says so when Mach is set).
- **Plots** (the kit's `LinePlot`): Cl against α, Cl against Cd, Cm against α,
  and XFOIL's Cp(x) at a chosen angle (−Cp upward). **Overlay engines** draws
  every engine's saved polar together; each legend entry names the engine and
  the settings it ran with. Above them, each shown polar's key numbers
  (`workspace/keyNumbers.js`): Cl max and whether it stalled in the range, the
  lift slope against thin-airfoil theory, the zero-lift angle, Cd min, the best
  Cl/Cd and Cm at 0°. Each plot and the OpenFOAM residuals have a closed "How to
  read this", and each table a "What the columns mean".
- **Table and export:** the picked engine's polar, **Export all polars (CSV)**
  (every engine's saved polar, whichever table is shown: one row per engine and
  angle, the settings on each row, and an angle that did not converge as a row
  of its own) and **Export .dat** (the saved section the outline shows,
  Selig). The browser downloads them.

Everything is kept in the project, in the plugin's folder:
`plugins/airfoil/studies/<sid>/` holds the record (settings, and the picked
engine, overlay, Cp angle, and OpenFOAM's angle and mesh under `view`), an
imported `airfoil.dat`, `results/neuralfoil.json`, `results/xfoil.json` and
`results/openfoam.json` (every OpenFOAM run), and one folder per OpenFOAM run
(`openfoam/run-<n>-a<α>/`, the case as the host ran it). Reopening the study
shows it as it was left, and follows a case still queued or running.

## Turning it on

Settings → Plugins → Airfoil → Turn on, then **Install dependencies**: the
plugin's own environment (NeuralFoil, AeroSandbox, NumPy, Gmsh and what they
need, `requirements.lock`, about 200 MB to download) is built from the app's
Python. The app's own packages never change.

## Files

| Path | What it is |
|---|---|
| `manifest.toml` | Key `airfoil`, optional (`default_enabled = false`), the study kind, workspace, start action and `[python]` environment |
| `plugin.py` | `register(hub)`: the `xfoil_polar` and `openfoam_2d` jobs |
| `airfoil_service.py` | The service (`ws.service`): `defaults`, `check`, `import_dat`, `warmup`, `neuralfoil_polar`, `results`, `xfoil_status`, `openfoam_info`, `openfoam_record`, `openfoam_collect`, `openfoam_delete`, `openfoam_polar`, `export_csv`, `export_dat`, `migrate_study` |
| `airfoil/` | Section geometry (`naca`, `shape`, `datfile`, `geometry`), settings, storage, exports (`export`), NeuralFoil (`neural`), XFOIL (`xfoil`), and OpenFOAM 2D: the C-mesh (`cmesh`), the case (`foamcase`) and its runs (`openfoam`) |
| `jobs/xfoil_polar.py` | The XFOIL job tool |
| `jobs/openfoam_2d.py` | The OpenFOAM 2D job tool: meshes the section and writes one angle's case |
| `workspace/` | The workspace page (kit components, `@magnusim/workspace`) |
| `xfoil/` | XFOIL's program, its source and licences, and how they were obtained (`xfoil/README.md`) |
| `tests/` | pytest: a stand-in XFOIL (`tests/fake_xfoil.py`) for the session rules, the shipped program against its golden (`tests/goldens/`), NeuralFoil and the `openfoam_2d` job's command line in the plugin's own environment when it is built (`tests/airfoil_env.py`: skipped when it is not, failed in the full tier, `MAGNUSIM_E2E_WSL=1` or `MAGNUSIM_E2E_FULL=1`), the C-mesh cell by cell (no face 65° or more off orthogonal at any level, Re 1e5 to 5e7), the case, the runs with a real run's coefficients and solver log (`tests/fixtures/openfoam/`), and the case in real OpenFOAM against XFOIL (`test_openfoam_wsl.py`, with `MAGNUSIM_E2E_WSL=1`) |
| `tools/make_xfoil_golden.py` | Writes the XFOIL golden from the shipped program, with the exact session it sent |
| `e2e/` | The plugin's browser tests, on the core's Playwright |

## Checks

```sh
python ../../python/tools/plugin_check.py .     # from this folder (npm run plugin:check -- bundled-plugins/airfoil)
python -m pytest tests                          # with the app's Python
MAGNUSIM_E2E_WSL=1 python -m pytest tests/test_openfoam_wsl.py   # the case in WSL's OpenFOAM (about a minute)
npx playwright test -c bundled-plugins/airfoil/e2e/playwright.config.js   # from magnusim-web
MAGNUSIM_E2E_WSL=1 npx playwright test -c bundled-plugins/airfoil/e2e/playwright.config.js -g gate:h17-openfoam-2d
```

The engine gates (`gate:h17-e2e`, `gate:h17-openfoam-2d`) need the plugin's
environment built for this `requirements.lock`. Per commit they skip without
it; in the full tier (`MAGNUSIM_E2E_WSL=1` or `MAGNUSIM_E2E_FULL=1`) they fail
and say how to build it. `gate:h17-disable-and-remove` is two tests: turned off
(the first test) and the folder removed, then restored (the last).

Licence: GPL-3.0-or-later. Third-party components: the repository's
`THIRD_PARTY_NOTICES.md` and `xfoil/README.md`.
