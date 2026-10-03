"""Which surfaces the Standard mesher sizes as inlets / outlets (physics-based sizing).

The BC's semantic class decides; a patch named inlet / outlet (or inlet_* /
outlet_*) is sized as one too. The default names the app gives Incompressible
Flow BCs (velocity_inlet_1, pressure_outlet_1, ...) are sized by their semantic.
"""

from types import SimpleNamespace

import pytest

gmsh_standard = pytest.importorskip("cfddesk.mesh.gmsh_standard")

from cfddesk.case import bc_menu, bc_registry  # noqa: E402
from cfddesk.mesh.patches import EmittedPatch  # noqa: E402


def _tags(monkeypatch, rows):
    """rows: (bc id, patch name, semantic or None (lookup fails), face id)."""
    bcs = [SimpleNamespace(id=bc_id) for bc_id, *_ in rows]
    semantics = {bc_id: sem for bc_id, _name, sem, _fid in rows}
    patches = [
        EmittedPatch(name=name, patch_type="patch", face_ids=(fid,), bc_id=bc_id, refinement_level=0)
        for bc_id, name, _sem, fid in rows
    ]
    monkeypatch.setattr(gmsh_standard, "emit_all_patches", lambda project: patches)
    monkeypatch.setattr(bc_menu, "registry_key_for_bc", lambda bc: bc.id)

    def get_type(key):
        if semantics[key] is None:
            raise KeyError(key)
        return SimpleNamespace(semantic=semantics[key])

    monkeypatch.setattr(bc_registry, "get_type", get_type)
    project = SimpleNamespace(boundary_conditions=bcs)
    face_to_tag = {fid: 100 + fid for *_, fid in rows}
    return gmsh_standard._inlet_outlet_surface_tags(project, face_to_tag)


def test_the_semantic_decides_for_the_apps_default_names(monkeypatch):
    rows = [
        ("a", "velocity_inlet_1", "inlet", 1),
        ("b", "pressure_outlet_1", "outlet", 2),
        ("c", "velocity_outlet_1", "outlet", 3),
        ("d", "wall_1", "wall", 4),
        ("e", "velocity_inlet", "inlet", 5),
        ("f", "pressure_outlet", "outlet", 6),
    ]
    assert _tags(monkeypatch, rows) == ([101, 105], [102, 103, 106])


def test_patches_named_inlet_or_outlet_are_sized_as_before(monkeypatch):
    rows = [
        ("a", "inlet", "wall", 1),
        ("b", "inlet_pipe", None, 2),
        ("c", "outlet", None, 3),
        ("d", "outlet_2", "wall", 4),
        ("e", "side", None, 5),
    ]
    assert _tags(monkeypatch, rows) == ([101, 102], [103, 104])
