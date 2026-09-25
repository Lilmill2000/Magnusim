"""Phase 2 land16: describe/dump fill for numerics_schema + control_schema."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from cfddesk.registry import get_registry, load_all, reset_for_tests
from cfddesk.registry.analysis import DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY

TOOLS = Path(__file__).resolve().parents[2] / "tools"
WEB_ROOT = Path(__file__).resolve().parents[3]
COMMITTED_REGISTRY = WEB_ROOT / "scripts" / "generated" / "registry.json"
sys.path.insert(0, str(TOOLS.parent))
sys.path.insert(0, str(TOOLS))

from registry_dump import dump_registry, main  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def _assert_json_schema_bag(bag: dict, *, required_props: set[str]) -> None:
    assert isinstance(bag, dict)
    assert bag.get("type") == "object"
    props = bag.get("properties")
    assert isinstance(props, dict)
    for key in required_props:
        assert key in props, f"missing property {key!r}"
        assert "default" in props[key], f"{key} missing default"
        assert "title" in props[key]


def test_describe_emits_numerics_and_control_for_analysis():
    load_all(force=True)
    by_key = {d["key"]: d for d in get_registry("analysis").describe()}

    steady = by_key[DEFAULT_STEADY_KEY]
    transient = by_key[DEFAULT_TRANSIENT_KEY]

    for row in (steady, transient):
        assert isinstance(row.get("schema"), dict)
        assert "turbulence_model" in row["schema"]["properties"]
        # Energy / passive species never reached a solve; Phase 6 removed them.
        assert set(row["schema"]["properties"]) == {"turbulence_model"}
        _assert_json_schema_bag(
            row["numerics_schema"],
            required_props=set(),
        )
        # The time scheme lives on the run panel (a select); no free-text ddt field.
        assert "ddt_default" not in row["numerics_schema"]["properties"]
        _assert_json_schema_bag(
            row["control_schema"],
            required_props={"end_time", "write_interval", "write_control"},
        )

    assert "delta_t" not in steady["control_schema"]["properties"]
    assert "delta_t" in transient["control_schema"]["properties"]
    assert transient["control_schema"]["properties"]["delta_t"]["default"] == 0.001

    # Steady SIMPLE numerics the solve reads; defaults match the pre-Phase-6 writer.
    steady_numerics = steady["numerics_schema"]["properties"]
    assert set(steady_numerics) == {"residual_u", "residual_p", "relax_u", "relax_p", "n_non_orthogonal"}
    assert steady_numerics["residual_u"]["default"] == 1e-4
    assert steady_numerics["n_non_orthogonal"]["default"] == 3
    assert all(prop.get("description") for prop in steady_numerics.values())
    # PIMPLE settings come from the run panel, so the transient row has none.
    assert transient["numerics_schema"]["properties"] == {}
    assert steady["time_dependency"] == "steady"
    assert transient["time_dependency"] == "transient"
    assert steady["default_turbulence"] == "kOmegaSST"
    assert steady["default_solver"] == "simpleFoam"
    assert transient["default_solver"] == "pimpleFoam"


def test_dump_registry_analysis_includes_numerics_control():
    payload = dump_registry(force=True)
    by_key = {row["key"]: row for row in payload["analysis"]}
    assert DEFAULT_STEADY_KEY in by_key and DEFAULT_TRANSIENT_KEY in by_key
    for key in (DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY):
        row = by_key[key]
        assert "numerics_schema" in row and "control_schema" in row
        if key == DEFAULT_STEADY_KEY:
            assert row["numerics_schema"]["properties"]["residual_u"]["default"] == 1e-4
        assert "end_time" in row["control_schema"]["properties"]

    # Non-analysis kinds must not invent empty numerics/control keys.
    for kind in ("solver", "mesher", "bc", "material", "monitor", "filter"):
        for row in payload[kind]:
            assert "numerics_schema" not in row
            assert "control_schema" not in row


def test_other_kinds_describe_unchanged_no_numerics_control():
    load_all(force=True)
    for kind in ("solver", "mesher", "filter"):
        for row in get_registry(kind).describe():
            assert "numerics_schema" not in row
            assert "control_schema" not in row


def test_registry_dump_check_green_after_describe_fill():
    assert COMMITTED_REGISTRY.is_file()
    rc = main(["--check", "--committed", str(COMMITTED_REGISTRY)])
    assert rc == 0


def test_cli_check_subprocess_still_green():
    script = TOOLS / "registry_dump.py"
    proc = subprocess.run(
        [sys.executable, str(script), "--check", "--committed", str(COMMITTED_REGISTRY)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr or proc.stdout
    data = json.loads(proc.stdout)
    assert data.get("ok") is True
