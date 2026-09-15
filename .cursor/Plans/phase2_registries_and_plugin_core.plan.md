---
name: "Phase 2: Registries and Plugin Core"
overview: "Turn every hard-coded domain concept (analysis type, solver, mesher, BC, material, monitor, result filter) into a registered spec in cfddesk, re-register today's built-ins so behavior is unchanged, extend the Geometry model to multiple bodies/regions, and add entry-point plugin discovery. No UI change."
todos:
  - id: p2-registry-core
    content: "cfddesk/registry/: Registry[T] base, SchemaField -> JSON Schema, PluginManifest, discovery via entry points + plugins/ folder"
    status: completed
  - id: p2-analysis-type
    content: "AnalysisType spec + built-ins incompressible_steady / incompressible_transient; replace PRIMARY_SIM_ANALYSIS and W17 strings"
    status: completed
  - id: p2-solver-backend
    content: "SolverBackend spec + simpleFoam / pimpleFoam (+ amgx variant); residual/courant parsers move here"
    status: completed
  - id: p2-mesh-backend
    content: "MeshBackend spec + standard / cfmesh / snappy_hexdominant; w21 branches collapse to registry lookup"
    status: completed
  - id: p2-bc-material-monitor
    content: "Wrap bc_registry in Registry; MaterialModel spec (newtonian_incompressible); MonitorSpec registry"
    status: completed
  - id: p2-result-filter
    content: "ResultFilter/Exporter spec wrapping tools/export_*.py; registry maps filter key -> tool + params schema"
    status: pending
  - id: p2-geometry-regions
    content: "Geometry gains bodies with roles (fluid/solid) + regions; migration v14; fingerprint unaffected for single fluid body"
    status: pending
  - id: p2-collapse-web-json
    content: "Project becomes the only persisted model; web_adapter reads/writes sim-scoped nodes; sibling *.json become derived mirrors (v15)"
    status: pending
  - id: p2-registry-cli
    content: "tools/registry_dump.py: emits full registry (labels, schemas, requirements) as JSON for Phase 3"
    status: pending
  - id: p2-tests
    content: "Registry tests: all built-ins load, schemas validate defaults, plugin discovery from a temp entry point"
    status: pending
isProject: false
---

# Phase 2: Registries and Plugin Core

## Goal

A plugin author can add a physics type, solver, mesher, BC, material, monitor, or result filter by registering a spec object. Everything the built-in incompressible flow does today goes through the same registries, so there is no privileged code path.

## Findings this phase is built on

### Existing registry to generalize

`cfd-web/python/cfddesk/case/bc_registry.py`:

- `SettingField(key, label, kind: float|int|vector3|bool|choice|text|raw_dict, default, choices, unit, energy_only, rate_kind)` L27-40.
- `BcTypeSpec(key, label, semantic, patch_type, settings_schema, write_U, write_p, write_T, supported)` L47-58.
- `BC_TYPES` dict with 22 keys (velocity_inlet_fixed/volumetric/mean/freestream/mass, velocity_outlet, pressure_inlet_gauge/total, pressure_outlet_gauge/total/mean, wall_noslip/slip/moving/rotating, fan, periodic, natural_convection, symmetry, wedge, empty, custom).
- `bc_menu.py`: `MenuType -> MenuVariant -> subvariants` nested menu, `_LEGACY_MAP`, `registry_key_for_bc`.
- `ras.py` handles turbulence per `SemanticClass`.

### Hard-coded strings to replace

