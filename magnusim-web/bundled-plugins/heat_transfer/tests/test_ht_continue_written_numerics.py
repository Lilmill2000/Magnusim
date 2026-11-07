"""What a Heat Transfer run solved with, for new and continued runs (RH3; its walls are Incompressible
Flow's, and k-omega SST's took Spalding's law and stepwise omega on 2026-11-06).

- A Start's plan carries "Numerics as written" (its Wall treatment row too), which the core records
  on the run, so the Run panel and the Assistant show what the run solved with.
- A Continue that goes on with what the run had (``restart.keep_numerics``) keeps the run's own
  fvSchemes and the walls its saved time holds, and its plan carries no rows.
- A Continue with the study's new numerics gives the saved time's wall patches the writer's
  entries (their saved values kept), for one region and for each fluid region of a conjugate case.

The saved times here hold what a run started before the change saved: nutkWallFunction and
omegaWallFunction without stepwise blending on the walls.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import pytest
from cfddesk.registry import load_all, reset_for_tests
from ht_inputs import make_inputs
from magnusim_sdk.foam import boundary_entry_types
from test_ht5_cht import WALLS_FIXED, _inputs

from heat_transfer.analyses import _decision
from heat_transfer.runspec import load_spec
from heat_transfer.writer import write_case

MARK = "// the run's own schemes"
SST_WALLS = "nut nutUSpaldingWallFunction, k kqRWallFunction, omega omegaWallFunction (stepwise)"


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _older(src: Path, dst: Path) -> None:
    """``dst`` holds the turbulence fields of ``src`` (a 0/ folder) as a run written before the
    change saved them."""
    dst.mkdir(parents=True, exist_ok=True)
    for f in ("U", "T", "p", "p_rgh", "k", "alphat"):
        if (src / f).is_file():
            shutil.copy(src / f, dst / f)
    nut = (src / "nut").read_text(encoding="utf-8").replace("nutUSpaldingWallFunction", "nutkWallFunction")
    (dst / "nut").write_text(nut.replace("value          uniform 0;", "value          uniform 0.0042;"), encoding="utf-8")
    (dst / "omega").write_text(re.sub(r"\n\s*blending\s+stepwise;", "", (src / "omega").read_text(encoding="utf-8")), encoding="utf-8")


def _ctx(spec):
    from types import SimpleNamespace

    return SimpleNamespace(inputs=spec.inputs)


def _single(tmp_path: Path, *, keep: bool):
    case = tmp_path / "case"
    study = {"turbulence_model": "kOmegaSST"}
    first = load_spec(make_inputs(tmp_path, study=study))
    assert first.ok, first.error
    assert write_case(first, case)["ok"]
    _older(case / "0", case / "100")
    (case / "system" / "fvSchemes").write_text((case / "system" / "fvSchemes").read_text(encoding="utf-8") + MARK + "\n", encoding="utf-8")
    restart = {"end_time": 300, **({"keep_numerics": True} if keep else {})}
    spec = load_spec(make_inputs(tmp_path, study=study, restart=restart))
    assert spec.ok, spec.error
    report = write_case(spec, case)
    assert report["ok"], report
    return case, report, _decision(spec, _ctx(spec))


def test_a_starts_plan_carries_the_wall_treatment_its_case_is_written_with(tmp_path: Path):
    spec = load_spec(make_inputs(tmp_path, study={"turbulence_model": "kOmegaSST"}))
    rows = {f"{r['group']}/{r['label']}": r["value"] for r in _decision(spec, _ctx(spec))["numerics"]}
    assert rows["Stays fixed/Wall treatment"].startswith(SST_WALLS + ", alphat compressible::alphatJayatillekeWallFunction")


def test_a_continue_as_it_was_keeps_the_runs_schemes_and_saved_walls(tmp_path: Path):
    case, report, plan = _single(tmp_path, keep=True)
    assert MARK in (case / "system" / "fvSchemes").read_text(encoding="utf-8")
    assert boundary_entry_types(case / "100" / "nut")["walls"] == "nutkWallFunction"
    assert report["restart"] == {"from_time": 100.0, "end_time": 300.0, "kept_numerics": True}
    assert "numerics" not in plan


def test_a_continue_with_new_numerics_gives_the_saved_walls_the_writers_entries(tmp_path: Path):
    case, report, plan = _single(tmp_path, keep=False)
    assert MARK not in (case / "system" / "fvSchemes").read_text(encoding="utf-8")
    walls = ["walls", "heater", "cold_plate", "lid"]
    assert report["restart"] == {"from_time": 100.0, "end_time": 300.0, "walls_rewritten": {"nut": walls, "omega": walls}}
    nut = boundary_entry_types(case / "100" / "nut")
    assert [nut[w] for w in walls] == ["nutUSpaldingWallFunction"] * 4 and nut["inlet"] == "calculated"
    assert "uniform 0.0042;" in (case / "100" / "nut").read_text(encoding="utf-8")
    assert (case / "100" / "omega").read_text(encoding="utf-8").count("stepwise") == 4
    rows = {f"{r['group']}/{r['label']}": r["value"] for r in plan["numerics"]}
    assert rows["Stays fixed/Wall treatment"].startswith(SST_WALLS)


BOUNDARY = """FoamFile
{
    version     2.0;
    format      ascii;
    class       polyBoundaryMesh;
    object      boundary;
}
2
(
    walls
    {
        type            wall;
        nFaces          8;
        startFace       40;
    }
    air_to_aluminium_6061
    {
        type            mappedWall;
        nFaces          4;
        startFace       48;
    }
)
"""


def test_a_conjugate_continue_with_new_numerics_gives_each_fluid_regions_saved_walls_the_writers_entries(tmp_path: Path):
    case = tmp_path / "case"
    study = {"turbulence_model": "kOmegaSST"}
    assert write_case(load_spec(_inputs(tmp_path, bcs=WALLS_FIXED, study=study)), case)["ok"]
    # The fluid region's mesh as the run split it, and its saved time.
    (case / "constant" / "air" / "polyMesh").mkdir(parents=True)
    (case / "constant" / "air" / "polyMesh" / "boundary").write_text(BOUNDARY, encoding="utf-8")
    _older(case / "0" / "air", case / "20" / "air")
    (case / "20" / "aluminium_6061").mkdir(parents=True)
    (case / "20" / "aluminium_6061" / "T").write_text("x", encoding="utf-8")
    report = write_case(load_spec(_inputs(tmp_path / "x", bcs=WALLS_FIXED, study=study, restart={"end_time": 40})), case)
    assert report["ok"], report
    both = ["walls", "air_to_aluminium_6061"]
    assert report["restart"] == {"from_time": 20.0, "end_time": 40.0, "walls_rewritten": {"air/nut": both, "air/omega": both}}
    assert set(boundary_entry_types(case / "20" / "air" / "nut").values()) == {"nutUSpaldingWallFunction"}
