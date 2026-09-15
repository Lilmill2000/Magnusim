"""Phase 2 land3: SolverBackend registry + OpenFOAM builtins + AnalysisType wiring."""

from __future__ import annotations

import pytest

from cfddesk.registry import (
    RegistryError,
    SolverBackend,
    get_registry,
    load_all,
    reset_for_tests,
    validate_analysis_solver_refs,
)
from cfddesk.registry.analysis import DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY
from cfddesk.registry.discovery import get_hub


EXPECTED_SOLVER_KEYS = {"simpleFoam", "pimpleFoam", "simpleFoam_amgx"}


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def test_load_all_registers_solver_keys():
    hub = load_all()
    reg = get_registry("solver")
    assert set(reg.keys()) == EXPECTED_SOLVER_KEYS
    assert hub.registry("solver") is reg


def test_solver_specs_shape():
    load_all()
    reg = get_registry("solver")
    simple = reg.get("simpleFoam")
    assert isinstance(simple, SolverBackend)
    assert simple.application == "simpleFoam"
    assert simple.time_dependency == "steady"
    assert simple.parallel == "mpirun"
    assert simple.stop_strategy == "stopAt_writeNow"
    assert simple.residual_line is None
    assert simple.write_fv_solution is None
    assert simple.script_template == "solve.sh"

    pimple = reg.get("pimpleFoam")
    assert pimple.application == "pimpleFoam"
    assert pimple.time_dependency == "transient"
    assert pimple.parallel == "mpirun"

    amgx = reg.get("simpleFoam_amgx")
    assert amgx.application == "simpleFoam"
    assert amgx.parallel == "none"
    assert any(r.kind == "gpu" for r in amgx.requires)


def test_analysis_solver_backends_resolve_from_registry():
    load_all()
    solver_keys = set(get_registry("solver").keys())
    analysis = get_registry("analysis")
    steady = analysis.get(DEFAULT_STEADY_KEY)
    transient = analysis.get(DEFAULT_TRANSIENT_KEY)
    for key in steady.solver_backends:
        assert key in solver_keys
    for key in transient.solver_backends:
        assert key in solver_keys
    assert steady.default_solver in solver_keys
    assert transient.default_solver in solver_keys
    # Explicit product mapping from land2
    assert "simpleFoam" in steady.solver_backends
    assert "simpleFoam_amgx" in steady.solver_backends
    assert transient.solver_backends == ("pimpleFoam",)


def test_validate_analysis_solver_refs_raises_on_unknown():
    load_all()
    hub = get_hub()
    # Corrupt: inject analysis with unknown solver bag key
    from cfddesk.builtin.incompressible import build_incompressible_steady
    from dataclasses import replace

    bad = replace(
        build_incompressible_steady(),
        key="incompressible_steady_bad",
        solver_backends=("notARealSolver",),
        default_solver="notARealSolver",
    )
    hub.registry("analysis").register(bad, plugin="builtin")
    with pytest.raises(RegistryError, match="unknown solver"):
        validate_analysis_solver_refs(hub)


def test_describe_solver_includes_requires():
    load_all()
    desc = {d["key"]: d for d in get_registry("solver").describe()}
    assert desc["simpleFoam"]["plugin"] == "builtin"
    assert desc["simpleFoam"]["label"]
    assert desc["simpleFoam"].get("requires")


def test_load_all_idempotent_solvers():
    load_all()
    load_all()
    load_all(force=True)
    assert set(get_registry("solver").keys()) == EXPECTED_SOLVER_KEYS