| String | Locations |
|---|---|
| `"Incompressible"` / `"incompressible"` | `project/model.py` L113-114 (`PRIMARY_SIM_NAME/ANALYSIS`), L320-321, L1633-1635, L2256-2257, L2381-2382; `results/filters.py` L937 `SAVE_VIEW_DEFAULT_NAME`; `scripts/w17-simulation.js` `W17_DEFAULTS` L29-38 (`analysis`, `analysis_title`, `category`, `flow_group`, `turbulence_model`, `time_dependency`, `algorithm`, `passive_species`); `src/main.js` L13879-13883, L14677 |
| `simpleFoam` / `pimpleFoam` | after Phase 1: `cfddesk/case/writer.py`, `runner/parallel.py`, `wsl/openfoam.py`, `wsl/templates/solve.sh`, `scripts/w27-solve.js` `path_kind` |
| Turbulence models | `settings.py` L29-36 `TurbulenceModel` Literal (laminar, kEpsilon, kOmegaSST, LRR, SSG); `ras.py`; `initial_conditions.py` L88-94; `numerics.py` L707-711 |
| `MeshAlgorithm` | `settings.py` L24 (`hex-dominant`, `hex-dominant-parametric`, `standard`); `HexcoreBackend` L28 (`cfmesh`, `bodyfit`); `scripts/w20-mesh.js` `MESH_ENGINES = {standard, cfmesh}` L61 and `W20_DEFAULTS.algorithm='Standard'`; `w21-mesh-generate.js` `standardEngine`/`wantsHexDominant` L583-599 |
| `TIME_DEPENDENCIES = {'Steady-state':'SIMPLE','Transient':'PIMPLE'}` | `w17-simulation.js` L70-73 |
| Filter types | `results/filters.py` `FilterSpec` union L863: cut_plane, streamlines, plot_over_path, iso_surface, iso_volume, animation, field_calculator; Node `vite-plugin-case-fields.js` maps each to a `tools/export_*.py` spawn (L455, 813, 901, 997, 1075, 1205, 1285) |
| Materials | `materials/library.py` `LibraryMaterial(key, name, viscosity_model, nu, rho)`, 8 entries; only `nu` reaches `transportProperties` |

### Model shape today

- `Geometry(id, name, step_path, faces, volumes: list[{id,name,face_ids}])` (`hierarchy.py` L57-65). Volumes exist (v7, from `TopAbs_SOLID`) but have no role; all are implicitly fluid.
- `Simulation(id, name, analysis_type: str, geometry_id, boundary_conditions, meshes, runs, solver: SolverSettings, boundary, materials: list[dict], initial_conditions, advanced_concepts, numerics, simulation_control, result_control, active_mesh_id, active_run_id)` L180-199. `analysis_type` is a free string always `"incompressible"`.
- `PROJECT_VERSION = 13`; upgrades `_upgrade_to_v7.._v13` run sequentially in `from_dict` L1487-1500; `save` snapshots `project.json.v{N}.bak` on bump.
- Web JSON siblings (`materials.json`, `boundary_conditions.json`, `mesh.json`, `mesh_refinements.json`, `result_controls.json`, `simulation_control.json`, `simulations.json`, `runs/catalog.json`) are the UI's actual source of truth; `project.json` gets stamped summaries. Phase 1 moved the writes into `tools/project_cli.py` but kept the file layout.

## Package layout to create

```
cfddesk/registry/
  __init__.py          # get_registry(kind), load_all(), reset_for_tests()
  base.py              # Registry[T], RegistryError, Spec protocol (key, label, plugin)
  schema.py            # SchemaField (superset of SettingField), to_json_schema(fields), validate(values, fields)
  manifest.py          # PluginManifest(key, name, version, requires: list[Requirement], provides: dict[str, list[str]], ui: UiManifest|None)
  discovery.py         # entry points "cfddesk.plugins" + <web_root>/plugins/*/manifest.toml; ordering; disable list from .cfddesk-local.json
  requirements.py      # Requirement(kind: "wsl_tool"|"python"|"gpu", name, version_spec); check_requirements(manifest, env) -> list[Missing]
  analysis.py          # AnalysisType spec
  solver.py            # SolverBackend spec
  mesher.py            # MeshBackend spec
  material.py          # MaterialModel spec
  monitor.py           # MonitorSpec
  result_filter.py     # ResultFilterSpec
  bc.py                # re-export BcTypeSpec through Registry
cfddesk/builtin/
  __init__.py          # register_builtins() called by load_all()
  incompressible.py    # AnalysisType x2
  solvers_openfoam.py  # simpleFoam, pimpleFoam, amgx variant
  meshers.py           # standard, cfmesh, snappy_hexdominant
  materials.py         # newtonian_incompressible (+ library entries)
  monitors.py          # area_average, flow_rate
  filters.py           # cut_plane, streamlines, plot_over_path, iso_surface, iso_volume, inspect_point, field (surface)
```

## Step 1: Registry core

`base.py`:

```python
class Registry(Generic[T]):
    kind: str
    def register(self, spec: T, *, plugin: str = "builtin") -> None   # error on duplicate key unless same plugin re-registering in tests
    def get(self, key: str) -> T
    def keys(self) -> list[str]; def items(self) -> list[T]
    def describe(self) -> list[dict]   # {key, label, plugin, schema: json_schema, requires, supported}
```

