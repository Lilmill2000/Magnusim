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

EXPECTED_MESHER_KEYS = {"standard", "cfmesh", "snappy_hexdominant"}
HONEST_REFINEMENTS = ("surface_custom_sizing", "inflate_boundary_layer")


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
    assert EXPECTED_MESHER_KEYS <= set(reg.keys())
    assert hub.registry("mesher") is reg
    assert analysis_has_mesh_bags(hub) is False


def test_mesher_specs_shape():
    load_all()
    reg = get_registry("mesher")

    standard = reg.get("standard")
    assert isinstance(standard, MeshBackend)
    assert standard.label == "Standard"
    assert standard.tool == "mesh"
    assert standard.generate is not None
    assert standard.generate() == "generate_standard.py"
    assert standard.supports_hex_core is True
    assert standard.frozen is False
    assert callable(standard.fingerprint_payload)
    assert {field.key for field in standard.settings_schema} >= {
        "fineness",
        "hex_element_core",
        "add_layers",
    }
    # What all three generators apply; nothing else is offered.
    assert standard.refinement_types == HONEST_REFINEMENTS
    assert standard.multi_region is False

    cfmesh = reg.get("cfmesh")
    assert cfmesh.label == "cfMesh cartesianMesh (legacy)"
    assert cfmesh.tool == "mesh"
    assert cfmesh.generate is not None
    assert cfmesh.generate() == "generate_cfmesh_standard.py"
    # Only what its run reads (the panel used to show none of these).
    assert [f.key for f in cfmesh.settings_schema] == ["fineness", "add_layers", "physics_based", "hex_element_core"]
    assert "Standard mesher builds this mesh instead" in cfmesh.settings_schema[-1].description
    assert cfmesh.frozen is True
    assert cfmesh.supports_hex_core is True
    assert any(r.name == "cartesianMesh" for r in cfmesh.requires)
    assert cfmesh.refinement_types == HONEST_REFINEMENTS

    snappy = reg.get("snappy_hexdominant")
    assert snappy.label == "Hex-dominant"
    assert snappy.tool == "mesh"
    assert snappy.generate is not None
    assert snappy.generate() == "generate_snappy.py"
    assert "hex_element_core" not in {field.key for field in snappy.settings_schema}
    # generate_snappy.py takes no small-feature, gap or gradation flags: the panel shows none.
    assert [f.key for f in snappy.settings_schema] == ["fineness", "add_layers", "physics_based"]
    assert {"small_feature_suppression", "gap_refinement_factor", "global_gradation_rate"} <= {
        f.key for f in standard.settings_schema
    }
    assert snappy.supports_hex_core is False
    assert snappy.frozen is False
    assert any(r.name == "snappyHexMesh" for r in snappy.requires)
    assert snappy.refinement_types == HONEST_REFINEMENTS


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
    assert EXPECTED_MESHER_KEYS <= set(get_registry("mesher").keys())


def test_hexcore_backup_tree_not_referenced_by_meshers_module():
    """Workspace rule: HEXCORE-PROCESS-BACKUP-2026-09-02/ must not be touched."""
    from pathlib import Path as _Path

    meshers_src = (
        _Path(__file__).resolve().parents[2] / "cfddesk" / "builtin" / "meshers.py"
    ).read_text(encoding="utf-8")
    assert "HEXCORE-PROCESS-BACKUP" not in meshers_src


def test_each_refinement_type_a_mesher_offers_is_one_its_generator_applies():
    """The menu comes from the mesher, so it must not offer what no run applies."""
    import re
    from pathlib import Path

    tools = Path(__file__).resolve().parents[2] / "tools"
    applies = {
        "standard": "generate_standard.py",
        "cfmesh": "generate_cfmesh_standard.py",
        "snappy_hexdominant": "generate_snappy.py",
    }
    loaders = {"surface_custom_sizing": "load_surface_custom_sizes", "inflate_boundary_layer": "load_inflate_refs"}
    load_all()
    for key, script in applies.items():
        src = (tools / script).read_text(encoding="utf-8")
        for t in get_registry("mesher").get(key).refinement_types:
            assert re.search(rf"\b{loaders[t]}\(", src), f"{key} offers {t} but {script} never loads it"


def test_a_malformed_mesher_is_refused():
    from dataclasses import replace

    from cfddesk.registry.base import RegistryError

    load_all()
    reg = get_registry("mesher")
    standard = reg.get("standard")
    bad = [
        replace(standard, key="m1", refinement_types=("region_refinement",)),
        replace(standard, key="m2", stage_labels=(("gmsh",),)),
        replace(standard, key="m3", stage_details=(("gmsh", "([", "x"),)),
        replace(standard, key="m4", report=(("k", "text"),)),
    ]
    for spec in bad:
        with pytest.raises(RegistryError, match=spec.key):
            reg.register(spec, plugin="test")
        assert spec.key not in reg.keys()


def test_describe_publishes_what_the_page_shows_for_a_mesher():
    load_all()
    rows = {row["key"]: row for row in get_registry("mesher").describe()}
    std = rows["standard"]
    assert [t["key"] for t in std["refinement_types"]] == list(HONEST_REFINEMENTS)
    assert std["refinement_types"][0]["label"] == "Surface custom sizing"
    assert std["refinement_types"][1]["hint"]
    assert std["stage_labels"]["gmshToFoam"] == "Building the OpenFOAM mesh and boundary layers"
    assert ["gmsh", "^tets:", "Filling the volume with tetrahedra"] in std["stage_details"]
    assert std["report"][0] == ["", "Standard", ""]
    assert rows["snappy_hexdominant"]["stage_labels"]["snappyHexMesh"] == "Snapping the mesh to the surface"
    assert rows["cfmesh"]["report"][0] == ["", "cfMesh", ""]


def test_mesh_mirror_keeps_a_meshers_own_settings_and_key():
    from cfddesk.project.web_mirrors.mesh import _mesh_entry, from_web_mesh

    doc = {
        "meshes": [
            {
                "id": "m1",
                "name": "Mesh 1",
                "ui_mesh_engine": "example_extra_mesher",
                "settings": {
                    "fineness": 3,
                    "advanced": {"mesh_engine": "example_extra_mesher"},
                    "mesher_settings": {"surface_bias": 2.25},
                },
            }
        ]
    }
    nodes, _active = from_web_mesh(doc)
    entry = _mesh_entry(nodes[0], sim_id="s1")
    # A plugin mesher's key survives (even while its plugin is off), with its own settings.
    assert entry["settings"]["advanced"]["mesh_engine"] == "example_extra_mesher"
    assert entry["settings"]["mesher_settings"] == {"surface_bias": 2.25}
    assert "mesher_settings" not in entry
