"""CAD-style needle triangles are refined before gmsh parametrizes them (Step 2)."""
from __future__ import annotations

import numpy as np
import pytest

from cfddesk.cad.face_groups import group_triangles, triangle_normals
from cfddesk.mesh.stl_refine import _edges, refine_for_parametrization, triangle_gamma
from tests.unit.test_face_groups import cad_cylinder, write_stl


def _closed(tris) -> bool:
    edges, slot = _edges(np.asarray(tris))
    return bool((np.bincount(slot.ravel(), minlength=len(edges)) == 2).all())


def _volume(pts, tris) -> float:
    c = np.asarray(pts)[np.asarray(tris)]
    return float(np.einsum("ij,ij->i", c[:, 0], np.cross(c[:, 1], c[:, 2])).sum() / 6.0)


def test_flat_needle_strip_becomes_well_shaped():
    pts = np.array([[0, 0, 0], [100, 0, 0], [100, 1, 0], [0, 1, 0]], dtype=float)
    tris = np.array([[0, 1, 2], [0, 2, 3]])
    assert triangle_gamma(pts, tris).min() < 0.05
    p2, t2, g2 = refine_for_parametrization(pts, tris, np.zeros(2, dtype=np.int64), 1.0)
    gamma = triangle_gamma(p2, t2)
    assert gamma.min() > 0.4 and np.median(gamma) > 0.8
    _n, area = triangle_normals(p2, t2)
    assert area.sum() == pytest.approx(100.0, rel=1e-9)
    assert np.allclose(p2[:, 2], 0.0)  # stays in the plane
    # Not a blow-up: about (length / L) * (width / L) * 2 triangles, within a small factor.
    assert len(t2) < 2000


def test_cylinder_refines_closed_on_the_same_facets_and_surfaces():
    pts, tris = cad_cylinder()
    groups = group_triangles(pts, tris)
    p2, t2, g2 = refine_for_parametrization(pts, tris, groups, 10.0)
    assert _closed(t2)
    assert _volume(p2, t2) == pytest.approx(_volume(pts, tris), rel=1e-6)
    _n0, a0 = triangle_normals(pts, tris)
    _n1, a1 = triangle_normals(p2, t2)
    for g in range(3):
        assert a1[g2 == g].sum() == pytest.approx(a0[groups == g].sum(), rel=1e-6)
    # Every refined point lies on the original cylinder (radius 20) or a cap plane.
    r = np.hypot(p2[:, 0], p2[:, 1])
    on_wall = np.isclose(r, 20.0 * np.cos(np.pi / 48), atol=0.2) | np.isclose(r, 20.0, atol=1e-9)
    on_cap = np.isclose(p2[:, 2], 0.0) | np.isclose(p2[:, 2], 300.0)
    assert (on_wall | on_cap).all()
    # The 300 x 2.6 mm wall strips were needles; now they are not.
    wall = g2 == 0
    assert np.percentile(triangle_gamma(pts, tris)[groups == 0], 50) < 0.05
    assert np.percentile(triangle_gamma(p2, t2)[wall], 5) > 0.2


def test_standard_mesh_of_a_faceted_stl_uses_discrete_surfaces(tmp_path):
    """Host side of Generate on a CAD-style STL: surfaces, patches and a valid volume."""
    from generate_standard import _add_default_walls, _apply_web_bcs

    from cfddesk.cad import io
    from cfddesk.cad.step import load_step
    from cfddesk.mesh.gmsh_standard import emitted_patch_types
    from cfddesk.mesh.standard_hexcore import StandardSizing, build_standard_msh
    from cfddesk.mesh.web_refinements import leftover_faces
    from cfddesk.project.model import Project

    pts, tris = cad_cylinder()
    stl = tmp_path / "pipe.stl"
    write_stl(stl, pts, tris)
    step = tmp_path / "g" / "source.step"
    io.write_geometry(io.load_cad(stl, length_unit="mm"), step)
    solid = load_step(step)
    project = Project.from_solid(solid, scale_to_metres=0.001, units_confirmed=True)
    web = [
        {"id": "in", "name": "Inlet", "type": "velocity_inlet", "faces": ["face 2@Body1"], "settings": {"speed_m_s": 1}},
        {"id": "out", "name": "Outlet", "type": "pressure_outlet", "faces": ["face 3@Body1"], "settings": {}},
    ]
    project = _apply_web_bcs(project, web, len(solid.faces))
    project = _add_default_walls(project, leftover_faces(project, len(solid.faces)))
    # Fineness 5: at 2 the ~30 segments round a 20 mm pipe lose >0.5% volume to
    # chord error and the volume check trips (same for a STEP cylinder).
    sizing = StandardSizing.automatic((0.04, 0.04, 0.3), fineness=5)
    lines: list[str] = []
    for hex_core in (True, False):
        res = build_standard_msh(
            step, solid, project, tmp_path / f"core{int(hex_core)}" / "geometry.msh",
            scale_to_metres=0.001, sizing=sizing, hex_core=hex_core, n_threads=4, log=lines.append,
        )
        assert sorted(res.patch_names) == sorted(emitted_patch_types(project)) == ["inlet", "outlet", "walls"]
        assert res.n_tets > 0
        assert res.hex_core_applied == hex_core
    assert any("discrete surfaces" in ln for ln in lines)
    assert any("refined for parametrization" in ln for ln in lines)
    assert any("physics-based: 1 inlet + 1 outlet" in ln for ln in lines)
    vol = [ln for ln in lines if ln.startswith("volume check")]
    assert vol and all(float(ln.rsplit("rel err ", 1)[1].rstrip(")")) < 5e-3 for ln in vol)


def test_small_surfaces_join_a_neighbour_on_the_same_patch_only():
    from cfddesk.mesh.gmsh_standard import _suppress_small_surfaces

    pts, tris = cad_cylinder()
    groups = group_triangles(pts, tris).astype(np.int64)
    # Make one bottom-cap triangle a surface of its own (a 1-facet "feature").
    cap = int(np.nonzero(groups == 1)[0][0])
    groups[cap] = 3
    tiny = float(np.sqrt(triangle_normals(pts, tris[[cap]])[1][0])) * 2
    walls = {0: "walls", 1: "walls", 2: "walls", 3: "walls"}
    out, merged = _suppress_small_surfaces(pts, tris, groups, walls, tiny)
    assert merged == {3: 1} and out[cap] == 1  # joins the rest of the cap
    # A small face with its own boundary condition stays a surface.
    own = {0: "walls", 1: "walls", 2: "walls", 3: "inlet"}
    out, merged = _suppress_small_surfaces(pts, tris, groups, own, tiny)
    assert merged == {} and out[cap] == 3
