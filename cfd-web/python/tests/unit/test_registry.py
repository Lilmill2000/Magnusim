"""Phase 2 land1: registry core unit tests."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from cfddesk.registry import (
    PluginManifest,
    Registry,
    RegistryError,
    Requirement,
    SchemaField,
    check_requirements,
    get_registry,
    load_all,
    reset_for_tests,
    to_json_schema,
    validate,
)
from cfddesk.registry.discovery import get_hub


@dataclass(frozen=True)
class _DummySpec:
    key: str
    label: str
    supported: bool = True


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def test_load_all_succeeds_and_idempotent():
    hub1 = load_all()
    hub2 = load_all()
    assert hub1 is hub2
    # Land1 builtins register zero domain specs — hub still usable
    reg = get_registry("smoke")
    assert reg.kind == "smoke"
    assert reg.keys() == []


def test_register_get_duplicate_raises():
    reg = Registry("demo")
    reg.register(_DummySpec("a", "A"), plugin="builtin")
    assert reg.get("a").label == "A"
    assert reg.keys() == ["a"]
    # Same plugin re-register OK
    reg.register(_DummySpec("a", "A2"), plugin="builtin")
    assert reg.get("a").label == "A2"
    # Different plugin duplicate raises
    with pytest.raises(RegistryError, match="duplicate"):
        reg.register(_DummySpec("a", "Other"), plugin="other")
    with pytest.raises(RegistryError, match="unknown"):
        reg.get("missing")


def test_describe_includes_plugin():
    reg = Registry("demo")
    reg.register(_DummySpec("x", "X"), plugin="p1")
    desc = reg.describe()
    assert desc == [
        {"key": "x", "label": "X", "plugin": "p1", "supported": True}
    ]


def test_to_json_schema_and_validate_roundtrip():
    fields = [
        SchemaField(
            "speed",
            "Speed",
            "float",
            default=1.0,
            min=0.0,
            max=100.0,
            unit="m/s",
            quantity="velocity",
            group="flow",
        ),
        SchemaField("n", "Count", "int", default=1, min=1, max=8),
        SchemaField("mode", "Mode", "choice", default="a", choices=("a", "b")),
        SchemaField("on", "On", "bool", default=False),
        SchemaField("dir", "Direction", "vector3", default=(0.0, 0.0, 1.0)),
        SchemaField(
            "extra",
            "Extra",
            "float",
            default=0.0,
            depends_on={"mode": "b"},
            advanced=True,
        ),
    ]
    schema = to_json_schema(fields)
    assert schema["$schema"].endswith("draft/2020-12/schema")
    assert schema["type"] == "object"
    assert "speed" in schema["properties"]
    assert schema["properties"]["speed"]["type"] == "number"
    assert schema["properties"]["speed"]["minimum"] == 0.0
    assert schema["properties"]["speed"]["x-cfddesk"]["unit"] == "m/s"
    assert schema["properties"]["speed"]["x-cfddesk"]["quantity"] == "velocity"
    assert schema["properties"]["mode"]["enum"] == ["a", "b"]
    assert schema["properties"]["extra"]["x-cfddesk"]["depends_on"] == {"mode": "b"}
    assert schema["properties"]["extra"]["x-cfddesk"]["advanced"] is True

    assert validate(
        {"speed": 10.0, "n": 2, "mode": "a", "on": True, "dir": [1, 0, 0]}, fields
    ) == []
    errs = validate({"speed": -1.0, "n": "x", "mode": "z", "dir": [1, 2]}, fields)
    assert any("speed" in e for e in errs)
    assert any("n" in e for e in errs)
    assert any("mode" in e for e in errs)
    assert any("dir" in e for e in errs)


def test_temp_folder_plugin_and_requirements(tmp_path: Path, monkeypatch):
    plugins = tmp_path / "plugins" / "testplug"
    plugins.mkdir(parents=True)
    (plugins / "manifest.toml").write_text(
        'key = "testplug"\nname = "Test Plug"\nversion = "0.1.0"\n',
        encoding="utf-8",
    )
    (plugins / "plugin.py").write_text(
        """
