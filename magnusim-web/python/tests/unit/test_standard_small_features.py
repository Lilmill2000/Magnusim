"""Standard mesher: small feature suppression must not open the surface, and a
volume fill that fails is tried again another way.

The part that showed it: a perforated plate whose louver tabs sit 0.188 mm off
the slot ends (1/8 in plate, 6,534 faces). gmsh's healShapes, asked to remove
edges under 1.5 mm, repaired each face on its own and left 7,040 CAD edges on
one face only. The surface mesh then had two nodes at one point and the volume
fill stopped with "PLC Error: A vertex lies in a segment". ``_tabs_part`` is a
small copy of that feature: a 3.175 mm plate across a box with two 1.524 mm
tabs beside its slots, each 0.188 mm short of the slot end. On it the old code
failed too (HXT crashed reading the open surface).
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.occt

T_PLATE = 3.175  # mm
T_TAB = 1.524
STEP_OFF = 0.188
SFS_M = 0.0015  # small feature suppression the failing run used (1.5 mm)


def _box(x0, y0, z0, x1, y1, z1):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeBox(gp_Pnt(x0, y0, z0), gp_Pnt(x1, y1, z1)).Shape()


def _tabs_fluid():
    """A 80 mm box of fluid around a plate with two slots. Under each, a tab hangs
    from the plate; its side continues the slot wall, and its end stops 0.188 mm
    short of the slot end, so the wall has 0.188 mm steps."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse

    plate = _box(-40, -40, 0, 40, 40, T_PLATE)
    for y in (-20.0, 20.0):
        plate = BRepAlgoAPI_Cut(plate, _box(-15, y, -1, 15, y + T_TAB, T_PLATE + 1)).Shape()
        plate = BRepAlgoAPI_Fuse(plate, _box(-15 + STEP_OFF, y - T_TAB, -15, 15, y, 0)).Shape()
    return BRepAlgoAPI_Cut(_box(-40, -40, -40, 40, 40, 40), plate).Shape()


def _tabs_part(tmp_path):
    pytest.importorskip("OCP.BRepPrimAPI")
    from generate_standard import _add_default_walls

    from cfddesk.cad.io import write_step
    from cfddesk.cad.step import load_step
    from cfddesk.project.model import Project

    step = tmp_path / "source.step"
    write_step(_tabs_fluid(), step)
    solid = load_step(step)
    project = Project.from_solid(solid, scale_to_metres=0.001, units_confirmed=True)
    project = _add_default_walls(project, list(range(len(solid.faces))))
    return step, solid, project


def _build(tmp_path, name: str, *, lines: list[str], hex_core: bool = True, sfs: float = SFS_M):
    from cfddesk.mesh import standard_hexcore as sh

    step, solid, project = _tabs_part(tmp_path)
    sizing = sh.StandardSizing.automatic((0.08, 0.08, 0.08), fineness=1, small_feature_m=sfs)
    return sh.build_standard_msh(
        step, solid, project, tmp_path / name / "geometry.msh",
        scale_to_metres=0.001, sizing=sizing, hex_core=hex_core, n_threads=1, log=lines.append,
    )


def test_gmsh_healing_opens_the_tabs_part(tmp_path):
    """The root cause, kept as a check: if a gmsh update fixes healShapes, this says so."""
    import gmsh

    from cfddesk.mesh.gmsh_standard import initialize_gmsh, write_gmsh_brep
    from cfddesk.mesh.heal_cache import open_curve_count

    _step, solid, _project = _tabs_part(tmp_path)
    brep = write_gmsh_brep(solid.shape, tmp_path / "geometry_mm.brep")
    initialize_gmsh(gmsh)
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("Geometry.OCCScaling", 0.001)
        gmsh.model.add("heal")
        gmsh.model.occ.importShapes(str(brep))
        gmsh.model.occ.synchronize()
        assert open_curve_count(gmsh) == 0
        gmsh.model.occ.healShapes(
            gmsh.model.getEntities(3), tolerance=SFS_M, fixDegenerated=True,
            fixSmallEdges=True, fixSmallFaces=True, sewFaces=False, makeSolids=False,
        )
        gmsh.model.occ.synchronize()
        assert open_curve_count(gmsh) > 0
    finally:
        gmsh.finalize()


def test_tabs_part_meshes_with_small_feature_suppression(tmp_path):
    """Before the fix the volume fill failed on the open surface."""
    lines: list[str] = []
    res = _build(tmp_path, "mesh", lines=lines)
    assert res.hex_core_applied and res.n_hex > 0 and res.n_tets > 0
    assert res.volume_fill_note == ""  # HXT filled it the first time
    assert res.assembly_error_rel is not None and res.assembly_error_rel < 1e-9
    assert any("small feature suppression (full)" in ln and "not used" in ln for ln in lines)
    assert "small feature suppression: faces below 0.0015 m suppressed; shorter edges kept (removing them would open the surface)" in lines
    assert not any(ln.startswith("volume fill failed") for ln in lines)


