"""Refine out to on Surface custom sizing (validation gap G4): the record's distance in metres
(``web_refinements.reach_metres``), the band each custom size's refinement region gets
(``snappy_hexdominant.refine_distance_m``), what generate_snappy.py writes in
snappyHexMeshDict and its meta, the mesh facts' bands, and the validation plan's estimate.
The record and its route are tested by scripts/server/__tests__/refinement-reach.test.js, the
panel and the Assistant by e2e/mesh-refine-reach.spec.js (its WSL test meshes a real band).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from cfddesk.cad.step import load_step
from cfddesk.mesh.snappy_hexdominant import (
    DEFAULT_BAND_CELLS,
    refine_distance_m,
    refinement_level_for_size,
)
from cfddesk.mesh.web_refinements import load_surface_custom_sizes, reach_metres
from tests.unit.test_two_d_mesh import (
    _box,
    _cut,
    _cylinder,
    _faces,
    _generate,
    _labels,
    _project,
    _slab_bcs,
    _write_step,
)


@pytest.fixture(scope="module")
def slab(tmp_path_factory) -> Path:
    """test_two_d_mesh's slab: a channel 100 x 50 mm, 10 mm deep along z, a 10 mm hole at (30, 25)."""
    path = tmp_path_factory.mktemp("slab") / "slab.step"
    return _write_step(_cut(_box(0, 0, 0, 100, 50, 10), _cylinder((30, 25, -1), (0, 0, 1), 5, 12)), path)


def _sizing(**over) -> dict:
    return {
        "type": "Surface custom sizing",
        "name": "Hole",
        "mesh_id": "mesh_1",
        "faces": ["face 2@Body1"],
        "sizing": "Custom",
        "default_size": 1.2,
        "default_size_unit": "mm",
        "min_size": 0,
        **over,
    }


@pytest.mark.parametrize(
    ("rec", "want"),
    [
        ({"reach": 15, "reach_unit": "mm"}, 0.015),
        ({"reach": 0.03, "reach_unit": "m"}, 0.03),
        ({"reach": 1, "reach_unit": "in"}, 0.0254),
        # No unit of its own: the size's.
        ({"reach": 2, "default_size_unit": "m"}, 2.0),
        ({"reach": "12"}, 0.012),
        ({"reach": None}, None),
        ({"reach": ""}, None),
        ({"reach": 0}, None),
        ({"reach": -3}, None),
        ({"reach": "far"}, None),
        ({}, None),
    ],
)
def test_reach_in_metres(rec, want):
    got = reach_metres(rec)
    assert got == (pytest.approx(want) if want is not None else None)


def test_the_band_reaches_out_to_the_distance_and_never_less_than_three_cells():
    assert DEFAULT_BAND_CELLS == 3
    assert refine_distance_m(0.001) == pytest.approx(0.003)
    assert refine_distance_m(0.001, None) == pytest.approx(0.003)
    assert refine_distance_m(0.001, 0.02) == pytest.approx(0.02)
    # Shorter than the default band: the default band.
    assert refine_distance_m(0.001, 0.002) == pytest.approx(0.003)
    assert refine_distance_m(0.001, 0.0) == pytest.approx(0.003)


def test_the_loader_carries_the_distance_only_when_there_is_one(tmp_path: Path):
    (tmp_path / "mesh_refinements.json").write_text(
        json.dumps({"refinements": [_sizing(reach=15, reach_unit="mm"), _sizing(name="Plain", faces=["face 3@Body1"], reach=None)]}),
        encoding="utf-8",
    )
    sizes, _mins, notes = load_surface_custom_sizes(tmp_path, "mesh_1", 10, 0.1)
    assert sizes == {1: pytest.approx(0.0012), 2: pytest.approx(0.0012)}
    assert notes[0]["reach_m"] == pytest.approx(0.015)
    # A record without one keeps its note as before (Standard's and cfMesh's meta unchanged).
    assert "reach_m" not in notes[1]


# ---------------------------------------------------------------- generate_snappy.py


def _hole(step: Path) -> str:
    """The slab's hole: its one face around (30, 25)."""
    solid = load_step(step)
    rest = set(_faces(solid)["rest"])
    hole = [int(r.face_id) for r in solid.faces if int(r.face_id) in rest and abs(r.centroid[0] - 30) < 1e-3 and abs(r.centroid[1] - 25) < 1e-3]
    assert len(hole) == 1
    return f"face {hole[0] + 1}@Body1"


def _mesh_dir(proj: Path) -> Path:
    from cfddesk.project.paths import find_mesh

    found = find_mesh(proj, "mesh_1", "sim_1")
    assert found
    return Path(found["dir"])