`schema.py`: `SchemaField` = `SettingField` + `min`, `max`, `step`, `depends_on: dict[str, Any] | None` (show when other field equals), `group`, `advanced: bool`, `quantity: Quantity | None` (ties into `units/quantities.py` for display units). `to_json_schema(fields)` produces JSON Schema draft-2020-12 with `x-cfddesk` extensions (`unit`, `quantity`, `group`, `depends_on`, `advanced`). `validate(values, fields)` returns errors list; used by `project_cli.py` before persisting.

`bc_registry.SettingField` becomes an alias of `SchemaField` (keep name for back-compat).

## Step 2: `AnalysisType`

```python
@dataclass(frozen=True)
class AnalysisType:
    key: str                       # "incompressible_steady"
    label: str                     # "Incompressible Fluid Flow"
    category: str                  # "FLUID DYNAMICS"
    time_dependency: Literal["steady","transient"]
    fields: tuple[str, ...]        # ("U","p","k","omega","nut")
    turbulence_models: tuple[str, ...]
    default_turbulence: str
    bc_types: tuple[str, ...]      # allowed bc_registry keys
    material_models: tuple[str, ...]
    solver_backends: tuple[str, ...]
    default_solver: str
    monitors: tuple[str, ...]
    result_fields: tuple[ResultField, ...]   # ResultField(key, label, unit_quantity, kind: scalar|vector)
    settings_schema: tuple[SchemaField, ...] # per-analysis (e.g. energy on/off, passive species count)
    numerics_schema: tuple[SchemaField, ...]
    control_schema: tuple[SchemaField, ...]  # endTime, writeInterval, transient block
    region_roles: tuple[str, ...] = ("fluid",)   # which body roles this analysis needs
    write_case: Callable[[CaseContext], None]     # writes 0/ constant/ system/
    validate: Callable[[Project, Simulation], list[str]]
    parse_log_line: Callable[[str], Event | None] | None = None   # solver-specific residual lines
    requires: tuple[Requirement, ...] = ()
```

`CaseContext(project, simulation, geometry, mesh_case_dir, out_dir, n_procs, run_spec)` bundles what Phase 1's `prepare_run.py` computed.

Built-ins in `builtin/incompressible.py`: `incompressible_steady` (`write_case` = Phase 1 steady path) and `incompressible_transient` (pimple path). `W17_DEFAULTS` in `w17-simulation.js` is replaced by `GET` of the registry description (Phase 3) Ã¢â‚¬â€ for Phase 2, keep the JS defaults but derive them from `tools/registry_dump.py` output committed as `scripts/generated/registry.json` (regenerated by an npm script) so there is one source.

`Simulation.analysis_type` stays a string but must be a registered key; `Project.from_dict` v14 migration maps `"incompressible"` -> `"incompressible_steady"` or `"incompressible_transient"` by `solver.mode` / `simulation_control.transient`.

## Step 3: `SolverBackend`

```python
@dataclass(frozen=True)
class SolverBackend:
    key: str                          # "simpleFoam", "pimpleFoam", "simpleFoam_amgx"
    label: str
    application: str                  # binary name
    time_dependency: Literal["steady","transient"]
    parallel: Literal["mpirun","none"]
    stop_strategy: Literal["stopAt_writeNow","sigterm"]
    residual_line: Callable[[str], dict | None]    # from Phase 1 solve_run parsers
    extra_lines: Callable[[str], dict | None] | None   # Courant etc.
    write_fv_solution: Callable[[CaseContext], None]
    write_control_dict: Callable[[CaseContext, str], None]   # functions_text
    script_template: str = "solve.sh"
    requires: tuple[Requirement, ...] = (Requirement("wsl_tool","simpleFoam"),)
```

`runner/parallel.py` `mpirun_simplefoam_inner` becomes generic over `application`. `wsl/templates/solve.sh` already takes `{{APP}}`.

## Step 4: `MeshBackend`

