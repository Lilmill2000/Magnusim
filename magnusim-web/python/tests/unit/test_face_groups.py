"""Mesh imports are grouped into surfaces (Step 2): a CAD-style STL of a pipe has
three faces (wall and two caps), not one per triangle, everywhere a face id is used.
"""
from __future__ import annotations

import struct
from pathlib import Path

import numpy as np
import pytest

from cfddesk.cad import io
from cfddesk.cad import preview as pvw
from cfddesk.cad.face_groups import (
    group_boundary_edges,
    group_properties,
    group_triangles,
    orient_outward,
)


def cad_cylinder(radius: float = 20.0, height: float = 300.0, n: int = 48):
    """Closed cylinder as CAD tools tessellate it: fan caps and one needle strip per segment."""
    ang = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
    ring = np.stack([radius * np.cos(ang), radius * np.sin(ang)], axis=1)
    bottom = np.column_stack([ring, np.zeros(n)])
    top = np.column_stack([ring, np.full(n, height)])
    pts = np.vstack([bottom, top, [[0, 0, 0], [0, 0, height]]])
    cb, ct = 2 * n, 2 * n + 1
    tris = []
    for i in range(n):
        j = (i + 1) % n
        tris += [(i, j, n + j), (i, n + j, n + i)]  # wall strip (outward)
        tris.append((cb, j, i))  # bottom cap (normal -z)
        tris.append((ct, n + i, n + j))  # top cap (normal +z)
    return pts, np.array(tris, dtype=np.int64)


def write_stl(path: Path, pts, tris) -> None:
    with path.open("wb") as fh:
        fh.write(b"\0" * 80 + struct.pack("<I", len(tris)))
        for a, b, c in tris:
            fh.write(struct.pack("<3f", 0, 0, 0))
            for i in (a, b, c):
                fh.write(struct.pack("<3f", *pts[i]))
            fh.write(b"\0\0")


def test_cylinder_groups_into_wall_and_two_caps():
    pts, tris = cad_cylinder()
    groups = group_triangles(pts, tris)
    assert groups.max() + 1 == 3
    # Ids follow the first triangle of each surface: wall, bottom, top.
    assert groups[0] == 0 and groups[2] == 1 and groups[3] == 2
    props = group_properties(pts, tris, groups)
    assert [p["planar"] for p in props] == [False, True, True]
    assert props[1]["normal"] == pytest.approx((0, 0, -1), abs=1e-9)
    assert props[2]["normal"] == pytest.approx((0, 0, 1), abs=1e-9)
    polygon = 0.5 * 48 * 20.0**2 * np.sin(2 * np.pi / 48)
    assert props[1]["area"] == pytest.approx(polygon, rel=1e-9)
    assert props[0]["area"] == pytest.approx(48 * 2 * 20.0 * np.sin(np.pi / 48) * 300.0, rel=1e-9)
    # Surface boundaries are the two rims.
    assert len(group_boundary_edges(tris, groups)) == 2 * 48


def test_orientation_is_made_consistent_and_outward():
    pts, tris = cad_cylinder()
    messy = tris[:, ::-1].copy()  # all inward
    messy[::3] = tris[::3]  # and a third flipped back: inconsistent winding
    fixed = orient_outward(pts, messy)
    c = pts[fixed]
    volume = np.einsum("ij,ij->i", c[:, 0], np.cross(c[:, 1], c[:, 2])).sum() / 6.0
    assert volume > 0
    # Consistent winding groups the same way as the clean mesh.
    assert group_triangles(pts, fixed).max() + 1 == 3


def test_zero_area_sliver_joins_a_neighbour():
    pts, tris = cad_cylinder()
    # Wall triangle (a, b, c) on rim edge (a, b): put a point on that edge and a
    # zero-area triangle (a, b, mid) between the wall and the cap. Still closed.
    a, b, c = tris[0]
    mid = len(pts)
    pts = np.vstack([pts, 0.5 * (pts[a] + pts[b])])
    tris = np.vstack([[[a, mid, c], [mid, b, c], [a, b, mid]], tris[1:]])
    from cfddesk.cad.face_groups import _edge_pairs

    assert len(_edge_pairs(tris)[0]) * 2 == 3 * len(tris)  # every edge shared by two
    groups = group_triangles(pts, tris)
    assert groups.max() + 1 == 3
    cap = next(k for k, t in enumerate(tris.tolist()) if 2 * 48 in t)
    # The sliver is not a face of its own: it joined the wall or the bottom cap.
    assert groups[2] in (groups[0], groups[cap])


def test_stl_import_preview_and_load_step_use_the_surfaces(tmp_path):
    from cfddesk.cad.step import load_step, tessellate_faces

    pts, tris = cad_cylinder()
    stl = tmp_path / "pipe.stl"
    write_stl(stl, pts, tris)
    loaded = io.load_cad(stl, length_unit="mm")
    assert loaded.n_faces == 3 and not loaded.unified
    step = tmp_path / "geom" / "source.step"
    assert io.write_geometry(loaded, step)  # deferred STEP
    assert io.read_triangle_sidecar(step)[2] is not None

    meta = pvw.export_preview(step, tmp_path / "e.vtp", tmp_path / "f.vtp", tmp_path / "m.json")
    assert meta["n_faces"] == 3
    assert [f["surface_type"] for f in meta["faces"]] == ["Mesh", "Plane", "Plane"]
    import pyvista as pv

    faces = pv.read(str(tmp_path / "f.vtp"))
    assert sorted(np.unique(faces["faceId"]).tolist()) == [1, 2, 3]
    assert meta["n_edge_polylines"] == 2 * 48  # the two rims, not every strip edge

    # faces[] rewritten from the sidecar agrees with the preview.
    again = pvw.write_faces_into_meta(step, tmp_path / "m.json")
    assert [f["id"] for f in again["faces"]] == [1, 2, 3]

    solid = load_step(step)
    assert [f.face_id for f in solid.faces] == [0, 1, 2]
    assert [f.surface_type for f in solid.faces] == ["Mesh", "Plane", "Plane"]
    assert solid.volumes[0].face_ids == (0, 1, 2)
    pts_t, tris_t, fids = tessellate_faces(solid)
    assert len(tris_t) == len(tris) and set(fids.tolist()) == {0, 1, 2}

    # The CAD face kept for a flat cap has the cap's outward normal.
    from cfddesk.cad.normals import face_outward_normal

    assert face_outward_normal(solid.faces[2].face) == pytest.approx((0, 0, 1), abs=1e-9)


def test_open_mesh_still_sews_and_is_not_grouped(tmp_path):
    pts, tris = cad_cylinder()
    stl = tmp_path / "open.stl"
    keep = np.array([t for t in tris if 2 * 48 + 1 not in t.tolist()])  # no top cap
    write_stl(stl, pts, keep)
    loaded = io.load_cad(stl, length_unit="mm")
    assert loaded.groups is None and loaded.triangles is None
