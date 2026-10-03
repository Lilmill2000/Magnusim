"""A reload imports each plugin's own package from the folder it loads the plugin
from: discovery takes back the sys.path entries it added for an earlier load, so
a folder that is no longer loaded cannot shadow the plugin's package (a copy of
Incompressible Flow loaded from a temporary folder once made a later load in the
same process read its LOG_PARSER path from that copy)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests

PACKAGE = "magnusim_leak_probe_pkg"


def _plugin(bundled: Path, origin: str) -> Path:
    folder = bundled / "leak_probe"
    (folder / PACKAGE).mkdir(parents=True)
    (folder / "manifest.toml").write_text(
        'key = "leak_probe"\nname = "Leak probe"\napi_version = "1.1"\n', encoding="utf-8"
    )
    (folder / "plugin.py").write_text(
        f"import {PACKAGE}\n\n\ndef register(hub):\n    return None\n", encoding="utf-8"
    )
    (folder / PACKAGE / "__init__.py").write_text(f'ORIGIN = "{origin}"\n', encoding="utf-8")
    return folder.resolve()


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    monkeypatch.setattr(sys, "path", list(sys.path))
    reset_for_tests()
    yield
    reset_for_tests()
    sys.modules.pop(PACKAGE, None)


def test_a_reload_imports_the_plugin_package_from_the_folder_it_loads(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    first = _plugin(tmp_path / "first", "first")
    second = _plugin(tmp_path / "second", "second")
    # The second folder is already on the path (as a configured path would be), behind the rest.
    sys.path.append(str(second))

    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(first.parent))
    hub = load_all()
    assert "leak_probe" in hub.manifests
    assert sys.modules[PACKAGE].ORIGIN == "first"

    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(second.parent))
    reset_for_tests()
    hub = load_all()
    assert "leak_probe" in hub.manifests
    assert sys.modules[PACKAGE].ORIGIN == "second"
    assert str(first) not in sys.path
    # A folder discovery did not add stays where it was.
    assert str(second) in sys.path


def test_a_reload_takes_back_only_the_entries_it_added(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    folder = _plugin(tmp_path / "bundled", "only")
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(folder.parent))
    load_all()
    assert sys.path.count(str(folder)) == 1
    reset_for_tests()
    assert str(folder) not in sys.path
    load_all()
    assert sys.path.count(str(folder)) == 1
