"""What a run shows: its monitors and energy balance (from the function objects' files),
its residuals and how it ended (from the solver's log)."""

from __future__ import annotations

import json
from pathlib import Path

from cfddesk.registry import contract as core_contract

from heat_transfer.monitors import MONITOR_QUANTITIES
from heat_transfer.parser import DENSITY_ZERO_REASON, HeatParser
from heat_transfer.results import read_wall_heat_flux, run_monitors

PLANS = [
    {"id": "mon-q", "name": "Heater flux", "type": "ht_wall_heat_flux", "patches": ["heater"]},
    {"id": "mon-t", "name": "Plate temperature", "type": "ht_surface_temperature", "patches": ["cold_plate", "walls"]},
    {"id": "mon-tc", "name": "Thermocouple 1", "type": "ht_thermocouple", "points": [[0.05, 0.01, 0.02], [9, 9, 9]],
     "key": "ht_probe_thermocouple_1"},
]


def _sfv(case: Path, name: str, area: float, column: str, rows: list[tuple[float, float]], start: str = "0") -> None:
    d = case / "postProcessing" / name / start
    d.mkdir(parents=True, exist_ok=True)
    lines = [f"# Region type : patch {name}", "# Faces  : 12", f"# Area   : {area}", f"# Time  {column}"]
    lines += [f"{t}\t{v}" for t, v in rows]
    (d / "surfaceFieldValue.dat").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _case(tmp_path: Path) -> Path:
    case = tmp_path / "case"
    whf = case / "postProcessing" / "ht_wall_heat_flux" / "0"
    whf.mkdir(parents=True)
    rows = ["# Wall heat-flux", "# Time\tpatch\tmin\tmax\tintegral"]
    for t, q_heater in ((1, 2.0), (2, 2.4), (3, 2.5)):
        rows.append(f"{t}\twalls\t-1\t1\t0")
        rows.append(f"{t}\theater\t100\t3100\t{q_heater}")
        rows.append(f"{t}\tcold_plate\t-900\t-10\t{-1.5}")
        rows.append(f"{t}\tlid\t-50\t0\t-0.2")
    (whf / "wallHeatFlux.dat").write_text("\n".join(rows) + "\n", encoding="utf-8")
    _sfv(case, "ht_Tavg_heater", 0.001, "areaAverage(T)", [(1, 320), (2, 330), (3, 331)])
    _sfv(case, "ht_Tmax_heater", 0.001, "max(T)", [(1, 330), (2, 340), (3, 342)])
    _sfv(case, "ht_Tavg_cold_plate", 0.004, "areaAverage(T)", [(1, 283.15), (2, 283.15), (3, 283.15)])
    _sfv(case, "ht_Tmax_cold_plate", 0.004, "max(T)", [(1, 283.15), (2, 283.15), (3, 283.15)])
    _sfv(case, "ht_Tavg_walls", 0.006, "areaAverage(T)", [(1, 293.15), (2, 295.15), (3, 296.15)])
    _sfv(case, "ht_Tmax_walls", 0.006, "max(T)", [(1, 300), (2, 301), (3, 302)])
    _sfv(case, "ht_enthalpy_inlet", 0.002, "weightedSum(h)", [(3, -10.0)])
    _sfv(case, "ht_enthalpy_outlet", 0.002, "weightedSum(h)", [(3, 10.79)])
    probe = case / "postProcessing" / "ht_probe_thermocouple_1" / "0"
    probe.mkdir(parents=True)
    (probe / "T").write_text(
        "# Probe 0 (0.05 0.01 0.02)\n# Probe 1 (9 9 9)\n#  Not Found\n#       Probe 0 1\n# Time\n"
        "1  300  -1e+300\n2  301.5  -1e+300\n3  302  -1e+300\n",
        encoding="utf-8",
    )
    meta = {"rho": 1.2, "ht_monitors": PLANS, "wall_patches": ["walls", "heater", "cold_plate", "lid"],
            "opening_patches": ["inlet", "outlet"]}
    (case / "w27-case.json").write_text(json.dumps(meta), encoding="utf-8")
    return case


def test_wall_heat_flux_rows_merge_a_restart(tmp_path):
    case = _case(tmp_path)
    later = case / "postProcessing" / "ht_wall_heat_flux" / "2"
    later.mkdir()
    (later / "wallHeatFlux.dat").write_text("2\theater\t0\t0\t9\n4\theater\t0\t0\t9.5\n", encoding="utf-8")
    rows = read_wall_heat_flux(case)
    assert sorted(rows) == [1.0, 2.0, 4.0]
    assert rows[2.0] == {"heater": (0.0, 0.0, 9.0)}


