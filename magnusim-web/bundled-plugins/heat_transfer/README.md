# Heat Transfer

A bundled Magnusim plugin (version `0.2.0`, host API 1.8, GPL-3.0-or-later): the
temperature and flow of one fluid heated or cooled through its walls and inlets, with
buoyancy (natural convection) or without it (forced convection), and heat conducted
through solid bodies (conjugate heat transfer, CHT). It ships turned on and
can be turned off in Settings > Plugins. It builds on Incompressible Flow's boundary
conditions (`requires_plugins = ["incompressible_flow>=1.1"]`) and imports only
`magnusim_sdk`, `cfddesk.registry` and Incompressible Flow's exported
`incompressible_flow.flow_bcs`.

## Getting started

**The sample.** Ask the Assistant to open the Heat Transfer heat sink sample: it copies a ready project into your
projects: an aluminium heat sink (a base 40 × 40 mm and 5 mm thick with four fins 4 mm
thick and 20 mm tall) with a 10 W heat source, on the floor of an air channel
200 × 50 × 50 mm, air coming in at 0.5 m/s and 20 °C, gravity along −Y, laminar. Its
mesh is set to Hex-dominant (fineness 4, about 126 000 cells): click Generate, then Start
the run as it comes (1500 iterations, a steady study's default; meshing and the run took
under 3 minutes in the test). The run's panel lists the energy balance (the 10 W in, and
9.96 to 10.02 W out with the air in two test runs: within 0.4 %) and the sink's own
temperatures (86.3 °C at its hottest); Results show T in the air and the sink. Open it again for a second copy ("Heat sink 2").

**Your own part.** Create Simulation → **Heat Transfer** (steady or transient). Then:

1. **Materials** ("+" in the study's Materials): a fluid (air, water, oil, nitrogen, or
   your own) on the fluid bodies. That is all **buoyant flow** needs: one fluid, with or
   without gravity. For **conjugate heat transfer** give the solid bodies a solid material
   (aluminium, copper, steel, FR-4, ...) and, in that material, a heat source if it makes
   heat. The study panel says which solver runs and why. A body with no material is left
   out of the mesh.
2. **Study settings:** gravity (its direction, or off for forced convection), the density
   model, the reference and starting temperatures, the turbulence model.
3. **Boundary conditions:** Incompressible Flow's inlets, outlets and walls, each with a
   Thermal group (an inlet's temperature; a wall adiabatic, at a fixed temperature, with a
   heat flux or a heat transfer coefficient). A solid's outer faces take a **Solid wall**.
   Faces between bodies of different materials are coupled on their own.
4. **Mesh** with Hex-dominant: a new mesh in a Heat Transfer study starts on it (Standard
   works too, but the heat through walls is less accurate on it, see Limits; cfMesh cannot
   mesh solids separately). Fins need at least 2 to 3
   cells across: Start says so when a solid is about one cell thick.
5. **Run:** add monitors (wall heat flux, surface temperature, thermocouples) and Start.
   Every run shows its energy balance.

## What it solves

One simulation type, **Heat Transfer** (Steady-state and Transient):