```python
@dataclass(frozen=True)
class MeshBackend:
    key: str                # "standard", "cfmesh", "snappy_hexdominant"
    label: str              # "Standard", "cfMesh cartesianMesh (legacy)", "Hex-dominant"
    settings_schema: tuple[SchemaField, ...]    # fineness, hex_element_core, add_layers, physics_based, small_feature_suppression, gap_refinement_factor, global_gradation_rate, ...
    refinement_types: tuple[str, ...]           # from mesh_refinements.REFINEMENT_MENU_BY_ALGORITHM
    tool: str                                   # "generate_standard.py" etc. (Phase 3 makes this a callable)
    fingerprint_payload: Callable[[MeshSettings, Project], dict]  # algo-specific part of _mesh_settings_fingerprint_payload L1799-1871
    supports_hex_core: bool
    requires: tuple[Requirement, ...]           # cfmesh -> Requirement("wsl_tool","cartesianMesh")
    frozen: bool = False                        # cfmesh: True (hexcore-cfmesh-backup rule)
```

`w21-mesh-generate.js` `standardEngine`/`wantsHexDominant`/`isStandard` (L570-599) collapse to `settings.mesh_backend` key lookup via `scripts/generated/registry.json`. `w20-mesh.js` `MESH_ENGINES` reads the same file. Keep the `hex_element_core` + `mesh_engine=cfmesh` -> `cfmesh` mapping as a migration rule (v14) so existing `mesh.json` documents resolve.

Constraint (workspace rule): cfMesh path stays registered and callable; `HEXCORE-PROCESS-BACKUP-2026-09-02/` untouched.

## Step 5: BC, Material, Monitor registries

- `registry/bc.py`: `BC = Registry[BcTypeSpec]("bc")`; `bc_registry.BC_TYPES` becomes a view over it; `get_type`, `type_labels`, `default_settings` delegate. `bc_menu.MENU` gains a `plugin` field so plugin BCs appear under a plugin-owned menu type. `BcTypeSpec` gains `fields_written: tuple[str, ...]` (e.g. `("U","p")`, `("T",)`) and `write_field: dict[str, WriterFn]` generalizing `write_U/write_p/write_T` so a CHT plugin can write `T` or a species field without a new attribute per field. Keep the three named attributes as properties.
- `registry/material.py`:
  ```python
  @dataclass(frozen=True)
  class MaterialModel:
      key: str; label: str
      properties_schema: tuple[SchemaField, ...]     # nu, rho (incompressible); cp, kappa, ... (thermal)
      write_files: Callable[[CaseContext, dict], None]   # transportProperties / thermophysicalProperties
      library: tuple[dict, ...]                       # presets (air, water, ...) from materials/library.py
  ```
  Built-in `newtonian_incompressible`.
- `registry/monitor.py`: `MonitorSpec(key, label, target: Literal["patch","point","volume","line"], fields_schema, write_function_object(ctx, target_ref, write_control_text) -> str, parse_dat(text) -> Series)`. Built-ins `area_average` (`mon_<patch>`), `flow_rate` (`flow_<patch>`) from Phase 1's `function_objects.py`; the `.dat` parser from `w27.parseSurfaceFieldValueDat` (moved to `surface_averages.py`).

## Step 6: `ResultFilter`

```python
@dataclass(frozen=True)
class ResultFilterSpec:
    key: str                  # "cut_plane", "streamlines", "iso_surface", "iso_volume", "plot_over_path", "inspect_point", "surface_field", "mesh_surface", "mesh_section"
    label: str
    params_schema: tuple[SchemaField, ...]
    tool: str                 # tools/export_*.py
    cache_scope: Literal["case_time","case"]      # matches vite-plugin cache dirs
    output: Literal["vtp","json"]
    model: type | None        # results/filters.py dataclass for persistence
```

Node `vite-plugin-case-fields.js` keeps its seven hand-written handlers this phase (Phase 3 replaces them with a generic `/api/filter/<key>` that reads this registry).

## Step 7: Geometry bodies and regions (v14)

`hierarchy.py`:

```python
@dataclass class Body:   id: str; name: str; face_ids: tuple[int,...]; role: Literal["fluid","solid","void"] = "fluid"; region: str = "fluid"
Geometry.bodies: list[Body]      # replaces volumes; `volumes` kept as read-only alias
Geometry.regions() -> dict[str, list[Body]]
```

- v14 upgrade: `volumes -> bodies(role="fluid", region="fluid")`. Mesh fingerprint must **not** change for single-fluid projects: `_mesh_fingerprint_payload` includes bodies only when any body has `role != "fluid"` or more than one region exists.
- BCs gain optional `region: str | None` (None = all/fluid). Materials `volume_ids` -> `body_ids` with alias.
- `AnalysisType.region_roles` lets `validate()` reject e.g. CHT when no solid body.
- Meshers: `MeshBackend.multi_region: bool`; built-ins all `False` this phase; `validate` rejects multi-region meshing until Phase 6 provides it.

