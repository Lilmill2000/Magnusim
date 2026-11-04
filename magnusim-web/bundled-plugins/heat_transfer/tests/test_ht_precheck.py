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
