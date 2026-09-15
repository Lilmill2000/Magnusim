---
name: "Phase 6: CHT as the First Real Plugin"
overview: "Build cfddesk-cht: a conjugate heat transfer analysis type on chtMultiRegionFoam with multi-region meshing, coupled-wall boundary conditions, thermal material models, temperature results, and region-aware monitors. Use it to stress and then stabilize the registry API, and record what later physics plugins (reacting, radiation, motion, structural) will need."
todos:
  - id: p6-multiregion-geometry
    content: "Geometry: bodies with fluid/solid roles from STEP compounds; region assignment UI; contact face detection (shared faces between bodies)"
    status: pending
  - id: p6-multiregion-mesh
    content: "MeshBackend multi_region: mesh each region with the Standard backend; splitMeshRegions / mergeMeshes; region polyMesh layout under constant/<region>"
    status: pending
  - id: p6-analysis-cht
    content: "AnalysisType cht_steady / cht_transient: fields per region (fluid: U p_rgh T k omega alphat; solid: T), regionProperties, per-region fvSchemes/fvSolution/g"
    status: pending
  - id: p6-thermal-materials
    content: "MaterialModel thermo_fluid (rhoConst|perfectGas, cp, kappa, mu) and thermo_solid (rho, cp, kappa); thermophysicalProperties writers"
    status: pending
  - id: p6-bcs
    content: "BC types: temperature_fixed, heat_flux, convective_htc, coupled_wall (compressible::turbulentTemperatureCoupledBaffleMixed) generated automatically for contact faces"
    status: pending
  - id: p6-solver
    content: "SolverBackend chtMultiRegionFoam / chtMultiRegionSimpleFoam; region-aware residual parser; decomposePar -allRegions"
    status: pending
  - id: p6-results
    content: "Result loading per region (OpenFOAMReader multi-region), T colormaps, heat flux monitor (wallHeatFlux FO), region selector in Filters"
    status: pending
  - id: p6-installer
    content: "Requirement checks (chtMultiRegionFoam present in openfoam2606-default); docs for install"
    status: pending
  - id: p6-api-fixes
    content: "Collect registry API gaps hit during the build; fix in core with API_VERSION minor bump; update compatibility.md"
    status: pending
  - id: p6-roadmap-next
    content: "Write docs/plugins/next-physics.md: what reacting flow, radiation, motion (dynamicMesh/MRF), structural (CalculiX) each require from core"
    status: pending
isProject: false
---

# Phase 6: CHT as the First Real Plugin

## Why CHT first

It touches every extension point at once: multiple bodies and regions (geometry model), multi-region meshing, a new solver family, new fields (T, p_rgh, alphat), new BC semantics (coupled interfaces that are generated rather than user-assigned), thermal material properties, and region-aware post-processing. If the registry API survives CHT, reacting flow and radiation are incremental.

## Prerequisites and known gaps

- Phase 2 gave `Geometry.bodies[].role/region` and `AnalysisType.region_roles`, but all built-in meshers are `multi_region=False` and `validate()` rejects multi-region. This phase fills that in.
- Standard mesher (`cfddesk/mesh/standard_hexcore.py`) assumes one fluid solid: `load_step` -> `LoadedSolid` with faces + volumes; `emit_all_patches` names patches from BCs; `gmsh_standard.run_gmsh_surface_mesh` produces physical groups per patch. Multi-body STEP already loads (`cad/io.py` `compound_shapes`, `enumerate_volumes`).
- `openfoam2606-default` (installed by `setup/wsl-bootstrap.sh`) ships `chtMultiRegionFoam` and `chtMultiRegionSimpleFoam` (ESI v2606: `chtMultiRegionFoam` handles both with `steadyState` ddt; keep both keys registered and check with `command -v`).
- `results/loader.py` `read_foam_grid` uses pyvista `OpenFOAMReader`; multi-region needs `reader.enable_all_patch_arrays()` and per-region selection (`reader.cell_regions`/`set_active_regions` in pyvista ≥0.43 exposes `all_patch_arrays`; verify on the pinned version).

## Plugin layout

```
plugins/cfddesk-cht/
  manifest.toml   (key="cht", requires.wsl_tools=["chtMultiRegionFoam","splitMeshRegions","topoSet"])
  src/cfddesk_cht/
    __init__.py         register()
    geometry.py         contact_faces(bodies) -> list[ContactPair]; region names
    mesher.py           MultiRegionStandard(MeshBackend)
    analysis.py         cht_steady, cht_transient
    materials.py        thermo_fluid, thermo_solid + presets (air, water, aluminium, copper, steel)
    bcs.py              temperature_fixed, heat_flux, convective_htc, coupled_wall, adiabatic
    solver.py           chtMultiRegionFoam backend + parser
    monitors.py         wall_heat_flux, region_average_T
    filters.py          region-aware surface_field / cut_plane wrappers
    case/               writers: regionProperties, g, per-region fvSchemes/fvSolution/thermophysicalProperties/turbulenceProperties, 0/<region>/{T,U,p,p_rgh,k,omega,alphat}
    templates/          cht_solve.sh (decomposePar -allRegions, mpirun chtMultiRegionFoam -parallel, reconstructPar -allRegions)
    tools/              export_region_field.py
    ui/                 region badges in tree, contact-face inspector (optional; try schema-only first)
  tests/
```

