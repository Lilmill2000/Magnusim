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


def _far_field_case(tmp_path: Path, nets: list[str]) -> Path:
    """A body in a box whose four sides are one Freestream (the validation set's cylinder): its
    flow monitor reads the net flow through all of them, ``nets`` (m³/s) at t = 1, 2."""
    case = tmp_path / "run-ff"
    case.mkdir(parents=True)
    (case / "w27-case.json").write_text(json.dumps({
        "rho": 1.0,
        "mapped": [{"patch": "far_field", "name": "Far field", "bc_type": "Freestream", "faces": ["face 1@B", "face 6@B"]}],
        "monitors": ["far_field", "cylinder"],
    }), encoding="utf-8")
    _dat(case, "mon_far_field", "0", "areaAverage(p)	areaAverage(U)",
         ["1	0.006	(0.99781626 -4.7e-09 0)", "2	0.0057	(0.99781626 -4.7e-09 0)"], area="8.500000e-03")
    _dat(case, "flow_far_field", "0", "sum(phi)", [f"{i + 1}	{q}" for i, q in enumerate(nets)], area="8.500000e-03")
    return case


def test_a_freestream_all_round_a_body_has_no_flow_balance_line(tmp_path: Path):
    """The stream goes in and out through the one Freestream: its net flow is the solve's
    round-off (-3.9e-13 m³/s on a 2D cylinder run), not flow in with none out (it read
    "Flow in 3.910e-10 L/s · out 0 L/s · imbalance 100.00 %", a warning)."""
    out = run_monitors(_far_field_case(tmp_path, ["-2.1e-12", "-3.91048955e-13"]))
    (far,) = out["monitors"]
    assert far["last"]["Q_m3s"] == pytest.approx(-3.91048955e-13)  # the monitor itself still says it
    assert out["balance"] is None and out["summary"] == [] and out["summary_warn"] is False
    # A real net flow through it (entrainment, a leak) still counts.
    real = run_monitors(_far_field_case(tmp_path / "real", ["-1e-4", "-1e-4"]))
    assert real["balance"] == {"in_m3s": pytest.approx(1e-4), "out_m3s": 0.0, "imbalance": pytest.approx(-1.0)}
    assert real["summary_warn"] is True


def _jet_case(tmp_path: Path, far_q: str, jet_q: str, *, far_area: str, jet_area: str, far_u: str, jet_u: str) -> Path:
    """A jet (a Velocity inlet) blowing into a box whose sides are one Freestream: what the jet
    brings in leaves through the far field."""
    case = tmp_path / "run-jet"
    case.mkdir(parents=True)
    (case / "w27-case.json").write_text(json.dumps({
        "rho": 1.0,
        "mapped": [
            {"patch": "far_field", "name": "Far field", "bc_type": "Freestream", "faces": ["face 1@B"]},
            {"patch": "jet", "name": "Jet", "bc_type": "Velocity inlet", "faces": ["face 7@B"]},
        ],
        "monitors": ["far_field", "jet"],
    }), encoding="utf-8")
    _dat(case, "mon_far_field", "0", "areaAverage(p)	areaAverage(U)", [f"1	0.0	{far_u}"], area=far_area)
    _dat(case, "flow_far_field", "0", "sum(phi)", [f"1	{far_q}"], area=far_area)
    _dat(case, "mon_jet", "0", "areaAverage(p)	areaAverage(U)", [f"1	0.0	{jet_u}"], area=jet_area)
    _dat(case, "flow_jet", "0", "sum(phi)", [f"1	{jet_q}"], area=jet_area)
    return case


@pytest.mark.parametrize(
    ("far_q", "jet_q", "far_area", "jet_area", "far_u", "jet_u"),
    [
        # 0.02 m³/s from a 20 cm² jet out through 4000 m² of far field at 30 m/s: 5e-6 m/s across
        # it, 1.7e-7 of its speed (it read in 0.02, out 0, "imbalance 100 %").
        ("0.02", "-0.02", "4.000000e+03", "2.000000e-03", "(30 0 0)", "(0 10 0)"),
        # A 2 mm jet at 1 m/s into a co-flowing box with 5 m² of far field: 6e-7 of its speed.
        ("3.1416e-06", "-3.1416e-06", "5.000000e+00", "3.141600e-06", "(1 0 0)", "(1 0 0)"),
    ],
)
def test_a_far_field_carrying_a_jets_flow_out_balances(tmp_path: Path, far_q, jet_q, far_area, jet_area, far_u, jet_u):
    """A far field's real net flow is as small against its own speed as round-off: with an
    opening that carries flow, every opening counts, so the jet's flow balances what leaves."""
    out = run_monitors(_jet_case(tmp_path, far_q, jet_q, far_area=far_area, jet_area=jet_area, far_u=far_u, jet_u=jet_u))
    q = float(far_q)
    assert out["balance"] == {"in_m3s": pytest.approx(q), "out_m3s": pytest.approx(q), "imbalance": pytest.approx(0.0, abs=1e-9)}
    assert out["summary_warn"] is False
    assert [s["label"] for s in out["summary"]] == ["Flow in", "out", "imbalance"]


