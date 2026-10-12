"""API 1.8: an analysis adds fields to the BCs of its studies (``AnalysisType.bc_fields``).

A test plugin's analysis offers Incompressible Flow's BC families and adds a
"Thermal" group to them, without IF's families changing.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import RegistryHub

HEAD = """
from cfddesk.registry import AnalysisType, BcFieldGroup, SchemaField
from cfddesk.registry.manifest import PluginManifest

KEY = "{key}"
T_IN = SchemaField("inlet_temperature", "Inlet temperature", "float", default=293.15, quantity="temperature")
MODE = SchemaField("thermal_wall", "Thermal", "choice", default="Adiabatic", choices=("Adiabatic", "Fixed temperature"))
T_WALL = SchemaField(
    "wall_temperature", "Wall temperature", "float", default=293.15, quantity="temperature",
    depends_on={{"thermal_wall": "Fixed temperature"}},
)


def analysis(groups):
    return AnalysisType(
        key="fx_heat", label="Heat", category="test", time_dependency="steady", fields=("U", "T"),
        bc_types=("velocity_inlet_fixed", "wall_noslip", "wall_slip", "pressure_outlet_gauge"),
        bc_fields=groups,
    )
"""

GOOD = """
def register(hub):
    hub.registry("analysis").register(analysis((
        BcFieldGroup("inlet_thermal", "Thermal", (T_IN,), families=("velocity_inlet",)),
        BcFieldGroup("wall_thermal", "Thermal", (MODE, T_WALL), families=("wall",), ui="FxWallThermal",
                     description="Heat through the wall."),
        BcFieldGroup("everywhere", "Tag", (SchemaField("tag", "Tag", "text", default=""),)),
    )), plugin=KEY)
    return PluginManifest(key=KEY, name="Heat fields", version="0.1.0")
"""

UNKNOWN_FAMILY = """
def register(hub):
    hub.registry("analysis").register(analysis((BcFieldGroup("g", "G", (T_IN,), families=("no_such_family",)),)), plugin=KEY)
    return PluginManifest(key=KEY, name="Ghost", version="0.1.0")
"""

FAMILY_KEY_CLASH = """
def register(hub):
    hub.registry("analysis").register(analysis((
        BcFieldGroup("g", "G", (SchemaField("wall_type", "Wall type", "text", default=""),), families=("wall",)),
    )), plugin=KEY)
    return PluginManifest(key=KEY, name="Clash", version="0.1.0")
"""

HOST_KEY_CLASH = """
def register(hub):
    hub.registry("analysis").register(analysis((BcFieldGroup("g", "G", (SchemaField("faces", "F", "text"),)),)), plugin=KEY)
    return PluginManifest(key=KEY, name="Host clash", version="0.1.0")
"""

TWICE = """
def register(hub):
    hub.registry("analysis").register(analysis((
        BcFieldGroup("a", "A", (T_IN,)), BcFieldGroup("b", "B", (T_IN,)),
    )), plugin=KEY)
    return PluginManifest(key=KEY, name="Twice", version="0.1.0")
"""


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    yield
    reset_for_tests()


def _load(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, body: str, key: str = "fx-heat") -> RegistryHub:
    d = tmp_path / "plugins" / key
    d.mkdir(parents=True)
    (d / "manifest.toml").write_text(
        f'key = "{key}"\nname = "{key}"\nversion = "0.1.0"\napi_version = "1.8"\nrequires_plugins = ["incompressible_flow"]\n',
        encoding="utf-8",
    )
    (d / "plugin.py").write_text(HEAD.format(key=key) + body, encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(tmp_path / "plugins"))
    return load_all(web_root=tmp_path, force=True)


def _failure(hub: RegistryHub, key: str = "fx-heat") -> str:
    rows = [f for f in hub.failures if f["key"] == key]
    return str(rows[0]["error"]) if rows else ""


def test_an_analysis_publishes_its_bc_field_groups(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hub = _load(tmp_path, monkeypatch, GOOD)
    assert _failure(hub) == ""
    row = {r["key"]: r for r in hub.registry("analysis").describe()}["fx_heat"]
    groups = {g["key"]: g for g in row["bc_fields"]}
    assert list(groups) == ["inlet_thermal", "wall_thermal", "everywhere"]
    assert groups["inlet_thermal"]["families"] == ["velocity_inlet"]
    assert groups["inlet_thermal"]["schema"]["properties"]["inlet_temperature"]["x-cfddesk"]["quantity"] == "temperature"
    wall = groups["wall_thermal"]
    assert (wall["title"], wall["ui"], wall["description"]) == ("Thermal", "FxWallThermal", "Heat through the wall.")
    assert wall["schema"]["properties"]["wall_temperature"]["x-cfddesk"]["depends_on"] == {"thermal_wall": "Fixed temperature"}
    assert groups["everywhere"]["families"] == []
    json.dumps(row["bc_fields"])
    # IF's own analyses add none, and its families are unchanged.
    assert {r["key"]: r for r in hub.registry("analysis").describe()}["incompressible_steady"]["bc_fields"] == []


@pytest.mark.parametrize(
    ("body", "why"),
    [
        (UNKNOWN_FAMILY, "names unknown bc_family ['no_such_family']"),
        (FAMILY_KEY_CLASH, "field 'wall_type' is a key the BC record already holds"),
        (HOST_KEY_CLASH, "field 'faces' is a key the BC record already holds"),
        (TWICE, "bc_fields field 'inlet_temperature' is in two groups"),
    ],
)
def test_a_bad_group_unloads_its_plugin_and_says_why(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, body: str, why: str
) -> None:
    hub = _load(tmp_path, monkeypatch, body)
    assert why in _failure(hub)
    assert "fx_heat" not in hub.registry("analysis").keys()
    assert "incompressible_steady" in hub.registry("analysis").keys()
