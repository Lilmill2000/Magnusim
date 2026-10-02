"""API 1.4 monitor quantities: the core says what a run's monitor series carry.

An analysis that declares no ``monitor_quantities`` but has a ``run_monitors``
hook answers API 1.1 rows (p_Pa, Umag, U, Un_m_s, Q_m3s per point): the core
adds the quantities the page used to hard-code, a mass flow per point, each
row's key and default quantity, and the flow balance as a summary. An analysis
that declares its quantities gets exactly those and no extras.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from cfddesk.registry import LEGACY_MONITOR_QUANTITIES, MonitorQuantity, MonitorType, Registry
from cfddesk.registry.analysis import AnalysisType
from cfddesk.registry.contract import (
    NO_MONITORS,
    ContractError,
    declared_monitor_quantities,
    describe_extra,
    monitor_quantities,
    run_monitors,
)

RHO = 1.2


def _point(t: float, q: float | None, p: float = 3.0) -> dict[str, Any]:
    return {"t": t, "U": [3.0, 4.0, 0.0], "Umag": 5.0, "p_Pa": p, "Q_m3s": q, "Un_m_s": None if q is None else q / 0.01}


def _answer() -> dict[str, Any]:
    """Today's incompressible row shape (bundled-plugins/incompressible_flow results.py)."""
    inlet_series = [_point(1.0, -0.02), _point(2.0, -0.03)]
    outlet_series = [_point(1.0, 0.02), _point(2.0, None)]
    custom_series = [{"t": 1.0, "U": [0.0, 0.0, 0.0], "Umag": 0.0, "p_Pa": 1.2, "Q_m3s": None, "Un_m_s": None}]
    return {
        "rho": RHO,
        "monitors": [
            {"patch": "inlet", "name": "Inlet", "bc_type": "Velocity inlet", "rho": RHO,
             "last": inlet_series[-1], "series": inlet_series},
            {"patch": "outlet", "name": "Outlet", "bc_type": "Pressure outlet", "rho": RHO,
             "last": outlet_series[-1], "series": outlet_series},
        ],
        "custom": [{"id": "rc1", "key": "rc_area_average_1", "name": "Area average 1", "rho": RHO,
                    "last": custom_series[-1], "series": custom_series}],
        "balance": {"in_m3s": 0.03, "out_m3s": 0.0303, "imbalance": 0.0101},
    }


def _spec(hook=None, **kw) -> SimpleNamespace:
    return SimpleNamespace(key="x_steady", run_monitors=hook, **kw)


def test_legacy_table_is_the_pages_old_table():
    keys = [q.key for q in LEGACY_MONITOR_QUANTITIES]
    assert keys == ["p", "Umag", "Ux", "Uy", "Uz", "Un", "Q", "mdot"]
    by = {q.key: q for q in LEGACY_MONITOR_QUANTITIES}
    assert (by["p"].label, by["p"].unit, by["p"].color, by["p"].csv) == ("Pressure", "Pa", "#6941c6", "pressure_Pa")
    assert (by["Ux"].sample, by["Ux"].component, by["Uz"].component) == ("U", 0, 2)
    assert [k for k in keys if by[k].plot] == ["p", "Umag", "Ux", "Uy", "Uz"]
    assert (by["Q"].unit, by["Q"].direction_from, by["Q"].direction) == ("m³/s", "Q_m3s", ("in", "out"))
    assert (by["mdot"].sample, by["mdot"].unit, by["mdot"].magnitude) == ("mdot_kgs", "kg/s", True)


