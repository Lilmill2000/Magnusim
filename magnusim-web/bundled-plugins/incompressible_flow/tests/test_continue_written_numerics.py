"""What a run solved with, for new, older and continued runs (RH3; the validation set's pipes,
2026-11-06, changed the writer: skew-corrected flux(HbyA) and grad(U), limitedGradU, and k-omega
SST's walls with Spalding's law and stepwise omega).

- A Start's plan carries "Numerics as written" of the case as it writes it (``numerics``); the
  core records it on the run (numerics_used.written), so the Run panel and the Assistant show
  what the run solved with, not what a later writer would write.
- A Continue that goes on with the numerics the run had (``restart.keep_numerics``: "as it was",
  or nothing changed) keeps the run's own fvSchemes and the walls its saved time holds, and its
  plan carries no rows (the run's record stays).
- A Continue with the study's new numerics writes fvSchemes afresh and gives the saved time's wall
  patches the writer's entries (their saved values kept), so the case matches the rows its plan
  carries.

The saved time here holds what a run started before the change saved: nutkWallFunction on the
walls, omegaWallFunction without stepwise blending, and plain linear fvSchemes.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.analysis import plan_run_case, write_run_case
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec
from magnusim_sdk.foam import boundary_entry_types

from incompressible_flow.precheck import run_check

OLD_SCHEMES_MARK = "// written before the skew-corrected schemes"


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _project(tmp_path: Path, record: dict) -> Path:
    root = tmp_path / "project"
    shutil.copytree(JS_PROJECT, root)
    rec = {"id": "sim_1", "name": "Incompressible", "time_dependency": "Steady-state", **record}
    (root / "simulation.json").write_text(json.dumps(rec), encoding="utf-8")
    (root / "simulations.json").write_text(json.dumps({"active_id": "sim_1", "simulations": [rec]}), encoding="utf-8")
    return root


BOUNDARY = """FoamFile
{
    version     2.0;
    format      ascii;
    class       polyBoundaryMesh;
    object      boundary;
}
3
(
    walls
    {
        type            wall;
        nFaces          40;
        startFace       100;
    }
    velocity_inlet_1
    {
        type            patch;
        nFaces          4;
        startFace       140;
    }
    pressure_1
    {
        type            patch;
        nFaces          4;
        startFace       144;
    }
)
"""


def _older_saved_time(case: Path, t: str = "100") -> None:
    """A saved time as a run written before the change saved it: its walls nutkWallFunction and
    omegaWallFunction without blending (values kept as saved), and its fvSchemes plain linear;
    the mesh it solved on kept beside them, as a continued run's is."""
    poly = case / "constant" / "polyMesh"
    poly.mkdir(parents=True, exist_ok=True)
    (poly / "boundary").write_text(BOUNDARY, encoding="utf-8")
    (poly / "owner").write_text("owner\n", encoding="utf-8")
    (case / t).mkdir()
    for f in ("U", "p", "k"):
        shutil.copy(case / "0" / f, case / t / f)
    nut = (case / "0" / "nut").read_text(encoding="utf-8").replace("nutUSpaldingWallFunction", "nutkWallFunction")
    (case / t / "nut").write_text(nut.replace("value          uniform 0;", "value          uniform 0.0042;"), encoding="utf-8")
    omega = (case / "0" / "omega").read_text(encoding="utf-8")
    (case / t / "omega").write_text(re.sub(r"\n\s*blending\s+stepwise;", "", omega), encoding="utf-8")
    schemes = (case / "system" / "fvSchemes").read_text(encoding="utf-8")
    old = schemes.replace("Gauss skewCorrected linear", "cellLimited Gauss linear 1").replace(
        "flux(HbyA) skewCorrected linear;", ""
    )
    (case / "system" / "fvSchemes").write_text(old + OLD_SCHEMES_MARK + "\n", encoding="utf-8")


