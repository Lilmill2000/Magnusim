"""Phase 2 land2: AnalysisType registry + incompressible builtins."""

from __future__ import annotations

import pytest

from cfddesk.registry import (
    AnalysisType,
    RegistryError,
    SchemaField,
    get_registry,
    load_all,
    reset_for_tests,
    schema_defaults,
    validate,
)
from cfddesk.registry.analysis import DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def test_load_all_registers_both_analysis_keys():
    hub = load_all()
    reg = get_registry("analysis")
    keys = reg.keys()
    assert DEFAULT_STEADY_KEY in keys
    assert DEFAULT_TRANSIENT_KEY in keys
    assert hub.registry("analysis") is reg


def test_load_all_idempotent_no_duplicate_crash():
    load_all()
    load_all()
    load_all(force=True)
    reg = get_registry("analysis")
    assert set(reg.keys()) == {DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY}


def test_describe_returns_labels_and_schemas():
    load_all()
    desc = get_registry("analysis").describe()
    by_key = {d["key"]: d for d in desc}
    assert by_key[DEFAULT_STEADY_KEY]["label"] == "Incompressible Fluid Flow"
    assert "Transient" in by_key[DEFAULT_TRANSIENT_KEY]["label"]
    for key in (DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY):
        row = by_key[key]
        assert row["plugin"] == "builtin"
        assert isinstance(row.get("schema"), dict)
        assert "properties" in row["schema"]
        assert "turbulence_model" in row["schema"]["properties"]
        assert row.get("requires")


def test_get_defaults_validate_via_schemafield():
    load_all()
    reg = get_registry("analysis")
    for key in (DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY):
        spec = reg.get(key)
        assert isinstance(spec, AnalysisType)
        assert spec.default_turbulence == "kOmegaSST"
        assert "U" in spec.fields and "p" in spec.fields
        assert callable(spec.write_case)  # land12: Phase 1 web_case wired
        assert callable(spec.validate)
        assert spec.validate() == []
        for schema_name in ("settings_schema", "numerics_schema", "control_schema"):
            fields = getattr(spec, schema_name)
            assert isinstance(fields, tuple) and len(fields) > 0
            assert all(isinstance(f, SchemaField) for f in fields)
            defaults = schema_defaults(fields)
            errors = validate(defaults, fields)
            assert errors == [], f"{key}.{schema_name}: {errors}"


def test_steady_vs_transient_product_shape():
    load_all()
    steady = get_registry("analysis").get(DEFAULT_STEADY_KEY)
    transient = get_registry("analysis").get(DEFAULT_TRANSIENT_KEY)
    assert steady.time_dependency == "steady"
    assert transient.time_dependency == "transient"
    assert steady.default_solver == "simpleFoam"
    assert transient.default_solver == "pimpleFoam"
    assert "simpleFoam" in steady.solver_backends
    assert "pimpleFoam" in transient.solver_backends
    assert "delta_t" in {f.key for f in transient.control_schema}
    assert "delta_t" not in {f.key for f in steady.control_schema}
    assert steady.category == "FLUID DYNAMICS"
    assert len(steady.bc_types) >= 20
    assert steady.region_roles == ("fluid",)
    assert steady.default_turbulence == "kOmegaSST"
    assert "nut" in steady.fields


def test_duplicate_different_plugin_still_raises():
    load_all()
    reg = get_registry("analysis")
    steady = reg.get(DEFAULT_STEADY_KEY)
    with pytest.raises(RegistryError, match="duplicate"):
        reg.register(steady, plugin="other_plugin")


def test_reset_for_tests_clears_analysis():
    load_all()
    assert DEFAULT_STEADY_KEY in get_registry("analysis").keys()
    reset_for_tests()
    assert get_registry("analysis").keys() == []
    load_all()
    assert DEFAULT_TRANSIENT_KEY in get_registry("analysis").keys()
