"""H8: the analysis contract — what the core asks an analysis, and what Incompressible Flow answers."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.contract import ContractError, LaunchSpec, ReadyContext
from cfddesk.registry.discovery import get_registry


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _analysis(key: str):
    return get_registry("analysis").get(key)


def test_describe_carries_the_contract():
    rows = {r["key"]: r for r in get_registry("analysis").describe()}
    steady, transient = rows["incompressible_steady"], rows["incompressible_transient"]
    assert steady["contract"] == "1.1"
    assert steady["family"]["title"] == "Incompressible Fluid Flow"
    assert steady["family"]["tags"] == ["FLUID FLOW (GAS OR LIQUID)", "MACH<0.3 (100 M/S)", "NEGLIGIBLE DENSITY VARIATION"]
    assert steady["family"] == transient["family"]
    assert (steady["algorithm_label"], transient["algorithm_label"]) == ("SIMPLE", "PIMPLE")
    assert (steady["x_axis"], transient["x_axis"]) == ("iterations", "seconds")
    assert steady["residual_keys"] == ["U", "p", "k", "omega", "epsilon", "R"]
    assert {f["key"] for f in steady["result_fields"]} >= {"p", "U"}


def test_study_defaults_are_the_old_w17_record():
    """What Node's W17 defaults carried, now asked of the analysis."""
    assert contract.study_defaults(_analysis("incompressible_steady")) == {
        "analysis_type": "incompressible_steady",
        "analysis": "Incompressible",
        "analysis_title": "Incompressible Fluid Flow",
        "category": "FLUID DYNAMICS",
        "flow_group": "FLOW",
        "turbulence_model_key": "kOmegaSST",
        "turbulence_model": "k-omega SST",
        "time_dependency": "Steady-state",
        "algorithm": "SIMPLE",
    }
    t = contract.study_defaults(_analysis("incompressible_transient"))
    assert (t["analysis_type"], t["time_dependency"], t["algorithm"]) == ("incompressible_transient", "Transient", "PIMPLE")
    assert contract.sibling(_analysis("incompressible_steady"), "Transient") == "incompressible_transient"


def test_run_model_defaults_and_normalize():
    from cfddesk.project.transient import STEADY_DEFAULTS, TRANSIENT_DEFAULTS

    assert contract.run_defaults(_analysis("incompressible_steady")) == STEADY_DEFAULTS
    assert contract.run_defaults(_analysis("incompressible_transient")) == TRANSIENT_DEFAULTS
    steady = _analysis("incompressible_steady")
    assert contract.run_normalize(steady, {"end_time": "12.4", "write_interval": 0}) == {"end_time": 12, "write_interval": 1}


def test_launch_specs():
    solvers = get_registry("solver")
    s = contract.launch_spec(_analysis("incompressible_steady"), solvers)
    assert (s.app, s.keep_frames, s.process_names, s.parallel) == ("simpleFoam", "latest", ("simpleFoam",), True)
    t = contract.launch_spec(_analysis("incompressible_transient"), solvers)
    assert (t.app, t.keep_frames) == ("pimpleFoam", "all")
    assert t.log_parser.module == "cfddesk.wsl.solve_run" and t.log_parser.factory == "ProgressParser"
    # The AmgX solver key runs the simpleFoam program (its application), serially.
    amgx = contract.launch_spec(_analysis("incompressible_steady"), solvers, solver_key="simpleFoam_amgx")
    assert (amgx.app, amgx.parallel) == ("simpleFoam", False)


def test_launch_spec_refuses_what_solve_sh_cannot_run():
    solvers = get_registry("solver")
    base = _analysis("incompressible_steady")
    bad_name = replace(base, key="x_bad", launch=lambda **_: LaunchSpec("simple Foam; rm", "latest", ("a",), "sigterm", False, contract.GENERIC_LOG_PARSER))
    with pytest.raises(ContractError, match="plain program name"):
        contract.launch_spec(bad_name, solvers)
    unregistered = replace(base, key="x_unreg", launch=lambda **_: LaunchSpec("icoFoam", "latest", ("icoFoam",), "sigterm", False, contract.GENERIC_LOG_PARSER))
    with pytest.raises(ContractError, match="not a registered solver app"):
        contract.launch_spec(unregistered, solvers)
    with pytest.raises(ContractError, match="not registered"):
        contract.launch_spec(replace(base, key="x_nosolver", default_solver="nope"), solvers)


def test_log_parsers():
    from cfddesk.wsl.solve_run import GenericParser, ProgressParser

    ic = contract.load_log_parser(contract.launch_spec(_analysis("incompressible_steady"), get_registry("solver")).log_parser.to_json())
    assert isinstance(ic, ProgressParser) and not isinstance(ic, GenericParser)
    gen = contract.load_log_parser(None)
    assert isinstance(gen, GenericParser)
    lines = ['MAGNUSIM_EVENT {"event":"stage","stage":"solve"}', "Time = 1", "DILUPBiCGStab:  Solving for T, Initial residual = 0.5, Final residual = 1e-6, No Iterations 3"]
    got = [e for line in lines for e in gen.feed(line)]
    assert any(e.event == "residual" and e.fields["field"] == "T" for e in got)
    got_ic = [e for line in lines for e in ProgressParser().feed(line)]
    assert not any(e.event == "residual" for e in got_ic)  # T is not an incompressible field


