"""Post-0c6be39 hydrate migrate: bug-stamped cfmesh vs explicit Advanced."""
from __future__ import annotations

from cfddesk.project.web_mirrors.mesh import from_web_mesh, to_web_mesh


def _bug_path_doc():
    """Old hexcore_backend-coupled stamp: adv.mesh_engine=cfmesh, no ui_mesh_engine."""
    return {
        "active_id": "mesh-1",
        "meshes": [
            {
                "id": "mesh-1",
                "name": "Mesh 1",
                "settings": {
                    "algorithm": "Standard",
                    "fineness": 1,
                    "hex_element_core": True,
                    "advanced": {"mesh_engine": "cfmesh"},
                },
            }
        ],
    }


def _explicit_cfmesh_doc():
    return {
        "active_id": "mesh-1",
        "meshes": [
            {
                "id": "mesh-1",
                "name": "Mesh 1",
                "ui_mesh_engine": "cfmesh",
                "settings": {
                    "algorithm": "Standard",
                    "fineness": 1,
                    "hex_element_core": True,
                    "advanced": {"mesh_engine": "cfmesh"},
                },
            }
        ],
    }


def test_bug_path_absent_ui_mesh_engine_coerces_to_standard():
    nodes, active = from_web_mesh(_bug_path_doc())
    assert active == "mesh-1"
    assert len(nodes) == 1
    meta = getattr(nodes[0], "web_meta", {})
    assert meta.get("ui_mesh_engine") == "standard"
    # hexcore_backend may still default to cfmesh (internal Standard hex-core hint);
    # product mesh_engine is ui_mesh_engine / advanced.mesh_engine, not that hint.


def test_explicit_ui_mesh_engine_cfmesh_preserved():
    nodes, _ = from_web_mesh(_explicit_cfmesh_doc())
    meta = getattr(nodes[0], "web_meta", {})
    assert meta.get("ui_mesh_engine") == "cfmesh"
    assert nodes[0].settings.hexcore_backend == "cfmesh"


def test_bug_path_roundtrip_emits_standard_mesh_engine():
    """Regenerate mirrors must emit advanced.mesh_engine=standard for bug path."""
    nodes, active = from_web_mesh(_bug_path_doc())

    class _Mesh:
        def __init__(self, n):
            self.id = n.id
            self.name = n.name
            self.settings = n.settings
            self.n_cells = n.n_cells
            self.n_points = n.n_points
            self.web_meta = getattr(n, "web_meta", {})
            self.refinements = []

    class _Sim:
        def __init__(self):
            self.id = "sim-1"
            self.meshes = [_Mesh(nodes[0])]
            self.active_mesh_id = active

        def active_mesh(self):
            return self.meshes[0]

    class _Proj:
        def __init__(self):
            self.simulations = [_Sim()]

    doc = to_web_mesh(_Proj(), sim_id="sim-1", project_id="p1")
    assert doc["settings"]["advanced"]["mesh_engine"] == "standard"
    assert doc["meshes"][0]["ui_mesh_engine"] == "standard"
    assert doc["meshes"][0]["settings"]["advanced"]["mesh_engine"] == "standard"


def test_explicit_cfmesh_roundtrip_keeps_cfmesh():
    nodes, active = from_web_mesh(_explicit_cfmesh_doc())

    class _Mesh:
        def __init__(self, n):
            self.id = n.id
            self.name = n.name
            self.settings = n.settings
            self.n_cells = n.n_cells
            self.n_points = n.n_points
            self.web_meta = getattr(n, "web_meta", {})
            self.refinements = []

    class _Sim:
        def __init__(self):
            self.id = "sim-1"
            self.meshes = [_Mesh(nodes[0])]
            self.active_mesh_id = active

        def active_mesh(self):
            return self.meshes[0]

    class _Proj:
        def __init__(self):
            self.simulations = [_Sim()]

    doc = to_web_mesh(_Proj(), sim_id="sim-1", project_id="p1")
    assert doc["settings"]["advanced"]["mesh_engine"] == "cfmesh"
    assert doc["meshes"][0]["ui_mesh_engine"] == "cfmesh"
