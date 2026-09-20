"""Unit tests for cfddesk.project.transient (w30 parity)."""
from __future__ import annotations

from cfddesk.case.writer import (
    write_control_dict_transient,
    write_fv_schemes_transient,
    write_fv_solution_pimple,
)
from cfddesk.project.transient import (
    TransientControl,
    estimate_delta_t,
    flow_through_time,
    foam_num,
    normalize_transient,
    resolve_transient_control,
)
from tests.conftest import GOLDEN, compare_or_update, normalize_foam


def test_foam_num_basic():
    assert foam_num(0) == "0"
    assert foam_num(5) == "5"
    assert foam_num(0.001) == "0.001"
    assert foam_num(0.1) == "0.1"


def test_normalize_and_resolve_defaults():
    ctrl = TransientControl.from_web({})
    assert ctrl.end_time == 5.0
    assert ctrl.write_count == 50
    assert abs(ctrl.write_interval - 0.1) < 1e-12
    assert ctrl.adjust_time_step is True
    assert ctrl.time_scheme == "Euler"
    assert ctrl.n_outer_correctors == 1
    assert ctrl.n_correctors == 2
    assert ctrl.n_non_orthogonal_correctors == 0
    assert ctrl.source and ctrl.source.get("delta_t") == "auto"


def test_normalize_aliases():
    t = normalize_transient({"endTime": 10, "time_scheme": "backward", "n_non_orthogonal_correctors": 2})
    assert t["end_time"] == 10
    assert t["time_scheme"] == "backward"
    assert t["n_non_orth_correctors"] == 2


def test_normalize_keeps_user_max_co():
    t = normalize_transient({"max_co": 200})
    assert t["max_co"] == 200


def test_estimate_delta_t_min_cell():
    est = estimate_delta_t(
        mesh_meta={"min_cell_volume_m3": 1e-9},
        speed_ref=1.0,
        max_co=1.0,
    )
    assert est is not None
    assert est["basis"] == "min_cell"
    assert est["delta_t"] > 0


def test_flow_through_time():
    ft = flow_through_time({"sizing": {"bbox_m": [1.0, 0.5, 0.2]}}, 2.0)
    assert ft == 0.5


def test_resolve_fixed_step():
    ctrl = resolve_transient_control(
        {"end_time": 1, "write_count": 10, "time_step_mode": "fixed", "delta_t": 0.01},
        {},
    )
    assert ctrl.adjust_time_step is False
    assert ctrl.delta_t == 0.01
    assert abs(ctrl.write_interval - 0.1) < 1e-12


def test_transient_dicts_match_js_transient_golden(tmp_path, update_golden):
    """Golden vs fixtures/golden/js_transient for system/ dicts (no FO bodies)."""
    ctrl = TransientControl(
        end_time=5.0,
        delta_t=0.001,
        write_interval=0.1,
        adjust_time_step=True,
        max_co=1.0,
        max_delta_t=0.1,
        time_scheme="Euler",
        n_outer_correctors=1,
        n_correctors=2,
        n_non_orthogonal_correctors=0,
    )
    # FO text matching the golden's mon_/flow_ blocks (order + write interval)
    from cfddesk.case.function_objects import monitors_functions_text

    functions = monitors_functions_text(["pressure_1", "velocity_inlet_1"], transient=ctrl)
    case = tmp_path / "case"
    (case / "system").mkdir(parents=True)
    write_control_dict_transient(case / "system" / "controlDict", ctrl=ctrl, functions_text=functions)
    write_fv_schemes_transient(case / "system" / "fvSchemes", ctrl=ctrl)
    write_fv_solution_pimple(case / "system" / "fvSolution", ctrl=ctrl)

    gdir = GOLDEN / "js_transient"
    for name in ("controlDict", "fvSchemes", "fvSolution"):
        got_path = case / "system" / name
        golden_path = gdir / name
        if update_golden:
            compare_or_update(got_path, golden_path, update=True)
            continue
        # js_transient goldens are raw JS dumps (blank lines retained). Phase 0
        # normalize_foam strips blank / banner lines from the Python writer
        # output — normalize both sides for a fair w30 parity check.
        assert golden_path.is_file(), f"missing golden {golden_path}"
        assert normalize_foam(got_path.read_text(encoding="utf-8")) == normalize_foam(
            golden_path.read_text(encoding="utf-8")
        ), f"mismatch vs {golden_path.name}"
