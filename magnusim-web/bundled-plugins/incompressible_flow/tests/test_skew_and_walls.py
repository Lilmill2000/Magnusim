"""The velocity gradient and the flux are skew-corrected (but for k-omega SST on a Standard mesh), and
k-omega SST's walls take Spalding's law (the validation set's pipes, 2026-11-06 and -07:
validation/README.md).

- Steady and transient: ``grad(U)`` is the study's gradient limiter on ``Gauss skewCorrected linear``
  (``cellLimited Gauss skewCorrected linear 1`` under Robust, ``Gauss skewCorrected linear`` with the
  limiter None), which linearUpwind, the viscous terms and the turbulence production read; the
  turbulence fields' gradients take the limiter on ``Gauss linear``; ``flux(HbyA)`` is interpolated
  ``skewCorrected linear``. No ``limitedGradU``.
- k-omega SST on a Standard mesh (its mesh facts' mesher) is written without them: ``grad(U)`` the
  limiter on ``Gauss linear`` and no flux entry (the validation pipe read its friction further off
  with them there); k-epsilon and laminar studies on Standard keep them.
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

from incompressible_flow import writer as if_writer
from incompressible_flow.physics import solved_turbulence_fields
from incompressible_flow.precheck import run_check
from incompressible_flow.writer import (
    mesher_of,
    skew_corrected,
    wall_functions,
    wall_treatment_words,
)

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
def test_the_limiter_is_on_the_skew_corrected_velocity_gradient(tmp_path: Path, record, transient, limited, turb):
    schemes = _text(_write(tmp_path, record, transient), "system/fvSchemes")
    assert _grad(schemes, "grad(U)") == limited
    assert _grad(schemes, "limitedGradU") is None and "limitedGradU" not in schemes
    assert _grad(schemes, "grad(k)") == turb and _grad(schemes, "grad(omega)") == turb
    bounded = "" if transient else "bounded "
    assert f"div(phi,U)      {bounded}Gauss linearUpwind grad(U);" in schemes
    assert "interpolationSchemes { default linear; flux(HbyA) skewCorrected linear; }" in schemes
    # The viscous term's explicit part reads grad(U) too.
    assert "div((nuEff*dev2(T(grad(U))))) Gauss linear;" in schemes


@pytest.mark.parametrize("transient", [None, TRANSIENT])
def test_with_the_limiter_none_grad_u_is_skew_corrected_and_unlimited(tmp_path: Path, transient):
    schemes = _text(_write(tmp_path, {"grad_limiter": "none"}, transient), "system/fvSchemes")
    assert _grad(schemes, "grad(U)") == "Gauss skewCorrected linear"
    assert _grad(schemes, "limitedGradU") is None
    assert "Gauss linearUpwind grad(U);" in schemes
    assert "flux(HbyA) skewCorrected linear" in schemes


@pytest.mark.parametrize(("choice", "written"), [("first_order", "bounded Gauss upwind"), ("second_order_limited", "bounded Gauss limitedLinearV 1")])
def test_momentum_schemes_without_a_gradient_keep_the_limited_velocity_gradient(tmp_path: Path, choice, written):
    schemes = _text(_write(tmp_path, {"momentum_convection": choice}), "system/fvSchemes")
    assert f"div(phi,U)      {written};" in schemes
    # The viscous terms still read grad(U): the limiter on the skew-corrected gradient.
    assert _grad(schemes, "grad(U)") == "cellLimited Gauss skewCorrected linear 1"
    assert "limitedGradU" not in schemes and "linearUpwind" not in schemes


def test_skew_correction_is_left_out_only_for_k_omega_sst_on_a_standard_mesh():
    """The gate (writer.skew_corrected): k-omega SST on Standard's tetrahedra is written with the plain
    lines; every other model on Standard, and every model on another mesher or before the mesh is known,
    with the skew-corrected ones."""
    assert skew_corrected("kOmegaSST", "standard") is False
    for model in ("laminar", "kEpsilon", "realizableKE", "SpalartAllmaras", "LRR", "SSG"):
        assert skew_corrected(model, "standard") is True, model
    for mesher in ("hexdominant", "snappy_hexdominant", "cfmesh", None, ""):
        assert skew_corrected("kOmegaSST", mesher) is True, mesher


def _standard_facts(spec) -> None:
    """Mesh facts saying the run's mesh is Standard's, stamped with its mesh (as the mesher keeps them)."""
    from magnusim_sdk import courant_rates
    from magnusim_sdk.mesh_facts import FACTS_FILE, FACTS_VERSION

    case = Path(spec.mesh_case_dir)
    stamp = courant_rates.mesh_stamp(case / "constant" / "polyMesh")
    (case / FACTS_FILE).write_text(json.dumps({"v": FACTS_VERSION, "mesher": "standard", "stamp": stamp}), encoding="utf-8")


@pytest.mark.parametrize("transient", [None, TRANSIENT])
def test_k_omega_sst_on_a_standard_mesh_is_written_with_the_plain_lines_and_says_so(tmp_path: Path, transient):
    spec = _spec(tmp_path, {"turbulence_model": "kOmegaSST"}, transient)
    _standard_facts(spec)
    assert mesher_of(spec) == "standard"
    case = tmp_path / "case"
    assert write_run_case(spec, case)["ok"]
    schemes = _text(case, "system/fvSchemes")
    assert _grad(schemes, "grad(U)") == "cellLimited Gauss linear 1"
    assert "skewCorrected" not in schemes and "limitedGradU" not in schemes
    assert "interpolationSchemes { default linear; }" in schemes
    bounded = "" if transient else "bounded "
    assert f"div(phi,U)      {bounded}Gauss linearUpwind grad(U);" in schemes
    rows = _rows(run_check(transient=transient is not None, spec=spec, settings=transient or {"end_time": 200}))
    assert rows["Schemes/Gradient limiter"] == "grad(U) cellLimited Gauss linear 1; grad(k), grad(omega) cellLimited Gauss linear 1"
    assert rows["Stays fixed/Velocity gradient"] == (
        "grad(U) Gauss linear inside the gradient limiter, not skew-corrected: k-omega SST on a Standard mesh; "
        "linearUpwind, the viscous terms and turbulence production read it"
    )
    assert rows["Stays fixed/Flux interpolation"] == "linear, not skew-corrected: k-omega SST on a Standard mesh"


def test_k_epsilon_and_laminar_on_a_standard_mesh_keep_the_skew_corrected_lines(tmp_path: Path):
    for n, model in enumerate(("kEpsilon", "laminar")):
        spec = _spec(tmp_path / str(n), {"turbulence_model": model})
        _standard_facts(spec)
        case = tmp_path / f"case{n}"
        assert write_run_case(spec, case)["ok"]
        schemes = _text(case, "system/fvSchemes")
        assert _grad(schemes, "grad(U)") == "cellLimited Gauss skewCorrected linear 1", model
        assert "flux(HbyA) skewCorrected linear" in schemes, model


def test_a_mesh_without_facts_is_written_skew_corrected(tmp_path: Path):
    """When the mesh's mesher is not known (no facts beside it) every model is written skew-corrected."""
    spec = _spec(tmp_path, {"turbulence_model": "kOmegaSST"})
    assert mesher_of(spec) is None
    assert if_writer.skew_corrected("kOmegaSST", mesher_of(spec)) is True
    schemes = _text(_write(tmp_path / "w", {"turbulence_model": "kOmegaSST"}), "system/fvSchemes")
    assert _grad(schemes, "grad(U)") == "cellLimited Gauss skewCorrected linear 1"


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
    assert rows["Schemes/Gradient limiter"] == "grad(U) cellLimited Gauss skewCorrected linear 1; grad(k), grad(omega) cellLimited Gauss linear 1"
    assert rows["Schemes/Momentum convection"] == "bounded Gauss linearUpwind grad(U)"
    assert rows["Stays fixed/Velocity gradient"] == (
        "grad(U) skew-corrected (Gauss skewCorrected linear) inside the gradient limiter; "
        "linearUpwind, the viscous terms and turbulence production read it"
    )
    assert rows["Stays fixed/Flux interpolation"] == "flux(HbyA) skewCorrected linear; the rest linear"
    assert rows["Stays fixed/Wall treatment"] == "nut nutUSpaldingWallFunction, k kqRWallFunction, omega omegaWallFunction (stepwise)"
    ke = _rows(run_check(transient=False, spec=_spec(tmp_path / "b", {"turbulence_model": "kEpsilon"}), settings={"end_time": 200}))
    assert ke["Stays fixed/Wall treatment"] == "nut nutkWallFunction, k kqRWallFunction, epsilon epsilonWallFunction"
    lam = _rows(run_check(transient=False, spec=_spec(tmp_path / "c", {"turbulence_model": "laminar", "grad_limiter": "none"}), settings={"end_time": 200}))
    assert "Stays fixed/Wall treatment" not in lam
    assert lam["Schemes/Gradient limiter"] == "grad(U) Gauss skewCorrected linear"
    assert lam["Schemes/Momentum convection"] == "bounded Gauss linearUpwind grad(U)"
    assert lam["Stays fixed/Velocity gradient"] == "grad(U) skew-corrected (Gauss skewCorrected linear) inside the gradient limiter; linearUpwind and the viscous terms read it"
    tr = _rows(run_check(transient=True, spec=_spec(tmp_path / "d", {"turbulence_model": "kOmegaSST"}, TRANSIENT), settings=TRANSIENT))
    assert tr["Schemes/Momentum convection"] == "Gauss linearUpwind grad(U)"
    assert tr["Stays fixed/Velocity gradient"].startswith("grad(U) skew-corrected (Gauss skewCorrected linear)")


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


