"""Sample projects (manifest ``[[samples]]``, host API 1.8).

- The table: a key, a title and a hint of one line, a path to a folder inside the
  plugin; a bad table fails the plugin's load, a folder without project.json is left
  out with a warning (shown on its Settings row).
- The catalog lists a plugin's samples while it is on (no paths), none while it is off.
- ``plugins.sample`` names the folder of a sample of a plugin that is on, and refuses
  any other.
- The manifest schema knows the key as 1.8.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import plugin_catalog, samples_from_meta
from cfddesk.worker.rpc import RpcError

WEB = Path(__file__).resolve().parents[3]


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    yield
    reset_for_tests()


def _sample_folder(root: Path, rel: str = "samples/box") -> Path:
    d = root / rel
    d.mkdir(parents=True)
    (d / "project.json").write_text(json.dumps({"id": "{{project_id}}", "title": "Box"}), encoding="utf-8")
    return d


def test_a_sample_table_is_read_with_its_text_and_folder(tmp_path: Path):
    _sample_folder(tmp_path)
    got, warnings = samples_from_meta(
        {"samples": [{"key": "box", "title": "A box", "hint": "One body, ready to mesh", "path": "samples/box"}]}, tmp_path
    )
    assert [(s.key, s.title, s.hint, s.path) for s in got] == [("box", "A box", "One body, ready to mesh", "samples/box")]
    assert warnings == []
    assert samples_from_meta({}, tmp_path) == ([], [])


@pytest.mark.parametrize(
    ("row", "why"),
    [
        ({"key": "Box", "title": "A box", "path": "samples/box"}, "lower-case"),
        ({"key": "box", "path": "samples/box"}, "needs a title"),
        ({"key": "box", "title": "x" * 41, "path": "samples/box"}, "at most 40"),
        ({"key": "box", "title": "A box", "hint": "two\nlines", "path": "samples/box"}, "one line"),
        ({"key": "box", "title": "A box"}, "needs a path"),
        ({"key": "box", "title": "A box", "path": "../elsewhere"}, "inside the plugin's folder"),
        ({"key": "box", "title": "A box", "path": "C:/elsewhere"}, "inside the plugin's folder"),
        ({"key": "box", "title": "A box", "path": "."}, "inside the plugin's folder"),
    ],
)
def test_a_bad_sample_table_fails_the_load_with_a_reason(tmp_path: Path, row: dict, why: str):
    _sample_folder(tmp_path)
    with pytest.raises(ValueError, match=why):
        samples_from_meta({"samples": [row]}, tmp_path)


def test_two_samples_with_one_key_fail_the_load(tmp_path: Path):
    _sample_folder(tmp_path)
    row = {"key": "box", "title": "A box", "path": "samples/box"}
    with pytest.raises(ValueError, match="two samples have this key"):
        samples_from_meta({"samples": [row, row]}, tmp_path)


def test_a_sample_folder_without_a_project_is_left_out_with_a_warning(tmp_path: Path):
    (tmp_path / "samples" / "empty").mkdir(parents=True)
    got, warnings = samples_from_meta({"samples": [{"key": "empty", "title": "Empty", "path": "samples/empty"}]}, tmp_path)
    assert got == []
    assert warnings == ["manifest [[samples]]: empty: 'samples/empty' has no project.json; left out"]


@pytest.fixture()
def demo(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """A user plugin with a sample and a sample whose folder is missing."""
    bundled = tmp_path / "bundled"
    plugins = tmp_path / "plugins"
    bundled.mkdir()
    plugins.mkdir()
    shutil.copytree(WEB / "bundled-plugins" / "incompressible_flow", bundled / "incompressible_flow",
                    ignore=shutil.ignore_patterns("__pycache__"))
    d = plugins / "demo"
    d.mkdir()
    (d / "manifest.toml").write_text(
        'key = "demo"\nname = "Demo"\nversion = "1.0.0"\napi_version = "1.8"\n\n'
        '[[samples]]\nkey = "box"\ntitle = "A box"\nhint = "One body"\npath = "samples/box"\n\n'
        '[[samples]]\nkey = "gone"\ntitle = "Gone"\npath = "samples/gone"\n',
        encoding="utf-8",
    )
    (d / "plugin.py").write_text("def register(hub):\n    return None\n", encoding="utf-8")
    _sample_folder(d)
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(bundled))
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    return d


def _row(key: str = "demo") -> dict:
    return {r["key"]: r for r in plugin_catalog()}[key]


def test_the_catalog_lists_the_samples_of_a_plugin_that_is_on(demo: Path):
    load_all(force=True)
    row = _row()
    assert row["status"] == "enabled"
    assert row["samples"] == [{"key": "box", "title": "A box", "hint": "One body"}]
    assert "manifest [[samples]]: gone: 'samples/gone' has no project.json; left out" in row["notes"]


def test_a_plugin_that_is_off_lists_no_samples(demo: Path, tmp_path: Path):
    (tmp_path / "local.json").write_text(json.dumps({"plugins": {"disabled": ["demo"]}}), encoding="utf-8")
    load_all(force=True)
    assert _row()["status"] == "disabled"
    assert _row().get("samples", []) == []


def test_plugins_sample_names_the_folder_of_a_sample_of_a_plugin_that_is_on(demo: Path, tmp_path: Path, monkeypatch):
    from cfddesk.worker import methods

    monkeypatch.setattr(methods, "web_root", lambda: WEB)
    load_all(force=True)
    got = methods.plugins_sample("demo", "box")
    assert got == {"ok": True, "plugin": "demo", "sample": "box", "title": "A box", "dir": str((demo / "samples" / "box").resolve())}
    with pytest.raises(RpcError, match="has no sample 'gone'"):
        methods.plugins_sample("demo", "gone")
    with pytest.raises(RpcError, match="has no sample 'nope'"):
        methods.plugins_sample("demo", "nope")
    with pytest.raises(RpcError, match="is not on"):
        methods.plugins_sample("missing", "box")
    (tmp_path / "local.json").write_text(json.dumps({"plugins": {"disabled": ["demo"]}}), encoding="utf-8")
    reset_for_tests()
    load_all(force=True)
    with pytest.raises(RpcError, match="is not on"):
        methods.plugins_sample("demo", "box")


def _link_folder(target: Path, link: Path) -> None:
    """A directory link: a junction on Windows (no privilege needed), else a symlink."""
    if sys.platform == "win32":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    else:
        link.symlink_to(target, target_is_directory=True)


def test_plugins_sample_checks_the_folder_again_when_asked(demo: Path, tmp_path: Path, monkeypatch):
    """The hub is cached from load time: turned off since, or the sample's folder swapped
    for a link or junction to a folder outside the plugin, it is refused at the call."""
    from cfddesk.worker import methods

    monkeypatch.setattr(methods, "web_root", lambda: WEB)
    load_all(force=True)
    assert methods.plugins_sample("demo", "box")["dir"] == str((demo / "samples" / "box").resolve())
    outside = _sample_folder(tmp_path, "outside/box")
    shutil.rmtree(demo / "samples" / "box")
    _link_folder(outside, demo / "samples" / "box")
    with pytest.raises(RpcError, match="has no sample 'box'"):
        methods.plugins_sample("demo", "box")
    link = demo / "samples" / "box"
    if sys.platform == "win32":
        link.rmdir()  # the junction itself, not the folder it leads to
    else:
        link.unlink()
    assert (outside / "project.json").is_file()
    _sample_folder(demo)
    assert methods.plugins_sample("demo", "box")["sample"] == "box"
    # Turned off since the hub was loaded (no reload): not on.
    (tmp_path / "local.json").write_text(json.dumps({"plugins": {"disabled": ["demo"]}}), encoding="utf-8")
    with pytest.raises(RpcError, match="is not on"):
        methods.plugins_sample("demo", "box")


def test_the_manifest_schema_knows_samples_as_1_8():
    import plugin_manifest_schema as schema

    assert schema.FEATURE_API["samples"] == "1.8"
    built = schema.build_schema()
    assert built["properties"]["samples"]["x-since"] == "1.8"
    sample = built["$defs"]["Sample"]
    assert sorted(sample["required"]) == ["key", "path", "title"]
    assert set(sample["properties"]) == {"key", "title", "hint", "path"}

