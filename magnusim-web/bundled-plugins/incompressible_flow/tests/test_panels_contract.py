"""What Incompressible Flow publishes for the core's panels (H10): its settings
components, its residual series and the run note's detail."""

from __future__ import annotations

from dataclasses import replace

import pytest
from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.contract import ContractError
from cfddesk.registry.discovery import get_registry

from incompressible_flow.transient import describe_transient


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _row(key: str) -> dict:
    return {r["key"]: r for r in get_registry("analysis").describe()}[key]


def test_both_analyses_name_the_plugins_settings_components():
    for key in ("incompressible_steady", "incompressible_transient"):
        assert _row(key)["ui"] == {"study_settings": "incompressible_flow.study", "run_settings": "incompressible_flow.run"}


def test_residual_series_steady_and_transient():
    steady = _row("incompressible_steady")["residual_series"]
    assert [s["key"] for s in steady] == ["U", "p", "k", "omega", "epsilon", "R"]
    u = steady[0]
    assert u["fields"] == ["Ux", "Uy", "Uz"] and u["always"] and u["color"] == "#1570ef" and u["swatch"] == "u"
    assert steady[3]["label"] == "ω" and steady[3]["swatch"] == "w"
    transient = _row("incompressible_transient")["residual_series"]
    co = transient[-1]
    assert (co["key"], co["dashed"], co["max_key"], co["swatch"]) == ("co_mean", True, "co_max", "co")
    assert transient[:-1] == steady


def test_residual_series_defaults_and_refuses_unknown_fields():
    spec = get_registry("analysis").get("incompressible_steady")
    bare = replace(spec, key="x_bare", residual_series=(), residual_keys=("T",))
    assert contract.residual_series(bare) == [
        {
            "key": "T",
            "label": "T",
            "color": "#667085",
            "fields": ["T"],
            "always": False,
            "dashed": False,
            "max_key": "",
            "max_label": "",
            "swatch": "",
        }
    ]
    with pytest.raises(ContractError, match="unknown field"):
        contract.residual_series(replace(spec, key="x_bad", residual_series=({"key": "T", "colour": "red"},)))


def test_run_note_detail():
    assert describe_transient({"end_time": 5, "write_count": 50, "adjust_time_step": True, "max_co": 1}) == "5 s · 50 frames · Co ≤ 1"
    assert describe_transient({"end_time": 0.2, "write_count": 4, "adjust_time_step": False, "delta_t": 1e-4}) == (
        "0.2 s · 4 frames · fixed Δt 1e-4 s"
    )
    assert describe_transient(None) == ""
