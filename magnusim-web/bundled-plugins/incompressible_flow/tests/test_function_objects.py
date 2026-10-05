"""Unit tests for mon_/flow_ surfaceFieldValue emitters."""
from __future__ import annotations

from conftest import FIXTURES

from incompressible_flow.function_objects import (
    field_average_block,
    js_to_precision,
    monitor_patches_from_mapped,
    monitors_functions_text,
    result_fields_functions_text,
    surface_field_value_block,
)
from incompressible_flow.transient import TransientControl


def test_js_to_precision_matches_node():
    assert js_to_precision(0.1 / 50, 6) == "0.00200000"
    assert js_to_precision(1.0, 6) == "1.00000"


def test_steady_monitors_use_timestep():
    text = monitors_functions_text(["inlet", "outlet"], transient=None)
    assert "mon_inlet" in text
    assert "flow_outlet" in text
    assert "writeControl    timeStep;" in text
    assert "operation       areaAverage;" in text
    assert "fields          ( U p );" in text
    assert "fields          ( phi );" in text
    assert "pInlet" not in text
    assert "pOutlet" not in text


def test_transient_monitors_use_runtime_interval():
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
    text = monitors_functions_text(["pressure_1"], transient=ctrl)
    assert "writeControl    runTime;" in text
    assert "writeInterval   0.00200000;" in text


def test_monitor_patches_from_mapped():
    mapped = [
        {"bc": {"bc_type": "Velocity Inlet", "faces": ["face 1@Body1"]}, "patch": "velocity_inlet_1"},
        {"bc": {"bc_type": "Pressure", "faces": ["face 2@Body1"]}, "patch": "pressure_1"},
        {"bc": {"bc_type": "Wall", "faces": ["face 3@Body1"]}, "patch": "walls"},
    ]
    patches = monitor_patches_from_mapped(mapped)
    assert patches == ["velocity_inlet_1", "pressure_1"]
    # AA face on wall owner should add walls
    patches2 = monitor_patches_from_mapped(
        mapped,
        aa_faces=["face 3@Body1"],
        patch_names=["velocity_inlet_1", "pressure_1", "walls"],
    )
    assert "walls" in patches2


def test_surface_field_value_block_shape():
    block = surface_field_value_block(
        "mon_x",
        "x",
        operation="areaAverage",
        fields=("U", "p"),
        write_control_text="writeControl    timeStep;\n        writeInterval   1;",
        log=True,
    )
    assert 'libs            ("libfieldFunctionObjects.so");' in block
    assert "regionType      patch;" in block


def test_custom_monitor_on_any_faces_is_a_sampled_surface(tmp_path, monkeypatch):
    """A Monitor on a plain wall face (no BC patch of its own) still records data."""
    from types import SimpleNamespace

    import cfddesk.project.paths as paths
    from cfddesk.project.case_services import CaseServices
    from magnusim_sdk.study import run_custom_monitors

    from incompressible_flow.function_objects import (
        custom_monitor_key,
        custom_monitors_functions_text,
    )
    from incompressible_flow.writer import write_custom_monitor_surfaces

    rcs = [
        {"id": "rc1", "name": "Area average 1", "category": "Surface data", "faces": ["face 15@Body1"]},
        {"id": "rc2", "name": "Area average 2", "category": "Surface data", "faces": []},
        {"id": "rc3", "name": "Probe", "kind": "probe", "faces": ["face 1@Body1"]},
    ]
    mons = run_custom_monitors(rcs)
    assert [m["name"] for m in mons] == ["Area average 1"]

    taken: set[str] = set()
    assert custom_monitor_key("Area average 1", taken) == "rc_area_average_1"
    assert custom_monitor_key("Area average 1", taken) == "rc_area_average_1_2"

    step = FIXTURES / "elbow.step"
    monkeypatch.setattr(paths, "resolve_step_for_study", lambda *a, **k: step)
    spec = SimpleNamespace(project_dir=tmp_path, simulation_id="s", mesh_id="m", custom_monitors=mons)
    written = write_custom_monitor_surfaces(tmp_path, spec, CaseServices(tmp_path, "s", "m"))
    assert len(written) == 1 and written[0]["key"] == "rc_area_average_1"
    stl = tmp_path / "constant" / "triSurface" / "rc_area_average_1.stl"
    assert stl.is_file() and stl.stat().st_size > 84
    assert written[0]["area_m2"] > 0

    text = custom_monitors_functions_text(written)
    assert "regionType      sampledSurface;" in text
    assert "type        meshedSurface;" in text and "surface     rc_area_average_1.stl;" in text
    assert "operation       areaAverage;" in text


def test_fo_monitor_spec_untouched_naming_collision():
    """registry.MonitorType must not replace function_objects.MonitorSpec."""
    from dataclasses import fields

    from cfddesk.registry import MonitorType

    from incompressible_flow import function_objects as fo

    assert {"patch", "kind"} <= {f.name for f in fields(fo.MonitorSpec)}
    assert {"key", "label", "target"} <= {f.name for f in fields(MonitorType)}
    assert fo.MonitorSpec is not MonitorType
    assert fo.MonitorKind.__args__ == ("area_average", "flow")


def test_fo_monitor_kind_flow_vs_flow_rate_unchanged():
    """Carry: FO MonitorKind still 'flow'; registry monitor key still flow_rate.
    No third name invented this land.
    """
    from cfddesk.registry import get_registry, load_all, reset_for_tests

    from incompressible_flow import function_objects as fo

    assert fo.MonitorKind.__args__ == ("area_average", "flow")
    reset_for_tests()
    try:
        load_all()
        assert "flow_rate" in get_registry("monitor").keys()
        assert "flow" not in get_registry("monitor").keys()
    finally:
        reset_for_tests()


