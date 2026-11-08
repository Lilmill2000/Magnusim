"""Plans: the geometry, its faces as the app numbers them, the selectors, and the requests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from magnusim_validation import cases
from magnusim_validation.faces import resolve
from magnusim_validation.geometry import FIXED_STAMP, fix_header_stamp
from magnusim_validation.plan import make_plan

pytestmark = pytest.mark.occt


def _rows():
    def row(i, c, n, st, area=1.0):
        return {"id": i, "body": 1, "area_mm2": area, "centroid_mm": c, "normal": n, "surface_type": st}

    return [
        row(1, [150.0, 0.0, 0.0], [0.0, 0.0, -1.0], "Cylinder", 18849.6),
        row(2, [300.0, 0.0, 0.0], [1.0, 0.0, 0.0], "Plane", 314.2),
        row(3, [0.0, 0.0, 0.0], [-1.0, 0.0, 0.0], "Plane", 314.2),
    ]


def test_selectors_pick_faces_by_what_they_are():
    labels = resolve(_rows(), cases.get("c1").FACE_SELECTORS)
    assert labels == {"inlet": ["face 3@Body1"], "outlet": ["face 2@Body1"], "wall": ["face 1@Body1"]}
    assert resolve(_rows(), {"wall": {"surface_type": "Cylinder"}}) == {"wall": ["face 1@Body1"]}


def test_a_selector_that_finds_another_count_fails_loudly():
    with pytest.raises(ValueError, match="found 0 faces"):
        resolve(_rows(), {"x": {"plane": {"axis": "x", "at_mm": 10.0, "sign": 1}}})
    with pytest.raises(ValueError, match="found 2 faces"):
        resolve(_rows(), {"x": {"rest": True, "count": 1}, "y": {"surface_type": "Cylinder"}})
    with pytest.raises(ValueError, match="another selector"):
        resolve(_rows(), {"a": {"surface_type": "Cylinder"}, "b": {"surface_type": "Cylinder"}})
    with pytest.raises(ValueError, match="unknown"):
        resolve(_rows(), {"a": {"sphere": True}})


def test_the_step_header_time_stamp_is_fixed():
    text = "FILE_NAME('Open CASCADE Shape Model','2026-11-04T13:50:14',('Author'),(\n"
    assert fix_header_stamp(text) == f"FILE_NAME('Open CASCADE Shape Model','{FIXED_STAMP}',('Author'),(\n"
    # The writer numbers its products per process: the number goes too.
    product = "#7 = PRODUCT('Open CASCADE STEP translator 7.9 6',\n  'Open CASCADE STEP translator 7.9 6','',(#8));"
    want = "#7 = PRODUCT('Open CASCADE STEP translator 7.9',\n  'Open CASCADE STEP translator 7.9','',(#8));"
    assert fix_header_stamp(product) == want


@pytest.mark.parametrize("variant", ["hexdominant", "standard"])
def test_case_1_plans_the_same_every_time(tmp_path: Path, variant: str):
    c1 = cases.get("c1")
    a = make_plan(c1, variant, tmp_path / "a", cores=4)
    b = make_plan(c1, variant, tmp_path / "b", cores=4)
    assert a == b
    assert (tmp_path / "a" / "geometry.step").read_bytes() == (tmp_path / "b" / "geometry.step").read_bytes()
    assert json.loads((tmp_path / "a" / "plan.json").read_text(encoding="utf-8")) == a
    # The app's own face table of the pipe: the wall, the outlet, the inlet.
    faces = {f["id"]: f for f in a["geometry"]["faces"]}
    assert faces[1]["surface_type"] == "Cylinder"
    assert faces[2]["centroid_mm"][0] == pytest.approx(300.0) and faces[2]["normal"] == [1.0, 0.0, 0.0]
    assert faces[3]["centroid_mm"][0] == pytest.approx(0.0) and faces[3]["normal"] == [-1.0, 0.0, 0.0]
    assert faces[3]["area_mm2"] == pytest.approx(100 * 3.141592653589793)
    # Every BC's faces are the selectors' labels; the wall is always sent no-slip.
    bcs = {b["name"]: b for b in a["bcs"]}
    assert bcs["Inlet"]["faces"] == ["face 3@Body1"] and bcs["Inlet"]["value"] == 1.0
    assert bcs["Outlet"]["faces"] == ["face 2@Body1"]
    assert bcs["Pipe wall"]["faces"] == ["face 1@Body1"] and bcs["Pipe wall"]["wall_type"] == "No-slip"
    assert a["material"]["kinematic_viscosity"] == pytest.approx(2e-4)
    assert a["run"]["cores"] == 4 and a["run"]["endTime"] == 3000
    assert a["mesh"]["settings"]["fineness"] == 6
    engine = a["mesh"]["settings"]["advanced"]["mesh_engine"]
    if variant == "hexdominant":
        assert engine == "snappy_hexdominant"
        assert a["mesh"]["settings"]["automatic_boundary_layers"] is False
        assert a["mesh"]["refinements"][0]["faces"] == ["face 1@Body1"]
        assert a["study"]["settings"]["n_non_orthogonal"] == 1
    else:
        assert engine == "standard"
        assert a["mesh"]["settings"]["automatic_boundary_layers"] is True
        assert a["mesh"]["refinements"] == []
        assert a["study"]["settings"]["n_non_orthogonal"] == 2
    assert a["mesh"]["expect"]["layers"] is True


def test_a_coarse_plan_is_coarser(tmp_path: Path):
    c1 = cases.get("c1")
    p = make_plan(c1, "hexdominant", tmp_path, coarse=True, cores=2)
    assert p["coarse"] is True
    assert p["mesh"]["settings"]["fineness"] == 4
    assert p["run"]["endTime"] == 750 and p["run"]["cores"] == 2
    with pytest.raises(ValueError):
        make_plan(c1, "polyhedral", tmp_path / "x")


def test_a_hex_dominant_plan_carries_what_its_mesh_will_be(tmp_path: Path):
    c1 = cases.get("c1")
    p = make_plan(c1, "hexdominant", tmp_path, cores=4)
    est = p["mesh"]["estimate"]
    # The mesher's own block: at least 8 cells across y and 12 across z, whatever the fineness
    # (the 15 D pipe at fineness 6 is within 3:1: its cells 5.96 mm along the padded span, 3.33
    # mm across y). Still 1.79 times as long as wide, so its ends sit just outside the pipe's two
    # planes (0.339 mm, end_plane_axes): 5.896 mm along, its wall cells (level 2) 1.474 mm.
    assert est["block"] == [67, 8, 12]
    assert est["walls_level"] == 2
    assert est["base_cell_mm"] == pytest.approx([5.8956, 3.325, 2.2167], abs=1e-3)
    assert est["wall_cell_mm"] == pytest.approx([1.4739, 0.8312, 0.5542], abs=1e-3)
    # An order of magnitude: case 1's real Hex-dominant mesh at fineness 6 had 128 706 cells.
    assert 128_706 <= est["n_cells"] <= 2 * 128_706
    assert est["layers"][0]["stack_over_smallest_cell"] == pytest.approx(1.0 / 0.5542, rel=1e-3)
    assert est["warnings"] == []
    coarse = make_plan(c1, "hexdominant", tmp_path / "c", coarse=True, cores=4)["mesh"]["estimate"]
    # At fineness 4 its 42 cells along (9.5 mm) are within 3 times the 3.33 mm across y: the same
    # counts as before the cap, its ends just outside the pipe's planes (9.409 mm along). Its real
    # coarse mesh had 78 243 cells.
    assert coarse["block"] == [42, 8, 12] and 78_243 <= coarse["n_cells"] <= 2 * 78_243
    assert coarse["base_cell_mm"][0] == pytest.approx(9.4088, abs=1e-3)
    # Standard sizes its own mesh: no estimate.
    assert "estimate" not in make_plan(c1, "standard", tmp_path / "s", cores=4)["mesh"]


def test_a_thick_layer_stack_on_a_thin_wall_cell_is_flagged():
    from magnusim_validation.mesh_plan import estimate

    faces = [{"id": 1, "area_mm2": 50265.0, "normal": [0.0, 0.0, -1.0], "surface_type": "Cylinder"},
             {"id": 2, "area_mm2": 314.2, "normal": [1.0, 0.0, 0.0], "surface_type": "Plane"},
             {"id": 3, "area_mm2": 314.2, "normal": [-1.0, 0.0, 0.0], "surface_type": "Plane"}]
    mesh = {"settings": {"fineness": 7, "physics_based_meshing": True, "advanced": {"mesh_engine": "snappy_hexdominant"}},
            "refinements": [{"name": "Wall layers", "type": "Inflate boundary layer", "faces": ["face 1@Body1"],
                             "n_layers": 2, "total_thickness": 1.7, "total_thickness_unit": "mm"}]}
    # The turbulent pipe of the design: 800 mm long, 20 mm across, at fineness 7.
    est = estimate(mesh, faces, [0.0, 800.0, -10.0, 10.0, -10.0, 10.0], 251_327.0)
    assert est is not None
    # 85 cells along (12.5 mm, 3.76 times the 3.33 mm across y) before the 3:1 cap; 107 with it,
    # the block's ends just outside the pipe's two planes: 9.88 mm each (9.94 over the padded
    # span), so its wall cells (level 3) are 1.235 mm along.
    assert est["block"] == [107, 8, 12]
    assert est["wall_cell_mm"] == pytest.approx([1.2354, 0.4156, 0.2771], abs=1e-3)
    assert est["warnings"] and "6.135 times the smallest wall cell" in est["warnings"][0]


def test_case_2s_hex_dominant_plan_has_the_meshers_cells(tmp_path: Path):
    """Case 2's 30 D pipe at fineness 6: the cap's 80 cells along (67 before it), the block's
    ends 0.567 mm outside the inlet's and outlet's planes, so its cells are 9.855 mm along, not
    the 9.975 of the padded span, and its wall cells (level 2) 2.464 mm."""
    for variant in ("hexdominant_sst", "hexdominant_kepsilon"):
        est = make_plan(cases.get("c2"), variant, tmp_path / variant, cores=8)["mesh"]["estimate"]
        assert est["block"] == [80, 8, 12]
        assert est["base_cell_mm"] == pytest.approx([9.8546, 3.325, 2.2167], abs=1e-3)
        assert est["wall_cell_mm"] == pytest.approx([2.4637, 0.8312, 0.5542], abs=1e-3)


def test_a_custom_size_becomes_a_level_of_the_diagonal_base_size():
    from magnusim_validation.mesh_plan import estimate

    faces = [{"id": 1, "area_mm2": 10_000.0, "normal": [0.0, -1.0, 0.0], "surface_type": "Plane"},
             {"id": 2, "area_mm2": 10_000.0, "normal": [0.0, 1.0, 0.0], "surface_type": "Plane"}]
    mesh = {"settings": {"fineness": 6, "advanced": {"mesh_engine": "snappy_hexdominant"}},
            "refinements": [{"name": "Floor", "type": "Surface custom sizing", "faces": ["face 1@Body1"],
                             "default_size": 0.147, "default_size_unit": "mm"}]}
    est = estimate(mesh, faces, [0.0, 400.0, 0.0, 10.0, 0.0, 51.0], 204_000.0)
    assert est is not None
    custom = est["custom_sizes"][0]
    # The level comes from the diagonal's base size; the cells it gives are finer than asked on the thin axis.
    assert custom["level"] == 6
    assert custom["cell_mm"][1] < 0.147 / 2
    assert est["n_cells"] > 1_000_000


def test_a_refine_out_to_counts_its_band_out_to_the_distance():
    """A custom size with a Refine out to (gap G4): its band's cells out to the distance, at its
    level, in place of its faces' three cells; the plan says how far it reaches."""
    import math

    from magnusim_validation.mesh_plan import estimate

    # A sphere of 10 mm in a box 280 x 160 x 160 mm (case 6's), its face sized 0.5 mm.
    faces = [{"id": 1, "area_mm2": math.pi * 100.0, "normal": None, "surface_type": "Sphere"},
             *({"id": i, "area_mm2": 25_600.0, "normal": [1.0, 0.0, 0.0], "surface_type": "Plane"} for i in (2, 3)),
             *({"id": i, "area_mm2": 44_800.0, "normal": [0.0, 1.0, 0.0], "surface_type": "Plane"} for i in (4, 5, 6, 7))]
    bounds = [-80.0, 200.0, -80.0, 80.0, -80.0, 80.0]
    volume = 280.0 * 160.0 * 160.0 - math.pi * 1000.0 / 6.0

    def mesh(**reach):
        return {"settings": {"fineness": 3, "advanced": {"mesh_engine": "snappy_hexdominant"}},
                "refinements": [{"name": "Wake", "type": "Surface custom sizing", "faces": ["face 1@Body1"],
                                 "default_size": 0.5, "default_size_unit": "mm", **reach}]}

    plain = estimate(mesh(), faces, bounds, volume)
    near = estimate(mesh(reach=15, reach_unit="mm"), faces, bounds, volume)
    assert plain is not None and near is not None
    assert "distance_mm" not in plain["custom_sizes"][0]
    custom = near["custom_sizes"][0]
    assert (custom["reach_mm"], custom["distance_mm"]) == (pytest.approx(15.0), pytest.approx(15.0))
    # The band around the sphere (radius 5 mm) out to 15 mm: (20^3 - 5^3) 4/3 pi of the level's cells.
    cell = custom["cell_mm"]
    band = (20.0**3 - 5.0**3) * 4.0 / 3.0 * math.pi / (cell[0] * cell[1] * cell[2])
    assert near["n_cells"] - plain["n_cells"] == pytest.approx(band, rel=0.05, abs=2_000)
    # A distance within the default band changes nothing.
    short = estimate(mesh(reach=1, reach_unit="mm"), faces, bounds, volume)
    assert short is not None and short["n_cells"] == plain["n_cells"]
    assert short["custom_sizes"][0]["distance_mm"] == pytest.approx(1.5)


