# Heat Transfer

A bundled Magnusim plugin (version `0.1.0-dev`, host API 1.8, GPL-3.0-or-later): the
temperature and flow of one fluid heated or cooled through its walls and inlets, with
buoyancy (natural convection) or without it (forced convection). It ships turned on and
can be turned off in Settings > Plugins. It builds on Incompressible Flow's boundary
conditions (`requires_plugins = ["incompressible_flow>=1.1"]`) and imports only
`magnusim_sdk`, `cfddesk.registry` and Incompressible Flow's exported
`incompressible_flow.flow_bcs`.

## What it solves

One simulation type, **Heat Transfer** (Steady-state and Transient):

- **Solvers:** OpenFOAM v2606 `buoyantSimpleFoam` (steady) and `buoyantPimpleFoam`
  (transient). Every body is fluid: a study whose bodies have one fluid material.
- **Gravity:** off, or along ±X, ±Y, ±Z or a custom direction, with its magnitude
  (9.80665 m/s² by default). Off solves forced convection with the same solvers.
- **Density:** incompressible perfect gas (gases: ρ = p_op M / (R T)), Boussinesq
  (liquids and small temperature differences: ρ = ρ₀ (1 − β (T − T_ref))) or constant
  density (forced convection only; refused with gravity on). "From the fluid" (the
  default) picks perfect gas for a gas (density below 50 kg/m³) and Boussinesq for a
  liquid. Boussinesq takes the material's density as ρ₀, the density at the reference
  temperature; the presets give it at 20 °C, the default reference, so a study with
  another reference should give the fluid its density at that temperature.
- **Operating pressure** (101 325 Pa): pressures in BCs and results are gauge; it sets
  the perfect gas density (`pRef`).
- **Reference temperature**: the Boussinesq T₀ and the heat transfer coefficient's
  reference. **Starting temperature**: blank uses the reference.
- **Turbulence:** laminar, k-omega SST, k-epsilon, realizable k-epsilon (compressible
  forms; `alphat` with `compressible::alphatJayatillekeWallFunction` on walls).
- **Numerics:** Robust or Accurate (energy is second order in both, its gradient never
  limited), the residual target, the relaxation of velocity (0.7), p_rgh (0.3) and
  energy (0.5) (steady), non-orthogonal correctors. Energy relaxed above about 0.5 can
  stall a through-flow solve with a lasting heat imbalance; a closed natural-convection
  case settles sooner at 0.9. Transient runs: simulation time, frames, adjustable time
  step with a maximum Courant number, PIMPLE correctors.
- **Boundary conditions:** Incompressible Flow's kinds (velocity inlets incl. flow rates
  and time tables, velocity and pressure outlets, walls incl. slip, moving and rotating,
  symmetry, freestream, total-pressure inlet) with a **Thermal** group: the inlet
  temperature; the temperature of fluid flowing back in at outlets and freestreams; on
  walls adiabatic, a fixed temperature, a heat flux (W/m², positive heats the fluid) or
  a heat transfer coefficient to an ambient temperature. Walls no BC claims are
  adiabatic. Temperatures show in °C (metric) or °F (imperial) with a K/°C/°F picker and
  are stored in K. A field never touched solves at the value its editor shows (an inlet
  at 20 °C, whatever the reference temperature). A new Wall starts No-slip (it is added
  for the heat through it; Incompressible Flow's own new Wall starts Slip).
- **Results:** temperature (legend, iso surfaces, iso volumes, plots over a path and
  Inspect in °C or °F), velocity, pressure, pressure without its hydrostatic part
  (`p_rgh`), density (`rho`, written at each saved time), wall heat flux (W/m², positive
  into the fluid), heat transfer coefficient h = q / (T_wall − T_ref) (W/(m²·K), against
  the reference temperature: positive on a wall that heats the fluid from above the
  reference and on one that cools it from below) and the turbulence fields.
- **Monitors:** Wall heat flux (W, the mean flux and the face flux of largest magnitude,
  its sign kept, on the walls you pick), Surface temperature (average and highest),
  Thermocouple (temperature at points), and the energy balance of every run (heat in
  and out through walls and openings; the imbalance in a steady run, the heat being
  stored in a transient one). "Stop when a monitor settles" watches a monitor on one
  boundary or a thermocouple; a temperature's tolerance is a difference in °C or °F.
  Runs can be continued.

## What Start refuses, with the reason

- a body with a material other than one fluid (a solid record a development build saved
  included), a fluid property at 0 or below (a thermal expansion of 0 is accepted: no
  buoyancy from temperature), a study setting saved as 0 (operating pressure, reference
  or starting temperature, residual target, a relaxation, gravity magnitude);
- each BC's Incompressible Flow checks, in Incompressible Flow's own words, and its
  Thermal fields (temperatures above absolute zero, a heat transfer coefficient above 0);
- a slip wall with heat through it (a slip wall has no boundary layer);
- a closed domain with nothing to move the fluid (gravity off and no Moving or Rotating
  wall) or nothing to heat it; a steady closed domain heated only by heat fluxes (no wall
  can take the heat out: no steady temperature);
- constant density with gravity, perfect gas for a liquid, and Boussinesq when β·ΔT of
  the boundary temperatures reaches 0.2.

Temperatures in these messages show in the project's unit.

## Limits of this version

- **Fluids only.** Heat conduction through solid bodies (conjugate heat transfer) is not
  part of 0.1.0-dev; the Materials panel offers fluids only.
- One fluid per study; constant properties.
- No radiation, temperature-dependent properties, heat sources, porous media, species.
- A Boussinesq run that still drives the density to zero fails with "Boussinesq density
  reached zero: use incompressible perfect gas" (the solver's log names Boussinesq, its
  density reached zero and the solver died).
