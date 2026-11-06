"""The velocity gradient and the flux are skew-corrected, and k-omega SST's walls take Spalding's law
(the validation set's pipes, 2026-11-06: validation/README.md).

- Steady and transient: ``grad(U)`` is ``Gauss skewCorrected linear`` and never limited (the viscous
  terms and the turbulence production read it); the study's gradient limiter is on the gradient
  momentum convection reads (``limitedGradU``, ``linearUpwind limitedGradU``) and on the turbulence
  fields' gradients; with the limiter None, linearUpwind reads ``grad(U)``; ``flux(HbyA)`` is
  interpolated ``skewCorrected linear``.
- A no-slip wall under k-omega SST: ``nutUSpaldingWallFunction`` and ``omegaWallFunction`` with
  ``blending stepwise``; k-epsilon keeps ``nutkWallFunction``; Spalart-Allmaras Spalding's law.
- "Numerics as written" says so: the Gradient limiter and Momentum convection rows as written, and
  the velocity gradient, the flux interpolation and the wall treatment under Stays fixed.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.analysis import write_run_case
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec

from incompressible_flow.physics import solved_turbulence_fields
from incompressible_flow.precheck import run_check
from incompressible_flow.writer import wall_functions, wall_treatment_words

TRANSIENT = {"end_time": 5, "write_count": 50, "max_co": 1, "n_outer_correctors": 1, "n_correctors": 2, "delta_t": 0.001, "max_delta_t": 0.1}


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _spec(tmp_path: Path, record: dict, transient: dict | None = None):
    root = tmp_path / "project"
    shutil.copytree(JS_PROJECT, root)
    rec = {"id": "sim_1", "name": "Incompressible", "time_dependency": "Transient" if transient else "Steady-state", **record}
    (root / "simulation.json").write_text(json.dumps(rec), encoding="utf-8")
    (root / "simulations.json").write_text(json.dumps({"active_id": "sim_1", "simulations": [rec]}), encoding="utf-8")
    spec = load_run_spec(root, run_id="run-n", require_mesh=False, n_procs=1, transient_override=transient)
    assert spec.ok, spec.error
    return spec


def _write(tmp_path: Path, record: dict, transient: dict | None = None) -> Path:
    case = tmp_path / "case"
    assert write_run_case(_spec(tmp_path, record, transient), case)["ok"]
    return case


def _text(case: Path, rel: str) -> str:
    return (case / rel).read_text(encoding="utf-8")


def _grad(schemes: str, name: str) -> str | None:
    m = re.search(rf"^    {re.escape(name)}\s+(.+);$", schemes, re.M)
    return m.group(1) if m else None


def _wall(text: str, patch: str = "walls") -> str:
    m = re.search(rf"^\s*{re.escape(patch)}\s*\n\s*\{{(.*?)\}}", text, re.M | re.S)
    assert m, f"no {patch} entry"
    return " ".join(m.group(1).split())


@pytest.mark.parametrize(
    ("record", "transient", "limited", "turb"),
    [
        ({}, None, "cellLimited Gauss skewCorrected linear 1", "cellLimited Gauss linear 1"),
        ({"numerics_preset": "accurate"}, None, "cellMDLimited Gauss skewCorrected linear 0.5", "cellMDLimited Gauss linear 0.5"),
        ({"grad_limiter": "light"}, None, "cellMDLimited Gauss skewCorrected linear 0.5", "cellMDLimited Gauss linear 0.5"),
        ({}, TRANSIENT, "cellLimited Gauss skewCorrected linear 1", "cellLimited Gauss linear 1"),
        ({"grad_limiter": "light"}, TRANSIENT, "cellMDLimited Gauss skewCorrected linear 0.5", "cellMDLimited Gauss linear 0.5"),
    ],
)
def test_the_limiter_is_on_the_convection_gradient_and_grad_u_is_skew_corrected(tmp_path: Path, record, transient, limited, turb):
    schemes = _text(_write(tmp_path, record, transient), "system/fvSchemes")
    assert _grad(schemes, "grad(U)") == "Gauss skewCorrected linear"
    assert _grad(schemes, "limitedGradU") == limited
    assert _grad(schemes, "grad(k)") == turb and _grad(schemes, "grad(omega)") == turb
    bounded = "" if transient else "bounded "
    assert f"div(phi,U)      {bounded}Gauss linearUpwind limitedGradU;" in schemes
    assert "interpolationSchemes { default linear; flux(HbyA) skewCorrected linear; }" in schemes
    # The viscous term's explicit part reads grad(U) (the unlimited one).
    assert "div((nuEff*dev2(T(grad(U))))) Gauss linear;" in schemes


@pytest.mark.parametrize("transient", [None, TRANSIENT])
def test_with_the_limiter_none_linear_upwind_reads_grad_u(tmp_path: Path, transient):
    schemes = _text(_write(tmp_path, {"grad_limiter": "none"}, transient), "system/fvSchemes")
    assert _grad(schemes, "grad(U)") == "Gauss skewCorrected linear"
    assert _grad(schemes, "limitedGradU") is None
    assert "Gauss linearUpwind grad(U);" in schemes
    assert "flux(HbyA) skewCorrected linear" in schemes


@pytest.mark.parametrize(("choice", "written"), [("first_order", "bounded Gauss upwind"), ("second_order_limited", "bounded Gauss limitedLinearV 1")])
def test_momentum_schemes_without_a_gradient_read_no_convection_gradient(tmp_path: Path, choice, written):
    schemes = _text(_write(tmp_path, {"momentum_convection": choice}), "system/fvSchemes")
    assert f"div(phi,U)      {written};" in schemes
    assert _grad(schemes, "grad(U)") == "Gauss skewCorrected linear"
    # Nothing reads a limited velocity gradient, so none is written.
    assert _grad(schemes, "limitedGradU") is None and "linearUpwind" not in schemes


def test_k_omega_sst_walls_take_spaldings_law_and_stepwise_omega(tmp_path: Path):
    case = _write(tmp_path, {"turbulence_model": "kOmegaSST"})
    assert _wall(_text(case, "0/nut")) == "type nutUSpaldingWallFunction; value uniform 0;"
    omega = _wall(_text(case, "0/omega"))
    assert omega.startswith("type omegaWallFunction; blending stepwise; value uniform ")
    assert _wall(_text(case, "0/k")).startswith("type kqRWallFunction; value uniform ")


@pytest.mark.parametrize("model", ["kEpsilon", "realizableKE"])
def test_k_epsilon_walls_keep_the_k_log_law(tmp_path: Path, model):
    case = _write(tmp_path, {"turbulence_model": model})
    assert _wall(_text(case, "0/nut")) == "type nutkWallFunction; value uniform 0;"
    assert _wall(_text(case, "0/epsilon")).startswith("type epsilonWallFunction; value uniform ")


def test_each_models_wall_entries():
    assert wall_functions("kOmegaSST")["nut"] == {"type": "nutUSpaldingWallFunction"}
    assert wall_functions("kOmegaSST")["omega"] == {"type": "omegaWallFunction", "blending": "stepwise"}
    assert wall_functions("SpalartAllmaras")["nut"] == {"type": "nutUSpaldingWallFunction"}
    for model in ("kEpsilon", "realizableKE", "LRR", "SSG"):
        assert wall_functions(model)["nut"] == {"type": "nutkWallFunction"}, model
        assert "blending" not in wall_functions(model)["omega"]
    assert wall_treatment_words("kOmegaSST") == "nut nutUSpaldingWallFunction, k kqRWallFunction, omega omegaWallFunction (stepwise)"
    assert wall_treatment_words("kEpsilon") == "nut nutkWallFunction, k kqRWallFunction, epsilon epsilonWallFunction"
    assert wall_treatment_words("laminar") == ""
    for model in ("LRR", "SSG", "SpalartAllmaras"):
        words = wall_treatment_words(model)
        assert words.startswith("nut nut"), (model, words)
        for f in solved_turbulence_fields(model):
            assert f in words, (model, f)


def _rows(out: dict) -> dict[str, str]:
    return {f"{r['group']}/{r['label']}": r["value"] for r in out["numerics"]}


def test_numerics_as_written_says_what_stays_fixed(tmp_path: Path):
    rows = _rows(run_check(transient=False, spec=_spec(tmp_path / "a", {"turbulence_model": "kOmegaSST"}), settings={"end_time": 200}))
    assert rows["Schemes/Gradient limiter"] == "limitedGradU cellLimited Gauss skewCorrected linear 1; grad(k), grad(omega) cellLimited Gauss linear 1"
    assert rows["Schemes/Momentum convection"] == "bounded Gauss linearUpwind limitedGradU"
    assert rows["Stays fixed/Velocity gradient"] == "grad(U) Gauss skewCorrected linear, never limited (the viscous terms and turbulence production)"
    assert rows["Stays fixed/Flux interpolation"] == "flux(HbyA) skewCorrected linear; the rest linear"
    assert rows["Stays fixed/Wall treatment"] == "nut nutUSpaldingWallFunction, k kqRWallFunction, omega omegaWallFunction (stepwise)"
    ke = _rows(run_check(transient=False, spec=_spec(tmp_path / "b", {"turbulence_model": "kEpsilon"}), settings={"end_time": 200}))
    assert ke["Stays fixed/Wall treatment"] == "nut nutkWallFunction, k kqRWallFunction, epsilon epsilonWallFunction"
    lam = _rows(run_check(transient=False, spec=_spec(tmp_path / "c", {"turbulence_model": "laminar", "grad_limiter": "none"}), settings={"end_time": 200}))
    assert "Stays fixed/Wall treatment" not in lam
    assert lam["Schemes/Gradient limiter"] == "linearUpwind reads grad(U) (Gauss skewCorrected linear, unlimited)"
    assert lam["Schemes/Momentum convection"] == "bounded Gauss linearUpwind grad(U)"
    tr = _rows(run_check(transient=True, spec=_spec(tmp_path / "d", {"turbulence_model": "kOmegaSST"}, TRANSIENT), settings=TRANSIENT))
    assert tr["Schemes/Momentum convection"] == "Gauss linearUpwind limitedGradU"
    assert tr["Stays fixed/Velocity gradient"].startswith("grad(U) Gauss skewCorrected linear")


def _model_help() -> str:
    from incompressible_flow.analyses import _settings_schema

    return next(f for f in _settings_schema() if f.key == "turbulence_model").description


def test_the_model_help_gives_only_the_y_plus_that_were_tested():
    """The Study panel's model help (and the Assistant's catalog, from the same schema) says what the
    clean developed wedge read at the y+ that were run, not "below about 0.5 resolves the wall" (one
    run at y+ 0.3) and not "any y+" for Spalart-Allmaras (its walls were not tested)."""
    text = _model_help()
    assert ("With its walls (Spalding's law) a developed pipe on a clean mesh read its friction within about 2 % with "
            "the first cell's centre at y+ 5 to 15 and within 4.5 % up to y+ 100, but 6 to 9 % low at y+ 1 to 3; below "
            "y+ 1 only y+ 0.3 was tested (1.5 % low).") in text
    assert "Spalart-Allmaras solves one equation and suits flow around wings and bodies in a freestream; how its walls read was not tested." in text
    for untested in ("any y+", "below about 0.5", "resolve the wall"):
        assert untested not in text, untested
