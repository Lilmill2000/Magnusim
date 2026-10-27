"""A workspace's commands file (manifest ``[[workspaces]] commands``, unreleased 1.9).

The manifest key: discovery takes a .json file in the plugin's workspace/ folder and passes its
path on in the catalog row; the schema says 1.9 and warns nobody to raise api_version yet. The
file: tools/workspace_commands.py answers the shared cases word for word as
src/keybinds/commands.ts does, and plugin:check's workspace rule reports what is wrong with it.
"""

from __future__ import annotations

import json
from pathlib import Path

import plugin_check
import plugin_manifest_schema
import pytest
import workspace_commands

from cfddesk.registry.discovery import workspaces_from_meta
from tests.unit.test_plugin_check import found, make_plugin, run

WEB_ROOT = Path(__file__).resolve().parents[3]
CASES = json.loads((WEB_ROOT / "scripts" / "__tests__" / "fixtures" / "workspace-commands-cases.json").read_text(encoding="utf-8"))
SDK_INFO = json.loads((WEB_ROOT / "docs" / "plugins" / "plugin-sdk.json").read_text(encoding="utf-8"))

GOOD = CASES["cases"][0]["doc"]
WS = '\n[[workspaces]]\nkey = "pad"\ntitle = "Pad"\ncommands = "workspace/commands.json"\n'
PAGE = {
    "workspace/index.html": '<script type="module" src="./main.js"></script>',
    "workspace/main.js": "import { connect } from '@magnusim/workspace';\nawait connect();\n",
}


@pytest.mark.parametrize("case", CASES["cases"], ids=[c["name"] for c in CASES["cases"]])
def test_the_shared_cases_word_for_word(case):
    assert workspace_commands.commands_problems(case["doc"], SDK_INFO["app_keys"]) == case["problems"]


@pytest.mark.parametrize("case", CASES["plugins"], ids=[c["name"] for c in CASES["plugins"]])
def test_the_shared_plugin_cases_word_for_word(case):
    listed = []
    for w in case["workspaces"]:
        commands, problems = workspace_commands.read_commands(w["doc"], SDK_INFO["app_keys"])
        assert problems == []
        listed.append((w["key"], commands))
    assert workspace_commands.shared_command_ids(listed) == case["problems"]


def test_the_apps_own_keys_are_plugin_sdk_jsons_and_the_fallback_matches():
    keys = SDK_INFO["app_keys"]
    assert sorted(keys) == ["app", "local", "reserved"]
    assert keys == plugin_check.FALLBACK_APP_KEYS
    assert plugin_check.app_keys(WEB_ROOT) == keys
    assert plugin_check.app_keys(WEB_ROOT / "nowhere") == plugin_check.FALLBACK_APP_KEYS
    for group in keys.values():
        for c in group:
            assert c["context"] == "any" and all(workspace_commands.is_combo(k) for k in c["keys"])
    # Escape is local: shown, and a workspace's to use.
    assert [k for c in keys["local"] for k in c["keys"]] == ["Escape"]
    one = {"version": 1, "contexts": [], "commands": [{"id": "a", "label": "A", "context": "any", "keys": ["Escape"]}]}
    assert workspace_commands.commands_problems(one, keys) == []


def test_combos():
    for ok in ("KeyR", "Ctrl+KeyR", "Ctrl+Shift+KeyR", "Ctrl+Alt+Shift+Meta+F24", "Alt+Digit0", "Meta+Slash", "Escape"):
        assert workspace_commands.is_combo(ok), ok
    for bad in ("R", "Ctrl+R", "Shift+Ctrl+KeyR", "Ctrl+Ctrl+KeyR", "Ctrl", "Ctrl+", "+KeyR", "ControlLeft", "Cmd+KeyR", "F25", "", None, 5):
        assert not workspace_commands.is_combo(bad), bad


# -- the manifest key -----------------------------------------------------------------------


def _folder(tmp_path: Path) -> Path:
    (tmp_path / "workspace").mkdir()
    (tmp_path / "workspace" / "index.html").write_text("<!doctype html>", encoding="utf-8")
    (tmp_path / "workspace" / "commands.json").write_text(json.dumps(GOOD), encoding="utf-8")
    (tmp_path / "workspace" / "keys.txt").write_text("", encoding="utf-8")
    (tmp_path / "commands.json").write_text("{}", encoding="utf-8")
    return tmp_path


