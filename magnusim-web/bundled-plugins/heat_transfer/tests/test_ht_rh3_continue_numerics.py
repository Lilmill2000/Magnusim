"""RH3 (run health spec 5.3): numerics at Continue in Heat Transfer.

A Continue writes its case with the numerics it goes on with: the core puts its restart's
``numerics`` over the study record (``cfddesk.project.run_inputs.with_numerics``, as
``gather_run_inputs`` does), and the writer reads them through its usual parse, with no writer
change. "Continue as it was" keeps the p_rgh relaxation the run started with (0.3) while the study
now has 0.2; "Continue with the new numerics" writes the study's; a blank one is the preset's.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from cfddesk.project.run_inputs import with_numerics
from cfddesk.registry import load_all, reset_for_tests
from ht_inputs import make_inputs

from heat_transfer.runspec import load_spec
from heat_transfer.writer import write_case


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _continued(tmp_path: Path, study: dict, numerics: dict) -> str:
    """A steady run written, saved at iteration 100, then continued to 300 with ``numerics``; its fvSolution."""
    case = tmp_path / "case"
    first = load_spec(make_inputs(tmp_path, study=study))
    assert first.ok, first.error
    assert write_case(first, case)["ok"]
    (case / "100").mkdir()
    for f in ("T", "U", "p_rgh"):
        (case / "100" / f).write_text("x", encoding="utf-8")
    spec = load_spec(make_inputs(tmp_path, study=with_numerics(study, numerics), restart={"end_time": 300}))
    assert spec.ok, spec.error
    report = write_case(spec, case)
    assert report["ok"] and report["restart"] == {"from_time": 100.0, "end_time": 300.0}
    return (case / "system" / "fvSolution").read_text(encoding="utf-8")


def test_as_it_was_writes_the_p_rgh_relaxation_the_run_started_with(tmp_path: Path):
    # Started with p_rgh 0.3 and energy blank; the study now has 0.2 and 0.4.
    sol = _continued(tmp_path, {"relax_p": 0.2, "relax_h": 0.4}, {"relax_p": 0.3, "relax_h": None})
    assert "p_rgh           0.3;" in sol and "h               0.5;" in sol


def test_the_new_numerics_write_the_studys(tmp_path: Path):
    sol = _continued(tmp_path, {"relax_p": 0.2, "relax_h": 0.4}, {"relax_p": 0.2, "relax_h": 0.4})
    assert "p_rgh           0.2;" in sol and "h               0.4;" in sol
