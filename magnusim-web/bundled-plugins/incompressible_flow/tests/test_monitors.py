"""Incompressible Flow declares its monitor contract (API 1.4): the quantities
its run monitors carry, the monitor types, and the run-monitor rows the core
used to complete for it. Nothing the page shows changes.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.contract import LEGACY_MONITOR_QUANTITIES
from cfddesk.registry.discovery import get_registry
from conftest import FIXTURES
from test_results import _case, _dat

from incompressible_flow.monitors import (
    AREA_AVERAGE_ALIASES,
    MONITOR_QUANTITIES,
    custom_monitor_records,
    custom_monitors,
)

# What contract.run_monitors answered for these cases before the analysis
# declared its monitor quantities (the core's legacy shim filled the rows in).
BEFORE = FIXTURES / "run_monitors_before_declared.json"
ANALYSES = ("incompressible_steady", "incompressible_transient")


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _meta(case: Path, doc: dict[str, Any]) -> None:
    case.mkdir(parents=True, exist_ok=True)
    (case / "w27-case.json").write_text(json.dumps(doc), encoding="utf-8")


def _outflow_only(tmp_path: Path) -> Path:
    """Flow out of one pressure boundary and nothing in: no imbalance to report."""
    case = tmp_path / "outflow"
    _meta(case, {"rho": 1000, "mapped": [{"patch": "outlet", "name": "Outlet", "bc_type": "Pressure outlet"}]})
    _dat(case, "flow_outlet", "0", "sum(phi)", ["1\t0.01", "2\t0.02"])
    return case


def _custom_only(tmp_path: Path) -> Path:
    """No density in the sidecar (the default is used) and one custom monitor."""
    case = tmp_path / "custom"
    _meta(case, {"custom_monitors": [{"id": "rc7", "key": "rc_probe", "name": "Probe", "faces": ["face 3@B"]}]})
    _dat(case, "rc_probe", "0", "areaAverage(p)\tareaAverage(U)", ["1\t0.5\t(1 0 0)", "2\t0.4\t(2 0 0)"])
    return case


def _balanced(tmp_path: Path) -> Path:
    """In and out within 1 %: the balance line does not warn."""
    case = tmp_path / "balanced"
    _meta(
        case,
        {
            "rho": 1.2,
            "mapped": [
                {"patch": "inlet", "name": "Inlet", "bc_type": "Velocity inlet"},
                {"patch": "outlet", "name": "Outlet", "bc_type": "Pressure outlet"},
            ],
        },
    )
    _dat(case, "mon_inlet", "0", "areaAverage(p)\tareaAverage(U)", ["1\t0.5\t(2 0 0)"])
    _dat(case, "flow_inlet", "0", "sum(phi)", ["1\t-0.03"])
    _dat(case, "mon_outlet", "0", "areaAverage(p)\tareaAverage(U)", ["1\t0.0\t(2 0 0)"])
    _dat(case, "flow_outlet", "0", "sum(phi)", ["1\t0.0301"])
    return case


CASES = {
    "full": lambda tmp: _case(tmp),
    "outflow_only": _outflow_only,
    "custom_only": _custom_only,
    "balanced": _balanced,
}


def _answer(key: str, case: Path) -> dict[str, Any]:
    return json.loads(json.dumps(contract.run_monitors(get_registry("analysis").get(key), case)))


def _without_type(answer: dict[str, Any]) -> dict[str, Any]:
    out = dict(answer)
    for group in ("monitors", "custom"):
        out[group] = [{k: v for k, v in row.items() if k != "type"} for row in answer[group]]
    return out


def test_declared_quantities_are_the_table_the_page_used():
    """Field by field the core's legacy table, so the page and CSVs stay the same."""
    assert len(MONITOR_QUANTITIES) == len(LEGACY_MONITOR_QUANTITIES)
    for ours, legacy in zip(MONITOR_QUANTITIES, LEGACY_MONITOR_QUANTITIES, strict=True):
        for f in dataclasses.fields(legacy):
            assert getattr(ours, f.name) == getattr(legacy, f.name), (legacy.key, f.name)
    rows = {r["key"]: r for r in get_registry("analysis").describe()}
    for key in ANALYSES:
        spec = get_registry("analysis").get(key)
        assert spec.monitor_quantities == MONITOR_QUANTITIES
        legacy = SimpleNamespace(key="legacy", monitor_quantities=LEGACY_MONITOR_QUANTITIES)
        assert rows[key]["monitor_quantities"] == contract.declared_monitor_quantities(legacy)


@pytest.mark.parametrize("name", sorted(CASES))
@pytest.mark.parametrize("key", ANALYSES)
def test_run_monitors_answer_is_what_the_core_used_to_fill_in(tmp_path: Path, name: str, key: str):
    """Through the contract, field by field the answer the legacy shim gave
    before the analysis declared its quantities (recorded in BEFORE), plus
    each row's monitor type."""
    before = json.loads(BEFORE.read_text(encoding="utf-8"))[name]
    got = _answer(key, CASES[name](tmp_path))
    assert set(got) == set(before)
    for field in before:
        if field in ("monitors", "custom"):
            continue
        assert got[field] == before[field], field
    trimmed = _without_type(got)
    for group in ("monitors", "custom"):
        assert len(trimmed[group]) == len(before[group])
        for row, old in zip(trimmed[group], before[group], strict=True):
            assert set(row) == set(old), (group, sorted(set(row) ^ set(old)))
            for field in old:
                assert row[field] == old[field], (group, row.get("key"), field)
            assert list(row) == list(old)  # the same JSON, key order too
    for row in got["custom"]:
        assert row["type"] == "area_average"
    for row in got["monitors"]:
        assert row["type"] == ("area_average" if row["series"] and row["series"][0]["U"] is not None else "flow_rate")


