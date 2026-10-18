# Writing a Magnusim plugin

A plugin adds or replaces one aspect of the workbench. Drop a folder in `plugins/` or install a wheel that publishes a `cfddesk.plugins` entry point, then restart. The host loads `register(hub)` for Python and, when the manifest names a UI bundle, `register(host)` for the page.

Start with `npm run plugin:new -- <key> [--workspace|--analysis]` from `magnusim-web/` ([GUIDE.md](GUIDE.md), "Quick start"). It writes a plugin that passes `npm run plugin:check`, with its tests. `templates/plugin/` and `templates/plugin-workspace/` are what it is made from: read them as examples, do not copy them (their keys are not yours).

## Manifest 1.8

```toml
key = "my-plugin"
name = "My plugin"
version = "0.1.0"
api_version = "1.8"
license = "GPL-3.0-or-later"
description = "What this plugin adds"
authors = "Your Name"
requires_plugins = ["incompressible_flow>=1.0"]
ui = "ui"
ui_entry = "index.js"
```

`api_version` must share the host major version (`1`). A different major is listed as `incompatible` and is not registered. `authors` is a comma-separated list when you have more than one. Omit `ui` when the plugin has no browser bundle. `license` is an SPDX identifier and is shown in Settings → Plugins. The manifest `key` must be the plugin's folder name: `plugin:check` (rule `key`) refuses any other.

`overrides` is a comma-separated list of `kind:key` tokens. A plugin may replace a protected builtin only when that token is listed. New keys do not need an override.

`requires_plugins` lists the plugins yours builds on, as `key` or `key>=version`. They load first; when one is missing, off, or too old, your plugin is not loaded and Settings → Plugins says which one it needs. Declare `incompressible_flow` when you clone or extend `incompressible_steady` / `incompressible_transient`: those simulation types come from the bundled Incompressible Flow plugin, not from the core.

Plugins that ship with the app live in `bundled-plugins/` and add `tier = "bundled"`, `required = true|false` and `protected = ["kind:key", ...]` (specs other plugins may not drop). A required plugin cannot be turned off. An optional one can ship off with `default_enabled = false`: nothing of it runs, and existing projects look unchanged, until someone turns it on in Settings → Plugins. See `compatibility.md` for what changed in each API version.

A wheel's entry point belongs in `pyproject.toml` once the register function is importable:

```toml
[project.entry-points."cfddesk.plugins"]
my-plugin = "my_plugin.plugin:register"
```

Use your own package name (the template maps its folder to `magnusim_plugin_template`). A bare `plugin:register` would collide with every other plugin built the same way.

Folder discovery loads `plugins/<folder>/plugin.py` and does not need that table.

## Register

`register(hub)` runs after the builtins and the bundled plugins. Clone a spec that is already on the hub and register it under a new key:

```python
from dataclasses import replace

from cfddesk.registry.manifest import PluginManifest


def register(hub):
    steady = hub.registry("analysis").get("incompressible_steady")
    spec = replace(steady, key="my_steady", label="My steady")
    hub.registry("analysis").register(spec, plugin="my-plugin")
    return PluginManifest(key="my-plugin", name="My plugin", version="0.1.0")
```

Hooks use the same module. `get_hooks().on("case.written", fn, plugin="my-plugin")` runs after the case files exist. `ctx.out_dir` is the case directory.

Do not import `cfddesk.builtin`, `scripts`, or `src.workbench`. Those are host internals. The public surface is `cfddesk.registry` and `magnusim_sdk` (OpenFOAM dictionary and field writers, units, job events, gmsh helpers, the MSH 2.2 writer, and `run_exe` for programs with a timeout). `tools/plugin_boundary.py` checks this.

The check reads every `.py` and `.pyw` file of the plugin except those in `tests/`, `node_modules/`, `__pycache__/`, `site-packages/`, dot folders (`.venv`, `.git`, caches), `*.egg-info`, any virtualenv (a folder holding `pyvenv.cfg`), and `build/` or `dist/` at the plugin root, so a plugin may carry a JavaScript toolchain or a local venv. Plugin code must not import from those folders: the check follows each import segment by segment and reports one that reaches a skipped folder, and its report lists what it skipped. A compiled `.pyc` outside `__pycache__/` is refused (ship sources), and a file that is not valid Python 3 is reported, not skipped. A plugin's own ruff config may use `extend-exclude`, never `exclude` (that would replace the default list and lint `node_modules`).

**Your own environment's packages.** A plugin with a `[python]` environment (below) may also import the packages its lock pins, but only in code that runs on that environment:

- its service module;
- its job tools registered with `python="plugin"`;
- its own modules that only those two import.

Code the host loads keeps the rule above: `plugin.py`, every module it imports (with `from pkg import *`, the submodules `pkg.__all__` names), every log parser module a `LogParserRef` names (the core imports it on its own Python), and job tools that run on the core's Python. A module that both sides import counts as host code. The check places a job only when `JobKind(...)` goes straight into `hub.register_job(...)` with its tool path and `python=` as plain strings, and a log parser only when its module is a plain string. If host code registers a job or names a log parser any other way (a variable, a loop, `dataclasses.replace`, an alias of `JobKind`, `setattr`), nothing counts as environment code.

To know what a lock provides, the check reads the built environment's `top_level.txt` and `RECORD` files. Without a built environment, it uses each package's normalized name plus a short table of known differences (`scikit-learn` is `sklearn`, `pillow` is `PIL`: `IMPORT_NAMES` in `tools/plugin_boundary.py`). A lock never provides `cfddesk`.

`importlib.import_module("x")` and `__import__("x")` count as `import x`, whether called by those names, through `from importlib import import_module as im` or `from importlib import *`, or as `<anything>.import_module(...)`. A relative name is read against `import_module`'s `package` (a string or `__package__`) or, for `__import__`, the file's own package. These are errors, because the check cannot tell what they load: such a call whose module name, package, level, globals or fromlist is not written out; an import function used other than as a direct call (`im = importlib.import_module`, `getattr(importlib, "import_module")`); `exec`, `eval` and `compile`; `runpy.run_module`/`run_path`; and a loader's `exec_module`. Relative imports in `plugin.py` are errors too: the host runs it as `cfddesk._bundled.<folder>`, so `.` and `..` there are the core's packages. Elsewhere, a relative import that climbs above the plugin's top-level package is an error. Nothing turns the check off for a line.

## Own environment and service (1.1)

A plugin that needs Python packages the app does not ship (NeuralFoil, a CAD kernel, ...) declares its own environment. Its backend then runs there, in its own process, and never in the core:

```toml
[python]
requirements = "requirements.lock"   # pinned, with hashes
python = ">=3.10,<3.13"              # the interpreters it supports
service = "my_plugin_service"        # its backend module (optional)
find_links = "wheels"                # a folder of wheels in the plugin, to install offline (optional)
```

- **The lock** lists every package, pinned and hashed (`pip-compile --generate-hashes`, or `name==1.2.3 --hash=sha256:...` lines); pip installs it with `--require-hashes`, wheels only. Editing the lock changes its hash, and the plugin shows "Needs setup" again.
- **Settings → Plugins** shows the plugin as "Needs setup" until someone clicks **Install dependencies** (on this PC only). The environment is built from the app's interpreter into `.cache/plugin-envs/<key>-<lock hash>/` and gets `magnusim_sdk` and nothing of the core: `import cfddesk` fails there, and the app's own packages never change. `Setup.bat -Plugins` builds the environments of bundled plugins that are on.
- **The service module** registers its methods; the page reaches them at `/api/plugin/<key>/<method>`:

```python
from magnusim_sdk.data import PluginData
from magnusim_sdk.service import method


@method("polar", timeout_s=120)
def polar(params, scope):
    data = PluginData(scope["project_dir"], scope["plugin"])  # its own folder in the project
    ...
    return {"cl": cl}
```

  A method gets the request's `params` and a `scope` (`plugin`, `project_id`, `project_dir`, `simulation_id`, `geometry_id`), returns something JSON can carry, and raises to fail the call with its message. Calls run one at a time; each has 30 s unless `timeout_s` says otherwise (600 at most). A call that runs longer ends the service and everything it started; a crash is reported and the next call starts it again; it stops after 10 minutes without calls. Print freely: the service's stdout goes to the log, not into replies.
- **Jobs** run on the plugin's environment when their `JobKind` says `python="plugin"` (in the plugin's folder); filter tools of a plugin with an environment run there too. Stopping a job stops everything its tool started.
- **Studies**: when a `[[study_kinds]]` entry's `schema_version` goes up, a service method `migrate_study` gets `{"study", "from_version", "to_version"}` for each older study and returns the upgraded record; the host stores it (rev-checked) with the new `schema_version`. It runs in the background: the tree shows the study as it was until the upgrade lands.
- **register()** still runs in the core, to declare specs, jobs and study kinds. Keep it free of your environment's packages: they are not importable there.

## Simulation types (analysis contract 1.1)

An `AnalysisType` needs only `key`, `label`, `category`, `time_dependency` and `fields` (API 1.4; the other fields default to empty). It tells the core everything else through optional contract fields (`cfddesk.registry.contract`), so the core never reaches into its physics. Keep a choice such as a turbulence model in your own `settings_schema`: its defaults fill the new-study settings that `study_defaults` leaves out.

