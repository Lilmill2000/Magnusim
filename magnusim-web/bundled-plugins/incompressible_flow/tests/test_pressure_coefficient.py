"""The pressure coefficient result field: the ``pressure`` function object in
staticCoeff mode, from the study's reference values, written when they are in
use. (Checked in WSL v2606 on the pitzDaily case this writer wrote, with p∞ 20
Pa: Cp = (rho p - p∞) / (½ rho U∞²) in every cell to the printed precision.)"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.contract import result_fields
from cfddesk.registry.discovery import get_registry
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec

from incompressible_flow.pressure_coefficient import (
    CP_FIELD,
    pressure_coefficient_block,
    writes_pressure_coefficient,
)
from incompressible_flow.writer import write_solve_case


def _write(tmp_path: Path, **change) -> tuple[str, dict]:
    spec = load_run_spec(JS_PROJECT, run_id="run-cp", require_mesh=False, n_procs=1)
    spec = dataclasses.replace(spec, **change)
    write_solve_case(spec, tmp_path / "case")
    control = (tmp_path / "case" / "system" / "controlDict").read_text(encoding="utf-8")
    side = json.loads((tmp_path / "case" / "w27-case.json").read_text(encoding="utf-8"))
    return control, side


def test_the_block_is_static_pressure_coefficient_in_pascals():
    text = pressure_coefficient_block(rho=998.2, p_inf=101.5, speed=2.5, drag=(0.0, 1.0, 0.0))
    for line in (
        "type            pressure;",
        "libs            (fieldFunctionObjects);",
        "writeControl    writeTime;",
        "mode            staticCoeff;",
        "result          Cp;",
        "rho             rhoInf;",
        "rhoInf          998.2;",
        "pInf            101.5;",
        "UInf            (0 2.5 0);",
    ):
        assert line in text, line


def test_a_study_that_never_set_reference_values_writes_no_cp(tmp_path: Path):
    control, side = _write(tmp_path)
    assert "pressureCoefficient" not in control
    assert side["pressure_coefficient"] is False


def test_a_reference_value_turns_cp_on_with_the_resolved_values(tmp_path: Path):
    control, side = _write(tmp_path, reference={"ref_pressure": 12.0, "ref_drag_dir": [0, 0, 1]})
    assert "pressureCoefficient" in control
    # Blank speed: the inlet's 50 m/s, along the study's drag direction; the fluid's density.
    assert "UInf            (0 0 50);" in control and "pInf            12;" in control
    assert f"rhoInf          {side['rho']:g};" in control
    assert side["pressure_coefficient"] is True


def test_a_forces_monitor_turns_cp_on(tmp_path: Path):
    spec = load_run_spec(JS_PROJECT, run_id="run-cp", require_mesh=False, n_procs=1)
    assert not writes_pressure_coefficient(spec)
    with_forces = dataclasses.replace(spec, forces_monitors=[{"id": "f", "name": "F", "boundaries": ["@walls"]}])
    assert writes_pressure_coefficient(with_forces)
    control, _ = _write(tmp_path, forces_monitors=[{"id": "f", "name": "F", "boundaries": ["@walls"]}])
    assert control.index("forces_f") < control.index("pressureCoefficient")


@pytest.mark.parametrize("key", ["incompressible_steady", "incompressible_transient"])
def test_cp_is_listed_after_the_analysis_fields(key):
    reset_for_tests()
    load_all()
    try:
        rows = result_fields(get_registry("analysis").get(key))
    finally:
        reset_for_tests()
    cp = rows[-1]
    assert (cp["key"], cp["label"], cp["kind"], cp["unit"], cp["shown"]) == (
        CP_FIELD, "Pressure coefficient", "scalar", "", "Cp",
    )
