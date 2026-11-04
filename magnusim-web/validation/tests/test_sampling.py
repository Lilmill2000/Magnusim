"""The harness's own reads of a run's case folder (sampling.py), on the app's committed
OpenFOAM results fixture: the cell values are the field file's own (no interpolation), a
patch field is the one the run saved, and a read kept in raw/ is used again once the
case folder is gone."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest
from magnusim_validation.paths import PY_ROOT
from magnusim_validation.sampling import cells, patch, sample_run

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
