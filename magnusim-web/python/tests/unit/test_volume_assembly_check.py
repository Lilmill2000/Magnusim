"""Standard mesh volume check: assembly errors raise, chord error on a coarse surface does not."""
from __future__ import annotations

import numpy as np
import pytest

from cfddesk.mesh import standard_hexcore as sh

# Unit cube, gmsh hex node order: bottom 0-3, top 4-7.
CUBE = np.array(
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    dtype=float,
)
HEX = np.array([[0, 1, 2, 3, 4, 5, 6, 7]], dtype=np.int64)
# Six tets round the 0-6 diagonal fill the same cube.
KUHN = np.array(
    [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]],
    dtype=np.int64,
)
NONE4, NONE5, NONE8 = (np.zeros((0, n), np.int64) for n in (4, 5, 8))


def _tet_boundary(cells: np.ndarray) -> np.ndarray:
    """Tet faces used once (the closed boundary), in arbitrary orientation."""
    faces: dict[tuple[int, ...], list[list[int]]] = {}
    for t in cells:
        for f in ((0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)):
            tri = [int(t[i]) for i in f]
            faces.setdefault(tuple(sorted(tri)), []).append(tri)
    return np.array([v[0] for v in faces.values() if len(v) == 1], dtype=np.int64)


def _hex_boundary() -> np.ndarray:
    """The cube's six quads, each split in two triangles as _collect_surface does."""
    quads = sh._CELL_FACES[8]
    return np.array([t for q in quads for t in ((q[0], q[1], q[2]), (q[0], q[2], q[3]))], dtype=np.int64)


def test_consistent_cells_match_their_boundary():
    tris = _tet_boundary(KUHN)
    assert len(tris) == 12
    assert sh.check_volume_assembly(CUBE, tris, KUHN, NONE8, NONE5) < 1e-12
    assert sh.check_volume_assembly(CUBE, _hex_boundary(), NONE4, HEX, NONE5) < 1e-12
    bnd = sh.boundary_enclosed_volume(CUBE, _hex_boundary(), [HEX])
    assert bnd.volume == pytest.approx(1.0)
    assert bnd.orphans == bnd.two_sided == bnd.uncovered == 0


def test_overlapping_core_and_shell_raises():
    # Tets filling the space the hex already occupies: 2 m³ of cells in a 1 m³ boundary.
    with pytest.raises(RuntimeError, match="assembly is inconsistent"):
        sh.check_volume_assembly(CUBE, _hex_boundary(), KUHN, HEX, NONE5)
    # One duplicated shell tet is enough.
    with pytest.raises(RuntimeError, match="volume mismatch"):
        sh.check_volume_assembly(CUBE, _tet_boundary(KUHN), np.vstack([KUHN, KUHN[:1]]), NONE8, NONE5)


def test_missing_region_raises():
    with pytest.raises(RuntimeError, match="assembly is inconsistent"):
        sh.check_volume_assembly(CUBE, _tet_boundary(KUHN), KUHN[1:], NONE8, NONE5)


def test_prism_volume_is_exact_with_bilinear_sides():
    # A bilinear quad halves the tet between its two diagonal splits, so the
    # exact volume is the mean of the two opposite tet decompositions.
    pts = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0.1, 0, 1], [1, 0.3, 1.2], [0, 1.1, 0.9]])
    a, b, c, d, e, f = (pts[[i]] for i in range(6))
    tv = sh._tet_vol
    split1 = float((tv(a, b, c, d) + tv(b, c, d, e) + tv(c, d, e, f))[0])
    split2 = float((tv(a, b, c, f) + tv(a, b, f, e) + tv(a, e, f, d))[0])
    assert abs(split1 - split2) > 0.05  # twisted enough to tell the splits apart
    assert sh._prism_volume(pts, np.array([[0, 1, 2, 3, 4, 5]])) == pytest.approx(0.5 * (split1 + split2), rel=1e-12)


def _pipe(tmp_path):
    ocp = pytest.importorskip("OCP.BRepPrimAPI")
    from generate_standard import _add_default_walls

    from cfddesk.cad.io import write_step
    from cfddesk.cad.step import load_step
    from cfddesk.project.model import Project

    step = tmp_path / "pipe.step"
    write_step(ocp.BRepPrimAPI_MakeCylinder(20.0, 300.0).Shape(), step)
    solid = load_step(step)
    project = Project.from_solid(solid, scale_to_metres=0.001, units_confirmed=True)
    project = _add_default_walls(project, list(range(len(solid.faces))))
    return step, solid, project


def test_coarse_pipe_passes_despite_chord_error(tmp_path, monkeypatch):
    """Fineness 2: ~30 segments round a 20 mm pipe lose ~0.6% to chord error. Generate still works."""
    step, solid, project = _pipe(tmp_path)
    sizing = sh.StandardSizing.automatic((0.04, 0.04, 0.3), fineness=2)
    seen: dict = {}
    real = sh.check_volume_assembly

    def spy(pts, tris, tets, hexes, pyrs, prisms=None, **kw):
        seen.update(pts=pts, tris=tris, tets=tets, hexes=hexes, pyrs=pyrs)
        return real(pts, tris, tets, hexes, pyrs, prisms, **kw)

    monkeypatch.setattr(sh, "check_volume_assembly", spy)
    for hex_core in (False, True):
        lines: list[str] = []
        res = sh.build_standard_msh(
            step, solid, project, tmp_path / f"core{int(hex_core)}" / "geometry.msh",
            scale_to_metres=0.001, sizing=sizing, hex_core=hex_core, n_threads=4, log=lines.append,
        )
        assert res.hex_core_applied == hex_core
        assert res.msh_path.is_file()
        # The CAD comparison sees the chord loss (the old check raised above 5e-3)...
        assert res.volume_error_rel is not None and 5e-3 < res.volume_error_rel < 2e-2
        assert any(ln.startswith("note: mesh volume is") for ln in lines)
        # ...but the cells fill their own boundary to round-off.
        assert res.assembly_error_rel is not None and res.assembly_error_rel < 1e-9

    # Break the hex core / shell assembly of that real mesh: both must raise.
    pts, tris, tets, hexes, pyrs = (seen[k] for k in ("pts", "tris", "tets", "hexes", "pyrs"))
    assert len(hexes) > 0 and len(tets) > 0
    with pytest.raises(RuntimeError, match="assembly is inconsistent"):
        real(pts, tris, tets, NONE8, pyrs)  # core missing
    with pytest.raises(RuntimeError, match="assembly is inconsistent"):
        real(pts, tris, tets, np.vstack([hexes, hexes[: max(1, len(hexes) // 10)]]), pyrs)  # overlap