- **Solvers:** the solver follows the study's materials. Every body fluid (one fluid
  material): OpenFOAM v2606 `buoyantSimpleFoam` (steady) and `buoyantPimpleFoam`
  (transient). A body of a solid material: conjugate heat transfer with
  `chtMultiRegionSimpleFoam` / `chtMultiRegionFoam`, the fluid and every solid solved
  together. The study panel says which runs and why ("Conjugate heat transfer with
  chtMultiRegionSimpleFoam: Body2 is Aluminium 6061 (solid). Body1 is Air (fluid).");
  giving the body back a fluid material goes back to buoyant flow, and no setting is lost
  (a solid's heat source stays on its material record). A body no material names is left
  out of the mesh.
- **Conjugate heat transfer:** each material with bodies is one region (the mesh has a
  cell zone per region, made by Standard or Hex-dominant; the case splits it with
  `splitMeshRegions -cellZonesOnly` before the solver, so a material on two separate
  bodies is still one region). The faces two regions share are coupled
  (`compressible::turbulentTemperatureRadCoupledMixed` on both sides). A solid region may
  have a **heat source**, set in its material (Materials, the solid: "Heat source" in W,
  or "Heat source per volume" in W/m³, one of them; spread evenly; 0 is none, below 0
  takes heat out; BTU/h or BTU/(h·ft³) in an imperial project). It is kept on the
  material record, so a copied study's solid keeps it; the study panel lists each solid's
  source. (A study saved by an earlier build with its sources on the study record still
  reads them.) A solid's outer faces take a **Solid wall** (this plugin's BC: adiabatic, a
  fixed temperature, a heat flux into the solid, or a heat transfer coefficient to an
  ambient temperature, `externalWallHeatFluxTemperature`); a Wall on a solid's face is
  read the same way; a solid's faces no BC claims are adiabatic. One fluid at most; no
  fluid at all solves conduction through the solids only.
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
- **Monitors in a CHT run:** a boundary's part in each body it is on; a thermocouple's
  points each read the body they are in (a point in a solid reads the solid's
  temperature; a point outside the mesh says so); every solid gets its own row (average
  and highest temperature); the energy balance counts the heat sources, the heat through
  every body's outer faces and the heat the flow carries through the openings (the faces
  between bodies are inside it). The run's monitors also give the heat through each
  interface. Residuals per region (`air:h`, `aluminium_6061:h`). Results: T in every body,
  U, p, p_rgh and rho in the fluid (grey in the solids, and the legend says so), wall heat
  flux on outer faces and interfaces in each body, the heat transfer coefficient on the
  fluid's walls and interfaces. A CHT run does not stop on its residuals (the solver has
  no such stop; the study panel hides the residual target): it runs its iterations, or
  until a monitor settles. Continue keeps the split mesh and its saved times.

## What Start refuses, with the reason

- more than one fluid material, a fluid or solid property at 0 or below (a thermal
  expansion of 0 is accepted: no buoyancy from temperature), a study setting saved as 0
  (operating pressure, reference or starting temperature, residual target, a relaxation,
  gravity magnitude);
- each BC's Incompressible Flow checks, in Incompressible Flow's own words, and its
  Thermal fields (temperatures above absolute zero, a heat transfer coefficient above 0);
- a slip wall with heat through it (a slip wall has no boundary layer);
- a closed domain with nothing to move the fluid (gravity off and no Moving or Rotating
  wall) or nothing to heat it; a steady closed domain heated only by heat fluxes (no wall
  can take the heat out: no steady temperature);
- constant density with gravity, perfect gas for a liquid, and Boussinesq when β·ΔT of
  the boundary temperatures reaches 0.2.

A conjugate heat transfer study, besides:

- a mesh made before the materials changed (each material's bodies are a region of their
  own: generate it again; a cfMesh mesh adds that cfMesh can't mesh solid bodies
  separately);
- a solid about one cell thick: half or more of its cells near its surface (a point on
  it) touch the surface on every side (refine the mesh there; HT0's heat sink with fins
  one cell thick diverged, 70 %; with 2.5 mm fins it converged, 23 %). Counted among the
  cells near the surface, so a thick base does not hide thin fins (the same 1.5 mm fins
  on a 10 mm base: 66 %);
- a solid's heat source given both in total and per volume (set one to 0), or not a
  number;
- an inlet, outlet, pressure boundary or freestream on a solid body's faces, and a Solid
  wall on a fluid's;
- a fluid region with no inlet or outlet, gravity off and no moving wall;
- a body (or group of touching bodies) with no way for its temperature to be set (every
  face adiabatic, no heat source, no flow through it); in a steady solve, heat that comes
  in (a source, a heat flux) with no face that takes it out (a fixed temperature, a heat
  transfer coefficient, or the flow through an inlet and an outlet), or heat that only
  goes out (a source or a heat flux below 0) with nothing that sets a temperature;
