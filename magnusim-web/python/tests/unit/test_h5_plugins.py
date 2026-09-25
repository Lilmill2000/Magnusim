"""H5 plugin host: demos, disable, broken register, clean install."""

from __future__ import annotations

import ast
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from cfddesk.registry import get_hub, get_registry, load_all, reset_for_tests
from cfddesk.registry.analysis import DEFAULT_STEADY_KEY
from cfddesk.registry.discovery import plugin_catalog

WEB_ROOT = Path(__file__).resolve().parents[3]
PYTHON_ROOT = WEB_ROOT / "python"
PLUGINS = WEB_ROOT / "plugins"
TEMPLATE = WEB_ROOT / "templates" / "plugin"
TEMPLATE_TEST = TEMPLATE / "tests" / "test_register.py"
DEMOS = ("example-laminar", "example-extra-mesher", "example-hook-monitor")
FORBIDDEN = ("cfddesk.builtin", "scripts", "src.workbench")
FIX = Path(__file__).resolve().parents[1] / "fixtures" / "js-project"


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def _imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.append(node.module)
    return names


def _forbidden(name: str) -> bool:
    return any(name == root or name.startswith(root + ".") for root in FORBIDDEN)


def _copy_demos(web: Path) -> None:
    for name in DEMOS:
        dest = web / "plugins" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(PLUGINS / name, dest)


def test_gate_h5_zero_core_edits_static():
    roots = [PLUGINS / name for name in DEMOS]
    roots.append(TEMPLATE)
    for root in roots:
        for path in root.rglob("*.py"):
            bad = [name for name in _imports(path) if _forbidden(name)]
            assert not bad, f"{path} imports {bad}"


def test_gate_h5_demos_register():
    load_all(force=True)
    laminar = get_registry("analysis").get("laminar_steady")
    assert laminar.label == "Laminar"
    assert laminar.default_turbulence == "laminar"
    assert laminar.write_case is not None
    standard = get_registry("mesher").get("standard")
    extra = get_registry("mesher").get("example_extra_mesher")
    assert extra.label == "Extra mesher"
    assert extra.tool == standard.tool
    assert extra.generate == standard.generate
    extra_fineness = next(field for field in extra.settings_schema if field.key == "fineness")
    standard_fineness = next(field for field in standard.settings_schema if field.key == "fineness")
    assert extra_fineness.default == 3
    assert standard_fineness.default == 5
    assert "example-hook-monitor" not in set(get_registry("analysis").keys())
    rows = {row["key"]: row for row in plugin_catalog()}
    assert rows["example-laminar"]["status"] == "enabled"
    assert rows["example-laminar"]["source"] == "local"
    assert rows["example-hook-monitor"]["ui"] == "ui"
    assert rows["example-hook-monitor"]["authors"] == ["Magnusim"]


def test_gate_h5_hook_monitor_writes_control_dict(tmp_path: Path):
    if not (FIX / "boundary_conditions.json").is_file():
        pytest.skip("js-project fixture missing")
    from cfddesk.project.web_adapter import load_run_spec
    from cfddesk.registry import write_run_case

    load_all(force=True)
    spec = load_run_spec(FIX, run_id="run-h5-hook", require_mesh=False, n_procs=1)
    assert spec.ok, spec.error
    out = tmp_path / "case"
    result = write_run_case(spec, out)
    assert result.get("ok") is True
    text = (out / "system" / "controlDict").read_text(encoding="utf-8")
    assert "exampleHookMonitor" in text


def test_gate_h5_folder_install(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    web = tmp_path / "web"
    _copy_demos(web)
    local = tmp_path / "local.json"
    local.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(local))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(local))
    load_all(web_root=web, force=True)
    assert "laminar_steady" in get_registry("analysis").keys()
    assert "example_extra_mesher" in get_registry("mesher").keys()
    assert DEFAULT_STEADY_KEY in get_registry("analysis").keys()


