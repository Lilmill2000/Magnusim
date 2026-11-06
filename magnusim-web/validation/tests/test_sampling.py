"""The harness's own reads of a run's case folder (sampling.py), on the app's committed
OpenFOAM results fixture: the cell values are the field file's own (no interpolation), a
patch field is the one the run saved, a line sampled with its components is what Plot over
path's own program gives for a scalar, and a read kept in raw/ is used again once the case
folder is gone."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from magnusim_validation.paths import PY_ROOT
from magnusim_validation.sampling import cells, line, patch, sample_run

FIXTURE = PY_ROOT / "tests" / "fixtures" / "foam-results" / "cavity-2d"


def _case(tmp_path: Path) -> Path:
    # A copy: the reader writes case.foam beside the fields.
    dst = tmp_path / "case"
    shutil.copytree(FIXTURE, dst)
    return dst


def _internal_vectors(path: Path) -> list[tuple[float, float, float]]:
    text = path.read_text(encoding="utf-8")
    body = text.split("internalField", 1)[1].split("boundaryField", 1)[0]
    return [tuple(float(v) for v in m.groups()) for m in re.finditer(r"\(([-+\deE.]+) ([-+\deE.]+) ([-+\deE.]+)\)", body)]


def test_the_cell_values_are_the_field_files_own(tmp_path: Path):
    case = _case(tmp_path)
    want = _internal_vectors(case / "0.5" / "U")
    got = cells(case, "0.5", ["U", "p"], use_cache=False)
    assert got["n"] == len(want) == 400
    assert got["source"] == "app_sampling"
    assert got["U_x"] == pytest.approx([w[0] for w in want], rel=1e-6, abs=1e-12)
    assert got["U_y"] == pytest.approx([w[1] for w in want], rel=1e-6, abs=1e-12)
    assert len(got["p"]) == 400 and len(got["vol"]) == 400
    # A box keeps the cells whose centres lie in it.
    xs = sorted(set(got["x"]))
    half = cells(case, "0.5", ["U"], box=[[-1.0, -1.0, -1.0], [xs[len(xs) // 2] - 1e-9, 1.0, 1.0]], use_cache=False)
    assert 0 < half["n"] < 400 and max(half["x"]) < xs[len(xs) // 2]
    with pytest.raises(KeyError):
        cells(case, "0.5", ["T"], use_cache=False)


def test_a_patch_field_is_the_one_the_run_saved(tmp_path: Path):
    case = _case(tmp_path)
    got = patch(case, "0.5", "movingWall", "U")
    assert got["n"] == 20 and got["source"] == "case_file:0.5/U"
    assert got["U_x"] == pytest.approx([1.0] * 20)
    with pytest.raises(KeyError, match="patches: "):
        patch(case, "0.5", "noSuchWall", "U")


def test_a_read_is_kept_in_raw_and_used_again_once_the_folder_is_gone(tmp_path: Path):
    case = _case(tmp_path)
    run_dir = tmp_path / "run"
    plan = {"extract": [{"key": "c", "kind": "cells", "fields": ["U"], "box_m": None},
                        {"key": "w", "kind": "patch", "patch": "movingWall", "field": "U", "box_m": None},
                        {"key": "line", "kind": "line"}]}
    assert sample_run(run_dir, plan, str(case), "0.5") == []
    first = json.loads((run_dir / "raw" / "sample_c.json").read_text(encoding="utf-8"))
    assert first["n"] == 400 and (run_dir / "raw" / "sample_w.json").is_file()
    assert not (run_dir / "raw" / "sample_line.json").exists()
    shutil.rmtree(case)
    assert sample_run(run_dir, plan, str(case), "0.5") == []
    assert json.loads((run_dir / "raw" / "sample_c.json").read_text(encoding="utf-8")) == first
    other = tmp_path / "other"
    problems = sample_run(other, plan, str(case), "0.5")
    assert len(problems) == 2 and all("case folder is gone" in p for p in problems)


def _route_answer(case: Path, tmp_path: Path, points: str, subdivisions: int, field: str) -> dict:
    """What /api/plot-over-path answers: its own program (export_plot_over_path.py) run with
    the command line the route builds (scripts/vite-plugin-case-fields.js popExportArgs)."""
    out = tmp_path / f"route-{field}"
    r = subprocess.run(
        [sys.executable, str(PY_ROOT / "tools" / "export_plot_over_path.py"), "--case", str(case), "--time", "0.5",
         "--out-dir", str(out), f"--points={points}", "--subdivisions", str(subdivisions), "--field", field],
        capture_output=True, text=True, timeout=300, check=False,
    )
    assert r.returncode == 0, r.stderr
    return json.loads((out / "plot_over_path.meta.json").read_text(encoding="utf-8"))


# A path of two segments across the cavity: the second starts where the first ends.
PATH = [[0.0, 0.05, 0.005], [0.05, 0.073, 0.005], [0.1, 0.031, 0.005]]
PATH_PARAM = ";".join(",".join(str(v) for v in p) for p in PATH)


def test_app_sampling_of_a_scalar_is_plot_over_paths_own_answer(tmp_path: Path):
    case = _case(tmp_path)
    route = _route_answer(case, tmp_path, PATH_PARAM, 40, "p")
    # The route reads the volume through the app's cache (a binary copy of it); so does this.
    mine = line(case, "0.5", ["p"], points_m=PATH, subdivisions=40)
    # 41 steps a segment: 42 samples on the first, 41 more on the second.
    assert route["n_valid"] == mine["n_valid"] == 83
    assert mine["source"] == "app_sampling"
    assert mine["distances"] == pytest.approx(route["distances"], rel=1e-12, abs=1e-15)
    flat = [v for pt in route["sample_points"] for v in pt]
    assert [v for pt in mine["sample_points"] for v in pt] == pytest.approx(flat, rel=1e-12, abs=1e-15)
    assert mine["p"] == pytest.approx(route["values"], rel=1e-12, abs=1e-15)


def test_app_sampling_keeps_a_vectors_components_sampled_as_the_route_samples_a_scalar(tmp_path: Path):
    """The route gives a vector's magnitude only. Each component here is what the route's own
    sampler gives for that component put on the mesh as a scalar, and their magnitude is the
    route's |U| to within the difference between interpolating a magnitude and its parts."""
    import numpy as np

    sys.path.insert(0, str(PY_ROOT / "tools"))
    from case_volume import load_volume
    from export_plot_over_path import sample_over_path

    case = _case(tmp_path)
    mine = line(case, "0.5", ["U"], points_m=PATH, subdivisions=40)
    grid, _ = load_volume(case, "0.5")
    # Each component in the vector's own precision (the sampler interpolates in it).
    u = np.asarray(grid.point_data["U"])
    for k, c in enumerate("xyz"):
        grid.point_data[f"U_{c}_scalar"] = np.ascontiguousarray(u[:, k])
        route_c = sample_over_path(grid, PATH, 40, f"U_{c}_scalar")
        assert mine[f"U_{c}"] == pytest.approx(route_c["values"], rel=1e-12, abs=1e-15), c
    mag = _route_answer(case, tmp_path, PATH_PARAM, 40, "U")
    assert mag["field_name"] == "magU"
    have = np.hypot(np.hypot(mine["U_x"], mine["U_y"]), mine["U_z"])
    assert np.max(np.abs(have - np.asarray(mag["values"]))) < 0.02 * max(mag["values"])
    # Several lines in one read: each as if read alone.
    many = line(case, "0.5", ["U", "p"], paths_m=[PATH, PATH[:2]], subdivisions=40)
    assert [p["n_valid"] for p in many["paths"]] == [83, 42]
    assert many["paths"][0]["U_x"] == mine["U_x"]
    with pytest.raises(KeyError):
        line(case, "0.5", ["T"], points_m=PATH, subdivisions=4, use_cache=False)
    with pytest.raises(ValueError):
        line(case, "0.5", ["p"], subdivisions=4, use_cache=False)