def test_mesh_settings_given_by_hand_are_merged_recorded_and_kept_out_of_results(tmp_path: Path):
    from magnusim_validation.__main__ import _run_dir
    from magnusim_validation.paths import RESULTS, RESULTS_COARSE, RESULTS_PROBE

    c1 = cases.get("c1")
    p = make_plan(c1, "standard", tmp_path, cores=4, mesh_settings={"hex_element_core": False, "advanced": {"x": 1}})
    assert p["mesh"]["settings"]["hex_element_core"] is False
    assert p["mesh"]["settings"]["advanced"] == {"mesh_engine": "standard", "x": 1}
    assert p["overrides"] == {"mesh_settings": {"hex_element_core": False, "advanced": {"x": 1}}}
    assert p["mesh"]["expect"]["layers"] is True
    study = make_plan(c1, "standard", tmp_path / "st", cores=4, study_settings={"grad_limiter": "none"})
    assert study["study"]["settings"]["grad_limiter"] == "none"
    assert study["study"]["settings"]["numerics_preset"] == "accurate"
    assert study["overrides"] == {"study_settings": {"grad_limiter": "none"}}
    # Layers turned off by hand: the probe expects none.
    off = make_plan(c1, "standard", tmp_path / "off", cores=4, mesh_settings={"automatic_boundary_layers": False})
    assert off["mesh"]["expect"]["layers"] is False
    # Only a full run of the case's own settings goes where the report reads.
    assert _run_dir("c1_laminar_pipe", "standard", False) == RESULTS / "c1_laminar_pipe" / "standard"
    assert _run_dir("c1_laminar_pipe", "standard", True) == RESULTS_COARSE / "c1_laminar_pipe" / "standard"
    assert _run_dir("c1_laminar_pipe", "standard", False, True) == RESULTS_PROBE / "c1_laminar_pipe" / "standard"
    assert _run_dir("c1_laminar_pipe", "standard", True, True) == RESULTS_PROBE / "c1_laminar_pipe" / "standard"
