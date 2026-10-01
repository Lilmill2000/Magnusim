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
| Material model | `newtonian_incompressible` |
| Monitors | `area_average`, `flow_rate` |

All of them are `protected` (no other plugin may drop them). Its manifest's
`default_analysis` makes `incompressible_steady` the analysis a study gets when
none is named, and maps the name studies saved before analysis keys carry
(`incompressible`) to it. The core names none of these keys.

## What it answers (the analysis contract)

The core reaches the plugin only through the analysis contract
(`cfddesk.registry.contract`, documented in `docs/plugins/compatibility.md`):

| Contract field | Here |
|---|---|
| `family`, `study_defaults`, `algorithm_label`, `x_axis` | `incompressible_flow/contract.py`, `analyses.py` |
| `validate_ready` | `contract.py`: fluid assigned, a flow-driving boundary condition, patches, pressures |
| `run_model` (defaults, normalize, preview) | `contract.py` and `transient.py` (`STEADY_DEFAULTS`, `TRANSIENT_DEFAULTS`, `normalize_transient`, the Δt estimate) |
| `write_case`, `plan_case` | `writer.py` (with `runspec.py`, `physics.py`, `function_objects.py`) |
| `launch` | not its own hook: the core builds it from its solver apps (`solvers.py`), its `frame_fields` (`U`, `p`) and its `log_parser` (`parser.py`) |
| `residual_series`, `result_fields` | `contract.py`, `analyses.py` |
| `run_monitors` | `results.py` (with `monitors.py`) |
| `ui` | `ui/StudySettings.tsx` and `ui/RunSettings.tsx` in the study and run panels' settings slots |

The Python package imports only `magnusim_sdk` and `cfddesk.registry`
(`python/tools/plugin_boundary.py` checks it). The UI imports only `react`, its
own `ui/` folder and type-only host types.

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
A change here also runs the core's `h5-plugins` and `h8-contract` (the plugin host
and the analysis contract, including what the app does when this plugin is
missing); every core change runs this suite too (`docs/TESTING.md`).
