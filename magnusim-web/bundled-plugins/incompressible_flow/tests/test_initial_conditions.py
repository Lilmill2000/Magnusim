"""F7: the study's starting flow (Still / From the inlet / Custom) and the
potential-flow start reach the written case.

Write checks run everywhere; the ``wsl`` tests run potentialFoam and then a few
simpleFoam iterations or pimpleFoam steps on a small blockMesh channel in a fresh
/tmp folder in WSL (``pytest -m wsl -k initial``).
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import pytest
from cfddesk.registry.analysis import write_run_case
from conftest import run_spec as load_run_spec
from test_turbulence_models import _project, channel_mesh  # noqa: F401  (fixture)
from wsl_tmp_case import log, run_steps

from incompressible_flow import physics
from incompressible_flow.analyses import build_incompressible_steady, build_incompressible_transient
from incompressible_flow.physics import physics_from_record, potential_flow_steps

TRANSIENT = {"end_time": 0.0002, "delta_t": 0.0001, "time_step_mode": "fixed", "write_count": 1}

# The channel's inlet (face 1, x = 0) and outlet (face 2, x = 1): outward normals.
CHANNEL_FACES = {
    "faces_length_unit": "m",
    "bodies": ["Body1"],
    "faces": [
        {"id": 1, "area": 0.01, "centroid": [0, 0.05, 0.05], "normal": [-1, 0, 0]},
        {"id": 2, "area": 0.01, "centroid": [1, 0.05, 0.05], "normal": [1, 0, 0]},
    ],
}


def _switch(monkeypatch, on: bool) -> None:
    """Set the potential-flow switch (physics.POTENTIAL_FLOW_READY) in every loaded copy
    of the module: the registry may have loaded the plugin under its own module name."""
    monkeypatch.setattr(physics, "POTENTIAL_FLOW_READY", on)
    for name, mod in list(sys.modules.items()):
        if name.endswith("incompressible_flow.physics") and hasattr(mod, "POTENTIAL_FLOW_READY"):
            monkeypatch.setattr(mod, "POTENTIAL_FLOW_READY", on)


@pytest.fixture
def potential_ready(monkeypatch):
    """The switch on (as shipped), whatever another test left."""
    _switch(monkeypatch, True)


@pytest.fixture
def potential_off(monkeypatch):
    """The switch off: the row and everything the writer adds for it are gone."""
    _switch(monkeypatch, False)


def _write(
    tmp_path: Path,
    record: dict,
    *,
    bcs: list[dict] | None = None,
    transient: dict | None = None,
    mesh_dir: Path | None = None,
) -> Path:
    root = _project(tmp_path, record)
    (root / "geometry" / "cad_preview.json").write_text(json.dumps(CHANNEL_FACES), encoding="utf-8")
    if bcs is not None:
        doc = {"defaults": {"wall_type": "No-slip"}, "boundary_conditions": [{"simulation_id": "sim_1", **b} for b in bcs]}
        (root / "boundary_conditions.json").write_text(json.dumps(doc), encoding="utf-8")
    spec = load_run_spec(root, run_id="run-ic", require_mesh=False, n_procs=1, transient_override=transient)
    assert spec.ok, spec.error
    if mesh_dir is not None:
        spec.mesh_case_dir = mesh_dir
        spec.end_time = 5
        spec.write_interval = 5
    case = tmp_path / "case"
    assert write_run_case(spec, case)["ok"]
    return case


def _text(case: Path, rel: str) -> str:
    return (case / rel).read_text(encoding="utf-8")


def _internal_u(case: Path) -> list[float]:
    m = re.search(r"internalField\s+uniform\s+\(([^)]*)\);", _text(case, "0/U"))
    assert m, _text(case, "0/U")[:300]
    return [float(x) for x in m.group(1).split()]


def _sidecar(case: Path) -> dict:
    return json.loads(_text(case, "w27-case.json"))


INLET = {"name": "velocity_inlet_1", "bc_type": "Velocity Inlet", "velocity_type": "Fixed", "faces": ["face 1@Body1"]}
OUTLET = {"name": "pressure_1", "bc_type": "Pressure Outlet", "value": 0, "unit": "Pa", "faces": ["face 2@Body1"]}


def test_record_reads_the_starting_flow():
    ph = physics_from_record({})
    assert (ph.initial_flow, ph.initial_u, ph.potential_flow) == ("still", (0.0, 0.0, 0.0), False)
    ph = physics_from_record(
        {"initial_flow": "custom", "initial_ux": 1.5, "initial_uy": "x", "initial_uz": -2, "potential_flow": True}
    )
    assert (ph.initial_flow, ph.initial_u, ph.potential_flow) == ("custom", (1.5, 0.0, -2.0), True)
    assert physics_from_record({"initial_flow": "warp"}).initial_flow == "still"
    # Its own non-orthogonal corrections: the study's, at least 3.
    assert physics_from_record({"n_non_orthogonal": 0}).potential_flow_non_orth() == 3
    assert physics_from_record({"n_non_orthogonal": 6}).potential_flow_non_orth() == 6


def test_the_switch_is_on():
    assert physics.POTENTIAL_FLOW_READY is True


def test_schema_rows_for_both_time_dependencies():
    for analysis in (build_incompressible_steady(), build_incompressible_transient()):
        fields = {f.key: f for f in analysis.settings_schema}
        assert fields["initial_flow"].default == "still"
        assert fields["initial_flow"].choice_labels == ("Still", "From the inlet", "Custom")
        for axis in "xyz":
            f = fields[f"initial_u{axis}"]
            assert (f.quantity, f.unit, f.default) == ("velocity", "m/s", 0.0)
            assert f.depends_on == {"initial_flow": "custom"}


def test_the_potential_flow_row_is_last(potential_ready):
    for analysis in (build_incompressible_steady(), build_incompressible_transient()):
        fields = {f.key: f for f in analysis.settings_schema}
        assert list(fields)[-1] == "potential_flow"
        assert fields["potential_flow"].kind == "bool" and fields["potential_flow"].default is False


def test_the_switch_off_drops_the_row(potential_off):
    for analysis in (build_incompressible_steady(), build_incompressible_transient()):
        # No row at all, not a disabled one.
        assert "potential_flow" not in [f.key for f in analysis.settings_schema]


@pytest.mark.parametrize("transient", [None, TRANSIENT])
def test_a_saved_potential_flow_changes_nothing_while_the_switch_is_off(tmp_path, transient, potential_off):
    rec = {"time_dependency": "Transient"} if transient else {}
    plain = _write(tmp_path / "a", rec, transient=transient)
    stray = _write(tmp_path / "b", {**rec, "potential_flow": True}, transient=transient)
    for rel in ("system/fvSolution", "system/fvSchemes", "0/U", "0/p"):
        assert _text(plain, rel) == _text(stray, rel), rel
    side = _sidecar(stray)
    assert "pre_steps" not in side and side["initial"]["potential_flow"] is False


def test_still_default_writes_todays_case(tmp_path):
    case = _write(tmp_path, {})
    assert "internalField   uniform (0 0 0);" in _text(case, "0/U")
    solution = _text(case, "system/fvSolution")
    assert "potentialFlow" not in solution and "Phi" not in solution
    assert "div(div(phi,U))" not in _text(case, "system/fvSchemes")
    side = _sidecar(case)
    assert side["initial"] == {"flow": "still", "velocity_m_s": [0.0, 0.0, 0.0], "from": "still", "potential_flow": False}
    assert "pre_steps" not in side


def test_custom_start_is_the_studys_vector(tmp_path):
    case = _write(tmp_path, {"initial_flow": "custom", "initial_ux": 2.5, "initial_uy": 0, "initial_uz": -0.25})
    assert _internal_u(case) == [2.5, 0.0, -0.25]
    assert _sidecar(case)["initial"]["from"] == "custom"


def test_from_the_inlet_flows_in_through_a_normal_inlet(tmp_path):
    case = _write(tmp_path, {"initial_flow": "inlet"}, bcs=[{**INLET, "value": 4, "unit": "m/s", "direction": "normal"}, OUTLET])
    ux, uy, uz = _internal_u(case)
    # Against the inlet's outward normal (-x): +x, at the inlet's speed.
    assert ux == pytest.approx(4.0) and uy == 0 and uz == 0
    assert _sidecar(case)["initial"]["from"] == "inlet"


def test_from_the_inlet_follows_a_vector_inlet_and_its_unit(tmp_path):
    inlet = {**INLET, "value": 10, "unit": "ft/s", "direction": "vector", "vector": [3, 4, 0]}
    case = _write(tmp_path, {"initial_flow": "inlet"}, bcs=[inlet, OUTLET])
    u = _internal_u(case)
    speed = 10 * 0.3048
    assert u == pytest.approx([0.6 * speed, 0.8 * speed, 0.0], rel=1e-6)


def test_from_the_inlet_uses_a_flow_rate_inlets_mean_speed(tmp_path):
    inlet = {**INLET, "velocity_type": "Flow rate", "flow_rate_type": "Volumetric", "value": 0.02, "unit": "m3/s"}
    case = _write(tmp_path, {"initial_flow": "inlet"}, bcs=[inlet, OUTLET])
    assert _internal_u(case) == pytest.approx([2.0, 0.0, 0.0])


def test_from_the_inlet_takes_the_freestream_without_an_inlet(tmp_path):
    fs = {
        "name": "far",
        "bc_type": "Freestream",
        "value": 20,
        "unit": "m/s",
        "vector": [1, 1, 0],
        "faces": ["face 1@Body1", "face 2@Body1"],
    }
    case = _write(tmp_path, {"initial_flow": "inlet"}, bcs=[fs])
    s = 20 / math.sqrt(2)
    assert _internal_u(case) == pytest.approx([s, s, 0.0], rel=1e-6)
    assert _sidecar(case)["initial"]["from"] == "freestream"


def test_from_the_inlet_starts_still_with_nothing_to_take_it_from(tmp_path):
    p_in = {**OUTLET, "name": "pressure_in", "value": 100, "faces": ["face 1@Body1"]}
    case = _write(tmp_path, {"initial_flow": "inlet"}, bcs=[p_in, OUTLET])
    assert "internalField   uniform (0 0 0);" in _text(case, "0/U")
    assert _sidecar(case)["initial"]["from"] == "none"


def test_turbulence_keeps_its_inlet_values(tmp_path):
    still = _text(_write(tmp_path / "a", {}), "0/k")
    moving = _text(_write(tmp_path / "b", {"initial_flow": "custom", "initial_ux": 9, "potential_flow": True}), "0/k")
    assert still == moving


def test_potential_flow_writes_its_dicts_and_declares_its_step(tmp_path, potential_ready):
    case = _write(tmp_path, {"potential_flow": True, "n_non_orthogonal": 1})
    solution = _text(case, "system/fvSolution")
    assert re.search(r"^\s+Phi\s*\{\s*\$p;\s*\}", solution, re.M)
    pf = re.search(r"^potentialFlow\s*\{(.*?)^\}", solution, re.M | re.S)
    assert pf and re.search(r"nNonOrthogonalCorrectors 3;", pf.group(1))
    assert "PhiRefCell" in pf.group(1) and "pRefCell" in pf.group(1)
    assert "div(div(phi,U)) Gauss linear;" in _text(case, "system/fvSchemes")
    side = _sidecar(case)
    assert side["pre_steps"] == potential_flow_steps() == [{"tool": "potentialFoam", "args": ["-writephi", "-writep"]}]
    assert side["initial"]["potential_flow"] is True


def test_potential_flow_in_a_transient_case(tmp_path, potential_ready):
    case = _write(tmp_path, {"potential_flow": True, "time_dependency": "Transient"}, transient=TRANSIENT)
    solution = _text(case, "system/fvSolution")
    assert re.search(r"^\s+Phi\s*\{\s*\$p;\s*\}", solution, re.M)
    assert re.search(r"^potentialFlow\s*\{", solution, re.M)
    assert "consistent          no;" in solution
    assert "div(div(phi,U)) Gauss linear;" in _text(case, "system/fvSchemes")
    assert _sidecar(case)["pre_steps"][0]["tool"] == "potentialFoam"


def test_a_new_case_drops_the_flux_a_potential_start_left(tmp_path, potential_ready):
    case = _write(tmp_path, {"potential_flow": True})
    (case / "0" / "phi").write_text("old flux", encoding="utf-8")
    (case / "log.potentialFoam.1").write_text("old log", encoding="utf-8")
    root = tmp_path / "project"
    (root / "simulations.json").write_text(
        json.dumps({"active_id": "sim_1", "simulations": [{"id": "sim_1", "potential_flow": False}]}), encoding="utf-8"
    )
    spec = load_run_spec(root, run_id="run-ic", require_mesh=False, simulation_id="sim_1")
    assert write_run_case(spec, case)["ok"]
    assert not (case / "0" / "phi").exists()
    assert not (case / "log.potentialFoam.1").exists()
    assert "pre_steps" not in _sidecar(case)


# --------------------------------------------------------------------------- WSL


def _check(case: Path, tool: str) -> str:
    text = log(case, tool)
    assert "FOAM FATAL" not in text, text[-3000:]
    assert re.search(r"^End\s*$", text, re.M), text[-3000:]
    return text


@pytest.mark.wsl
@pytest.mark.parametrize("model", ["kOmegaSST", "laminar"])
def test_potential_flow_then_simplefoam_in_wsl(tmp_path, channel_mesh, model, potential_ready):  # noqa: F811
    case = _write(tmp_path, {"turbulence_model": model, "potential_flow": True}, mesh_dir=channel_mesh)
    step = potential_flow_steps()[0]
    code = run_steps(case, [" ".join([step["tool"], *step["args"]]), "simpleFoam"])
    assert code == 0, log(case, "potentialFoam")[-3000:] + log(case, "simpleFoam")[-3000:]
    _check(case, "potentialFoam")
    # potentialFoam wrote the start into 0/: a flowing U (non-uniform), its flux and pressure.
    after = case / "0.after"
    assert (after / "phi").is_file()
    head = (after / "U").read_bytes()[:4000]
    assert b"nonuniform" in head
    sim = _check(case, "simpleFoam")
    assert re.search(r"^Time = 5\s*$", sim, re.M)
    assert (case / "5" / "U").is_file()


@pytest.mark.wsl
def test_potential_flow_then_pimplefoam_in_wsl(tmp_path, channel_mesh, potential_ready):  # noqa: F811
    case = _write(
        tmp_path, {"potential_flow": True, "time_dependency": "Transient"}, transient=TRANSIENT, mesh_dir=channel_mesh
    )
    step = potential_flow_steps()[0]
    code = run_steps(case, [" ".join([step["tool"], *step["args"]]), "pimpleFoam"])
    assert code == 0, log(case, "potentialFoam")[-3000:] + log(case, "pimpleFoam")[-3000:]
    _check(case, "potentialFoam")
    _check(case, "pimpleFoam")


@pytest.mark.wsl
def test_from_the_inlet_start_runs_in_wsl(tmp_path, channel_mesh):  # noqa: F811
    case = _write(
        tmp_path,
        {"initial_flow": "inlet"},
        bcs=[{**INLET, "value": 5, "unit": "m/s", "direction": "normal"}, OUTLET],
        mesh_dir=channel_mesh,
    )
    assert _internal_u(case) == pytest.approx([5.0, 0.0, 0.0])
    code = run_steps(case, ["simpleFoam"])
    assert code == 0, log(case, "simpleFoam")[-3000:]
    _check(case, "simpleFoam")