- "Varies with time" on a pressure boundary is refused in transient heat transfer studies
  (`prghPressure` takes a fixed value). A freestream boundary's pressure has no
  hydrostatic correction.

## Fluid presets and their sources

Constant properties at 20 °C and 1 atm.

| Fluid | ρ kg/m³ | μ Pa·s | cp J/(kg·K) | k W/(m·K) | β 1/K | M g/mol | Source |
|---|---|---|---|---|---|---|---|
| Air | 1.204 | 1.825e-5 | 1007 | 0.02514 | 3.411e-3 (1/T) | 28.97 | Çengel & Ghajar, *Heat and Mass Transfer*, 5th ed., Table A-15 (air at 1 atm) |
| Water | 998.0 | 1.002e-3 | 4182 | 0.598 | 2.07e-4 | 18.015 | Çengel & Ghajar, Table A-9 (saturated water); β from the CRC Handbook of Chemistry and Physics (volume expansion of water at 20 °C) |
| Oil (ISO VG 32) | 869 | 0.075 | 1881 | 0.145 | 7.0e-4 | — | viscosity from ISO 3448 grade 32 (32 mm²/s at 40 °C, 5.4 mm²/s at 100 °C, a typical hydraulic mineral oil data sheet) extrapolated to 20 °C with ASTM D341 (≈ 86 mm²/s); density from a typical data sheet (872 kg/m³ at 15 °C); cp, k and β of engine oil, Çengel & Ghajar Table A-13. Approximate: use the oil's own data sheet for design work |
| Nitrogen | 1.165 | 1.76e-5 | 1040 | 0.0253 | 3.411e-3 (1/T) | 28.013 | Çengel & Ghajar, Table A-16 (gases at 1 atm), interpolated to 20 °C |
| Custom fluid | Air's | | | | | | the user's own |

## Layout

| Path | What it is |
|---|---|
| `manifest.toml`, `plugin.py` | what the host reads, and `register(hub)` |
| `heat_transfer/analyses.py` | the two AnalysisTypes, their schemas and result fields |
| `heat_transfer/contract.py` | the family, what blocks a run, run models, residual series |
| `heat_transfer/physics.py`, `materials.py`, `bcs.py` | study settings, the fluid model, Thermal BC fields and the new Wall's seed |
| `heat_transfer/runspec.py`, `writer.py`, `functions.py`, `settle.py`, `transient.py` | the case a run writes |
| `heat_transfer/parser.py`, `results.py`, `monitors.py` | the solver log, monitors and energy balance |
| `heat_transfer/jobs/write_run_case.py` | the run's prepare step (its `LaunchSpec.prepare_job`) |
| `ui/` | the study and run panels' settings |
| `tests/` | pytest (writer goldens, contract, results; `-m wsl` the solve proofs) |
| `e2e/` | the plugin's browser suite |

## Validation (HT4)

`tests/test_ht_wsl_proofs.py` (`pytest -m wsl`, OpenFOAM v2606 in WSL), each case written
by the app's run path (the first two meshed by Standard):

| Case | Mesh | Result | Target |
|---|---|---|---|
| de Vahl Davis cavity, Ra = 1e5 (ΔT = 10 K, 0.1 m, 2 mm slab with symmetry sides), steady | 48 960 cells (fineness 4, layers) | Nu_avg 4.5330 against 4.519 (+0.31 %); walls' energy imbalance 0.0095 %; Nu moved 0.034 % over the last 1000 of 6000 iterations | within 5 % |
| Pipe, D = 20 mm, L = 200 mm, air at 1 m/s (laminar), 500 W/m² on the wall | 233 633 cells (fineness 6) | wall 6.28076 W in, m·cp·ΔT 6.27962 W carried out: imbalance 0.018 % | within 1 % |
| The same cavity, transient (`buoyantPimpleFoam`) | 20 × 20 blockMesh | 82 adjustable steps to t = 4 s, frames written, thermocouple 298.09 K | runs, writes frames |
| Boussinesq with β·ΔT = 2.1 | 20 × 20 blockMesh | solver exits (136); the run's reason "Boussinesq density reached zero: use incompressible perfect gas" | the reason shows |
| The e2e fixture cavity, 400 iterations | 20 × 20 blockMesh | htc 3.34 W/(m²·K) on both the hot and the cold wall (h = q / (T_wall − T_ref) face by face); `rho` written | positive h on both |
| Turbulent channel: k-omega SST, perfect gas, gravity, floor at 60 °C, roof with h = 10 W/(m²·K) to 10 °C, 300 iterations | 40 × 30 blockMesh | runs with the wall functions; floor htc 5.93 W/(m²·K), the roof takes 0.133 W out | runs |

The app-path e2e (`e2e/ht4-heat-transfer.spec.js`, with `MAGNUSIM_E2E_WSL=1`) meshes and
solves the same cavity through the browser and checks a channel's written case (see the
HT4 report for its numbers). A run stops on its residual target: on the natural-convection
cavity the residuals can reach it while Nu is still creeping towards its settled value. To
stop on the quantity itself, use "Stop when a monitor settles" on a Wall heat flux monitor.
