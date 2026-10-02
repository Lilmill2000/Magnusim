"""API 1.4: an AnalysisType needs only its identity and fields.

The API 1.0 fields (turbulence, bc and material lists, monitors, the schemas,
validate) default to empty; an analysis built with all of them by position,
as 1.0 plugins do, still constructs. A new study's turbulence comes from the
analysis's own study_defaults or settings_schema; the core's one remaining
use of turbulence is ``default_turbulence`` as a seed (its 1.0 meaning).
"""

from __future__ import annotations

from dataclasses import replace

from cfddesk.registry import contract
from cfddesk.registry.analysis import AnalysisType, run_analysis_validate
from cfddesk.registry.base import Registry
from cfddesk.registry.schema import SchemaField


def _minimal(key: str = "toy_steady") -> AnalysisType:
    return AnalysisType(key, "Toy", "TEST", "steady", ("T",))


def test_minimal_analysis_constructs_registers_and_describes():
    spec = _minimal()
    assert spec.turbulence_models == () and spec.default_turbulence == ""
    assert spec.settings_schema == () and spec.default_solver == ""
    assert run_analysis_validate(spec) == []
    reg: Registry[AnalysisType] = Registry("analysis")
    reg.register(spec, plugin="toy")
    (row,) = reg.describe()
    assert row["key"] == "toy_steady" and row["category"] == "TEST" and row["time_dependency"] == "steady"
    assert "default_turbulence" not in row and "turbulence_models" not in row
    assert row["study_defaults"] == {
        "analysis_type": "toy_steady",
        "analysis": "Toy",
        "analysis_title": "Toy",
        "category": "TEST",
        "time_dependency": "Steady-state",
        "algorithm": "",
    }


def test_positional_api_1_0_construction_still_works():
    def check(*_a, **_k):
        return ["blocked"]

    spec = AnalysisType(
        "legacy_steady",
        "Legacy",
        "FLUID",
        "steady",
        ("U", "p"),
        ("laminar", "kEpsilon"),
        "kEpsilon",
        ("wall",),
        ("constant",),
        ("simpleFoam",),
        "simpleFoam",
        ("forces",),
        (),
        (),
        (),
        (),
        check,
    )
    assert spec.turbulence_models == ("laminar", "kEpsilon") and spec.default_turbulence == "kEpsilon"
    assert spec.default_solver == "simpleFoam" and spec.monitors == ("forces",)
    assert run_analysis_validate(spec) == ["blocked"]
    reg: Registry[AnalysisType] = Registry("analysis")
    reg.register(spec, plugin="legacy")
    (row,) = reg.describe()
    # A 1.0 analysis that sets them still publishes them.
    assert row["default_turbulence"] == "kEpsilon"
    assert row["turbulence_models"] == ["laminar", "kEpsilon"]


def test_study_defaults_seed_turbulence_from_default_turbulence():
    out = contract.study_defaults(replace(_minimal(), default_turbulence="kEpsilon"))
    assert out["turbulence_model"] == out["turbulence_model_key"] == "kEpsilon"
    assert "flow_group" not in out


def test_study_defaults_take_settings_schema_defaults():
    spec = replace(
        _minimal(),
        settings_schema=(SchemaField("model", "Model", "enum", default="fast", choices=("fast", "slow")),),
    )
    out = contract.study_defaults(spec)
    assert out["model"] == "fast"
    assert "flow_group" not in out and "turbulence_model" not in out and "turbulence_model_key" not in out


def test_study_defaults_hook_wins_and_misses_are_filled():
    schema = (
        SchemaField("model", "Model", "enum", default="fast", choices=("fast", "slow")),
        SchemaField("rate", "Rate", "float", default=2.0),
    )

    def hook(td: str) -> dict:
        return {"analysis_type": "toy_steady", "model": "slow", "turbulence_model": "laminar"}

    out = contract.study_defaults(
        replace(_minimal(), settings_schema=schema, default_turbulence="kEpsilon", study_defaults=hook)
    )
    # The hook's own values win over default_turbulence and the schema.
    assert out["model"] == "slow" and out["turbulence_model"] == "laminar"
    # What the hook leaves out comes from default_turbulence, then the schema.
    assert out["turbulence_model_key"] == "kEpsilon"
    assert out["rate"] == 2.0


def test_default_turbulence_wins_over_a_schema_default():
    spec = replace(
        _minimal(),
        default_turbulence="kEpsilon",
        settings_schema=(SchemaField("turbulence_model", "Turbulence", "enum", default="laminar", choices=("laminar", "kEpsilon")),),
    )
    assert contract.study_defaults(spec)["turbulence_model"] == "kEpsilon"
