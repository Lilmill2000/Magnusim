"""RH3 (run health spec 5.3): numerics at Continue in Incompressible Flow.

A Continue writes its case with the numerics it goes on with: the core puts its restart's
``numerics`` over the study record (``cfddesk.project.run_inputs``), and the writer reads them
through its usual parse, with no writer change:

- "Continue as it was": the relaxation the run started with, though the study now has another;
- "Continue with the new numerics": the study's, and a blank one is the preset's again;
- a run with no record (started before RH3) sends none: the study's, as before;
- a stopped run's Max Courant that waited for its Continue (A2's ``at_continue``) is in the
  continued case's controlDict, with its outer correctors in fvSolution.

The prepare job's ``--restart`` keeps ``numerics`` (``run_case.restart_arg``).
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest
from cfddesk.registry import load_all, reset_for_tests, run_case
from cfddesk.registry.analysis import write_run_case
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec


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


def _save(case: Path, t: str) -> None:
    (case / t).mkdir()
    for f in ("U", "p", "k", "omega", "nut"):
        (case / t / f).write_text(f"saved {t}\n", encoding="utf-8")


def _relaxation(case: Path) -> dict[str, str]:
    text = (case / "system" / "fvSolution").read_text(encoding="utf-8")
    block = text[text.index("relaxationFactors") :]
    return dict(re.findall(r"\n\s+(\w+)\s+([0-9.eE+-]+);", block))


def _entry(text: str, key: str) -> str:
    return next(line.split(None, 1)[1].strip().rstrip(";") for line in text.splitlines() if line.strip().startswith(key + " "))


def _continued(tmp_path: Path, study: dict, numerics: dict | None) -> tuple[Path, object]:
    """A steady run written, saved at iteration 100, then continued to 200 with ``numerics``."""
    root = _project(tmp_path, study)
    case = tmp_path / "case"
    first = load_run_spec(root, run_id="run-c", require_mesh=False, n_procs=1)
    assert first.ok, first.error
    assert write_run_case(first, case)["ok"]
    _save(case, "100")
    restart: dict = {"end_time": 200, "write_interval": 50}
    if numerics is not None:
        restart["numerics"] = numerics
    spec = load_run_spec(root, run_id="run-c", require_mesh=False, n_procs=1, restart=restart)
    assert spec.ok, spec.error
    report = write_run_case(spec, case)
    assert report["ok"], report
    assert report["restart"] == {"from_time": 100.0, "end_time": 200.0}
    return case, spec


def test_as_it_was_writes_the_relaxation_the_run_started_with(tmp_path: Path):
    # Started with relaxation p 0.3 and U blank; the study now has p 0.2 and U 0.5.
    case, spec = _continued(tmp_path, {"relax_p": 0.2, "relax_u": 0.5}, {"relax_p": 0.3, "relax_u": None})
    relax = _relaxation(case)
    assert (relax["p"], relax["U"]) == ("0.3", "0.7")
    # The core put them over the study record; the restart the writer reads holds none.
    assert "numerics" not in (spec.restart or {})
    assert spec.restart == {"end_time": 200, "write_interval": 50}


def test_the_new_numerics_write_the_studys(tmp_path: Path):
    case, _spec = _continued(tmp_path, {"relax_p": 0.2, "relax_u": 0.5}, {"relax_p": 0.2, "relax_u": 0.5})
    relax = _relaxation(case)
    assert (relax["p"], relax["U"]) == ("0.2", "0.5")


def test_a_run_with_no_record_continues_with_the_studys_numerics(tmp_path: Path):
    case, _spec = _continued(tmp_path, {"relax_p": 0.2}, None)
    assert _relaxation(case)["p"] == "0.2"


def test_the_prepare_jobs_restart_keeps_the_numerics():
    text = json.dumps({"end_time": 200, "write_interval": 50, "numerics": {"relax_p": 0.3, "grad_limiter": None}})
    assert run_case.restart_arg(text) == {"end_time": 200.0, "write_interval": 50.0, "numerics": {"relax_p": 0.3, "grad_limiter": None}}
    assert run_case.restart_arg(json.dumps({"end_time": 200})) == {"end_time": 200.0, "write_interval": None}
    with pytest.raises(ValueError, match="numerics"):
        run_case.restart_arg(json.dumps({"end_time": 200, "numerics": [1]}))
    with pytest.raises(ValueError, match="numerics"):
        run_case.restart_arg(json.dumps({"end_time": 200, "numerics": {"relax_p": {"x": 1}}}))


def test_a_stopped_runs_max_courant_that_waited_for_continue_is_written_on_continue(tmp_path: Path):
    # A2: Max Courant 100 -> 5 and 1 -> 3 outer correctors waited for Continue (the run's transient
    # block holds them, at_continue); the continued case is written with them.
    root = _project(tmp_path, {"time_dependency": "Transient"})
    case = tmp_path / "case"
    solved = {"end_time": 1, "write_count": 10, "max_co": 100, "n_outer_correctors": 1, "n_correctors": 2}
    first = load_run_spec(root, run_id="run-t", require_mesh=False, n_procs=1, transient_override=solved)
    assert first.ok, first.error
    assert write_run_case(first, case)["ok"]
    assert _entry((case / "system" / "controlDict").read_text(encoding="utf-8"), "maxCo") == "100"
    _save(case, "0.5")
    waited = {**solved, "end_time": 2, "max_co": 5, "n_outer_correctors": 3}
    spec = load_run_spec(
        root,
        run_id="run-t",
        require_mesh=False,
        n_procs=1,
        transient_override=waited,
        restart={"end_time": 2, "write_interval": 0.1, "numerics": {"momentum_convection": None}},
    )
    assert spec.ok, spec.error
    report = write_run_case(spec, case)
    assert report["ok"] and report["restart"] == {"from_time": 0.5, "end_time": 2.0}
    control = (case / "system" / "controlDict").read_text(encoding="utf-8")
    assert (_entry(control, "startFrom"), _entry(control, "maxCo")) == ("latestTime", "5")
    assert _entry((case / "system" / "fvSolution").read_text(encoding="utf-8"), "nOuterCorrectors") == "3"
