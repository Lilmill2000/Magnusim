"""Phase 2 land4: MeshBackend registry + standard/cfmesh/snappy_hexdominant builtins."""

from __future__ import annotations

from dataclasses import fields

import pytest

from cfddesk.registry import (
    MeshBackend,
    analysis_has_mesh_bags,
    get_registry,
    load_all,
    reset_for_tests,
)
from cfddesk.registry.analysis import AnalysisType
from cfddesk.registry.discovery import get_hub
from cfddesk.project.mesh_refinements import REFINEMENT_MENU_BY_ALGORITHM


EXPECTED_MESHER_KEYS = {"standard", "cfmesh", "snappy_hexdominant"}


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def test_settings_mesh_literals_untouched_no_name_collision():
    """settings MeshAlgorithm / HexcoreBackend Literals stay; registry is MeshBackend."""
    from pathlib import Path as _Path

    settings_src = (
        _Path(__file__).resolve().parents[2] / "cfddesk" / "project" / "settings.py"
    ).read_text(encoding="utf-8")
    assert (
        'MeshAlgorithm = Literal["hex-dominant", "hex-dominant-parametric", "standard"]'
        in settings_src
    )
    assert 'HexcoreBackend = Literal["cfmesh", "bodyfit"]' in settings_src

    from cfddesk import registry as reg_mod

    assert hasattr(reg_mod, "MeshBackend")
    # Must NOT shadow settings names at registry package root
    assert not hasattr(reg_mod, "MeshAlgorithm")
    assert not hasattr(reg_mod, "HexcoreBackend")
    assert isinstance(MeshBackend, type)


def test_analysis_type_has_no_mesh_bags():
    """Soft-pass: no AnalysisType mesh string bags — do not invent a third list."""
    names = {f.name for f in fields(AnalysisType)}
    assert "mesh_backends" not in names
    assert "mesh_backend" not in names
    assert "default_mesher" not in names
    assert "meshers" not in names
    # solver_backends remains the wired bag pattern (land3); mesh has none yet
    assert "solver_backends" in names


def test_load_all_registers_mesher_keys():
    hub = load_all()
    reg = get_registry("mesher")
    assert set(reg.keys()) == EXPECTED_MESHER_KEYS
    assert hub.registry("mesher") is reg
    assert analysis_has_mesh_bags(hub) is False


def test_mesher_specs_shape():
    load_all()
    reg = get_registry("mesher")

    standard = reg.get("standard")
    assert isinstance(standard, MeshBackend)
    assert standard.label == "Standard"
    assert standard.tool == "generate_standard.py"
    assert standard.supports_hex_core is True
    assert standard.frozen is False
    assert standard.fingerprint_payload is None
    assert standard.settings_schema == ()
    assert standard.refinement_types == REFINEMENT_MENU_BY_ALGORITHM["standard"]
    assert standard.multi_region is False

    cfmesh = reg.get("cfmesh")
    assert cfmesh.label == "cfMesh cartesianMesh (legacy)"
    assert cfmesh.tool == "generate_cfmesh_standard.py"
    assert cfmesh.frozen is True
    assert cfmesh.supports_hex_core is True
    assert any(r.name == "cartesianMesh" for r in cfmesh.requires)
    assert cfmesh.refinement_types == REFINEMENT_MENU_BY_ALGORITHM["standard"]

    snappy = reg.get("snappy_hexdominant")
    assert snappy.label == "Hex-dominant"
    assert snappy.tool == "generate_snappy.py"
    assert snappy.supports_hex_core is False
    assert snappy.frozen is False
    assert any(r.name == "snappyHexMesh" for r in snappy.requires)
    assert snappy.refinement_types == REFINEMENT_MENU_BY_ALGORITHM["hex-dominant"]


def test_describe_mesher_includes_requires():
    load_all()
    desc = {d["key"]: d for d in get_registry("mesher").describe()}
    assert desc["standard"]["plugin"] == "builtin"
    assert desc["cfmesh"]["label"]
    assert desc["cfmesh"].get("requires")


def test_load_all_idempotent_meshers():
    load_all()
    load_all()
    load_all(force=True)
    assert set(get_registry("mesher").keys()) == EXPECTED_MESHER_KEYS


def test_hexcore_backup_tree_not_referenced_by_meshers_module():
    """Workspace rule: HEXCORE-PROCESS-BACKUP-2026-09-02/ must not be touched."""
    from pathlib import Path as _Path

    meshers_src = (
        _Path(__file__).resolve().parents[2] / "cfddesk" / "builtin" / "meshers.py"
    ).read_text(encoding="utf-8")
    assert "HEXCORE-PROCESS-BACKUP" not in meshers_src
