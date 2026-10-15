"""Heat Transfer's analysis contract: what blocks a run (in the user's words), the run
models, the launch spec, the registry rows the page reads, and the plugin as the host loads it."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from cfddesk.registry import contract as core_contract
from cfddesk.registry import get_registry, load_all, reset_for_tests
from cfddesk.registry.contract import ReadyContext
from ht_inputs import AIR, ALUMINIUM, CAVITY_BCS, CHANNEL_BCS, MESH_PATCHES, WATER

from heat_transfer import contract
from heat_transfer.analyses import STEADY_KEY, TRANSIENT_KEY

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def _ctx(
    *,
    materials=(AIR,),
    bcs=CHANNEL_BCS,
    study=None,
    patches=tuple(MESH_PATCHES),
    units: str | None = None,
) -> ReadyContext:
    project = Path(".")
    if units:
        import json
        import tempfile

        project = Path(tempfile.mkdtemp(prefix="ht-units-"))
        (project / "project.json").write_text(json.dumps({"units": units}), encoding="utf-8")
    return ReadyContext(
        project_dir=project,
        simulation_id="sim_1",
        run_id="run_1",
        mesh_id="mesh_1",
        mesh_case_dir=None,
        patches=tuple(patches),
        study=dict(study or {"time_dependency": "Steady-state"}),
        read_study=lambda _name: None,
        mesh={"mesh_id": "mesh_1", "mesh_name": "Mesh 1"},
        materials=tuple({**m, "simulation_id": "sim_1"} for m in materials),
        bcs=tuple({**b, "simulation_id": "sim_1"} for b in bcs),
    )


def _first(ctx: ReadyContext) -> dict | None:
    issues = contract.validate_ready(ctx)
    return issues[0] if issues else None


def test_a_ready_channel_and_cavity_have_no_issues():
    assert contract.validate_ready(_ctx()) == []
    assert contract.validate_ready(_ctx(materials=(WATER,), bcs=CAVITY_BCS, study={"gravity": "-y"})) == []


def test_a_solid_material_makes_the_study_conjugate_heat_transfer():
    """A solid body: the CHT checks run (heat_transfer.cht_ready); without a mesh case they
    stop at the mesh (test_ht5_cht.py has the rest)."""
    issue = _first(_ctx(materials=(AIR, ALUMINIUM)))
    assert issue is not None
    assert issue["message"] == "Mesh 1 has no case folder: generate it again."
    assert issue["fix"] == {"go": "mesh", "id": "mesh_1", "name": "Mesh 1"}
    # A solid's property at 0 is refused first, by name.
    issue = _first(_ctx(materials=(AIR, {**ALUMINIUM, "thermal_conductivity": 0})))
    assert issue["message"] == 'Material "Aluminium 6061": its thermal conductivity is 0; it must be above 0.'


def test_a_fluid_property_at_zero_is_refused_at_start():
    issue = _first(_ctx(materials=({**AIR, "thermal_conductivity": 0},)))
    assert issue["message"] == 'Material "Air": its thermal conductivity is 0; it must be above 0.'
    assert issue["fix"] == {"go": "material", "id": "m-air", "name": "Air"}
    # No thermal expansion is a real fluid (no buoyancy from temperature): forced convection runs.
    assert contract.validate_ready(_ctx(materials=({**AIR, "thermal_expansion": 0},), study={"gravity": "off"})) == []


def test_a_study_setting_saved_as_zero_is_refused_at_start():
    issue = _first(_ctx(study={"time_dependency": "Steady-state", "operating_pressure": 0}))
    assert issue == {"message": "Study settings: the operating pressure must be above 0.", "fix": {"go": "study"}}
    issue = _first(_ctx(study={"time_dependency": "Steady-state", "relax_h": 0}))
    assert issue["message"] == "Study settings: the relaxation energy is 0; it must be above 0 and at most 1."


def test_materials_must_be_one_assigned_fluid():
    assert _first(_ctx(materials=()))["message"] == "Assign a fluid to a volume first"
    other = {**WATER, "id": "m-w2", "assigned_volumes": ["Body2"]}
    issue = _first(_ctx(materials=(AIR, other)))
    assert "This simulation has 2 fluids (Air, Water); it solves one fluid." in issue["message"]


def test_every_bc_needs_its_patch():
    issue = _first(_ctx(patches=("walls", "inlet")))
    assert issue["message"].startswith('Mesh has no patch for "outlet"')
    assert issue["fix"]["go"] == "mesh"


def test_a_closed_domain_needs_something_to_move_it_and_a_heated_wall():
    issue = _first(_ctx(materials=(WATER,), bcs=CAVITY_BCS, study={"gravity": "off"}))
    assert issue["message"] == (
        "Nothing moves the fluid: the domain is closed, gravity is off and no wall moves. Turn gravity on "
        "(natural convection), make a wall Moving or Rotating, or add an inlet and an outlet."
    )
    adiabatic = [{**b, "thermal_condition": "adiabatic"} for b in CAVITY_BCS]
    issue = _first(_ctx(materials=(WATER,), bcs=adiabatic, study={"gravity": "-y"}))
    assert "every wall is adiabatic" in issue["message"]


def test_a_lid_driven_cavity_is_moved_by_its_wall():
    """Gravity off, closed, but the lid slides: the fluid moves (forced convection in a box)."""
    lid = [*CAVITY_BCS, {"id": "bc-lid", "name": "lid", "bc_type": "Wall", "wall_type": "Moving",
                         "wall_velocity": [0.1, 0, 0], "faces": ["face 5@Body1"]}]
    assert contract.validate_ready(_ctx(materials=(WATER,), bcs=lid, study={"gravity": "off"})) == []
    spun = [{**b, "wall_type": "Rotating", "rotation_axis": [0, 0, 1], "rotation_speed": 10} if b["name"] == "lid" else b
            for b in lid]
    assert contract.validate_ready(_ctx(materials=(WATER,), bcs=spun, study={"gravity": "off"})) == []


def test_a_closed_steady_case_heated_only_by_fluxes_is_refused():
    """With no fixed-temperature or HTC wall, nothing sets the temperature level: no steady state."""
    fluxes = [
        {**CAVITY_BCS[0], "thermal_condition": "heat_flux", "wall_heat_flux": 100},
        {**CAVITY_BCS[1], "thermal_condition": "heat_flux", "wall_heat_flux": -100},
        CAVITY_BCS[2],
    ]
    issue = _first(_ctx(materials=(WATER,), bcs=fluxes, study={"gravity": "-y"}))
    assert issue["message"].startswith("A steady solve of a closed domain needs a wall that can take heat out")
    assert "solve it as a transient study" in issue["message"]
    # A transient run of the same box warms or cools in time: it runs.
    assert contract.validate_ready(
        _ctx(materials=(WATER,), bcs=fluxes, study={"gravity": "-y", "time_dependency": "Transient"})
    ) == []
    # One heat transfer coefficient wall gives the heat a way out.
    htc = [fluxes[0], {**CAVITY_BCS[1], "thermal_condition": "heat_transfer_coefficient", "wall_htc": 5}, CAVITY_BCS[2]]
    assert contract.validate_ready(_ctx(materials=(WATER,), bcs=htc, study={"gravity": "-y"})) == []


def test_a_slip_wall_with_heat_through_it_is_refused():
    slip = [{**b, "wall_type": "Slip"} if b["name"] == "heater" else b for b in CHANNEL_BCS]
    issue = _first(_ctx(bcs=slip))
    assert issue["message"] == (
        'Wall "heater" is a slip wall with a heat flux: a slip wall has no boundary layer, so the heat through it '
        "would be wrong. Make it a No-slip wall, or set its Thermal to Adiabatic."
    )
    assert issue["fix"] == {"go": "bc", "id": "bc-heat", "name": "heater"}
    fixed = [{**b, "wall_type": "Slip"} if b["name"] == "cold_plate" else b for b in CHANNEL_BCS]
    assert "is a slip wall with a fixed temperature" in _first(_ctx(bcs=fixed))["message"]
    quiet = [{**b, "wall_type": "Slip", "thermal_condition": "adiabatic"} if b["name"] == "heater" else b for b in CHANNEL_BCS]
    assert contract.validate_ready(_ctx(bcs=quiet)) == []


def test_openings_need_a_pressure_level():
    no_outlet = [b for b in CHANNEL_BCS if b["name"] != "outlet"]
    no_outlet.append({"id": "vo", "name": "lid", "bc_type": "Velocity outlet", "value": 0.5, "unit": "m/s", "faces": ["face 5@Body1"]})
    assert _first(_ctx(bcs=no_outlet))["message"] == "Add a pressure boundary with an assigned face"


def test_density_models_against_gravity_and_the_fluid():
    issue = _first(_ctx(study={"density_model": "constant", "gravity": "-z"}))
    assert issue["message"].startswith("Constant density cannot carry buoyancy")
    assert contract.validate_ready(_ctx(study={"density_model": "constant", "gravity": "off"})) == []
    issue = _first(_ctx(materials=(WATER,), study={"density_model": "perfect_gas"}))
    assert "Incompressible perfect gas is for gases, and Water is a liquid (998 kg/m³). Use Boussinesq." == issue["message"]


def test_the_boussinesq_guard():
    hot = [{**b, "wall_temperature": 600.0} if b["name"] == "heater" else b for b in CAVITY_BCS]
    # Air on Boussinesq: beta 3.411e-3, 600 K against 293.15 K: 1.05.
    issue = _first(_ctx(bcs=hot, study={"density_model": "boussinesq", "gravity": "-y"}))
    assert "β·ΔT is 1.05 (326.9 °C at heater against the reference 20 °C), and it must stay below 0.2." in issue["message"]
    # An imperial project reads the same numbers in °F.
    imperial = _ctx(bcs=hot, study={"density_model": "boussinesq", "gravity": "-y"}, units="Imperial")
    assert "β·ΔT is 1.05 (620.3 °F at heater against the reference 68 °F)" in _first(imperial)["message"]
    assert "Use incompressible perfect gas" in issue["message"]
    # The same temperatures as a perfect gas solve.
    assert contract.validate_ready(_ctx(bcs=hot, study={"gravity": "-y"})) == []
    # Water at 30 °C against 20 °C: 0.002.
    assert contract.validate_ready(_ctx(materials=(WATER,), bcs=CAVITY_BCS, study={"gravity": "-y"})) == []


def test_bc_problems_come_with_their_name():
    bad = [{**b, "turbulence_spec": "Intensity and length scale", "turbulence_intensity": 0} if b["name"] == "inlet" else b
           for b in CHANNEL_BCS]
    issue = _first(_ctx(bcs=bad))
    # Incompressible Flow's own sentence for its own check (flow_bcs.BoundaryProblem.message).
    assert issue["message"].startswith('Turbulence at the inlet of "inlet": the turbulence intensity')
    assert issue["fix"] == {"go": "bc", "id": "bc-in", "name": "inlet"}
    cold = [{**b, "wall_htc": 0} if b["name"] == "lid" else b for b in CHANNEL_BCS]
    assert _first(_ctx(bcs=cold))["message"] == '"lid": its heat transfer coefficient must be above 0.'
    table = [{**b, "time_varying": True, "time_table": [[0, 0], [1, 5]]} if b["name"] == "outlet" else b for b in CHANNEL_BCS]
    assert contract.validate_ready(_ctx(bcs=table)) == []
    issue = _first(_ctx(bcs=table, study={"time_dependency": "Transient"}))
    assert '"Varies with time" is not used on pressure boundaries' in issue["message"]


def test_run_models():
    assert contract.STEADY_RUN_MODEL.defaults() == {"end_time": 1000, "write_interval": 100}
    assert contract.STEADY_RUN_MODEL.normalize({"end_time": "250", "write_interval": 0}) == {"end_time": 250, "write_interval": 1}
    t = contract.TRANSIENT_RUN_MODEL.normalize({"end_time": 4, "write_count": 8, "max_delta_t": 9, "settle": None})
    assert t["end_time"] == 4 and t["write_count"] == 8 and t["max_delta_t"] == 0.5 and t["settle"] is None
    preview = contract.TRANSIENT_RUN_MODEL.preview(settings={"end_time": 2, "write_count": 4})
    assert preview["partial"] and preview["control"]["write_interval"] == 0.5


@pytest.fixture
def loaded():
    reset_for_tests()
    load_all()
    yield get_registry("analysis")
    reset_for_tests()


def test_the_analyses_as_the_registry_holds_them(loaded):
    steady, transient = loaded.get(STEADY_KEY), loaded.get(TRANSIENT_KEY)
    assert loaded.owner(STEADY_KEY) == "heat_transfer"
    assert steady.family.key == transient.family.key == "heat_transfer"
    assert steady.material_models == ("thermo_fluid", "thermo_solid")
    assert steady.region_roles == ("fluid", "solid")
    assert steady.solver_backends == ("buoyantSimpleFoam", "chtMultiRegionSimpleFoam")
    assert [g.key for g in steady.bc_fields] == ["ht_inlet_thermal", "ht_opening_thermal", "ht_wall_thermal"]
    launch = core_contract.launch_spec(steady, get_registry("solver"))
    assert (launch.app, launch.keep_frames, launch.kinematic_fields, launch.frame_fields) == (
        "buoyantSimpleFoam", "latest", (), ("T", "U"))
    assert launch.prepare_job == "heat_transfer.write_run_case"
    tl = core_contract.launch_spec(transient, get_registry("solver"))
    assert (tl.app, tl.keep_frames) == ("buoyantPimpleFoam", "all")
    assert core_contract.study_defaults(steady, "steady")["analysis"] == "Heat transfer"
    rows = {r["key"]: r for r in core_contract.result_fields(steady)}
    assert rows["T"]["label"] == "Temperature" and rows["T"]["unit_quantity"] == "temperature"
    assert rows["wallHeatFlux"]["unit"] == "W/m²"
    quantities = {q["key"]: q for q in core_contract.monitor_quantities(steady)}
    assert quantities["T_pt"]["unit_quantity"] == "temperature" and quantities["Q"]["unit"] == "W"
    # Incompressible Flow stays the default analysis.
    from cfddesk.registry.analysis import default_analysis_key

    assert default_analysis_key() == "incompressible_steady"


def test_the_host_loads_it_from_a_plugins_folder(tmp_path):
    """Copied into a plugins folder beside Incompressible Flow, it loads with no failure."""
    web = tmp_path / "web"
    for key in ("heat_transfer", "incompressible_flow"):
        shutil.copytree(
            PLUGIN_DIR.parent / key,
            web / "bundled-plugins" / key,
            ignore=shutil.ignore_patterns("tests", "e2e", "__pycache__", "*.pyc", "node_modules"),
        )
    reset_for_tests()
    try:
        hub = load_all(web_root=web, force=True)
        assert [f for f in hub.failures if f["key"] == "heat_transfer"] == []
        manifest = hub.manifests["heat_transfer"]
        assert manifest.license == "GPL-3.0-or-later"
        assert manifest.version == "0.1.0-dev"
    finally:
        reset_for_tests()


def test_the_core_session_runs_these_tests_before_incompressible_flows():
    """Incompressible Flow's tests import their constants ``from conftest``: whichever
    folder conftest pytest loaded last. This folder's must load before theirs, so its
    testpaths entry comes first in the core's pytest config (nothing here imports conftest)."""
    import re

    text = (PLUGIN_DIR.parents[1] / "python" / "pyproject.toml").read_text(encoding="utf-8")
    paths = re.findall(r'"([^"]+)"', re.search(r"^testpaths\s*=\s*\[([^\]]*)\]", text, re.M).group(1))
    own, other = "../bundled-plugins/heat_transfer/tests", "../bundled-plugins/incompressible_flow/tests"
    assert own in paths and paths.index(own) < paths.index(other)
    imports = re.compile(r"^\s*(from conftest import|import conftest)", re.M)
    assert not any(imports.search(p.read_text(encoding="utf-8")) for p in Path(__file__).parent.glob("*.py"))


def test_incompressible_flows_checks_come_in_its_starts_order():
    """A wall problem on an earlier record and a turbulence problem on a later one: Start says
    the turbulence problem first, as Incompressible Flow's own Start does (flow_bcs.first_boundary_problem)."""
    spun = {"id": "bc-lid", "name": "lid", "bc_type": "Wall", "wall_type": "Rotating", "rotation_axis": [0, 0, 0],
            "faces": ["face 5@Body1"]}
    bad_inlet = {**CHANNEL_BCS[0], "turbulence_spec": "Intensity and length scale", "turbulence_intensity": 0}
    bcs = [spun, bad_inlet, *CHANNEL_BCS[1:4], CHANNEL_BCS[5]]
    issue = _first(_ctx(bcs=bcs))
    assert issue["message"].startswith('Turbulence at the inlet of "inlet":')
    assert issue["fix"] == {"go": "bc", "id": "bc-in", "name": "inlet"}
    laminar = _first(_ctx(bcs=bcs, study={"time_dependency": "Steady-state", "turbulence_model": "laminar"}))
    assert laminar["message"] == 'Wall "lid": its rotation axis has no direction (all three components are 0).'
    assert laminar["fix"] == {"go": "bc", "id": "bc-lid", "name": "lid"}
