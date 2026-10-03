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
    assert steady["contract"] == "1.5"
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


def test_kinematic_fields_in_the_contract():
    """API 1.4: an analysis may say which fields its cases store divided by density."""
    solvers = get_registry("solver")
    base = _analysis("incompressible_steady")
    rows = {r["key"]: r for r in get_registry("analysis").describe()}
    # The default analysis declares its own: p is stored divided by rho.
    assert rows["incompressible_steady"]["kinematic_fields"] == ["p"]
    assert contract.kinematic_fields(base) == ("p",)
    # Not declared: describe says null, the launch spec carries null.
    undeclared = replace(base, key="x_undeclared", kinematic_fields=None)
    assert contract.describe_extra(undeclared)["kinematic_fields"] is None
    assert contract.kinematic_fields(undeclared) is None
    assert contract.launch_spec(undeclared, solvers).to_json()["kinematic_fields"] is None
    declared = replace(base, key="x_kin", kinematic_fields=("p", "p_rgh"))
    assert contract.kinematic_fields(declared) == ("p", "p_rgh")
    assert contract.launch_spec(declared, solvers).to_json()["kinematic_fields"] == ["p", "p_rgh"]
    assert contract.describe_extra(declared)["kinematic_fields"] == ["p", "p_rgh"]
    assert contract.describe_extra(replace(base, key="x_none", kinematic_fields=()))["kinematic_fields"] == []


@pytest.mark.parametrize("bad", ["", "1p", "p__x", "p-x", "a" * 65, "p q"])
def test_a_bad_kinematic_field_name_is_a_contract_error(bad: str):
    solvers = get_registry("solver")
    spec = replace(_analysis("incompressible_steady"), key="x_bad_kin", kinematic_fields=("p", bad))
    with pytest.raises(ContractError, match="not a field name"):
        contract.kinematic_fields(spec)
    with pytest.raises(ContractError, match="not a field name"):
        contract.launch_spec(spec, solvers)
    hooked = replace(
        _analysis("incompressible_steady"),
        key="x_bad_launch",
        launch=lambda **_: LaunchSpec(
            "simpleFoam", "latest", ("simpleFoam",), "sigterm", False, contract.GENERIC_LOG_PARSER, kinematic_fields=(bad,)
        ),
    )
    with pytest.raises(ContractError, match="not a field name"):
        contract.launch_spec(hooked, solvers)
    with pytest.raises(ContractError, match="tuple of field names"):
        contract.kinematic_fields(replace(spec, kinematic_fields="p"))