def _ctrl(average_from: float = 0.0) -> TransientControl:
    return TransientControl(
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
        average_from=average_from,
    )


def _block(text: str, name: str) -> str:
    """One function object's body (from its name to its closing brace)."""
    import re

    m = re.search(rf"^    {name}\n    \{{\n(.*?)\n    \}}", text, re.S | re.M)
    assert m, f"no {name} block in\n{text}"
    return m.group(1)


def test_result_fields_are_written_at_every_saved_time():
    text = result_fields_functions_text(turbulent=True, rho=1.196)
    for name, fo_type in (
        ("yPlus", "yPlus"),
        ("wallShearStress", "wallShearStress"),
        ("pTotal", "pressure"),
        ("vorticity", "vorticity"),
        ("Q", "Q"),
    ):
        body = _block(text, name)
        assert f"type            {fo_type};" in body
        assert 'libs            ("libfieldFunctionObjects.so");' in body
        # Worked out only when a frame is saved, and saved with it.
        assert "executeControl  writeTime;" in body
        assert "writeControl    writeTime;" in body
    assert "fieldAverage" not in text


def test_total_pressure_is_written_in_pa_as_p_total():
    body = _block(result_fields_functions_text(turbulent=True, rho=998.2), "pTotal")
    assert "mode            total;" in body
    # "total(p)" is not a field name results can show; the incompressible case's p
    # is divided by density, so the function object needs rho to write Pa.
    assert "result          pTotal;" in body
    assert "rho             rhoInf;" in body
    assert "rhoInf          998.2;" in body


def test_laminar_runs_write_no_y_plus():
    text = result_fields_functions_text(turbulent=False, rho=1.2)
    assert "yPlus" not in text
    assert "type            wallShearStress;" in text


def test_transient_runs_average_u_and_p_from_the_start():
    text = result_fields_functions_text(turbulent=True, rho=1.2, transient=_ctrl())
    body = _block(text, "fieldAverage")
    assert "type            fieldAverage;" in body
    assert "writeControl    writeTime;" in body
    # Averaged every time step, written with the frames; no start time = from the start.
    assert "executeControl" not in body and "timeStart" not in body
    assert body.count("mean        on;") == 2 and body.count("prime2Mean  off;") == 2
    assert "            U\n" in body and "            p\n" in body


def test_averaging_starts_at_the_runs_average_from_time():
    assert "timeStart       1.5;" in field_average_block(_ctrl(1.5))
    assert "timeStart" not in field_average_block(_ctrl(0.0))


def test_every_written_field_is_a_result_field():
    from incompressible_flow import function_objects as fo
    from incompressible_flow.analyses import _RESULT_FIELDS
    from incompressible_flow.physics import KINEMATIC_FIELDS

    keys = {f.key for f in _RESULT_FIELDS}
    written = {
        fo.YPLUS_FIELD, fo.WALL_SHEAR_STRESS_FIELD, fo.TOTAL_PRESSURE_FIELD, fo.VORTICITY_FIELD,
        fo.Q_FIELD, fo.MEAN_VELOCITY_FIELD, fo.MEAN_PRESSURE_FIELD,
    }
    assert written <= keys
    labels = {f.key: (f.label, f.unit, f.kind) for f in _RESULT_FIELDS}
    assert labels["yPlus"] == ("y+", "", "scalar")
    assert labels["wallShearStress"] == ("Wall shear stress", "Pa", "vector")
    assert labels["pTotal"] == ("Total pressure", "Pa", "scalar")
    assert labels["vorticity"] == ("Vorticity", "1/s", "vector")
    assert labels["Q"] == ("Q-criterion", "1/s²", "scalar")
    assert labels["UMean"] == ("Mean velocity", "m/s", "vector")
    assert labels["pMean"] == ("Mean pressure", "Pa", "scalar")
    # Stored divided by density like p (shown x rho); pTotal is written in Pa.
    assert {"wallShearStress", "pMean"} <= set(KINEMATIC_FIELDS)
    assert "pTotal" not in KINEMATIC_FIELDS


def test_written_case_holds_the_result_function_objects(tmp_path):
    import json

    from conftest import JS_PROJECT
    from conftest import run_spec as load_run_spec

    from incompressible_flow.writer import write_solve_case

    spec = load_run_spec(JS_PROJECT, run_id="r-fields", require_mesh=False, n_procs=1)
    assert spec.ok, spec.error
    write_solve_case(spec, tmp_path / "steady")
    text = (tmp_path / "steady" / "system" / "controlDict").read_text(encoding="utf-8")
    # The monitors stay; the result fields follow them.
    assert text.index("mon_pressure_1") < text.index("    yPlus\n") < text.index("    Q\n")
    assert f"rhoInf          {spec.rho:g};" in text
    assert "fieldAverage" not in text
    sidecar = json.loads((tmp_path / "steady" / "w27-case.json").read_text(encoding="utf-8"))
    assert sidecar["kinematic_fields"] == ["p", "wallShearStress", "pMean"]

    spec = load_run_spec(
        JS_PROJECT,
        run_id="r-fields-t",
        require_mesh=False,
        n_procs=1,
        transient_override={"end_time": 2, "write_count": 20, "average_from": 0.5},
    )
    write_solve_case(spec, tmp_path / "transient")
    text = (tmp_path / "transient" / "system" / "controlDict").read_text(encoding="utf-8")
    assert "timeStart       0.5;" in _block(text, "fieldAverage")
    sidecar = json.loads((tmp_path / "transient" / "w27-case.json").read_text(encoding="utf-8"))
    assert sidecar["transient"]["average_from"] == 0.5
