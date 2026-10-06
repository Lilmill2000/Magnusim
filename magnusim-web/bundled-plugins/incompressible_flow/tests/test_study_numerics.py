"""F9: the study's Numerics preset (Robust / Accurate) and SIMPLEC reach the steady case.

Write checks run everywhere; the ``wsl`` tests run a few simpleFoam iterations of
each option on a small blockMesh channel in a fresh /tmp folder in WSL
(``pytest -m wsl -k numerics``).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from cfddesk.registry.analysis import write_run_case
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec
from test_turbulence_models import _project, channel_mesh  # noqa: F401  (fixture)
from wsl_tmp_case import log, run_steps

from incompressible_flow.analyses import build_incompressible_steady, build_incompressible_transient
from incompressible_flow.physics import (
    SIMPLEC_RELAX_P,
    SIMPLEC_RELAX_U,
    TURBULENCE_MODELS,
    physics_from_record,
    solved_turbulence_fields,
)

FIX = JS_PROJECT


def _write(tmp_path: Path, record: dict, *, transient: dict | None = None, mesh_dir: Path | None = None) -> Path:
    root = _project(tmp_path, record)
    spec = load_run_spec(root, run_id="run-n", require_mesh=False, n_procs=1, transient_override=transient)
    assert spec.ok, spec.error
    if mesh_dir is not None:
        spec.mesh_case_dir = mesh_dir
        spec.end_time = 5
        spec.write_interval = 5
    case = tmp_path / "case"
    assert write_run_case(spec, case)["ok"]
    return case


def _text(case: Path, rel: str) -> str:
    return (case / rel).read_text(encoding="utf-8")


def _block(text: str, name: str) -> str:
    m = re.search(rf"^{name}\s*\{{(.*?)^\}}", text, re.M | re.S)
    assert m, f"no {name} block"
    return m.group(1)


def test_record_reads_preset_and_simplec():
    ph = physics_from_record({})
    assert (ph.numerics, ph.simplec) == ("robust", False)
    ph = physics_from_record({"numerics_preset": "accurate", "simplec": True})
    assert (ph.numerics, ph.simplec) == ("accurate", True)
    assert (ph.solve_relax_u(), ph.solve_relax_p()) == (SIMPLEC_RELAX_U, SIMPLEC_RELAX_P)
    # Unknown text keeps the default; an on/off saved as text still reads.
    ph = physics_from_record({"numerics_preset": "fancy", "simplec": "true", "relax_u": 0.6})
    assert (ph.numerics, ph.simplec, ph.relax_u) == ("robust", True, 0.6)
    assert physics_from_record({"simplec": False}).simplec is False


def test_steady_schema_has_preset_and_simplec_and_hides_relaxation_under_simplec():
    fields = {f.key: f for f in build_incompressible_steady().numerics_schema}
    keys = list(fields)
    assert keys.index("numerics_preset") == 0
    assert keys.index("simplec") < keys.index("relax_u") < keys.index("relax_p")
    assert fields["numerics_preset"].default == "robust"
    assert fields["numerics_preset"].choice_labels == ("Robust", "Accurate")
    assert fields["simplec"].default is False and fields["simplec"].kind == "bool"
    assert fields["relax_u"].depends_on == {"simplec": False}
    assert fields["relax_p"].depends_on == {"simplec": False}
    # A transient study's numerics live in the run panel.
    assert build_incompressible_transient().numerics_schema == ()


def test_robust_default_writes_todays_schemes(tmp_path):
    schemes = _text(_write(tmp_path, {}), "system/fvSchemes")
    assert "grad(U)         cellLimited Gauss linear 1;" in schemes
    assert re.search(r"grad\(k\)\s+cellLimited Gauss linear 1;", schemes)
    assert re.search(r"div\(phi,k\)\s+bounded Gauss upwind;", schemes)
    assert "laplacianSchemes { default Gauss linear limited corrected 0.5; }" in schemes
    assert "snGradSchemes { default limited corrected 0.5; }" in schemes
    solution = _text(_write(tmp_path / "b", {"numerics_preset": "robust"}), "system/fvSolution")
    assert "consistent      no;" in solution


@pytest.mark.parametrize("model", [m for m in TURBULENCE_MODELS if m != "laminar"])
def test_accurate_writes_second_order_turbulence_and_lighter_limiting(tmp_path, model):
    case = _write(tmp_path, {"turbulence_model": model, "numerics_preset": "accurate"})
    schemes = _text(case, "system/fvSchemes")
    assert "grad(U)         cellMDLimited Gauss linear 0.5;" in schemes
    assert "cellLimited" not in schemes
    assert "div(phi,U)      bounded Gauss linearUpwind grad(U);" in schemes
    assert "bounded Gauss upwind" not in schemes
    # Every solved turbulence field (k, epsilon or omega, R, Spalart-Allmaras's nuTilda).
    for name in solved_turbulence_fields(model):
        assert re.search(rf"div\(phi,{name}\)\s+bounded Gauss limitedLinear 1;", schemes), name
    assert "laplacianSchemes { default Gauss linear corrected; }" in schemes
    assert "snGradSchemes { default corrected; }" in schemes
    sidecar = json.loads(_text(case, "w27-case.json"))
    assert sidecar["numerics"]["preset"] == "accurate"


def test_accurate_does_not_change_a_transient_case(tmp_path):
    transient = {"end_time": 0.002, "delta_t": 0.001, "time_step_mode": "fixed", "write_count": 1}
    rec = {"time_dependency": "Transient"}
    plain = _text(_write(tmp_path / "a", rec, transient=transient), "system/fvSchemes")
    accurate = _text(
        _write(tmp_path / "b", {**rec, "numerics_preset": "accurate", "simplec": True}, transient=transient),
        "system/fvSchemes",
    )
    assert plain == accurate
    sol = _text(_write(tmp_path / "c", {**rec, "simplec": True}, transient=transient), "system/fvSolution")
    assert "consistent          no;" in sol


def test_simplec_writes_consistent_and_its_own_relaxation(tmp_path):
    case = _write(tmp_path, {"simplec": True, "relax_u": 0.5, "relax_p": 0.2})
    solution = _text(case, "system/fvSolution")
    simple = _block(solution, "SIMPLE")
    assert re.search(r"consistent\s+yes;", simple)
    relax = _block(solution, "relaxationFactors")
    assert re.search(r"^\s+p\s+1;", relax, re.M)
    for name in ("U", "k", "omega"):
        assert re.search(rf"^\s+{name}\s+0\.9;", relax, re.M), name
    assert "0.5;" not in relax and "0.2;" not in relax
    numerics = json.loads(_text(case, "w27-case.json"))["numerics"]
    assert (numerics["simplec"], numerics["relax_u"], numerics["relax_p"]) == (True, 0.9, 1.0)


@pytest.mark.parametrize("model", ["LRR", "SSG"])
def test_simplec_keeps_a_reynolds_stress_models_lower_relaxation(tmp_path, model):
    # SIMPLEC's 0.9 is never above the model's own: a Reynolds-stress model keeps 0.5.
    case = _write(tmp_path, {"turbulence_model": model, "simplec": True})
    relax = _block(_text(case, "system/fvSolution"), "relaxationFactors")
    assert re.search(r"^\s+p\s+1;", relax, re.M)
    for name in ("U", "R", "epsilon"):
        assert re.search(rf"^\s+{name}\s+0\.5;", relax, re.M), name
    assert "0.9;" not in relax
    numerics = json.loads(_text(case, "w27-case.json"))["numerics"]
    assert (numerics["simplec"], numerics["relax_u"], numerics["relax_p"]) == (True, 0.5, 1.0)
    assert physics_from_record({"turbulence_model": "kEpsilon", "simplec": True}).solve_relax_u() == 0.9


def test_simplec_off_keeps_the_studys_relaxation(tmp_path):
    solution = _text(_write(tmp_path, {"simplec": False, "relax_u": 0.5, "relax_p": 0.2}), "system/fvSolution")
    assert re.search(r"consistent\s+no;", solution)
    assert re.search(r"^\s+p\s+0\.2;", solution, re.M)
    assert re.search(r"^\s+U\s+0\.5;", solution, re.M)


# --------------------------------------------------------------------------- WSL


def _converge(case: Path) -> str:
    code = run_steps(case, ["simpleFoam"])
    text = log(case, "simpleFoam")
    assert code == 0, text[-3000:]
    assert "FOAM FATAL" not in text, text[-3000:]
    assert re.search(r"^End\s*$", text, re.M), text[-3000:]
    assert (case / "5" / "U").is_file()
    return text


@pytest.mark.wsl
@pytest.mark.parametrize("model", ["kOmegaSST", "kEpsilon", "LRR", "laminar"])
def test_accurate_runs_in_wsl(tmp_path, channel_mesh, model):  # noqa: F811
    case = _write(tmp_path, {"turbulence_model": model, "numerics_preset": "accurate"}, mesh_dir=channel_mesh)
    text = _converge(case)
    assert re.search(r"^Time = 5\s*$", text, re.M)


@pytest.mark.wsl
def test_simplec_with_lrr_runs_in_wsl(tmp_path, channel_mesh):  # noqa: F811
    case = _write(tmp_path, {"turbulence_model": "LRR", "simplec": True}, mesh_dir=channel_mesh)
    relax = _block(_text(case, "system/fvSolution"), "relaxationFactors")
    assert re.search(r"^\s+U\s+0\.5;", relax, re.M)
    text = _converge(case)
    assert re.search(r"^Time = 5\s*$", text, re.M)
    assert re.search(r"Solving for R", text)


@pytest.mark.wsl
def test_simplec_runs_in_wsl(tmp_path, channel_mesh):  # noqa: F811
    case = _write(tmp_path, {"simplec": True}, mesh_dir=channel_mesh)
    text = _converge(case)
    assert re.search(r"^Time = 5\s*$", text, re.M)
    assert re.search(r"Solving for p,", text)