def test_a_legacy_hook_gets_the_legacy_quantities_and_the_shim(tmp_path: Path):
    seen = []
    out = run_monitors(_spec(lambda case: seen.append(case) or _answer()), tmp_path)
    assert seen == [tmp_path]
    assert out["quantities"] == monitor_quantities(_spec(lambda _c: {}))
    assert [q["key"] for q in out["quantities"]] == [q.key for q in LEGACY_MONITOR_QUANTITIES]
    assert out["quantities"][0] == {
        "key": "p", "label": "Pressure", "sample": "p_Pa", "component": None, "unit_quantity": "pressure",
        "unit": "Pa", "color": "#6941c6", "magnitude": False, "direction_from": "", "direction": ["", ""],
        "plot": True, "details": True, "headline": True, "csv": "pressure_Pa",
    }
    inlet, outlet = out["monitors"]
    # Mass flow per point is the flow rate times the answer's rho (signed, as the CSV wrote it).
    assert [p["mdot_kgs"] for p in inlet["series"]] == pytest.approx([-0.02 * RHO, -0.03 * RHO])
    assert outlet["series"][1]["mdot_kgs"] is None
    assert inlet["last"]["mdot_kgs"] == pytest.approx(-0.03 * RHO)
    # Keys and the quantity each plot opens on (pressure boundaries and custom monitors: p).
    assert (inlet["key"], inlet["default_quantity"]) == ("mon_inlet", "Umag")
    assert (outlet["key"], outlet["default_quantity"]) == ("mon_outlet", "p")
    (custom,) = out["custom"]
    assert (custom["key"], custom["default_quantity"]) == ("rc_area_average_1", "p")
    # The flow balance line, warning above 1 %.
    assert out["summary"] == [
        {"label": "Flow in", "value": 0.03, "quantity": "Q", "unit": ""},
        {"label": "out", "value": 0.0303, "quantity": "Q", "unit": ""},
        {"label": "imbalance", "value": pytest.approx(1.01), "quantity": "", "unit": "%"},
    ]
    assert out["summary_warn"] is True


def test_the_legacy_summary_matches_the_old_balance_rules(tmp_path: Path):
    def with_balance(balance):
        return run_monitors(_spec(lambda _c: {**_answer(), "balance": balance}), tmp_path)

    calm = with_balance({"in_m3s": 0.03, "out_m3s": 0.0301, "imbalance": 0.0033})
    assert calm["summary"][2]["value"] == pytest.approx(0.33) and calm["summary_warn"] is False
    no_ratio = with_balance({"in_m3s": 0.0, "out_m3s": 0.02, "imbalance": None})
    assert [s["label"] for s in no_ratio["summary"]] == ["Flow in", "out"] and no_ratio["summary_warn"] is False
    assert with_balance({"in_m3s": 0.0, "out_m3s": 0.0, "imbalance": None})["summary"] == []
    assert with_balance(None)["summary"] == []
    # An answer with its own summary keeps it.
    own = run_monitors(_spec(lambda _c: {**_answer(), "summary": [{"label": "Heat", "value": 2.0}]}), tmp_path)
    assert own["summary"] == [{"label": "Heat", "value": 2.0}] and own["summary_warn"] is False


def test_a_declared_analysis_gets_exactly_its_quantities_and_no_shim(tmp_path: Path):
    temp = MonitorQuantity("T", "Temperature", "T_K", unit_quantity="temperature", unit="K", color="#b42318")
    flux = {"key": "qw", "label": "Heat flux", "sample": "q_W_m2", "unit": "W/m²", "plot": False}
    spec = _spec(lambda _c: _answer(), monitor_quantities=(temp, flux))
    out = run_monitors(spec, tmp_path)
    assert [q["key"] for q in out["quantities"]] == ["T", "qw"]
    assert out["quantities"][1]["unit"] == "W/m²" and out["quantities"][1]["color"] == "#3884e6"
    assert out["quantities"] == declared_monitor_quantities(spec)
    inlet = out["monitors"][0]
    assert "mdot_kgs" not in inlet["series"][0] and "key" not in inlet and "default_quantity" not in inlet
    assert out["summary"] == [] and out["summary_warn"] is False
    # Declared none: none, and still no shim.
    bare = run_monitors(_spec(lambda _c: _answer(), monitor_quantities=()), tmp_path)
    assert bare["quantities"] == [] and "key" not in bare["monitors"][0]


