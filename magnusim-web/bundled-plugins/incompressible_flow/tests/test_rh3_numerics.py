"""RH3 (run health, spec 5.1-5.9): numerics as settings in Incompressible Flow.

- Each study key (schemes, linear solvers, turbulence relaxation, velocity limit) and each run
  key (outer relaxation, outer tolerance): its field's bounds, its round trip through the study
  record or the run's transient block, and the fixed OpenFOAM string the case is written with.
- Blank is today: the goldens (test_write_case_golden, test_prepare_run_golden) prove it.
- Bounds apply only to an edit: a stored value outside its range is written as saved, kept
  when another key is edited, never refused by validate_ready, and listed by the pre-run
  check's setting_out_of_range.
- "Numerics as written" names what the case is written with, the velocity limit with its
  numbers.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest
from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.analysis import write_run_case
from cfddesk.registry.discovery import get_registry
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec
from magnusim_sdk.numerics_settings import BOUNDS, CAUTION_FIRST_ORDER, CAUTION_LIMIT_OFF

from incompressible_flow.analyses import build_incompressible_steady, build_incompressible_transient
from incompressible_flow.physics import physics_from_record
from incompressible_flow.precheck import run_check
from incompressible_flow.transient import normalize_transient, resolve_transient_control

TRANSIENT = {"end_time": 5, "write_count": 50, "max_co": 1, "n_outer_correctors": 1, "n_correctors": 2, "delta_t": 0.001, "max_delta_t": 0.1}


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


def _spec(tmp_path: Path, record: dict, transient: dict | None = None):
    root = _project(tmp_path, record)
    spec = load_run_spec(root, run_id="run-n", require_mesh=False, n_procs=1, transient_override=transient)
    assert spec.ok, spec.error
    return spec


def _write(tmp_path: Path, record: dict, transient: dict | None = None) -> Path:
    spec = _spec(tmp_path, record, transient)
    case = tmp_path / "case"
    assert write_run_case(spec, case)["ok"]
    return case


def _text(case: Path, rel: str) -> str:
    return (case / rel).read_text(encoding="utf-8")


def _entry(text: str, name: str) -> str:
    """The body of a dictionary entry `name { ... }` at 4 spaces (a solver)."""
    m = re.search(rf"\n    {re.escape(name)}\n    \{{\n(.*?)\n    \}}", text, re.S)
    assert m, f"no entry {name}"
    return m.group(1)


# ---------------------------------------------------------------------------
# The fields: bounds, cautions, advanced
# ---------------------------------------------------------------------------


def test_every_key_has_its_bounds_and_is_advanced():
    steady = {f.key: f for f in build_incompressible_steady().numerics_schema}
    transient = {f.key: f for f in build_incompressible_transient().numerics_schema}
    control = {f.key: f for f in build_incompressible_transient().control_schema}
    for key, (lo, hi) in BOUNDS.items():
        f = control[key] if key.startswith("outer_") else steady[key]
        assert (f.min, f.max) == (lo, hi), key
        assert f.advanced, key
    assert "relax_turbulence" not in transient and steady["relax_turbulence"].depends_on == {"simplec": False}
    assert steady["grad_limiter"].choices == ("strong", "light", "none")
    assert steady["momentum_convection"].choices == ("first_order", "second_order", "second_order_limited")
    assert steady["turbulence_convection"].choices == ("first_order", "second_order")
    assert steady["non_orth_correction"].choices == ("full", "limited_05", "limited_033", "none")
    assert steady["velocity_limit"].choices == ("auto", "custom", "off") and steady["velocity_limit"].default == "auto"
    assert steady["velocity_limit_max"].depends_on == {"velocity_limit": "custom"}
    # Defaults are today's; blank where today's value is computed.
    assert (steady["p_tolerance"].default, steady["p_rel_tol"].default, steady["p_max_iter"].default) == (1e-7, 0.01, 200)
    assert (steady["eq_tolerance"].default, steady["eq_rel_tol"].default, steady["eq_max_iter"].default) == (1e-8, 0.1, 50)
    for key in ("grad_limiter", "turbulence_convection", "non_orth_correction", "relax_turbulence"):
        assert steady[key].default is None and steady[key].optional, key
    for key in ("outer_relax_p", "outer_relax_eq", "outer_tolerance"):
        assert control[key].default is None and control[key].optional, key
    # The cautions (x-cfddesk.caution).
    assert steady["momentum_convection"].caution == {"first_order": CAUTION_FIRST_ORDER}
    assert steady["turbulence_convection"].caution == {"first_order": CAUTION_FIRST_ORDER}
    assert steady["velocity_limit"].caution == {"off": CAUTION_LIMIT_OFF}


def test_the_caution_reaches_the_json_schema():
    from cfddesk.registry.schema import to_json_schema

    props = to_json_schema(build_incompressible_steady().numerics_schema)["properties"]
    assert props["momentum_convection"]["x-cfddesk"]["caution"] == {"first_order": CAUTION_FIRST_ORDER}
    assert props["velocity_limit"]["x-cfddesk"]["caution"] == {"off": CAUTION_LIMIT_OFF}
    assert "caution" not in props["p_tolerance"]["x-cfddesk"]


# ---------------------------------------------------------------------------
# Each study key: round trip and the written string (steady and transient)
# ---------------------------------------------------------------------------

STEADY_CASES = [
    ({"grad_limiter": "light"}, "system/fvSchemes", "grad(U)         cellMDLimited Gauss linear 0.5;"),
    ({"grad_limiter": "none"}, "system/fvSchemes", "grad(U)         Gauss linear;"),
    ({"momentum_convection": "first_order"}, "system/fvSchemes", "div(phi,U)      bounded Gauss upwind;"),
    ({"momentum_convection": "second_order_limited"}, "system/fvSchemes", "div(phi,U)      bounded Gauss limitedLinearV 1;"),
    ({"turbulence_convection": "second_order"}, "system/fvSchemes", "div(phi,k)      bounded Gauss limitedLinear 1;"),
    ({"non_orth_correction": "full"}, "system/fvSchemes", "laplacianSchemes { default Gauss linear corrected; }"),
    ({"non_orth_correction": "limited_033"}, "system/fvSchemes", "snGradSchemes { default limited corrected 0.33; }"),
    ({"non_orth_correction": "none"}, "system/fvSchemes", "laplacianSchemes { default Gauss linear uncorrected; }"),
    ({"relax_turbulence": 0.4}, "system/fvSolution", "        k               0.4;\n"),
]


@pytest.mark.parametrize(("record", "rel", "line"), STEADY_CASES)
def test_a_steady_study_key_is_written(tmp_path: Path, record: dict, rel: str, line: str):
    ns = physics_from_record(record).numerics_settings
    for key, value in record.items():
        assert getattr(ns, key) == value
    assert line in _text(_write(tmp_path, record), rel)


TRANSIENT_CASES = [
    ({"grad_limiter": "light"}, "grad(U)         cellMDLimited Gauss linear 0.5;"),
    ({"momentum_convection": "first_order"}, "div(phi,U)      Gauss upwind;"),
    ({"turbulence_convection": "first_order"}, "div(phi,k)      Gauss upwind;"),
    ({"non_orth_correction": "full"}, "snGradSchemes { default corrected; }"),
]


@pytest.mark.parametrize(("record", "line"), TRANSIENT_CASES)
def test_a_transient_study_key_is_written(tmp_path: Path, record: dict, line: str):
    text = _text(_write(tmp_path, {**record, "time_dependency": "Transient"}, TRANSIENT), "system/fvSchemes")
    assert line in text


@pytest.mark.parametrize("transient", [None, TRANSIENT])
def test_the_linear_solvers_are_written_and_hinted(tmp_path: Path, transient):
    rec = {"p_tolerance": 1e-6, "p_rel_tol": 0.05, "p_max_iter": 500, "eq_tolerance": 1e-9, "eq_rel_tol": 0.2, "eq_max_iter": 100}
    if transient:
        rec["time_dependency"] = "Transient"
    case = _write(tmp_path, rec, transient)
    sol = _text(case, "system/fvSolution")
    p = _entry(sol, "p")
    assert "tolerance       1e-6;" in p and "relTol          0.05;" in p and "maxIter         500;" in p
    eq = _entry(sol, '"(U|k|omega)"')
    assert "tolerance       1e-9;" in eq and "relTol          0.2;" in eq and "maxIter         100;" in eq
    # What stays fixed: the solver types, nCellsInCoarsestLevel and the final loop's relTol 0.
    assert "solver          GAMG;" in p and "nCellsInCoarsestLevel 20;" in p and "solver          smoothSolver;" in eq
    if transient:
        assert "$p;\n        relTol          0;" in sol
    hints = json.loads(_text(case, "w27-case.json"))["health_hints"]
    assert hints["linsolve"]["p"]["max_iter"] == 500 and hints["linsolve"]["p"]["tol"] == 1e-6
    assert hints["linsolve"]["U"]["max_iter"] == 100 and hints["linsolve"]["k"]["rel_tol"] == 0.2


def test_relaxation_turbulence_is_not_used_while_simplec_is_on(tmp_path: Path):
    sol = _text(_write(tmp_path, {"simplec": True, "relax_turbulence": 0.4}), "system/fvSolution")
    assert "        k               0.9;\n" in sol and "0.4" not in sol


def test_the_velocity_limit_off_custom_and_automatic(tmp_path: Path):
    off = _write(tmp_path / "off", {"velocity_limit": "off"})
    assert not (off / "system" / "fvOptions").exists()
    assert json.loads(_text(off, "w27-case.json"))["health_hints"]["limiter"] is None
    custom = _write(tmp_path / "custom", {"velocity_limit": "custom", "velocity_limit_max": 300})
    assert "max             300.000;" in _text(custom, "system/fvOptions")
    assert json.loads(_text(custom, "w27-case.json"))["health_hints"]["limiter"]["cap"] == 300
    # Custom without a maximum is written as Automatic.
    blank = _text(_write(tmp_path / "blank", {"velocity_limit": "custom"}), "system/fvOptions")
    auto = _text(_write(tmp_path / "auto", {}), "system/fvOptions")
    assert blank == auto and "limitVelocity" in auto


# ---------------------------------------------------------------------------
# The run keys: outer relaxation and outer tolerance
# ---------------------------------------------------------------------------


def test_the_outer_relaxation_and_tolerance_with_outer_correctors(tmp_path: Path):
    t = {**TRANSIENT, "n_outer_correctors": 3, "outer_relax_p": 0.4, "outer_relax_eq": 0.6, "outer_tolerance": 1e-3}
    ctrl = resolve_transient_control(t, {})
    assert (ctrl.outer_relax_p, ctrl.outer_relax_eq, ctrl.outer_tolerance) == (0.4, 0.6, 1e-3)
    sol = _text(_write(tmp_path, {"time_dependency": "Transient"}, t), "system/fvSolution")
    assert "        p               0.4;\n        pFinal          1;" in sol
    assert '"(U|k|omega)"   0.6;' in sol
    pimple = sol[sol.index("PIMPLE") :]
    assert "residualControl" in pimple
    assert "        p\n        {\n            tolerance       0.001;\n            relTol          0;" in pimple
    assert '        "(U|k|omega)"\n        {\n            tolerance       0.001;' in pimple


def test_blank_outer_settings_are_todays_and_one_outer_corrector_uses_none(tmp_path: Path):
    t3 = {**TRANSIENT, "n_outer_correctors": 3}
    sol = _text(_write(tmp_path / "a", {"time_dependency": "Transient"}, t3), "system/fvSolution")
    assert "        p               0.3;" in sol and '"(U|k|omega)"   0.7;' in sol and "residualControl" not in sol
    # With 1 outer corrector the run's outer settings are not used (the PISO case as today).
    t1 = {**TRANSIENT, "outer_relax_p": 0.4, "outer_tolerance": 1e-3}
    plain = _text(_write(tmp_path / "b", {"time_dependency": "Transient"}, TRANSIENT), "system/fvSolution")
    assert _text(_write(tmp_path / "c", {"time_dependency": "Transient"}, t1), "system/fvSolution") == plain


# ---------------------------------------------------------------------------
# Bounds apply only to an edit (spec 5.4)
# ---------------------------------------------------------------------------


def test_a_stored_value_out_of_range_is_written_as_saved(tmp_path: Path):
    sol = _text(_write(tmp_path, {"p_tolerance": 0.01}), "system/fvSolution")
    assert "tolerance       0.01;" in _entry(sol, "p")
    t = {**TRANSIENT, "n_outer_correctors": 2, "outer_relax_p": 1.5}
    sol = _text(_write(tmp_path / "t", {"time_dependency": "Transient"}, t), "system/fvSolution")
    assert "        p               1.5;" in sol


def test_a_stored_run_value_out_of_range_is_kept_when_another_key_is_edited():
    spec = get_registry("analysis").get("incompressible_transient")
    stored = normalize_transient({**TRANSIENT, "outer_relax_p": 1.5, "outer_tolerance": 0.5})
    assert (stored["outer_relax_p"], stored["outer_tolerance"]) == (1.5, 0.5)
    # The page resends the whole block with a new Max Courant: only that key was edited.
    out = contract.run_normalize(spec, {**stored, "max_co": 2}, stored)
    assert (out["outer_relax_p"], out["outer_tolerance"], out["max_co"]) == (1.5, 0.5, 2.0)
    # An edit of the key itself is held to its range.
    out = contract.run_normalize(spec, {**stored, "outer_relax_p": 3}, stored)
    assert out["outer_relax_p"] == 1.0 and out["outer_tolerance"] == 0.5


def test_validate_ready_never_refuses_a_stored_value_out_of_range(tmp_path: Path):
    from test_contract import INLET, OUTLET, _ready, _study

    root = _study(tmp_path, fluid_assigned=True, bcs=[INLET, OUTLET])
    study = {"id": "s1", "p_tolerance": 0.01, "relax_turbulence": 1.5, "eq_max_iter": 5000, "relax_p": 1.5}
    assert _ready(root, study=study) == []


def test_the_pre_run_check_lists_a_stored_value_out_of_range(tmp_path: Path):
    root = _project(tmp_path, {"p_tolerance": 0.01, "time_dependency": "Transient"})
    spec = load_run_spec(root, run_id="run-r", require_mesh=False, n_procs=1, transient_override={**TRANSIENT, "outer_relax_eq": 2})
    from cfddesk.project.run_inputs import gather_run_inputs

    inputs = gather_run_inputs(root, run_id="run-r", require_mesh=False, transient_override=TRANSIENT, time_dependency="transient")
    out = run_check(transient=True, spec=spec, inputs=inputs, settings={**TRANSIENT, "outer_relax_eq": 2})
    rows = {r["code"]: r for r in out["checks"]}
    row = rows["setting_out_of_range"]
    assert row["level"] == "warn"
    assert row["text"] == "Saved p tolerance 1e-2 is outside 1e-12 to 1e-3. Saved outer relaxation equations 2 is outside 0 to 1."
    assert row["fix"] is None


def test_the_pre_run_check_lists_nothing_for_values_in_range(tmp_path: Path):
    spec = _spec(tmp_path, {"p_tolerance": 1e-6})
    out = run_check(transient=False, spec=spec, settings={"end_time": 200})
    assert "setting_out_of_range" not in {r["code"] for r in out["checks"]}


# ---------------------------------------------------------------------------
# "Numerics as written"
# ---------------------------------------------------------------------------


def _rows(out: dict) -> dict[str, dict]:
    return {f"{r['group']}/{r['label']}": r for r in out["numerics"]}


def test_numerics_as_written_names_what_the_case_is_written_with(tmp_path: Path):
    spec = _spec(tmp_path, {"grad_limiter": "light", "p_max_iter": 500})
    out = run_check(transient=False, spec=spec, settings={"end_time": 200})
    rows = _rows(out)
    assert rows["Schemes/Gradient limiter"] == {"group": "Schemes", "label": "Gradient limiter", "value": "cellMDLimited Gauss linear 0.5", "source": "study"}
    assert rows["Schemes/Turbulence convection"]["value"] == "bounded Gauss upwind"
    assert rows["Schemes/Turbulence convection"]["source"] == "preset"
    assert rows["Linear solvers/p"]["value"] == "GAMG, tolerance 1e-7, relTol 0.01, maxIter 500"
    assert rows["Relaxation/Turbulence"]["value"] == "0.7 (as U)"
    limit = rows["Limiters/Velocity limit"]["value"]
    speed = float(re.search(r"= 10 × ([0-9.]+) m/s", limit).group(1)) if "=" in limit else None
    assert re.fullmatch(r"([0-9.]+ m/s = 10 × [0-9.]+ m/s|50 m/s \(at least 50 m/s; 10 × [0-9.]+ m/s is less\))( \(inlet .+\))?", limit), limit
    assert speed is None or speed > 0
    assert rows["Stays fixed/nCellsInCoarsestLevel"]["value"] == "20"


def test_numerics_as_written_of_a_transient_run(tmp_path: Path):
    t = {**TRANSIENT, "n_outer_correctors": 3, "outer_relax_p": 0.4, "outer_tolerance": 1e-3}
    spec = _spec(tmp_path, {"time_dependency": "Transient", "velocity_limit": "off"}, t)
    rows = _rows(run_check(transient=True, spec=spec, settings=t))
    assert rows["PIMPLE/Outer correctors"]["value"] == "3 (PIMPLE)"
    assert rows["PIMPLE/Outer relaxation"]["value"] == "p 0.4, equations 0.7; the final outer loop 1"
    assert rows["PIMPLE/Outer tolerance"]["value"] == "0.001 (p and the equations, relTol 0)"
    assert rows["Limiters/Velocity limit"]["value"] == "Off: nothing caps the velocity"
    assert rows["Schemes/Turbulence convection"]["value"] == "Gauss limitedLinear 1"
    assert rows["Stays fixed/turbOnFinalIterOnly"]["value"] == "yes"


def test_numerics_as_written_before_the_mesh_from_the_study_and_the_settings():
    from types import SimpleNamespace

    from incompressible_flow.precheck import numerics

    inputs = SimpleNamespace(study={"momentum_convection": "first_order"})
    rows = {r["label"]: r for r in numerics(None, inputs, {**TRANSIENT, "outer_relax_p": 0.5}, transient=True)}
    assert rows["Momentum convection"]["value"] == "Gauss upwind"
    assert rows["Velocity limit"]["value"].startswith("10 × the reference speed, at least 50 m/s (")
    assert rows["Outer relaxation"]["value"].startswith("None:")


def test_a_stored_value_out_of_range_never_blocks_a_continue(tmp_path: Path):
    # A transient run continued from its latest saved time with outer relaxation 1.5 and p tolerance
    # 1e-2 saved: the restart is written, with both as saved.
    t = {**TRANSIENT, "n_outer_correctors": 2, "outer_relax_p": 1.5}
    root = _project(tmp_path, {"time_dependency": "Transient", "p_tolerance": 0.01})
    case = tmp_path / "case"
    spec = load_run_spec(root, run_id="r-cont", require_mesh=False, n_procs=1, transient_override=t)
    assert write_run_case(spec, case)["ok"]
    (case / "0.5").mkdir()
    for name in ("U", "p"):
        (case / "0.5" / name).write_text("saved\n", encoding="utf-8")
    spec = load_run_spec(root, run_id="r-cont", require_mesh=False, n_procs=1, transient_override=t, restart={"end_time": 5})
    report = write_run_case(spec, case)
    assert report["ok"] is True, report
    assert report["restart"]["from_time"] == 0.5
    sol = _text(case, "system/fvSolution")
    assert "        p               1.5;" in sol and "tolerance       0.01;" in _entry(sol, "p")