## Step 1: Multi-region geometry

- `geometry.contact_faces(solid: LoadedSolid) -> list[ContactPair(body_a, body_b, face_ids_a, face_ids_b)]`: OCCT `BRepAlgoAPI_Section` / `BRepExtrema_DistShapeShape` between body pairs; faces coincident within tolerance are contacts. Store in `Geometry.contacts` (core change: add field, v16 migration, no fingerprint impact when empty).
- Geometry panel (Phase 4 `GeometryPanel`): role select per body (fluid/solid) and region name; default: bodies whose name contains "solid|wall|pipe" -> solid, else fluid. Persist via `geometry.update`.
- `AnalysisType.validate` for CHT: ≥1 fluid and ≥1 solid body; every solid has at least one contact.

## Step 2: Multi-region meshing

`MultiRegionStandard(MeshBackend)` with `multi_region=True`:

1. For each region: build a `LoadedSolid` view containing only that body's faces; run `standard_hexcore.build_standard_msh` with patches = user BCs on that body + auto `contact_<a>_<b>` patches for contact faces + `<region>_walls` default.
2. `gmshToFoam` each region into `constant/<region>/polyMesh` on WSL (template `cht_mesh.sh`), then `checkMesh -region <r>`.
3. Alternative single-mesh route for a later iteration: mesh union with `cellZones` per body and `splitMeshRegions -cellZones -overwrite`. Start with per-region meshing because the Standard mesher already works per solid and conformal interfaces are not required for `mappedPatch`-based CHT coupling (uses AMI-style nearest mapping).
4. Fingerprint: `fingerprint_payload` includes per-region settings and contacts.
5. `MeshSettings` gets `per_region_overrides: dict[str, dict]` (schema via `SchemaField` with `group="Regions"`).
6. `mesh.result` records per-region cell counts; `MeshInspect` shows a table.

Core changes required: `MeshBackend.multi_region`, `CaseContext.regions`, `mesh_run` helpers accepting `-region`. Copy-back and `.foam` marker unchanged.

## Step 3: Analysis type

`cht_steady` (`chtMultiRegionFoam` with `steadyState`) and `cht_transient`:

- `fields`: fluid `U p p_rgh T k omega alphat nut`; solid `T`.
- `region_roles=("fluid","solid")`.
- `settings_schema`: gravity vector, reference pressure, buoyancy on/off (`p_rgh` vs `p`), radiation off (reserved).
- `write_case(ctx)`:
  - `constant/regionProperties` (`regions (fluid (f1) solid (s1 s2))`).
  - `constant/g`.
  - per fluid region: `thermophysicalProperties` (from material), `turbulenceProperties` (reuse `ras.write_turbulence_properties` with compressible model names `kOmegaSST`), `fvSchemes`, `fvSolution` (`p_rgh` PCG/GAMG, `h|e` PBiCGStab, `PIMPLE`/`SIMPLE` blocks per time dependency), `0/<region>/*`.
  - per solid region: `thermophysicalProperties` (`heSolidThermo`), `fvSchemes`, `fvSolution`, `0/<region>/T`.
  - `system/controlDict` with `functions` from monitors; `system/decomposeParDict` + per-region copies.
- `parse_log_line`: `Solving for <region>:<field>` lines -> `residual` events with `region`.

## Step 4: Thermal materials

- `thermo_fluid`: schema `equation_of_state: rhoConst|perfectGas`, `rho`, `cp`, `mu`, `Pr`, `molWeight`; writer -> `thermophysicalProperties` (`heRhoThermo`, `pureMixture`, `const` transport, `hConst`). Presets: air, water.
- `thermo_solid`: `rho`, `cp`, `kappa` (isotropic); writer -> `heSolidThermo`, `constIso`. Presets: aluminium, copper, steel, PLA.
- Materials panel already lists models from registry; body picker restricts by role (`MaterialModel.roles=("fluid",)|("solid",)` — core addition).

## Step 5: Boundary conditions

