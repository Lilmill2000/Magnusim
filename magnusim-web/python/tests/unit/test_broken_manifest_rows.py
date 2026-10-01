"""A plugin whose manifest does not parse or validate, as Settings > Plugins and STUDIES show it.

The row is the tier its folder was found in ("bundled" or "local"), says what is
wrong with the TOML parser's line and column (the file name, never a full path),
and carries the manifest's name when a line still gives it. A study of that
plugin keeps the name in its record, as it does while the plugin is off.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

import cfddesk.registry.discovery as discovery
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import plugin_catalog

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
    monkeypatch.setenv("MAGNUSIM_WEB_ROOT", str(web))
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(bundled))
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(projects))
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(local))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(local))
    reset_for_tests()
    yield {"tmp": tmp_path, "bundled": bundled, "plugins": plugins, "projects": projects, "local": local}
    reset_for_tests()


def _row(key: str = KEY) -> dict:
    row = {r["key"]: r for r in plugin_catalog()}.get(key)
    assert row is not None
    return row


def _edit(manifest: Path, old: str, new: str) -> None:
    text = manifest.read_text(encoding="utf-8")
    assert old in text
    manifest.write_text(text.replace(old, new), encoding="utf-8")


def _no_path(error: str, env: dict) -> None:
    assert str(env["tmp"]) not in error
    assert "\\" not in error and "/" not in error


def test_a_bundled_manifest_that_does_not_parse_is_listed_bundled_by_name_with_line_and_column(env):
    # Line 3 of the fixture: version = 1.0.0 (a bare dotted value is not TOML).
    _edit(env["bundled"] / KEY / "manifest.toml", 'version = "1.0.0"', "version = 1.0.0")
    load_all()
    row = _row()
    assert {k: row[k] for k in ("status", "enabled", "source", "tier", "name")} == {
        "status": "error",
        "enabled": False,
        "source": "bundled",
        "tier": "bundled",
        "name": "Optional demo",
    }
    assert row["error"].startswith("manifest.toml is not valid TOML (line 3, column 14): ")
    assert "Expected newline or end of document" in row["error"]
    _no_path(row["error"], env)
    # The required plugin next to it is unaffected.
    assert _row("incompressible_flow")["status"] == "enabled"


def test_a_name_that_cannot_be_read_falls_back_to_the_folder(env):
    _edit(env["bundled"] / KEY / "manifest.toml", 'name = "Optional demo"', "name = Optional demo")
    load_all()
    row = _row()
    assert row["name"] == KEY
    assert row["source"] == "bundled"
    assert row["error"].startswith("manifest.toml is not valid TOML (line 2, column ")


def test_the_lenient_name_is_only_a_top_level_quoted_line():
    assert discovery._lenient_name('key = "x"\nname = "Magnusim CAD"  # shown\nversion = 0.1.0\n') == "Magnusim CAD"
    assert discovery._lenient_name("name = 'Single'\n") == "Single"
    # In a table, unquoted, or escaped: not read.
    assert discovery._lenient_name('key = "x"\n[[workspaces]]\nname = "Part"\n') == ""
    assert discovery._lenient_name("name = Bare\n") == ""
    assert discovery._lenient_name('name = "Say \\"hi\\""\n') == ""
    # At most 80 characters.
    assert discovery._lenient_name('name = "' + "N" * 100 + '"\n') == "N" * 80


@pytest.mark.parametrize("quotes", ['"""', "'''"])
def test_the_lenient_name_skips_lines_inside_a_multi_line_string(quotes: str):
    q = quotes
    # A name = line in a multi-line string is text, not the plugin's name.
    assert discovery._lenient_name(f'description = {q}\nname = "Fake"\n{q}\nname = "Real"\n') == "Real"
    assert discovery._lenient_name(f"description = {q}Starts here\nname = 'Fake'\nends here{q}\nname = 'Real'\n") == "Real"
    # A [line] inside one is not a table either.
    assert discovery._lenient_name(f'notes = {q}\n[not a table]\n{q}\nname = "Real"\n') == "Real"
    # One that opens and closes on its line hides nothing.
    assert discovery._lenient_name(f'description = {q}One line{q}\nname = "Real"\n') == "Real"
    # One that never closes hides the rest: no name rather than a wrong one.
    assert discovery._lenient_name(f'description = {q}\nname = "Fake"\n') == ""


