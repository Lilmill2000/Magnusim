
"""Golden-file tests for cfddesk.case.writer.write_simplefoam_case."""
from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from cfddesk.cad.step import load_step
from cfddesk.case.writer import assert_guardrails, write_simplefoam_case
from cfddesk.project.model import Project

from tests.conftest import GOLDEN, PROJECTS, compare_or_update

pytestmark = pytest.mark.occt

FILES = (
    "controlDict", "fvSchemes", "fvSolution",
    "transportProperties", "turbulenceProperties",
    "U", "p", "k", "omega", "nut",
)


def _proj_backend(doc: dict, backend: str) -> Project:
    proj = Project.from_dict(doc)
    sims = [replace(s, solver=replace(s.solver, backend=backend)) for s in proj.simulations]
    return replace(proj, simulations=sims)


@pytest.mark.parametrize("backend,folder", [("cpu", "steady_cpu"), ("amgx", "steady_amgx")])
def test_write_simplefoam_matches_golden(tmp_case_dir, sample_project_dict, elbow_step_path, update_golden, backend, folder):
    proj = _proj_backend(sample_project_dict, backend)
    solid = load_step(elbow_step_path)
    amgx = Path(__file__).resolve().parents[1] / "fixtures" / "amgx_options.json"
    write_simplefoam_case(
        tmp_case_dir,
        amgx_json=amgx,
        default_backend=backend,
        project=proj,
        solid=solid,
        turbulence="kOmegaSST",
        turbulence_intensity_pct=5.0,
    )
    mapping = {
        "controlDict": tmp_case_dir / "system" / "controlDict",
        "fvSchemes": tmp_case_dir / "system" / "fvSchemes",
        "fvSolution": tmp_case_dir / "system" / "fvSolution",
        "transportProperties": tmp_case_dir / "constant" / "transportProperties",
        "turbulenceProperties": tmp_case_dir / "constant" / "turbulenceProperties",
        "U": tmp_case_dir / "0" / "U",
        "p": tmp_case_dir / "0" / "p",
        "k": tmp_case_dir / "0" / "k",
        "omega": tmp_case_dir / "0" / "omega",
        "nut": tmp_case_dir / "0" / "nut",
    }
    gdir = GOLDEN / folder
    for name in FILES:
        compare_or_update(mapping[name], gdir / name, update=update_golden)
    report = assert_guardrails(tmp_case_dir)
    assert report.ok
    assert report.amgx_on_p is (backend == "amgx")
