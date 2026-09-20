"""Golden-file tests for cfddesk.case.writer.write_simplefoam_case.

CI runs the non-occt path (``not occt``): project fixture + vector inlet so STEP
is not required. The optional ``@pytest.mark.occt`` test still exercises the
face-normal path when cadquery-ocp + elbow.step are available.
"""
from __future__ import annotations

import copy
from dataclasses import replace
from pathlib import Path

import pytest

from cfddesk.case.writer import assert_guardrails, write_simplefoam_case
from cfddesk.project.model import Project
from tests.conftest import GOLDEN, compare_or_update

FILES = (
    "controlDict",
    "fvSchemes",
    "fvSolution",
    "transportProperties",
    "turbulenceProperties",
    "U",
    "p",
    "k",
    "omega",
    "nut",
)

# Face-normal inlet velocity from the OCCT-captured steady_cpu/U golden.
# Used with direction_mode=vector so CI can reproduce U without STEP.
_GOLDEN_INLET_U = (-0.139148, -0.462484, 0.12941)


def _proj_backend(doc: dict, backend: str) -> Project:
    proj = Project.from_dict(doc)
    sims = [replace(s, solver=replace(s.solver, backend=backend)) for s in proj.simulations]
    return replace(proj, simulations=sims)


def _doc_vector_inlet(doc: dict) -> dict:
    """Mutate a copy so velocity inlet uses components (no solid/STEP)."""
    out = copy.deepcopy(doc)
    for sim in out.get("simulations") or []:
        for bc in sim.get("boundary_conditions") or []:
            if bc.get("type") == "velocity_inlet_fixed":
                settings = dict(bc.get("settings") or {})
                settings["direction_mode"] = "vector"
                settings["velocity"] = list(_GOLDEN_INLET_U)
                bc["settings"] = settings
    return out


def _mapping(case_dir: Path) -> dict[str, Path]:
    return {
        "controlDict": case_dir / "system" / "controlDict",
        "fvSchemes": case_dir / "system" / "fvSchemes",
        "fvSolution": case_dir / "system" / "fvSolution",
        "transportProperties": case_dir / "constant" / "transportProperties",
        "turbulenceProperties": case_dir / "constant" / "turbulenceProperties",
        "U": case_dir / "0" / "U",
        "p": case_dir / "0" / "p",
        "k": case_dir / "0" / "k",
        "omega": case_dir / "0" / "omega",
        "nut": case_dir / "0" / "nut",
    }


def _amgx_json() -> Path:
    return Path(__file__).resolve().parents[1] / "fixtures" / "amgx_options.json"


@pytest.mark.parametrize("backend,folder", [("cpu", "steady_cpu"), ("amgx", "steady_amgx")])
def test_write_simplefoam_matches_golden_no_occt(
    tmp_case_dir, sample_project_dict, update_golden, backend, folder
):
    """CI path: no STEP / OCCT. Vector inlet reproduces golden U."""
    doc = _doc_vector_inlet(sample_project_dict)
    proj = _proj_backend(doc, backend)
    write_simplefoam_case(
        tmp_case_dir,
        amgx_json=_amgx_json(),
        default_backend=backend,
        project=proj,
        solid=None,
        turbulence="kOmegaSST",
        turbulence_intensity_pct=5.0,
    )
    mapping = _mapping(tmp_case_dir)
    gdir = GOLDEN / folder
    for name in FILES:
        compare_or_update(mapping[name], gdir / name, update=update_golden)
    report = assert_guardrails(tmp_case_dir)
    assert report.ok
    assert report.amgx_on_p is (backend == "amgx")


@pytest.mark.occt
@pytest.mark.parametrize("backend,folder", [("cpu", "steady_cpu"), ("amgx", "steady_amgx")])
def test_write_simplefoam_matches_golden_occt(
    tmp_case_dir, sample_project_dict, elbow_step_path, update_golden, backend, folder
):
    """Optional: STEP face-normal inlet (skipped under CI ``not occt``)."""
    from cfddesk.cad.step import load_step

    proj = _proj_backend(sample_project_dict, backend)
    solid = load_step(elbow_step_path)
    write_simplefoam_case(
        tmp_case_dir,
        amgx_json=_amgx_json(),
        default_backend=backend,
        project=proj,
        solid=solid,
        turbulence="kOmegaSST",
        turbulence_intensity_pct=5.0,
    )
    mapping = _mapping(tmp_case_dir)
    gdir = GOLDEN / folder
    for name in FILES:
        compare_or_update(mapping[name], gdir / name, update=update_golden)
    report = assert_guardrails(tmp_case_dir)
    assert report.ok
    assert report.amgx_on_p is (backend == "amgx")