## Step 8: Collapse web JSON into `Project` (v15)

Goal: one persisted model. `Project.simulations[i]` already has `materials`, `boundary_conditions`, `meshes[].settings`, `meshes[].refinements`, `result_control`, `simulation_control`, `runs`. The sibling JSON files are the UI's copy.

1. `web_adapter.py` (Phase 1) gains `to_web_*` / `from_web_*` for each sibling so `project_cli.py` subcommands write **`Project`** and then regenerate the sibling files as mirrors (read-only for Node/UI).
2. v15 migration: on load, if sibling files are newer than `project.json` (compare `updated_at`), ingest them once, then mark `project.json.persistence.web_mirrors="derived"`.
3. `runs/catalog.json` and `runs/run-*.json` -> `Simulation.runs[]` with `RunNode.settings_snapshot` holding the Phase 1 run record fields; keep files as mirrors for the media panel and result loaders that read `case_dir`.
4. Node reads either; nothing in Node writes siblings after this step (Phase 1 lint guard extended to include sibling filenames).

## Step 9: Discovery

- `discovery.py`: `importlib.metadata.entry_points(group="cfddesk.plugins")`; each entry point is a callable `register(reg: RegistryHub) -> PluginManifest`. Also scan `<web_root>/plugins/*/manifest.toml` + `plugin.py` for local dev (`web_root()` from `wsl/config.py`).
- `.cfddesk-local.json` gains `plugins: {disabled: [...]}`.
- `requirements.check_requirements(manifest, env)` where `env` is built from `.cfddesk-local.json` (`openfoam_version`, `cfmesh_version` from Phase 0 step 8) plus `which`-style probes cached per session: `wsl -d <distro> -- openfoam2606 bash -c 'command -v <tool>'`.
- `load_all()` is idempotent; called by every `tools/*.py` entry and by `project_cli.py`. Failing plugin import logs an `error` event and continues (never breaks built-ins).
- `tools/registry_dump.py [--check-requirements]` prints `{analysis:[...], solver:[...], mesher:[...], bc:[...], material:[...], monitor:[...], filter:[...], plugins:[manifests], missing:[...]}`.

## Step 10: Replace hard-coded sites

- `model.py`: `PRIMARY_SIM_ANALYSIS` -> `registry.analysis.default_key()`; `PRIMARY_SIM_NAME` -> spec label; `filters.py` `SAVE_VIEW_DEFAULT_NAME` built from label + run name.
- `settings.py` `TurbulenceModel`, `MeshAlgorithm`, `HexcoreBackend` Literals -> `str` validated against registries (keep Literal aliases for typing).
- `w17-simulation.js`, `w20-mesh.js`, `w21-mesh-generate.js`: read `scripts/generated/registry.json` (generated by `npm run gen:registry` -> `python tools/registry_dump.py > scripts/generated/registry.json`; add to `start.bat` and Setup).

## Tests

`tests/unit/test_registry.py`:
- `load_all()` registers exactly the built-in keys listed above; `describe()` JSON schemas validate their own defaults (`jsonschema` dev dep).
- Duplicate key from a second plugin raises `RegistryError`.
- Temp plugin: write `plugins/testplug/manifest.toml` + `plugin.py` registering an `AnalysisType("laminar_only")`; `load_all()` picks it up; `check_requirements` reports a fake missing tool.
- `Project.from_dict(v13 fixture)` -> v15; `analysis_type in registry`; bodies derived; mesh fingerprint unchanged vs v13 value stored in fixture.
- Every `AnalysisType.write_case` for built-ins produces goldens identical to Phase 1.

## Acceptance criteria

- `grep -rn "incompressible\|kOmegaSST\|simpleFoam" cfddesk/ --include=*.py` matches only `cfddesk/builtin/` and registry docstrings.
- `w17`, `w20`, `w21` contain no literal analysis/mesher/solver names; they read `scripts/generated/registry.json`.
- UI behavior unchanged (Playwright smoke + solve smoke green; goldens green).
- A 30-line demo plugin in `plugins/example/` registers a new `AnalysisType` and appears in `registry_dump.py` output (UI exposure is Phase 4/5).
