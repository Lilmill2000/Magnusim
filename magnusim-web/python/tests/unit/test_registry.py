"""Phase 2 land1 / land1-fix: registry core unit tests."""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

from cfddesk.registry import (
    PluginManifest,
    Registry,
    RegistryError,
    SchemaField,
    check_requirements,
    get_registry,
    load_all,
    reset_for_tests,
    to_json_schema,
    validate,
)
from cfddesk.registry import discovery as discovery_mod
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
    # Hub usable; land2+ registers analysis builtins (tested separately)
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


def test_describe_schema_failure_warns(caplog):
    @dataclass
    class _Broken:
        key: str = "b"
        label: str = "B"
        settings_schema: object = object()  # not iterable SchemaFields

    reg = Registry("demo")
    reg.register(_Broken(), plugin="p1")
    with caplog.at_level(logging.WARNING, logger="cfddesk.registry.base"):
        desc = reg.describe()
    assert desc[0]["schema"] is None
    assert any("schema" in r.message.lower() for r in caplog.records)


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
    # All fields have defaults → not required
    assert "required" not in schema

    assert validate(
        {"speed": 10.0, "n": 2, "mode": "a", "on": True, "dir": [1, 0, 0]}, fields
    ) == []
    errs = validate({"speed": -1.0, "n": "x", "mode": "z", "dir": [1, 2]}, fields)
    assert any("speed" in e for e in errs)
    assert any("n" in e for e in errs)
    assert any("mode" in e for e in errs)
    assert any("dir" in e for e in errs)


def test_required_fields_in_schema_and_validate():
    fields = [
        SchemaField("name", "Name", "text"),  # default None → required
        SchemaField("n", "Count", "int", default=1),
        SchemaField("flag", "Flag", "bool"),  # bool + None default → optional
        SchemaField("meta", "Meta", "raw_dict"),  # raw_dict → optional
        SchemaField(
            "detail",
            "Detail",
            "text",
            depends_on={"name": "special"},
        ),
    ]
    schema = to_json_schema(fields)
    assert schema["required"] == ["name", "detail"]
    assert validate({"name": "ok", "n": 2}, fields) == []
    errs = validate({"n": 2}, fields)
    assert any("missing required field 'name'" in e for e in errs)
    # detail only required when depends_on matches
    assert validate({"name": "other"}, fields) == []
    errs2 = validate({"name": "special"}, fields)
    assert any("missing required field 'detail'" in e for e in errs2)
    assert validate({"name": "special", "detail": "x"}, fields) == []


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


def test_load_all_retries_after_plugin_failure(tmp_path: Path, monkeypatch):
    """Partial load leaves _LOADED False so a later load_all() retries without force."""
    plugins = tmp_path / "plugins" / "flaky"
    plugins.mkdir(parents=True)
    (plugins / "manifest.toml").write_text(
        'key = "flaky"\nname = "Flaky"\nversion = "0.1.0"\n',
        encoding="utf-8",
    )
    (plugins / "plugin.py").write_text("raise RuntimeError('boom')\n", encoding="utf-8")
    monkeypatch.setenv("CFDDESK_WEB_ROOT", str(tmp_path))
    reset_for_tests()
    hub1 = load_all(web_root=tmp_path)
    assert discovery_mod._LOADED is False
    assert "recovered" not in hub1.registry("analysis").keys()
    # Builtins remain; demo registration from first attempt survives retry
    hub1.registry("demo").register(_DummySpec("kept", "Kept"), plugin="builtin")

    (plugins / "plugin.py").write_text(
        """
from dataclasses import dataclass
from cfddesk.registry.manifest import PluginManifest

@dataclass(frozen=True)
class Spec:
    key: str
    label: str

def register(hub):
    hub.registry("analysis").register(Spec("recovered", "Recovered"), plugin="flaky")
    return PluginManifest(key="flaky", name="Flaky", version="0.1.0",
                          provides={"analysis": ["recovered"]})
""",
        encoding="utf-8",
    )
    # Drop cached failed module so re-import picks up the fixed file
    sys.modules.pop("cfddesk._plugins.flaky", None)

    hub2 = load_all(web_root=tmp_path)  # no force=
    assert hub2 is hub1
    assert discovery_mod._LOADED is True
    assert "recovered" in hub2.registry("analysis").keys()
    assert "kept" in hub2.registry("demo").keys()  # builtins / prior regs not wiped



