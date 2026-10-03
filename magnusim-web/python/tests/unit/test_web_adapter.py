"""Unit tests for web JSON → RunSpec adapter."""
from __future__ import annotations

import json
from pathlib import Path

from cfddesk.project.web_adapter import (
    map_bc_to_patch,
    sanitize_patch_name,
    study_web_bcs,
    unique_numbered_patch,
    web_bc_to_registry,
)

# What Incompressible Flow's RunSpec reads from these (slip walls, the fluid, the
# fixture project) is tested with the plugin:
# bundled-plugins/incompressible_flow/tests/test_runspec.py.


def test_sanitize_patch_name():
    assert sanitize_patch_name("Velocity Inlet 1") == "velocity_inlet_1"
    assert sanitize_patch_name("pressure_1") == "pressure_1"


def test_unique_numbered_patch_collision_suffix():
    names = {"walls", "pressure_1_3", "pressure_2_3"}
    assert unique_numbered_patch("pressure_1", names) == "pressure_1_3"
    assert unique_numbered_patch("pressure_2", names) == "pressure_2_3"
    assert unique_numbered_patch("pressure_1", {"pressure_1", "pressure_1_3"}) == "pressure_1"
    assert unique_numbered_patch("pressure_1", {"pressure_1_2", "pressure_1_3"}) is None
    assert unique_numbered_patch("pressure_1", {"pressure_10"}) is None


def test_map_bc_to_patch_accepts_suffixed_mesh_name():
    patch = map_bc_to_patch(
        {"name": "Pressure 1", "faces": ["face 13@Body1"]},
        {"walls", "pressure_1_3", "pressure_2_3"},
    )
    assert patch == "pressure_1_3"


def test_study_web_bcs_reads_folder_bcs_when_aggregate_empty(tmp_path: Path):
    from cfddesk.project.paths import (
        assemble_study_bcs,
        create_geometry_folder,
        create_study_folder,
        find_study,
        persist_child_item,
    )

    create_geometry_folder(tmp_path, {"id": "g1", "name": "part.step", "original_filename": "part.step"})
    create_study_folder(tmp_path, "g1", {"id": "sim-a", "name": "Incompressible Steady-state"})
    study = find_study(tmp_path, "sim-a")
    assert study is not None
    persist_child_item(
        Path(study["dir"]) / "boundary_conditions",
        "bc",
        {
            "id": "bc-1",
            "name": "Pressure 1",
            "bc_type": "Pressure",
            "faces": ["face 10@Body1"],
            "value": 0,
            "simulation_id": "sim-a",
        },
    )
    persist_child_item(
        Path(study["dir"]) / "boundary_conditions",
        "bc",
        {
            "id": "bc-2",
            "name": "Pressure 2",
            "bc_type": "Pressure",
            "faces": ["face 13@Body1"],
            "value": -15000,
            "simulation_id": "sim-a",
        },
    )
    (Path(study["dir"]) / "boundary_conditions.json").write_text(
        json.dumps({"boundary_conditions": [], "simulation_id": "sim-a", "updated_at": "2026-09-19T16:21:01.453Z"}),
        encoding="utf-8",
    )
    assembled = assemble_study_bcs(tmp_path, "sim-a")
    assert [b["name"] for b in assembled] == ["Pressure 1", "Pressure 2"]
    rows = study_web_bcs(tmp_path, [], simulation_id="sim-a")
    assert [r["name"] for r in rows] == ["Pressure 1", "Pressure 2"]
    assert rows[0]["faces"] == ["face 10@Body1"]


