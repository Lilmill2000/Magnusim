"""HT3: the results tools on a solved two-region case (``fixtures/cht-case``).

The fixture is a real chtMultiRegionSimpleFoam case, 3 iterations on an 8x4x2 box
(20 x 10 x 10 mm): ``air`` (x < 10 mm, fluid, 32 cells) and ``aluminium_6061``
(x > 10 mm, solid, 32 cells), split by splitMeshRegions; the unsplit
``constant/polyMesh`` (64 cells, no fields) stays beside the regions, as in every
such case. Its frame ``3/`` holds ``air/{T,U,p,p_rgh,rho,phi}`` and
``aluminium_6061/{T,p}``.

- The reader reads both regions and never the unsplit mesh: 64 cells, not 128.
- U (fluid only) survives the merge as NaN in the solid, in the reader's float32.
- Field discovery, the field export, the series range, cut plane, iso surface and
  volume, inspect, plot over path and the VTK export work on every region; their
  outputs keep each point's region (``vtkRegion``).
- The cache stamps see a change in any region's file.
- The SDK's RegionProgressParser reads the case's own log.
"""
# ruff: noqa: I001
from __future__ import annotations

import json
import os
import shutil
import time
import zipfile
from pathlib import Path

import numpy as np
import pytest
import pyvista as pv

from cfddesk.worker import volume_cache
import case_volume  # noqa: E402
import export_case_field  # noqa: E402
import export_cut_plane  # noqa: E402
import export_inspect_point  # noqa: E402
import export_iso_surface  # noqa: E402
import export_iso_volume  # noqa: E402
import export_plot_over_path  # noqa: E402
import export_vtk  # noqa: E402
import result_names  # noqa: E402

from cfddesk.results.loader import read_foam_grid
from cfddesk.results.regions import REGION_ARRAY, case_regions, merge_regions, regions_without, stamp_files
from cfddesk.results.session import case_fingerprint
from magnusim_sdk.progress import RegionProgressParser

CHT = Path(__file__).resolve().parents[1] / "fixtures" / "cht-case"
AIR, SOLID = 32, 32
REGIONS = [{"name": "air", "role": "fluid"}, {"name": "aluminium_6061", "role": "solid"}]


@pytest.fixture()
def case(tmp_path: Path) -> Path:
    dst = tmp_path / "case"
    shutil.copytree(CHT, dst)
    return dst


def test_the_case_lists_its_regions(case: Path):
    assert case_regions(case) == REGIONS
    assert regions_without(case, "3", "magU") == [REGIONS[1]]
    assert regions_without(case, "3", "T") == []


def test_the_volume_is_both_regions_and_not_the_unsplit_mesh(case: Path):
    mesh, source = case_volume.load_volume(case, "3", use_cache=False)
    assert source.startswith("OpenFOAMReader:")
    assert mesh.n_cells == AIR + SOLID
    region = np.asarray(mesh.cell_data[REGION_ARRAY])
    assert (region == 0).sum() == AIR and (region == 1).sum() == SOLID
    # T everywhere; U in the fluid only, NaN in the solid, in the reader's dtype.
    t = np.asarray(mesh.cell_data["T"])
    u = np.asarray(mesh.cell_data["U"])
    assert np.isfinite(t).all()
    assert u.dtype == np.float32 and u.shape == (AIR + SOLID, 3)
    assert np.isfinite(u[region == 0]).all() and np.isnan(u[region == 1]).all()
    assert np.isnan(np.asarray(mesh.point_data["U"])[np.asarray(mesh.point_data[REGION_ARRAY]) == 1]).all()
    # The fluid cells are cooler (walls at 300 K) than the solid (350 K).
    assert t[region == 0].mean() < t[region == 1].mean()
    assert 299.0 < t.min() and t.max() < 351.0


def test_the_results_session_reader_reads_both_regions(case: Path):
    grid, _foam, field, _dec = read_foam_grid(case)
    assert grid.n_cells == AIR + SOLID
    assert field == "magU"  # the sidecar lists no result fields: the first vector's magnitude
    assert {"T", "U", REGION_ARRAY} <= set(grid.cell_data.keys())