def test_the_model_help_says_what_the_probes_show_of_the_stress_limiter_not_how_it_acts():
    """With the limiter off (b1 0) Standard's developed pipe read +12.6 % against the clean wedge's
    +11.1 %: the limiter is involved; how it cuts nut on the tetrahedra is inferred, not shown."""
    text = _model_help()
    assert ("developed on Standard it read about 14 % low, and about as high as on a clean mesh with SST's stress limiter "
            "off (probed with skew-corrected schemes), so the limiter is involved, though how is not known.") in text
    assert "uneven strain rate" not in text


def test_the_model_help_says_what_a_pipe_from_an_inlet_reads_on_each_mesher():
    """The validation pipe from its uniform inlet, as the app writes it now (2026-11-07 probes): within
    about 4 % on Hex-dominant (-4.2 %, -3.0 % Accurate; -3.7 %, -2.8 % Robust), 11 to 18 % low on Standard
    with layers (-10.9 % and -13.8 % Robust, -17.6 % and -17.2 % Accurate) and up to 31 % low without
    (0.0 % and -9.9 % Robust, -31 % and -28 % Accurate): not the developed pipe's 9 % alone."""
    text = _model_help()
    assert ("A pipe from a uniform inlet read its friction within about 4 % on Hex-dominant, but on Standard's tetrahedra "
            "11 to 18 % low with wall layers and up to about 31 % low with none (0 to 10 % with the Robust preset)") in text
    assert "about 9 % low" not in text
