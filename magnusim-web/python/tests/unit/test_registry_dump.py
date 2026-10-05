"""Phase 2 land9: tools/registry_dump.py CLI + dump shape."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from cfddesk.registry import reset_for_tests
from cfddesk.registry.analysis import DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY

# Import dump helper from tools/ (same path layout as other CLI tests).
TOOLS = Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(TOOLS.parent))
sys.path.insert(0, str(TOOLS))

from registry_dump import DUMP_KINDS, dump_registry, main  # noqa: E402

from tests.unit.bundled_manifests import default_on_keys  # noqa: E402

EXPECTED_SOLVER_KEYS = {"simpleFoam", "pimpleFoam"}
EXPECTED_MESHER_KEYS = {"standard", "cfmesh", "snappy_hexdominant"}
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


def test_dump_registry_contains_builtin_keys():
    payload = dump_registry(force=True)
    assert set(DUMP_KINDS).issubset(payload.keys())
    assert "plugins" in payload
    assert "missing" in payload
    assert payload["missing"] == []

    analysis_keys = {row["key"] for row in payload["analysis"]}
    assert DEFAULT_STEADY_KEY in analysis_keys
    assert DEFAULT_TRANSIENT_KEY in analysis_keys

    assert {row["key"] for row in payload["solver"]} == EXPECTED_SOLVER_KEYS
    assert EXPECTED_MESHER_KEYS <= {row["key"] for row in payload["mesher"]}
    assert {row["key"] for row in payload["filter"]} == EXPECTED_FILTER_KEYS

    from tests.unit.if_bc_keys import IF_BC_KEYS

    assert tuple(row["key"] for row in payload["bc"]) == IF_BC_KEYS
    assert any(row["key"] == "newtonian_incompressible" for row in payload["material"])
    assert any(row["key"] == "area_average" for row in payload["monitor"])
    assert any(row["key"] == "flow_rate" for row in payload["monitor"])

    # describe() shape: key/label/plugin present
    for kind in DUMP_KINDS:
        for row in payload[kind]:
            assert "key" in row and "label" in row and "plugin" in row


def test_dump_check_requirements_reports_missing_with_empty_env():
    payload = dump_registry(check_reqs=True, env={}, force=True)
    assert isinstance(payload["missing"], list)
    # Built-in analysis/solver/mesher stamp wsl_tool requires; empty env => missing.
    names = {
        (m.get("requirement") or {}).get("name")
        for m in payload["missing"]
        if isinstance(m, dict)
    }
    assert "simpleFoam" in names or "pimpleFoam" in names


def test_cli_stdout_smoke(tmp_path: Path, monkeypatch):
    reset_for_tests()
    monkeypatch.chdir(tmp_path)
    # Capture via --out for stability under pytest capture
    out = tmp_path / "reg.json"
    rc = main(["--force", "--out", str(out)])
    assert rc == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert "analysis" in data
    assert any(r["key"] == DEFAULT_STEADY_KEY for r in data["analysis"])


def test_cli_subprocess_smoke():
    """Spawn the tool script like Node would (sys.path insert inside script)."""
    script = TOOLS / "registry_dump.py"
    assert script.is_file()
    py = sys.executable
    proc = subprocess.run(
        [py, str(script), "--force"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)
    assert set(DUMP_KINDS).issubset(data.keys())
    keys = {r["key"] for r in data["analysis"]}
    assert DEFAULT_STEADY_KEY in keys


def test_builtins_only_dump_ignores_installed_plugins(monkeypatch: pytest.MonkeyPatch):
    """gate:h6-registry-builtins-only: plugins on this PC never change the golden."""
    fixtures = Path(__file__).resolve().parents[1] / "fixtures" / "plugins"
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(fixtures))
    with_plugins = dump_registry(force=True)
    assert "example_extra_mesher" in {row["key"] for row in with_plugins["mesher"]}
    builtins = dump_registry(builtins_only=True)
    assert "example_extra_mesher" not in {row["key"] for row in builtins["mesher"]}
    assert "laminar_steady" not in {row["key"] for row in builtins["analysis"]}
    # What ships: the core plus the bundled plugins a fresh install turns on (every one
    # whose manifest does not set default_enabled = false), never a user plugin.
    shipped = default_on_keys()
    assert sorted(p["key"] for p in builtins["plugins"]) == shipped
    assert {row["plugin"] for kind in DUMP_KINDS for row in builtins[kind]} <= {"builtin", *shipped}
    monkeypatch.delenv("MAGNUSIM_PLUGINS_DIR")
    assert json.loads(json.dumps(builtins)) == json.loads(json.dumps(dump_registry(builtins_only=True)))


def test_shipped_dump_names_a_broken_bundled_manifest_bundled(tmp_path: Path):
    bundled = tmp_path / "bundled-plugins"
    (bundled / "broken").mkdir(parents=True)
    (bundled / "broken" / "manifest.toml").write_text('key = "broken"\nname =\n', encoding="utf-8")
    (bundled / "broken" / "plugin.py").write_text("def register(hub):\n    return None\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="'source': 'bundled'"):
        dump_registry(builtins_only=True, bundled_dir=bundled)
