"""Heat Transfer's pre-run check (run health, RH2; contract API 1.9 RunModel.check): the shared
rules that apply to it. No velocity limit (it writes none), no time-step estimate yet (it passes
no flow speed), and the study's own non-orthogonal correctors."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.discovery import get_registry

from heat_transfer.precheck import NO_ESTIMATE, run_check


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _spec(**physics):
    ph = SimpleNamespace(turbulence_model="kOmegaSST", n_non_orthogonal=0, **physics)
    return SimpleNamespace(ok=True, n_cells=250_000, physics=ph)


def test_the_run_models_have_the_check_hook():
    keys = [k for k in get_registry("analysis").keys() if str(k).startswith("heat_transfer")]
    assert keys
    for key in keys:
        model = contract.run_model(get_registry("analysis").get(key))
        assert model is not None and model.check is not None, key


def test_courant_rows_without_a_velocity_limit_and_no_estimate():
    out = run_check(transient=True, spec=_spec(), settings={"end_time": 100, "max_co": 20, "n_outer_correctors": 1, "n_correctors": 2})
    rows = {r["code"]: r for r in out["checks"]}
    piso = rows["piso_high_co"]
    assert piso["level"] == "warn"
    assert piso["text"].endswith("At 20 expect k and omega to go negative and the run to become unstable.")
    assert "velocity limit" not in piso["text"]
    assert out["estimate"]["line"] == NO_ESTIMATE
    assert out["estimate"]["velocity_cap"] is None


def test_the_study_non_orthogonal_correctors():
    mesh = {"quality": {"known": True, "ok": True, "failed": [], "max_non_orthogonality": 78.0, "max_skewness": 1.0}}
    out = run_check(transient=True, spec=_spec(), settings={"end_time": 100, "max_co": 0.8}, context={"mesh": mesh, "mesh_ready": True})
    row = {r["code"]: r for r in out["checks"]}["non_ortho_correctors"]
    assert row["text"] == "The worst cells are 78° non-orthogonal and the run uses no non-orthogonal correctors."
    assert row["fix"]["target"] == "study"
    assert row["fix"]["values"] == [{"key": "n_non_orthogonal", "value": 2}]


def test_a_steady_run_gets_the_relaxation_row_and_the_robust_alternative():
    """Buoyant SIMPLE: a steady run's relaxation is checked as Incompressible Flow's is, under the
    same study keys, and a skewed mesh offers the robust numerics preset as its alternative."""
    mesh = {"quality": {"known": True, "ok": True, "failed": [], "max_non_orthogonality": 40.0, "max_skewness": 4.6}}
    spec = _spec(relax_p=0.8, relax_u=0.7, numerics="accurate")
    out = run_check(transient=False, spec=spec, settings={"end_time": 1000}, context={"mesh": mesh, "mesh_ready": True})
    rows = {r["code"]: r for r in out["checks"]}
    relax = rows["steady_relax"]
    assert relax["level"] == "warn"
    assert relax["text"] == "Relaxation p 0.8 often diverges with SIMPLE."
    assert relax["fix"]["target"] == "study"
    assert relax["fix"]["values"] == [{"key": "relax_p", "value": 0.3}, {"key": "relax_u", "value": 0.7}]
    skew = rows["mesh_skew"]
    assert skew["alt"]["label"] == "Robust numerics"
    assert skew["alt"]["values"] == [{"key": "numerics_preset", "value": "robust"}]
    # The defaults (0.3, 0.7, robust): neither.
    calm = run_check(transient=False, spec=_spec(relax_p=0.3, relax_u=0.7, numerics="robust"), settings={"end_time": 1000}, context={"mesh": mesh, "mesh_ready": True})
    calm_rows = {r["code"]: r for r in calm["checks"]}
    assert "steady_relax" not in calm_rows and calm_rows["mesh_skew"]["alt"] is None


def test_before_a_mesh_only_the_settings_are_checked():
    out = run_check(transient=True, spec=SimpleNamespace(ok=False), settings={"end_time": 100, "max_co": 20, "n_outer_correctors": 1})
    assert out["estimate"]["complete"] is False
    assert [r["code"] for r in out["checks"]] == ["piso_high_co"]


def test_a_standard_mesh_gets_the_study_panels_note_as_a_pre_run_row():
    """standard_mesh_heat (info): on a Standard mesh the pre-run check carries the Study panel's note,
    word for word (ui/StudySettings.tsx STANDARD_MESH_NOTE), so the Assistant (read_results precheck)
    reads what the person reads; on another mesher, none."""
    import re
    from pathlib import Path

    from heat_transfer.precheck import STANDARD_MESH_NOTE

    ui = (Path(__file__).resolve().parents[1] / "ui" / "StudySettings.tsx").read_text(encoding="utf-8")
    consts = {m.group(1): m.group(2) for m in re.finditer(r"export const (STANDARD_\w+_PCT) = (\d+(?:\.\d+)?);", ui)}
    body = re.search(r"export const STANDARD_MESH_NOTE =\s*(.+?);\n", ui, re.S).group(1)  # type: ignore[union-attr]
    parts = re.findall(r"`([^`]*)`|'([^']*)'", body)
    text = "".join(a or b for a, b in parts)
    text = re.sub(r"\$\{(\w+)\}", lambda m: consts[m.group(1)], text)
    assert text == STANDARD_MESH_NOTE
    mesh = {"mesher": "standard", "quality": {"known": False}}
    out = run_check(transient=False, spec=_spec(relax_p=0.3, relax_u=0.7, numerics="robust"), settings={"end_time": 1000}, context={"mesh": mesh, "mesh_ready": True})
    row = next(r for r in out["checks"] if r["code"] == "standard_mesh_heat")
    assert (row["level"], row["text"], row["fix"]["target"]) == ("info", STANDARD_MESH_NOTE, "mesh")
    hexd = run_check(transient=False, spec=_spec(relax_p=0.3, relax_u=0.7, numerics="robust"), settings={"end_time": 1000}, context={"mesh": {"mesher": "snappy_hexdominant"}, "mesh_ready": True})
    assert "standard_mesh_heat" not in [r["code"] for r in hexd["checks"]]
