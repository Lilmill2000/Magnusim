"""API 1.8: what a new BC of a family starts with in an analysis's studies (``AnalysisType.bc_seeds``).

A test plugin's analysis offers Incompressible Flow's wall family and seeds its new
Wall no-slip; a seed that names a family it does not offer, a field the family does
not hold or a choice the field does not have unloads the plugin with the reason.
Heat Transfer's own analyses seed their walls no-slip; Incompressible Flow's seed nothing.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import RegistryHub
from tests.unit.bundled_manifests import installed

HEAD = """
from cfddesk.registry import AnalysisType
from cfddesk.registry.manifest import PluginManifest

KEY = "{key}"


def analysis(seeds):
    return AnalysisType(
        key="fx_seeded", label="Seeded", category="test", time_dependency="steady", fields=("U",),
        bc_types=("velocity_inlet_fixed", "wall_noslip", "wall_slip", "pressure_outlet_gauge"),
        bc_seeds=seeds,
    )


def register(hub):
    hub.registry("analysis").register(analysis(SEEDS), plugin=KEY)
    return PluginManifest(key=KEY, name="Seeds", version="0.1.0")
"""


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    yield
    reset_for_tests()


def _load(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seeds: str, key: str = "fx-seeds") -> RegistryHub:
    d = tmp_path / "plugins" / key
    d.mkdir(parents=True)
    (d / "manifest.toml").write_text(
        f'key = "{key}"\nname = "{key}"\nversion = "0.1.0"\napi_version = "1.8"\nrequires_plugins = ["incompressible_flow"]\n',
        encoding="utf-8",
    )
    (d / "plugin.py").write_text(f"SEEDS = {seeds}\n" + HEAD.format(key=key), encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(tmp_path / "plugins"))
    return load_all(web_root=tmp_path, force=True)


def _failure(hub: RegistryHub, key: str = "fx-seeds") -> str:
    rows = [f for f in hub.failures if f["key"] == key]
    return str(rows[0]["error"]) if rows else ""


def test_an_analysis_publishes_its_bc_seeds(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hub = _load(tmp_path, monkeypatch, '{"wall": {"wall_type": "No-slip"}}')
    assert _failure(hub) == ""
    rows = {r["key"]: r for r in hub.registry("analysis").describe()}
    assert rows["fx_seeded"]["bc_seeds"] == {"wall": {"wall_type": "No-slip"}}
    json.dumps(rows["fx_seeded"]["bc_seeds"])
    # Incompressible Flow's analyses seed nothing (its new Wall keeps starting slip).
    assert rows["incompressible_steady"]["bc_seeds"] == {}
    # Heat Transfer's new Wall starts no-slip (when it is installed).
    if installed("heat_transfer"):
        assert rows["heat_transfer_steady"]["bc_seeds"] == {"wall": {"wall_type": "No-slip"}}
        assert rows["heat_transfer_transient"]["bc_seeds"] == {"wall": {"wall_type": "No-slip"}}


@pytest.mark.parametrize(
    ("seeds", "why"),
    [
        ('{"symmetry": {"x": 1}}', "bc_seeds names bc_family 'symmetry', which it does not offer"),
        ('{"wall": {"no_such": "x"}}', "bc_seeds['wall'] field 'no_such' is not a field of the family"),
        ('{"wall": {"wall_type": "Sticky"}}', "bc_seeds['wall']['wall_type'] = 'Sticky' is not one of"),
        ('{"wall": {"wall_type": ["No-slip"]}}', "bc_seeds['wall']['wall_type'] must be a string, number or bool"),
        ('{"wall": {}}', "bc_seeds['wall'] must be a non-empty dict of field values"),
    ],
)
def test_a_bad_seed_unloads_its_plugin_and_says_why(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seeds: str, why: str
) -> None:
    hub = _load(tmp_path, monkeypatch, seeds)
    assert why in _failure(hub)
    assert "fx_seeded" not in hub.registry("analysis").keys()
    assert "incompressible_steady" in hub.registry("analysis").keys()