def test_discovery_takes_a_json_file_in_workspace_or_none_and_leaves_a_bad_one_out(tmp_path: Path):
    folder = _folder(tmp_path)
    row = {"key": "pad", "title": "Pad"}
    assert workspaces_from_meta({"workspaces": [row]}, folder)[0].commands == ""
    assert workspaces_from_meta({"workspaces": [{**row, "commands": ""}]}, folder)[0].commands == ""
    got = workspaces_from_meta({"workspaces": [{**row, "commands": "workspace\\commands.json"}]}, folder)[0]
    assert got.commands == "workspace/commands.json"
    for bad, why in (
        ("commands.json", "commands 'commands.json' must be a .json file in the plugin's workspace/ folder"),
        ("workspace/../commands.json", "commands 'workspace/../commands.json' must be a .json file in the plugin's workspace/ folder"),
        ("workspace/keys.txt", "commands 'workspace/keys.txt' must be a .json file in the plugin's workspace/ folder"),
        ("workspace/gone.json", "commands 'workspace/gone.json' is missing"),
        (["workspace/commands.json"], "commands must be a path (text)"),
    ):
        errors: dict[str, str] = {}
        got = workspaces_from_meta({"workspaces": [{**row, "commands": bad}]}, folder, errors)
        # The workspace stays, with no commands; the entry and the rest are kept.
        assert [(w.key, w.entry, w.commands) for w in got] == [("pad", "workspace/index.html", "")]
        assert errors == {"pad": why}
    # entry stays fatal: a workspace can't open without its page.
    with pytest.raises(ValueError, match="missing"):
        workspaces_from_meta({"workspaces": [{**row, "entry": "workspace/gone.html", "commands": "workspace/gone.json"}]}, folder)


def _catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, manifest_extra: str, files: dict[str, str]) -> dict:
    """The worker's plugins.list row of a plugin made with these manifest lines and files."""
    from cfddesk.registry import load_all, reset_for_tests
    from cfddesk.worker import methods
    from tests.unit.bundled_manifests import required_only_copy

    plugins = tmp_path / "plugins"
    make_plugin(plugins, "pad-plugin", manifest_extra=manifest_extra, files=files, tests=False)
    local = tmp_path / "local.json"
    local.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(required_only_copy(tmp_path / "bundled")))
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(tmp_path / "projects"))
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(local))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(local))
    reset_for_tests()
    try:
        load_all(force=True)
        return {r["key"]: r for r in methods.plugins_list()["plugins"]}["pad-plugin"]
    finally:
        reset_for_tests()


def test_the_catalog_row_names_the_commands_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    row = _catalog(tmp_path, monkeypatch, WS, {**PAGE, "workspace/commands.json": json.dumps(GOOD)})
    assert row["status"] == "enabled", row
    assert row["workspaces"] == [
        {"key": "pad", "title": "Pad", "icon": "", "entry": "workspace/index.html", "commands": "workspace/commands.json", "commands_error": ""}
    ]
    assert not any("commands" in n for n in row["notes"]), row["notes"]


def test_a_missing_commands_file_never_stops_the_plugin_loading(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture):
    with caplog.at_level("WARNING"):
        row = _catalog(tmp_path, monkeypatch, WS, PAGE)
    assert row["status"] == "enabled", row
    why = "commands 'workspace/commands.json' is missing"
    assert row["workspaces"][0]["commands"] == "" and row["workspaces"][0]["commands_error"] == why
    note = f"manifest [[workspaces]]: pad: {why}; its commands are left out of Settings → Keybinds"
    assert note in row["notes"]
    assert [r for r in caplog.records if note in r.getMessage()], "logged as a plugin warning"


