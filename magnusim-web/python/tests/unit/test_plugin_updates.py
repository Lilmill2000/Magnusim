"""Plugin updates: a newer copy of a bundled plugin in the user's plugins folder.

One copy of each plugin is chosen before any is imported: the higher version
wins, a tie goes to the app's own copy, and only the chosen copy's register()
runs. A used update loads as the bundled plugin (its required / default-on flags
stay the app's own), and an update that fails to load falls back to the app's copy.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import get_registry, plugin_catalog
from cfddesk.registry.versions import compare_versions

WEB = Path(__file__).resolve().parents[3]


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    yield
    reset_for_tests()


def _register_body(tag: str, log: Path, *, fail: bool = False) -> str:
    """register(): note which copy ran, register a solver named after the copy."""
    lines = [
        "from types import SimpleNamespace",
        "def register(hub):",
        f"    with open({str(log)!r}, 'a', encoding='utf-8') as fh:",
        f"        fh.write({tag!r} + '\\n')",
        f"    hub.registry('probe_kind').register(SimpleNamespace(key={tag!r}), plugin='demo')",
    ]
    if fail:
        lines.append("    raise RuntimeError('update is broken')")
    lines.append("    return None")
    return "\n".join(lines) + "\n"


def _plugin(folder: Path, dirname: str, version: str, body: str, key: str = "demo", **meta) -> Path:
    d = folder / dirname
    d.mkdir(parents=True)
    lines = [f'key = "{key}"', 'name = "Demo"', f'version = "{version}"', 'api_version = "1.1"']
    for k, v in meta.items():
        lines.append(f"{k} = {json.dumps(v)}")
    (d / "manifest.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (d / "plugin.py").write_text(body, encoding="utf-8")
    return d


@pytest.fixture()
def folders(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    bundled = tmp_path / "bundled"
    plugins = tmp_path / "plugins"
    bundled.mkdir()
    plugins.mkdir()
    # The real bundled plugins come along, so the app is whole.
    for name in ("incompressible_flow",):
        shutil.copytree(WEB / "bundled-plugins" / name, bundled / name, ignore=shutil.ignore_patterns("__pycache__"))
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(bundled))
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    return bundled, plugins, tmp_path / "ran.log"


def _ran(log: Path) -> list[str]:
    return log.read_text(encoding="utf-8").split() if log.is_file() else []


def _row(key: str = "demo") -> dict:
    return {r["key"]: r for r in plugin_catalog()}[key]


@pytest.mark.parametrize(
    ("a", "b", "want"),
    [
        ("0.2.0-dev", "0.2.0", -1),
        ("0.2.0", "0.1.9", 1),
        ("1.0", "1.0.0", 0),
        ("1.0.0-alpha", "1.0.0-alpha.1", -1),
        ("1.0.0-alpha.1", "1.0.0-beta", -1),
        ("1.0.0-beta.2", "1.0.0-beta.11", -1),
        ("1.0.0-rc.1", "1.0.0", -1),
        ("0.1.0+build.5", "0.1.0", 0),
        ("not a version", "0.0.1", -1),
    ],
)
def test_versions_compare_as_semver(a: str, b: str, want: int):
    assert compare_versions(a, b) == want
    assert compare_versions(b, a) == -want


def test_a_newer_update_is_used_and_only_its_register_runs(folders):
    bundled, plugins, log = folders
    _plugin(bundled, "demo", "0.1.0", _register_body("app", log), tier="bundled")
    _plugin(plugins, "demo", "0.2.0", _register_body("update", log))
    hub = load_all()
    assert _ran(log) == ["update"]
    assert get_registry("probe_kind").keys() == ["update"]
    m = hub.manifests["demo"]
    assert (m.version, m.tier, m.source) == ("0.2.0", "bundled", "bundled")
    assert hub.plugin_dir("demo") == plugins / "demo"
    row = _row()
    assert (row["copy"], row["root"], row["tier"], row["dir"]) == ("update", "user", "bundled", "demo")
    assert (row["version"], row["bundled_version"], row["unused_copies"]) == ("0.2.0", "0.1.0", [])


@pytest.mark.parametrize("user_version", ["0.1.0", "0.0.9", "0.1.0-dev", "garbage"])
def test_the_apps_copy_wins_a_tie_or_a_newer_version(folders, user_version: str):
    bundled, plugins, log = folders
    _plugin(bundled, "demo", "0.1.0", _register_body("app", log), tier="bundled")
    _plugin(plugins, "demo-old", user_version, _register_body("update", log))
    hub = load_all()
    assert _ran(log) == ["app"]
    assert hub.plugin_dir("demo") == bundled / "demo"
    row = _row()
    assert (row["copy"], row["root"], row["version"], row["bundled_version"]) == ("app", "bundled", "0.1.0", "0.1.0")
    [unused] = row["unused_copies"]
    assert unused["dir"] == "demo-old" and unused["version"] == user_version
    assert "ships with Magnusim (0.1.0) is the same or newer" in unused["reason"]


def test_a_release_beats_its_own_prerelease(folders):
    bundled, plugins, log = folders
    _plugin(bundled, "demo", "0.2.0-dev", _register_body("app", log), tier="bundled")
    _plugin(plugins, "demo", "0.2.0", _register_body("update", log))
    load_all()
    assert _ran(log) == ["update"] and _row()["copy"] == "update"


def test_of_two_updates_the_newest_is_used(folders):
    bundled, plugins, log = folders
    _plugin(bundled, "demo", "0.1.0", _register_body("app", log), tier="bundled")
    _plugin(plugins, "demo-a", "0.3.0", _register_body("a", log))
    _plugin(plugins, "demo-b", "0.2.0", _register_body("b", log))
    load_all()
    assert _ran(log) == ["a"]
    row = _row()
    assert row["dir"] == "demo-a" and row["copy"] == "update"
    assert [(u["dir"], u["version"]) for u in row["unused_copies"]] == [("demo-b", "0.2.0")]
    assert "holds a newer update (0.3.0)" in row["unused_copies"][0]["reason"]


def test_a_broken_update_falls_back_to_the_apps_copy(folders):
    bundled, plugins, log = folders
    _plugin(bundled, "demo", "0.1.0", _register_body("app", log), tier="bundled")
    _plugin(plugins, "demo", "0.2.0", _register_body("update", log, fail=True))
    hub = load_all()
    assert _ran(log) == ["update", "app"]
    # What the broken update registered is gone; the app's copy is what is loaded.
    assert get_registry("probe_kind").keys() == ["app"]
    assert hub.manifests["demo"].version == "0.1.0" and hub.plugin_dir("demo") == bundled / "demo"
    assert not [f for f in hub.failures if f.get("key") == "demo"]
    row = _row()
    assert (row["status"], row["copy"], row["root"]) == ("enabled", "app", "bundled")
    [unused] = row["unused_copies"]
    assert unused["version"] == "0.2.0" and "update is broken" in unused["reason"]
    assert "the version that ships with Magnusim is used" in unused["reason"]


def test_an_update_for_a_newer_app_falls_back(folders):
    bundled, plugins, log = folders
    _plugin(bundled, "demo", "0.1.0", _register_body("app", log), tier="bundled")
    d = _plugin(plugins, "demo", "0.2.0", _register_body("update", log))
    text = (d / "manifest.toml").read_text(encoding="utf-8").replace('api_version = "1.1"', 'api_version = "9.0"')
    (d / "manifest.toml").write_text(text, encoding="utf-8")
    hub = load_all()
    assert _ran(log) == ["app"] and hub.incompatible == []
    assert "incompatible" in _row()["unused_copies"][0]["reason"]


def test_an_update_keeps_the_apps_on_off_flags(folders, tmp_path: Path):
    """A plugin that ships off stays off with an update that says otherwise."""
    bundled, plugins, log = folders
    _plugin(bundled, "demo", "0.1.0", _register_body("app", log), tier="bundled", default_enabled=False)
    _plugin(plugins, "demo", "0.2.0", _register_body("update", log), default_enabled=True, required=True)
    hub = load_all()
    assert _ran(log) == []
    row = _row()
    assert (row["status"], row["copy"], row["required"], row["default_enabled"]) == ("disabled", "update", False, False)
    (tmp_path / "local.json").write_text(json.dumps({"plugins": {"enabled": ["demo"]}}), encoding="utf-8")
    hub = load_all(force=True)
    assert _ran(log) == ["update"] and hub.manifests["demo"].required is False


def test_an_incompressible_flow_update_stays_required_with_its_default_analysis(folders):
    bundled, plugins, _log = folders
    upd = plugins / "incompressible_flow"
    shutil.copytree(bundled / "incompressible_flow", upd)
    text = (upd / "manifest.toml").read_text(encoding="utf-8")
    assert 'version = "1.0.0"' in text and "required = true" in text
    text = text.replace('version = "1.0.0"', 'version = "1.0.1"').replace("required = true", "required = false")
    (upd / "manifest.toml").write_text(text, encoding="utf-8")
    hub = load_all()
    m = hub.manifests["incompressible_flow"]
    assert (m.version, m.tier, m.required) == ("1.0.1", "bundled", True)
    assert hub.plugin_dir("incompressible_flow") == upd
    assert hub.required_failures == []
    assert get_registry("analysis").owner("incompressible_steady") == "incompressible_flow"
    assert getattr(m, "default_analysis", None)
    row = _row("incompressible_flow")
    assert (row["copy"], row["required"], row["bundled_version"]) == ("update", True, "1.0.0")


def test_a_user_plugin_with_its_own_key_is_unaffected(folders):
    _bundled, plugins, log = folders
    _plugin(plugins, "mine", "0.1.0", _register_body("mine", log), key="mine")
    load_all()
    row = _row("mine")
    assert (row["copy"], row["root"], row["tier"], row["bundled_version"]) == ("user", "user", "user", "")


def test_an_update_unloaded_by_the_checks_after_loading_falls_back_to_the_app_copy(folders):
    """An Incompressible Flow update whose [default_analysis] names no analysis of its
    own loads, then fails the check after loading: the app loads its own copy instead."""
    bundled, plugins, _log = folders
    upd = plugins / "incompressible_flow"
    shutil.copytree(bundled / "incompressible_flow", upd)
    text = (upd / "manifest.toml").read_text(encoding="utf-8")
    assert 'steady = "incompressible_steady"' in text
    text = text.replace('version = "1.0.0"', 'version = "1.0.1"').replace(
        'steady = "incompressible_steady"', 'steady = "incompressible_nowhere"'
    )
    (upd / "manifest.toml").write_text(text, encoding="utf-8")
    hub = load_all()
    m = hub.manifests["incompressible_flow"]
    assert (m.version, m.required) == ("1.0.0", True)
    assert hub.plugin_dir("incompressible_flow") == bundled / "incompressible_flow"
    assert hub.required_failures == []
    assert get_registry("analysis").owner("incompressible_steady") == "incompressible_flow"
    row = _row("incompressible_flow")
    assert (row["copy"], row["status"]) == ("app", "enabled")
    [unused] = row["unused_copies"]
    assert unused["version"] == "1.0.1" and "incompressible_nowhere" in unused["reason"]
