"""Phase 2 land15: web_mirrors package split ownership + stable public imports."""
from __future__ import annotations

from cfddesk.project import web_adapter as wa
from cfddesk.project import web_mirrors as wm


def test_web_mirrors_is_package_with_owned_modules():
    import cfddesk.project.web_mirrors as pkg
    import cfddesk.project.web_mirrors.bcs as bcs
    import cfddesk.project.web_mirrors.controls as controls
    import cfddesk.project.web_mirrors.materials as materials
    import cfddesk.project.web_mirrors.mesh as mesh
    import cfddesk.project.web_mirrors.ops as ops
    import cfddesk.project.web_mirrors.simulations as simulations

    assert pkg.__file__ and pkg.__file__.endswith("__init__.py")
    assert materials.to_web_materials.__module__.endswith(".materials")
    assert bcs.to_web_boundary_conditions.__module__.endswith(".bcs")
    assert mesh.to_web_mesh.__module__.endswith(".mesh")
    assert mesh.to_web_mesh_refinements.__module__.endswith(".mesh")
    assert controls.to_web_result_controls.__module__.endswith(".controls")
    assert controls.to_web_simulation_control.__module__.endswith(".controls")
    assert simulations.to_web_simulations.__module__.endswith(".simulations")
    assert simulations.to_web_runs_catalog.__module__.endswith(".simulations")
    assert ops.regenerate_web_mirrors.__module__.endswith(".ops")
    assert ops.apply_web_sibling_to_project.__module__.endswith(".ops")


def test_public_import_paths_stable():
    for name in (
        "WEB_SIBLING_RELS",
        "to_web_materials",
        "from_web_materials",
        "to_web_boundary_conditions",
        "from_web_boundary_conditions",
        "to_web_mesh",
        "from_web_mesh",
        "to_web_mesh_refinements",
        "from_web_mesh_refinements",
        "to_web_result_controls",
        "from_web_result_controls",
        "to_web_simulation_control",
        "from_web_simulation_control",
        "to_web_simulations",
        "from_web_simulations",
        "to_web_runs_catalog",
        "from_web_runs_catalog",
        "apply_web_sibling_to_project",
        "regenerate_web_mirrors",
        "ingest_web_siblings_if_newer",
        "load_or_synthesize_project",
        "mark_web_mirrors_derived",
        "is_python_project_doc",
    ):
        assert hasattr(wm, name), name
        assert hasattr(wa, name) or name in (
            # web_adapter re-export set from land8 (may omit a few ops helpers)
            "sibling_updated_at",
            "project_updated_at",
        ), name


def test_web_adapter_reexports_match_package():
    assert wa.to_web_materials is wm.to_web_materials
    assert wa.from_web_materials is wm.from_web_materials
    assert wa.to_web_boundary_conditions is wm.to_web_boundary_conditions
    assert wa.to_web_mesh is wm.to_web_mesh
    assert wa.regenerate_web_mirrors is wm.regenerate_web_mirrors
    assert wa.apply_web_sibling_to_project is wm.apply_web_sibling_to_project
