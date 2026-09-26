"""Unit tests for mon_/flow_ surfaceFieldValue emitters."""
from __future__ import annotations

from pathlib import Path

from cfddesk.case.function_objects import (
    js_to_precision,
    monitor_patches_from_mapped,
    monitors_functions_text,
    surface_field_value_block,
)
from cfddesk.project.transient import TransientControl


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
    from cfddesk.case.function_objects import custom_monitor_key, custom_monitors_functions_text
    from cfddesk.case.writer import write_custom_monitor_surfaces
    from cfddesk.project.web_adapter import run_custom_monitors

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

    step = Path(__file__).resolve().parents[1] / "fixtures" / "geometry" / "elbow.step"
    monkeypatch.setattr(paths, "resolve_step_for_study", lambda *a, **k: step)
    spec = SimpleNamespace(project_dir=tmp_path, simulation_id="s", mesh_id="m", custom_monitors=mons)
    written = write_custom_monitor_surfaces(tmp_path, spec)
    assert len(written) == 1 and written[0]["key"] == "rc_area_average_1"
    stl = tmp_path / "constant" / "triSurface" / "rc_area_average_1.stl"
    assert stl.is_file() and stl.stat().st_size > 84
    assert written[0]["area_m2"] > 0

    text = custom_monitors_functions_text(written)
    assert "regionType      sampledSurface;" in text
    assert "type        meshedSurface;" in text and "surface     rc_area_average_1.stl;" in text
    assert "operation       areaAverage;" in text