def test_monitor_rows_and_the_energy_balance(tmp_path):
    out = run_monitors(_case(tmp_path))
    rows = {r["key"]: r for r in out["custom"]}
    q = rows["htq_mon-q"]
    assert q["name"] == "Heater flux" and q["default_quantity"] == "Q"
    assert q["last"] == {"t": 3.0, "Q_W": 2.5, "q_avg_W_m2": 2500.0, "q_max_W_m2": 3100.0}
    assert q["area_m2"] == 0.001 and len(q["series"]) == 3
    t = rows["htT_mon-t"]
    # Area-weighted: (283.15 * 4 + 296.15 * 6) / 10.
    assert abs(t["last"]["T_avg_K"] - 290.95) < 1e-9 and t["last"]["T_max_K"] == 302
    tc = rows["ht_probe_thermocouple_1_0"]
    assert tc["name"] == "Thermocouple 1 · point 1" and tc["last"] == {"t": 3.0, "T_K": 302.0}
    outside = rows["ht_probe_thermocouple_1_1"]
    assert outside["note"] == "This point is outside the fluid." and outside["last"]["T_K"] is None
    b = out["balance"]
    assert b["walls_in_W"] == 2.5 and abs(b["walls_out_W"] - 1.7) < 1e-12
    assert abs(b["carried_out_W"] - 0.79) < 1e-9
    assert abs(b["heat_in_W"] - 2.5) < 1e-12 and abs(b["heat_out_W"] - 2.49) < 1e-9
    assert [s["label"] for s in out["summary"]] == ["Heat in", "out", "imbalance"]
    assert abs(out["summary"][2]["value"] - 0.4) < 1e-6 and out["summary_warn"] is False
    # The balance is also a monitor of its own (the Monitors panel lists it and its line).
    (row,) = out["monitors"]
    assert row["key"] == "ht_energy_balance" and row["name"] == "Energy balance"
    assert row["quantities"] == ["Q_in", "Q_out", "imbalance"]
    assert row["last"]["t"] == 3.0 and abs(row["last"]["imbalance_pct"] - 0.4) < 1e-6


def test_largest_heat_flux_on_a_cooled_wall_is_its_most_negative(tmp_path):
    """"Largest heat flux" is the face flux of largest magnitude, its sign kept: on the cold
    plate (faces between -900 and -10 W/m²) it is -900, not -10."""
    case = _case(tmp_path)
    meta = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    meta["ht_monitors"] = [*PLANS, {"id": "mon-c", "name": "Plate flux", "type": "ht_wall_heat_flux", "patches": ["cold_plate"]}]
    (case / "w27-case.json").write_text(json.dumps(meta), encoding="utf-8")
    rows = {r["key"]: r for r in run_monitors(case)["custom"]}
    assert rows["htq_mon-c"]["last"]["q_max_W_m2"] == -900.0
    assert rows["htq_mon-q"]["last"]["q_max_W_m2"] == 3100.0


def test_a_transient_run_says_the_heat_it_stores_and_never_warns(tmp_path):
    """While a transient run warms up, heat in and out differ by the heat stored: the line
    says so (in minus out, W) instead of an imbalance warning."""
    case = _case(tmp_path)
    _sfv(case, "ht_enthalpy_outlet", 0.002, "weightedSum(h)", [(3, 10.2)])
    meta = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    (case / "w27-case.json").write_text(json.dumps({**meta, "time_dependency": "Transient"}), encoding="utf-8")
    out = run_monitors(case)
    assert [s["label"] for s in out["summary"]] == ["Heat in", "out", "stored"]
    stored = out["summary"][2]
    assert stored["quantity"] == "Q" and abs(stored["value"] - (out["balance"]["heat_in_W"] - out["balance"]["heat_out_W"])) < 1e-12
    assert stored["value"] > 0.5 and out["summary_warn"] is False
    # The same numbers in a steady run warn (more than the tolerated imbalance).
    (case / "w27-case.json").write_text(json.dumps(meta), encoding="utf-8")
    steady = run_monitors(case)
    assert steady["summary"][2]["label"] == "imbalance" and steady["summary_warn"] is True


def test_a_closed_cavity_balances_its_walls(tmp_path):
    case = _case(tmp_path)
    meta = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    meta["opening_patches"] = []
    (case / "w27-case.json").write_text(json.dumps(meta), encoding="utf-8")
    out = run_monitors(case)
    series = out["monitors"][0]["series"]
    assert [p["t"] for p in series] == [1.0, 2.0, 3.0]
    assert series[0]["Q_in_W"] == 2.0 and abs(series[0]["Q_out_W"] - 1.7) < 1e-12


def test_the_answer_passes_the_core_check(tmp_path):
    class Spec:
        key = "heat_transfer_steady"
        run_monitors = staticmethod(run_monitors)
        monitor_quantities = MONITOR_QUANTITIES

    answer = core_contract.run_monitors(Spec, _case(tmp_path))
    assert {q["key"] for q in answer["quantities"]} >= {"Q", "q_avg", "T_avg", "T_pt"}
    assert answer["summary"][0]["label"] == "Heat in"


def test_a_case_with_nothing_written(tmp_path):
    (tmp_path / "w27-case.json").write_text("{}", encoding="utf-8")
    assert run_monitors(tmp_path) == {"rho": None, "monitors": [], "custom": [], "balance": None, "summary": [], "summary_warn": False}


