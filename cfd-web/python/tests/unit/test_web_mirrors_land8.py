"""Phase 2 land8: web sibling mirrors <-> Project round-trip + v15 + fingerprint."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from cfddesk.project.model import PROJECT_VERSION, Project
from cfddesk.project.web_adapter import (
    from_web_boundary_conditions,
    from_web_materials,
    from_web_mesh,
    from_web_result_controls,
    from_web_runs_catalog,
    from_web_simulation_control,
    regenerate_web_mirrors,
    to_web_boundary_conditions,
    to_web_materials,
    to_web_mesh,
    to_web_result_controls,
    to_web_runs_catalog,
    to_web_simulation_control,
)
from cfddesk.project.web_mirrors import (
    apply_web_sibling_to_project,
    ingest_web_siblings_if_newer,
    load_or_synthesize_project,
    mark_web_mirrors_derived,
)
from tests.conftest import PROJECTS

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "js-project"
BASELINE_FP = "1fe52a19f6e6f90a"


def test_project_version_is_15():
    assert PROJECT_VERSION == 15


def test_v13_to_v15_fingerprint_unchanged():
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    assert proj.version == 15
    assert proj.persistence.get("web_mirrors") == "derived"
    fp = proj.mesh_input_fingerprint()
    assert fp == BASELINE_FP, f"fingerprint changed: {fp} != {BASELINE_FP}"


def test_to_web_from_web_symbols_exist():
    for name in (
        to_web_materials,
        from_web_materials,
        to_web_boundary_conditions,
        from_web_boundary_conditions,
        to_web_mesh,
        from_web_mesh,
        to_web_result_controls,
        from_web_result_controls,
        to_web_simulation_control,
        from_web_simulation_control,
        to_web_runs_catalog,
        from_web_runs_catalog,
        regenerate_web_mirrors,
    ):
        assert callable(name)


def test_roundtrip_siblings_to_project_to_mirrors(tmp_path: Path):
    """PROVE: siblings -> Project -> mirrors (materials + BCs + mesh + control)."""
    src = FIX
    if not (src / "materials.json").is_file():
        pytest.skip("js-project fixture missing")

    # Seed sibling files into temp project dir
    for name in (
        "materials.json",
        "boundary_conditions.json",
        "mesh.json",
        "result_controls.json",
        "simulation_control.json",
    ):
        (tmp_path / name).write_text((src / name).read_text(encoding="utf-8"), encoding="utf-8")

    proj, mode = load_or_synthesize_project(tmp_path)
    assert mode == "synthesized"
    assert proj.primary_simulation() is not None
    mats = proj.primary_simulation().materials
    assert mats and mats[0]["name"] == "Air"
    assert abs(float(mats[0]["nu"]) - 1.529e-5) < 1e-12
    assert len(proj.primary_simulation().boundary_conditions) >= 2

    # Regenerate mirrors from Project
    written = regenerate_web_mirrors(proj, tmp_path, sim_id=proj.primary_simulation().id)
    assert "materials" in written
    assert "boundary_conditions" in written
    assert "mesh" in written

    mats2 = json.loads((tmp_path / "materials.json").read_text(encoding="utf-8"))
    assert mats2["materials"][0]["name"] == "Air"
    assert abs(float(mats2["materials"][0]["kinematic_viscosity"]) - 1.529e-5) < 1e-12
    assert mats2["materials"][0]["assigned_volumes"] == ["Body1"]

    bcs2 = json.loads((tmp_path / "boundary_conditions.json").read_text(encoding="utf-8"))
    names = {b.get("name") for b in bcs2["boundary_conditions"]}
    assert any("inlet" in str(n).lower() for n in names)
    assert any("pressure" in str(n).lower() for n in names)

    # Second pass: mirrors -> Project again preserves Air nu
    proj2, _ = load_or_synthesize_project(tmp_path)
    assert abs(float(proj2.primary_simulation().materials[0]["nu"]) - 1.529e-5) < 1e-12


def test_v15_ingest_newer_sibling(tmp_path: Path):
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    # Old project timestamp
    doc["updated_at"] = "2020-01-01T00:00:00Z"
    proj = Project.from_dict(doc)  # upgrades to v15 without project_dir siblings
    assert proj.persistence.get("web_mirrors") == "derived"

    # Write a newer materials sibling and ingest
    mats = {
        "materials": [
            {
                "name": "Air",
                "kinematic_viscosity": 2.0e-5,
                "density": 1.1,
                "assigned_volumes": ["solid-0"],
            }
        ],
        "updated_at": "2030-01-01T00:00:00Z",
    }
    (tmp_path / "materials.json").write_text(json.dumps(mats), encoding="utf-8")
    # Save project with old updated_at
    proj = mark_web_mirrors_derived(proj)
    object.__setattr__ if False else None
    import dataclasses

    proj = dataclasses.replace(proj, updated_at="2020-01-01T00:00:00Z")
    proj.save(tmp_path / "project.json")
    loaded = Project.load(tmp_path / "project.json")
    # load calls from_dict with project_dir -> v15 ingest
    air = loaded.primary_simulation().materials
    assert air and abs(float(air[0]["nu"]) - 2.0e-5) < 1e-12
    assert loaded.persistence.get("web_mirrors") == "derived"


def test_apply_and_regenerate_runs(tmp_path: Path):
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    catalog = {
        "runs": [
            {
                "id": "run-abc",
                "name": "Run 1",
                "status": "done",
                "case_dir": str(tmp_path / "runs" / "run-abc"),
                "mesh_id": proj.primary_simulation().active_mesh_id,
            }
        ],
        "active_id": "run-abc",
        "updated_at": "2030-01-01T00:00:00Z",
    }
    proj = apply_web_sibling_to_project(proj, "runs", catalog)
    assert any(r.id == "run-abc" for r in proj.primary_simulation().runs)
    regenerate_web_mirrors(proj, tmp_path, kinds=["runs"])
    out = json.loads((tmp_path / "runs" / "catalog.json").read_text(encoding="utf-8"))
    assert out["runs"][0]["id"] == "run-abc"
