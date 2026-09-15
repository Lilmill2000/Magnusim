"""Phase 2 land11: PRIMARY_SIM_ANALYSIS remap to registered AnalysisType keys."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from cfddesk.project.model import PRIMARY_SIM_ANALYSIS, PROJECT_VERSION, Project
from cfddesk.registry import (
    DEFAULT_STEADY_KEY,
    DEFAULT_TRANSIENT_KEY,
    LEGACY_ANALYSIS_ALIAS,
    RegistryError,
    default_analysis_key,
    get_registry,
    load_all,
    reset_for_tests,
    resolve_analysis_key,
)

from tests.conftest import PROJECTS


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def test_primary_sim_analysis_is_registered_key():
    load_all()
    assert PRIMARY_SIM_ANALYSIS == DEFAULT_STEADY_KEY
    assert PRIMARY_SIM_ANALYSIS in get_registry("analysis").keys()
    assert PRIMARY_SIM_ANALYSIS != LEGACY_ANALYSIS_ALIAS


def test_resolve_legacy_alias_by_solver_mode():
    assert resolve_analysis_key("incompressible") == DEFAULT_STEADY_KEY
    assert (
        resolve_analysis_key("incompressible", solver_mode="steady")
        == DEFAULT_STEADY_KEY
    )
    assert (
        resolve_analysis_key("incompressible", solver_mode="transient")
        == DEFAULT_TRANSIENT_KEY
    )
    assert (
        resolve_analysis_key(
            "incompressible",
            simulation_control={"transient": {"end_time": 1.0}},
        )
        == DEFAULT_TRANSIENT_KEY
    )
    assert (
        resolve_analysis_key(None, transient=True) == DEFAULT_TRANSIENT_KEY
    )
    assert default_analysis_key() == DEFAULT_STEADY_KEY
    assert default_analysis_key(time_dependency="transient") == DEFAULT_TRANSIENT_KEY


def test_resolve_registered_keys_passthrough():
    assert resolve_analysis_key(DEFAULT_STEADY_KEY) == DEFAULT_STEADY_KEY
    assert resolve_analysis_key(DEFAULT_TRANSIENT_KEY) == DEFAULT_TRANSIENT_KEY
    # Explicit registered key is not remapped by solver mode.
    assert (
        resolve_analysis_key(DEFAULT_STEADY_KEY, solver_mode="transient")
        == DEFAULT_STEADY_KEY
    )


def test_resolve_unknown_fails_closed():
    load_all()
    with pytest.raises(RegistryError, match="unknown key"):
        resolve_analysis_key("not_a_real_analysis", registry=get_registry("analysis"))


def test_load_all_builtins_still_present():
    hub = load_all()
    keys = set(get_registry("analysis").keys())
    assert keys == {DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY}
    assert hub.registry("analysis").get(DEFAULT_STEADY_KEY).time_dependency == "steady"


@pytest.mark.parametrize("ver", [13, 14, 15])
def test_fixture_migrates_legacy_analysis_type(ver: int):
    path = PROJECTS / f"v{ver}.json"
    assert path.is_file(), f"missing fixture {path.name}"
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc.get("version") == ver
    sim0 = (doc.get("simulations") or [{}])[0]
    assert sim0.get("analysis_type") == LEGACY_ANALYSIS_ALIAS
    proj = Project.from_dict(doc)
    assert proj.version == PROJECT_VERSION
    analysis = proj.primary_simulation().analysis_type
    assert analysis == DEFAULT_STEADY_KEY
    load_all()
    assert analysis in get_registry("analysis").keys()


def test_fixture_transient_solver_mode_maps_to_transient_key():
    path = PROJECTS / "v13.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc = copy.deepcopy(doc)
    doc["simulations"][0]["analysis_type"] = LEGACY_ANALYSIS_ALIAS
    doc["simulations"][0]["solver"]["mode"] = "transient"
    proj = Project.from_dict(doc)
    assert proj.primary_simulation().analysis_type == DEFAULT_TRANSIENT_KEY


def test_no_third_analysis_key_in_primary_constant():
    """PRIMARY_SIM_ANALYSIS must be a registry builtin, not a free-string bag."""
    load_all()
    allowed = set(get_registry("analysis").keys())
    assert PRIMARY_SIM_ANALYSIS in allowed
    assert "incompressible" not in allowed