from dataclasses import dataclass
from cfddesk.registry.manifest import PluginManifest
from cfddesk.registry.requirements import Requirement

@dataclass(frozen=True)
class Spec:
    key: str
    label: str

def register(hub):
    hub.registry("analysis").register(Spec("laminar_only", "Laminar Only"), plugin="testplug")
    return PluginManifest(
        key="testplug",
        name="Test Plug",
        version="0.1.0",
        requires=[Requirement("wsl_tool", "fakeToolXYZ", ">=1")],
        provides={"analysis": ["laminar_only"]},
    )
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("CFDDESK_WEB_ROOT", str(tmp_path))
    reset_for_tests()
    hub = load_all(web_root=tmp_path)
    assert "laminar_only" in hub.registry("analysis").keys()
    assert hub.registry("analysis").get("laminar_only").label == "Laminar Only"
    assert "testplug" in hub.manifests
    missing = check_requirements(hub.manifests["testplug"], env={"wsl_tools": set()})
    assert len(missing) == 1
    assert missing[0].requirement.name == "fakeToolXYZ"
    assert check_requirements(
        hub.manifests["testplug"], env={"wsl_tools": {"fakeToolXYZ"}}
    ) == []


def test_disabled_plugin_skipped(tmp_path: Path, monkeypatch):
    plugins = tmp_path / "plugins" / "disabledplug"
    plugins.mkdir(parents=True)
    (plugins / "manifest.toml").write_text(
        'key = "disabledplug"\nname = "D"\n', encoding="utf-8"
    )
    (plugins / "plugin.py").write_text(
        """
from dataclasses import dataclass
from cfddesk.registry.manifest import PluginManifest

@dataclass(frozen=True)
class Spec:
    key: str
    label: str

def register(hub):
    hub.registry("analysis").register(Spec("should_not", "No"), plugin="disabledplug")
    return PluginManifest(key="disabledplug", name="D")
""",
        encoding="utf-8",
    )
    (tmp_path / ".cfddesk-local.json").write_text(
        '{"plugins": {"disabled": ["disabledplug"]}}',
        encoding="utf-8",
    )
    monkeypatch.setenv("CFDDESK_WEB_ROOT", str(tmp_path))
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(tmp_path / ".cfddesk-local.json"))
    reset_for_tests()
    hub = load_all(web_root=tmp_path)
    assert "should_not" not in hub.registry("analysis").keys()


def test_failing_plugin_does_not_break_builtins(tmp_path: Path, monkeypatch):
    plugins = tmp_path / "plugins" / "badplug"
    plugins.mkdir(parents=True)
    (plugins / "manifest.toml").write_text(
        'key = "badplug"\nname = "Bad"\n', encoding="utf-8"
    )
    (plugins / "plugin.py").write_text("raise RuntimeError('boom')\n", encoding="utf-8")
    monkeypatch.setenv("CFDDESK_WEB_ROOT", str(tmp_path))
    reset_for_tests()
    hub = load_all(web_root=tmp_path)  # must not raise
    assert hub is get_hub()
    hub.registry("demo").register(_DummySpec("ok", "OK"), plugin="builtin")
    assert hub.registry("demo").get("ok").key == "ok"


def test_reset_for_tests_clears_state():
    hub = load_all()
    hub.registry("demo").register(_DummySpec("z", "Z"), plugin="builtin")
    assert "z" in get_registry("demo").keys()
    reset_for_tests()
    assert get_registry("demo").keys() == []


def test_setting_field_alias_still_works():
    """bc_registry.SettingField is SchemaField alias; BC_TYPES still load."""
    from cfddesk.case.bc_registry import BC_TYPES, SettingField
    from cfddesk.registry.schema import SchemaField

    assert SettingField is SchemaField
    assert len(BC_TYPES) >= 20
    f = SettingField("v", "V", "float", default=1.0, unit="m/s")
    assert f.key == "v"
    assert f.min is None