# ---------------------------------------------------------------------------
# validate_ready: the messages Node's validateSolveReady gave, in the same order
# ---------------------------------------------------------------------------


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


def _study(tmp_path: Path, *, fluid_assigned: bool, bcs: list[dict]) -> Path:
    root = tmp_path / "p"
    geom = root / "geometries" / "Geometry_g"
    _write(geom / "id.json", {"id": "g", "kind": "geometry"})
    study = geom / "simulations" / "Study"
    _write(study / "id.json", {"id": "s1", "kind": "simulation", "time_dependency": "Steady-state"})
    mat = {"id": "m1", "name": "Air", "simulation_id": "s1", "assigned_volumes": ["v1"] if fluid_assigned else []}
    _write(study / "materials" / "Air" / "material.json", mat)
    for i, bc in enumerate(bcs):
        _write(study / "boundary_conditions" / f"BC_{i}" / "bc.json", {"id": f"b{i}", "simulation_id": "s1", **bc})
    return root


def _ready(root: Path, patches: tuple[str, ...] = ("inlet", "outlet", "walls")) -> list[dict]:
    ctx = ReadyContext(
        project_dir=root,
        simulation_id="s1",
        run_id="r1",
        mesh_id="m",
        mesh_case_dir=None,
        patches=patches,
        study={"id": "s1"},
        read_study=lambda _n: None,
        mesh={"mesh_id": "m", "mesh_name": "Mesh 1"},
    )
    return contract.validate_ready(_analysis("incompressible_steady"), ctx)


INLET = {"name": "Inlet", "bc_type": "Velocity inlet", "faces": ["face 1@B"], "value": 2}
OUTLET = {"name": "Outlet", "bc_type": "Pressure outlet", "faces": ["face 2@B"], "value": 0}


def test_ready_needs_an_assigned_fluid(tmp_path: Path):
    issues = _ready(_study(tmp_path, fluid_assigned=False, bcs=[INLET, OUTLET]))
    assert issues == [{"message": "Assign a fluid to a volume first", "fix": {"go": "material"}}]


def test_ready_needs_a_flow_driver(tmp_path: Path):
    no_faces = {"name": "Inlet", "bc_type": "Velocity inlet", "faces": []}
    issues = _ready(_study(tmp_path, fluid_assigned=True, bcs=[no_faces, OUTLET]))
    assert issues[0]["message"] == "Add a velocity inlet, or two pressure boundaries, each with an assigned face"
    assert issues[0]["fix"] == {"go": "bc", "id": "b0", "name": "Inlet"}


def test_ready_needs_a_pressure_boundary(tmp_path: Path):
    issues = _ready(_study(tmp_path, fluid_assigned=True, bcs=[INLET]))
    assert issues == [{"message": "Add a pressure boundary with an assigned face", "fix": {"go": "bc-picker"}}]


def test_ready_needs_a_mesh_patch_per_bc(tmp_path: Path):
    issues = _ready(_study(tmp_path, fluid_assigned=True, bcs=[INLET, OUTLET]), patches=("inlet", "walls"))
    assert issues[0]["message"] == 'Mesh has no patch for "Outlet" (looked for outlet). Generate the mesh after assigning BCs.'
    assert issues[0]["fix"] == {"go": "mesh", "id": "m", "name": "Mesh 1"}
    assert issues[0]["patches"] == ["inlet", "walls"]


def test_ready_needs_a_pressure_difference(tmp_path: Path):
    p1 = {"name": "Pressure 1", "bc_type": "Pressure outlet", "faces": ["face 1@B"], "value": 1, "unit": "kPa"}
    p2 = {"name": "Pressure 2", "bc_type": "Pressure outlet", "faces": ["face 2@B"], "value": 1000, "unit": "Pa"}
    issues = _ready(_study(tmp_path, fluid_assigned=True, bcs=[p1, p2]), patches=("pressure_1", "pressure_2"))
    assert issues[0]["message"].startswith("Both pressure boundaries have the same value")
    assert issues[0]["fix"] == {"go": "bc", "id": "b0", "name": "Pressure 1"}


def test_ready_when_everything_is_set(tmp_path: Path):
    assert _ready(_study(tmp_path, fluid_assigned=True, bcs=[INLET, OUTLET])) == []


def test_analysis_rpcs(tmp_path: Path):
    from cfddesk.worker import methods

    root = _study(tmp_path, fluid_assigned=False, bcs=[INLET, OUTLET])
    out = methods.analysis_validate_ready(project_dir=str(root), simulation_id="s1", run_id="r1")
    assert out["analysis_key"] == "incompressible_steady" and out["ready"] is False
    assert out["issues"][0]["message"] == "Assign a fluid to a volume first"
    d = methods.analysis_defaults(key="incompressible_steady", time_dependency="Transient")
    assert d["sibling"] == "incompressible_transient" and d["run"]["end_time"] == 200
    assert methods.analysis_launch_spec(key="incompressible_transient")["launch"]["keep_frames"] == "all"
    assert methods.analysis_describe(key="incompressible_steady")["analysis"]["contract"] == "1.1"