def test_merging_keeps_an_array_only_one_region_has():
    a = pv.ImageData(dimensions=(3, 2, 2)).cast_to_unstructured_grid()
    b = pv.ImageData(dimensions=(3, 2, 2), origin=(2, 0, 0)).cast_to_unstructured_grid()
    a.cell_data["U"] = np.ones((a.n_cells, 3), dtype=np.float32)
    a.cell_data["T"] = np.full(a.n_cells, 1.0, dtype=np.float32)
    b.cell_data["T"] = np.full(b.n_cells, 2.0, dtype=np.float64)
    merged = merge_regions([("a", a), ("b", b)], ["a", "b"])
    assert merged.n_cells == a.n_cells + b.n_cells
    assert np.isnan(np.asarray(merged.cell_data["U"])[a.n_cells :]).all()
    assert np.asarray(merged.cell_data["U"]).dtype == np.float32
    assert list(np.asarray(merged.cell_data["T"])) == [1.0] * a.n_cells + [2.0] * b.n_cells


def test_field_discovery_reads_every_region(case: Path):
    t3 = case / "3"
    assert result_names.shown_fields(t3) == ["p", "p_rgh", "rho", "T", "magU"]
    assert result_names.foam_source(t3, "magU") == ("U", "vector")
    assert [p.parent.name for p in result_names.foam_paths(t3, "T")] == ["air", "aluminium_6061"]
    assert [p.parent.name for p in result_names.foam_paths(t3, "U")] == ["air"]
    # No result fields in the sidecar: the frame's first field; with them, the first the frame wrote.
    assert result_names.default_shown_field(case, "3") == "p"
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    side["result_fields"] = [{"key": "T", "kind": "scalar"}, {"key": "U", "kind": "vector", "unit_quantity": "velocity"}]
    (case / "w27-case.json").write_text(json.dumps(side), encoding="utf-8")
    assert result_names.default_shown_field(case, "3") == "T"
    assert result_names.velocity_vector(case, "3") == "U"


def test_the_field_export_spans_both_regions(case: Path, tmp_path: Path):
    meta = export_case_field.export_field(case, "3", "T", tmp_path / "out-T")
    assert meta["regions"] == REGIONS and meta["regions_without_field"] == []
    proof = meta["foam_proof"]
    # The range is every region's: the air's 300 K walls and the solid's 350 K.
    assert proof["min"] < 301.0 and proof["max"] > 349.0
    surf = pv.read(tmp_path / "out-T" / "T.vtp")
    assert {int(v) for v in np.unique(surf.point_data[REGION_ARRAY])} == {0, 1}
    meta = export_case_field.export_field(case, "3", "magU", tmp_path / "out-U")
    assert meta["regions_without_field"] == [REGIONS[1]]
    surf = pv.read(tmp_path / "out-U" / "magU.vtp")
    mag = np.asarray(surf.point_data["magU"])
    region = np.asarray(surf.point_data[REGION_ARRAY])
    assert np.isnan(mag[region == 1]).all() and np.isfinite(mag[region == 0]).all()
    rng = export_case_field.series_field_range(case, "T")
    assert rng["times"] == ["0", "3"] and rng["min"] < 301.0 and rng["max"] >= 349.0


def test_a_cut_plane_crosses_both_regions(case: Path, tmp_path: Path):
    meta = export_cut_plane.export_cut_plane(case, "3", tmp_path / "cut", ox=0.01, oy=0.005, oz=0.005, nx=0, ny=0, nz=1, field="T")
    assert not meta["empty"] and meta["umin"] < 305.0 and meta["umax"] > 345.0
    cut = pv.read(tmp_path / "cut" / "cut_plane.vtp")
    region = np.asarray(cut.point_data[REGION_ARRAY])
    assert {int(round(v)) for v in np.unique(region)} == {0, 1}
    x = np.asarray(cut.points)[:, 0]
    assert (x[np.round(region) == 0] <= 0.01 + 1e-9).all() and (x[np.round(region) == 1] >= 0.01 - 1e-9).all()


