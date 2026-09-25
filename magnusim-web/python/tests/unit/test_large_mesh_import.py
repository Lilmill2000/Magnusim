"""Large faceted imports stay fast and correct (Phase 7 follow-up).

A closed 12,288-triangle sphere exercises: the triangle-sidecar preview, binary
VTP, grouping into one smooth surface, linear-time volume enumeration, units
before the deferred STEP, and the BREP handoff to gmsh.
"""
from __future__ import annotations

import shutil
import struct
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest

from cfddesk.cad import io
from cfddesk.cad import preview as pvw


def _sphere(radius: float = 50.0, subdiv: int = 5):
    """Icosphere: closed, consistently outward, 20 * 4**subdiv triangles."""
    t = (1 + 5 ** 0.5) / 2
    v = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
         (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    f = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6),
         (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10),
         (8, 6, 7), (9, 8, 1)]
    pts = [np.array(p, dtype=float) / np.linalg.norm(p) for p in v]
    def mid(cache: dict[tuple[int, int], int], a: int, b: int) -> int:
        key = (min(a, b), max(a, b))
        if key not in cache:
            m = pts[a] + pts[b]
            pts.append(m / np.linalg.norm(m))
            cache[key] = len(pts) - 1
        return cache[key]

    for _ in range(subdiv):
        cache: dict[tuple[int, int], int] = {}
        nf = []
        for a, b, c in f:
            ab, bc, ca = mid(cache, a, b), mid(cache, b, c), mid(cache, c, a)
            nf += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        f = nf
    return np.array(pts) * radius, np.array(f)


def _write_stl(path: Path, pts, tris) -> None:
    with path.open("wb") as fh:
        fh.write(b"\0" * 80 + struct.pack("<I", len(tris)))
        for a, b, c in tris:
            fh.write(struct.pack("<3f", 0, 0, 0))
            for i in (a, b, c):
                fh.write(struct.pack("<3f", *pts[i]))
            fh.write(b"\0\0")


@pytest.fixture(scope="module")
def sphere_import(tmp_path_factory):
    d = tmp_path_factory.mktemp("sphere")
    stl = d / "sphere.stl"
    _write_stl(stl, *_sphere())
    loaded = io.load_cad(stl)
    step = d / "geom" / "source.step"
    deferred = io.write_geometry(loaded, step)
    return loaded, step, deferred


def test_large_closed_mesh_keeps_its_triangles_and_defers_the_step(sphere_import):
    loaded, step, deferred = sphere_import
    # One smooth surface: every fold between neighbours is far below 30 degrees.
    assert loaded.n_faces == 1
    assert len(loaded.triangles[1]) == 20 * 4**5 and set(loaded.groups.tolist()) == {0}
    assert not loaded.unified
    assert deferred and not step.exists()
    assert io.step_sidecar_path(step).is_file() and io.triangle_sidecar_path(step).is_file()
    assert io.read_triangle_sidecar(step) is not None


def test_triangle_preview_matches_the_occ_preview(sphere_import, tmp_path):
    import pyvista as pv

    _loaded, step, _ = sphere_import
    fast = pvw.export_preview(step, tmp_path / "e.vtp", tmp_path / "f.vtp", tmp_path / "m.json")
    assert fast["display"] == "mesh-triangles"
    assert fast["n_faces"] == 1 and fast["faces"][0]["surface_type"] == "Mesh"
    shape = io.read_step_shape(step)
    # Force the OCC path by hiding the triangle sidecar.
    tris = io.triangle_sidecar_path(step)
    held = tris.with_suffix(".held")
    tris.rename(held)
    try:
        full = pvw.export_preview(step, tmp_path / "e2.vtp", tmp_path / "f2.vtp", tmp_path / "m2.json", shape=shape)
    finally:
        held.rename(tris)
    # The OCC path sees one face per triangle; the grouped preview one surface of them.
    assert full["n_faces"] == fast["n_display_tris"] == 20 * 4**5
    for k in fast["bounds"]:
        assert fast["bounds"][k] == pytest.approx(full["bounds"][k], abs=1e-6)
    total = sum(f["area"] for f in full["faces"])
    assert fast["faces"][0]["area"] == pytest.approx(total, rel=1e-9)
    assert fast["faces"][0]["centroid"] == pytest.approx([0.0, 0.0, 0.0], abs=1e-6)
    assert fast["center_of_mass"] == pytest.approx(full["center_of_mass"], abs=1e-3)

    faces = pv.read(str(tmp_path / "f.vtp"))
    assert faces.n_cells == fast["n_display_tris"]
    assert set(np.unique(faces["faceId"]).tolist()) == {1}
    # A closed smooth surface has no boundary: no edges drawn, not all 18k.
    assert fast["n_edge_polylines"] == 0


def test_volume_enumeration_is_linear_on_many_faces(sphere_import):
    from cfddesk.cad.step import load_step

    _loaded, step, _ = sphere_import
    t = time.time()
    solid = load_step(step)  # uses the sidecar; the STEP is still pending
    assert time.time() - t < 20
    assert len(solid.volumes) == 1 and len(solid.volumes[0].face_ids) == len(solid.faces)
    # Units resolve before the background STEP exists (imports are in mm).
    assert solid.units.proposed_scale_to_metres == pytest.approx(0.001)
    assert not solid.units.ambiguous


def test_gmsh_gets_a_brep_of_the_loaded_solid(sphere_import, tmp_path):
    import gmsh

    from cfddesk.cad.step import load_step
    from cfddesk.mesh.gmsh_standard import initialize_gmsh, write_gmsh_brep

    _loaded, step, _ = sphere_import
    solid = load_step(step)
    brep = write_gmsh_brep(solid.shape, tmp_path / "geometry.brep", scale_to_metres=0.001)
    initialize_gmsh(gmsh, interruptible=False)
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.occ.importShapes(str(brep))
        gmsh.model.occ.synchronize()
        # The BREP is the per-triangle CAD solid (the mesher meshes the surfaces instead).
        assert len(gmsh.model.getEntities(2)) == len(solid.mesh_triangles[1])
        x0, y0, z0, x1, y1, z1 = gmsh.model.getBoundingBox(-1, -1)
        assert x1 - x0 == pytest.approx(0.1, abs=1e-3)  # 100 mm sphere, in metres
    finally:
        gmsh.finalize()
    # gmsh must not leave the process unable to launch PATH tools.
    if shutil.which("node"):
        subprocess.run(["node", "-v"], capture_output=True, check=True)


def test_deferred_step_units_and_writer(sphere_import):
    from cfddesk.cad.units import parse_step_header_units

    _loaded, step, _ = sphere_import
    labels, geometric, _notes = parse_step_header_units(step)
    assert geometric == "MM" and labels
    io.write_deferred_step(step)
    labels2, geometric2, _ = parse_step_header_units(step)
    assert geometric2 == "MM"
    # The written STEP keeps the sidecar and triangle sidecar current.
    assert io.read_triangle_sidecar(step) is not None