def test_study_web_bcs_ignores_other_simulations(tmp_path: Path):
    (tmp_path / "mesh.json").write_text(
        json.dumps(
            {
                "simulation_id": "sim-b",
                "meshes": [{"id": "mesh-b", "simulation_id": "sim-b"}],
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "simulations.json").write_text(
        json.dumps({"active_id": "sim-b", "simulations": [{"id": "sim-a"}, {"id": "sim-b"}]}),
        encoding="utf-8",
    )
    rows = study_web_bcs(
        tmp_path,
        [
            {"name": "Pressure 1", "simulation_id": "sim-a", "faces": ["face 10@Body1"]},
            {"name": "Pressure 1", "simulation_id": "sim-b", "faces": ["face 13@Body1"]},
            {"name": "Pressure 2", "simulation_id": "sim-a"},
        ],
        mesh_id="mesh-b",
    )
    assert [r["name"] for r in rows] == ["Pressure 1"]
    assert rows[0]["simulation_id"] == "sim-b"


def test_web_bc_to_registry_velocity_and_pressure():
    key, settings = web_bc_to_registry(
        {
            "bc_type": "Velocity Inlet",
            "velocity_type": "Fixed",
            "value": 2.0,
            "unit": "m/s",
            "direction": "normal",
        }
    )
    assert key == "velocity_inlet_fixed"
    assert settings.get("speed") == 2.0

    key2, settings2 = web_bc_to_registry(
        {"bc_type": "Pressure Outlet", "value": 0, "unit": "Pa"}
    )
    assert key2.startswith("pressure_")
    assert settings2.get("gauge_pressure") == 0.0


def test_web_bc_to_registry_dispatches_to_the_registered_family():
    """The family whose record_type (or an alias, any case or spacing) names the
    record resolves it; a type no family names reads as a no-slip wall."""
    from cfddesk.registry import BcFamily, load_all, reset_for_tests

    reset_for_tests()
    try:
        hub = load_all()
        seen = []

        def resolve(rec):
            seen.append(rec)
            return "wall_slip", {"from": "fx"}

        hub.registry("bc_family").register(
            BcFamily(key="fx_sym", label="Symmetry", record_type="Symmetry plane",
                     aliases=("Mirror",), variants=("wall_slip",), resolve=resolve),
            plugin="fx",
        )
        assert web_bc_to_registry({"bc_type": "symmetry  Plane", "x": 1}) == ("wall_slip", {"from": "fx"})
        assert web_bc_to_registry({"bc_type": "Mirror"}) == ("wall_slip", {"from": "fx"})
        assert seen[0] == {"bc_type": "symmetry  Plane", "x": 1}
        assert web_bc_to_registry({"bc_type": "Periodic"}) == ("wall_noslip", {})
        assert web_bc_to_registry({}) == ("wall_noslip", {})
        # Pressure's aliases reach its family.
        assert web_bc_to_registry({"bc_type": "Pressure outlet", "value": 3, "unit": "Pa"}) == (
            "pressure_outlet_gauge", {"gauge_pressure": 3.0})
        hub.registry("bc_family").drop_plugin("fx")
        assert web_bc_to_registry({"bc_type": "Symmetry plane"}) == ("wall_noslip", {})
    finally:
        reset_for_tests()


def test_web_bc_to_registry_reads_an_object_record():
    from types import SimpleNamespace

    rec = SimpleNamespace(bc_type="Wall", value=None, unit="", velocity_type=None, flow_rate_type=None,
                          direction=None, vector=None, wall_type="Slip", name="Wall 1")
    assert web_bc_to_registry(rec) == ("wall_slip", {})


def test_web_bc_mesh_entry_canonicalizes_aliases_and_refuses_unknown_types():
    import pytest

    from cfddesk.project.web_adapter import web_bc_mesh_entry

    assert web_bc_mesh_entry({"bc_type": "Slip wall", "wall_type": "Slip"})[0] == "wall_slip"
    assert web_bc_mesh_entry({"type": "velocity_inlet", "value": 2, "unit": "m/s"})[0] == "velocity_inlet_fixed"
    assert web_bc_mesh_entry({"bc_type": "Pressure inlet", "value": 1, "unit": "Pa"})[0] == "pressure_outlet_gauge"
    # A bad direction vector still meshes (as the family's first variant).
    bad = {"bc_type": "Velocity inlet", "value": 1, "direction": "Vector", "vector": [1, "nan", 0]}
    assert web_bc_mesh_entry(bad) == ("velocity_inlet_fixed", {})
    with pytest.raises(ValueError, match="unsupported boundary condition type"):
        web_bc_mesh_entry({"bc_type": "Symmetry"})


def test_unnamed_web_bcs_mesh_under_the_names_the_meshers_used_before():
    """An unnamed record keeps its old patch name (a velocity outlet does not become "outlet")."""
    from cfddesk.project.web_adapter import web_bc_mesh_entry, web_bc_patch_name

    expect = {"Velocity inlet": "inlet", "Velocity outlet": "velocity_outlet", "Pressure": "outlet", "Wall": "wall"}
    for bc_type, name in expect.items():
        rec = {"bc_type": bc_type, "value": 1, "unit": "m/s" if bc_type.startswith("Velocity") else "Pa"}
        assert web_bc_patch_name(rec, web_bc_mesh_entry(rec)[0]) == name
    assert web_bc_patch_name({"bc_type": "Wall", "name": "Lid"}, "wall_noslip") == "Lid"


def test_parse_boundary_patches_indented(tmp_path: Path):
    from magnusim_sdk.foam import boundary_patch_names as _parse_boundary_patches

    boundary = tmp_path / "boundary"
    boundary.write_text(
        "FoamFile\n{\n    format ascii;\n}\n\n3\n(\n    walls\n    {\n        type            wall;\n    }\n"
        "    velocity_inlet_1\n    {\n        type            patch;\n    }\n"
        "    pressure_1\n    {\n        type            patch;\n    }\n)\n",
        encoding="utf-8",
    )
    assert _parse_boundary_patches(boundary) == ["walls", "velocity_inlet_1", "pressure_1"]