def test_iso_surface_and_volume_keep_the_region(case: Path, tmp_path: Path):
    meta = export_iso_surface.export_iso_surface(case, "3", tmp_path / "iso", iso_field="T", iso_value=340.0)
    assert not meta["empty"]
    iso = pv.read(tmp_path / "iso" / "iso_surface.vtp")
    assert REGION_ARRAY in iso.point_data
    meta = export_iso_volume.export_iso_volume(case, "3", tmp_path / "iv", iso_field="T", iso_value_low=0.0, iso_value_high=1.0)
    assert not meta["empty"]
    iv = pv.read(tmp_path / "iv" / "iso_volume.vtp")
    assert {int(round(v)) for v in np.unique(iv.point_data[REGION_ARRAY])} == {0, 1}


def test_inspect_says_the_region_and_no_velocity_in_the_solid(case: Path, tmp_path: Path):
    solid = export_inspect_point.export_inspect(case, "3", tmp_path / "in-s", 0.015, 0.005, 0.005)
    assert solid["hit"] and solid["region"] == "aluminium_6061"
    assert solid["values"]["magU"] is None and 340.0 < solid["values"]["T"] < 351.0
    air = export_inspect_point.export_inspect(case, "3", tmp_path / "in-a", 0.005, 0.005, 0.005)
    assert air["hit"] and air["region"] == "air"
    assert air["values"]["magU"] is not None and air["values"]["T"] < solid["values"]["T"]
    json.dumps(solid, allow_nan=False)


def test_plot_over_path_runs_through_both_regions(case: Path, tmp_path: Path):
    path = [[0.001, 0.005, 0.005], [0.019, 0.005, 0.005]]
    t = export_plot_over_path.export_plot_over_path(case, "3", tmp_path / "pop-t", points=path, field="T")
    assert not t["empty"] and min(t["distances"]) < 0.002 and max(t["distances"]) > 0.016
    u = export_plot_over_path.export_plot_over_path(case, "3", tmp_path / "pop-u", points=path, field="magU")
    # U only where the path is in the fluid (the first half).
    assert not u["empty"] and max(u["distances"]) < 0.0095
    json.dumps(u, allow_nan=False)


def test_the_vtk_export_holds_a_block_per_region(case: Path, tmp_path: Path):
    res = export_vtk.export_vtk(case, ["3"], tmp_path / "vtk", "cht")
    assert res["n_cells"] == AIR + SOLID
    out = tmp_path / "unzipped"
    with zipfile.ZipFile(res["zip"]) as zf:
        zf.extractall(out)
    files = sorted(p.relative_to(out).as_posix() for p in out.rglob("*.vt*"))
    assert "cht/3/air/internalMesh.vtu" in files and "cht/3/aluminium_6061/internalMesh.vtu" in files
    # Never the unsplit mesh (no fields) and never a patch group.
    assert "cht/3/internalMesh.vtu" not in files and not [f for f in files if "/group/" in f]
    assert "The case has 2 regions (air, aluminium_6061)" in (out / "README.txt").read_text(encoding="utf-8")
    solid = pv.read(out / "cht" / "3" / "aluminium_6061" / "internalMesh.vtu")
    assert solid.n_cells == SOLID and "T" in solid.cell_data and "U" not in solid.cell_data


def _touch(path: Path) -> None:
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))


def test_cache_stamps_see_every_region(case: Path):
    files = {p.relative_to(case).as_posix() for p in stamp_files(case, "3")}
    assert {"3/air/T", "3/air/U", "3/aluminium_6061/T", "constant/air/polyMesh/points", "constant/aluminium_6061/polyMesh/points"} <= files
    assert "constant/polyMesh/points" not in files
    before = (case_volume._stamp(case, "3"), volume_cache._foam_stamp(case, "3"), case_fingerprint(case))
    _touch(case / "3" / "aluminium_6061" / "T")
    after = (case_volume._stamp(case, "3"), volume_cache._foam_stamp(case, "3"), case_fingerprint(case))
    assert all(a != b for a, b in zip(before, after, strict=True)), (before, after)
    time.sleep(0)


