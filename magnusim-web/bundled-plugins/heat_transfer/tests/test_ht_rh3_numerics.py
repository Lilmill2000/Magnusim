"""RH3 (run health, spec 5.1-5.9): numerics as settings in Heat Transfer.

Each study key (schemes with the energy equation, linear solvers, turbulence relaxation, the
velocity limit: Off by default) and each run key (outer relaxation, outer tolerance): its
bounds, round trip and written string; blank is today (the goldens of test_ht_writer and
test_ht5_cht prove it); a stored value out of range is written as saved, never refused, and
listed by the pre-run check; "Numerics as written" names what the case is written with.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.discovery import get_registry
from ht_inputs import CAVITY_BCS, WATER, make_inputs
from magnusim_sdk.numerics_settings import BOUNDS, CAUTION_FIRST_ORDER, CAUTION_LIMIT_OFF

from heat_transfer.analyses import control_schema, numerics_schema
from heat_transfer.physics import physics_from_record, physics_problem
from heat_transfer.precheck import run_check
from heat_transfer.runspec import load_spec
from heat_transfer.transient import normalize_transient, resolve_transient
from heat_transfer.writer import write_case

TRANSIENT = {"end_time": 20, "write_count": 10, "max_co": 0.5}


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _write(tmp_path: Path, **kw) -> Path:
    case = tmp_path / "case"
    spec = load_spec(make_inputs(tmp_path, **kw))
    assert spec.ok, spec.error
    assert write_case(spec, case)["ok"]
    return case


def _text(case: Path, rel: str) -> str:
    return (case / rel).read_text(encoding="utf-8")


def _entry(text: str, name: str) -> str:
    m = re.search(rf"\n    {re.escape(name)}\n    \{{\n(.*?)\n    \}}", text, re.S)
    assert m, f"no entry {name}"
    return m.group(1)


def test_every_key_has_its_bounds_and_heat_transfer_defaults():
    steady = {f.key: f for f in numerics_schema(transient=False)}
    transient = {f.key: f for f in numerics_schema(transient=True)}
    control = {f.key: f for f in control_schema(transient=True)}
    for key, (lo, hi) in BOUNDS.items():
        f = control[key] if key.startswith("outer_") else steady[key]
        assert (f.min, f.max) == (lo, hi), key
        assert f.advanced, key
    assert "relax_turbulence" in steady and "relax_turbulence" not in transient
    assert steady["relax_turbulence"].depends_on is None  # Heat Transfer has no SIMPLEC
    assert steady["energy_convection"].default == "second_order"
    assert steady["energy_convection"].caution == {"first_order": CAUTION_FIRST_ORDER}
    assert steady["velocity_limit"].default == "off" and steady["velocity_limit"].caution == {"off": CAUTION_LIMIT_OFF}
    assert steady["eq_max_iter"].default is None and steady["eq_max_iter"].optional
    assert steady["p_tolerance"].label == "p_rgh tolerance"
    assert control["outer_relax_p"].label == "Outer relaxation p_rgh"


@pytest.mark.parametrize(
    ("record", "line"),
    [
        ({"grad_limiter": "light"}, "grad(U)         cellMDLimited Gauss linear 0.5;"),
        ({"momentum_convection": "first_order"}, "div(phi,U)      bounded Gauss upwind;"),
        ({"energy_convection": "first_order"}, "div(phi,h)      bounded Gauss upwind;"),
        ({"turbulence_convection": "second_order"}, "div(phi,k)      bounded Gauss limitedLinear 1;"),
        ({"non_orth_correction": "full"}, "laplacianSchemes { default Gauss linear corrected; }"),
    ],
)
def test_a_study_scheme_is_written(tmp_path: Path, record: dict, line: str):
    ns = physics_from_record(record).numerics_settings
    for key, value in record.items():
        assert getattr(ns, key) == value
    schemes = _text(_write(tmp_path, study={"turbulence_model": "kOmegaSST", **record}), "system/fvSchemes")
    assert line in schemes
    # grad(h) and div(phi,K) stay fixed.
    assert "grad(h)         Gauss linear;" in schemes and "div(phi,K)      bounded Gauss upwind;" in schemes


def test_the_linear_solvers_and_turbulence_relaxation_are_written_and_hinted(tmp_path: Path):
    rec = {"turbulence_model": "kOmegaSST", "p_tolerance": 1e-6, "p_rel_tol": 0.05, "p_max_iter": 400, "eq_tolerance": 1e-9, "eq_rel_tol": 0.2, "eq_max_iter": 300, "relax_turbulence": 0.4}
    case = _write(tmp_path, study=rec)
    sol = _text(case, "system/fvSolution")
    p = _entry(sol, "p_rgh")
    assert "tolerance       1e-6;" in p and "relTol          0.05;" in p and "maxIter         400;" in p
    eq = _entry(sol, '"(U|h|k|omega)"')
    assert "tolerance       1e-9;" in eq and "relTol          0.2;" in eq and "maxIter         300;" in eq
    assert '        "(k|omega)" 0.4;' in sol and "        U               0.7;" in sol
    hints = json.loads(_text(case, "w27-case.json"))["health_hints"]
    assert hints["linsolve"]["p_rgh"]["max_iter"] == 400 and hints["linsolve"]["h"]["max_iter"] == 300
    # Blank: no maxIter line (OpenFOAM's 1000), which health reads.
    plain = _write(tmp_path / "plain", study={"turbulence_model": "kOmegaSST"})
    assert "maxIter" not in _entry(_text(plain, "system/fvSolution"), '"(U|h|k|omega)"')
    assert json.loads(_text(plain, "w27-case.json"))["health_hints"]["linsolve"]["h"]["max_iter"] == 1000


def test_the_velocity_limit_is_off_by_default_and_written_when_set(tmp_path: Path):
    off = _write(tmp_path / "off", study={})
    assert not (off / "system" / "fvOptions").exists()
    assert json.loads(_text(off, "w27-case.json"))["health_hints"]["limiter"] is None
    custom = _write(tmp_path / "custom", study={"velocity_limit": "custom", "velocity_limit_max": 12.5})
    assert "max             12.5;" in _text(custom, "system/fvOptions")
    assert json.loads(_text(custom, "w27-case.json"))["health_hints"]["limiter"]["cap"] == 12.5
    auto = _text(_write(tmp_path / "auto", study={"velocity_limit": "auto"}), "system/fvOptions")
    assert "type            limitVelocity;" in auto and re.search(r"max             [0-9.e+-]+;", auto)


def test_the_outer_relaxation_and_tolerance_with_outer_correctors(tmp_path: Path):
    t = {**TRANSIENT, "n_outer_correctors": 3, "outer_relax_p": 0.3, "outer_tolerance": 1e-3}
    ctrl = resolve_transient(t)
    assert (ctrl.outer_relax_p, ctrl.outer_relax_eq, ctrl.outer_tolerance) == (0.3, None, 1e-3)
    sol = _text(_write(tmp_path, materials=[WATER], bcs=CAVITY_BCS, study={"gravity": "-y", "turbulence_model": "laminar"}, transient=t), "system/fvSolution")
    assert "        p_rgh           0.3;\n        p_rghFinal      1;" in sol
    assert '        "(U|h)" 1;\n        "(U|h)Final" 1;' in sol
    assert "residualControl" in sol[sol.index("PIMPLE") :] and "        p_rgh\n        {\n            tolerance       0.001;" in sol
    # Blank, or 1 outer corrector: today's PIMPLE.
    t1 = {**TRANSIENT, "outer_relax_p": 0.3, "outer_tolerance": 1e-3}
    base = _text(_write(tmp_path / "a", materials=[WATER], bcs=CAVITY_BCS, study={"gravity": "-y", "turbulence_model": "laminar"}, transient=TRANSIENT), "system/fvSolution")
    assert _text(_write(tmp_path / "b", materials=[WATER], bcs=CAVITY_BCS, study={"gravity": "-y", "turbulence_model": "laminar"}, transient=t1), "system/fvSolution") == base
    assert '".*"            1;' in base


def test_a_stored_value_out_of_range_is_used_as_saved_and_kept(tmp_path: Path):
    sol = _text(_write(tmp_path, study={"p_tolerance": 0.01}), "system/fvSolution")
    assert "tolerance       0.01;" in _entry(sol, "p_rgh")
    assert physics_problem({"p_tolerance": 0.01, "relax_turbulence": 1.5}) is None
    stored = normalize_transient({**TRANSIENT, "outer_relax_p": 1.5})
    spec = get_registry("analysis").get("heat_transfer_transient")
    out = contract.run_normalize(spec, {**stored, "max_co": 0.6}, stored)
    assert (out["outer_relax_p"], out["max_co"]) == (1.5, 0.6)
    assert contract.run_normalize(spec, {**stored, "outer_relax_p": 4}, stored)["outer_relax_p"] == 1.0


def test_the_pre_run_check_lists_it_and_numerics_as_written_shows_the_case(tmp_path: Path):
    inputs = make_inputs(tmp_path, study={"turbulence_model": "kOmegaSST", "eq_max_iter": 5000, "energy_convection": "first_order"})
    out = run_check(transient=False, inputs=inputs, settings={"end_time": 500})
    row = {r["code"]: r for r in out["checks"]}["setting_out_of_range"]
    assert row["level"] == "warn" and row["text"] == "Saved equations max iterations 5000 is outside 5 to 1000."
    rows = {f"{r['group']}/{r['label']}": r for r in out["numerics"]}
    assert rows["Schemes/Energy convection"] == {"group": "Schemes", "label": "Energy convection", "value": "bounded Gauss upwind", "source": "study"}
    assert rows["Linear solvers/U, h, k, omega"]["value"] == "PBiCGStab, tolerance 1e-8, relTol 0.1, maxIter 5000"
    assert rows["Limiters/Velocity limit"]["value"] == "Off: nothing caps the velocity"
    assert rows["Stays fixed/div(phi,K)"]["value"] == "bounded Gauss upwind (the preset's)"
    # A preset row names the preset the case is written with.
    assert rows["Schemes/Gradient limiter"]["source"] == "preset" and rows["Schemes/Gradient limiter"]["preset"] == "Robust"
    accurate = run_check(transient=False, inputs=make_inputs(tmp_path / "a", study={"numerics_preset": "accurate"}), settings={"end_time": 500})
    assert {r["label"]: r for r in accurate["numerics"]}["Gradient limiter"]["preset"] == "Accurate"


def test_conjugate_heat_transfer_fluid_regions_get_the_study_numerics(tmp_path: Path):
    from test_ht5_cht import ALUMINIUM, WALLS_FIXED
    from test_ht5_cht import _write as write_cht

    case, _ = write_cht(
        tmp_path,
        bcs=WALLS_FIXED,
        materials=[*make_inputs(tmp_path / "x").materials["materials"][:1], ALUMINIUM],
        study={"gravity": "-y", "turbulence_model": "kOmegaSST", "momentum_convection": "first_order", "velocity_limit": "custom", "velocity_limit_max": 5},
    )
    assert "div(phi,U)      bounded Gauss upwind;" in _text(case, "system/air/fvSchemes")
    assert "max             5;" in _text(case, "system/air/fvOptions")
