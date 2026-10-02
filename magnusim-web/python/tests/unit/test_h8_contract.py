"""H8: the analysis contract — what the core asks an analysis, and what Incompressible Flow answers."""

from __future__ import annotations

from dataclasses import replace

import pytest

from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.contract import ContractError, LaunchSpec
from cfddesk.registry.discovery import get_registry

# Incompressible Flow's own answers (defaults, run model, launch, log parser,
# readiness messages and the worker calls that ask them) are tested with the
# plugin: bundled-plugins/incompressible_flow/tests/test_contract.py.


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _analysis(key: str):
    return get_registry("analysis").get(key)


def test_describe_carries_the_contract():
    rows = {r["key"]: r for r in get_registry("analysis").describe()}
    steady, transient = rows["incompressible_steady"], rows["incompressible_transient"]
    assert steady["contract"] == "1.1"
    assert steady["family"]["title"] == "Incompressible Fluid Flow"
    assert steady["family"]["tags"] == ["FLUID FLOW (GAS OR LIQUID)", "MACH<0.3 (100 M/S)", "NEGLIGIBLE DENSITY VARIATION"]
    assert steady["family"] == transient["family"]
    assert (steady["algorithm_label"], transient["algorithm_label"]) == ("SIMPLE", "PIMPLE")
    assert (steady["x_axis"], transient["x_axis"]) == ("iterations", "seconds")
    assert steady["residual_keys"] == ["U", "p", "k", "omega", "epsilon", "R"]
    assert {f["key"] for f in steady["result_fields"]} >= {"p", "U"}


def test_launch_spec_refuses_what_solve_sh_cannot_run():
    solvers = get_registry("solver")
    base = _analysis("incompressible_steady")
    bad_name = replace(base, key="x_bad", launch=lambda **_: LaunchSpec("simple Foam; rm", "latest", ("a",), "sigterm", False, contract.GENERIC_LOG_PARSER))
    with pytest.raises(ContractError, match="plain program name"):
        contract.launch_spec(bad_name, solvers)
    unregistered = replace(base, key="x_unreg", launch=lambda **_: LaunchSpec("icoFoam", "latest", ("icoFoam",), "sigterm", False, contract.GENERIC_LOG_PARSER))
    with pytest.raises(ContractError, match="not a registered solver app"):
        contract.launch_spec(unregistered, solvers)
    with pytest.raises(ContractError, match="not registered"):
        contract.launch_spec(replace(base, key="x_nosolver", default_solver="nope"), solvers)