def test_the_parser_reads_the_cases_own_log():
    parser = RegionProgressParser()
    parser.feed('MAGNUSIM_EVENT {"event":"stage","stage":"solve"}')
    events = []
    for line in (CHT / "log.chtMultiRegionSimpleFoam").read_text(encoding="utf-8").splitlines():
        events.extend(parser.feed(line))
    steps = parser.snapshot()["residuals"]
    assert [s["t"] for s in steps] == [1.0, 2.0, 3.0]
    assert {"air:Ux", "air:h", "air:p_rgh", "aluminium_6061:h"} <= set(steps[-1])
    assert not [k for k in steps[-1] if k != "t" and ":" not in k]


# ---------------------------------------------------------------------------
# Review fixes
# ---------------------------------------------------------------------------


def _strict_json(path: Path) -> dict:
    """The file as a browser's JSON.parse reads it: NaN or Infinity is an error."""

    def no_constant(name: str) -> None:
        raise ValueError(f"{name} in {path.name}")

    return json.loads(path.read_text(encoding="utf-8"), parse_constant=no_constant)


def test_a_cut_plane_through_the_solid_by_velocity_has_no_range(case: Path, tmp_path: Path):
    """Coloured by U through the solid alone: every value is NaN. Its range is
    null, never NaN (NaN in the meta made the server's JSON.parse fail: a 500)."""
    meta = export_cut_plane.export_cut_plane(case, "3", tmp_path / "cut", ox=0.015, oy=0.005, oz=0.005, nx=1, ny=0, nz=0, field="magU")
    assert not meta["empty"]
    assert meta["umin"] is None and meta["umax"] is None
    assert _strict_json(tmp_path / "cut" / "cut_plane.meta.json")["umin"] is None
    # Across both regions: the fluid's range.
    meta = export_cut_plane.export_cut_plane(case, "3", tmp_path / "cut2", ox=0.01, oy=0.005, oz=0.005, nx=0, ny=0, nz=1, field="magU")
    assert meta["umin"] is not None and meta["umax"] >= meta["umin"]
    _strict_json(tmp_path / "cut2" / "cut_plane.meta.json")


def test_finite_ranges_and_json_never_hold_nan():
    assert result_names.finite_range(np.array([np.nan, np.nan])) == (None, None)
    assert result_names.finite_range(np.array([np.nan, 2.0, -1.0, np.inf])) == (-1.0, 2.0)
    assert result_names.finite_range(None) == (None, None)
    text = result_names.json_text({"a": float("nan"), "b": [1.0, float("inf"), (2.0, float("-inf"))], "c": "x"})
    assert json.loads(text) == {"a": None, "b": [1.0, None, [2.0, None]], "c": "x"}
    # Plain values: the text json.dumps writes.
    doc = {"umin": 1.5, "n": 3, "rows": [{"t": 0.1}], "ok": True, "none": None}
    assert result_names.json_text(doc, indent=2) == json.dumps(doc, indent=2)


def test_every_results_meta_is_strict_json(case: Path, tmp_path: Path):
    """The exporters the multi-region results run through write JSON a browser reads,
    for a field the solid has not (U)."""
    export_case_field.export_field(case, "3", "magU", tmp_path / "f")
    _strict_json(tmp_path / "f" / "magU.meta.json")
    export_iso_surface.export_iso_surface(case, "3", tmp_path / "iso", iso_field="T", iso_value=340.0, color_field="magU")
    _strict_json(tmp_path / "iso" / "iso_surface.meta.json")
    export_iso_volume.export_iso_volume(case, "3", tmp_path / "iv", iso_field="T", iso_value_low=0.0, iso_value_high=1.0, color_field="magU")
    _strict_json(tmp_path / "iv" / "iso_volume.meta.json")
    export_inspect_point.export_inspect(case, "3", tmp_path / "in", 0.015, 0.005, 0.005)
    _strict_json(tmp_path / "in" / "inspect.meta.json")