def _stream_and_wall_case(tmp_path: Path, *, second: dict, second_u: str, second_q: str, second_area: str) -> Path:
    """The cylinder in one Freestream (its round-off net flow, as the 2D run wrote it) and a second
    monitored patch: ``second``'s mapped record with its area average and flow."""
    case = tmp_path / "run-ff2"
    case.mkdir(parents=True)
    (case / "w27-case.json").write_text(json.dumps({
        "rho": 1.0,
        "mapped": [{"patch": "far_field", "name": "Far field", "bc_type": "Freestream", "faces": ["face 1@B"]}, second],
        "monitors": ["far_field", second["patch"]],
    }), encoding="utf-8")
    _dat(case, "mon_far_field", "0", "areaAverage(p)\tareaAverage(U)", ["869\t0.0057529782\t(0.99781626 -4.6808847e-09 0)"], area="8.500000e-03")
    _dat(case, "flow_far_field", "0", "sum(phi)", ["869\t-3.91048955e-13"], area="8.500000e-03")
    _dat(case, f"mon_{second['patch']}", "0", "areaAverage(p)\tareaAverage(U)", [f"869\t0.21\t{second_u}"], area=second_area)
    _dat(case, f"flow_{second['patch']}", "0", "sum(phi)", [f"869\t{second_q}"], area=second_area)
    return case


@pytest.mark.parametrize(
    ("wall_type", "wall_u", "wall_q"),
    [
        # No-slip: U = 0 and phi = 0 on every face.
        ("No-slip", "(0 0 0)", "0"),
        # Rotating (a spinning cylinder): its faces' velocities cancel to round-off in the mean, and
        # its flow is round-off too, so their ratio says nothing.
        ("Rotating", "(2.1e-12 -1.3e-12 0)", "3.2e-20"),
    ],
)
def test_a_wall_with_an_area_average_on_it_does_not_bring_the_round_off_balance_back(tmp_path: Path, wall_type, wall_u, wall_q):
    """An Area average monitor on the cylinder's faces monitors its wall's patch too. A wall is no
    opening: it is left out of the balance, so the Freestream's round-off still gives no balance
    line (the wall, not read as round-off, made the far field's -3.9e-13 m³/s count: "Flow in
    3.910e-10 L/s · out 0 L/s · imbalance 100.00 %" again)."""
    wall = {"patch": "cylinder", "name": "Cylinder", "bc_type": "Wall", "wall_type": wall_type, "faces": ["face 5@B"]}
    out = run_monitors(_stream_and_wall_case(tmp_path, second=wall, second_u=wall_u, second_q=wall_q, second_area="1.570800e-04"))
    assert [m["patch"] for m in out["monitors"]] == ["far_field", "cylinder"]  # both still listed
    assert out["balance"] is None and out["summary"] == [] and out["summary_warn"] is False


def test_an_opening_at_rest_carries_no_flow(tmp_path: Path):
    """A velocity inlet set to 0 m/s (no speed, no flow) beside the Freestream's round-off: nothing
    flows through either, so there is no balance line (an opening with no speed never counted as
    round-off, and the far field's -3.9e-13 m³/s read "imbalance 100 %")."""
    still = {"patch": "jet", "name": "Jet", "bc_type": "Velocity inlet", "faces": ["face 7@B"], "value": 0}
    out = run_monitors(_stream_and_wall_case(tmp_path, second=still, second_u="(0 0 0)", second_q="0", second_area="2.0e-03"))
    assert out["balance"] is None and out["summary"] == [] and out["summary_warn"] is False


def test_a_monitored_wall_is_left_out_of_a_real_balance(tmp_path: Path):
    """An inlet, an outlet and a wall with an Area average on it: the balance is the inlet's and
    the outlet's (the wall's zero flow adds nothing either way), and a run whose case names no BC
    types (an older one) counts every monitored patch, as before."""
    case = _case(tmp_path)
    meta = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    meta["mapped"].append({"patch": "walls", "name": "Walls", "bc_type": "Wall", "faces": ["face 3@B"]})
    (case / "w27-case.json").write_text(json.dumps(meta), encoding="utf-8")
    _dat(case, "mon_walls", "0", "areaAverage(p)\tareaAverage(U)", ["4\t0.5\t(0 0 0)"], area="5.000000e-02")
    _dat(case, "flow_walls", "0", "sum(phi)", ["4\t0"], area="5.000000e-02")
    out = run_monitors(case)
    assert [m["patch"] for m in out["monitors"]] == ["inlet", "outlet", "walls"]
    assert out["balance"]["in_m3s"] == pytest.approx(0.03) and out["balance"]["out_m3s"] == pytest.approx(0.033)
    for m in meta["mapped"]:
        m.pop("bc_type")
    (case / "w27-case.json").write_text(json.dumps(meta), encoding="utf-8")
    old = run_monitors(case)
    assert old["balance"]["in_m3s"] == pytest.approx(0.03) and old["balance"]["out_m3s"] == pytest.approx(0.033)


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
    legacy = [q.key for q in LEGACY_MONITOR_QUANTITIES]
    assert [q["key"] for q in got["quantities"]][: len(legacy)] == legacy
    inlet, outlet = got["monitors"]
    assert (inlet["key"], inlet["default_quantity"], outlet["key"]) == ("mon_inlet", "Umag", "mon_outlet")
    assert inlet["series"][1]["mdot_kgs"] == pytest.approx(-0.02 * 1.2)
    assert inlet["series"][2]["mdot_kgs"] is None  # no flow row at t=3
    (custom,) = got["custom"]
    assert (custom["key"], custom["default_quantity"]) == ("rc_area_average_1", "p")
    assert [s["label"] for s in got["summary"]] == ["Flow in", "out", "imbalance"]
    assert got["summary"][2]["value"] == pytest.approx(10.0) and got["summary_warn"] is True
