# Incompressible Flow

Magnusim's Steady-State and Transient simulation types: flow of one fluid whose
density does not change (Mach below about 0.3), solved with OpenFOAM's
`simpleFoam` (steady, SIMPLE) and `pimpleFoam` (transient, PIMPLE).

It is a **required** bundled plugin (`required = true` in `manifest.toml`): it
cannot be turned off, and if it does not load, the app says so on every page
("Incompressible Flow failed to load: …"), refuses to create or run simulations,
and an existing study or run says why instead of showing settings. Projects and
results stay readable.

Licence: GPL-3.0-or-later.

## What it registers

| Kind | Keys |
|---|---|
| Analyses | `incompressible_steady`, `incompressible_transient` (one family, `incompressible`) |
| Solver apps | `simpleFoam`, `pimpleFoam` |
| BC types | `velocity_inlet_fixed`, `velocity_inlet_volumetric`, `velocity_inlet_mass`, `velocity_outlet`, `pressure_outlet_gauge`, `wall_noslip`, `wall_slip`, `symmetry`, `freestream`, `wall_moving`, `wall_rotating`, `total_pressure_inlet` (`bcs.py`, with their OpenFOAM writers) |
| BC families | `velocity_inlet`, `velocity_outlet`, `pressure_outlet` ("Pressure"), `total_pressure_inlet`, `freestream`, `wall`, `symmetry` (`bcs.py`: labels, hints, colours, aliases, seeds per unit system, unit fields, the generic form's fields and the record resolver) |
| Material model | `newtonian_incompressible`, with the Fluid picker's presets at 20 °C, 1 atm: Air, Argon, Carbon dioxide, Hydrogen, Nitrogen, Water, Seawater (3.5% saline), Custom fluid (`materials.py`) |
| Monitors | `area_average` (the one the Monitors dialog offers), `flow_rate`, and the monitor quantities the Graphs panel shows (`monitors.py`) |

All of them are `protected` (no other plugin may drop them). Its manifest's
`default_analysis` makes `incompressible_steady` the analysis a study gets when
none is named, and maps the name studies saved before analysis keys carry
(`incompressible`) to it. The core reads them through the registry. The 1.x BC
shims (`cfddesk.case.bc_registry`, `bc_menu`) keep a frozen copy of the seven BC
type keys old projects store, so those projects still load and mesh when this
plugin failed to load. The BC keys and saved `bc_type` strings are the ones the
core used before, so projects need no migration.

## What it answers (the analysis contract)

The core reaches the plugin only through the analysis contract
(`cfddesk.registry.contract`, documented in `docs/plugins/compatibility.md`):

| Contract field | Here |
|---|---|
| `family`, `study_defaults`, `algorithm_label`, `x_axis` | `incompressible_flow/contract.py`, `analyses.py` |
| `validate_ready` | `contract.py`: fluid assigned, a flow-driving boundary condition (a moving or rotating wall drives a closed box: no pressure boundary is asked for, and the SIMPLE and PIMPLE dictionaries carry `pRefCell 0; pRefValue 0;`), patches, pressures |
| `run_model` (defaults, normalize, preview) | `contract.py` and `transient.py` (`STEADY_DEFAULTS`, `TRANSIENT_DEFAULTS`, `normalize_transient`, the Δt estimate) |
| `write_case`, `plan_case` | `writer.py` (with `runspec.py`, `physics.py`, `function_objects.py`) |
| `launch` | not its own hook: the core builds it from its solver apps (`solvers.py`), its `frame_fields` (`U`, `p`) and its `log_parser` (`parser.py`) |
| `residual_series`, `result_fields` | `contract.py`, `analyses.py` |
| `kinematic_fields` | `physics.py` (`p`) |
| `bc_types`, `material_models` | `analyses.py` (the specs in `bcs.py` and `materials.py`) |
| `monitor_quantities` | `monitors.py` (`MONITOR_QUANTITIES`) |
| `run_monitors` | `results.py` (with `monitors.py`): each row's `key`, monitor `type` and `default_quantity`, the mass flow per point and the flow balance `summary` |
| `ui` | `ui/StudySettings.tsx` and `ui/RunSettings.tsx` in the study and run panels' settings slots; `ui/BcSettings.tsx` in the BC editor's `bc-settings` slot (`incompressible_flow.bc`, named by its families' `ui`) |

The Python package imports only `magnusim_sdk` and `cfddesk.registry`
(`python/tools/plugin_boundary.py` checks it). The UI imports only `react`, its
own `ui/` folder and type-only host types.

## Turbulence models

The study panel's Turbulence model (`physics.py`: `TURBULENCE_MODELS`, the panel
labels and the run note's names; `writer.py` writes the fields, wall functions,
schemes and solver settings each model needs):

| Model (OpenFOAM name) | Fields in 0/ | Walls |
|---|---|---|
| Laminar (`laminar`) | none | |
| Spalart-Allmaras (`SpalartAllmaras`) | `nuTilda`, `nut` | `nuTilda` 0, `nut` `nutUSpaldingWallFunction` (not tested against a developed pipe) |
| k-epsilon (`kEpsilon`), Realizable k-epsilon (`realizableKE`) | `k`, `epsilon`, `nut` | high-Re wall functions |
| k-omega SST (`kOmegaSST`, the default) | `k`, `omega`, `nut` | `nut` `nutUSpaldingWallFunction`, `omega` `omegaWallFunction` `blending stepwise`, `k` `kqRWallFunction`: a developed pipe read within about 2 % with the first cell's centre at y+ 5 to 15 and within 4.5 % up to 100, 6 to 9 % low at 1 to 3 (below 1, only y+ 0.3 was run: -1.5 %) |
| LRR, SSG (`LRR`, `SSG`) | `k`, `epsilon`, `R`, `nut` | high-Re wall functions |

A boundary's "Turbulence at the inlet" (`inlet_turbulence.py`) sets k, omega and
epsilon; under Spalart-Allmaras it sets `nuTilda` instead: Auto is 3 x the fluid's
viscosity, a viscosity ratio (no intensity) or an intensity and length scale give
a turbulent viscosity that `nuTilda` is solved back from.

## Changes

- **Skew-corrected velocity gradient and flux; Spalding's law on k-omega SST walls
  (validation set, 2026-11).** Plain linear interpolation and Gauss linear gradients
  ignore a cell's skewness, so on Standard's tetrahedra the mass flux (`flux(HbyA)`) and
  the velocity gradient the viscous term reads were wrong: the validation set's laminar
  pipe read f Re 16 % high on Standard. Both are skew-corrected now (`flux(HbyA)
  skewCorrected linear`, `grad(U) Gauss skewCorrected linear`, never limited, steady and
  transient); the study's gradient limiter limits the gradient linearUpwind reads
  (`limitedGradU`) and the turbulence fields' gradients. k-omega SST's no-slip walls take
  `nutUSpaldingWallFunction` with `omegaWallFunction` `blending stepwise` (they had
  `nutkWallFunction`, which read a developed pipe 8 to 20 % low from y+ 12 to 35); the
  other models' walls are as before. "Numerics as written" lists the velocity gradient,
  the flux interpolation and the wall treatment under Stays fixed. The evidence:
  `validation/README.md`.
- **Force on picked faces (Result control > Surface data > Force).** The force on
  exactly the faces a user picks in the 3D view, as Area average picks them (one
  face, several, or a whole wall, with no wall BC needed): total, pressure and
  viscous force, drag, lift and side along the study's reference directions, the
  moment about its centre of rotation, and the coefficients once it has a reference
  area, live while it solves, in the run's results and in the CSVs. The writer moves
  the mesh faces of each picked CAD face into a patch of their own in the run's copy
  of the mesh (`force_faces.py`, `polymesh.py`: `mgf_<face>__<wall patch>`, with
  the wall's boundary conditions, so the flow is the same) and measures them with
  `forces` / `forceCoeffs`; a whole-wall Forces monitor measures the pieces of its
  walls too. Only wall faces: a face on an inlet or outlet is refused at Start. A
  continued run keeps the split it started with. Runs without a Force write their
  cases exactly as before.
- **Reference vectors are kept (with host API 1.8's study route).** The study panel's
  Reference values save the centre of rotation and the drag and lift directions
  (`ref_cofr`, `ref_drag_dir`, `ref_lift_dir`, three numbers each) on the study. The
  route before kept scalars only, so a typed vector went back to blank and Forces
  monitors used the origin and the automatic directions whatever was typed; now they
  use what the study holds (`reference.py`), so a study with typed vectors writes
  different forces (`CofR`, `dragDir`, `liftDir`). Blanking a vector (or a reference
  value) clears it again, and a copied study carries them. Studies saved before have
  none stored, so they write the case as before.

## Tests

| What | Where | Run |
|---|---|---|
| Python, with the goldens `tests/goldens/js_steady` and `js_transient` | `tests/` | `pytest bundled-plugins/incompressible_flow/tests` (also part of the core's `pytest` and CI) |
| The goldens through `prepare_run` | `tests/test_prepare_run_golden.py` | `npm run test:prepare-run-golden` |
| Refresh the goldens after a deliberate writer change | | `node scripts/__tests__/capture-js-case.mjs`, then check `git diff` |
| UI | `ui/*.test.tsx` | `npx vitest run bundled-plugins/incompressible_flow/ui` (part of `npm run test:unit`) |
| The run panel's transient clean-up and the stored one agree | `tests/transient_vectors.json` | read by both `tests/test_transient.py` and `ui/transient.test.tsx` |

Its browser tests (real meshes and solves in WSL) are its own suite in `e2e/`,
run on the core's Playwright: `npm run test:e2e -- --suite incompressible_flow`,
or one spec with `npm run test:e2e -- bundled-plugins/incompressible_flow/e2e/<spec>`.
A change here also runs the core specs that check how the core meets its bundled
plugins, including what the app does when this plugin is missing; every core
change runs this suite too. `docs/TESTING.md` lists both.
