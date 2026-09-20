"""Phase 2 land7: Geometry bodies/regions (v14) + fingerprint soft-pass."""
from __future__ import annotations

import json
from dataclasses import replace

import pytest

from cfddesk.project.hierarchy import Body
from cfddesk.project.model import (
    PROJECT_VERSION,
    Project,
    _mesh_fingerprint_payload,
)
from cfddesk.registry import (
    load_all,
    reset_for_tests,
    validate_multi_region_meshing,
)
from cfddesk.registry.analysis import run_analysis_validate
from tests.conftest import PROJECTS


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def test_v13_fixture_upgrades_to_v14_bodies():
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    assert doc["version"] == 13
    proj = Project.from_dict(doc)
    assert proj.version == PROJECT_VERSION
    assert PROJECT_VERSION >= 14
    geom = proj.primary_geometry()
    assert geom is not None
    assert geom.bodies
    assert all(isinstance(b, Body) for b in geom.bodies)
    assert all(b.role == "fluid" for b in geom.bodies)
    assert all(b.region == "fluid" for b in geom.bodies)
    # volumes is read-only alias
    assert geom.volumes[0]["id"] == geom.bodies[0].id
    assert geom.volumes[0]["face_ids"] == list(geom.bodies[0].face_ids)
    regions = geom.regions()
    assert list(regions.keys()) == ["fluid"]
    assert regions["fluid"] == list(geom.bodies)


def test_single_fluid_fingerprint_unchanged_vs_baseline():
    """Soft-pass HARD: v13→v14 must not change mesh fingerprint for single-fluid."""
    baseline = "1fe52a19f6e6f90a"  # captured at HEAD 845d24b before land7
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    fp = proj.mesh_input_fingerprint()
    payload = _mesh_fingerprint_payload(proj)
    assert "bodies" not in payload
    assert fp == baseline
    # round-trip to_dict (bodies) and back still matches
    again = Project.from_dict(proj.to_dict())
    assert again.mesh_input_fingerprint() == baseline


def test_fingerprint_includes_bodies_when_non_fluid_or_multi_region():
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    geom = proj.primary_geometry()
    assert geom and geom.bodies
    solid = replace(geom.bodies[0], role="solid", region="solid")
    geom2 = replace(geom, bodies=[solid])
    proj2 = replace(proj, geometries=[geom2])
    payload = _mesh_fingerprint_payload(proj2)
    assert "bodies" in payload
    assert proj2.mesh_input_fingerprint() != proj.mesh_input_fingerprint()

    # multi-region, both fluid roles
    b0 = geom.bodies[0]
    b1 = Body(
        id="extra",
        name="Extra",
        face_ids=b0.face_ids,
        role="fluid",
        region="fluid2",
    )
    geom3 = replace(geom, bodies=[b0, b1])
    proj3 = replace(proj, geometries=[geom3])
    assert "bodies" in _mesh_fingerprint_payload(proj3)


def test_materials_body_ids_alias_volume_ids():
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    sim = proj.primary_simulation()
    assert sim and sim.materials
    m = sim.materials[0]
    assert "body_ids" in m
    assert m["body_ids"] == m["volume_ids"]
    assert m["body_ids"] == ["solid-0"]


def test_bc_optional_region_roundtrip():
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    bc = proj.boundary_conditions[0]
    assert bc.region is None
    d = bc.to_dict()
    assert "region" not in d
    from cfddesk.project.model import BoundaryCondition

    with_region = replace(bc, region="fluid")
    d2 = with_region.to_dict()
    assert d2["region"] == "fluid"
    back = BoundaryCondition.from_dict(d2)
    assert back.region == "fluid"


def test_validate_multi_region_rejects_when_mesher_false():
    hub = load_all()
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    geom = proj.primary_geometry()
    assert geom and geom.bodies
    b0 = geom.bodies[0]
    b1 = Body(id="b2", name="B2", face_ids=b0.face_ids, role="fluid", region="other")
    proj2 = replace(proj, geometries=[replace(geom, bodies=[b0, b1])])
    standard = hub.registry("mesher").get("standard")
    assert standard.multi_region is False
    errs = validate_multi_region_meshing(proj2, standard)
    assert errs
    # single region OK
    assert validate_multi_region_meshing(proj, standard) == []


def test_analysis_validate_region_roles_fluid_ok():
    hub = load_all()
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    spec = hub.registry("analysis").get("incompressible_steady")
    assert run_analysis_validate(spec, proj) == []


def test_to_dict_emits_bodies_not_volumes():
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    gdict = proj.to_dict()["geometries"][0]
    assert "bodies" in gdict
    assert "volumes" not in gdict