def test_a_long_parser_message_is_cut_and_keeps_its_line_and_column():
    # tomli quotes the whole key of a table declared twice.
    header = "[" + "k" * 50_000 + "]\n"
    meta, why = discovery._parse_toml('name = "A"\n' + header + header, source="manifest.toml")
    assert meta is None
    prefix = "is not valid TOML (line 3, column 50002): "
    assert why.startswith(prefix)
    said = why[len(prefix) :]
    assert said.startswith("Cannot declare (")
    assert len(said) == 200 and said.endswith("…")

    class OldError(ValueError):
        pass

    # The text-only shape of older tomllib, and one without a place.
    long = "x" * 1000
    assert discovery._toml_error(OldError(f"{long} (at line 4, column 9)")) == (
        f"is not valid TOML (line 4, column 9): {long[:199]}…"
    )
    assert discovery._toml_error(OldError(long)) == f"is not valid TOML: {long[:199]}…"
    # A short one is kept as it is.
    assert discovery._toml_error(OldError("Invalid value (at line 4, column 9)")).endswith(": Invalid value")


def test_a_user_manifest_that_does_not_parse_is_listed_local(env):
    shutil.copytree(FIXTURE, env["plugins"] / "user-opt")
    manifest = env["plugins"] / "user-opt" / "manifest.toml"
    _edit(manifest, 'key = "opt-demo"', 'key = "user-opt"')
    _edit(manifest, "[[workspaces]]", "[[workspaces]")
    load_all()
    row = _row("user-opt")
    assert (row["status"], row["source"], row["tier"], row["name"]) == ("error", "local", "user", "Optional demo")
    assert "manifest.toml is not valid TOML (line " in row["error"]
    _no_path(row["error"], env)


@pytest.mark.parametrize(
    ("old", "new", "error"),
    [
        (
            'key = "opt_case"',
            'key = "Opt-Case"',
            "manifest [[study_kinds]]: key 'Opt-Case' must be lower_snake_case",
        ),
        (
            'workspace = "bench"',
            'workspace = "elsewhere"',
            "manifest [[workspaces]]: study kind opt_case: workspace 'elsewhere' is not declared",
        ),
        ("", "\n[files]\nmax_file_mb = 0\n", "manifest [files]: max_file_mb must be between 1 and 4096, not 0"),
        ("", '\n[python]\nrequirements = "missing.lock"\n', "manifest [python]: requirements file 'missing.lock' is missing"),
    ],
    ids=["study_kinds", "workspaces", "files", "python"],
)
def test_a_bundled_manifest_that_does_not_validate_is_listed_bundled(env, old: str, new: str, error: str):
    manifest = env["bundled"] / KEY / "manifest.toml"
    if old:
        _edit(manifest, old, new)
    else:
        with manifest.open("a", encoding="utf-8") as fh:
            fh.write(new)
    # It ships off, and the manifest is checked only for a plugin that is on.
    env["local"].write_text(json.dumps({"plugins": {"enabled": [KEY]}}), encoding="utf-8")
    load_all()
    row = _row()
    assert (row["status"], row["source"], row["tier"], row["name"]) == ("error", "bundled", "bundled", "Optional demo")
    assert row["error"] == error


def test_a_bundled_plugin_unloaded_for_an_unknown_solver_is_listed_bundled(env):
    # It loads, then fails the registry's cross-reference check and is unloaded (h6).
    folder = env["bundled"] / "bad-solver"
    folder.mkdir()
    (folder / "manifest.toml").write_text(
        'key = "badsolver"\nname = "Bad Solver Refs"\nversion = "0.1.0"\nrequired = false\n', encoding="utf-8"
    )
    (folder / "plugin.py").write_text(
        """
from dataclasses import dataclass
from cfddesk.registry.manifest import PluginManifest

@dataclass(frozen=True)
class Spec:
    key: str
    label: str
    solver_backends: tuple = ()
    default_solver: str = ""

def register(hub):
    hub.registry("analysis").register(
        Spec(key="plugin_bad_analysis", label="Bad", solver_backends=("totallyFakeSolver",), default_solver="totallyFakeSolver"),
        plugin="badsolver",
    )
    return PluginManifest(key="badsolver", name="Bad Solver Refs", version="0.1.0")
""",
        encoding="utf-8",
    )
    hub = load_all()
    assert "badsolver" not in hub.manifests
    row = _row("badsolver")
    assert (row["status"], row["source"], row["tier"], row["name"]) == ("error", "bundled", "bundled", "Bad Solver Refs")
    assert "unknown solver" in row["error"]


