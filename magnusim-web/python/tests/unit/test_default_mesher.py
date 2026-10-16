"""API 1.8: the mesher a new mesh of an analysis's studies starts with (``AnalysisType.default_mesher``).

A test plugin's analysis that names a registered mesher publishes it on its row; one that
names a mesher no plugin registers still loads, its row keeps the name (the page and the
server use it only when that mesher is registered: src/defaultMesher.ts) and its plugin's
Settings row says so. Heat Transfer's analyses name Hex-dominant; Incompressible Flow's
name none. A builtin analysis naming an unknown mesher is a core bug.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import RegistryHub, plugin_catalog
from tests.unit.bundled_manifests import installed

HEAD = """
from cfddesk.registry import AnalysisType
from cfddesk.registry.manifest import PluginManifest

KEY = "{key}"


def register(hub):
    hub.registry("analysis").register(
        AnalysisType(key="fx_meshed", label="Meshed", category="test", time_dependency="steady", fields=("U",),
                     bc_types=("wall_noslip",), default_mesher=MESHER),
        plugin=KEY,
    )
    return PluginManifest(key=KEY, name="Meshed", version="0.1.0")
"""


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    yield
    reset_for_tests()


def _load(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mesher: str, key: str = "fx-mesher") -> RegistryHub:
    d = tmp_path / "plugins" / key
    d.mkdir(parents=True)
    (d / "manifest.toml").write_text(
        f'key = "{key}"\nname = "{key}"\nversion = "0.1.0"\napi_version = "1.8"\nrequires_plugins = ["incompressible_flow"]\n',
        encoding="utf-8",
    )
    (d / "plugin.py").write_text(f"MESHER = {mesher!r}\n" + HEAD.format(key=key), encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(tmp_path / "plugins"))
    return load_all(web_root=tmp_path, force=True)


def _row(hub: RegistryHub, key: str) -> dict:
    return {r["key"]: r for r in hub.registry("analysis").describe()}[key]


def test_an_analysis_publishes_the_mesher_its_new_meshes_start_with(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hub = _load(tmp_path, monkeypatch, "snappy_hexdominant")
    assert [f for f in hub.failures if f["key"] == "fx-mesher"] == []
    assert _row(hub, "fx_meshed")["default_mesher"] == "snappy_hexdominant"
    plugin = {r["key"]: r for r in plugin_catalog(tmp_path)}["fx-mesher"]
    assert not [n for n in plugin["notes"] if "default_mesher" in n]
    # Incompressible Flow names none (its new meshes stay on the app's default, Standard).
    assert _row(hub, "incompressible_steady")["default_mesher"] == ""
    assert _row(hub, "incompressible_transient")["default_mesher"] == ""
    if installed("heat_transfer"):
        assert _row(hub, "heat_transfer_steady")["default_mesher"] == "snappy_hexdominant"
        assert _row(hub, "heat_transfer_transient")["default_mesher"] == "snappy_hexdominant"


def test_a_mesher_no_plugin_registers_is_said_on_the_settings_row_and_the_analysis_still_loads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hub = _load(tmp_path, monkeypatch, "no_such_mesher")
    assert [f for f in hub.failures if f["key"] == "fx-mesher"] == []
    assert "fx_meshed" in hub.registry("analysis").keys()
    assert _row(hub, "fx_meshed")["default_mesher"] == "no_such_mesher"
    plugin = {r["key"]: r for r in plugin_catalog(tmp_path)}["fx-mesher"]
    notes = [n for n in plugin["notes"] if "default_mesher" in n]
    assert len(notes) == 1
    assert "'no_such_mesher' is not a mesher this app has" in notes[0]
    assert "new meshes in its studies start on the app's default mesher" in notes[0]


def test_a_builtin_analysis_naming_an_unknown_mesher_is_a_core_bug() -> None:
    from cfddesk.registry import AnalysisType
    from cfddesk.registry.base import RegistryError
    from cfddesk.registry.mesher import note_default_meshers

    hub = RegistryHub()
    hub.registry("analysis").register(
        AnalysisType(key="core_bad", label="Bad", category="test", time_dependency="steady", fields=("U",), default_mesher="nope")
    )
    with pytest.raises(RegistryError, match="default_mesher 'nope'"):
        note_default_meshers(hub)


def test_a_builtin_analysis_naming_an_unknown_mesher_stops_load_all(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import cfddesk.builtin as builtin
    from cfddesk.registry import AnalysisType
    from cfddesk.registry.base import RegistryError

    real = builtin.register_builtins

    def with_a_bad_one(hub: RegistryHub) -> None:
        real(hub)
        hub.registry("analysis").register(
            AnalysisType(key="core_bad", label="Bad", category="test", time_dependency="steady", fields=("U",), default_mesher="nope")
        )

    monkeypatch.setattr(builtin, "register_builtins", with_a_bad_one)
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(tmp_path / "plugins"))
    with pytest.raises(RegistryError, match="analysis 'core_bad': default_mesher 'nope'"):
        load_all(web_root=tmp_path, force=True)


def test_only_a_mesher_a_new_mesh_can_use_counts_as_known() -> None:
    """The rule of src/defaultMesher.ts: the core's product engines, then plugin meshers. A
    core mesher that is not a product engine is not one a new mesh can start on."""
    import dataclasses

    from cfddesk.builtin import register_builtins
    from cfddesk.registry import AnalysisType
    from cfddesk.registry.mesher import CORE_MESH_ENGINES, new_mesh_engines, note_default_meshers

    hub = RegistryHub()
    register_builtins(hub)
    meshers = hub.registry("mesher")
    standard = meshers.get("standard")
    meshers.register(dataclasses.replace(standard, key="core_algorithm_only"))
    meshers.register(dataclasses.replace(standard, key="fx_plugin_mesher"), plugin="fx")
    assert new_mesh_engines(hub) == [k for k in CORE_MESH_ENGINES if k in meshers.keys()] + ["fx_plugin_mesher"]
    for key, want in (("fx_algo", "core_algorithm_only"), ("fx_plugin", "fx_plugin_mesher"), ("fx_core", "cfmesh")):
        hub.registry("analysis").register(
            AnalysisType(key=key, label=key, category="test", time_dependency="steady", fields=("U",), default_mesher=want),
            plugin="fx",
        )
    notes = note_default_meshers(hub)
    assert [owner for owner, _ in notes] == ["fx"]
    assert "default_mesher 'core_algorithm_only' is not a mesher this app has" in notes[0][1]


def test_the_core_engines_are_the_pages() -> None:
    """src/defaultMesher.ts CORE_MESH_ENGINES and cfddesk.registry.mesher's are one list."""
    import re

    from cfddesk.registry.mesher import CORE_MESH_ENGINES

    ts = (Path(__file__).resolve().parents[3] / "src" / "defaultMesher.ts").read_text(encoding="utf-8")
    m = re.search(r"CORE_MESH_ENGINES[^=]*=\s*Object\.freeze\(\[([^\]]*)\]", ts)
    assert m, "CORE_MESH_ENGINES not found in src/defaultMesher.ts"
    assert tuple(re.findall(r"'([^']+)'", m.group(1))) == CORE_MESH_ENGINES