- `family`: the Create Simulation title, description and tags, shared with a sibling analysis (steady and transient of the same physics).
- `study_defaults(time_dependency)`, `algorithm_label`, `residual_keys`, `x_axis`, `ui`.
- `validate_ready(ctx)`: what still blocks a run, as `[{"message", "fix"}]`. The Run panel shows the message.
- `run_model`: run settings defaults, clean-up and the preview numbers (for example the time step).
- `write_case(ctx)`: writes the case; `ctx.simulation` holds the study's settings.
- `launch` (or the default solver's `SolverApp`): the program, which frames to keep (`all` or `latest`), the process names Stop looks for, and `frame_fields` (fields that mark a written frame).
- `launch` (API 1.8) may take `inputs`: a hook whose signature names an `inputs` parameter (not `**kwargs` alone) gets the run's `RunInputs` when the core plans a run (Start, Continue), so its program can follow the study (Heat Transfer runs `chtMultiRegionSimpleFoam` once a body has a solid material, else `buoyantSimpleFoam`). The relay asks the hook without them (for the run's log parser only): name one parser that reads every run the hook may plan.
- `launch` (API 1.5) may also say `serial_below_cells` (the cell count under which a run is serial; `None` keeps 200000 steady and 50000 transient) and `prepare_job`: the key of your own `JobKind` that writes a run's case into `MAGNUSIM_CASE_DIR` (`""` lets the builtin `solve.prepare` call your `write_case`). Such a job reaches the core through `cfddesk.registry.run_case`: `case_dir_problem` (refuse any folder but the run's own case folder), `run_inputs`, `ready_context`, `write_case` and `stamp_prepare_report`. Print `stage` event lines as it goes and exit 3 when the run is not ready.
- `live_metrics` (API 1.5): the per-step numbers the Run panel's progress line shows after the time, as `{key, label, format: "time" | "sig2", max_key?}` rows (for example `{"key": "co_mean", "label": "Co", "format": "sig2", "max_key": "co_max"}`). Leave it `None` to keep the Δt and Co text of a transient run.
- `log_parser`: `module:factory` of the parser that turns the solver's output into job events.
- `kinematic_fields` (API 1.4): the fields your cases store divided by density (pressure in an incompressible case), shown times `rho`. The core writes them in the case's `w27-case.json` unless `write_case` listed its own; leave it `None` to say nothing (a case with no list is read as `["p"]`).
- `monitor_quantities` (API 1.4) and `run_monitors(case_dir)`: what the Graphs panel's monitors show. Each `MonitorQuantity` reads one value of the series points (`sample`) and gives its label, unit and colour, and whether it is plotted, listed in a monitor's details, shown as a headline or exported as a CSV column. `run_monitors` returns the monitor rows (each with a `key`, a `default_quantity` and series points `{t, <sample>: value}`) and a `summary` line. The page formats and plots only what these say. A `MonitorType` with `user_creatable=True` is offered in the Monitors dialog.
- `result_fields`: what your runs' results show, as `ResultField(key, label, unit_quantity, kind, unit, magnitude_label)` rows. Every results tool (colouring, iso surface and volume, plot over path, cutting planes, particle trace, inspect, views, legends) lists these in your order, those the frame wrote, with your labels and units; nothing else is shown for your runs. Give a velocity vector `unit_quantity="velocity"`: particle trace and vector glyphs follow the first one, and are off for a case without one. A case you write yourself can carry the list as `result_fields` in its `w27-case.json` (the core adds it after `write_case` when it is missing).

`python/tests/fixtures/plugins/stub-analysis` is a complete example: a steady scalar-diffusion analysis on `laplacianFoam`, written with `magnusim_sdk` only.

## Boundary conditions and materials (1.4)

The Boundary Conditions and Materials panels show what the registry holds, so a plugin can add its own.

A BC has two parts. A `BcTypeSpec` (kind `bc`) is one variant the case writer knows: its `semantic` (`inlet`, `outlet` or `wall`), its `patch_type` and its writers for `U` and `p`. A `BcFamily` (kind `bc_family`) is what the user picks: its `label`, `hint` and `color`; the `record_type` a saved BC stores in `bc_type`, and older `aliases`; its `variants` (BC type keys, the first the default); a new BC's `defaults` per unit system; the `values` rows that say which fields carry units; the `fields` of its generic editor; the `ui` component that replaces that editor; and `resolve`, which turns a saved BC into its variant key and SI settings for the case writer. Each variant names its `family` and the record values that select it (`match`).

```python test
from cfddesk.registry import BcFamily, BcTypeSpec, validate_bc_families
from cfddesk.registry.discovery import RegistryHub
from cfddesk.registry.schema import SchemaField


def write_symmetry(name, settings, ctx):
    return "        type            symmetryPlane;\n"


def register_bcs(hub):
    hub.registry("bc").register(
        BcTypeSpec(
            key="symmetry_plane",
            label="Symmetry",
            semantic="wall",
            patch_type="patch",
            write_U=write_symmetry,
            write_p=write_symmetry,
            family="symmetry",
        ),
        plugin="my-plugin",
    )
    hub.registry("bc_family").register(
        BcFamily(
            key="symmetry",
            label="Symmetry",
            record_type="Symmetry",
            hint="Mirror plane: no flow through it",
            variants=("symmetry_plane",),
            defaults={"metric": {"mirror": "Plane"}, "imperial": {"mirror": "Plane"}},
            fields=(SchemaField("mirror", "Mirror", "choice", default="Plane", choices=("Plane", "Wedge")),),
            resolve=lambda record: ("symmetry_plane", {}),
        ),
        plugin="my-plugin",
    )


hub = RegistryHub()
register_bcs(hub)
validate_bc_families(hub)  # the check the host runs once every plugin has registered
(row,) = hub.registry("bc_family").describe()
assert row["record_type"] == "Symmetry" and row["variants"] == ["symmetry_plane"], row
```

After every plugin has registered, each family's variants must be registered BC types and each BC type's `family` a registered family; a plugin that breaks this is unloaded with the reason on its Settings row. An analysis offers BCs through its `bc_types`: clone one as in Register and add your variant (`python/tests/fixtures/bc-plugins/example-extra-bc` does both). Its studies' BC panel then lists every family with a variant among them. With `ui` empty, the editor is a form built from `fields`. For an editor of your own, name it in `ui` and register the component from your UI:

```javascript
host.pluginUi.registerBcSettings("my-plugin.bc", MyBcEditor, { facesNote: MyFacesNote });
```

It gets `BcSettingsProps` (`src/plugin-api/slots.ts`): the saved `bc`, its `family` row, `imperial`, the assigned `faces`, `save(patch)` and `flowBasis(faces)` (one face's mean area and the fluid's density). `facesNote` is optional and is drawn under the assigned faces. Incompressible Flow's BC types and families (the seven stored types and their four families, then symmetry, freestream, total-pressure inlet and the moving and rotating walls) are protected: build on them, never drop them. The slot props also carry `study` (the study's record, or null). `cfddesk.case.bc_registry` and `cfddesk.case.bc_menu` are 1.x shims kept for older code; read the registry instead.

A `MaterialModel` (kind `material`) gives the Materials panel its fluids and fields: `properties_schema` (the number rows; a field's `quantity` gives its Imperial unit), `library` (the presets, rows of `key`, `name`, `values`, `library`, `codes`, `names` and optional `legacy_values`), `record_keys` (the record keys that hold each property), `record_constants` (what every record carries) and `custom_preset` (the preset a record has once the user types their own values). An analysis names its model in `material_models`. A saved material keeps its numbers; `compatibility.md` (1.4) has the rule that matches a record to its preset. Incompressible Flow's `newtonian_incompressible` (`bundled-plugins/incompressible_flow/incompressible_flow/materials.py`) is a complete example.

## Building on another plugin, and heat transfer pieces (1.8)

**Plugin exports.** A plugin may use another plugin's Python code only through modules that plugin lists in its manifest `exports` (`"package.module"`, a module of its own), and only when its own `requires_plugins` names that plugin (so it loads first). Anything else of another plugin stays private: `plugin:check` and the CI boundary check (`tools/plugin_boundary.py`, rule 4) refuse the import with the fix. An export is the exporter's public API: it keeps its names and meaning across its minor versions.

```toml
# The exporter's manifest
exports = ["incompressible_flow.flow_bcs"]
# The user's manifest
requires_plugins = ["incompressible_flow>=1.1"]
```

**Incompressible Flow's flow BCs (`incompressible_flow.flow_bcs`, from Incompressible Flow 1.1).** A solver of the same flow (Heat Transfer's buoyant solvers) takes the velocity and turbulence of every boundary from Incompressible Flow instead of copying its inlet logic. `flow_patches(inputs, *, nu, rho, turbulence_model, poly_mesh=None, initial_flow="still", initial_u=(0, 0, 0), compressible=False)` reads the core's `RunInputs` of one run (the study's own BC records, face areas and run settings) with the fluid's kinematic viscosity (m²/s) and density (kg/m³) and the model the caller solves with (`laminar`, an OpenFOAM RAS name or a study's display name such as "k-omega SST", read by `turbulence_model_name`; a model it does not know raises `ValueError`), and returns a `FlowPatches`:

- `patch_names`: the mesh's patches in its `boundary` order (`poly_mesh` is the case's `constant/polyMesh`; without one they come from the BCs);
- `U`: each patch's `0/U` boundaryField entry (`{key: value}` strings, as `magnusim_sdk.foam.write_vol_field` takes them) for every Incompressible Flow BC kind: velocity inlets (normal speed, vector, volumetric and mass flow, a "Varies with time" table in a transient run), velocity outlets, pressure boundaries, walls (no-slip, slip, moving, rotating; walls no BC claims take the study's default wall), symmetry, freestream and the total-pressure inlet. With `compressible=True` a mass-flow inlet or outlet reads the solver's density field (`rho rho;`, its `rhoInlet` the start value);
- `turbulence` (`{field: {patch: entry}}` for each field the model reads: `k`, `omega`, `epsilon`, `nut`, `nuTilda`, `R`; none when laminar, with each boundary's own "Turbulence at the inlet") and `turbulence_internal` (each field's internal value string);
- `kinds` (each patch is one of `KINDS`: `inlet`, `pressure`, `velocity_outlet`, `wall`, `symmetry`, `freestream` or `total_pressure`), `records` (the BC record on it) and `wall_motion` (a wall's treatment, one of `WALL_MOTIONS`: `no_slip`, `slip`, `moving`, `rotating`; fixed tokens, never the editor's labels);
- `speed_ref` (m/s) and `hydraulic_diameter` (m), the reference speed and inlet size Incompressible Flow's turbulence values use; `initial_velocity` (m/s) and `initial_from`;
- `scales` (case-wide) and `patch_scales` (each boundary whose "Turbulence at the inlet" is not Auto), each with exactly the keys of `SCALE_KEYS`: `k` (m²/s²), `omega` (1/s), `epsilon` (m²/s³), `intensity` (a fraction: 0.05 is the 5 % a record stores as `turbulence_intensity = 5`), `length_scale_m` (m; for a boundary set by a viscosity ratio, the length its k and omega imply) and `nu_tilda` (m²/s under Spalart-Allmaras, else None).

`boundary_pressure_pa(record)` gives a pressure boundary's gauge pressure, a total-pressure inlet's total pressure or a freestream's pressure in Pa: the fixed value (a "Varies with time" table is not read; `varies_with_time(record, transient=)` says whether the table is what the run solves); `boundary_kind(record)` one of the kinds above (None for another plugin's BC); `wall_motion(record)` a wall record's token (None for another kind); `boundary_problem(record, turbulence_model=, transient=)` what Incompressible Flow's Start would refuse on that boundary as a `BoundaryProblem` (`kind`: `turbulence`, `time_table` or `wall_motion`; `detail` in the user's words; `message`, the sentence Incompressible Flow's own Start shows, such as `Turbulence at the inlet of "inlet": …`), or None. Like Start it skips a record with no assigned face. `first_boundary_problem(records, turbulence_model=, transient=)` gives the one Start reports first for a study's records: it checks kind by kind across them (every inlet's turbulence, then every table, then every wall's motion), so check a study with it rather than record by record. Pressure entries are not part of it: Incompressible Flow stores pressure divided by density, another solver writes its own (`p_rgh`). Incompressible Flow's own cases are written by the same functions, so the two stay the same (its tests compare them on every kind and on its golden cases).