def _continued(tmp_path: Path, *, keep: bool) -> tuple[Path, dict, dict]:
    root = _project(tmp_path, {"turbulence_model": "kOmegaSST"})
    case = tmp_path / "case"
    first = load_run_spec(root, run_id="run-c", require_mesh=False, n_procs=1)
    assert first.ok, first.error
    assert write_run_case(first, case)["ok"]
    _older_saved_time(case)
    restart: dict = {"end_time": 200, "write_interval": 50, "numerics": {"relax_p": None}}
    if keep:
        restart["keep_numerics"] = True
    spec = load_run_spec(root, run_id="run-c", require_mesh=False, n_procs=1, restart=restart)
    assert spec.ok, spec.error
    plan = plan_run_case(spec)
    report = write_run_case(spec, case)
    assert report["ok"], report
    return case, report, plan


def _wall_lines(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    m = re.search(r"\n    walls\n    \{(.*?)\n    \}", text, re.S)
    assert m, text
    return " ".join(m.group(1).split())


def test_a_starts_plan_carries_numerics_as_written_of_the_case_it_writes(tmp_path: Path):
    root = _project(tmp_path, {"turbulence_model": "kOmegaSST"})
    spec = load_run_spec(root, run_id="run-s", require_mesh=False, n_procs=1)
    rows = {f"{r['group']}/{r['label']}": r["value"] for r in plan_run_case(spec)["numerics"]}
    assert rows["Stays fixed/Wall treatment"] == "nut nutUSpaldingWallFunction, k kqRWallFunction, omega omegaWallFunction (stepwise)"
    assert rows["Stays fixed/Flux interpolation"] == "flux(HbyA) skewCorrected linear; the rest linear"
    # The same rows the Run panel's check gives for that case.
    check = run_check(transient=False, spec=spec, settings={"end_time": spec.end_time, "write_interval": spec.write_interval})
    assert plan_run_case(spec)["numerics"] == check["numerics"]


def test_a_continue_as_it_was_keeps_the_runs_schemes_and_saved_walls(tmp_path: Path):
    case, report, plan = _continued(tmp_path, keep=True)
    schemes = (case / "system" / "fvSchemes").read_text(encoding="utf-8")
    assert OLD_SCHEMES_MARK in schemes and "skewCorrected" not in schemes
    assert boundary_entry_types(case / "100" / "nut")["walls"] == "nutkWallFunction"
    assert "blending" not in _wall_lines(case / "100" / "omega")
    assert report["restart"] == {"from_time": 100.0, "end_time": 200.0, "kept_numerics": True}
    assert json.loads((case / "w27-case.json").read_text(encoding="utf-8"))["restart"]["kept_numerics"] is True
    # Its plan carries no rows: the run's record of what it was written with stays.
    assert "numerics" not in plan


def test_a_continue_with_new_numerics_writes_the_schemes_afresh_and_the_saved_walls_too(tmp_path: Path):
    case, report, plan = _continued(tmp_path, keep=False)
    schemes = (case / "system" / "fvSchemes").read_text(encoding="utf-8")
    assert OLD_SCHEMES_MARK not in schemes and "flux(HbyA) skewCorrected linear;" in schemes
    # The saved walls take the writer's entries, with the values the run saved.
    assert _wall_lines(case / "100" / "nut") == "type nutUSpaldingWallFunction; value uniform 0.0042;"
    assert _wall_lines(case / "100" / "omega").startswith("type omegaWallFunction; blending stepwise; value ")
    # The inlet keeps what the run saved there; k's walls were already the writer's.
    assert boundary_entry_types(case / "100" / "nut")["velocity_inlet_1"] == "calculated"
    assert report["restart"] == {"from_time": 100.0, "end_time": 200.0, "walls_rewritten": {"nut": ["walls"], "omega": ["walls"]}}
    # Its plan's rows are what the case now holds.
    rows = {f"{r['group']}/{r['label']}": r["value"] for r in plan["numerics"]}
    assert rows["Stays fixed/Wall treatment"] == "nut nutUSpaldingWallFunction, k kqRWallFunction, omega omegaWallFunction (stepwise)"
