"""A run's monitor results (Run panel graphs and the mass balance), read in Python.

They were read by Node (w27-solve.js getRunMonitors) until H9; the numbers are
the same: velocity in m/s, pressure kinematic × rho in Pa, flow in m³/s.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from magnusim_sdk.foam import parse_surface_field_value, read_surface_field_value

from incompressible_flow.results import run_monitors

HEAD = "# Region type : patch {patch}\n# Faces       : 40\n# Area        : {area}\n"


def _dat(case: Path, name: str, time: str, header: str, rows: list[str], area: str = "1.000000e-02") -> None:
    d = case / "postProcessing" / name / time
    d.mkdir(parents=True, exist_ok=True)
    text = HEAD.format(patch=name, area=area) + f"# Time        \t{header}\n" + "".join(r + "\n" for r in rows)
    (d / "surfaceFieldValue.dat").write_text(text, encoding="utf-8")


def _case(tmp_path: Path) -> Path:
    case = tmp_path / "run-1"
    case.mkdir(parents=True)
    (case / "w27-case.json").write_text(
        json.dumps(
            {
                "rho": 1.2,
                "mapped": [
                    {"patch": "inlet", "name": "Inlet", "bc_type": "Velocity inlet", "faces": ["face 1@B"]},
                    {"patch": "outlet", "name": "Outlet", "bc_type": "Pressure outlet", "faces": ["face 2@B"]},
                ],
                "monitors": ["inlet", "outlet", "walls"],
                "custom_monitors": [{"id": "rc1", "key": "rc_area_average_1", "name": "Area average 1", "faces": ["face 9@B"]}],
            }
        ),
        encoding="utf-8",
    )
    _dat(case, "mon_inlet", "0", "areaAverage(p)\tareaAverage(U)", ["1\t0.5\t(2 0 0)", "2\t0.25\t(3 4 0)", "3\t0.1\t(9 9 9)"])
    # A restart from t=3 writes a new time folder; its rows win from t=3 on.
    _dat(case, "mon_inlet", "3", "areaAverage(p)\tareaAverage(U)", ["3\t0.2\t(0 3 4)", "4\t0.3\t(0 0 1)"])
    _dat(case, "flow_inlet", "0", "sum(phi)", ["1\t-0.01", "2\t-0.02", "4\t-0.03"])
    _dat(case, "flow_outlet", "0", "sum(phi)", ["1\t0.01", "2\t0.02", "4\t0.033"], area="2.000000e-02")
    _dat(case, "rc_area_average_1", "0", "areaAverage(p)\tareaAverage(U)", ["4\t1.0\t(1 2 2)"], area="5.000000e-03")
    return case


def test_surface_field_value_rows_and_restart_merge(tmp_path: Path):
    case = _case(tmp_path)
    got = read_surface_field_value(case, "mon_inlet")
    assert got is not None
    assert got["columns"] == ["areaAverage(p)", "areaAverage(U)"]
    assert got["area"] == pytest.approx(0.01) and got["faces"] == 40
    assert [r[0] for r in got["rows"]] == [1.0, 2.0, 3.0, 4.0]
    assert got["rows"][2] == [3.0, 0.2, [0.0, 3.0, 4.0]]
    assert read_surface_field_value(case, "mon_missing") is None
    # A number OpenFOAM wrote badly is None (Node read it as NaN, sent as null).
    assert parse_surface_field_value("# Time p\nnot a row\n1 1e\n")["rows"] == [[1.0, None]]


def test_run_monitors_patch_values_in_display_units(tmp_path: Path):
    out = run_monitors(_case(tmp_path))
    assert out["rho"] == pytest.approx(1.2)
    assert [m["patch"] for m in out["monitors"]] == ["inlet", "outlet"]  # walls wrote nothing
    inlet = out["monitors"][0]
    assert (inlet["name"], inlet["bc_type"], inlet["faces"]) == ("Inlet", "Velocity inlet", ["face 1@B"])
    assert inlet["area_m2"] == pytest.approx(0.01) and inlet["n_faces"] == 40
    t2 = inlet["series"][1]
    assert t2["Umag"] == pytest.approx(5.0)
    assert t2["p_Pa"] == pytest.approx(0.25 * 1.2)
    assert t2["Q_m3s"] == pytest.approx(-0.02) and t2["Un_m_s"] == pytest.approx(-2.0)
    assert inlet["series"][2]["Q_m3s"] is None  # no flow row at t=3
    final = inlet["final"]
    assert final["iteration"] == 4.0
    assert final["mean_velocity_magnitude"] == pytest.approx(1.0)
    assert final["mass_flow_kgs"] == pytest.approx(-0.03 * 1.2)

    outlet = out["monitors"][1]  # flow only
    assert outlet["area_m2"] == pytest.approx(0.02)
    assert outlet["series"][0]["U"] is None and outlet["series"][0]["p_Pa"] is None
    assert outlet["final"]["volumetric_flow_m3s"] == pytest.approx(0.033)

    (custom,) = out["custom"]
    assert (custom["id"], custom["key"], custom["name"]) == ("rc1", "rc_area_average_1", "Area average 1")
    assert custom["final"]["mean_velocity_magnitude"] == pytest.approx(3.0)
    assert custom["final"]["pressure_Pa"] == pytest.approx(1.2)
    assert custom["area_m2"] == pytest.approx(0.005)

    bal = out["balance"]
    assert bal["in_m3s"] == pytest.approx(0.03) and bal["out_m3s"] == pytest.approx(0.033)
    assert bal["imbalance"] == pytest.approx(0.1)


def test_run_monitors_without_results(tmp_path: Path):
    out = run_monitors(tmp_path / "never-ran")
    assert out == {
        "rho": 1.196, "monitors": [], "custom": [], "balance": None, "summary": [], "summary_warn": False,
    }


def test_run_monitors_rpc_reads_through_the_run_analysis(tmp_path: Path):
    from cfddesk.worker import methods
    from cfddesk.worker.rpc import RpcError

    root = tmp_path / "proj"
    case = _case(root / "runs")
    got = methods.analysis_run_monitors(project_dir=str(root), run_id="1", case_dir=str(case), time_dependency="Steady-state")
    assert got["ok"] and got["analysis_key"] == "incompressible_steady"
    assert [m["patch"] for m in got["monitors"]] == ["inlet", "outlet"]
    assert [q["key"] for q in got["quantities"]][:2] == ["p", "Umag"] and got["summary"]
    with pytest.raises(RpcError):
        methods.analysis_run_monitors(project_dir=str(root), run_id="1", case_dir=str(tmp_path), time_dependency="Steady-state")


def test_run_monitors_answers_carry_their_own_quantities(tmp_path: Path):
    """The analysis declares its monitor quantities (API 1.4): describe lists
    them, and its own answers carry what the page reads (mass flow per point,
    row keys and plot defaults, the flow balance line)."""
    from cfddesk.registry import LEGACY_MONITOR_QUANTITIES, contract, load_all, reset_for_tests
    from cfddesk.registry.discovery import get_registry

    from incompressible_flow.monitors import MONITOR_QUANTITIES

    reset_for_tests()
    load_all()
    try:
        rows = {r["key"]: r for r in get_registry("analysis").describe()}
        for key in ("incompressible_steady", "incompressible_transient"):
            spec = get_registry("analysis").get(key)
            assert spec.monitor_quantities == MONITOR_QUANTITIES
            assert [q["key"] for q in rows[key]["monitor_quantities"]] == [q.key for q in MONITOR_QUANTITIES]
        got = contract.run_monitors(get_registry("analysis").get("incompressible_steady"), _case(tmp_path))
    finally:
        reset_for_tests()
    # The hook's own answer already has every field; the core adds only quantities.
    own = run_monitors(_case(tmp_path / "own"))
    assert {k: v for k, v in got.items() if k != "quantities"} == own
    assert [q["key"] for q in got["quantities"]] == [q.key for q in LEGACY_MONITOR_QUANTITIES]
    inlet, outlet = got["monitors"]
    assert (inlet["key"], inlet["default_quantity"], outlet["key"]) == ("mon_inlet", "Umag", "mon_outlet")
    assert inlet["series"][1]["mdot_kgs"] == pytest.approx(-0.02 * 1.2)
    assert inlet["series"][2]["mdot_kgs"] is None  # no flow row at t=3
    (custom,) = got["custom"]
    assert (custom["key"], custom["default_quantity"]) == ("rc_area_average_1", "p")
    assert [s["label"] for s in got["summary"]] == ["Flow in", "out", "imbalance"]
    assert got["summary"][2]["value"] == pytest.approx(10.0) and got["summary_warn"] is True