def test_a_commands_file_outside_workspace_never_stops_the_plugin_loading(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    outside = WS.replace('commands = "workspace/commands.json"', 'commands = "workspace/../commands.json"')
    row = _catalog(tmp_path, monkeypatch, outside, {**PAGE, "commands.json": json.dumps(GOOD)})
    assert row["status"] == "enabled", row
    why = "commands 'workspace/../commands.json' must be a .json file in the plugin's workspace/ folder"
    assert row["workspaces"][0]["commands"] == "" and row["workspaces"][0]["commands_error"] == why
    assert f"manifest [[workspaces]]: pad: {why}; its commands are left out of Settings → Keybinds" in row["notes"]


def test_the_schema_says_1_9_and_nobody_is_told_to_raise_api_version_yet(tmp_path: Path):
    built = plugin_manifest_schema.build_schema()
    prop = built["$defs"]["WorkspaceSpec"]["properties"]["commands"]
    assert prop["x-since"] == "1.9" and prop["default"] == ""
    assert "Unreleased (1.9)" in prop["description"]
    errors, unknown = plugin_manifest_schema.validate({"key": "pad", "title": "Pad", "commands": "workspace/commands.json"}, {"$ref": "#/$defs/WorkspaceSpec"}, built)
    assert errors == [] and unknown == []
    errors, _ = plugin_manifest_schema.validate({"key": "pad", "title": "Pad", "commands": "commands.json"}, {"$ref": "#/$defs/WorkspaceSpec"}, built)
    assert errors
    # A 1.7 plugin (CAD) that names a commands file: the manifest check passes with no warning.
    report = run(make_plugin(tmp_path, manifest_extra=WS, files={**PAGE, "workspace/commands.json": json.dumps(GOOD)}, api="1.7"))
    assert found(report, "manifest", "warning") == [] and found(report, "api_version", "warning") == [], plugin_check.render(report)
    assert report.checks["workspace"] == "pass", plugin_check.render(report)


# -- plugin:check's workspace rule --------------------------------------------------------------


def test_plugin_check_reports_a_missing_unreadable_or_wrong_commands_file(tmp_path: Path):
    # The host loads the plugin without it (a warning); plugin:check says it is an error.
    missing = run(make_plugin(tmp_path / "a", manifest_extra=WS, files=PAGE))
    assert "workspace 'pad': commands 'workspace/commands.json' is missing" in found(missing, "workspace")
    assert missing.checks["workspace"] == "fail"
    outside = WS.replace('commands = "workspace/commands.json"', 'commands = "workspace/../commands.json"')
    escaped = run(make_plugin(tmp_path / "d", manifest_extra=outside, files={**PAGE, "commands.json": json.dumps(GOOD)}))
    assert "workspace 'pad': commands 'workspace/../commands.json' must be a .json file in the plugin's workspace/ folder" in found(escaped, "workspace")

    broken = run(make_plugin(tmp_path / "b", manifest_extra=WS, files={**PAGE, "workspace/commands.json": "{version: 1"}))
    assert any(m.startswith("workspace 'pad': commands workspace/commands.json is not JSON") for m in found(broken, "workspace"))

    bad = {**GOOD, "commands": [{"id": "help", "label": "Help", "context": "nowhere", "keys": ["Ctrl+Slash"]}]}
    wrong = run(make_plugin(tmp_path / "c", manifest_extra=WS, files={**PAGE, "workspace/commands.json": json.dumps(bad)}))
    assert found(wrong, "workspace") == [
        'workspace \'pad\': commands workspace/commands.json: commands[0].context "nowhere" is not a declared context or "any"',
        "workspace 'pad': commands workspace/commands.json: commands[0].keys: \"Ctrl+Slash\" is the app's own key (Open or close the Assistant panel)",
    ]
    assert wrong.checks["workspace"] == "fail"


def test_plugin_check_reads_the_file_as_a_browser_does(tmp_path: Path):
    # NaN and Infinity are Python's, not JSON's: the app could not read the file.
    text = json.dumps({**GOOD, "note": float("nan")})
    assert "NaN" in text
    nan = run(make_plugin(tmp_path / "a", manifest_extra=WS, files={**PAGE, "workspace/commands.json": text}))
    assert any(m.startswith("workspace 'pad': commands workspace/commands.json is not JSON: NaN is not JSON") for m in found(nan, "workspace")), found(nan, "workspace")
    # A UTF-8 byte-order mark is dropped, as Response.json() drops it.
    folder = make_plugin(tmp_path / "b", manifest_extra=WS, files=PAGE)
    (folder / "workspace" / "commands.json").write_bytes(b"\xef\xbb\xbf" + json.dumps(GOOD).encode("utf-8"))
    assert found(run(folder), "workspace") == []
    # A lone surrogate in the file is named as the app names it, and the report prints.
    sur = make_plugin(tmp_path / "c", manifest_extra=WS, files=PAGE)
    (sur / "workspace" / "commands.json").write_text(
        '{"version": 1, "contexts": [], "commands": [{"id": "a", "label": "A", "context": "any", "keys": ["\\ud800"]}]}', encoding="utf-8"
    )
    report = run(sur)
    assert any('"\\ud800" is not a key' in m for m in found(report, "workspace")), found(report, "workspace")
    plugin_check.render(report).encode("utf-8")


def test_plugin_check_refuses_one_command_id_in_two_workspaces(tmp_path: Path):
    two = WS + '\n[[workspaces]]\nkey = "sheet"\ntitle = "Sheet"\nentry = "workspace/index.html"\ncommands = "workspace/sheet.json"\n'
    sheet = {"version": 1, "contexts": [], "commands": [{"id": "edit.undo", "label": "Undo", "context": "any", "keys": []}]}
    report = run(make_plugin(tmp_path, manifest_extra=two, files={**PAGE, "workspace/commands.json": json.dumps(GOOD), "workspace/sheet.json": json.dumps(sheet)}))
    assert found(report, "workspace") == [
        "workspace \"sheet\": command \"edit.undo\" is also workspace \"pad\"'s: a plugin's command ids are one set, "
        "since the person's keys are kept per plugin"
    ]


def test_api_version_is_asked_for_only_once_this_host_is_1_9(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    meta = {"api_version": "1.8", "workspaces": [{"key": "pad", "title": "Pad", "commands": "workspace/commands.json"}]}
    assert "workspaces.commands" not in plugin_check._uses(meta)
    monkeypatch.setattr(plugin_check, "API_VERSION", "1.9")
    assert "workspaces.commands" in plugin_check._uses(meta)
    assert "workspaces.commands" not in plugin_check._uses({**meta, "workspaces": [{"key": "pad", "title": "Pad"}]})
    folder = make_plugin(tmp_path, manifest_extra=WS, files={**PAGE, "workspace/commands.json": json.dumps(GOOD)}, api="1.8")
    report = plugin_check.Report(str(folder))
    plugin_check.check_api_version(folder, plugin_check._parse_toml((folder / "manifest.toml").read_text(encoding="utf-8"))[0], report)
    assert [f.message for f in report.findings if f.check == "api_version"] == [
        "workspaces.commands needs host API 1.9, but api_version is 1.8: a 1.8 host ignores it; raise api_version"
    ]
