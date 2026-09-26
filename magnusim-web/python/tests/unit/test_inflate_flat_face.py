"""Inflate on flat faces (rims with corners): no gmsh extrusion, which stalls or crashes
the tet fill there; snappy addLayers grows those layers. Smooth rims keep the extrusion."""
from __future__ import annotations

import time

import pytest

from cfddesk.mesh import standard_hexcore as sh


def _project(tmp_path, shape, name: str, inlet: str, outlet: str):
    from generate_standard import _add_default_walls, _apply_web_bcs

    from cfddesk.cad.io import write_step
    from cfddesk.cad.step import load_step
    from cfddesk.mesh.web_refinements import leftover_faces
    from cfddesk.project.model import Project

    step = tmp_path / f"{name}.step"
    write_step(shape, step)
    solid = load_step(step)
    project = Project.from_solid(solid, scale_to_metres=0.001, units_confirmed=True)
    web = [
        {"id": "in", "name": "Inlet", "type": "velocity_inlet", "faces": [inlet], "settings": {"speed_m_s": 1}},
        {"id": "out", "name": "Outlet", "type": "pressure_outlet", "faces": [outlet], "settings": {}},
    ]
    project = _apply_web_bcs(project, web, len(solid.faces))
    project = _add_default_walls(project, leftover_faces(project, len(solid.faces)))
    return step, solid, project


def test_rim_is_smooth_tells_a_pipe_wall_from_a_box_face(tmp_path):
    prim = pytest.importorskip("OCP.BRepPrimAPI")
    import gmsh

    from cfddesk.cad.io import write_step
    from cfddesk.mesh.gmsh_standard import initialize_gmsh

    pipe = tmp_path / "pipe.step"
    box = tmp_path / "box.step"
    write_step(prim.BRepPrimAPI_MakeCylinder(20.0, 300.0).Shape(), pipe)
    write_step(prim.BRepPrimAPI_MakeBox(100.0, 50.0, 20.0).Shape(), box)
    initialize_gmsh(gmsh)
    try:
        gmsh.model.add("pipe")
        gmsh.model.occ.importShapes(str(pipe))
        gmsh.model.occ.synchronize()
        faces = [t for _d, t in gmsh.model.getEntities(2)]
        # The lateral face is the one whose rims are the two end circles (plus its seam).
        smooth = [t for t in faces if sh.rim_is_smooth(gmsh, [t])]
        assert smooth, "a pipe wall has closed rims"
        gmsh.model.add("box")
        gmsh.model.occ.importShapes(str(box))
        gmsh.model.occ.synchronize()
        for _d, t in gmsh.model.getEntities(2):
            assert not sh.rim_is_smooth(gmsh, [t]), t
    finally:
        gmsh.finalize()


def test_inflate_on_box_walls_meshes_without_gmsh_extrusion(tmp_path):
    prim = pytest.importorskip("OCP.BRepPrimAPI")
    step, solid, project = _project(
        tmp_path, prim.BRepPrimAPI_MakeBox(100.0, 50.0, 20.0).Shape(), "box", "face 1@Body1", "face 2@Body1"
    )
    sizing = sh.StandardSizing.automatic((0.1, 0.05, 0.02), fineness=3)
    specs = [sh.LayerPatchSpec(name="walls", n_layers=3, thickness_m=0.001, expansion=1.2, honor_absolute=True)]
    lines: list[str] = []
    t0 = time.monotonic()
    res = sh.build_standard_msh(
        step, solid, project, tmp_path / "geometry.msh",
        scale_to_metres=0.001, sizing=sizing, hex_core=False, layer_specs=specs,
        n_threads=4, log=lines.append,
    )
    # It used to run to the 480 s fill timeout (or crash gmsh) with the extrusion.
    assert time.monotonic() - t0 < 120
    assert res.gmsh_layer_patches == []
    assert res.n_tets > 0 and res.n_prism == 0
    assert any("walls has corners on its rim" in ln for ln in lines), lines