def test_a_rho_the_core_would_not_use_gives_no_mass_flow(tmp_path: Path):
    """The core left mdot empty when rho was not a positive number; so does the analysis."""
    case = tmp_path / "neg"
    _meta(case, {"rho": -1, "mapped": [{"patch": "outlet", "name": "Outlet", "bc_type": "Pressure outlet"}]})
    _dat(case, "flow_outlet", "0", "sum(phi)", ["1\t0.01"])
    got = _answer("incompressible_steady", case)
    assert got["monitors"][0]["series"][0]["mdot_kgs"] is None


def test_monitor_types_say_what_they_measure():
    rows = {r["key"]: r for r in get_registry("monitor").describe()}
    aa, fr = rows["area_average"], rows["flow_rate"]
    assert aa["aliases"] == ["Area average", "Surface data"] and aa["user_creatable"] is True
    assert aa["quantities"] == ["p", "Umag", "Ux", "Uy", "Uz"] and aa["description"]
    assert fr["quantities"] == ["Q", "mdot", "Un"] and fr["user_creatable"] is False
    keys = {q.key for q in MONITOR_QUANTITIES}
    assert set(aa["quantities"]) <= keys and set(fr["quantities"]) <= keys
    assert tuple(get_registry("monitor").get("area_average").aliases) == AREA_AVERAGE_ALIASES


def test_custom_monitor_records_legacy_shapes():
    recs = [
        {"id": "a", "monitor_type": "area_average", "name": "Typed", "faces": ["f1"]},
        {"id": "b", "category": "Surface data", "name": "Outlet probe", "faces": ["f2"]},
        {"id": "c", "kind": "Area average", "name": "Mid", "faces": ["f3"]},
        {"id": "d", "name": "Area average 4", "faces": ["f4"]},
        {"id": "e", "kind": "probe", "name": "Point", "faces": ["f5"]},
        {"id": "f", "monitor_type": "flow_rate", "name": "Flow", "faces": ["f6"]},
        "not a record",
        None,
    ]
    assert [r["id"] for r in custom_monitor_records(recs)] == ["a", "b", "c", "d"]
    assert custom_monitor_records(None) == []


def test_custom_monitors_match_the_sdk_for_saved_records():
    """For records saved before monitor types, the run gets the same monitors as before."""
    from magnusim_sdk.study import run_custom_monitors

    recs = [
        {"id": "rc1", "name": "Area average 1", "category": "Surface data", "faces": ["face 15@Body1"]},
        {"id": "rc2", "name": "Area average 2", "category": "Surface data", "faces": []},
        {"id": "rc3", "name": "Probe", "kind": "probe", "faces": ["face 1@Body1"]},
        {"id": "rc4", "kind": "AREA AVERAGE", "faces": ["face 2@Body1", "", None]},
        {"id": "rc5", "type": "surface data", "name": "x", "faces": ["face 3@Body1"]},
    ]
    assert custom_monitors(recs) == run_custom_monitors(recs)
    assert [m["id"] for m in custom_monitors(recs)] == ["rc1", "rc4", "rc5"]
    assert custom_monitors([{"id": "t", "monitor_type": "area_average", "faces": ["f"]}]) == [
        {"id": "t", "name": "Monitor", "faces": ["f"]}
    ]


def test_kinematic_fields_are_declared_where_the_writer_reads_them():
    from incompressible_flow.writer import KINEMATIC_FIELDS

    assert KINEMATIC_FIELDS == ("p",)
    rows = {r["key"]: r for r in get_registry("analysis").describe()}
    for key in ANALYSES:
        assert get_registry("analysis").get(key).kinematic_fields == KINEMATIC_FIELDS
        assert rows[key]["kinematic_fields"] == ["p"]


def test_result_fields_name_the_units_the_page_showed():
    from cfddesk.registry.contract import result_fields

    rows = {r["key"]: r for r in result_fields(get_registry("analysis").get("incompressible_steady"))}
    assert {k: r["unit"] for k, r in rows.items()} == {
        "U": "m/s", "p": "Pa", "k": "m²/s²", "omega": "1/s", "epsilon": "m²/s³", "nut": "m²/s", "R": "m²/s²",
    }
    assert rows["U"]["magnitude_label"] == "Velocity Magnitude" and rows["U"]["shown"] == "magU"
    assert (rows["R"]["kind"], rows["R"]["shown"]) == ("symm_tensor", None)
    shown = [r["shown"] for r in rows.values() if r["shown"]]
    assert shown == ["magU", "p", "k", "omega", "epsilon", "nut"]
