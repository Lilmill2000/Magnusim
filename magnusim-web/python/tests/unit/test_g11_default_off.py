"""G11: an optional bundled plugin that ships off (manifest ``default_enabled = false``).

gate:g11-not-imported: it is listed in Settings (so it can be turned on) but not
imported, served or given study kinds until someone on this PC turns it on.
gate:g11-enable-remembered: the worker remembers that in ``plugins.enabled``; an
explicit off wins; the shipped registry golden leaves it out while every bundled
plugin still loads with nothing failing.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

import cfddesk.registry.discovery as discovery
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import plugin_catalog, tier_flags

WEB = Path(__file__).resolve().parents[3]
FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "optional-plugins" / "opt-demo"
KEY = "opt-demo"


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    bundled = tmp_path / "bundled"
    shutil.copytree(
        WEB / "bundled-plugins" / "incompressible_flow",
        bundled / "incompressible_flow",
        ignore=shutil.ignore_patterns("tests", "__pycache__"),
    )
    shutil.copytree(FIXTURE, bundled / KEY)
    web = tmp_path / "web"
    web.mkdir()
    plugins = tmp_path / "plugins"
    plugins.mkdir()
    projects = tmp_path / "projects"
    (projects / "proj-a").mkdir(parents=True)
    (projects / "proj-a" / "project.json").write_text(json.dumps({"id": "proj-a", "title": "proj-a"}), encoding="utf-8")
    local = tmp_path / "local.json"
    local.write_text("{}", encoding="utf-8")
    # A private web root: the legacy <web root>/.cfddesk-local.json is read too.
    monkeypatch.setenv("MAGNUSIM_WEB_ROOT", str(web))
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(bundled))
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(projects))
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(local))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(local))
    discovery.__dict__.pop("_g11_imports", None)
    reset_for_tests()
    yield {"bundled": bundled, "web": web, "plugins": plugins, "projects": projects, "local": local}
    reset_for_tests()
    discovery.__dict__.pop("_g11_imports", None)


def _row(key: str = KEY) -> dict | None:
    return {r["key"]: r for r in plugin_catalog()}.get(key)


def _lists(local: Path) -> tuple[list[str], list[str]]:
    plugins = json.loads(local.read_text(encoding="utf-8")).get("plugins") or {}
    return list(plugins.get("disabled") or []), list(plugins.get("enabled") or [])


def _imported() -> bool:
    return KEY in discovery.__dict__.get("_g11_imports", [])


def _kinds() -> list[str]:
    from cfddesk.worker import methods

    return [k["key"] for k in methods.plugin_studies_list(project_id="proj-a")["kinds"]]


def test_gate_g11_not_imported(env):
    hub = load_all()
    assert KEY not in hub.manifests
    assert not _imported()
    assert f"cfddesk._bundled.{KEY}" not in sys.modules
    row = _row()
    assert row is not None
    assert {k: row[k] for k in ("status", "enabled", "tier", "source", "required", "default_enabled", "dir", "python_env")} == {
        "status": "disabled",
        "enabled": False,
        "tier": "bundled",
        "source": "bundled",
        "required": False,
        "default_enabled": False,
        "dir": KEY,
        "python_env": None,
    }
    assert row["name"] == "Optional demo"
    assert hub.failures == [] and hub.required_failures == []
    assert _kinds() == []
    # The required plugin next to it is unaffected.
    assert _row("incompressible_flow")["status"] == "enabled"


def test_gate_g11_enable_remembered_and_off_wins(env):
    from cfddesk.worker import methods

    load_all()
    methods.plugins_enable(key=KEY)
    assert _lists(env["local"]) == ([], [KEY])
    assert _row()["status"] == "enabled"
    assert _imported()
    assert _kinds() == ["opt_case"]
    # Still on after a restart of the registry.
    reset_for_tests()
    load_all()
    assert _row()["status"] == "enabled"
    # Turned off: it leaves the on list and joins the off list.
    methods.plugins_disable(key=KEY)
    assert _lists(env["local"]) == ([KEY], [])
    assert _row()["status"] == "disabled"
    assert _kinds() == []
    # A hand-edited file naming it in both lists: off wins.
    env["local"].write_text(json.dumps({"plugins": {"disabled": [KEY], "enabled": [KEY]}}), encoding="utf-8")
    reset_for_tests()
    load_all()
    assert _row()["status"] == "disabled"


def test_a_default_on_bundled_plugin_turned_on_is_remembered_too(env):
    """Turning on any optional bundled plugin is kept, so a later version that
    ships it off leaves it on for someone who turned it on."""
    from cfddesk.worker import methods

    manifest = env["bundled"] / KEY / "manifest.toml"
    manifest.write_text(manifest.read_text(encoding="utf-8").replace("default_enabled = false", "default_enabled = true"))
    load_all()
    methods.plugins_disable(key=KEY)
    methods.plugins_enable(key=KEY)
    assert _lists(env["local"]) == ([], [KEY])
    # The required plugin is never written to either list.
    with pytest.raises(Exception, match="cannot be turned off"):
        methods.plugins_disable(key="incompressible_flow")
    assert "incompressible_flow" not in _lists(env["local"])[1]


def test_legacy_file_and_the_flat_key(env, monkeypatch: pytest.MonkeyPatch):
    import cfddesk.wsl.config as wsl_config
    from cfddesk.worker import methods

    # As the app runs: no named local JSON, so the current file is read together with
    # the legacy one in the web root. Both are private here: the current file's path is
    # stubbed (unnamed, it would be this PC's real file) and the worker's web root is
    # MAGNUSIM_WEB_ROOT.
    monkeypatch.delenv("MAGNUSIM_LOCAL_JSON")
    monkeypatch.delenv("CFDDESK_LOCAL_JSON")
    current = env["web"] / ".magnusim-local.json"
    current.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(wsl_config, "local_json_path", lambda: current)
    monkeypatch.setattr(methods, "local_json_path", lambda: current)
    real = [wsl_config.web_root() / name for name in (".magnusim-local.json", ".cfddesk-local.json")]
    real_before = [p.read_bytes() if p.is_file() else None for p in real]
    legacy = env["web"] / ".cfddesk-local.json"
    legacy.write_text(json.dumps({"plugins": {"enabled": [KEY]}}), encoding="utf-8")
    reset_for_tests()
    load_all()
    assert _row()["status"] == "enabled"
    methods.plugins_disable(key=KEY)
    assert json.loads(legacy.read_text(encoding="utf-8"))["plugins"]["enabled"] == []
    assert _row()["status"] == "disabled"
    # A current file holding only the flat list: it is folded into the nested one.
    current.write_text(json.dumps({"plugins.disabled": ["example-laminar"]}), encoding="utf-8")
    reset_for_tests()
    methods.plugins_enable(key=KEY)
    data = json.loads(current.read_text(encoding="utf-8"))
    assert "plugins.disabled" not in data
    assert data["plugins"]["disabled"] == ["example-laminar"]
    assert data["plugins"]["enabled"] == [KEY]
    # This PC's own settings files were never touched.
    assert [p.read_bytes() if p.is_file() else None for p in real] == real_before


def test_a_named_local_json_is_the_only_settings_file(env):
    """MAGNUSIM_LOCAL_JSON (tests, second servers) is read alone: a plugin turned on in
    this PC's legacy web-root file does not leak in, and turning it off leaves that file
    as it was."""
    from cfddesk.worker import methods

    legacy = env["web"] / ".cfddesk-local.json"
    before = json.dumps({"plugins": {"enabled": [KEY]}})
    legacy.write_text(before, encoding="utf-8")
    reset_for_tests()
    load_all()
    assert discovery.plugin_state(env["web"]) == discovery.PluginState()
    assert _row()["status"] == "disabled"
    methods.plugins_enable(key=KEY)
    methods.plugins_disable(key=KEY)
    assert legacy.read_text(encoding="utf-8") == before
    assert json.loads(env["local"].read_text(encoding="utf-8"))["plugins"]["disabled"] == [KEY]


def test_manifest_flags_are_strict():
    with pytest.raises(ValueError, match="cannot be off by default"):
        tier_flags({"required": True, "default_enabled": False}, "bundled")
    with pytest.raises(ValueError, match="default_enabled must be true or false"):
        tier_flags({"default_enabled": "sometimes"}, "bundled")
    # The line-fallback parser gives strings.
    assert tier_flags({"default_enabled": "false"}, "bundled") == (False, False)
    assert tier_flags({"required": "false"}, "bundled") == (False, True)
    assert tier_flags({"required": "TRUE"}, "bundled") == (True, True)
    # Bundled-tier keys only.
    assert tier_flags({"required": True, "default_enabled": False}, "user") == (False, True)


def test_a_required_plugin_cannot_ship_off(env):
    manifest = env["bundled"] / "incompressible_flow" / "manifest.toml"
    manifest.write_text(manifest.read_text(encoding="utf-8") + "\ndefault_enabled = false\n", encoding="utf-8")
    hub = load_all()
    assert "cannot be off by default" in hub.required_failures[0]["error"]


def test_a_user_plugin_ignores_the_flag(env):
    shutil.copytree(FIXTURE, env["plugins"] / "user-opt")
    manifest = env["plugins"] / "user-opt" / "manifest.toml"
    manifest.write_text(
        manifest.read_text(encoding="utf-8").replace('key = "opt-demo"', 'key = "user-opt"').replace('tier = "bundled"\n', ""),
        encoding="utf-8",
    )
    hub = load_all()
    assert "user-opt" in hub.manifests
    assert _row("user-opt")["default_enabled"] is True
    assert _row("user-opt")["status"] == "enabled"


def test_a_plugin_that_needs_an_off_one_says_so(env):
    d = env["bundled"] / "needs-opt"
    d.mkdir()
    (d / "manifest.toml").write_text(
        'key = "needs-opt"\nname = "Needs opt"\napi_version = "1.1"\nrequires_plugins = ["opt-demo"]\n', encoding="utf-8"
    )
    (d / "plugin.py").write_text("def register(hub):\n    return None\n", encoding="utf-8")
    hub = load_all()
    [fail] = [f for f in hub.failures if f["key"] == "needs-opt"]
    assert fail["error"] == "needs the Optional demo plugin, which is off"
    assert not _imported()


def test_studies_of_an_off_plugin_are_kept_greyed_with_its_name(env):
    from cfddesk.registry.plugin_data import PluginData
    from cfddesk.worker import methods

    rec = PluginData(env["projects"] / "proj-a", KEY).create_study("opt_case", "Kept", plugin_name="Optional demo")
    load_all()
    [row] = methods.plugin_studies_list(project_id="proj-a")["studies"]
    assert row["id"] == rec["id"]
    assert row["available"] is False
    assert row["reason"] == "Requires the Optional demo plugin"


def test_setup_builds_environments_only_for_plugins_that_are_on(env, monkeypatch: pytest.MonkeyPatch, capsys):
    sys.path.insert(0, str(WEB / "python" / "tools"))
    try:
        import plugin_env as cli
    finally:
        sys.path.pop(0)
    d = env["bundled"] / KEY
    (d / "requirements.lock").write_text("", encoding="utf-8")
    with (d / "manifest.toml").open("a", encoding="utf-8") as fh:
        fh.write('\n[python]\nrequirements = "requirements.lock"\n')
    built: list[str] = []
    monkeypatch.setattr(cli, "_create", lambda web_root, key: built.append(key) or 0)
    assert cli.main(["create-bundled", "--web-root", str(env["web"])]) == 0
    assert built == []
    assert f"skipped {KEY}: off" in capsys.readouterr().out
    assert cli.main(["create-bundled", "--include-off", "--web-root", str(env["web"])]) == 0
    assert built == [KEY]
    env["local"].write_text(json.dumps({"plugins": {"enabled": [KEY]}}), encoding="utf-8")
    built.clear()
    assert cli.main(["create-bundled", "--web-root", str(env["web"])]) == 0
    assert built == [KEY]


def test_the_shipped_golden_leaves_out_a_plugin_that_ships_off(env):
    sys.path.insert(0, str(WEB / "python" / "tools"))
    try:
        from registry_dump import dump_registry, shipped_hub
    finally:
        sys.path.pop(0)
    shipped = dump_registry(builtins_only=True, bundled_dir=env["bundled"])
    assert [p["key"] for p in shipped["plugins"]] == ["incompressible_flow"]
    every = shipped_hub(bundled_dir=env["bundled"], include_optional=True)
    assert sorted(every.manifests) == ["incompressible_flow", KEY]
    assert every.failures == []


def test_an_off_plugin_has_no_start_actions_until_it_is_turned_on(env):
    """A plugin that ships off draws no start action anywhere (its catalog row and the
    tree's kind rows say none) until someone turns it on."""
    from cfddesk.worker import methods

    manifest = env["bundled"] / KEY / "manifest.toml"
    text = manifest.read_text(encoding="utf-8").replace('api_version = "1.1"', 'api_version = "1.4"')
    manifest.write_text(text + '\n[[start_actions]]\nstudy_kind = "opt_case"\nlabel = "Start an optional case"\n', encoding="utf-8")
    load_all()
    row = _row()
    assert (row["status"], row["start_actions"]) == ("disabled", [])
    assert methods.plugin_studies_list(project_id="proj-a")["kinds"] == []
    # Turned on: the same manifest's action is there (so the empty lists above were the off state).
    methods.plugins_enable(key=KEY)
    assert [a["label"] for a in _row()["start_actions"]] == ["Start an optional case"]
    [kind] = methods.plugin_studies_list(project_id="proj-a")["kinds"]
    assert kind["start_action"]["label"] == "Start an optional case"


def test_every_real_bundled_plugin_that_ships_off_has_no_start_actions(env, monkeypatch: pytest.MonkeyPatch):
    """On a fresh install every real bundled plugin whose manifest sets
    default_enabled = false is off, with no start action, whatever it declares."""
    from tests.unit.bundled_manifests import BUNDLED, default_off_keys, default_on_keys

    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(BUNDLED))
    reset_for_tests()
    load_all()
    rows = {r["key"]: r for r in plugin_catalog()}
    for key in default_off_keys():
        assert (key, rows[key]["status"], rows[key]["start_actions"]) == (key, "disabled", [])
    for key in default_on_keys():
        assert rows[key]["status"] != "disabled", key


def test_the_shipped_hub_is_the_default_on_bundled_folders():
    """What a fresh install loads is every real bundled plugin whose manifest does not
    set default_enabled = false, and nothing else."""
    from tests.unit.bundled_manifests import default_on_keys

    sys.path.insert(0, str(WEB / "python" / "tools"))
    try:
        from registry_dump import shipped_hub
    finally:
        sys.path.pop(0)
    assert sorted(shipped_hub().manifests) == default_on_keys()


def test_gate_g11_every_real_bundled_plugin_loads():
    """The shipped golden holds only what a fresh install turns on; this loads every
    real bundled plugin, the optional ones too, with nothing failing."""
    sys.path.insert(0, str(WEB / "python" / "tools"))
    try:
        from registry_dump import shipped_hub
    finally:
        sys.path.pop(0)
    from tests.unit.bundled_manifests import bundled_manifests

    hub = shipped_hub(include_optional=True)
    assert hub.failures == []
    assert "incompressible_flow" in hub.manifests
    # Every bundled folder, the ones that ship off included.
    assert sorted(hub.manifests) == sorted(bundled_manifests())
