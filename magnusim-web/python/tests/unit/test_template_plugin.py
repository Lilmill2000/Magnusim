"""The plugin template declares the host's current API, so an API bump must update it."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from registry_dump import dump_registry

from cfddesk.registry import API_VERSION, get_hub, reset_for_tests
from cfddesk.registry.discovery import _parse_simple_toml

TEMPLATE = Path(__file__).resolve().parents[3] / "templates" / "plugin"
PYPROJECT = Path(__file__).resolve().parents[2] / "pyproject.toml"


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def test_template_manifest_declares_the_host_api():
    meta = _parse_simple_toml((TEMPLATE / "manifest.toml").read_text(encoding="utf-8"))
    assert meta is not None
    assert meta["api_version"] == API_VERSION


def test_core_run_collects_the_template_test():
    # A plain pytest run (and CI) must run the template's own test, not only a gate
    # that runs it by path.
    meta = _parse_simple_toml(PYPROJECT.read_text(encoding="utf-8"), source="pyproject.toml")
    assert meta is not None
    testpaths = meta["tool"]["pytest"]["ini_options"]["testpaths"]
    assert "../templates/plugin/tests" in testpaths
    assert (PYPROJECT.parent / "../templates/plugin/tests").resolve() == TEMPLATE / "tests"
    assert (TEMPLATE / "tests" / "test_register.py").is_file()


def test_plugin_made_from_the_template_is_listed_with_the_host_api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    plugins = tmp_path / "plugins"
    shutil.copytree(TEMPLATE, plugins / "template-demo", ignore=shutil.ignore_patterns("tests", "__pycache__", "*.pyc"))
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    # register() returns its own manifest, and its api_version wins over manifest.toml's.
    rows = {row["key"]: row for row in dump_registry(force=True)["plugins"]}
    assert rows["template-demo"]["api_version"] == API_VERSION
    assert get_hub().manifests["template-demo"].api_version == API_VERSION
