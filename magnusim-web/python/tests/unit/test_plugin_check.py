"""tools/plugin_check.py (npm run plugin:check): every rule, on plugins built here.

Each rule has a test that breaks a plugin the way the rule forbids and expects
that rule's finding, next to a plugin that keeps the rule and has none. The
last tests run the check over what ships (bundled-plugins/) and the core's
test plugins, with the few that are broken on purpose named.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import plugin_check
import plugin_manifest_schema
import pytest

from cfddesk.registry import API_VERSION

WEB_ROOT = Path(__file__).resolve().parents[3]
TOOL = WEB_ROOT / "python" / "tools" / "plugin_check.py"

MANIFEST = """\
key = "{key}"
name = "Good plugin"
version = "0.1.0"
api_version = "{api}"
license = "GPL-3.0-or-later"
description = "A plugin the checker should pass"
authors = ["Tests"]
"""

PLUGIN_PY = '''\
"""A plugin that registers nothing."""

from __future__ import annotations

PLUGIN = "{key}"


def register(hub):
    return None
'''

PASSING_TEST = "def test_ok():\n    assert 1 + 1 == 2\n"


def make_plugin(root: Path, key: str = "good-plugin", *, manifest_extra: str = "", files: dict[str, str] | None = None,
                api: str = API_VERSION, tests: bool = True) -> Path:
    folder = root / key
    folder.mkdir(parents=True)
    (folder / "manifest.toml").write_text(MANIFEST.format(key=key, api=api) + manifest_extra, encoding="utf-8")
    (folder / "plugin.py").write_text(PLUGIN_PY.format(key=key), encoding="utf-8")
    if tests:
        (folder / "tests").mkdir()
        (folder / "tests" / "test_good.py").write_text(PASSING_TEST, encoding="utf-8")
    for rel, text in (files or {}).items():
        path = folder / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(text), encoding="utf-8")
    return folder


def run(folder: Path, *, load: bool = False, tests: bool = False) -> plugin_check.Report:
    return plugin_check.check_plugin(folder, run_tests=tests, load=load)


def found(report: plugin_check.Report, check: str, level: str = "error") -> list[str]:
    return [f.message for f in report.findings if f.check == check and f.level == level]


# -- a plugin that keeps every rule ------------------------------------------------


def test_a_good_plugin_passes_every_rule_with_its_tests_run(tmp_path: Path):
    report = run(make_plugin(tmp_path), load=True, tests=True)
    assert report.ok, plugin_check.render(report)
    assert report.findings == []
    assert report.checks["load"] == "pass"
    assert report.checks["tests"] == "pass"
    assert report.tests["results"]["pytest"]["status"] == "passed"
    for cid in ("workspace", "ui", "tools", "requirements", "hooks"):
        assert report.checks[cid] == "n/a", cid


# -- manifest ------------------------------------------------------------------------


def test_manifest_types_and_required_keys(tmp_path: Path):
    folder = make_plugin(tmp_path)
    text = (folder / "manifest.toml").read_text(encoding="utf-8")
    (folder / "manifest.toml").write_text(text.replace('version = "0.1.0"', "version = 1"), encoding="utf-8")
    report = run(folder)
    assert any("version must be text" in m for m in found(report, "manifest")), found(report, "manifest")
    assert report.checks["manifest"] == "fail"

    (folder / "manifest.toml").write_text(text.replace('name = "Good plugin"\n', ""), encoding="utf-8")
    assert any("needs name" in m for m in found(run(folder), "manifest"))


def test_manifest_unknown_key_is_a_warning(tmp_path: Path):
    folder = make_plugin(tmp_path, manifest_extra='\n[[study_kind]]\nkey = "a"\ntitle = "A"\n')
    report = run(folder)
    assert report.ok
    assert any("study_kind is not a manifest key" in m for m in found(report, "manifest", "warning"))


def test_manifest_that_does_not_parse_stops_the_check(tmp_path: Path):
    folder = make_plugin(tmp_path)
    (folder / "manifest.toml").write_text('key = "good-plugin\n', encoding="utf-8")
    report = run(folder)
    assert found(report, "manifest")
    assert report.checks["manifest"] == "fail"
    assert report.checks["tests"] == "skipped"


def test_manifest_needs_plugin_py(tmp_path: Path):
    folder = make_plugin(tmp_path)
    (folder / "plugin.py").unlink()
    assert any("plugin.py is missing" in m for m in found(run(folder), "manifest"))


def test_manifest_table_rows_follow_the_dataclasses(tmp_path: Path):
    folder = make_plugin(
        tmp_path,
        manifest_extra='\n[[workspaces]]\nkey = "Bad Key"\ntitle = "T"\n\n[files]\nmax_file_mb = 0\n',
    )
    msgs = found(run(folder), "manifest")
    assert any("workspaces[0].key" in m for m in msgs), msgs
    assert any("files.max_file_mb must be at least 1" in m for m in msgs), msgs


# -- key -------------------------------------------------------------------------------


def test_key_must_be_the_folder_name(tmp_path: Path):
    folder = make_plugin(tmp_path)
    text = (folder / "manifest.toml").read_text(encoding="utf-8")
    (folder / "manifest.toml").write_text(text.replace('key = "good-plugin"', 'key = "other-name"'), encoding="utf-8")
    report = run(folder)
    assert any("'other-name' is not the folder's name 'good-plugin'" in m for m in found(report, "key"))
    assert not found(run(make_plugin(tmp_path / "b")), "key")


def test_key_of_a_bundled_plugin_is_taken(tmp_path: Path):
    # A user plugin with a bundled plugin's key takes that plugin's place in the host.
    folder = make_plugin(tmp_path, "incompressible_flow")
    assert any("is a bundled plugin's key (bundled-plugins/incompressible_flow, v1.0.0)" in m for m in found(run(folder), "key"))
    # The bundled plugin itself is not taking anyone's key.
    assert not found(run(WEB_ROOT / "bundled-plugins" / "incompressible_flow"), "key")


def test_a_newer_copy_of_a_bundled_plugin_is_an_update(tmp_path: Path):
    """A copy with a higher version replaces the app's own (an update); one that is
    not newer would never be used, whatever its manifest says about its tier."""
    upd = tmp_path / "upd"
    shutil.copytree(WEB_ROOT / "bundled-plugins" / "incompressible_flow", upd / "incompressible_flow",
                    ignore=shutil.ignore_patterns("__pycache__"))
    folder = upd / "incompressible_flow"
    text = (folder / "manifest.toml").read_text(encoding="utf-8")
    report = run(folder)
    assert any("v1.0.0) and this copy (v1.0.0) is not newer" in m for m in found(report, "key"))
    (folder / "manifest.toml").write_text(text.replace('version = "1.0.0"', 'version = "1.0.1"'), encoding="utf-8")
    report = run(folder)
    assert not found(report, "key")
    assert "an update of the bundled plugin incompressible_flow (v1.0.0)" in report.notes["key"]


# -- api_version -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("api", "says"),
    [("2.0", "major version 2"), ("1.999", "newer than this host"), ("one", "not major.minor")],
)
def test_api_version_errors(tmp_path: Path, api: str, says: str):
    report = run(make_plugin(tmp_path, api=api))
    assert any(says in m for m in found(report, "api_version")), found(report, "api_version")


def test_api_version_older_than_a_key_it_uses_is_a_warning(tmp_path: Path):
    folder = make_plugin(tmp_path, api="1.1", manifest_extra="\n[files]\nmax_file_mb = 8\n")
    report = run(folder)
    assert report.ok
    assert any("files needs host API 1.2" in m for m in found(report, "api_version", "warning"))
    assert not found(run(make_plugin(tmp_path / "b", api="1.2", manifest_extra="\n[files]\nmax_file_mb = 8\n")), "api_version", "warning")


# -- license -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("expr", "level"),
    [
        ("GPL-3.0-or-later", None),
        ("MIT", None),
        ("Apache-2.0 OR MIT", None),
        ("(MIT AND BSD-3-Clause)", None),
        ("GPL-3.0-or-later WITH GCC-exception-3.1", None),
        ("MIT OR LicenseRef-Proprietary", None),
        ("GPL-3.0", "warning"),
        ("GPL-2.0-only", "error"),
        ("Proprietary", "error"),
        ("MIT AND LicenseRef-Proprietary", "error"),
        ("MIT OR", "error"),
        ("MIT WITH", "error"),
        ("(MIT WITH)", "error"),
        ("MIT WITH OR GPL-3.0-or-later", "error"),
        ("", "error"),
    ],
)
def test_license_expressions(expr: str, level: str | None):
    problem = plugin_check.license_problem(expr)
    assert (problem[0] if problem else None) == level, problem


def test_license_rule_runs_on_the_manifest(tmp_path: Path):
    folder = make_plugin(tmp_path)
    text = (folder / "manifest.toml").read_text(encoding="utf-8")
    (folder / "manifest.toml").write_text(text.replace("GPL-3.0-or-later", "GPL-2.0-only"), encoding="utf-8")
    assert any("cannot be combined with GPL-3.0" in m for m in found(run(folder), "license"))


# -- load ---------------------------------------------------------------------------------


def test_load_reports_a_register_that_raises(tmp_path: Path):
    folder = make_plugin(tmp_path)
    (folder / "plugin.py").write_text("def register(hub):\n    raise RuntimeError('broken on purpose')\n", encoding="utf-8")
    report = run(folder, load=True)
    assert any("broken on purpose" in m for m in found(report, "load")), plugin_check.render(report)


def test_load_reports_a_manifest_table_the_host_refuses(tmp_path: Path):
    folder = make_plugin(
        tmp_path,
        manifest_extra='\n[[study_kinds]]\nkey = "note"\ntitle = "Note"\nworkspace = "nowhere"\n',
    )
    report = run(folder, load=True)
    assert any("workspace 'nowhere' is not declared" in m for m in found(report, "load")), plugin_check.render(report)


def test_load_passes_on_what_the_loader_ignores_as_a_warning(tmp_path: Path):
    folder = make_plugin(
        tmp_path,
        files={"workspace/index.html": '<script type="module" src="./main.js"></script>', "workspace/main.js": "import { connect } from '@magnusim/workspace';\nawait connect();\n"},
        manifest_extra=textwrap.dedent(
            """
            [[workspaces]]
            key = "pad"
            title = "Pad"

            [[study_kinds]]
            key = "pad"
            title = "Pad"
            workspace = "pad"

            [[start_actions]]
            study_kind = "pad"
            label = "Start a pad"
            places = ["home", "toolbar"]
            """
        ),
    )
    report = run(folder, load=True)
    assert report.ok, plugin_check.render(report)
    assert any("'toolbar' is not known to this app" in m for m in found(report, "load", "warning"))
    assert not found(report, "manifest", "warning")  # the open list is the loader's to judge


def dir_link(link: Path, target: Path) -> None:
    """A folder link: a junction on Windows (no privilege needed), else a symlink."""
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    else:
        os.symlink(target, link, target_is_directory=True)


def test_load_reports_links_the_host_refuses_and_survives_a_loop(tmp_path: Path):
    outside = tmp_path / "outside-tools"
    outside.mkdir()
    (outside / "run.py").write_text("print('run')\n", encoding="utf-8")
    folder = make_plugin(tmp_path / "set")
    body = '    hub.register_job(JobKind("gp_link", "tools/run.py", "project", python="core"), plugin=PLUGIN, package_dir=HERE)'
    (folder / "plugin.py").write_text(JOB_PLUGIN.format(body=body), encoding="utf-8")
    dir_link(folder / "tools", outside)  # resolves outside: the host refuses the tool
    dir_link(folder / "data", folder)  # a loop
    (folder / "inner").mkdir()
    dir_link(folder / "alias", folder / "inner")  # inside the plugin: fine
    other = make_plugin(tmp_path / "set", "other-plugin", tests=False)
    done = subprocess.run(
        [sys.executable, str(TOOL), "--json", "--no-tests", str(folder), str(other)],
        capture_output=True, text=True, encoding="utf-8", timeout=600,
    )
    doc = json.loads(done.stdout)  # no crash: both plugins reported
    by_key = {p["key"]: p for p in doc["plugins"]}
    assert by_key["other-plugin"]["ok"], by_key["other-plugin"]
    load = [f for f in by_key["good-plugin"]["findings"] if f["check"] == "load"]
    assert any(f["file"] == "tools" and "leads outside the plugin" in f["message"] for f in load), load
    assert any(f["file"] == "data" and "a loop" in f["message"] for f in load), load
    assert not any(f["file"] == "alias" for f in load), load
    # The load probe ran on a copy without those links (copying the loop never ends),
    # so it saw what the host sees: no tool inside the plugin.
    assert not any("could not be copied" in f["message"] for f in load), load
    assert any("the host refuses to load it" in f["message"] and "tools/run.py" in f["message"] for f in load), load
    assert done.returncode == 1


def test_links_in_folders_the_host_never_reads_are_not_refused(tmp_path: Path):
    # A developer's node_modules junctioned to a shared install (a snapshot of the app, a
    # monorepo), a cache folder linked elsewhere, and a link inside a real node_modules
    # (pnpm's layout): the host never reads these folders, so none is a load error.
    shared = tmp_path / "shared-node-modules"
    (shared / "pkg").mkdir(parents=True)
    (shared / "pkg" / "index.js").write_text("module.exports = 1;\n", encoding="utf-8")
    folder = make_plugin(tmp_path / "set")
    dir_link(folder / "node_modules", shared)
    dir_link(folder / ".cache", shared)
    (folder / "ui").mkdir()
    (folder / "ui" / "node_modules").mkdir()
    dir_link(folder / "ui" / "node_modules" / "pkg", shared / "pkg")
    assert plugin_check.link_problems(folder) == []
    report = run(folder, load=True)
    assert report.checks["load"] == "pass", plugin_check.render(report)
    assert found(report, "load") == [] and found(report, "load", "warning") == []
    # A link elsewhere in the plugin to the same place is still refused.
    dir_link(folder / "vendor-js", shared)
    assert [p.name for p, _why in plugin_check.link_problems(folder)] == ["vendor-js"]


# -- imports and register --------------------------------------------------------------------


def test_imports_outside_the_boundary(tmp_path: Path):
    folder = make_plugin(tmp_path)
    (folder / "plugin.py").write_text("import requests\n\n\ndef register(hub):\n    return None\n", encoding="utf-8")
    assert any("not requests" in m for m in found(run(folder), "imports"))


def test_register_body_imports_nothing_heavy(tmp_path: Path):
    folder = make_plugin(tmp_path)
    (folder / "plugin.py").write_text("def register(hub):\n    import numpy\n    return None\n", encoding="utf-8")
    msgs = found(run(folder), "register")
    assert any("register() imports numpy" in m for m in msgs), msgs


@pytest.mark.parametrize(
    ("code", "name"),
    [
        ("import importlib\n\n\ndef register(hub):\n    importlib.import_module('gmsh')\n    return None\n", "gmsh"),
        ("def register(hub):\n    __import__('numpy.linalg')\n    return None\n", "numpy.linalg"),
        ("from importlib import import_module as load\n\n\ndef register(hub):\n    load('scipy')\n    return None\n", "scipy"),
        # A star import binds import_module; a relative name is read against its package.
        ("from importlib import *\n\n\ndef register(hub):\n    import_module('gmsh')\n    return None\n", "gmsh"),
        ("import importlib\n\n\ndef register(hub):\n    importlib.import_module('.gmsh', 'gmsh')\n    return None\n", "gmsh.gmsh"),
    ],
)
def test_register_body_imports_nothing_heavy_by_name(tmp_path: Path, code: str, name: str):
    folder = make_plugin(tmp_path)
    (folder / "plugin.py").write_text(code, encoding="utf-8")
    msgs = found(run(folder), "register")
    assert any(f"register() imports {name}" in m for m in msgs), msgs


def test_imports_on_the_plugins_own_environment(tmp_path: Path):
    extra = '\n[python]\nrequirements = "requirements.lock"\nservice = "good_service"\n'
    lock = "gmsh==4.15.2 \\\n    --hash=sha256:" + "0" * 64 + "\n"
    folder = make_plugin(
        tmp_path,
        manifest_extra=extra,
        files={"requirements.lock": lock, "good_service.py": "import gmsh\nfrom magnusim_sdk.service import method\n"},
    )
    report = run(folder)
    assert report.checks["imports"] == "pass", found(report, "imports")
    # The host loads plugin.py: the lock's packages are not for it.
    (folder / "plugin.py").write_text("import gmsh\n\n\ndef register(hub):\n    return None\n", encoding="utf-8")
    assert any("gmsh comes from gmsh, pinned in the plugin's lock" in m for m in found(run(folder), "imports"))
    (folder / "plugin.py").write_text(PLUGIN_PY.format(key="good-plugin"), encoding="utf-8")
    # Nor is the core, from the environment, by import statement or by name.
    (folder / "good_service.py").write_text("import importlib\n\nscope = importlib.import_module('cfddesk.project.scope')\n", encoding="utf-8")
    assert any("not cfddesk.project.scope" in m for m in found(run(folder), "imports"))


def test_register_with_no_register_function(tmp_path: Path):
    folder = make_plugin(tmp_path)
    (folder / "plugin.py").write_text("PLUGIN = 'x'\n", encoding="utf-8")
    assert any("no top-level register(hub)" in m for m in found(run(folder), "register"))


def test_register_may_define_functions_that_import_lazily(tmp_path: Path):
    # The lazy import the rule asks for: defined in register(), run only when called.
    folder = make_plugin(tmp_path)
    (folder / "plugin.py").write_text(
        "def register(hub):\n    def on_saved(payload):\n        import numpy as np\n        return np.zeros(1)\n\n"
        "    later = lambda: __import__('scipy')\n\n    class Handler:\n        def run(self):\n            import gmsh\n\n"
        "    return None\n",
        encoding="utf-8",
    )
    report = run(folder, load=True)
    assert not found(report, "register"), plugin_check.render(report)
    # A class body runs when register() runs; its method does not.
    (folder / "plugin.py").write_text("def register(hub):\n    class Mesh:\n        import gmsh\n    return None\n", encoding="utf-8")
    assert any("register() imports gmsh" in m for m in found(run(folder), "register"))


def test_register_re_exported_from_the_plugins_own_module(tmp_path: Path):
    folder = make_plugin(tmp_path, files={"good_core.py": "def register(hub):\n    return None\n"})
    (folder / "plugin.py").write_text("from good_core import register\n\n__all__ = ['register']\n", encoding="utf-8")
    report = run(folder, load=True)
    assert report.ok, plugin_check.render(report)
    # Followed: what the real register() imports is still checked.
    (folder / "good_core.py").write_text("def register(hub):\n    import numpy\n    return None\n", encoding="utf-8")
    report = run(folder)
    assert any("register() imports numpy" in m for m in found(report, "register")), found(report, "register")
    assert any(f.file == "good_core.py" for f in report.findings if f.check == "register")
    # Further than the AST follows (a star import): left to loading the plugin, not an error.
    (folder / "good_core.py").write_text("from good_impl import *  # noqa: F403\n", encoding="utf-8")
    (folder / "good_impl.py").write_text("__all__ = ['register']\n\n\ndef register(hub):\n    return None\n", encoding="utf-8")
    report = run(folder, load=True)
    assert report.ok, plugin_check.render(report)


@pytest.mark.parametrize("how", ["importlib.import_module('numpy')", "__import__('pyvista')"])
def test_register_loading_imports_a_package_the_host_has_already(tmp_path: Path, how: str):
    # The host's loader imports numpy, pyvista and vtk itself: a new-module diff
    # never shows them, so the probe watches the plugin's own imports.
    folder = make_plugin(tmp_path)
    (folder / "plugin.py").write_text(f"import importlib\n\nHEAVY = {how}\n\n\ndef register(hub):\n    return None\n", encoding="utf-8")
    report = run(folder, load=True)
    name = "numpy" if "numpy" in how else "pyvista"
    assert any(f"loading the plugin imports {name}" in m for m in found(report, "register")), plugin_check.render(report)


def test_register_loading_pulls_in_a_heavy_package(tmp_path: Path):
    # Hidden from the import scan (built name); only loading the plugin shows it.
    folder = make_plugin(
        tmp_path,
        files={"good_plugin_mesh/__init__.py": "import importlib\n\ngmsh = importlib.import_module('gm' + 'sh')\n"},
    )
    (folder / "plugin.py").write_text("import good_plugin_mesh\n\n\ndef register(hub):\n    return None\n", encoding="utf-8")
    report = run(folder, load=True)
    assert any("loading the plugin imports gmsh" in m for m in found(report, "register")), plugin_check.render(report)


# -- React ----------------------------------------------------------------------------------


def test_react_as_a_dependency(tmp_path: Path):
    folder = make_plugin(tmp_path, files={"package.json": json.dumps({"dependencies": {"react": "^19.0.0"}})})
    assert any("dependencies has react" in m for m in found(run(folder), "react"))
    ok = make_plugin(tmp_path / "b", files={"package.json": json.dumps({"devDependencies": {"react": "^19.0.0"}})})
    assert not found(run(ok), "react")


def test_react_bundled_into_a_workspace_script(tmp_path: Path):
    folder = make_plugin(tmp_path, files={"workspace/app.js": "var R={__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE:{}};\n"})
    assert any("React's own code" in m for m in found(run(folder), "react"))


def test_react_from_a_url(tmp_path: Path):
    folder = make_plugin(
        tmp_path,
        files={
            "workspace/index.html": '<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>',
            "workspace/main.js": 'import React from "https://esm.sh/react@18";\nimport { createRoot } from "https://esm.sh/react-dom@18/client";\n',
            "ui/panel.tsx": 'import x from "https://cdn.example.org/react-dom.mjs";\n',
        },
    )
    msgs = found(run(folder), "react")
    assert len(msgs) == 4, msgs
    assert all(m.startswith("loads React from https://") for m in msgs), msgs
    # Other packages from a URL are the workspace rule's business, not React's.
    other = make_plugin(tmp_path / "b", files={"workspace/main.js": 'import r from "https://esm.sh/react-router@6";\n'})
    assert not found(run(other), "react")


# -- workspace --------------------------------------------------------------------------------

WS_MANIFEST = '\n[[workspaces]]\nkey = "pad"\ntitle = "Pad"\n'


def test_workspace_that_connects(tmp_path: Path):
    folder = make_plugin(
        tmp_path,
        manifest_extra=WS_MANIFEST,
        files={
            "workspace/index.html": '<script type="module" src="./main.js"></script>',
            "workspace/main.js": "import { connect } from '@magnusim/workspace';\nimport { Button } from '@magnusim/plugin-ui';\nawait connect();\n",
        },
    )
    report = run(folder)
    assert report.checks["workspace"] == "pass", plugin_check.render(report)


@pytest.mark.parametrize(
    ("files", "says"),
    [
        ({"workspace/index.html": "<p>no script</p>", "workspace/main.js": "import '@magnusim/workspace';"}, "loads no script"),
        ({"workspace/index.html": '<script type="module" src="./gone.js"></script>'}, "loads ./gone.js, which is missing"),
        ({"workspace/index.html": '<script type="module" src="./main.js"></script>', "workspace/main.js": "console.log(1);\n"},
         "no workspace script imports '@magnusim/workspace'"),
        ({"workspace/index.html": '<script type="module" src="./main.js"></script>',
          "workspace/main.js": "import { connect } from '@magnusim/workspace';\nimport * as THREE from 'three';\n"},
         "imports 'three', which a workspace frame cannot resolve"),
        ({}, "its entry workspace/index.html is missing"),
    ],
)
def test_workspace_faults(tmp_path: Path, files: dict[str, str], says: str):
    report = run(make_plugin(tmp_path, manifest_extra=WS_MANIFEST, files=files))
    assert any(says in m for m in found(report, "workspace")), found(report, "workspace")


def test_workspace_inline_script_never_runs_so_it_never_connects(tmp_path: Path):
    # The frame's CSP (frameCsp in scripts/server/workspace-files.ts) has no
    # 'unsafe-inline': the browser never runs this, so the page never connects.
    html = "<script type=\"module\">\nimport { connect } from '@magnusim/workspace';\nawait connect();\n</script>"
    report = run(make_plugin(tmp_path, manifest_extra=WS_MANIFEST, files={"workspace/index.html": html}))
    msgs = found(report, "workspace")
    assert any("has an inline script" in m for m in msgs), msgs
    assert any("no workspace script imports '@magnusim/workspace'" in m for m in msgs), msgs
    # A data block is never run, so it is fine; the script file connects.
    ok = make_plugin(
        tmp_path / "b",
        manifest_extra=WS_MANIFEST,
        files={
            "workspace/index.html": '<script type="application/json" id="cfg">{"a": 1}</script>\n<script type="module" src="./main.js"></script>',
            "workspace/main.js": "import { connect } from '@magnusim/workspace';\nawait connect();\n",
        },
    )
    assert run(ok).checks["workspace"] == "pass", plugin_check.render(run(ok))


GOOD_MAIN = "import { connect } from '@magnusim/workspace';\nawait connect();\n"


@pytest.mark.parametrize(
    ("files", "says"),
    [
        # Another site: the CSP's script-src has no outside origin.
        ({"workspace/index.html": '<script src="https://cdn.example.org/lib.js"></script><script type="module" src="./main.js"></script>'},
         "loads https://cdn.example.org/lib.js, which is on another site"),
        ({"workspace/index.html": '<script type="module" src="//cdn.example.org/lib.js"></script><script type="module" src="./main.js"></script>'},
         "loads //cdn.example.org/lib.js, which is on another site"),
        ({"workspace/index.html": '<script type="module" src="./main.js"></script>',
          "workspace/main.js": GOOD_MAIN + "import * as d3 from 'https://esm.sh/d3@7';\n"},
         "imports https://esm.sh/d3@7, which is on another site"),
        # An absolute path outside /plugin-sdk/ and the plugin's own folder.
        ({"workspace/index.html": '<script type="module" src="/api/x.js"></script><script type="module" src="./main.js"></script>'},
         "loads /api/x.js, a path the frame's Content-Security-Policy does not allow"),
        # Served as application/octet-stream with nosniff: never run.
        ({"workspace/index.html": '<script src="./lib.cjs"></script><script type="module" src="./main.js"></script>', "workspace/lib.cjs": "1;\n"},
         "which the host serves as .cjs, not JavaScript"),
        ({"workspace/index.html": '<script type="importmap">{"imports": {}}</script><script type="module" src="./main.js"></script>'},
         "has an import map of its own"),
        ({"workspace/index.html": '<script type="module" src="./main.js"></script>',
          "workspace/main.js": GOOD_MAIN + "import { x } from './util';\n"},
         "imports ./util, which is missing"),
        ({"workspace/index.html": '<script type="module" src="./main.js"></script>',
          "workspace/main.js": GOOD_MAIN + "import fs from 'node:fs';\n"},
         "imports node:fs, a Node.js module, which a browser cannot load"),
    ],
)
def test_workspace_scripts_the_frame_csp_never_runs(tmp_path: Path, files: dict[str, str], says: str):
    files = {"workspace/main.js": GOOD_MAIN, **files}
    report = run(make_plugin(tmp_path, manifest_extra=WS_MANIFEST, files=files))
    assert any(says in m for m in found(report, "workspace")), found(report, "workspace")


def test_workspace_paths_the_frame_csp_allows(tmp_path: Path):
    folder = make_plugin(
        tmp_path,
        manifest_extra=WS_MANIFEST,
        files={
            "workspace/index.html": '<script type="module" src="/plugins/good-plugin/workspace/main.js"></script>'
            '<script type="module" src="/plugin-sdk/extra.js"></script>',
            "workspace/main.js": GOOD_MAIN + "import { y } from './lib/y.mjs';\nimport data from './data.json' with { type: 'json' };\n"
            # A WASM build's Node-only branch: never reached in a browser.
            "if (typeof process === 'object') { const fs = require('node:fs'); await import('node:module'); }\n",
            "workspace/lib/y.mjs": "export const y = 1;\n",
            "workspace/data.json": "{}\n",
        },
    )
    report = run(folder)
    assert report.checks["workspace"] == "pass", plugin_check.render(report)


# -- ui ---------------------------------------------------------------------------------------

UI_MANIFEST = '\nui = "ui"\nui_entry = "index.tsx"\n'


def test_ui_imports(tmp_path: Path):
    good = make_plugin(
        tmp_path,
        manifest_extra=UI_MANIFEST,
        files={
            "ui/index.tsx": "import { useState } from 'react';\nimport type { RJSFSchema } from '@rjsf/utils';\nimport { Button } from '@magnusim/plugin-ui';\nimport { x } from './x';\n",
            "ui/x.ts": "export const x = 1;\n",
            "ui/index.test.tsx": "import { render } from '@testing-library/react';\n",
        },
    )
    assert run(good).checks["ui"] == "pass"
    bad = make_plugin(
        tmp_path / "b",
        manifest_extra=UI_MANIFEST,
        files={"ui/index.tsx": "import _ from 'lodash';\nimport { y } from '../outside';\n", "outside.ts": "export const y = 1;\n"},
    )
    msgs = found(run(bad), "ui")
    assert any("imports 'lodash'" in m for m in msgs), msgs
    assert any("leaves the ui folder" in m for m in msgs), msgs


def test_ui_imports_as_the_hosts_bundler_reads_them(tmp_path: Path):
    # plugin-ui-bundle.ts refuses every specifier that is not ./ or ../ (or the
    # host's own), require() and absolute paths included; comments are not code.
    bad = make_plugin(
        tmp_path,
        manifest_extra=UI_MANIFEST,
        files={
            "ui/index.tsx": 'const _ = require("lodash");\nimport x from "/abs/thing.js";\nimport y from "https://esm.sh/zod";\n'
            "export const z = import('left-pad');\n",
        },
    )
    msgs = found(run(bad), "ui")
    for spec in ("lodash", "/abs/thing.js", "https://esm.sh/zod", "left-pad"):
        assert any(f"imports '{spec}'" in m for m in msgs), (spec, msgs)
    ok = make_plugin(
        tmp_path / "b",
        manifest_extra=UI_MANIFEST,
        files={
            "ui/index.tsx": '// import _ from "lodash";\n/* import x from "moment";\n   require("left-pad") */\n'
            "const doc = 'import a from \"b\"';\nconst re = /\\/\\/ import c from 'd'/;\nconst y = require('./y');\n"
            "export default function A() { return null; }\n",
            "ui/y.ts": "export const y = 1;\n",
        },
    )
    assert run(ok).checks["ui"] == "pass", found(run(ok), "ui")


def test_js_scan_blanks_comments_and_finds_strings():
    text = "a = '//x'; // gone\nb = `t${ '#1' }u\nv` /* c\nd */ / 2;\nr = /'[/]/g;\n"
    code, spans = plugin_check.js_scan(text)
    assert code.count("\n") == text.count("\n") and len(code) == len(text)
    assert "gone" not in code and "c\nd" not in code and "'//x'" in code
    literals = [text[a:b] for a, b in spans]
    assert "'//x'" in literals and "'#1'" in literals
    assert any(lit.startswith("`t") for lit in literals) and any(lit.endswith("u\nv`") for lit in literals)
    assert "'[/]/g;\n" not in "".join(literals)  # a regex literal is not a string


def test_ui_entry_missing(tmp_path: Path):
    report = run(make_plugin(tmp_path, manifest_extra=UI_MANIFEST))
    assert any("ui/index.tsx is missing" in m for m in found(report, "ui"))


# -- tools ----------------------------------------------------------------------------------

JOB_PLUGIN = '''\
from pathlib import Path

from cfddesk.registry.jobs import JobKind

PLUGIN = "good-plugin"
HERE = Path(__file__).resolve().parent


def register(hub):
{body}
    return None
'''


@pytest.mark.parametrize(
    ("body", "says"),
    [
        ('    hub.register_job(JobKind("gp_ok", "tools/run.py", "project", python="core"), plugin=PLUGIN, package_dir=HERE)', None),
        ('    hub.registry("job").register(JobKind("gp_out", "../elsewhere.py", "project"), plugin=PLUGIN)', "without package_dir"),
        ('    hub.register_job(JobKind("gp_env", "tools/run.py", "project", python="plugin"), plugin=PLUGIN, package_dir=HERE)', "has no [python] table"),
    ],
)
def test_tools_inside_the_plugin(tmp_path: Path, body: str, says: str | None):
    folder = make_plugin(tmp_path, files={"tools/run.py": "print('run')\n"})
    (folder / "plugin.py").write_text(JOB_PLUGIN.format(body=body), encoding="utf-8")
    report = run(folder, load=True)
    msgs = found(report, "tools")
    if says is None:
        assert not msgs and report.checks["tools"] == "pass", plugin_check.render(report)
    else:
        assert any(says in m for m in msgs), plugin_check.render(report)


def test_tools_job_tool_outside_through_the_registry(tmp_path: Path):
    folder = make_plugin(tmp_path)
    body = (
        '    hub.registry("job").register(JobKind("gp_far", "../far.py", "project"), plugin=PLUGIN)\n'
        "    hub._job_packages['gp_far'] = HERE"
    )
    (folder / "plugin.py").write_text(JOB_PLUGIN.format(body=body), encoding="utf-8")
    assert any("outside the plugin folder" in m for m in found(run(folder, load=True), "tools"))


def test_tools_service_module_must_exist(tmp_path: Path):
    extra = '\n[python]\nrequirements = "requirements.lock"\nservice = "good_service"\n'
    folder = make_plugin(tmp_path, manifest_extra=extra, files={"requirements.lock": "# no packages\n"})
    assert any("service 'good_service' is not a module" in m for m in found(run(folder), "tools"))
    (folder / "good_service.py").write_text("from magnusim_sdk.service import method\n", encoding="utf-8")
    assert not found(run(folder), "tools")


@pytest.mark.parametrize("service", ["../elsewhere", "/abs/svc", "back end", "svc.", "2fast"])
def test_tools_a_service_that_is_no_module_name_is_an_error_not_a_crash(tmp_path: Path, service: str):
    extra = f'\n[python]\nrequirements = "requirements.lock"\nservice = "{service}"\n'
    folder = make_plugin(tmp_path, manifest_extra=extra, files={"requirements.lock": "# no packages\n"})
    report = run(folder)
    assert any(f"service {service!r} is not a module name" in m for m in found(report, "tools")), report.findings
    # The checker ran its rules: no "plugin:check itself failed".
    assert not any("itself failed" in f.message for f in report.findings), [f.message for f in report.findings]


# -- requirements ----------------------------------------------------------------------------

HASH = "--hash=sha256:" + "0" * 64


def test_lock_problems():
    good = f"# pinned\nrequests==2.32.3 \\\n    {HASH}\nidna==3.7 {HASH}  # inline\n--index-url https://pypi.org/simple\n"
    assert plugin_check.lock_problems(good) == []
    bad = plugin_check.lock_problems(f"requests>=2 {HASH}\nidna==3.7\n-e .\n")
    assert [line for line, _ in bad] == [1, 2, 3]
    assert "not pinned" in bad[0][1] and "no --hash" in bad[1][1] and "-e is not allowed" in bad[2][1]


@pytest.mark.parametrize(
    "line",
    ["-rother.txt", "--requirement=other.txt", "--requirem other.txt", "-cconstraints.txt", "--cons c.txt", "-e.", "--ed=."],
)
def test_lock_options_read_as_pip_reads_them(line: str):
    # optparse: a short option's value may follow it directly; a long one may be shortened.
    bad = plugin_check.lock_problems(f"six==1.16.0 {HASH}\n{line}\n")
    assert [n for n, _ in bad] == [2] and "is not allowed in a lock" in bad[0][1], bad
    assert plugin_check.lock_problems(f"six==1.16.0 {HASH}\n--require-hashes\n--index-url https://pypi.org/simple\n") == []


@pytest.mark.parametrize("codec", ["utf-8-sig", "utf-16", "utf-32"])
def test_lock_with_a_byte_order_mark_is_read_as_pip_reads_it(tmp_path: Path, codec: str):
    # Notepad and PowerShell 5.1 write these; pip decodes requirement files by the mark.
    extra = '\n[python]\nrequirements = "requirements.lock"\n'
    folder = make_plugin(tmp_path, manifest_extra=extra)
    (folder / "requirements.lock").write_bytes(f"six==1.16.0 \\\n    {HASH}\n".encode(codec))
    report = run(folder)
    assert report.checks["requirements"] == "pass", found(report, "requirements")
    (folder / "requirements.lock").write_bytes("six>=1\n".encode(codec))
    assert any("'six>=1' is not pinned" in m for m in found(run(folder), "requirements"))


def test_requirements_rule_reads_the_manifest_lock(tmp_path: Path):
    extra = '\n[python]\nrequirements = "requirements.lock"\n'
    folder = make_plugin(tmp_path, manifest_extra=extra, files={"requirements.lock": "numpy>=1\n"})
    msgs = found(run(folder), "requirements")
    assert any("not pinned" in m for m in msgs) and any("no --hash" in m for m in msgs), msgs
    (folder / "requirements.lock").unlink()
    assert any("is missing" in m for m in found(run(folder), "requirements"))


# -- hooks --------------------------------------------------------------------------------------


def test_hooks_reserved_is_a_warning(tmp_path: Path):
    folder = make_plugin(tmp_path)
    (folder / "plugin.py").write_text(
        "from cfddesk.registry.hooks import get_hooks\n\n\ndef _f(**kw):\n    return None\n\n\n"
        "def register(hub):\n    get_hooks().on('mesh.result', _f, plugin='good-plugin')\n    get_hooks().on('case.written', _f, plugin='good-plugin')\n",
        encoding="utf-8",
    )
    report = run(folder, load=True)
    msgs = found(report, "hooks", "warning")
    assert any("'mesh.result'" in m for m in msgs) and not any("case.written" in m for m in msgs), msgs
    assert report.ok


# -- colours ---------------------------------------------------------------------------------------


def test_colours_outside_tokens_warn(tmp_path: Path):
    css = """\
    :root { --mine-accent: #1570ef; }
    /* a note about #101828 */
    .a { color: var(--mg-text, #101828); border: 1px solid #ff0000; }
    """
    js = "const ok = '#/p/1';\nconst c = '#abcdef';\nel.querySelector('#main');\n"
    report = run(make_plugin(tmp_path, files={"src/app.css": css, "src/app.js": js}))
    msgs = found(report, "colours", "warning")
    assert len(msgs) == 2, msgs
    assert any("#ff0000" in m for m in msgs) and any("#abcdef" in m for m in msgs)
    assert report.ok


def test_colours_in_template_literals_but_not_in_references(tmp_path: Path):
    js = "// a note about #123456\nconst css = `\n  .x {\n    color: #ff0000;\n  }\n`;\nconst link = <a href=\"#add\">Add</a>;\n"
    html = '<a href="#add">Add</a> <p id="bed"></p> <svg><rect fill="url(#bed)"/></svg>\n<p style="color: #abc">x</p>\n'
    report = run(make_plugin(tmp_path, files={"ui/panel.jsx": js, "ui/help.html": html}))
    hits = sorted((f.file, f.line, f.message.split()[2]) for f in report.findings if f.check == "colours")
    assert hits == [("ui/help.html", 2, "#abc"), ("ui/panel.jsx", 4, "#ff0000")], hits


# -- copy -----------------------------------------------------------------------------------------


def test_copy_banned_words(tmp_path: Path):
    folder = make_plugin(
        tmp_path,
        files={
            "a.py": "LABEL = 'Coming soon'\n",
            "b.js": "// TODO wire this\n",
            "c.html": "<p>Lorem ipsum</p>\n",
            "README.md": "No `TODO`, no \"coming soon\", no “lorem” in copy.\n",
            "NOTES.md": "TODO: finish\n",
        },
    )
    msgs = [(f.file, f.line) for f in run(folder).findings if f.check == "copy"]
    assert sorted(msgs) == [("NOTES.md", 1), ("a.py", 1), ("b.js", 1), ("c.html", 1)], msgs


def test_copy_reads_pyw_and_text_in_any_unicode_encoding(tmp_path: Path):
    folder = make_plugin(tmp_path, files={"panel.pyw": "LABEL = 'Coming soon'\n"})
    (folder / "notes.txt").write_bytes("Ready: TODO\n".encode("utf-16"))
    (folder / "more.md").write_bytes("Lorem ipsum\n".encode("utf-8-sig"))
    msgs = sorted((f.file, f.message.split("'")[1]) for f in run(folder).findings if f.check == "copy")
    assert msgs == [("more.md", "lorem"), ("notes.txt", "TODO"), ("panel.pyw", "coming soon")], msgs


def test_copy_and_colours_skip_vendored_code(tmp_path: Path):
    folder = make_plugin(
        tmp_path,
        files={
            "_vendor/lib/__init__.py": "# TODO(upstream): speed up\nC = '#ff0000'\n",
            "third_party/x.js": "// TODO\nconst c = '#00ff00';\n",
            "extlib/LICENSE": "MIT License\n",
            "extlib/core.py": "# TODO: upstream's\n",
        },
    )
    report = run(folder)
    assert not found(report, "copy") and not found(report, "colours", "warning"), plugin_check.render(report)
    # The plugin's own code is still read.
    (folder / "own.py").write_text("# TODO\n", encoding="utf-8")
    assert found(run(folder), "copy")


def test_copy_reads_sources_not_build_output(tmp_path: Path):
    folder = make_plugin(
        tmp_path,
        files={
            "package.json": json.dumps({"scripts": {"build": "vite build"}}),
            "src/main.js": "export const x = 1;\n",
            "workspace/main.js": "// TODO from a vendored library\n",
            "node_modules/x/index.js": "// TODO\n",
            "tests/test_x.py": "# TODO\ndef test_x():\n    pass\n",
        },
    )
    assert not found(run(folder), "copy")
    (folder / "src" / "main.js").write_text("// TODO\n", encoding="utf-8")
    assert found(run(folder), "copy")


# -- tests ----------------------------------------------------------------------------------------


def test_tests_that_fail(tmp_path: Path):
    folder = make_plugin(tmp_path)
    (folder / "tests" / "test_bad.py").write_text("def test_bad():\n    assert False, 'fails on purpose'\n", encoding="utf-8")
    report = run(folder, tests=True)
    assert report.checks["tests"] == "fail"
    assert any("pytest failed" in m for m in found(report, "tests")), found(report, "tests")


def test_tests_skipped_is_never_passed(tmp_path: Path):
    report = run(make_plugin(tmp_path), tests=False)
    assert report.checks["tests"] == "skipped"
    assert report.tests["status"] == "skipped"


def test_no_tests_is_a_warning(tmp_path: Path):
    report = run(make_plugin(tmp_path, tests=False), tests=True)
    assert any("no tests" in m for m in found(report, "tests", "warning"))


def test_npm_tests_need_the_plugins_packages(tmp_path: Path):
    folder = make_plugin(tmp_path, tests=False, files={"package.json": json.dumps({"scripts": {"test": "vitest run"}})})
    report = run(folder, tests=True)
    assert any("run npm ci in the plugin folder" in m for m in found(report, "tests"))


def test_tests_never_see_this_pcs_settings(tmp_path: Path):
    folder = make_plugin(tmp_path)
    (folder / "tests" / "test_env.py").write_text(
        "import os\n\n\ndef test_env():\n    path = os.environ['MAGNUSIM_LOCAL_JSON']\n"
        "    assert 'magnusim-plugin-tests-' in path and path.endswith('settings.json')\n",
        encoding="utf-8",
    )
    assert run(folder, tests=True).checks["tests"] == "pass"


# -- the command line ------------------------------------------------------------------------------


def test_cli_json_exit_codes_and_globs(tmp_path: Path):
    make_plugin(tmp_path / "set", "good-plugin", tests=False)
    bad = make_plugin(tmp_path / "set", "bad-plugin", tests=False)
    (bad / "plugin.py").write_text("LABEL = 'TODO'\n\n\ndef register(hub):\n    return None\n", encoding="utf-8")
    done = subprocess.run(
        [sys.executable, str(TOOL), "--json", "--no-tests", str(tmp_path / "set" / "*")],
        capture_output=True, text=True, encoding="utf-8", timeout=300,
    )
    assert done.returncode == 1, done.stderr
    doc = json.loads(done.stdout)
    by_key = {p["key"]: p for p in doc["plugins"]}
    assert set(by_key) == {"good-plugin", "bad-plugin"}
    assert by_key["good-plugin"]["ok"] and not by_key["bad-plugin"]["ok"]
    assert by_key["bad-plugin"]["checks"]["copy"] == "fail"
    good_only = subprocess.run(
        [sys.executable, str(TOOL), "--no-tests", str(tmp_path / "set" / "good-plugin")],
        capture_output=True, text=True, encoding="utf-8", timeout=300,
    )
    assert good_only.returncode == 0, good_only.stdout
    assert "PASS: 0 error(s)" in good_only.stdout
    missing = subprocess.run([sys.executable, str(TOOL), str(tmp_path / "nowhere")], capture_output=True, text=True, timeout=60)
    assert missing.returncode == 2
    assert "not a plugin folder" in missing.stderr


def test_cli_paths_with_dots_and_another_letter_case(tmp_path: Path):
    folder = make_plugin(tmp_path, tests=False)
    (folder / "tests").mkdir()
    # `..` from inside the plugin is the plugin.
    env = {k: v for k, v in os.environ.items() if k != "INIT_CWD"}  # npm's, when run through npm
    up = subprocess.run(
        [sys.executable, str(TOOL), "--json", "--no-tests", ".."],
        cwd=str(folder / "tests"), capture_output=True, text=True, encoding="utf-8", timeout=300, env=env,
    )
    assert up.returncode == 0, up.stdout + up.stderr
    assert json.loads(up.stdout)["plugins"][0]["key"] == "good-plugin"
    # The folder's name as it is on disk, not as typed (a case-insensitive file system).
    other_case = tmp_path / "GOOD-PLUGIN"
    if other_case.exists():
        report = plugin_check.check_plugin(other_case, run_tests=False, load=False)
        assert not found(report, "key"), found(report, "key")


def test_cli_one_plugin_that_breaks_the_check_does_not_hide_the_others(tmp_path: Path, monkeypatch, capsys):
    make_plugin(tmp_path / "set", "good-plugin", tests=False)
    make_plugin(tmp_path / "set", "odd-plugin", tests=False)
    real = plugin_check.check_plugin

    def flaky(folder, **kw):
        if Path(folder).name == "odd-plugin":
            raise RuntimeError("unexpected input")
        return real(folder, **kw)

    monkeypatch.setattr(plugin_check, "check_plugin", flaky)
    code = plugin_check.main(["--json", "--no-tests", str(tmp_path / "set" / "*")])
    doc = json.loads(capsys.readouterr().out)
    by_path = {Path(p["path"]).name: p for p in doc["plugins"]}
    assert code == 1
    assert by_path["good-plugin"]["ok"]
    odd = by_path["odd-plugin"]
    assert not odd["ok"] and "plugin:check itself failed on this plugin" in odd["findings"][0]["message"]
    assert "RuntimeError: unexpected input" in odd["findings"][0]["message"]


# -- the schema stays with manifest.py ---------------------------------------------------------------


def test_schema_covers_every_manifest_field():
    schema = plugin_manifest_schema.build_schema()
    assert schema["x-api-version"] == API_VERSION
    assert set(schema["$defs"]["StudyKind"]["properties"]) >= {"key", "title", "icon", "workspace", "schema_version", "links_geometry"}


def test_schema_fails_loudly_on_a_new_manifest_field(monkeypatch: pytest.MonkeyPatch):
    import dataclasses

    from cfddesk.registry import manifest as manifest_mod

    @dataclasses.dataclass(frozen=True)
    class StudyKind(manifest_mod.StudyKind):
        brand_new: str = ""

    monkeypatch.setitem(plugin_manifest_schema.ARRAY_TABLES, "StudyKind", (StudyKind, ("key", "title"), plugin_manifest_schema.ARRAY_TABLES["StudyKind"][2]))
    with pytest.raises(plugin_manifest_schema.SchemaDriftError, match="brand_new"):
        plugin_manifest_schema.build_schema()


# -- what ships, and the core's test plugins ------------------------------------------------------------

# Test plugins that break a rule on purpose (what each is for), and the rule.
EXPECTED_FAILURES = {
    "python/tests/fixtures/plugins/ui-folder-name": {"key"},  # a key that is not its folder's name
    "python/tests/fixtures/workspace-plugins/ws-demo": {"workspace"},  # silent.html never connects (the timeout test)
}
# Findings in shipped plugins that their owners fix; the test fails once one is fixed,
# so this list only ever shrinks.
# (CAD's ARCHITECTURE.md copy finding is fixed: none is open.)
KNOWN_OPEN: dict[str, set[str]] = {}


def _plugin_folders() -> list[Path]:
    out = sorted(p for p in (WEB_ROOT / "bundled-plugins").iterdir() if (p / "manifest.toml").is_file())
    for parent in sorted((WEB_ROOT / "python" / "tests" / "fixtures").glob("*plugins*")):
        out += sorted(p for p in parent.iterdir() if (p / "manifest.toml").is_file())
    return out


@pytest.mark.slow
def test_shipped_and_test_plugins_pass_but_for_the_named_ones():
    """gate:h16-check-plugins (their own tests run in their suites: --no-tests here)."""
    failing: dict[str, set[str]] = {}
    for folder in _plugin_folders():
        report = plugin_check.check_plugin(folder, run_tests=False)
        rel = folder.relative_to(WEB_ROOT).as_posix()
        failed = {cid for cid, status in report.checks.items() if status == "fail"}
        if failed:
            failing[rel] = failed
    expected = {**EXPECTED_FAILURES, **KNOWN_OPEN}
    assert failing == expected, json.dumps({k: sorted(v) for k, v in failing.items()}, indent=1)