def test_healed_geometry_is_cached_per_geometry(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    monkeypatch.setenv("MAGNUSIM_MESH_GEOMETRY_CACHE", str(cache))
    first: list[str] = []
    a = _build(tmp_path, "a", lines=first)
    assert [p.name.split(".", 1)[1] for p in cache.iterdir()] == ["faces.brep"]
    again: list[str] = []
    b = _build(tmp_path, "b", lines=again)
    assert "small feature suppression: healed geometry reused from an earlier mesh" in again
    assert not any("not used" in ln for ln in again)
    # The first mesh is made from the written geometry too, so both are the same.
    assert (a.n_nodes, a.n_tets, a.n_hex, a.n_pyr, a.n_tris) == (b.n_nodes, b.n_tets, b.n_hex, b.n_pyr, b.n_tris)
    # Another suppression size is another entry.
    _build(tmp_path, "c", lines=[], sfs=0.001)
    assert len(list(cache.glob("*.brep"))) == 2


def test_healing_that_always_opens_is_remembered(tmp_path, monkeypatch):
    from cfddesk.mesh import heal_cache

    cache = tmp_path / "cache"
    monkeypatch.setenv("MAGNUSIM_MESH_GEOMETRY_CACHE", str(cache))
    monkeypatch.setattr(heal_cache, "_HEAL_MODES", heal_cache._HEAL_MODES[:1])  # short-edge repair only
    first: list[str] = []
    res = _build(tmp_path, "a", lines=first)
    assert res.n_tets > 0
    assert any(ln.startswith("small feature suppression skipped: the CAD is meshed as it is") for ln in first)
    assert not any("features below" in ln and ln.endswith("suppressed") for ln in first)
    assert [p.suffix for p in cache.iterdir()] == [".open"]
    again: list[str] = []
    _build(tmp_path, "b", lines=again)
    assert any("found by an earlier mesh" in ln for ln in again)


def test_cache_off_still_heals(tmp_path, monkeypatch):
    monkeypatch.setenv("MAGNUSIM_MESH_GEOMETRY_CACHE", "off")
    lines: list[str] = []
    res = _build(tmp_path, "a", lines=lines)
    assert res.n_hex > 0
    assert any(ln.startswith("small feature suppression: faces below 0.0015 m suppressed") for ln in lines)


def _fail_first_fills(monkeypatch, n_fail: int, seen: list[int]):
    from cfddesk.mesh import standard_hexcore as sh

    real = sh.generate_volume_or_timeout

    def fake(gmsh, **kw):
        algo = int(gmsh.option.getNumber("Mesh.Algorithm3D"))
        seen.append(algo)
        if len(seen) <= n_fail:
            raise Exception(f"HXT 3D mesh failed (test {len(seen)})")
        return real(gmsh, **kw)

    monkeypatch.setattr(sh, "generate_volume_or_timeout", fake)


def test_failed_volume_fill_is_retried_with_delaunay(tmp_path, monkeypatch):
    seen: list[int] = []
    _fail_first_fills(monkeypatch, 1, seen)
    lines: list[str] = []
    res = _build(tmp_path, "mesh", lines=lines)
    assert seen == [10, 1]  # HXT, then Delaunay
    assert res.hex_core_applied and res.n_hex > 0
    assert res.volume_fill_note == "filled with Delaunay after 1 failed attempt(s)"
    assert any(
        ln.startswith("volume fill failed (HXT, hex element core on): HXT 3D mesh failed (test 1)") for ln in lines
    )
    assert res.assembly_error_rel is not None and res.assembly_error_rel < 1e-9


def test_hex_core_is_dropped_when_both_fills_fail(tmp_path, monkeypatch):
    seen: list[int] = []
    _fail_first_fills(monkeypatch, 2, seen)
    res = _build(tmp_path, "mesh", lines=[])
    assert seen == [10, 1, 10]
    assert not res.hex_core_applied and res.n_hex == 0 and res.n_tets > 0
    assert res.hex_core_note == "hex element core skipped: the tet fill around it failed"
    assert res.volume_fill_note == "filled with HXT after 2 failed attempt(s); hex element core dropped"


def test_every_fill_failing_raises_the_first_error(tmp_path, monkeypatch):
    seen: list[int] = []
    _fail_first_fills(monkeypatch, 99, seen)
    with pytest.raises(Exception, match=r"HXT 3D mesh failed \(test 1\)"):
        _build(tmp_path, "mesh", lines=[])
    assert seen == [10, 1, 10, 1]


def test_failure_before_the_volume_fill_is_not_retried(tmp_path, monkeypatch):
    from cfddesk.mesh import standard_hexcore as sh

    calls = []

    def broken(*a, **k):
        calls.append(1)
        raise RuntimeError("gap sizes broke")

    monkeypatch.setattr(sh, "_gap_sizes", broken)
    with pytest.raises(RuntimeError, match="gap sizes broke"):
        _build(tmp_path, "mesh", lines=[])
    assert calls == [1]
