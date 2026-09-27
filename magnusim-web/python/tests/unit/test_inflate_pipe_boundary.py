"""Inflate layers (hex core off): the written boundary is the cells' boundary, patched as on the CAD."""
from __future__ import annotations

import numpy as np
import pytest

from cfddesk.mesh import standard_hexcore as sh

R_M = 0.020


def _inflate_pipe(tmp_path, fineness: int):
    ocp = pytest.importorskip("OCP.BRepPrimAPI")
    from generate_standard import _add_default_walls, _apply_web_bcs

    from cfddesk.cad.io import write_step
    from cfddesk.cad.step import load_step
    from cfddesk.mesh.web_refinements import leftover_faces
    from cfddesk.project.model import Project

    step = tmp_path / "pipe.step"
    write_step(ocp.BRepPrimAPI_MakeCylinder(20.0, 300.0).Shape(), step)
    solid = load_step(step)
    project = Project.from_solid(solid, scale_to_metres=0.001, units_confirmed=True)
    web = [
        {"id": "in", "name": "Inlet", "type": "velocity_inlet", "faces": ["face 2@Body1"], "settings": {"speed_m_s": 1}},
        {"id": "out", "name": "Outlet", "type": "pressure_outlet", "faces": ["face 3@Body1"], "settings": {}},
    ]
    project = _apply_web_bcs(project, web, len(solid.faces))
    project = _add_default_walls(project, leftover_faces(project, len(solid.faces)))
    sizing = sh.StandardSizing.automatic((0.04, 0.04, 0.3), fineness=fineness)
    specs = [sh.LayerPatchSpec(name="walls", n_layers=3, thickness_m=0.002, expansion=1.2, honor_absolute=True)]
    return step, solid, project, sizing, specs


def _uncovered_cell_faces(tris: np.ndarray, cells: list[np.ndarray]) -> int:
    """Cell faces used once that no boundary triangle writes (gmshToFoam defaultFaces)."""
    faces: dict[tuple[int, ...], list] = {}
    for arr in cells:
        for f in sh._CELL_FACES[arr.shape[1]]:
            for row in arr[:, list(f)].tolist():
                faces.setdefault(tuple(sorted(row)), []).append(row)
    written = {tuple(t) for t in np.sort(tris, axis=1).tolist()}

    def covered(row: list[int]) -> bool:
        if len(row) == 3:
            return tuple(sorted(row)) in written
        a, b, c, d = row  # a quad is written as two triangles, either diagonal
        return any(
            tuple(sorted(s)) in written and tuple(sorted(t)) in written
            for s, t in (((a, b, c), (a, c, d)), ((a, b, d), (b, c, d)))
        )

    return sum(1 for rows in faces.values() if len(rows) == 1 and not covered(rows[0]))


@pytest.mark.parametrize("fineness", [2, 5])
def test_inflate_pipe_boundary_is_closed_and_patched(tmp_path, monkeypatch, fineness):
    step, solid, project, sizing, specs = _inflate_pipe(tmp_path, fineness)
    seen: dict = {}
    real = sh._write_msh2

    def spy(path, nodes, *, blocks, physical_names):
        seen.update(nodes=nodes, blocks=blocks, names=physical_names)
        return real(path, nodes, blocks=blocks, physical_names=physical_names)

    monkeypatch.setattr(sh, "_write_msh2", spy)
    lines: list[str] = []
    res = sh.build_standard_msh(
        step, solid, project, tmp_path / "geometry.msh",
        scale_to_metres=0.001, sizing=sizing, hex_core=False, layer_specs=specs,
        n_threads=4, log=lines.append,
    )
    assert res.n_prism > 0 and res.gmsh_layer_patches == ["walls"]
    asm = [ln for ln in lines if ln.startswith("volume assembly:")]
    assert asm and "rel err" in asm[0]
    # Inlet/outlet tets beside the stack stay patched; the seam's prism side is interior.
    assert not any("defaultFaces" in ln for ln in asm), asm
    assert not any("cells on both sides" in ln for ln in asm), asm

    pts = np.asarray(seen["nodes"], dtype=float)
    by_type = {int(et): (np.asarray(conn), phys) for et, conn, phys in seen["blocks"]}
    tris, tri_phys = by_type[sh.TRI]
    tri_phys = np.asarray(tri_phys)
    cells = [by_type[t][0] for t in (sh.TET, sh.PRISM) if len(by_type[t][0])]
    assert _uncovered_cell_faces(tris, cells) == 0
    bnd = sh.boundary_enclosed_volume(pts, tris, cells)
    assert bnd.two_sided == bnd.orphans == 0

    phys_of = {name: tag for tag, (dim, name) in seen["names"].items() if dim == 2}
    for patch in ("inlet", "outlet"):
        pt = tris[tri_phys == phys_of[patch]]
        a, b, c = (pts[pt[:, k]] for k in range(3))
        # gmsh tilts the layer normals at the rim, so the stack's end-face
        # nodes sit a little off the end plane: 0.07-0.09 mm on Windows and
        # 0.11 mm on Linux at fineness 2 (same gmsh version, different builds).
        # Allow a tenth of the 2 mm stack, then measure in that plane.
        assert np.ptp(pts[pt.ravel(), 2]) < 0.1 * specs[0].thickness_m
        area = float(0.5 * np.abs(np.cross(b - a, c - a)[:, 2]).sum())
        # Rim of the patch (edges used once): the pipe's own circle, r = 20 mm,
        # not the 18 mm stack cap, and no hole inside.
        edges: dict[tuple[int, int], int] = {}
        for t in np.sort(pt, axis=1).tolist():
            for e in ((t[0], t[1]), (t[0], t[2]), (t[1], t[2])):
                edges[e] = edges.get(e, 0) + 1
        rim = np.unique([n for e, k in edges.items() if k == 1 for n in e])
        r = np.hypot(pts[rim, 0], pts[rim, 1])
        assert np.allclose(r, R_M, rtol=0, atol=1e-7), (patch, r.min(), r.max())
        # π·r² less the chord error: the polygon inscribed through the rim nodes.
        theta = np.sort(np.arctan2(pts[rim, 1], pts[rim, 0]))
        dtheta = np.diff(np.append(theta, theta[0] + 2.0 * np.pi))
        polygon = float(0.5 * R_M**2 * np.sin(dtheta).sum())
        assert area == pytest.approx(polygon, rel=1e-9), patch
        assert polygon == pytest.approx(np.pi * R_M**2, rel=1e-2)
