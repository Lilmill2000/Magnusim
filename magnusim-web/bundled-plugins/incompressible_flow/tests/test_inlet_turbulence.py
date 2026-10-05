""""Turbulence at the inlet": the setting's scales (inlet_turbulence.py) and the
per-patch k, omega, epsilon and R the case writer turns them into."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from incompressible_flow import inlet_turbulence as it
from incompressible_flow.physics import StudyPhysics
from incompressible_flow.runspec import FaceProps, RunSpec
from incompressible_flow.writer import (
    _build_field_patches,
    patch_turbulence,
    turb_value_strings,
    write_solve_case,
)

NU = 1.5e-5
AUTO = {"k": "0.5", "omega": "20", "epsilon": "0.9", "R": "(0.3 0 0 0.3 0 0.3)"}


def _spec(*mapped: tuple[str, dict], model: str = "kOmegaSST", face_props: dict | None = None) -> RunSpec:
    return RunSpec(
        project_dir=Path("."),
        run_id="r1",
        mesh_case_dir=Path("."),
        n_procs=1,
        solver_app="simpleFoam",
        end_time=10,
        write_interval=10,
        transient=None,
        nu=NU,
        rho=1.2,
        wall_default="No-slip",
        bcs=[],
        monitor_patches=[],
        face_props=face_props or {},
        mapped=[{"bc": bc, "patch": patch} for patch, bc in mapped],
        physics=StudyPhysics(turbulence_model=model),  # type: ignore[arg-type]
    )


INLET = {"name": "Inlet", "bc_type": "Velocity inlet", "faces": ["face 1@B"], "velocity_type": "Fixed", "value": 10, "unit": "m/s"}
PRESSURE = {"name": "Pressure", "bc_type": "Pressure", "faces": ["face 2@B"], "value": 0, "unit": "Pa"}


def test_the_setting_reads_as_auto_unless_it_names_another():
    assert it.turbulence_spec({}) == it.AUTO
    assert it.turbulence_spec({"turbulence_spec": "intensity and LENGTH scale"}) == it.LENGTH
    assert it.turbulence_spec({"turbulence_spec": "Intensity and viscosity ratio"}) == it.RATIO
    assert it.turbulence_spec({"turbulence_spec": "nonsense"}) == it.AUTO
    assert it.patch_scales({"turbulence_spec": "Auto"}, speed=10, nu=NU) is None


def test_intensity_and_length_scale():
    sc = it.patch_scales({"turbulence_spec": it.LENGTH, "turbulence_intensity": 2, "turbulence_length_scale": 0.05}, speed=10, nu=NU)
    k = 1.5 * (0.02 * 10) ** 2
    omega = math.sqrt(k) / (0.09**0.25 * 0.05)
    assert sc == pytest.approx(
        {"spec": it.LENGTH, "intensity": 0.02, "speed_m_s": 10, "length_scale_m": 0.05, "k": k, "omega": omega, "epsilon": 0.09 * k * omega}
    )


def test_intensity_and_viscosity_ratio():
    sc = it.patch_scales({"turbulence_spec": it.RATIO, "turbulence_intensity": 1, "turbulence_viscosity_ratio": 10}, speed=20, nu=NU)
    k = 1.5 * (0.01 * 20) ** 2
    assert sc["k"] == pytest.approx(k)
    # nut = k / omega = 10 nu
    assert sc["k"] / sc["omega"] == pytest.approx(10 * NU)
    assert sc["epsilon"] == pytest.approx(0.09 * k * sc["omega"])


def test_blank_numbers_take_the_defaults():
    sc = it.patch_scales({"turbulence_spec": it.LENGTH}, speed=10, nu=NU)
    assert (sc["intensity"], sc["length_scale_m"]) == (0.05, 0.01)
    sc = it.patch_scales({"turbulence_spec": it.RATIO, "turbulence_intensity": ""}, speed=10, nu=NU)
    assert (sc["intensity"], sc["viscosity_ratio"]) == (0.05, 10.0)


@pytest.mark.parametrize(
    ("fields", "problem"),
    [
        ({"turbulence_intensity": 0}, "the turbulence intensity must be above 0 % and at most 100 %"),
        ({"turbulence_intensity": 150}, "the turbulence intensity must be above 0 % and at most 100 %"),
        ({"turbulence_intensity": "abc"}, "the turbulence intensity must be above 0 % and at most 100 %"),
        ({"turbulence_length_scale": 0}, "the turbulence length scale must be above 0"),
        ({"turbulence_spec": it.RATIO, "turbulence_viscosity_ratio": -1}, "the turbulent viscosity ratio must be above 0"),
        ({"turbulence_intensity": 3, "turbulence_length_scale": 0.2}, None),
        ({"turbulence_spec": it.AUTO, "turbulence_intensity": 0}, None),
    ],
)
def test_settings_problems(fields: dict, problem: str | None):
    assert it.settings_problem({"turbulence_spec": it.LENGTH, **fields}) == problem


def test_a_velocity_inlet_writes_its_own_values_from_its_own_speed():
    inlet = {**INLET, "turbulence_spec": it.LENGTH, "turbulence_intensity": 2, "turbulence_length_scale": 0.05}
    spec = _spec(("inlet", inlet), ("pressure", PRESSURE))
    own = patch_turbulence(spec, speed_ref=99.0)
    assert set(own) == {"inlet"}
    assert own["inlet"]["speed_m_s"] == 10
    values = turb_value_strings(own["inlet"]["k"], own["inlet"]["omega"])
    _u, _p, turb = _build_field_patches(spec, ["inlet", "pressure", "walls"], turb_values=AUTO, patch_turb={"inlet": values})
    assert turb["k"]["inlet"] == {"type": "fixedValue", "value": f"uniform {values['k']}"}
    assert turb["omega"]["inlet"] == {"type": "fixedValue", "value": f"uniform {values['omega']}"}
    # The pressure boundary (Auto) and the walls keep the case-wide values.
    assert turb["k"]["pressure"] == {"type": "inletOutlet", "inletValue": "uniform 0.5", "value": "uniform 0.5"}
    assert turb["k"]["walls"] == {"type": "kqRWallFunction", "value": "uniform 0.5"}


def test_a_pressure_boundary_uses_the_case_speed_for_its_intensity():
    pressure = {**PRESSURE, "turbulence_spec": it.RATIO, "turbulence_intensity": 1, "turbulence_viscosity_ratio": 5}
    own = patch_turbulence(_spec(("inlet", INLET), ("pressure", pressure)), speed_ref=7.0)
    assert set(own) == {"pressure"}
    assert own["pressure"]["speed_m_s"] == 7.0
    assert own["pressure"]["k"] == pytest.approx(1.5 * (0.01 * 7) ** 2)


def test_value_strings_match_the_case_wide_formatting():
    v = turb_value_strings(0.375, 123.456789)
    assert v == {"k": "0.375000", "omega": "123.457", "epsilon": "4.16667", "R": "(0.250000 0 0 0.250000 0 0.250000)"}


def _write(tmp_path: Path, spec: RunSpec) -> Path:
    out = tmp_path / "case"
    write_solve_case(spec, out)
    return out


def test_the_written_case_holds_the_inlet_values_and_the_sidecar_says_so(tmp_path: Path):
    inlet = {**INLET, "turbulence_spec": it.LENGTH, "turbulence_intensity": 2, "turbulence_length_scale": 0.05}
    spec = _spec(("inlet", inlet), ("pressure", PRESSURE), model="kEpsilon", face_props={"face 1@B": FaceProps(area_m2=0.01)})
    out = _write(tmp_path, spec)
    k = 1.5 * (0.02 * 10) ** 2
    eps = 0.09**0.75 * k**1.5 / 0.05
    text = " ".join((out / "0" / "epsilon").read_text(encoding="utf-8").split())
    want = turb_value_strings(k, math.sqrt(k) / (0.09**0.25 * 0.05))["epsilon"]
    assert float(want) == pytest.approx(eps, rel=1e-5)
    assert f"inlet {{ type fixedValue; value uniform {want}; }}" in text
    side = json.loads((out / "w27-case.json").read_text(encoding="utf-8"))
    assert side["turbulence"]["patches"]["inlet"]["length_scale_m"] == 0.05


def test_a_laminar_case_writes_no_turbulence(tmp_path: Path):
    inlet = {**INLET, "turbulence_spec": it.LENGTH, "turbulence_intensity": 2}
    out = _write(tmp_path, _spec(("inlet", inlet), ("pressure", PRESSURE), model="laminar"))
    assert not (out / "0" / "k").exists()
    side = json.loads((out / "w27-case.json").read_text(encoding="utf-8"))
    assert side["turbulence"]["patches"] == {}
