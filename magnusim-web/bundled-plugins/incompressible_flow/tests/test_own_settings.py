"""These tests never read this PC's settings: a local JSON that turns this plugin off,
named by both variables before any test starts (as a PC or a shell could), is not
what a test sees. The conftest gives each test an empty file of its own."""

from __future__ import annotations

import json

import pytest
from cfddesk.registry import get_registry, load_all, reset_for_tests
from cfddesk.registry.discovery import plugin_state
from cfddesk.wsl.config import local_json_path, web_root

KEY = "incompressible_flow"


@pytest.fixture(scope="module", autouse=True)
def _pc_settings(tmp_path_factory):
    """Module-wide, so it is in place before the conftest's per-test file."""
    path = tmp_path_factory.mktemp("pc") / ".magnusim-local.json"
    path.write_text(json.dumps({"plugins": {"disabled": [KEY]}}), encoding="utf-8")
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("CFDDESK_LOCAL_JSON", str(path))
        mp.setenv("MAGNUSIM_LOCAL_JSON", str(path))
        yield path


def test_plugin_tests_do_not_read_the_pcs_settings(_pc_settings, monkeypatch):
    assert local_json_path() != _pc_settings
    # The plugin is required, so it would load even when listed off; the on/off
    # lists the core reads are what show the PC's file is not seen.
    assert plugin_state(web_root()).disabled == frozenset()
    reset_for_tests()
    try:
        load_all()
        keys = {r["key"] for r in get_registry("analysis").describe()}
        assert {"incompressible_steady", "incompressible_transient"} <= keys
    finally:
        reset_for_tests()

    # The same file, once read, does turn the plugin off: the check above is not empty.
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(_pc_settings))
    assert plugin_state(web_root()).disabled == frozenset({KEY})
