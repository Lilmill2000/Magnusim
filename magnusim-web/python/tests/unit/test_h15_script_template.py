"""H15: SolverApp.script_template is only a solve job; anything else is ignored with
a note in Settings > Plugins, and the plugin still loads."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import get_hub, plugin_catalog
from cfddesk.registry.solver import script_template_notes

PLUGIN = '''
from cfddesk.registry.solver import SolverApp

def register(hub):
    hub.registry("solver").register(
        SolverApp(key="tmpl_custom", label="Custom foam", application="customFoam", time_dependency="steady",
                  parallel="none", stop_strategy="sigterm", script_template="my_script"),
        plugin="tmpl-demo",
    )
    hub.registry("solver").register(
        SolverApp(key="tmpl_default", label="Default foam", application="defaultFoam", time_dependency="steady",
                  parallel="none", stop_strategy="sigterm"),
        plugin="tmpl-demo",
    )
    hub.registry("solver").register(
        SolverApp(key="tmpl_mesh_job", label="Mesh job foam", application="meshJobFoam", time_dependency="steady",
                  parallel="none", stop_strategy="sigterm", script_template="mesh"),
        plugin="tmpl-demo",
    )
    return None
'''


@pytest.fixture
def plugins(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    folder = tmp_path / "plugins" / "tmpl-demo"
    folder.mkdir(parents=True)
    (folder / "manifest.toml").write_text(
        'key = "tmpl-demo"\nname = "Template demo"\nversion = "1.0.0"\napi_version = "1.3"\n', encoding="utf-8"
    )
    (folder / "plugin.py").write_text(PLUGIN, encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(tmp_path / "plugins"))
    reset_for_tests()
    yield
    reset_for_tests()


def test_a_value_that_is_not_a_solve_job_is_a_note(plugins, caplog: pytest.LogCaptureFixture):
    with caplog.at_level(logging.WARNING, logger="cfddesk.registry.solver"):
        hub = load_all(force=True)
        notes = script_template_notes(hub, "tmpl-demo")
        script_template_notes(hub, "tmpl-demo")
    assert "tmpl-demo" in hub.manifests
    assert sorted(notes) == [
        'Solver Custom foam: script_template "my_script" is not a solve job, so it is ignored. Solves use solve.sh.',
        'Solver Mesh job foam: script_template "mesh" is not a solve job, so it is ignored. Solves use solve.sh.',
    ]
    # Logged once per plugin, solver and value.
    said = [r.getMessage() for r in caplog.records if "script_template" in r.getMessage()]
    assert len(said) == 2
    row = next(r for r in plugin_catalog() if r["key"] == "tmpl-demo")
    assert row["status"] == "enabled"
    assert sorted(row["notes"]) == sorted(notes)


def test_the_builtin_solve_job_and_other_plugins_have_no_note(plugins):
    hub = load_all(force=True)
    assert script_template_notes(hub, "incompressible_flow") == []
    assert script_template_notes(hub, "no-such-plugin") == []
    row = next(r for r in plugin_catalog() if r["key"] == "incompressible_flow")
    assert not any("script_template" in n for n in row["notes"])
    assert get_hub().registry("job").get("solve").tool == "solve.sh"
