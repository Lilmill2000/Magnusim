"""Phase 2 land10: broader registry/golden prove (p2-tests) + stale registry.json.

Covers load_all kinds, builtin key sets (land2-6 / test_registry_dump EXPECTED_*),
dump/describe smoke, analysis schema_defaults+validate, and committed registry.json
stale check (--check / check_committed_registry).

Fingerprint / migration / web-mirror coverage is NOT duplicated here - see:
  - tests/unit/test_geometry_bodies.py (land7 v14 bodies + fingerprint soft-pass)
  - tests/unit/test_web_mirrors_land8.py (land8 v15 write-through mirrors)
  - tests/unit/test_project_migrations.py (v5..v13 migrations)
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from cfddesk.case.bc_registry import BC_TYPES
from cfddesk.registry import (
    AnalysisType,
    SchemaField,
    get_registry,
    load_all,
    reset_for_tests,
    schema_defaults,
    validate,
)
from cfddesk.registry.analysis import DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY

TOOLS = Path(__file__).resolve().parents[2] / "tools"
WEB_ROOT = Path(__file__).resolve().parents[3]
COMMITTED_REGISTRY = WEB_ROOT / "scripts" / "generated" / "registry.json"
sys.path.insert(0, str(TOOLS.parent))
sys.path.insert(0, str(TOOLS))

from registry_dump import (  # noqa: E402
    DUMP_KINDS,
    check_committed_registry,
    dump_registry,
    main,
)

EXPECTED_ANALYSIS_KEYS = {DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY}
EXPECTED_SOLVER_KEYS = {"simpleFoam", "pimpleFoam", "simpleFoam_amgx"}
EXPECTED_MESHER_KEYS = {"standard", "cfmesh", "snappy_hexdominant"}
EXPECTED_MATERIAL_KEYS = {"newtonian_incompressible"}
EXPECTED_MONITOR_KEYS = {"area_average", "flow_rate"}
EXPECTED_FILTER_KEYS = {
    "cut_plane",
    "streamlines",
    "plot_over_path",
    "iso_surface",
    "iso_volume",
    "inspect_point",
    "surface_field",
    "mesh_surface",
    "mesh_section",
}


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def test_load_all_kinds_present():
    hub = load_all(force=True)
    for kind in DUMP_KINDS:
        assert kind in hub.kinds()
        reg = get_registry(kind)
        assert hub.registry(kind) is reg
        assert len(reg.keys()) > 0


def test_builtin_keys_match_land2_through_land6():
    load_all(force=True)
    assert EXPECTED_ANALYSIS_KEYS <= set(get_registry("analysis").keys())
    assert set(get_registry("solver").keys()) == EXPECTED_SOLVER_KEYS
    assert set(get_registry("mesher").keys()) == EXPECTED_MESHER_KEYS
    assert set(get_registry("bc").keys()) == set(BC_TYPES.keys())
    assert len(get_registry("bc").keys()) == 7
    assert set(get_registry("material").keys()) == EXPECTED_MATERIAL_KEYS
    assert set(get_registry("monitor").keys()) == EXPECTED_MONITOR_KEYS
    assert set(get_registry("filter").keys()) == EXPECTED_FILTER_KEYS


def test_dump_and_describe_smoke_across_kinds():
    payload = dump_registry(force=True)
    assert set(DUMP_KINDS).issubset(payload.keys())
    assert "plugins" in payload and "missing" in payload
    assert payload["missing"] == []

    assert EXPECTED_ANALYSIS_KEYS <= {row["key"] for row in payload["analysis"]}
    assert {row["key"] for row in payload["solver"]} == EXPECTED_SOLVER_KEYS
    assert {row["key"] for row in payload["mesher"]} == EXPECTED_MESHER_KEYS
    assert {row["key"] for row in payload["bc"]} == set(BC_TYPES.keys())
    assert {row["key"] for row in payload["material"]} == EXPECTED_MATERIAL_KEYS
    assert {row["key"] for row in payload["monitor"]} == EXPECTED_MONITOR_KEYS
    assert {row["key"] for row in payload["filter"]} == EXPECTED_FILTER_KEYS

    for kind in DUMP_KINDS:
        live = get_registry(kind).describe()
        assert payload[kind] == live
        for row in live:
            assert "key" in row and "label" in row and "plugin" in row


def test_analysis_schema_defaults_validate():
    """land2 pattern: schema_defaults + validate for each analysis schema bag."""
    load_all(force=True)
    reg = get_registry("analysis")
    for key in (DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY):
        spec = reg.get(key)
        assert isinstance(spec, AnalysisType)
        for schema_name in ("settings_schema", "numerics_schema", "control_schema"):
            fields = getattr(spec, schema_name)
            assert isinstance(fields, tuple) and len(fields) > 0
            assert all(isinstance(f, SchemaField) for f in fields)
            defaults = schema_defaults(fields)
            errors = validate(defaults, fields)
            assert errors == [], f"{key}.{schema_name}: {errors}"


def test_committed_registry_json_matches_live_dump():
    assert COMMITTED_REGISTRY.is_file(), f"missing {COMMITTED_REGISTRY}"
    ok, message = check_committed_registry(committed_path=COMMITTED_REGISTRY, force=True)
    assert ok, message
    rc = main(["--check", "--committed", str(COMMITTED_REGISTRY)])
    assert rc == 0


def test_intentional_registry_drift_fails_check(tmp_path: Path):
    """HARD: prove stale check fails when committed JSON intentionally drifts."""
    fresh = dump_registry(force=True)
    drifted = json.loads(json.dumps(fresh))
    # Mutate a stable builtin label so equality must fail.
    assert drifted["analysis"], "expected analysis rows"
    drifted["analysis"][0]["label"] = "INTENTIONAL_DRIFT_LABEL"
    stale_path = tmp_path / "registry.json"
    stale_path.write_text(
        json.dumps(drifted, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )

    ok, message = check_committed_registry(committed_path=stale_path, force=True)
    assert ok is False
    assert "stale" in message.lower() or "drift" in message.lower()

    rc = main(["--check", "--committed", str(stale_path)])
    assert rc == 1


def test_check_cli_subprocess_smoke():
    script = TOOLS / "registry_dump.py"
    assert script.is_file()
    proc = subprocess.run(
        [sys.executable, str(script), "--check", "--committed", str(COMMITTED_REGISTRY)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr or proc.stdout
    data = json.loads(proc.stdout)
    assert data.get("ok") is True