def test_a_bundled_plugin_for_another_host_api_is_listed_bundled(env):
    _edit(env["bundled"] / KEY / "manifest.toml", 'api_version = "1.1"', 'api_version = "9.0"')
    env["local"].write_text(json.dumps({"plugins": {"enabled": [KEY]}}), encoding="utf-8")
    load_all()
    row = _row()
    assert (row["status"], row["source"], row["tier"]) == ("incompatible", "bundled", "bundled")


def test_a_manifest_that_cannot_be_read_says_why_without_its_path(env, monkeypatch: pytest.MonkeyPatch):
    target = env["bundled"] / KEY / "manifest.toml"
    real = Path.read_text

    def read_text(self: Path, *args, **kwargs):
        if self == target:
            raise PermissionError(13, "Permission denied", str(self))
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    load_all()
    row = _row()
    assert (row["status"], row["source"], row["name"]) == ("error", "bundled", KEY)
    assert row["error"] == "manifest.toml could not be read: Permission denied"


def test_a_required_plugin_with_a_broken_manifest_reports_the_parser_message(env):
    manifest = env["bundled"] / "incompressible_flow" / "manifest.toml"
    manifest.write_text(manifest.read_text(encoding="utf-8") + "\n[broken\n", encoding="utf-8")
    hub = load_all()
    [fail] = hub.required_failures
    assert fail["error"].startswith("manifest.toml is not valid TOML (line ")
    row = _row("incompressible_flow")
    assert (row["status"], row["source"], row["name"]) == ("error", "bundled", "Incompressible Flow")


def test_the_parser_message_has_the_same_shape_without_line_attributes():
    class OldError(ValueError):
        pass

    assert discovery._toml_error(OldError("Invalid value (at line 4, column 9)")) == (
        "is not valid TOML (line 4, column 9): Invalid value"
    )
    assert discovery._toml_error(OldError("Unclosed array (at end of document)")) == (
        "is not valid TOML: Unclosed array (at end of document)"
    )


def test_without_a_toml_parser_a_manifest_with_tables_says_so(monkeypatch: pytest.MonkeyPatch):
    real_import = __import__

    def fake_import(name, *args, **kwargs):
        if name in ("tomllib", "tomli"):
            raise ImportError(f"blocked {name}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)
    meta, why = discovery._parse_toml('key = "p"\n[files]\nmax_file_mb = 1\n', source="manifest.toml")
    assert meta is None
    assert why.startswith("has [tables] or a requires array")


@pytest.mark.parametrize("readable", [True, False])
def test_a_study_of_a_plugin_with_a_broken_manifest_keeps_its_plugin_name(env, readable: bool):
    from cfddesk.registry.plugin_data import PluginData
    from cfddesk.worker import methods

    manifest = env["bundled"] / KEY / "manifest.toml"
    if readable:
        _edit(manifest, 'version = "1.0.0"', "version = 1.0.0")
    else:
        _edit(manifest, 'name = "Optional demo"', "name = Optional demo")
    # The name its plugin had when the study was saved, not the one in the manifest now:
    # the reason gives the study's, also when a line of the manifest still gives one.
    rec = PluginData(env["projects"] / "proj-a", KEY).create_study("opt_case", "Kept", plugin_name="Older demo")
    load_all()
    assert _row()["status"] == "error"
    assert _row()["name"] == ("Optional demo" if readable else KEY)
    [row] = methods.plugin_studies_list(project_id="proj-a")["studies"]
    assert row["id"] == rec["id"]
    assert row["available"] is False
    assert row["plugin_name"] == "Older demo"
    assert row["reason"] == "Requires the Older demo plugin"


def test_a_study_record_without_a_name_uses_the_row_name(env):
    from cfddesk.registry.plugin_data import PluginData
    from cfddesk.worker import methods

    _edit(env["bundled"] / KEY / "manifest.toml", 'version = "1.0.0"', "version = 1.0.0")
    PluginData(env["projects"] / "proj-a", KEY).create_study("opt_case", "Kept")
    load_all()
    [row] = methods.plugin_studies_list(project_id="proj-a")["studies"]
    assert row["reason"] == "Requires the Optional demo plugin"