- Boussinesq when β·ΔT of the boundary temperatures (the solids' faces included)
  reaches 0.2, and Boussinesq on a gas while a solid has a heat source (how hot it gets
  is not known before the solve: HT0's air round a 10 W heater ran to 600 K, where
  Boussinesq's density reaches 0; use incompressible perfect gas).

Temperatures in these messages show in the project's unit.

## Limits of this version

- One fluid per study; constant properties; a solid's conductivity is the same in every
  direction.
- No radiation (P1, fvDOM, solar load), temperature-dependent or anisotropic properties,
  contact resistance between bodies, thin walls (baffles) on shared faces, Joule heating,
  humidity or condensation, phase change, porous media, MRF, species. Bodies that touch over
  part of a face are not coupled there. cfMesh cannot mesh solid bodies separately (Generate
  says so).
- A solid about one cell thick is refused at Start; the Mesh panel does not warn about it
  yet.
- A Wall heat flux monitor picks boundaries, not the faces between bodies; the heat through
  each interface is listed with the run's monitors.
- Results legends show temperature in the project's unit (°C or °F) with no K/°C/°F picker
  of their own; the viewport shows no gravity arrow.
- On a tetrahedral mesh (Standard) the heat through walls is less accurate next to a
  laminar flow: up to about 14 % high (the validation set's laminar pipes; within 0.4 % on
  Hex-dominant), and about 6 % high through a solid's walls. The turbulent pipe (k-omega
  SST, wall functions, no layers) reads +0.34 % on Standard and −1.61 % on Hex-dominant
  since k-omega SST's walls take Spalding's law (before: −20.5 % and −9.6 %; "Validation",
  below), and a natural convection cavity within 1.5 %. Through a solid's fixed-temperature face: the
  composite wall below gave 6.35 % more heat on 195 345 tetrahedra (the temperature inside
  the solids was right to 0.45 % of ΔT), and 0.11 % on Hex-dominant hexahedra. Corrected
  schemes for the solids ("Accurate" numerics: `Gauss linear corrected`, `snGrad
  corrected`) do not fix it (+6.97 %): the error is the gradient at the wall of a
  tetrahedron next to it, which OpenFOAM does not correct. The study panel of every Heat
  Transfer study whose mesh is Standard says so, and its pre-run check (Before you start, which
  the Assistant reads) in the same words ("On a Standard mesh (tetrahedra) the heat through
  walls is less accurate next to a laminar flow: up to about 14 % high (the validation's
  laminar pipes), and about 6 % high through a solid's walls. Its turbulent pipe (k-omega SST,
  wall functions) read within about 1 %, and natural convection in a cavity within 1.5 %. Mesh
  with Hex-dominant for heat numbers."), and a new mesh in a Heat Transfer study starts on
  Hex-dominant. Use Hex-dominant for heat numbers.
- Start reads the unsplit mesh once (patches, the regions they touch, how thin each solid
  is) and keeps what it found beside the mesh (`<mesh case>/ht-mesh-summary.json`, keyed
  by the mesh files' sizes and times): a 2 million cell ascii mesh is checked in about
  3 s within about 450 MB, and a later check of the same mesh reads only that file. The
  solids' volumes are worked out only for a heat source given per volume, and a
  thermocouple's region only for its points; a mesh that cannot be read, or one too
  large for the memory free, is a plain reason at Start.
- The energy balance counts the heat the flow carries through the openings, not heat
  conducted through them: with a hot body right next to an inlet, heat diffusing back out
  of the inlet shows as an imbalance.
- The starting temperature is the same in every body.
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

## Solid presets and their sources

Constant properties at 20 to 27 °C. Conductivity is the same in every direction.

| Solid | ρ kg/m³ | cp J/(kg·K) | k W/(m·K) | Source |
|---|---|---|---|---|
| Aluminium 6061 (T6) | 2700 | 896 | 167 | ASM Handbook Vol. 2 (Properties of Wrought Aluminum Alloys), 6061-T6 at 25 °C; the same values in MatWeb's 6061-T6 data sheet |
| Aluminium (pure) | 2702 | 903 | 237 | Incropera, DeWitt, Bergman & Lavine, *Fundamentals of Heat and Mass Transfer*, 6th ed., Table A.1 (300 K) |
| Copper (pure) | 8933 | 385 | 401 | Incropera et al., Table A.1 (300 K) |
| Steel (plain carbon, AISI 1010) | 7832 | 434 | 63.9 | Incropera et al., Table A.1 (300 K) |
| Stainless steel 304 | 7900 | 477 | 14.9 | Incropera et al., Table A.1 (AISI 304, 300 K) |
| Brass (70 % Cu, 30 % Zn, cartridge brass) | 8530 | 380 | 110 | Incropera et al., Table A.1 (300 K) |
| FR-4 (circuit board) | 1850 | 1100 | 0.29 | typical laminate data sheet values, through the board's thickness (along the board about 0.8): approximate, use the board maker's data |
| Glass (soda-lime plate) | 2500 | 750 | 1.4 | Incropera et al., Table A.3 (glass, plate (soda lime), 300 K) |
| ABS | 1050 | 1400 | 0.17 | typical moulding-grade data sheet values (ρ 1.04 to 1.06 g/cm³, k 0.14 to 0.19 W/(m·K), cp 1.3 to 1.5 kJ/(kg·K)): approximate |
| PLA | 1240 | 1800 | 0.13 | Farah, Anderson & Langer, "Physical and mechanical properties of PLA, and their functions in widespread applications", Adv. Drug Deliv. Rev. 107 (2016), Table 2 (ρ 1.24 g/cm³, k 0.13 W/(m·K)); cp of amorphous PLA near 20 °C about 1.2 to 1.8 kJ/(kg·K), the upper value taken: approximate |
| Custom solid | Aluminium 6061's | | | the user's own |

## Layout

| Path | What it is |
|---|---|
| `manifest.toml`, `plugin.py` | what the host reads, and `register(hub)` |
| `heat_transfer/analyses.py` | the two AnalysisTypes, their schemas and result fields |
| `heat_transfer/contract.py` | the family, what blocks a run, run models, residual series |
| `heat_transfer/physics.py`, `materials.py`, `bcs.py` | study settings, the fluid model, Thermal BC fields and the new Wall's seed |
| `heat_transfer/runspec.py`, `writer.py`, `functions.py`, `settle.py`, `transient.py` | the case a run writes |
| `heat_transfer/cht.py`, `polymesh.py`, `cht_writer.py`, `cht_functions.py` | a CHT case: its regions from the mesh and the materials, its files and function objects |
| `heat_transfer/cht_ready.py` | what blocks a CHT run |
| `heat_transfer/parser.py`, `results.py`, `cht_results.py`, `monitors.py` | the solver log, monitors and energy balance |
| `heat_transfer/jobs/write_run_case.py` | the run's prepare step (its `LaunchSpec.prepare_job`) |
| `ui/` | the study and run panels' settings |
| `samples/heat-sink/` | the heat-sink sample Home opens (`[[samples]]`; inputs only) |
| `validation/` | the validation set's results (`results.json`) and the script that writes `VALIDATION.md` |
| `tests/` | pytest (writer goldens, contract, results; `-m wsl` the solve proofs; `-m validation` the validation set) |
| `e2e/` | the plugin's browser suite |

## Validation

The validation set compares the plugin with published results: de Vahl Davis's square
cavity at Ra = 10³ to 10⁶, laminar pipes with a fixed wall heat flux and a fixed wall
temperature (Shah & London), a turbulent pipe against Gnielinski's correlation, and the
composite wall and heated block below. Each case runs through the app's own path
(mesher, prepare job, `solve.sh`), Hex-dominant for every case and Standard on the pipes.
The numbers, the setups and the sources: [VALIDATION.md](VALIDATION.md). It has no
tolerance bands, so it stays report-only (the app's validation set locked its own on
2026-11-07); `pytest -m validation` runs it.

The full run of 2026-11-07 (Heat Transfer 0.2.0, OpenFOAM v2606, 8 processes, 34.6 minutes, from
the commit of the app's validation set's second full run), the error against the reference
(± the case's own uncertainty: for the cavity half the gap between its hot and cold walls, for
the pipes the standard error of the slices' mean):

| Case | Reference | Hex-dominant | Standard |
|---|---|---|---|
| Cavity, Ra = 10³ / 10⁴ / 10⁵ / 10⁶: Nu-bar (the mean of the hot and cold walls) | 1.118 / 2.243 / 4.519 / 8.800 | +0.00 / +0.09 / −0.55 / −0.64 ± 0.88 % | |
| The same: Nu_max on the hot wall (y/L 0.01 to 0.99) | 1.505 / 3.528 / 7.717 / 17.925 | +0.13 / −0.17 / −1.37 / −4.83 % (each peak within 0.005 L of the reference's height) | |
| Laminar pipe, fixed wall heat flux: Nu | 4.364 | −0.06 ± 1.45 % | +13.84 ± 0.18 % |
| Laminar pipe, fixed wall temperature: Nu | 3.657 | −0.29 ± 1.75 % | +13.08 ± 0.35 % |
| Turbulent pipe, Re = 50 000 (k-omega SST, wall functions, Spalding's law at the walls), 17.5 to 22.5 D from the inlet: Nu | 106.9 (Gnielinski) | −1.61 % (y+ 14 to 58) | +0.34 % (y+ 54 to 167) |
| Composite wall: heat | 5.338 W | +0.11 % | |
| Heated block: heat out, highest temperature rise | 10 W, 14.60 K | +0.00 %, +0.03 % | |

The cavity's reference is de Vahl Davis's Nu-bar, the cavity's mean Nusselt number; his
hot-wall values Nu_0 are 1.117, 2.238, 4.509 and 8.817, and the hot wall alone read
1.1180, 2.2449, 4.4940 and 8.8200. Standard meshes (tetrahedra) read the heat through walls
up to about 14 % high next to a laminar flow, about 6 % high through a solid's walls (the
boundary gradient of a tetrahedron next to a wall), within 1.5 % in a cavity (the Ra = 10⁵
proof below, meshed by Standard), and the turbulent pipe within 0.4 %; the study panel and
the pre-run check say so for every Heat Transfer study on a Standard mesh, and a new mesh in a
Heat Transfer study starts on Hex-dominant. Use Hex-dominant for heat numbers. Against the run
before it (2026-10-15, Heat Transfer 0.1.0, and the turbulent pipe's two rows of 2026-11-07, run
again after k-omega SST's walls changed) every row moved by at most 0.06 points of its error (the
laminar pipes on Hex-dominant, whose meshes differ from one generate to the next: 124 648 and
124 210 cells against 124 242 and 124 662), the turbulent pipe on Standard +0.03 points (+0.34 %
against +0.31 %, the same 36 219 cells). With the walls before that
(nutkWallFunction) the pipe read about 10 % under Gnielinski's correlation on Hex-dominant
(−7.9 % on a finer mesh, fineness 7, 293 760 cells) and about 20 % under on Standard. Its
slices are 17.5 to 22.5 D after a uniform inlet, where the flow is still developing.

Since that run (probes of 2026-11-06 on OpenFOAM v2606, 8 ranks):

- **The turbulent pipe's shortfall was k-omega SST's wall treatment.** Heat Transfer's walls
  are Incompressible Flow's, and since f7926eb0 they take Spalding's law with stepwise omega
  (the validation set's README, "k-omega SST at the wall"): the pipe's Nu reads -1.61 % on
  Hex-dominant (y+ 14 to 58) and +0.34 % on Standard (y+ 54 to 167), from -9.6 % and -20.5 %
  (the committed rows above, the full run of 2026-11-07; the probe read +0.32 % and the two rows'
  first rerun +0.31 %).
- **The fluid's schemes stay as they are.** Incompressible Flow writes `grad(U)` and the flux
  skew-corrected since f7926eb0, which took its laminar pipe on Standard from f Re +16 % to
  +0.2 %. The same lines in Heat Transfer (`grad(U) Gauss skewCorrected linear`, the limiter on
  `limitedGradU`, `flux((rho*HbyA)) skewCorrected linear`: v2606's buoyant and CHT solvers form
  phiHbyA from `fvc::flux(rho*HbyA)`), with `grad(h) Gauss skewCorrected linear` as well, were
  probed on the validation cases' own meshes, the case re-solved with only its fvSchemes changed
  (re-solved unchanged, the laminar and turbulent pipes on Standard give the app's Nu to four
  digits; the heat sink, still settling at 3000 iterations, is compared with its own unchanged
  re-solve (the app's own run of it carried 10.124 W out):

  | Case | As written | Skew-corrected |
  |---|---|---|
  | Laminar pipe, fixed wall temperature, Standard (139 200 cells, one layer): Nu / f Re | +13.07 % / +15.1 % | +5.15 % / -1.1 % |
  | Laminar pipe, fixed wall heat flux, Standard: Nu / f Re | +13.83 % / +15.1 % | +5.63 % / -1.1 % |
  | Laminar pipes, Hex-dominant (4 layers): Nu, fixed flux / fixed temperature | -0.04 / -0.26 % | -0.30 / -0.58 % (each within its slices' ± 1.5 to 1.8 %) |
  | Turbulent pipe, Hex-dominant: Nu | -1.61 % | -0.94 % |
  | Turbulent pipe, Standard (no layers: tetrahedra at the wall, wall functions): Nu / f | +0.32 % / +2.3 % | -39.3 % / +101 % |
  | de Vahl Davis cavity, Ra = 10⁵, Hex-dominant: Nu-bar / Nu_max | -0.55 / -1.37 % | -0.56 / -1.35 % |
  | Heat sink in a channel (HT5, Hex-dominant, 3000 iterations): heat carried out / sink T_max | 10.002 W / 359.261 K | 9.901 W / 359.713 K |

  (f from the pressure drop over the slices against Petukhov's 0.0210 at Re 50 000, both from
  re-solves; the flow is still developing there.) On the laminar pipe the friction is the velocity gradient and the flux (each alone
  halves its error; Nu moves less than a point), and most of Nu's error is `grad(h)`'s (alone:
  Nu +5.5 %); what is left is not the gradient scheme (least squares +5.0 %), the energy's
  convection (central +4.8 %), the face interpolation (+5.2 %) nor the non-orthogonal correction
  (full: +6.1 %). On the turbulent pipe on Standard every one of the lines reads worse: the flux
  alone Nu -14 % and f +115 %, `grad(U)` alone -20 % and +60 %, `grad(h)` alone -7.7 % and f
  unchanged. Incompressible Flow's own turbulent pipe on Standard with its layers turned off
  (case 2, k-omega SST, Accurate, y+ 41 to 143) reads the same way: f -31 % and f_tau -27 %
  with the schemes before f7926eb0, -62 % and -65 % with its skew-corrected ones (the flux alone
  -44 / -42 %, `grad(U)` alone -35 / -42 %). So the skew-corrected lines help where the wall
  cells are layers and hurt where they are tetrahedra under wall functions (most likely the cell
  gradients the corrections use, which a wall function's profile across the first cell does not
  follow; not probed further), and Heat Transfer keeps its schemes until a set of lines reads
  both right.

## Proofs (HT4)

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

## Proofs (HT5, conjugate heat transfer)

`tests/test_ht5_cht_wsl.py` (`pytest -m wsl`): each case set up as a study, meshed by the
app's mesher and run the way Start runs it (the runner's relay: the plugin's prepare job,
the WSL `splitMeshRegions` step, `solve.sh`), read back through the analysis's own monitors.

| Case | Mesh | Result | Target |
|---|---|---|---|
| Composite wall: steel 10 mm and stainless steel 20 mm side by side, 100 °C and 20 °C on their outer faces | Hex-dominant, 13 634 cells | heat 5.34348 W against 5.33769 W from 1D (+0.11 %); every cell within 0.48 % of ΔT of the 1D profile; balance 0.0001 % | within 1 % |
| The same wall on a Standard mesh | Standard, 195 345 tetrahedra | heat 5.67675 W (+6.35 %; with corrected schemes for the solids, 194 709 cells: +6.97 %); every cell within 0.45 % of ΔT of the profile | the study panel's note (about 6 % high) |
| Heated block: stainless steel 40 × 40 × 10 mm, 10 W, h = 500 W/(m²·K) to 20 °C on its bottom | Hex-dominant, 12 576 cells, one region (no split) | heat out 10.00000 W; T_max 307.752 K against 307.747 K from 1D (rise 0.03 % off) | 1 %, 5 % |
| The same with 625 000 W/m³ | the same | source 9.99988 W (the mesh's volume), heat out 9.99988 W, T_max as above | 1 %, 5 % |
| Heat sink in a channel: aluminium base and 4 fins, 10 W, air at 0.5 m/s and 20 °C, gravity, laminar, 4 ranks | Hex-dominant, 95 902 cells (air 74 893, sink 21 009) | m·cp·ΔT_bulk 10.01280 W against the 10 W source (0.13 %, 4000 iterations; 1.3 % at 1500); the interface takes 9.9996 W; sink T_max 359.215 K (a rise of 66.07 K) | within 2 % |
| Its highest temperature against a finer mesh (forced convection: with gravity the finer mesh resolves an unsteady plume a steady solve does not settle on) | Hex-dominant, 95 902 and 156 123 cells | T_max rise 67.273 K and 66.774 K (+0.75 %); balances 0.28 % and 0.002 % | within 5 % |
| Two separate aluminium blocks (20 × 10 × 20 mm, 40 mm apart), one material with 1 W, in an air channel at 0.5 m/s, gravity off | Hex-dominant, 62 953 cells (air 56 688, aluminium 6 265) | one solid region of two pieces (`splitMeshRegions -cellZonesOnly`: every cell in a region, the interfaces `air_to_aluminium_6061` / `aluminium_6061_to_air`, no `domain<N>`); both blocks at 47 °C; m·cp·ΔT_bulk 0.98809 W (1.19 %) | within 2 % |
| A closed box of air (100 mm, walls at 20 °C, no opening) with a 2 W aluminium block, gravity, perfect gas | Hex-dominant, 17 620 cells | solves; 1.99996 W out through the walls (0.002 %); the block at 142.2 °C | within 2 % |
| The same sink, transient on 2 ranks | the same | 20 steps of 2 ms, frames 0.01 to 0.04 s in both regions, continued to 0.06 s (no split again) | runs, writes frames, continues |
| The composite wall with "Stop when a monitor settles" (the cold face's heat flow within 0.001 W over 20 iterations) | Hex-dominant, fineness 2 | ended at iteration 168 of 2000; the log parser reads it as settled | stops early |

At 0.2 m/s the same sink's steady solve did not settle (the heat carried out swung
between 9.7 and 10.2 W: the plume of a mixed-convection flow at that speed is unsteady);
solve such a case as a transient study.

The app-path e2e (`e2e/ht4-heat-transfer.spec.js`, with `MAGNUSIM_E2E_WSL=1`) meshes and
solves the same cavity through the browser and checks a channel's written case (see the
HT4 report for its numbers). A run stops on its residual target: on the natural-convection
cavity the residuals can reach it while Nu is still creeping towards its settled value. To
stop on the quantity itself, use "Stop when a monitor settles" on a Wall heat flux monitor.