def test_load_all_retries_after_ep_load_failure(monkeypatch):
    """Failed EP import leaves _LOADED False so a later load_all() retries without force."""
    calls = {"n": 0}

    class FlakyEP:
        name = "flaky_ep"

        def load(self):
            calls["n"] += 1
            if calls["n"] == 1:
                raise ImportError("boom on first EP load")

            def register(hub):
                hub.registry("analysis").register(
                    _DummySpec("from_ep", "From EP"), plugin="flaky_ep"
                )
                return PluginManifest(
                    key="flaky_ep",
                    name="Flaky EP",
                    version="0.1.0",
                    provides={"analysis": ["from_ep"]},
                )

            return register

    class FakeEPs:
        def select(self, group=None):
            return [FlakyEP()]

    import importlib.metadata as md

    monkeypatch.setattr(md, "entry_points", lambda: FakeEPs())
    reset_for_tests()
    hub1 = load_all()
    assert discovery_mod._LOADED is False
    assert "from_ep" not in hub1.registry("analysis").keys()
    hub1.registry("demo").register(_DummySpec("kept", "Kept"), plugin="builtin")

    hub2 = load_all()  # no force=
    assert hub2 is hub1
    assert discovery_mod._LOADED is True
    assert "from_ep" in hub2.registry("analysis").keys()
    assert "kept" in hub2.registry("demo").keys()


def test_ep_non_callable_feeds_had_failures(monkeypatch):
    """Non-callable EP load result must also keep _LOADED False."""

    class BadEP:
        name = "not_callable_ep"

        def load(self):
            return object()  # not callable

    class FakeEPs:
        def select(self, group=None):
            return [BadEP()]

    import importlib.metadata as md

    monkeypatch.setattr(md, "entry_points", lambda: FakeEPs())
    reset_for_tests()
    load_all()
    assert discovery_mod._LOADED is False


def test_toml_fallback_fail_closed_on_tables(monkeypatch, caplog):
    """Without tomllib/tomli, manifests with [tables]/requires arrays must not silently degrade."""
    real_import = __import__

    def _fake_import(name, *args, **kwargs):
        if name in ("tomllib", "tomli"):
            raise ImportError(f"blocked {name}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", _fake_import)
    text = '''key = "p"
name = "P"

[requires]
tool = "x"
'''
    with caplog.at_level(logging.WARNING, logger="cfddesk.registry.discovery"):
        result = discovery_mod._parse_simple_toml(text, source="plugins/p/manifest.toml")
    assert result is None
    assert any("refusing" in r.message.lower() or "tables" in r.message.lower() for r in caplog.records)


def test_toml_fallback_fail_closed_on_requires_array(monkeypatch, caplog):
    real_import = __import__

    def _fake_import(name, *args, **kwargs):
        if name in ("tomllib", "tomli"):
            raise ImportError(f"blocked {name}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", _fake_import)
    text = 'key = "p"\nrequires = [{kind = "wsl_tool", name = "blockMesh"}]\n'
    with caplog.at_level(logging.WARNING, logger="cfddesk.registry.discovery"):
        result = discovery_mod._parse_simple_toml(text, source="plugins/p/manifest.toml")
    assert result is None
    assert any("requires" in r.message.lower() or "refusing" in r.message.lower() for r in caplog.records)


def test_toml_fallback_flat_ok(monkeypatch):
    real_import = __import__

    def _fake_import(name, *args, **kwargs):
        if name in ("tomllib", "tomli"):
            raise ImportError(f"blocked {name}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", _fake_import)
    text = 'key = "p"\nname = "P"\nversion = "1.0.0"\n'
    result = discovery_mod._parse_simple_toml(text, source="plugins/p/manifest.toml")
    assert result == {"key": "p", "name": "P", "version": "1.0.0"}


def test_no_public_uimanifest_export():
    import cfddesk.registry as reg

    assert "UiManifest" not in reg.__all__
    assert not hasattr(reg, "UiManifest")
    assert hasattr(PluginManifest, "ui")


def test_reset_for_tests_clears_state():
    hub = load_all()
    hub.registry("demo").register(_DummySpec("z", "Z"), plugin="builtin")
    assert "z" in get_registry("demo").keys()
    reset_for_tests()
    assert get_registry("demo").keys() == []


def test_setting_field_alias_still_works():
    """bc_registry.SettingField is SchemaField alias; BC_TYPES still load."""
    from cfddesk.case.bc_registry import BC_TYPES, SettingField
    from cfddesk.registry.schema import SchemaField as SF

    assert SettingField is SF
    assert len(BC_TYPES) == 7
    f = SettingField("v", "V", "float", default=1.0, unit="m/s")
    assert f.key == "v"
    assert f.min is None