def test_gate_h5_disable_removes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    web = tmp_path / "web"
    _copy_demos(web)
    local = tmp_path / "local.json"
    local.write_text(
        json.dumps({"plugins": {"disabled": ["example-laminar", "example-extra-mesher"]}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(local))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(local))
    load_all(web_root=web, force=True)
    assert "laminar_steady" not in get_registry("analysis").keys()
    assert "example_extra_mesher" not in get_registry("mesher").keys()
    assert DEFAULT_STEADY_KEY in get_registry("analysis").keys()
    rows = {row["key"]: row for row in plugin_catalog(web)}
    assert rows["example-laminar"]["status"] == "disabled"
    assert rows["example-extra-mesher"]["status"] == "disabled"
    assert rows["example-laminar"]["enabled"] is False


def test_gate_h5_broken_register_is_listed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    plugins = tmp_path / "plugins" / "broken-register"
    plugins.mkdir(parents=True)
    (plugins / "manifest.toml").write_text(
        'key = "broken-register"\nname = "Broken"\nversion = "0.0.1"\napi_version = "1.0"\n',
        encoding="utf-8",
    )
    (plugins / "plugin.py").write_text("raise RuntimeError('register failed')\n", encoding="utf-8")
    local = tmp_path / "local.json"
    local.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(local))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(local))
    load_all(web_root=tmp_path, force=True)
    rows = {row["key"]: row for row in plugin_catalog(tmp_path)}
    assert rows["broken-register"]["status"] == "error"
    assert "register failed" in rows["broken-register"]["error"]
    assert DEFAULT_STEADY_KEY in get_registry("analysis").keys()
    assert get_hub().manifests.get("broken-register") is None


def test_gate_h5_incompatible_is_listed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    plugins = tmp_path / "plugins" / "future-plug"
    plugins.mkdir(parents=True)
    (plugins / "manifest.toml").write_text(
        'key = "future-plug"\nname = "Future"\nversion = "9.0.0"\napi_version = "9.0"\n',
        encoding="utf-8",
    )
    (plugins / "plugin.py").write_text(
        "def register(hub):\n    raise AssertionError('incompatible plugin must not register')\n",
        encoding="utf-8",
    )
    local = tmp_path / "local.json"
    local.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(local))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(local))
    load_all(web_root=tmp_path, force=True)
    rows = {row["key"]: row for row in plugin_catalog(tmp_path)}
    assert rows["future-plug"]["status"] == "incompatible"
    assert rows["future-plug"]["enabled"] is False


def test_gate_h5_authoring():
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", str(TEMPLATE_TEST), "-q", "--tb=short"],
        cwd=str(PYTHON_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_gate_h5_zero_core_wheel(tmp_path: Path):
    wheel_dir = tmp_path / "wheels"
    wheel_dir.mkdir()
    built = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            "--no-deps",
            "--no-build-isolation",
            "-w",
            str(wheel_dir),
            str(PYTHON_ROOT),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    assert built.returncode == 0, built.stderr or built.stdout
    wheels = list(wheel_dir.glob("cfddesk-*.whl"))
    assert wheels, "cfddesk wheel was not built"
    site = tmp_path / "wheel-site"
    site.mkdir()
    installed = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-deps",
            "--upgrade",
            "--target",
            str(site),
            str(wheels[0]),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    assert installed.returncode == 0, installed.stderr or installed.stdout
    web = tmp_path / "web"
    _copy_demos(web)
    runner = tmp_path / "run_demos.py"
    runner.write_text(
        "\n".join(
            [
                "import ast, sys",
                "from pathlib import Path",
                "import cfddesk",
                "origin = Path(cfddesk.__file__).resolve()",
                "root = Path(sys.argv[2]).resolve()",
                "if root not in origin.parents:",
                "    raise SystemExit('cfddesk did not come from the wheel: ' + str(origin))",
                "web = Path(sys.argv[1])",
                "roots = ('cfddesk.builtin', 'scripts', 'src.workbench')",
                "def forbidden(name):",
                "    return any(name == root or name.startswith(root + '.') for root in roots)",
                "for path in (web / 'plugins').rglob('*.py'):",
                "    tree = ast.parse(path.read_text(encoding='utf-8'))",
                "    names = []",
                "    for node in ast.walk(tree):",
                "        if isinstance(node, ast.Import):",
                "            names.extend(alias.name for alias in node.names)",
                "        elif isinstance(node, ast.ImportFrom) and node.module:",
                "            names.append(node.module)",
                "    bad = [name for name in names if forbidden(name)]",
                "    if bad:",
                "        raise SystemExit(f'{path} imports {bad}')",
                "from cfddesk.registry import get_registry, load_all, reset_for_tests",
                "reset_for_tests()",
                "load_all(web_root=web, force=True)",
                "assert 'laminar_steady' in get_registry('analysis').keys()",
                "assert 'example_extra_mesher' in get_registry('mesher').keys()",
                "print('ok')",
                "",
            ]
        ),
        encoding="utf-8",
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = str(site)
    proc = subprocess.run(
        [sys.executable, str(runner), str(web), str(site)],
        capture_output=True,
        text=True,
        check=False,
        env=env,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