def test_inspect_names_the_region_of_a_click_on_the_outer_surface(case: Path, tmp_path: Path):
    """A click on the solid's outer face lands a rounding error outside the cells:
    the probe reads the cell just inside, and the region is that cell's (it was
    looked up again at the clicked point, which is off the mesh: no region)."""
    mesh, _ = case_volume.load_volume(case, "3", use_cache=False)
    grid = export_inspect_point._point_grid(mesh)
    outside = [0.015, 0.005, 0.01 + 1e-8]
    _sampled, hit = export_inspect_point._sample_once(grid, outside, ["T"])
    assert not hit, "the point must be just off the mesh for this test"
    probed = export_inspect_point.probe_point(grid, outside, ["T"])
    assert probed["hit"] and probed["region_index"] == 1
    res = export_inspect_point.export_inspect(case, "3", tmp_path / "in", *outside)
    assert res["hit"] and res["region"] == "aluminium_6061"
    res = export_inspect_point.export_inspect(case, "3", tmp_path / "in2", 0.005, 0.005, 0.01 + 1e-8)
    assert res["hit"] and res["region"] == "air"


def _uniform_solid_t(case: Path, value: float) -> None:
    path = case / "3" / "aluminium_6061" / "T"
    text = path.read_text(encoding="utf-8")
    # Uniform inside and on every patch (a field with values per wall face only is
    # read as stored on the walls, y+ style).
    body = (
        f"internalField   uniform {value};\n"
        f'boundaryField\n{{\n    ".*" {{ type calculated; value uniform {value}; }}\n}}\n'
    )
    path.write_text(text[: text.index("internalField")] + body, encoding="utf-8")


def test_a_uniform_region_weighs_its_cells_in_the_combined_mean(case: Path):
    """The solid's T stored uniform (350 K over its 32 cells) and the air's per cell:
    the mean over both regions weighs each region by its cells."""
    _uniform_solid_t(case, 350.0)
    paths = result_names.foam_paths(case / "3", "T")
    air = export_case_field.parse_foam_scalar_or_vector(paths[0], "scalar")
    stats = export_case_field.parse_foam_fields(paths, "scalar")
    assert air["n_cells_internal"] == AIR
    assert stats["pmean"] == pytest.approx((air["pmean"] * AIR + 350.0 * SOLID) / (AIR + SOLID))
    assert stats["pmax"] == 350.0


def test_plot_over_path_through_the_solid_alone_says_the_field_is_not_there(case: Path, tmp_path: Path):
    path = [[0.012, 0.005, 0.005], [0.019, 0.005, 0.005]]
    u = export_plot_over_path.export_plot_over_path(case, "3", tmp_path / "pu", points=path, field="magU")
    assert u["empty"] and u["reason"] == "field_not_in_regions"
    off = export_plot_over_path.export_plot_over_path(case, "3", tmp_path / "po", points=[[1, 1, 1], [2, 2, 2]], field="magU")
    assert off["empty"] and off["reason"] == "miss_mesh"


def test_plot_over_path_breaks_where_the_field_is_not_defined(case: Path, tmp_path: Path):
    """Air, then the solid, then air again: U's series is two runs, never joined
    across the solid; a path in one region has no breaks."""
    path = [[0.002, 0.005, 0.005], [0.018, 0.005, 0.005], [0.003, 0.006, 0.005]]
    u = export_plot_over_path.export_plot_over_path(case, "3", tmp_path / "pb", points=path, field="magU", subdivisions=40)
    assert not u["empty"] and len(u["breaks"]) == 1
    at = u["breaks"][0]
    assert 0 < at < len(u["values"])
    # The run before the break ends in the air (x < 10 mm), the next starts there.
    assert u["sample_points"][at - 1][0] < 0.0101 and u["sample_points"][at][0] < 0.0101
    t = export_plot_over_path.export_plot_over_path(case, "3", tmp_path / "pt", points=path, field="T", subdivisions=40)
    assert "breaks" not in t