**Fields on another plugin's BCs.** An analysis adds fields to the BCs of its studies with `bc_fields`, groups of `SchemaField`s (`BcFieldGroup`: `key`, `title`, `fields`, `families`, `ui`, `description`). The BC editor draws each group under the family's own settings, only in studies of that analysis, and saves its fields in the same BC record, so a family another plugin owns gains them without changing. `families` names the bc_family keys a group is for (empty: every family the analysis offers). A field may not use a key the family or the host already holds; a group that does unloads its plugin with the reason. `ui` names a component drawn instead of the generic form (`host.pluginUi.registerBcSection(name, Component)`; it gets `BcSettingsProps` plus its `group`).

An analysis may also say what a new BC starts with in its studies, `bc_seeds` (`{bc_family key: {field: value}}`): over the family's own seed and over the rule that a new BC of the family the study's defaults name starts on the other choice. Heat Transfer's `{"wall": {"wall_type": "No-slip"}}` makes its new Wall start no-slip (it is added for the heat through it). The family must be one the analysis offers, each field one of the family's, each value plain (a choice one of the field's choices); otherwise the plugin is unloaded with the reason.

```python test
from cfddesk.registry import AnalysisType, BcFieldGroup, SchemaField

T_IN = SchemaField("inlet_temperature", "Inlet temperature", "float", default=293.15, quantity="temperature")
heat = AnalysisType(
    key="my_heat_steady", label="Heat", category="heat", time_dependency="steady", fields=("T",),
    bc_types=("velocity_inlet_fixed", "wall_noslip"),
    bc_fields=(BcFieldGroup("inlet_thermal", "Thermal", (T_IN,), families=("velocity_inlet",)),),
)
assert heat.bc_fields[0].families == ("velocity_inlet",)
```

**Several materials per study.** A `MaterialModel` has a `role`, `"fluid"` (the default) or `"solid"`. An analysis that lists more than one model in `material_models` lets a study hold several material records, one per group of bodies: the Materials tree lists each, "+" adds one, its panel picks the model ("Type"), the preset and the bodies, and a body belongs to one record at a time (assigning it takes it from the other). Each record with bodies is one region of the mesh, with its model's role (`cfddesk.project.regions.study_regions`; Start's `ReadyContext.mesh` gives the mesh's `regions` and `out_of_date_materials` when they are no longer the study's): Standard and Hex-dominant mesh such a study with one cellZone per region (named after it: lower-case word characters, and never a name a case's files have or another region's, `r_g`, `air_2`; `cfddesk.wsl.region_rule`), the faces between regions meshed through, so `splitMeshRegions -cellZonesOnly` gives a CHT case its regions (one region per cellZone, even when a material's bodies are apart; `-cellZones` would walk the mesh and name each separate piece `domain<N>`) and their `<a>_to_<b>` interface patches; cfMesh refuses it. A record names its model in `material_model`. An analysis with one model keeps the one-fluid panel.

**The mesher a new mesh starts with.** An analysis may name it, `default_mesher` (a mesher's key): a new mesh in its studies starts on it, when that mesher is registered, instead of the app's default (Standard). Heat Transfer names Hex-dominant (`"snappy_hexdominant"`), because the heat through walls is more accurate on its hexahedra. Restore defaults on a mesh gives it back. An existing mesh keeps its mesher and a copy keeps its source's; a mesher a new mesh cannot use (none registers it, or a core mesher that is not a product engine) is ignored with a warning on your plugin's Settings row (new meshes then start on the app's default).

```python test
from cfddesk.registry import AnalysisType

heat = AnalysisType(key="my_heat_steady", label="Heat", category="heat", time_dependency="steady", fields=("T",),
                    default_mesher="snappy_hexdominant")
assert heat.default_mesher == "snappy_hexdominant"
```

**Units.** Temperatures are shown and typed in °C (metric) or °F (imperial), stored in K; a schema form's temperature field has a K/°C/°F picker. New quantities: `heat_flux`, `heat_transfer_coefficient`, `thermal_conductivity`, `specific_heat`, `power`, `power_density`, `thermal_expansion`, `acceleration`, `dynamic_viscosity` and `molar_mass` (`magnusim_sdk.units`, and the kit's `UNITS`).

## Sample projects (1.8)

A plugin may ship ready-made projects that show what it does. Home's **Open sample** lists the samples of every plugin that is on; a pick copies one into the projects folder as a new project (titled as no project there is: "Heat sink", then "Heat sink 2") and opens it. A sample holds a project's inputs: the geometry, its studies with their materials, BCs, mesh settings and monitors. It holds no mesh and no results, and no runs: each study of the copy gets a new draft run (a run's id names its WSL case, so two copies never share one).

```toml
[[samples]]
key = "heat-sink"            # lower-case letters, digits and '-'; unique in the plugin
title = "Heat sink"          # the menu item and the new project's title, at most 40 characters
hint = "An aluminium heat sink with a 10 W source in an air channel: conjugate heat transfer, ready to mesh"
path = "samples/heat-sink"   # a folder inside the plugin holding project.json
```

Make the folder from a project you set up in the app (before Generate):

```bash
node scripts/sample-from-project.mjs <projects folder>/<project id> bundled-plugins/<key>/samples/<name>
```

It copies the project without its mesh case folder and its runs, and writes its JSON files with three placeholders where a project holds its own place: `{{project_dir}}` (the project's folder; the parts of a path under it joined with `/`), `{{projects_root}}` (only as a whole string: a path under it would lead into other projects) and `{{project_id}}`. The copy fills them in for its own folder, so a sample opens on any PC. The tool refuses a project whose mesh was generated, one holding a link or junction or more than 64 MB of files, and JSON that still names a folder outside the project; opening refuses those too, and any string naming a place on a PC (a drive, UNC or absolute POSIX path; the app's `/api/...` URLs are fine). Check the folder in (`plugin:pack` packs it with the plugin) and give it a default-suite e2e that opens it from Home. A bad `[[samples]]` table fails the plugin's load with the reason; a folder that is missing or holds no `project.json` is left out with a warning on the plugin's Settings row (`plugin:check` shows it).

## UI

The page has no import map, so how a UI gets React and the UI kit depends on its `ui_entry`:

- **A prebuilt `.js` UI imports nothing bare.** Bundle your own files into it, and use `host.React`, `host.ReactDOM` and `host.pluginUi.kit` for React and the kit.
- **A `.tsx`, `.ts` or `.jsx` UI** is bundled by the host. It may import `react`, `react/jsx-runtime`, `@magnusim/plugin-ui` and its own files in `ui/`; the host resolves `react` and the kit to the page's own copies.

Either way the host passes one React and one plugin API object:

```javascript
export function register(host) {
  const React = host.React;
  host.pluginUi.registerPanel({
    key: "my-plugin",
    title: "My plugin",
    place: "prefs",
    Component() {
      return React.createElement("p", null, "Hello");
    },
  });
}
```

`host` is `{ React, ReactDOM, pluginUi, scope }`. `scope` is the open project's scope id. In-page UI has no import map (workspaces do, below). A thrown `register` or a thrown panel is a Plugins-tab row and a toast. Builtins stay loaded.

`pluginUi` can register a panel, replace a host panel, add a filter widget, add a schema field widget, or add a tree transform. Tree nodes must carry the current project scope or the tree drops them.

A panel's `place` is `"filters"` (the Filters panel) or `"prefs"` (your row in Settings → Plugins). Those are the only places the app draws. The older names `tree`, `toolbar`, `results` and `geometry` were never shown; registering there now fails and your plugin shows an error row.

`registerFieldWidget(name, Component)` renders any schema field whose `x-cfddesk.widget` is `name` with your component. `registerStudySettings`, `registerRunSettings` and `registerBcSettings` fill the study, run and BC editors' settings slots (above, and `compatibility.md`).

Everything your `register(host)` adds is recorded under your plugin key. Disabling the plugin removes it at once, and reloading replaces it instead of adding a second copy.

## Workspaces (1.1)

A panel fits in the workbench; a tool with its own screens (an airfoil polar bench, a sketcher) gets a **workspace**: a full page you draw yourself, opened from one of your study kinds. The app keeps the header (Back to project, `<Your plugin> › <Study>` with rename, Queue, Settings) and puts your page under it, over the project's workbench.

```toml
[[workspaces]]
key = "bench"
title = "Bench"
icon = "M4 5h16v14H4z M4 9h16"      # one SVG path, 24 x 24
entry = "workspace/index.html"      # an .html file in workspace/

[[study_kinds]]
key = "bench_case"
title = "Bench case"
icon = "M5 19V5h14v14z"
workspace = "bench"                 # a study of this kind opens there
```

The host serves your `workspace/` folder, and only that folder, to the frame. The study's row in the tree opens it, and so does the header's Workspaces menu (New Bench case). The link `#/p/<project>/ws/<plugin>/<workspace>/<study>` reopens it after a reload.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="./bench.css" />
    <script type="module" src="./main.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
```

```javascript
// main.js
import { connect } from '@magnusim/workspace';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

const ws = await connect();                     // context: plugin, project, study, units, theme
const study = await ws.study.get();
// The header shows the study's title and Back: the page draws neither.
createRoot(document.getElementById('root')).render(createElement('p', null, `Last angle: ${String(study.last_alpha ?? 'none')}`));
const polar = await ws.service('polar', { alpha: 4 });  // your backend
await ws.data.write(`studies/${study.id}/polar.json`, polar);
await ws.study.update({ last_alpha: 4 }, study.rev);   // refused if another tab saved first
```

- **Imports.** The host puts an import map in your page for `react`, `react-dom/client`, `react/jsx-runtime`, `@magnusim/workspace` and `@magnusim/plugin-ui` (the UI kit, below). Import those names; do not ship your own React. If you bundle your code, mark them external and emit ES modules. The versions are in `docs/plugins/plugin-sdk.json`. For types, copy `docs/plugins/workspace-sdk.d.ts` (and `docs/plugins/plugin-ui.d.ts` for the kit) into your plugin.
- **Styles.** `/plugin-sdk/theme.css` is loaded before your own CSS: use its `--mg-*` tokens (colours, type, spacing, radii, shadows) so the page matches the app. `/plugin-sdk/plugin-ui.css`, the kit's styles, is loaded after `theme.css`.
- **The sandbox.** The page runs in a sandboxed frame with an opaque origin. Its Content-Security-Policy allows scripts, styles, fonts, images and `fetch` only from `/plugin-sdk/` and your own `workspace/` folder, plus `data:` and `blob:` images:
  - No inline `<script>`: put code in module files.
  - No `/api/`: use `ws.service`, `ws.data`, `ws.study` and `ws.jobs`.
  - No `localStorage`, IndexedDB or cookies: keep state in `ws.data` (JSON, 8 MB a file), `ws.files` (any file, within your `[files]` limits) or the study.
  - Workers: `ws.spawnWorker(new URL('./worker.js', import.meta.url))`. You can post to it at once; messages are held until your module has loaded.
  - WebAssembly from your folder: `WebAssembly.instantiateStreaming(fetch(new URL('./x.wasm', import.meta.url)))`.
- **Bridge calls** are allowed only for your plugin, this project and this study; `compatibility.md` lists them all. Anything else is refused with "not allowed: …". `ws.on('units', fn)` follows the user's unit choice; `ws.on('study', fn)` gets the study after a rename in the header (save next with its `rev`, or with `ws.context.study.rev`, which follows); `ws.ui.toast`, `ws.ui.confirm` and `ws.ui.prompt` use the app's own; `ws.nav.back()` closes the workspace.
- **Starting.** Call `connect()` as soon as the page loads. A page that has not connected within 5 s shows the user "<Your plugin> didn't start." with Try again.
- **Checking the host (1.2).** Everything below needs host 1.2. Check `ws.context.hostVersion` (compare the numbers) and set `api_version = "1.2"`; a 1.1 host refuses the new calls with code `not_allowed`.
- **Big and binary files (1.2).** `ws.files` keeps any file in your plugin's folder of the project, the same folder `ws.data` and your Python see. A write is streamed in chunks and replaces the file only once every byte has arrived. Pass the `etag` you read as `ifMatch` so a write never overwrites a version saved from another tab (it rejects with code `changed`), or `ifMatch: null` to only create:

  ```toml
  [files]                 # what your workspace may keep in one project
  max_file_mb = 256       # one file (default 64)
  max_total_mb = 1024     # everything in your folder (default 512)
  ```

  ```javascript
  const model = await ws.files.stat(`studies/${study.id}/model.bin`);
  const saved = await ws.files.write(`studies/${study.id}/model.bin`, bytes, {
    ifMatch: model ? model.etag : null,
    onProgress: (done, total) => bar.set(done / total),
  });
  const back = await ws.files.read(`studies/${study.id}/model.bin`); // ArrayBuffer, or null
  ```

  Your service and jobs reach the same files through `magnusim_sdk.data.PluginData` (`from_scope(scope)` in a service method, `from_env()` in a job): `read_bytes`, `write_bytes`, `atomic_path` (a temp path for a mesher or exporter, replaced in one step), `list_files`, `delete_file` and `file_info`, whose `etag` matches the workspace's. Paths follow one set of rules everywhere (`compatibility.md`); a study's own `study.json` changes only through `ws.study`. The output of your OpenFOAM cases (1.3: frames, logs, `postProcessing`, the mesh) lands in the same folder and counts toward `max_total_mb` too; a run is not cut short at the limit, but later writes and submits are refused until you delete old cases.
- **Unsaved work (1.2).** Call `ws.nav.setDirty(true, 'Sketch 2 is not saved')` on the first change that is not saved yet, and `ws.nav.setDirty(false)` once it is. While it is set, and while a `ws.files.write` is on its way, every way out of the workspace asks the user first, with your plugin's name and your message, and closing the browser tab shows the browser's own prompt. `ws.nav.back()` resolves `false` when the user stays; clear the flag first to leave without a question. Never reload your own page while dirty: a reload clears the flag and loses the work. If your page accepts dropped files, call `preventDefault()` on `dragover` and `drop`, or the browser opens the file in place of the app.
- **Keyboard and full screen (1.2).** Your page has the keyboard when it connects and again after the app's dialogs and Settings close; listen on `window` or `document`. `document.documentElement.requestFullscreen()` from a click or key handler covers the whole screen; Esc always leaves, and the app leaves full screen before it shows a dialog. The app's toasts are not seen over a full-screen page.

`python/tests/fixtures/workspace-plugins/ws-demo` is a complete example (modules, React, WebAssembly, a worker, service calls, data and study saves), driven by `e2e/h13-workspace.spec.js`. To start a workspace plugin of your own, run `npm run plugin:new -- <key> --workspace`.

### OpenFOAM cases and solve hooks (1.3)

A workspace can run an OpenFOAM case it wrote in its study's folder: the host runs it in WSL on the app's one compute slot (it may wait in the queue behind a mesh or a solve), streams its progress to the page, and can show its results in the project's 3D view.

```javascript
const ws = await connect();
// Write the case with ws.files (or your service) under studies/<sid>/cases/c1, then:
const { id } = await ws.compute.submitOpenFOAM({
  caseRel: 'cases/c1',                       // inside this study's folder; a case runs once
  app: 'pimpleFoam',                         // a registered solver, as controlDict names it
  pre: [{ tool: 'blockMesh' }],              // WSL steps before the solver
  results: { kinematicFields: ['p'], rho: 1.2 },
});
ws.compute.events(id, (ev) => {
  if (ev.event === 'progress') plot.add(ev.points);
  if (ev.event === 'end' && ev.status === 'done') ws.results.openIn3D('cases/c1');
});
```

`compatibility.md` (1.3) has the rules: the calls, the case and `controlDict` rules, the table of WSL steps and their arguments (meshing utilities and parallel spans included), the events, Stop, what happens when the plugin is turned off or the app restarts, and the codes. `python/tests/fixtures/foam-plugins/foam-demo` is a complete example, driven by `e2e/h15-submit-openfoam.spec.js`.

Your plugin's Python can also follow every solve, core runs included: `solve.prepare`, `solve.parse_line` (batches of solver output lines) and `solve.stop`, registered with `get_hooks().on(name, fn, plugin=KEY)` in `register(hub)`. They run inside the solve's relay process, never slow the solve, and are dropped for the run when they take too long or raise; `compatibility.md` lists what they are told and their limits.

## Start actions (1.4)

A study kind with a workspace can have a **start action**: a button that creates a study of that kind and opens it in its workspace. The host draws it in up to four places, the same way for every plugin:

| Place | What the user sees | At most |
|---|---|---|
| `empty_project` | A button under Add geometry in a project with no geometry, with your `hint` below it | 3 |
| `header` | A button in the project header, left of Workspaces. Its menu lists the project's studies of the kind (read-only ones marked), then "New <Kind>" | 3 |
| `new_project` | A radio under "Start from" in the New Project dialog, beside "Import geometry". A long list scrolls; the dialog opens at once and adds the radios when the app has read them | no limit |
| `home` | A button on Home, left of New project. It opens the New Project dialog with your action chosen and a title "Untitled <Kind> N" filled in, so one Create click makes the project and the study | 3 |

```toml
[[workspaces]]
key = "sketch"
title = "Sketch"
entry = "workspace/index.html"

[[study_kinds]]
key = "sketch"
title = "Sketch"
workspace = "sketch"            # a start action needs a kind with a workspace

[[start_actions]]
study_kind = "sketch"           # required: one of your kinds that has a workspace
label = "Start a sketch"        # required, 1-40 characters
hint = "Draw it here, then simulate it"   # optional, up to 120 characters
icon = "M4 8l8-4 8 4"           # optional, one SVG path; the default is the kind's icon
places = ["empty_project", "header", "new_project", "home"]   # optional; the default is all four
home_label = "New sketch"       # optional, 1-40 characters: Home's button text (default: label)
header_label = "Sketch"         # optional, 1-24 characters: the header button's text
```

- **The study.** A click makes a study named with the first "<Kind title> N" that no study of any plugin in the project, and no geometry, already has. There is no name prompt; the user renames it from the workspace header. The workspace then opens at `#/p/<project>/ws/<plugin>/<workspace>/<study>`. A button stays disabled from the click until the workspace opens or a notice shows. If the study cannot be made (your plugin was turned off meanwhile), the user sees "Could not create the study"; the project stays open (from the New Project dialog, the new project opens without the study).
- **Rules.** At most one start action per kind, and at most one `header` action per workspace. Texts are one line of plain text, with no control or bidirectional-override characters, and the manifest check never shortens them: a text that is too long is an error. On Home, in a window too narrow for every button, a start button's text ends in "…" and its tooltip has the whole text; New project always stays in view. The header button shows `header_label`, or else the workspace title, which must then be 24 characters or fewer. `header_label` needs `"header"` in `places`. A bad table fails only your plugin, with "manifest [[start_actions]]: …" on its Settings row.
- **Places a later host may add.** A name in `places` this host does not know is ignored, with a warning on your plugin's Settings row ("place 'toolbar' is not known to this app; ignored"), so a plugin written for a later host still loads. The table is an error only when no known place is left. Keys this host does not know are ignored.
- **Order and caps.** Places list actions in plugin load order (bundled plugins first, then the user's plugins folder), then manifest order, each place cut at its cap. A kind whose header button was cut stays in the Workspaces menu, and STUDIES shows it. A kind shown as a header button leaves the Workspaces menu. STUDIES stays hidden in a project that has no plugin study while every kind is a header button.
- **When nothing shows.** A plugin that is off, missing, needs setup or failed to load shows its actions nowhere. They come back without a reload once it is turned on in Settings → Plugins.
- **Older hosts.** A 1.3 host ignores `[[start_actions]]`: your kinds still open from the Workspaces menu and STUDIES. Set `api_version = "1.4"`.
- **`links_geometry` (parsed in 1.4, used from 1.5).** `links_geometry = true` on a study kind says its studies may link one project geometry ("Linking a geometry (1.5)" below). It must be `true` or `false`, and the kind must have a workspace.

`npm run plugin:new -- <key> --workspace` writes a working starting point: a kind, a workspace page, and commented-out `[[start_actions]]` and `links_geometry` lines. `python/tests/fixtures/start-plugins/` has two complete examples, driven by `e2e/start-actions.spec.js`.

## Linking a geometry (1.5)

A study kind with `links_geometry = true` (and a workspace) can link **one project geometry per study**: its design becomes a geometry the simulation side uses like an imported part, and later saves of the design update it. The host does the same for every plugin; nothing in it knows what your plugin is.

**What your plugin does.** Export the saved design as one compound of solids in mm, as an OCCT BREP (binary, BinTools, or text, BRepTools), write it with `ws.files.write` (it returns the sha256), optionally write a face-name sidecar, then call `ws.project.linkGeometry`:

```ts test
import { connect } from '@magnusim/workspace';

const ws = await connect();
const sid = ws.context.study.id;
const shape = await ws.files.write(`studies/${sid}/export/part.bbrep`, new Uint8Array([1, 2, 3]));
const names = await ws.files.write(`studies/${sid}/export/face_names.json`, '{}');
const linked = await ws.project.linkedGeometry();
const study = await ws.study.get();
const sourceVersion = (Number(study.source_version) || 0) + 1;
await ws.study.update({ source_version: sourceVersion }, study.rev);
try {
  const r = await ws.project.linkGeometry({
    shape: { rel: shape.rel, format: 'brep', sha256: shape.sha256 },
    faceNames: { rel: names.rel, sha256: names.sha256 },
    sourceVersion,
    basedOnRev: linked ? linked.rev : null,
    onProgress: (p) => console.log(p.stage, p.ahead ?? ''),
  });
  console.log(r.change, r.rev, r.lost.length, r.claimedTwice.length);
} catch (e) {
  // "cancelled": the user kept editing (the app's question), or removed the update from
  // the Queue. "not_now" (1.7): the study's geometry was removed and the user chose not to
  // add it again. Stay as you are; show no error.
  const code = (e as { code?: string }).code;
  if (code !== 'cancelled' && code !== 'not_now') throw e;
}
ws.on('geometry', (g) => console.log('the linked geometry is now rev', g.rev));
```

**A file your plugin's Python wrote.** Each file is given by `sha256` (what `ws.files.write` returned) **or** by `etag`, exactly one of the two. A file your backend wrote (`magnusim_sdk.data`, with the sidecar from `magnusim_sdk.link.write_face_names`) never passes through the page: read its etag with `ws.files.stat` and link it by that. If the file changes between the stat and the link, the call is refused with `changed`.

```ts test
import { connect } from '@magnusim/workspace';

const ws = await connect();
const sid = ws.context.study.id;
// Your backend's own method wrote both files into the study's folder.
const out = (await ws.service('export', { study_id: sid })) as { shape: string; faceNames: string };
const shape = await ws.files.stat(out.shape);
const names = await ws.files.stat(out.faceNames);
if (!shape || !names) throw new Error('the export is missing');
const linked = await ws.project.linkedGeometry();
const study = await ws.study.get();
const sourceVersion = Math.max(Number(study.source_version) || 0, linked ? linked.sourceVersion : 0) + 1;
await ws.study.update({ source_version: sourceVersion }, study.rev);
await ws.project.linkGeometry({
  shape: { rel: out.shape, format: 'brep', etag: shape.etag },
  faceNames: { rel: out.faceNames, etag: names.etag },
  sourceVersion,
  basedOnRev: linked ? linked.rev : null,
});
```

- **The first call creates the geometry** (named after the study, or `name`). It is made like an import: it never waits for a running mesh or solve.
- **A later call** with the same bytes changes nothing (`change: 'none'`, at once). One that changes only names or labels updates it in place (`names`, the rev kept). One that changes the shape is an **update**: a queued job on the app's one compute slot (the page gets stage `queued` with the jobs `ahead` of it while a mesh, a solve or a plugin case runs), then `shape`, the rev + 1.
- **The app's question.** When the **shape** changed and a simulation study on the geometry has saved setup (a boundary condition, material, monitor or refinement, a generated mesh, a run with results), the app asks the user, in its own dialog over your page, the same for every plugin: **"Save as new geometry"** adds the part as a new geometry ("<Geometry> v2", "v3", ...) and can copy each study's setup onto it, faces matched by name; the old geometry and its studies, meshes and results stay exactly as they were and become a plain geometry. **"Overwrite <Geometry>"** is the update below. **"Keep editing"** changes nothing. Your call stays pending while the dialog is open. You write no code for it and cannot skip it: `linkGeometry` has no mode. After "Save as new" the result has `created: true` and a new `geometryId`, and `linkedGeometry()` names the new geometry. After "Keep editing" the call rejects with `cancelled`: **the user kept editing**, so stay as you are and show no error. A geometry nothing uses yet, a change of names only, and the first link never ask. If your page closes before the user answers, the geometry's row says "Waiting for your choice" with "Choose…".
- **An update rewrites the simulation setup once, at its commit.** Every boundary condition, material, refinement, monitor and run that can still start (every run but a finished one) of the geometry's studies keeps its faces by **name**, then by shape. The fields of your own BC families, BC kinds, monitor kinds and meshers that hold faces or bodies (widget `faces`, `patch` or `body`, or `holds`) are rewritten the same way: a face split in two keeps its boundary condition on both halves; a face that is gone stays listed on its record under "Lost faces" (with its label) and comes back when a later design has a face of that name again. Two boundary conditions whose faces merged into one keep neither until the user picks (`claimedTwice`). Bodies pair by `id`, then name, then index, so a body the user renames keeps its material. Generated meshes are out of date. The result lists all of it, and the host shows the user a report.
- **Save, then link.** `sourceVersion` names one saved design: a whole number that only goes up and is never shared by two designs. `basedOnRev` is the geometry rev the page last read (`linkedGeometry().rev`, `null` before the first link). An older design is refused (`stale`), and so is a call while the page says it has unsaved work (`unsaved`: call `nav.setDirty(false)` after saving). Write the reserved study key `source_version` after each save: the geometry's row says "Not up to date with <study>." while the saved design is newer than the linked one.
- **Byte-identical exports.** Two exports of one design must be byte-identical (the BREP and the sidecar), so a link that changed nothing costs nothing. `magnusim_sdk.link.write_face_names` writes the sidecar that way.
- **Refusals** carry `.code`: `unsaved`, `stale`, `changed` (a file's bytes or etag differ from what you passed), `outside_study`, `unsupported_format`, `bad_brep` (not a BREP this app reads, or a face outside every solid), `empty` (no solid), `bad_face_names` (the message says which rule), `preview_failed`, `plugin_needed` (a record of the geometry's studies belongs to a plugin that is off or not installed: the update would not know which of its fields hold faces), `busy`, `gone` (the geometry was removed), `superseded` (a newer link of the study replaced a queued one, or a question still open), `cancelled` (the user kept editing, or removed the update from the Queue: show no error), `failed`, `not_allowed`; from 1.7 also `not_now` and `target_removed` (the study's geometry was removed: "Editing a project geometry (1.7)", "A removed geometry").
- **Nothing stops an update from a page.** `ws.jobs.stop` answers `not_allowed` for it; the user can remove a queued update from the Queue (`cancelled`).
- **Events.** `ws.on('geometry', fn)` tells the page of its own study when the geometry changed (this page's link or another tab's). A page of another study hears nothing.

**Formats.** 1.5 reads one: `format: 'brep'`, an OCCT BREP, binary or text, told apart by its header (OCCT 7.8 or later reads it; this app has 7.9.3). Any other value is refused with `unsupported_format`. A plugin with no OCCT (a scan, an STL/OBJ/PLY generator) cannot link in 1.5; a mesh format, whose faces are the app's own face groups, is the first follow-up.

**Face numbering** (the one rule; `compatibility.md` "1.5" states it per format). A face's `index` is its 1-based position in `TopExp_Explorer(shape, TopAbs_FACE)` over the whole compound, counting every visit: a face two touching solids share is visited once per solid, so it has one index per solid, each with its own `body`. A body's `index` is its 1-based `TopExp_Explorer(shape, TopAbs_SOLID)` order. A Python plugin calls `magnusim_sdk.link.face_visits(shape)`, the function the app itself uses.

**The face-name sidecar** (`face_names.json`, format `magnusim.face-names` version 1): `length_unit` must be `"mm"`; `shape_sha256` (the shape file's sha256, recommended) ties it to one export; `bodies` lists every solid once (`index`, optional `id`, `name`, `label`, `color`), with names and ids unique; `faces` lists every face visit once (`index`, `body`, optional `name`, `label`). `name` (1-200 characters) is the match key and is never shown when a `label` (1-120 characters) exists; several faces may share a name (the pieces of one split face). Faces and bodies are shown as "Label (face 12)" and "Label (Body2)".

```python test
import json
import tempfile
from pathlib import Path

from magnusim_sdk.link import check, face_visits, write_face_names
from OCP.BinTools import BinTools
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

box = BRepPrimAPI_MakeBox(10.0, 20.0, 30.0).Shape()
out = Path(tempfile.mkdtemp())
BinTools.Write_s(box, str(out / "part.bbrep"))
import hashlib

sha = hashlib.sha256((out / "part.bbrep").read_bytes()).hexdigest()
faces = [{"index": i, "body": b, "name": f"F:{i}", "label": f"Side {i}"} for i, b, _f in face_visits(box)]
write_face_names(out / "face_names.json", [{"index": 1, "id": "b1", "name": "Body 1", "label": "Fluid"}], faces, sha)
assert check(out / "part.bbrep", out / "face_names.json") == []
assert json.loads((out / "face_names.json").read_text(encoding="utf-8"))["faces"][0]["label"] == "Side 1"
```

From a shell (the same checks the app runs; exit code 0 when it would accept the pair): `python -m magnusim_sdk.link check part.bbrep face_names.json`.

**Schema fields that hold faces.** A boundary-condition kind's, monitor kind's or mesher's `SchemaField` with `widget="faces"`, `"patch"` or `"body"` is rewritten by an update like the host's own face lists; a field with your own widget says so with `holds="faces"` or `holds="body"` (published as `x-cfddesk.holds`). Its value is read from the record's top level or its `settings` (a mesher's from `settings.mesher_settings`). Study-level settings with these widgets are not supported in 1.5.

## Exit sync (1.6)

A linking page registers an **exit hook**: the app runs it on every way out of the workspace that it owns, so the geometry gets the design the user leaves with. The contract is **save, then link**: the handler saves unsaved work, calls `nav.setDirty(false)`, links with `ws.project.linkGeometry`, and returns. A page's own "Done" button just calls `ws.nav.back()`; the hook does the sync.

```ts test
import { connect } from '@magnusim/workspace';

const ws = await connect();
const sid = ws.context.study.id;
// An older host refuses onLeave with code "not_allowed": link from your own button then.
await ws.nav.onLeave(async ({ reason, signal, progress }) => {
  progress(null, 'Saving the design');
  // ...save unsaved work here, then:
  await ws.nav.setDirty(false);
  if (signal.aborted) return;
  progress(0.5, 'Exporting the design');
  const shape = await ws.files.write(`studies/${sid}/export/part.bbrep`, new Uint8Array([1, 2, 3]));
  const linked = await ws.project.linkedGeometry();
  const study = await ws.study.get();
  const sourceVersion = Number(study.source_version) || 0;
  try {
    await ws.project.linkGeometry({
      shape: { rel: shape.rel, format: 'brep', sha256: shape.sha256 },
      sourceVersion,
      basedOnRev: linked ? linked.rev : null,
    });
  } catch (e) {
    // "Keep editing" in the app's question: the leave is over and the workspace stays open.
    if ((e as { code?: string }).code === 'cancelled') return;
    throw e;
  }
  console.log('left by', reason);
  // The camera the project's viewport lands with (optional).
  return { view: { position: [400, 0, 100], target: [0, 0, 0], up: [0, 0, 1], projection: 'perspective', fovDeg: 30 } };
});
document.getElementById('done')?.addEventListener('click', () => void ws.nav.back());
```

- **Every way out the app owns runs it,** with its `reason`: the header's Back (`back`), your page's `nav.back()` (`frame-back`), the browser's Back or Forward and a typed link (`history`), opening another project (`project`), Home (`home`), and `results.openIn3D` (`results`). **None of these run it:** turning your plugin off in Settings (only the usual question about unsaved work), closing or reloading the tab, and a page that crashed or does not answer. The geometry then keeps its last update, and its row says "Not up to date with <study>." while the saved design is newer.
- **Order.** The app leaves full screen, checks that your page answers, runs the hook, then asks about unsaved work only if the page is still dirty, then leaves. Nothing is drawn for a hook quicker than 400 ms; after that the workspace header shows `progress`'s label (or the link's stage: "Queued behind 2 jobs (see Queue)", "Waiting for your choice"), with Cancel, and your page is covered so nothing is edited after the snapshot. Once the link's job exists the button reads "Stay here": the job goes on whatever the user does (it is not stopped), and the workspace stays open.
- **The app's question** ("Save as new geometry", "Overwrite", "Keep editing", see "Linking a geometry (1.5)") shows inside the leave, over your page: your `linkGeometry` stays pending. "Keep editing" rejects it with `cancelled`, ends the leave and keeps the workspace open with no further question: return at once.
- **Long work.** The leave waits while a bridge call made during it is in flight (an upload, the link) and while the link's job is queued. The call that started the leave (your `nav.back()` or `results.openIn3D`, which wait for it) does not count. A hook with no `progress` and no call for **30 s** has stalled (the clock stops while an app dialog is open); a worker that exports for long must post progress at least every 10 s. Once the link's job exists (5 s after, or at once when it is queued) the header offers **"Continue in background"**: the workspace closes and the update goes on in the app. Your page closes with it, so your hook never returns: a camera meant for that landing must go on `linkGeometry`'s `view`. When the update lands the part is not framed again: it gets that view, unless the user moved the camera meanwhile, and with no view the user's camera stays as it is.
- **When it fails** (a throw, a stall, a refused link such as `unsaved`, your page gone), the app asks once: "Couldn't update the project", with your message, Stay (the default) or "Leave anyway". It says what became of the link: "<Geometry> keeps its last update." when none reached the app, "The update of <Geometry> goes on." when the app took it (its job runs on, whatever your page does), "<Geometry> was updated." when it went through (the update's report shows if the user stays). `signal` aborts when the user cancels, stays or the hook stalls.
- **A script that cannot ask** (`openProject` with `askToLeave: false`) runs the hook with no question: the app's link question is answered "Overwrite", and the leave goes on once the server has the link.
- **One leave at a time.** During a leave, Back is disabled and `nav.back()` answers `false`, also from inside the handler.
- **`setDirty` keeps its meaning,** "would be lost": a saved design that is not linked yet is not dirty.
- **The camera** (`ViewState`, optional, from the hook's result or `linkGeometry`'s `view`; the last one wins) is model mm in the frame of your export, Z up like the app's viewport: `position`, `target`, `up`, `projection` (`perspective` with the vertical angle `fovDeg`, or `orthographic` with the full visible `height` in mm). The app's window has another width, so the sides crop differently. A view with a number that is not finite, the position on the target, or `up` along the view direction is dropped. It is applied when the user goes Back to the project (the header's or your `nav.back()`) and the part shows (stage geometry or setup), also when the hook linked nothing because the design did not change: the project then shows the study's geometry with that camera. After "Continue in background" only `linkGeometry`'s `view` can arrive (see "Long work").

## Editing a project geometry (1.7)

A study kind that links geometry can also **edit a geometry the user imported**: a STEP, IGES or BREP part. Declare a **geometry action** and the app offers it, the same way for every plugin, in three places: the right-click menu of the geometry (and its bodies) in the tree, the viewport's right-click on the part, and a button in the Geometry panel. "Edit in CAD" is the CAD plugin's.

```toml test
key = "part-editor"
name = "Part editor"
version = "0.1.0"
api_version = "1.7"
license = "GPL-3.0-or-later"
description = "Edits imported parts"
authors = "Your Name"

[[workspaces]]
key = "editor"
title = "Part editor"
entry = "workspace/index.html"

[[study_kinds]]
key = "part"
title = "Part"
workspace = "editor"
links_geometry = true            # the edit goes back as a link

[[geometry_actions]]
study_kind = "part"              # required: a kind with a workspace and links_geometry = true
label = "Edit in Part editor"    # required, 1-40 characters
hint = "Open this part here. Back updates it in the project."   # optional, up to 120 characters
formats = ["step", "iges", "brep"]                 # optional; the default is all three
places = ["tree", "viewport", "panel"]             # optional; the default is all three
```

- **What a click does.** The app opens a study of your kind for that geometry, at its workspace's address: the study that links the geometry (after its first edit went back), else the newest study of your kind that edits it and links nothing yet, else a **new study named after the geometry** ("Vortex", then "Vortex (2)" when that name is taken). The app runs this on one lane, so two tabs never make two studies. The new study's record carries `edits_geometry: {id, name, at}`; it is the app's, and `study.update` cannot change it. Until its first edit goes back, the study is shown on the geometry's row ("Being edited in <study>", with Edit), not in STUDIES: nothing of the project changed yet. The app's question about a new shape names the geometry ("<Geometry> has a new shape"), and "Save as new" names the copy after it ("<Geometry> v2").
- **When it is off.** The item is shown disabled with the reason under it: a mesh import ("<Geometry> is a mesh (STL); Edit in CAD needs a STEP, IGES or BREP part."), a source file that is missing, a geometry that is updating, one another plugin's study links ("<Geometry> comes from <Study> (<Plugin>). Edit it there."), or one taken over by a study that was deleted since (its original is kept: the reason says to add it as a new geometry and edit that). A plugin that is off shows nothing. `"mesh"` and a format or place this host does not know are left out with a warning on your plugin's Settings row; none left is an error. At most one action per kind.
- **What your page gets.** `ws.context.geometry` is the geometry the study edits: `{id, name, format, fileName, linked, rev, bodies, faces}` (`linked` false until its first edit went back). `ws.context.launch` says what the user right-clicked in the viewport (`{face: "face 3@Body1", body: "Body1"}`), once, for the page load the action opened; a reload has none.
- **Read the part.** `ws.project.geometrySource({signal, onProgress})` gives the geometry's file as a `File` (always STEP in 1.7: an IGES or BREP import comes as the STEP the app made of it, the one its faces were numbered from), with its `sha256`. `ws.project.geometryFaces()` gives the face table in the app's order (each face's `index`, `body`, `label`, area, centroid, normal, surface type, and `uses`: the boundary conditions, materials, refinements and monitors that use it), with `sourceSha256`.
- **Send the edit back.** Link as in "Linking a geometry (1.5)". The **first** link of the study takes that geometry over (the same id; the app's question "Overwrite <Geometry>" first when a study has setup on it, "Save as new geometry" leaves it as it was). Pass `originalNames`: a face-name file of the ORIGINAL geometry, one row per face of `geometryFaces()` in its order, its `shape_sha256` that call's `sourceSha256`, each face named as your design names it now, **with the fingerprint of the face the row names**: its `centroid`, `area` and `normal` from `geometryFaces()` (mm). The app puts those names on the original's faces, so a boundary condition follows its face to the face of the same name in the new shape (then by shape). It checks each row's fingerprint against its face (the tolerances of the app's own face match): a row that names another face loses its name, so that face follows by shape only (a face that moved is then lost and listed, never put on the wrong face), and `LinkResult.unverified` counts such rows. When more than 20 % of the rows do not match, or the file does not describe the original, the link is refused at the call with `bad_face_names` ("originalNames: 3 of 6 faces don't match <Geometry>", "originalNames does not describe <Geometry>: <rule>"). A face with no name follows by shape only. Link only when the design changed: opening the page and going back changes nothing in the project. After the update the app says so: "<Geometry> updated from <Study>. The original file is kept: Geometry panel → Add the original as a new geometry."
- **The original is kept.** The geometry's source files move to its `link/original/` folder. Later, `geometrySource()` serves that original (`adopted: true`), `linkedGeometry()` says `adopted` and `original`, and the Geometry panel offers "Add the original as a new geometry" (the original imported again beside it, as "<file> (original)").
- **A removed geometry.** When the user removes the geometry your study edits or links, the study stays (STUDIES lists it with "Its geometry <Geometry> was removed"), and the app's remove question says so: "The <workspace> <kind> '<Study>' that edits it stays. It won't add the geometry back unless you choose to." The study's record gets the app's `geometry_removed: {id, name, at}` (read-only, like `edits_geometry`), and `ws.context.geometry` is null. The study never takes over another geometry, even a new one with the same name. Its next `linkGeometry` (with or without a change) adds nothing on its own: the app asks, in the same dialog as its other question, "<Geometry> was removed from the project. Add <Study> as a new geometry?". **"Add as new geometry"** adds the part as a first link does (named after the study, or "<Study> v2" when another geometry has that name; `created: true`) and the mark goes. **"Not now"** adds nothing: the call rejects with `not_now`; inside a leave the leave goes on and Back returns to the project. Treat it as "done, nothing linked", show no error; the next link asks again. **"Keep editing"** rejects with `cancelled`, as for the other question. A link sent to the app's route by something that cannot show the question is refused `target_removed` with those words, and nothing is added.
- **Refusals** (`.code`): `not_allowed` (the study edits no geometry), `gone`, `no_source` (a geometry a link made has no STEP, or the import's STEP is missing), `not_ready` (the geometry is updating, or the app has not read its faces yet: it reads them when the geometry is shown; try again after `.retryAfter` seconds), `adopted` (another study took the geometry over first), `bad_face_names`, and, from a link, `not_now` and `target_removed` (above).

```ts test
import { connect, type GeometryFaces } from '@magnusim/workspace';

const ws = await connect();
const g = ws.context.geometry;
if (g && !g.linked) {
  const read = async () => {
    for (;;) {
      try {
        return await ws.project.geometrySource({ onProgress: (done, total) => console.log(done, '/', total) });
      } catch (e) {
        const err = e as { code?: string; retryAfter?: number };
        if (err.code !== 'not_ready') throw e;
        await new Promise((r) => setTimeout(r, (err.retryAfter || 3) * 1000));
      }
    }
  };
  const source = await read();
  console.log(source.file.name, source.size, source.sha256);
  const table: GeometryFaces = await ws.project.geometryFaces();
  const launch = ws.context.launch;
  if (launch?.face) console.log('select', launch.face, 'of', table.faces.length);
  // ...import source.file, edit it, export the design (part.bbrep, face_names.json), then
  // name the ORIGINAL's faces as the design names them now:
  const sid = ws.context.study.id;
  const originalNames = {
    format: 'magnusim.face-names',
    version: 1,
    length_unit: 'mm',
    shape_sha256: table.sourceSha256,
    bodies: table.bodies.map((b) => ({ index: b.index, id: `b${b.index}`, name: `Part ${b.index}` })),
    // Each row names a face of your design and carries THAT face's fingerprint, as geometryFaces()
    // gave it for the face you matched it to (here every face kept its place).
    faces: table.faces.map((f) => ({ index: f.index, body: f.body, name: `F:import:${f.index}`, centroid: f.centroid, area: f.area, normal: f.normal })),
  };
  const orig = await ws.files.write(`studies/${sid}/export/original_names.json`, JSON.stringify(originalNames));
  const shape = await ws.files.write(`studies/${sid}/export/part.bbrep`, new Uint8Array([1, 2, 3]));
  const study = await ws.study.get();
  const sourceVersion = (Number(study.source_version) || 0) + 1;
  await ws.study.update({ source_version: sourceVersion }, study.rev);
  const r = await ws.project.linkGeometry({
    shape: { rel: shape.rel, format: 'brep', sha256: shape.sha256 },
    originalNames: { rel: orig.rel, sha256: orig.sha256 },
    sourceVersion,
    basedOnRev: null,
  });
  console.log(r.geometryId === g.id, r.rev, r.adopted, r.unverified);
}
```

`python/tests/fixtures/edit-plugins/edit-demo/` is a complete example, driven by `e2e/geometry-actions.spec.js`.

## Assistant tools in a workspace (unreleased)

Not released yet (the next minor, 1.9): the host still reports 1.8, so a page checks that `ws.assistant` exists. A workspace page can offer **tools** that the app's assistant may call while the page is open. The user asks in words; the model picks a tool and its input; the app checks the input, asks the user when the tool needs it, and your handler runs in the page with the page's own state.

```ts test
import { connect, type AssistantCall, type AssistantTool } from '@magnusim/workspace';

const ws = await connect();
let count = 0;
const none = { type: 'object', properties: {}, additionalProperties: false } as const;
const tools: AssistantTool[] = [
  { name: 'get_count', description: 'Says the counter.', inputSchema: none, risk: 'read' },
  {
    name: 'slow_add',
    title: 'Add to the counter slowly',
    description: 'Adds a whole number to the counter, one step at a time.',
    inputSchema: { type: 'object', properties: { by: { type: 'integer', minimum: -100, maximum: 100 } }, required: ['by'], additionalProperties: false },
    risk: 'edit',
    timeoutS: 30,
  },
  { name: 'reset', title: 'Reset the counter', description: 'Sets the counter to 0. It cannot be undone.', inputSchema: none, risk: 'destructive' },
  { name: 'snap', description: 'A picture of the counter.', inputSchema: none, risk: 'read' },
];

async function run({ tool, input, signal, progress }: AssistantCall) {
  if (tool === 'get_count') return { data: { count } };
  if (tool === 'reset') {
    count = 0;
    return 'The counter is 0.';
  }
  if (tool === 'snap') {
    const canvas = new OffscreenCanvas(64, 64);
    return { text: `The counter shows ${count}.`, images: [{ mediaType: 'image/png' as const, data: await canvas.convertToBlob() }] };
  }
  const by = Number(input.by);
  if (by === 0) {
    // The message says what went wrong, the hint how to fix it, the detail what it refers to.
    throw Object.assign(new Error('by must not be 0'), { code: 'invalid_input', hint: 'Send a whole number from -100 to 100 other than 0.', detail: { field: 'by' } });
  }
  for (let i = 0; i < Math.abs(by); i++) {
    // Stopped (the user's Stop, a stall, leaving the workspace): change nothing more.
    if (signal.aborted) throw new Error('Stopped');
    progress(i / Math.abs(by), `Adding ${i + 1} of ${Math.abs(by)}`);
    await new Promise((r) => setTimeout(r, 200));
    count += Math.sign(by);
  }
  // The summary is the turn log's line for this call; the model gets text and data.
  return { text: `The counter is ${count}.`, data: { count }, summary: `Added ${by}: the counter is ${count}` };
}

const assistant = ws.assistant;
if (assistant) {
  // The person's request its calls belong to: as it starts, changes and ends (listen before register).
  assistant.onTurn((turn) => console.info(`${turn.state}: ${turn.title} (${turn.used.steps} of ${turn.used.stepsCap} steps)`));
  const reg = await assistant.register(tools, run, { guide: 'The counter workspace keeps one whole number, shown in the middle of the page.' });
  for (const r of reg.refused) console.warn(`${r.name} was refused (${r.code}): ${r.message}`);
}
```

- **One call sets the tools and their handler.** `register(tools, handler, {guide})` replaces what the page offered before; `register([], null)` withdraws everything. It resolves with the app's verdict: `accepted` (the names the assistant may call) and `refused` (each with `code` and `message`: a bad name, a schema keyword the app does not take, a duplicate). The handler is kept only once the app answered: with `available: false` nothing changes. `reason: 'not_connected'` means the tab could not reach the assistant yet, often because it opened in the background: register again later, for example on `visibilitychange`. On a host without it, `ws.assistant` is absent (a host that has the SDK but not the call refuses with `not_allowed`).
- **Names and schemas.** A name is 1 to 32 of `a-z`, `0-9` and `_`, starting with a letter, never `__`; at most 32 tools in at most 512 KB. `inputSchema` is a strict subset of JSON Schema: every object lists its `properties` and says `additionalProperties: false`; `enum`, `const`, `minimum`/`maximum`, `minLength`/`maxLength`, `minItems`/`maxItems`, `description` and `title` are allowed; `$ref`, `oneOf`, `anyOf`, `allOf`, `pattern`, `format`, `default` and lists of types are not. The app checks every constraint before your handler runs, but the model may see the numeric and length limits only as words in the description: say them there too.
- **Risk.** `read` changes nothing; `edit` changes the page's own state; `compute` starts long work or takes the app's compute slot; `destructive` cannot be undone. The app asks the user before every `compute` and `destructive` call (the question opens with "Don't" focused), and an unknown risk counts as `destructive`. Never claim a lower risk than the tool has. A `destructive` tool's `confirm` (one sentence) is what that question says the call does, in place of "can't be undone" (below).
- **The handler** gets `call`, `turn` (the same for every call of one request of the user's: one undo step, for example; a call from another app on this PC, through MCP, has no such request and reads `mcp:<connection id>`, the same for every call on that app's connection, which may stay open as long as the app runs, so end such a group after a pause or a change the user made too), `tool`, `input` (checked), `signal` and `progress(fraction, label?, {waiting?})`. It returns text, or `{text?, data?, images?, summary?}`, or nothing. `text` is at most 64 KB, `data` plain JSON of at most 256 KB, and `images` at most 4 PNG, JPEG or WebP Blobs of at most 1.5 MB and 2000 px a side each; more fails the call with `too_large`, and anything else with `bad_result`. `summary` is the turn log's line for the call (at most 160 characters; "Done" without one), never the model's. A throw fails the call: its `code` is kept when it is `invalid_input` (the input makes no sense here), `busy` (the user is in the middle of something) or `not_ready`, and reads `failed` otherwise; its `message`, `hint` and `detail` reach the model (below). A result that cannot be copied to the app (a function in `data`) fails the call too.
- **Time.** One call runs at a time in a page; a second gets `busy`. `timeoutS` (1 to 600, default 60) is a stall window, not a total limit: each `progress`, and each bridge call of your page in flight (an upload, a service call), keep the call alive. A call that says nothing for `timeoutS` is stopped (`stalled`); a hidden tab slows timers and stops `requestAnimationFrame`, so a long tool there should report progress from its work, not from animation frames. A call that waits for the person says so with `progress(null, 'Waiting for you to close the Extrude panel', {waiting: true})`: until its next progress without it, or its end, that time does not count toward the turn's minutes (Minutes per turn, Settings → Assistant), for 20 minutes of one call's waits at most (past them they count).
- **Stop.** `signal` aborts when the user stops the turn (the app waits 2 s for your last answer: a result that arrives then counts as done, and the assistant gets it; an error, or no answer, reads as stopped, and it may or may not have finished), when the call stalls, when the user leaves the workspace (`leaving`: an exit hook runs after it) and when the page closes or reloads (`closed`). Stop then and change nothing more.
- **What reaches the model.** What a tool returns reaches the model as data, never as instructions, and it is project data: with a cloud provider the app asks the user before any of the project goes out. Tool names and descriptions go into the tool definitions the model is given, and the `guide` into its instructions for the conversation: both are your plugin's own text, trusted like its code, so keep them fixed and never fill them from a project. The `guide` is fixed text about your workspace (at most 4000 characters, its lines kept) with no project data in it; the first one a conversation sees is kept for that whole conversation. Progress labels go to the turn's log, where the person sees them; the model does not.
- **When the tools go.** The page closing or reloading, leaving the workspace and turning the plugin off withdraw them; a reloaded page registers again. Only the tab's own workspace offers tools to a request started in that tab.
- **Turns.** `ws.assistant.onTurn(fn)` hears each turn bound to this tab (`AssistantTurn`): `running` as it starts and after each change (at most once a second), `ended` once with `end: {state, reason}`. It gives the turn's `id` (the `turn` of its calls), a `title` (the first line of the person's request, at most 60 characters), `local` (a local server), `contextTokens` and `images` (null while unknown) and `used` (`steps`, `stepsCap`, `usd`, `usdCap`; a turn on a coding agent counts its calls against its own cap and no dollars). Listen before `register`: a page that offers tools hears the turns already running. An `ended` with no `end` means the page did not hear how it ended (its link was down). `ws.assistant.stop(turn)` stops a turn told to this tab, as the person's Stop does, and resolves `{stopped}` once it ended, or `{stopped: false, reason}` (`not_this_tab`, `ended`, `not_connected`, `no_assistant`, `not_allowed`).

### Designing workspace tools

A model corrects itself from what your tool tells it. These make that easy:

- **Say how to fix it.** Throw an error with a `code`, a `message` that says what went wrong, a `hint` that says how to fix it in one sentence ("Call add with by set to 1, 2 or 3."), and a `detail` of plain JSON the model can act on: the field, the candidates, the allowed range. The model reads all four in its next request as `{"tool", "ok": false, "error": {"code", "message", "hint", "detail"}}`. A `hint` is cut to 500 characters. A `detail` past 4 KB as JSON, or one that is not plain JSON, is dropped and the message ends " (detail too large)" or " (detail not plain JSON)"; the SDK sends what JSON makes of it (a `Date` as its text, a function left out). A fixed word at the start of the message (`step_too_big: …`) gives the model, and your tests, something stable to match.
- **Name what it did.** Return a `summary`: one line, at most 160 characters, that names what the call did ("Added 2: the counter is 2"). It is the turn log's line for the call, where the person reads it; the model never gets it, so whatever the model needs goes in `text` or `data`. A failed call's log line is its message, with its hint under it.
- **Wait for the person instead of refusing.** When the person is in the middle of something your tool would disturb (a panel of theirs open, a value being typed), wait until they finish rather than failing at once: a model told `busy` tends to call again and again, spending the turn's steps. While you wait, send `progress(null, label, {waiting: true})` every few seconds, the label saying what you wait for: it keeps the call from stalling, shows the person why, and stops the turn's minutes. Give up after a bound (minutes, not hours) with `busy`, a message that says what the person is doing, and a `hint` that tells the model to say what it needs and end its turn. Reads never need to wait.
- **Say what the question means.** The app asks the person before each call of a `destructive` tool, and by default the question says the call "can't be undone". When that is not true (your page has its own undo, or the change is easy to put back), give the tool a `confirm`: one sentence of fixed text, at most 120 characters, that says what a call does and how to take it back ("Deletes features from the Part; Ctrl+Z brings them back."). It replaces "can't be undone" in the question; a full stop is added when it has none. Keep project data out of it, as out of the `guide`: it is your plugin's own text. A `compute` tool's question always says "starts a computation".
- **Group by turn.** Every call of one request of the person's carries the same `turn`, and `onTurn` says when that turn starts and ends: make its edits one undo step named after its `title` ("Assistant: plate with four holes"), show that the assistant is working while it runs, and offer Stop in your own page with `stop(turn)`.
- **Make each call all or nothing.** A call does the whole step it names, or changes nothing and fails saying why: when a later part of it fails, or the call is stopped or stalls, put back what its earlier parts changed before you throw. The model then never builds on half a step, and can call again with its input fixed. A step that takes several edits (a sketch and the feature made from it) is one call.
- **Keep every field required, with an empty value for "unused".** List every property of an input in `required`, let `""`, `[]` and `false` mean "not used", and say in its description what to send when it does not apply. With the first cloud dialect, the provider makes the model's input fit the schema as the model writes it (strict), but only within one budget per request: 20 tools, 24 optional properties and 16 properties of more than one type, all tools counted together. It is granted in the order the tools are offered: the host's tools first, then yours by name. A tool past it is sent unchecked by the provider (the app still checks every input), so each optional property can cost a tool after it its strictness. The other cloud dialect sends optional properties as required ones that may be null; a local server is never strict. A local model often leaves out the fields it has no use for: on a local server the app gives a missing or null required string (without `enum` or `const`, and no `minLength` above 0), list (no `minItems` above 0) or boolean that empty value before it checks the input, and guesses nothing else (numbers, enums and objects stay missing, and so does a string or list your schema says may not be empty). An input that is still wrong is refused once, with every problem named (`invalid_input`: up to 12, in at most 2000 characters), so the model fixes them in one round. Your handler only gets an input that passed.
- **Keep the set small.** A request offers the model at most 40 tools with a cloud provider and 24 with a local server. Your workspace's tools are kept first, in name order, and the host's tools fill the room left; past the cap, the tools after it in name order are not offered in that request at all. Fewer tools also take less of a local model's context, and it picks among them better. When you offer more than 24, make sure the ones a local turn needs come first by name.
- **What the model sees of a result.** One line of JSON per call, cleaned: every run of whitespace, line breaks included, becomes one space, so keep `text` to a sentence or two and put structure in `data`. Strings stop at 2000 characters, lists at 200 items, objects at 200 keys, and nesting at 8 levels (deeper parts read `null`); `text` stops at 16 KB and the whole result at 32 KB, each cut marked `"truncated": true`. Keep results compact, give numbers their units in the key (`length_mm`), and offer a short and a full form when the full one is large.
- **Leave room in a local model's context.** On a local server every request carries the whole conversation and every tool's name, description and schema, and the answer gets what the model's context leaves after them, with 1024 tokens kept free: at most 8192 tokens (32,000 on a server on another computer). With less than 2048 left the turn ends `failed` (`context`) and the person is asked to load the model with a longer context. So keep descriptions and schemas short and results compact, and say in your plugin's documentation what context your tools need. A model whose server says it reads no images gets a line of text in place of each picture: whatever it must know from one goes in `text` or `data` as well.
- **When the provider can't compile your schemas strictly.** With a cloud provider the app asks for each tool's input to be decoded strictly against its schema, the app's own tools first, as far as the provider's strict limits go (each optional field counts against them). If the provider refuses to compile the set, the request goes again with your tools not strict (the app's own stay strict) and the turn's log says so; the app still checks every input before your handler gets it. Fewer optional fields keep a set within those limits.

## UI kit (1.3)

`@magnusim/plugin-ui` holds components and helpers that look like the app's own panels, drawn with the `--mg-*` tokens. In the page use `host.pluginUi.kit`, or import it from a `.tsx` UI the host bundles; in a workspace frame import `@magnusim/plugin-ui`. Both run the same code, so a panel looks the same in either place. The types are in `docs/plugins/plugin-ui.d.ts` (also served as `/plugin-sdk/plugin-ui.d.ts`), and the kit's version is `PLUGIN_UI_API_VERSION`.

```javascript
// workspace/main.js
import { connect } from '@magnusim/workspace';
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, PanelChrome, Toggle } from '@magnusim/plugin-ui';

const ws = await connect();
function Bench() {
  const [on, setOn] = useState(false);
  return h(PanelChrome, { title: 'Bench', card: true, onDone: () => ws.nav.back() },
    h(Toggle, { label: 'Viscous', checked: on, onChange: setOn }),
    h(Button, { variant: 'primary', onClick: () => ws.ui.toast('Saved', { kind: 'success' }) }, 'Save'));
}
createRoot(document.getElementById('root')).render(h(Bench));
```

The components, each as the core draws it today:

- `Button`: `primary`, `secondary` (the default), `neutral` (Done), `link`, `fix` and `danger`; `block` for the full width.
- `NumberUnitInput`: a number in a unit, kept in SI. `onCommitSi` runs on blur and Enter, Escape puts the value back, and `quantity` with `units` picks the unit shown. `width` is `narrow`, `wide` or `fill`.
- `Select`: the BC and Materials panels' select.
- `Toggle`: a switch (a real checkbox, so Space works) or the ON/OFF pill of schema forms.
- `Field`: a settings row, the label (with an optional help tip) on the left and the control on the right.
- `Hint` (a note under a control), `DisabledReason` (why something cannot run, with an optional fix) and `EmptyState` (an empty list or chart).
- `Icon`: `pencil`, `trash`, `back`, `document`, or your own 24 x 24 path.
- `PanelChrome`: a title, the body and a foot with Delete and Done, and no header buttons. `card` draws the card, for a frame; in the app's flyout the host draws it.
- `StatusBlock`, `Elapsed` and `useElapsed`: the progress block of the Mesh and Run panels.
- `Toast`, and `PanelError`, the card a failed panel shows.
- `LinePlot`: a small line chart, log or linear, with a hover readout and a legend. Its x axis is iterations, simulated seconds, or `kind: 'linear'`: a number axis with round ticks that may lie below zero, drawn in row order (a drag polar turns back). `ColorLegend`: a colour scale with its range.
- Helpers: `formatSci`, `parseSci`, `formatSimTime`, `formatElapsed` and `formatEta`; the unit tables and conversions (`UNITS`, `toSi`, `fromSi`, `convertQuantity`, `fieldUnit`, `fieldQuantity`, ...); the colour maps `rainbow`, `viridis`, `balance` and `curl` (`COLORMAPS`, `colormapRgb`, `colormapGradient`).

How they fit the app:

- **Done.** `PanelChrome` needs `onDone`: pass `pluginUi.panelDone` in the page and `() => ws.nav.back()` in a frame. The kit's Done sends only `cfd:panel-done`; the core's own Done handling (such as saving a refinement) does not run for it.
- **Toasts.** `pluginUi.toast(message, { kind })` shows an app toast at the bottom right; up to three stack, newest last, and while the pointer is on any of them none closes. From a frame, `ws.ui.toast` shows one at the bottom right of the workspace, one at a time. The app draws it over your frame, not in your page: a test finds it as `page.locator('[data-ws-toast]')`, not in the frame. Info and success close after 3.8 s and errors after 9 s; the time stops while the pointer or the focus is on a toast. A `Toast` of your own takes `paused` to hold its time the same way.
- **Units.** `pluginUi.unitSystem()` in the page and `ws.context.units` in a frame are `metric` or `imperial`; pass it to `NumberUnitInput`'s `units`.
- **Field widgets.** `SchemaField(widget="my-plugin.rate")` in Python puts `x-cfddesk.widget` on the field's schema, and `pluginUi.registerFieldWidget('my-plugin.rate', Rate)` draws that field with your component, typed `ComponentType<FieldWidgetProps>`. Render only the control (the form draws the row), and use `NumberUnitInput` with `width="fill"` for the form's width. A widget registered after a form opened replaces the core control at once. `python/tests/fixtures/kit-plugins/kit-demo` is a complete example, driven by `e2e/h14-kit.spec.js`.
- **Selects.** A kit `Select` looks like the BC and Materials panels' selects (`.bc-select`), not like a schema form's own selects. In a schema form pass `width="fill"` for the form's width; inside the study panel the core's `.sim-study-panel .schema-form select` restyles it.
- **Shared tables.** `UNITS`, `IMPERIAL_DEFAULT`, `SI_DEFAULT` and `COLORMAPS` are frozen: the app reads the same tables.
- **Older hosts.** A 1.2 host cannot load a frame that imports the kit: the module does not resolve, and the page shows "didn't start". Declare `api_version = "1.3"` in a plugin that uses the kit.

## Plugins tab

Settings → Plugins lists each plugin's name (or key), version, source (`bundled` from `bundled-plugins/`, `local` from `plugins/`, `update` for a newer copy of a bundled plugin in `plugins/`, or `entry_point` for a wheel), and status:

- `enabled`, shown as On, or as Required for a required plugin, which has no Disable button.
- `disabled`, shown as Off. An optional bundled plugin that ships off (`default_enabled = false`) is listed this way with "Ships with Magnusim and stays off until you turn it on."
- `needs setup`: its own environment is not installed on this PC yet; the row has **Install dependencies**.
- `missing requirement`: a WSL program or Python package in its `requires` is not found; its page UI and workspaces do not load. A missing GPU is only a note on an `enabled` row.
- `incompatible`: its `api_version` has a different major.
- `error`, shown as Failed to load, with the message (a manifest or `register` failure, a missing required plugin, or a UI bundle that failed in the page).

**Install plugin from zip…** installs a zip made by `npm run plugin:pack` after showing what it is; **Remove** (a user plugin), **Remove update** (a newer copy of a bundled plugin) and **Remove unused copies** delete its copies from `plugins/`. A copy that is not used says why under the plugin. [GUIDE.md](GUIDE.md), "Shipping a plugin, and updates", has the rules.

Enable and Disable call the plugin routes, reload the registry, and load or remove the plugin's UI at once. **Reload plugins** runs `registry.reload` and loads UI bundles again. It also stops every running plugin OpenFOAM case ("Stopped: plugins were reloaded") and takes every queued one off the queue. Disable, and removing a plugin's environment, stop only that plugin's cases; Enable and installing an environment stop nothing.

## License

Magnusim is GPL-3.0-or-later. A plugin runs inside the Magnusim Python worker and page, so a distributed plugin is part of a GPL-3.0-or-later combined work. License it under GPL-3.0-or-later or a GPL-compatible license such as MIT, BSD, Apache-2.0, or LGPL-3.0. The template declares GPL-3.0-or-later.

## Registry reference

`docs/plugins/registry.json` lists every key the core and the bundled plugins that are on by default register, per kind (analysis, solver, mesher, bc, bc_family, material, monitor, filter), with `plugins`, `default_analysis` and `missing`. A bundled plugin that ships off (Airfoil) and your own plugins are not in it; the app reads those from the live registry while it runs. `npm run gen:registry` (from `magnusim-web/`) regenerates it together with `scripts/generated/registry.json`.