def _regions(text: str) -> dict[str, tuple[float, int]]:
    """snappyHexMeshDict's refinementRegions: name -> (distance, level)."""
    block = text.split("refinementRegions", 1)[1]
    return {m[0]: (float(m[1]), int(m[2])) for m in re.findall(r"(refine_\d+)\s*\{\s*mode distance;\s*levels \(\(([-+.\deE]+) (\d+)\)\);", block)}


@pytest.mark.occt
@pytest.mark.parametrize("two_d", [False, True], ids=["3d", "one-cell-across"])
def test_generate_writes_the_distance_as_the_refinement_region(slab: Path, tmp_path: Path, two_d: bool):
    lab = _labels(slab)
    hole = _hole(slab)
    proj = _project(tmp_path, slab, _slab_bcs(lab))
    (_mesh_dir(proj) / "refinements.json").write_text(
        json.dumps(
            {
                "refinements": [
                    _sizing(name="Wake", faces=[hole], reach=15, reach_unit="mm"),
                    # The same face's own size, three cells out (no Refine out to).
                    _sizing(name="Near", faces=[hole], default_size=0.6),
                ]
            }
        ),
        encoding="utf-8",
    )
    case = tmp_path / "case"
    rc, result, out = _generate(proj, case, *(["--one-cell-across", "1"] if two_d else []))
    assert rc == 0 and result.get("ok") is True, out[-3000:]
    text = (case / "system" / "snappyHexMeshDict").read_text(encoding="utf-8")
    regions = _regions(text)
    meta = json.loads((case / "w23-geometry-meta.json").read_text(encoding="utf-8"))
    rows = {r["name"]: r for r in meta["refinement_regions"]}
    assert set(regions) == set(rows) == {"refine_1", "refine_2"}
    wake = next(r for r in rows.values() if r.get("reach_m"))
    near = next(r for r in rows.values() if not r.get("reach_m"))
    # The Refine out to is the region's distance; the plain size keeps three of its cells.
    assert regions[wake["name"]][0] == pytest.approx(0.015)
    assert wake["reach_m"] == pytest.approx(0.015) and wake["distance_m"] == pytest.approx(0.015)
    assert regions[near["name"]][0] == pytest.approx(3 * 0.0006)
    assert near["distance_m"] == pytest.approx(0.0018) and "reach_m" not in near
    # Each at the level that meets its own size.
    base = meta["two_d"]["base_m"] if two_d else None
    if base:
        assert wake["level"] == refinement_level_for_size(base, 0.0012)
        assert near["level"] == refinement_level_for_size(base, 0.0006)
    assert near["level"] == wake["level"] + 1


@pytest.mark.occt
def test_generate_without_a_distance_writes_what_it_wrote_before(slab: Path, tmp_path: Path):
    lab = _labels(slab)
    proj = _project(tmp_path, slab, _slab_bcs(lab))
    (_mesh_dir(proj) / "refinements.json").write_text(json.dumps({"refinements": [_sizing(faces=[_hole(slab)])]}), encoding="utf-8")
    case = tmp_path / "case"
    rc, result, out = _generate(proj, case)
    assert rc == 0 and result.get("ok") is True, out[-3000:]
    meta = json.loads((case / "w23-geometry-meta.json").read_text(encoding="utf-8"))
    assert [sorted(r) for r in meta["refinement_regions"]] == [["distance_m", "level", "name"]]
    assert meta["refinement_regions"][0]["distance_m"] == pytest.approx(0.0036)


# ---------------------------------------------------------------- mesh facts


def test_mesh_facts_list_each_band(tmp_path: Path):
    from magnusim_sdk.mesh_facts import build_mesh_facts

    case = tmp_path / "case"
    (case / "system").mkdir(parents=True)
    (case / "w23-geometry-meta.json").write_text(
        json.dumps(
            {
                "walls_level": 1,
                "two_d": {"axis": 2, "base_m": 0.004, "depth_m": 0.01},
                "refinement_regions": [
                    {"name": "refine_1", "level": 2, "distance_m": 0.015, "reach_m": 0.015},
                    {"name": "refine_2", "level": 3, "distance_m": 0.0018},
                ],
            }
        ),
        encoding="utf-8",
    )
    facts = build_mesh_facts(case, mesher="hexdominant")
    assert facts["surface_cell_m"] == pytest.approx(0.002)
    assert facts["refined"] == [
        {"level": 2, "cell_m": 0.001, "distance_m": 0.015, "reach_m": 0.015},
        {"level": 3, "cell_m": 0.0005, "distance_m": 0.0018},
    ]


def test_mesh_facts_without_custom_sizes_have_no_bands(tmp_path: Path):
    from magnusim_sdk.mesh_facts import build_mesh_facts

    case = tmp_path / "case"
    (case / "system").mkdir(parents=True)
    (case / "w23-geometry-meta.json").write_text(json.dumps({"walls_level": 1, "refinement_regions": []}), encoding="utf-8")
    assert "refined" not in build_mesh_facts(case, mesher="hexdominant")