- `temperature_fixed` (T `fixedValue`), `heat_flux` (`externalWallHeatFluxTemperature` mode `flux`), `convective_htc` (`externalWallHeatFluxTemperature` mode `coefficient` with `h`, `Ta`), `adiabatic` (`zeroGradient`), `coupled_wall` (`compressible::turbulentTemperatureCoupledBaffleMixed` with `Tnbr T`, `kappaMethod fluidThermo|solidThermo`) written for both sides of each contact automatically by `write_case`; user cannot delete them but can inspect (`BcTypeSpec.auto_generated=True`, core addition).
- Existing inlet/outlet BC types gain `write_T` (inlet `fixedValue`, outlet `inletOutlet`) and `write_field["p_rgh"]`/`["alphat"]` — via the Phase 2 generalized `write_field` map. Core `bc_registry` built-ins are extended by the plugin through `hub.bc.extend(key, field, writer)` (core addition: allow plugins to add field writers to existing BC types).

## Step 6: Solver backend and script

- `SolverBackend(key="chtMultiRegionFoam", application="chtMultiRegionFoam", parallel="mpirun", stop_strategy="stopAt_writeNow", script_template="cht_solve.sh")`.
- `cht_solve.sh`: `decomposePar -allRegions -force`, `mpirun -np N chtMultiRegionFoam -parallel`, live `reconstructPar -allRegions -time <t>`; same `CFDDESK_EVENT` lines as `solve.sh`.
- `kill` reuses `runner/parallel.kill_mpirun_tree`.

## Step 7: Results

- `results/loader.py`: `load_foam_case(..., region: str | None)`; `export_case_field.py` gains `--region`. `ResultFilterSpec.params_schema` for built-in filters gains optional `region` when `analysis.regions > 1` (core: filter params may be extended by analysis type -> `AnalysisType.filter_param_extensions`).
- Filters panel: region selector (from `runs.regions` RPC).
- Monitors: `wall_heat_flux` (`wallHeatFlux` FO, parses `postProcessing/wallHeatFlux/<t>/wallHeatFlux.dat`), `region_average_T` (`volFieldValue`). Graphs panel handles new quantity units via `ResultField.unit_quantity` (`temperature`, `heat_flux` added to `units/quantities.py`).
- Colormaps: T uses a diverging/“thermal” preset; add `lut.ts` presets keyed by quantity.

## Step 8: Installer and requirements

- `requires.wsl_tools` checked at load; Plugin Manager shows missing tools with the apt hint.
- `setup/wsl-bootstrap.sh` unchanged (`openfoam2606-default` includes CHT solvers); verify with `openfoam2606 bash -c 'command -v chtMultiRegionFoam'` in Phase 0's `verifyWslToolchain`.

## Step 9: Core API fixes discovered here (expected list, to be confirmed)

- `Geometry.contacts`, `Body.role` UI, `MaterialModel.roles`, `BcTypeSpec.auto_generated`, `hub.bc.extend`, `MeshBackend.multi_region`, `CaseContext.regions`, `AnalysisType.filter_param_extensions`, `Event.region`, per-region job progress.
- Each lands in core with tests, `API_VERSION` minor bump (`1.1`), entries in `compatibility.md`.

## Step 10: Next-physics notes

`docs/plugins/next-physics.md` records, per future plugin, what core must offer:

- **Reacting flow** (`reactingFoam`): species fields `Y_<name>` (variable field lists -> `AnalysisType.fields` may be a callable of settings), `thermo.compressibleGas` + `reactions` files (material model with a mechanism editor -> custom UI widget), inlet species BCs (BC settings schema depends on species list -> dynamic schema).
- **Radiation** (`fvDOM`/`P1` via `radiationProperties`): an “analysis add-on” concept (`AnalysisAddon` registry that mutates `write_case` output and adds fields like `G`, `qr`) rather than a new analysis type.
- **Motion** (MRF zones, `dynamicMeshDict` solid-body motion): mesh zones from bodies (`cellZone` per body), time-varying BCs (table inputs -> `SchemaField.kind="table"`), `MRFProperties` writer.
- **Structural** (`solidDisplacementFoam` in OpenFOAM, or CalculiX via `ccx`): non-OpenFOAM `SolverBackend` (`script_template` + custom parser + result converter to VTU); loads/constraints as BC types on solid bodies; results loader for `.frd` -> VTP. Requires `SolverBackend.result_loader` hook and the installer to provision `calculix-ccx` in WSL.

## Tests

- Unit: contact detection on a two-body STEP fixture (pipe in box); `write_case` goldens for a 1-fluid/1-solid case; region parser.
- WSL-marked: mesh both regions at F=1, run 10 iterations of `chtMultiRegionFoam`, assert `T` exists in both regions and `wallHeatFlux.dat` non-empty.
- Playwright: create CHT simulation, assign roles, materials per body, add temperature BC, mesh, run, view T on a cut plane with region selector.

## Acceptance criteria

- `pip install plugins/cfddesk-cht` + restart exposes “Conjugate Heat Transfer” in the Simulation picker; full pipeline works on a two-body STEP.
- No plugin code paths inside `cfddesk/` core other than the generic hooks listed in Step 9.
- `API_VERSION 1.1` documented; both Phase 5 demo plugins still load unchanged.
- `next-physics.md` written and reviewed.
