"""Host API 1.8: a plugin may import another plugin's ``exports`` when it requires that plugin."""

from __future__ import annotations

from pathlib import Path

import plugin_boundary


def _web(tmp_path: Path) -> Path:
    web = tmp_path / "web"
    (web / "python" / "cfddesk").mkdir(parents=True)
    (web / "python" / "tools").mkdir(parents=True)
    (web / "bundled-plugins").mkdir()
    return web


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _flow(web: Path, exports: str = '["flow.bcs"]') -> Path:
    """A plugin 'flow' with a package 'flow' that exports flow.bcs (and keeps flow.writer private)."""
    d = web / "bundled-plugins" / "flow"
    _write(d / "manifest.toml", f'key = "flow"\nexports = {exports}\n')
    _write(d / "plugin.py", "from flow import bcs\n")
    _write(d / "flow" / "__init__.py", "")
    _write(d / "flow" / "bcs.py", "from flow import writer\n")
    _write(d / "flow" / "writer.py", "")
    return d


def _heat(web: Path, body: str, requires: str = 'requires_plugins = ["flow>=1.1"]\n') -> Path:
    d = web / "bundled-plugins" / "heat"
    _write(d / "manifest.toml", f'key = "heat"\n{requires}')
    _write(d / "plugin.py", "import heat.writer\n")
    _write(d / "heat" / "__init__.py", "")
    _write(d / "heat" / "writer.py", body)
    return d


def _problems(web: Path) -> list[dict[str, object]]:
    report = plugin_boundary.run(web)
    return list(report["problems"])  # type: ignore[arg-type]


def test_a_plugin_that_requires_the_exporter_may_import_its_export(tmp_path: Path) -> None:
    web = _web(tmp_path)
    _flow(web)
    _heat(
        web,
        "import flow.bcs\nfrom flow.bcs import x\nfrom flow import bcs\nimport flow.bcs as fb\n",
    )
    assert _problems(web) == []


def test_without_requires_plugins_the_import_is_refused_with_the_fix(tmp_path: Path) -> None:
    web = _web(tmp_path)
    _flow(web)
    _heat(web, "from flow.bcs import x\n", requires="")
    [p] = _problems(web)
    assert p["import"] == "flow.bcs"
    assert "exported by the plugin flow: list it in requires_plugins" in str(p["problem"])


def test_a_module_the_exporter_does_not_export_stays_private(tmp_path: Path) -> None:
    web = _web(tmp_path)
    _flow(web)
    _heat(web, "from flow.writer import y\nfrom flow import writer, bcs\nimport flow\n")
    problems = _problems(web)
    assert [p["import"] for p in problems] == ["flow.writer", "flow", "flow"]
    assert all("plugins may import only" in str(p["problem"]) for p in problems)


def test_bad_exports_are_the_exporters_problem_and_export_nothing(tmp_path: Path) -> None:
    web = _web(tmp_path)
    _flow(web, exports='["flow", "other.bcs", "flow.gone", "flow.bcs"]')
    _heat(web, "from flow.bcs import x\n")
    problems = _problems(web)
    whys = sorted(str(p["problem"]) for p in problems if str(p["file"]).endswith("manifest.toml"))
    assert whys == [
        "exports: 'flow' is not a module of a package (write it as package.module)",
        "exports: 'flow.gone' has no file (flow/gone.py)",
        "exports: 'other.bcs' is not under one of this plugin's own packages",
    ]
    # A plugin whose exports are wrong exports nothing until they are fixed.
    assert [p["import"] for p in problems if str(p["file"]).endswith("writer.py")] == ["flow.bcs"]


def test_check_plugin_alone_finds_the_exports_of_the_apps_bundled_plugins(tmp_path: Path) -> None:
    """plugin:check runs on one folder: the exports come from bundled-plugins/ and the siblings."""
    web = _web(tmp_path)
    _flow(web)
    user = _write(tmp_path / "user" / "heat" / "manifest.toml", 'key = "heat"\nrequires_plugins = ["flow"]\n').parent
    _write(user / "plugin.py", "from flow.bcs import x\n")
    problems, _skipped = plugin_boundary.check_plugin(user, "heat", web_root=web)
    assert problems == []