LOG = """Time = 1

DILUPBiCGStab:  Solving for Ux, Initial residual = 1, Final residual = 0.01, No Iterations 1
DILUPBiCGStab:  Solving for Uy, Initial residual = 0.9, Final residual = 0.01, No Iterations 1
DILUPBiCGStab:  Solving for h, Initial residual = 0.5, Final residual = 0.01, No Iterations 1
GAMG:  Solving for p_rgh, Initial residual = 0.8, Final residual = 0.001, No Iterations 7
GAMG:  Solving for p_rgh, Initial residual = 0.3, Final residual = 0.001, No Iterations 7
rho min/max : 1.13 1.21
Time = 2

DILUPBiCGStab:  Solving for h, Initial residual = 0.2, Final residual = 0.01, No Iterations 1
GAMG:  Solving for p_rgh, Initial residual = 0.1, Final residual = 0.001, No Iterations 7
DILUPBiCGStab:  Solving for k, Initial residual = 0.05, Final residual = 0.001, No Iterations 1

SIMPLE solution converged in 2 iterations
"""


def _feed(text: str) -> tuple[HeatParser, list]:
    p = HeatParser()
    events = []
    for line in text.splitlines():
        events.extend(p.feed(line))
    return p, events


def test_the_parser_reads_residuals_without_u_and_the_first_of_each_field():
    p, events = _feed(LOG)
    snap = p.snapshot()
    rows = snap["residuals"]
    assert rows[0]["p_rgh"] == 0.8 and rows[0]["h"] == 0.5 and rows[0]["Ux"] == 1
    assert rows[1] == {"t": 2.0, "h": 0.2, "p_rgh": 0.1, "k": 0.05}
    conv = [e for e in events if e.event == "converged"]
    assert conv and conv[0].fields == {"by": "residuals", "time": 2.0}


BOUSSINESQ_HEAD = "Selecting thermodynamics package\n{\n    type            heRhoThermo;\n    equationOfState Boussinesq;\n}\n"
PERFECT_GAS_HEAD = "Selecting thermodynamics package\n{\n    equationOfState incompressiblePerfectGas;\n}\n"


def test_the_parser_names_a_boussinesq_density_that_reached_zero_when_the_solver_dies():
    p, events = _feed(BOUSSINESQ_HEAD + "Time = 50\n\nrho min/max : 0 1.177\n\n#1  Foam::sigFpe::sigHandler(int)\n"
                      "Floating point exception (core dumped)\n")
    reasons = [e.fields for e in events if e.event == "failed_reason"]
    assert reasons == [{"reason": DENSITY_ZERO_REASON}]
    assert p.snapshot()["failed_reason"] == "Boussinesq density reached zero: use incompressible perfect gas"


def test_the_parser_blames_the_density_only_on_fatal_evidence_in_a_boussinesq_case():
    """No reason from a density of zero that the run lives through, nor in a perfect-gas
    case (its density cannot be clipped to zero by Boussinesq): only fatal evidence counts."""
    _p, recovered = _feed(BOUSSINESQ_HEAD + "Time = 1\nrho min/max : 0 1.17\nTime = 2\nrho min/max : 0.9 1.1\nEnd\n")
    assert [e for e in recovered if e.event == "failed_reason"] == []
    _p, gas = _feed(PERFECT_GAS_HEAD + "Time = 1\nrho min/max : 0 1.17\nFOAM FATAL ERROR: something else\n")
    assert [e for e in gas if e.event == "failed_reason"] == []
    _p, plain = _feed("Time = 1\nMin/max rho:0 1.17\nFloating point exception\n")
    assert [e for e in plain if e.event == "failed_reason"] == []
    _p, once = _feed(BOUSSINESQ_HEAD + "Time = 1\nMin/max rho:-1 1.17\nsigFpe\nFOAM aborting\n")
    assert len([e for e in once if e.event == "failed_reason"]) == 1


def test_the_settle_stop_ends_a_run():
    _p, events = _feed("Time = 40\nsettleStop\naverage: settle condition satisfied\nStopping calculation\n")
    assert [e.fields for e in events if e.event == "converged"] == [{"by": "monitor", "time": 40.0}]


def test_the_committed_cavity_has_a_positive_heat_transfer_coefficient_on_both_walls():
    """The e2e fixture's finished cavity (solved by the writer's function objects): htc is
    h = q / (T_wall - T_ref) with T_ref 298.15 K, positive on the hot wall (30 °C, heat in) and
    on the cold wall (20 °C, heat out), never OpenFOAM's raw q / (T_ref - T_wall)."""
    from ht_foam_fields import patch_values

    t400 = Path(__file__).resolve().parents[1] / "e2e" / "fixtures" / "cavity-case" / "400"
    for wall, t_wall, sign in (("hot", 303.15, 1), ("cold", 293.15, -1)):
        h = patch_values(t400 / "htc", wall)
        q = patch_values(t400 / "wallHeatFlux", wall)
        assert len(h) == len(q) == 20
        assert all(v > 0 for v in h), (wall, h[:3])
        assert all(sign * v > 0 for v in q), (wall, q[:3])
        for hv, qv in zip(h, q, strict=True):
            assert abs(hv - qv / (t_wall - 298.15)) <= 1e-9 * max(1.0, abs(hv))
    assert (t400 / "rho").is_file()