@pytest.mark.parametrize(
    "answer",
    [
        {"monitors": {"inlet": {}}},
        {"monitors": [["not", "a", "dict"]]},
        {"monitors": [{"patch": "a", "series": [{"U": [0, 0, 0]}]}]},
        {"monitors": [{"patch": "a", "series": [{"t": "1"}]}]},
        {"monitors": [{"patch": "a", "series": "1 2 3"}]},
        {"custom": None},
        {"rho": "1.2"},
        {"balance": [0.1, 0.2]},
        {"summary": "Flow in 1 L/s"},
        {"summary_warn": "yes"},
    ],
)
def test_a_wrong_answer_is_a_contract_error(answer, tmp_path: Path):
    with pytest.raises(ContractError):
        run_monitors(_spec(lambda _c: answer), tmp_path)


def test_not_a_dict_is_a_contract_error(tmp_path: Path):
    with pytest.raises(ContractError, match="must return a dict"):
        run_monitors(_spec(lambda _c: [1, 2]), tmp_path)


@pytest.mark.parametrize(
    "rows",
    [
        ({"key": "T", "label": "T", "sample": "T", "shade": "red"},),
        ({"key": "T", "label": "T"},),
        (MonitorQuantity("1T", "T", "T"),),
        (MonitorQuantity("T", "T", "T", color="red"),),
        (MonitorQuantity("T", "T", "T", unit="K\n"),),
        (MonitorQuantity("T", "T", "T", component=-1),),
        (MonitorQuantity("T", "T", "T", direction=("in",)),),  # type: ignore[arg-type]
        (MonitorQuantity("T", "T", "T"), MonitorQuantity("T", "T2", "T2")),
        ("T",),
    ],
)
def test_bad_declared_quantities_are_a_contract_error(rows):
    with pytest.raises(ContractError):
        monitor_quantities(_spec(None, monitor_quantities=rows))


def test_no_hook_answers_no_monitors(tmp_path: Path):
    spec = AnalysisType("x_steady", "X", "TEST", "steady", ("T",))
    assert spec.monitor_quantities is None
    out = run_monitors(spec, tmp_path)
    assert out == NO_MONITORS
    assert out["quantities"] == [] and out["summary"] == [] and out["summary_warn"] is False
    assert monitor_quantities(spec) == []
    # A fresh copy each time: changing one answer leaves the next alone.
    out["monitors"].append({"patch": "x"})
    assert run_monitors(spec, tmp_path)["monitors"] == []


def test_describe_publishes_only_what_the_analysis_declares():
    undeclared = AnalysisType("x_steady", "X", "TEST", "steady", ("T",), run_monitors=lambda _c: {})
    assert describe_extra(undeclared)["monitor_quantities"] is None
    declared = AnalysisType(
        "y_steady", "Y", "TEST", "steady", ("T",), monitor_quantities=(MonitorQuantity("T", "Temperature", "T_K"),)
    )
    assert [q["key"] for q in describe_extra(declared)["monitor_quantities"]] == ["T"]


def test_monitor_rows_carry_the_new_fields():
    reg: Registry[MonitorType] = Registry("monitor")
    reg.register(MonitorType("area_average", "Area average", "patch"), plugin="p")
    reg.register(
        MonitorType(
            "probe", "Probe", "point", description="Values at a point", aliases=("point_probe",),
            user_creatable=True, quantities=("p", "Umag"),
        ),
        plugin="p",
    )
    plain, probe = reg.describe()
    assert (plain["target"], plain["description"], plain["aliases"], plain["user_creatable"], plain["quantities"]) == (
        "patch", "", [], False, []
    )
    assert plain["schema"]["type"] == "object" and plain["schema"]["properties"] == {}
    assert (probe["description"], probe["aliases"], probe["user_creatable"], probe["quantities"]) == (
        "Values at a point", ["point_probe"], True, ["p", "Umag"]
    )
