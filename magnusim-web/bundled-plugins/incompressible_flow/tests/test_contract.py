"""The analysis contract as Incompressible Flow answers it: defaults, run model, launch,
log parser, readiness messages and the worker calls that ask them."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from cfddesk.project.paths import assemble_study_bcs, assemble_study_materials
from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.contract import ReadyContext
from cfddesk.registry.discovery import get_registry

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _analysis(key: str):
    return get_registry("analysis").get(key)


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
    from incompressible_flow.transient import STEADY_DEFAULTS, TRANSIENT_DEFAULTS

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
    assert t.log_parser.module == "incompressible_flow.parser" and t.log_parser.factory == "IncompressibleParser"


def test_log_parsers():
    from magnusim_sdk.progress import ProgressParser as GenericParser

    from incompressible_flow.parser import IncompressibleParser as ProgressParser

    ic = contract.load_log_parser(contract.launch_spec(_analysis("incompressible_steady"), get_registry("solver")).log_parser.to_json())
    assert isinstance(ic, ProgressParser)
    gen = contract.load_log_parser(None)
    assert type(gen) is GenericParser
    assert ic.residual_re.pattern != gen.residual_re.pattern  # incompressible fields only vs any field
    lines = ['MAGNUSIM_EVENT {"event":"stage","stage":"solve"}', "Time = 1", "DILUPBiCGStab:  Solving for T, Initial residual = 0.5, Final residual = 1e-6, No Iterations 3"]
    got = [e for line in lines for e in gen.feed(line)]
    assert any(e.event == "residual" and e.fields["field"] == "T" for e in got)
    got_ic = [e for line in lines for e in ProgressParser().feed(line)]
    assert not any(e.event == "residual" for e in got_ic)  # T is not an incompressible field


def test_registered_solvers_and_materials_are_not_stubs():
    """gate:h1-no-stubs, the plugin's half: its solver and material modules are finished."""
    for name in ("solvers.py", "materials.py"):
        text = (PLUGIN_ROOT / "incompressible_flow" / name).read_text(encoding="utf-8")
        assert "NOT_yet_done" not in text


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
        materials=tuple(assemble_study_materials(root, "s1")),
        bcs=tuple(assemble_study_bcs(root, "s1")),
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


def test_run_settings_are_cleaned_by_the_run_analysis(tmp_path: Path):
    """What Node stores for a transient run is its analysis's clean-up, not the core's."""
    from cfddesk.worker import methods

    root = _study(tmp_path, fluid_assigned=True, bcs=[INLET, OUTLET])
    out = methods.analysis_run_normalize(
        project_dir=str(root),
        simulation_id="s1",
        run_id="r1",
        time_dependency="Transient",
        settings={"n_correctors": 99, "write_count": "80", "delta_t": ""},
        base={"end_time": 2.5, "max_co": 0.5},
    )
    assert out["analysis_key"] == "incompressible_transient"
    t = out["settings"]
    # The analysis's limits (correctors at most 10), the stored values kept, blanks = auto.
    assert (t["n_correctors"], t["write_count"], t["end_time"], t["max_co"], t["delta_t"]) == (10, 80, 2.5, 0.5, None)
    # A value its model rejects falls back to the analysis's default.
    bad = methods.analysis_run_normalize(key="incompressible_transient", settings={"max_co": 0}, base={"max_co": 0.5})
    assert bad["settings"]["max_co"] == 1.0
    # A steady analysis cleans its own settings.
    steady = methods.analysis_run_normalize(key="incompressible_steady", settings={"end_time": "12.4"})
    assert steady["settings"] == {"end_time": 12, "write_interval": 50}
