"""Point probes: the monitor type, the probes function object the writer emits for
a run's probes, and one row per point read back from what OpenFOAM v2606 wrote
(fixtures/pitzdaily-monitors, with a point outside the mesh)."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.discovery import get_registry
from conftest import FIXTURES, JS_PROJECT
from conftest import run_spec as load_run_spec

from incompressible_flow.force_objects import (
    plan_probe_monitors,
    probes_block,
    probes_functions_text,
)
from incompressible_flow.monitors import PROBE_QUANTITY_KEYS, probe_monitor_records
from incompressible_flow.probes_results import parse_probe_file, probe_rows
from incompressible_flow.results import run_monitors
from incompressible_flow.writer import write_solve_case

CASE = FIXTURES / "pitzdaily-monitors"


@pytest.fixture
def registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def test_probes_block_samples_u_and_p_at_the_points():
    text = probes_block("probes_a", [[0.1, 0, 0], [0.25, -0.5, 1e-3]], write_control_text="writeControl    timeStep;")
    assert "type            probes;" in text and "libs            (sampling);" in text
    assert "fields          (U p);" in text
    assert "probeLocations  ( (0.1 0 0) (0.25 -0.5 0.001) );" in text


def test_probe_records_keep_well_formed_points():
    rcs = [
        {"id": "a", "monitor_type": "probe", "name": "Wake", "points": [[0.1, 0, 0], [1, "x", 0], [1, 2], [0, 0, "0.5"]]},
        {"id": "b", "monitor_type": "forces", "boundaries": ["@walls"]},
        {"id": "c", "monitor_type": "probe"},
    ]
    assert probe_monitor_records(rcs) == [
        {"id": "a", "name": "Wake", "points": [[0.1, 0.0, 0.0], [0.0, 0.0, 0.5]]},
        {"id": "c", "name": "Point probe", "points": []},
    ]


def test_plan_skips_probes_without_points_and_keys_the_rest():
    spec = SimpleNamespace(
        probe_monitors=[
            {"id": "a", "name": "Wake", "points": [[0, 0, 0]]},
            {"id": "b", "name": "Empty", "points": []},
            {"id": "c", "name": "Wake", "points": [[1, 0, 0], [2, 0, 0]]},
        ]
    )
    plans = plan_probe_monitors(spec)
    assert [(p["id"], p["key"], len(p["points"])) for p in plans] == [("a", "probes_wake", 1), ("c", "probes_wake_2", 2)]
    assert probes_functions_text(plans).count("type            probes;") == 2


def test_the_writer_emits_probes_and_records_them(tmp_path: Path):
    spec = load_run_spec(JS_PROJECT, run_id="run-probes", require_mesh=False, n_procs=1)
    spec = dataclasses.replace(spec, probe_monitors=[{"id": "rc-p", "name": "Point probe 1", "points": [[0.01, 0.02, 0.0]]}])
    write_solve_case(spec, tmp_path / "case")
    control = (tmp_path / "case" / "system" / "controlDict").read_text(encoding="utf-8")
    assert "probes_point_probe_1" in control and "probeLocations  ( (0.01 0.02 0) );" in control
    side = json.loads((tmp_path / "case" / "w27-case.json").read_text(encoding="utf-8"))
    assert side["probe_monitors"] == [
        {"id": "rc-p", "name": "Point probe 1", "key": "probes_point_probe_1", "points": [[0.01, 0.02, 0.0]]}
    ]


def test_parse_probe_file_marks_points_not_found():
    text = (
        "# Probe 0 (0.1 0 0)\n# Probe 1 (5 5 5)  # Not Found\n# Time 0 1\n"
        "1 (1 2 2) (-1e+300 -1e+300 -1e+300)\n2 (2 0 0) (-1e+300 -1e+300 -1e+300)\n"
    )
    parsed = parse_probe_file(text)
    assert parsed["points"] == [[0.1, 0.0, 0.0], [5.0, 5.0, 5.0]]
    assert parsed["not_found"] == [1]
    assert parsed["rows"] == [[1.0, [1.0, 2.0, 2.0], None], [2.0, [2.0, 0.0, 0.0], None]]


def test_real_v2606_probes_read_as_one_row_per_point():
    rows = [r for r in run_monitors(CASE)["custom"] if r["type"] == "probe"]
    assert [r["key"] for r in rows] == ["probes_probe_1_1", "probes_probe_1_2", "probes_probe_1_3"]
    assert [r["name"] for r in rows] == ["Probe 1 · point 1", "Probe 1 · point 2", "Probe 1 · point 3"]
    assert {r["id"] for r in rows} == {"rc-p1"}
    first, outside, third = rows
    assert len(first["series"]) == 8
    # p is kinematic in the file: shown in Pa (rho 1.2). The last line of p and U.
    assert first["last"]["p_Pa"] == pytest.approx(297.81251 * 1.2)
    assert third["last"]["p_Pa"] == pytest.approx(161.66838 * 1.2)
    assert first["last"]["U"] == pytest.approx([6.8431745, -0.045008173, 2.3876044e-14])
    assert first["last"]["Upt_m_s"] == pytest.approx(6.84332251, rel=1e-8)
    assert first["details"] == [["Point", "(0.1, 0, 0) m"]] and first["note"] == ""
    assert first["quantities"] == list(PROBE_QUANTITY_KEYS) and first["default_quantity"] == "p"
    # The point outside the mesh: no flat line of -1e300, a note instead.
    assert outside["outside"] is True and outside["series"] == [] and outside["last"] is None
    assert outside["note"] == "(5, 5, 5) m is outside the fluid: there are no values there."


def test_a_probe_that_wrote_nothing_has_no_rows(tmp_path: Path):
    plan = {"id": "x", "name": "P", "key": "probes_p", "points": [[0, 0, 0]]}
    assert probe_rows(tmp_path, plan, 1.2) == []


def test_contract_answer_and_monitor_type(registry):
    spec = get_registry("analysis").get("incompressible_transient")
    answer = contract.run_monitors(spec, CASE)
    keys = {q["key"] for q in answer["quantities"]}
    assert set(PROBE_QUANTITY_KEYS) <= keys
    row = {r["key"]: r for r in get_registry("monitor").describe()}["probe"]
    assert (row["label"], row["target"], row["user_creatable"]) == ("Point probe", "point", True)
    assert row["quantities"] == list(PROBE_QUANTITY_KEYS)
    assert "probe" in spec.monitors
