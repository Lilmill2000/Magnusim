"""G12: the plugin boundary check skips vendored folders, and they cannot hide plugin code."""

from __future__ import annotations

import importlib.util
import json
import os
import py_compile
import sys
from pathlib import Path

import plugin_boundary
import pytest

GOOD = "import json\nfrom magnusim_sdk.foam import foam_header\nfrom cfddesk.registry.contract import AnalysisFamily\n"
HIDDEN = "which the boundary check does not read; plugin code must not import from it"
NOT_ALLOWED = "plugins may import only magnusim_sdk, cfddesk.registry and the standard library, not requests"
EXTENSION = "a compiled extension module the boundary check cannot read"


def _web(tmp_path: Path) -> Path:
    web = tmp_path / "web"
    (web / "python" / "cfddesk").mkdir(parents=True)
    (web / "python" / "tools").mkdir(parents=True)
    (web / "bundled-plugins").mkdir()
    return web


def _plugin(parent: Path, name: str, body: str) -> Path:
    d = parent / name
    d.mkdir(parents=True)
    (d / "manifest.toml").write_text(f'key = "{name}"\n', encoding="utf-8")
    (d / "plugin.py").write_text(body, encoding="utf-8")
    return d


def _write(path: Path, text: str | bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, bytes):
        path.write_bytes(text)
    else:
        path.write_text(text, encoding="utf-8")
    return path


def _vendored(plugin: Path) -> None:
    """A JS toolchain (Python 2 files), a virtualenv under two names, build output, packaging metadata."""
    _write(plugin / "node_modules" / "node-gyp" / "gyp" / "pylib" / "gyp" / "__init__.py", 'print "x"\n')
    _write(plugin / ".venv" / "Lib" / "site-packages" / "requests" / "__init__.py", "import urllib3\n")
    _write(plugin / "env" / "pyvenv.cfg", "home = /usr/bin\n")
    _write(plugin / "env" / "x.py", "import requests\n")
    _write(plugin / "build" / "lib" / "fine" / "x.py", "import requests\n")
    _write(plugin / "dist" / "y.py", "import requests\n")
    _write(plugin / "fine.egg-info" / "z.py", "import requests\n")


def _fine(tmp_path: Path, body: str = GOOD) -> tuple[Path, Path]:
    web = _web(tmp_path)
    fine = _plugin(web / "bundled-plugins", "fine", body)
    _vendored(fine)
    return web, fine


def _problems(report: dict) -> list[tuple[str, str, str]]:
    return [(Path(p["file"]).name, p["import"], p["problem"]) for p in report["problems"]]


def test_vendored_folders_are_skipped_and_listed(tmp_path: Path):
    web, _fine_dir = _fine(tmp_path)
    report = plugin_boundary.run(web)
    assert report["ok"], report["problems"]
    assert report["skipped"]["bundled-plugins/fine"] == [
        ".venv", "build", "dist", "env", "fine.egg-info", "node_modules"
    ]


def test_vendored_folders_are_skipped_at_any_depth(tmp_path: Path):
    web, fine = _fine(tmp_path)
    pkg = fine / "pkg"
    _write(pkg / "__init__.py", GOOD)
    for folder in ("node_modules", "__pycache__", "site-packages", "tests", ".cache", "pkg.egg-info"):
        _write(pkg / folder / "a.py", "import requests\n")
    _write(pkg / "venv2" / "pyvenv.cfg", "home = /usr/bin\n")
    _write(pkg / "venv2" / "a.py", "import requests\n")
    report = plugin_boundary.run(web)
    assert report["ok"], report["problems"]
    assert "pkg" not in report["skipped"]["bundled-plugins/fine"]
    assert {
        "pkg/node_modules", "pkg/__pycache__", "pkg/site-packages", "pkg/tests", "pkg/.cache", "pkg/pkg.egg-info",
        "pkg/venv2",
    } <= set(report["skipped"]["bundled-plugins/fine"])


@pytest.mark.parametrize(
    ("body", "shown", "where"),
    [
        ("from node_modules.x import y\n", "node_modules.x", "node_modules"),
        ("import build.lib\n", "build.lib", "build"),
        ("import dist\n", "dist", "dist"),
        ("import env\n", "env", "env"),
        ("from .node_modules import z\n", ".node_modules", "node_modules"),
        ("from . import build\n", ".build", "build"),
    ],
)
def test_a_skipped_folder_cannot_hide_plugin_code(tmp_path: Path, body: str, shown: str, where: str):
    web, _fine_dir = _fine(tmp_path, GOOD + body)
    report = plugin_boundary.run(web)
    assert _problems(report) == [("plugin.py", shown, f"{shown} is in {where}/, {HIDDEN}")]


def test_a_relative_import_into_a_skipped_subfolder_is_a_problem(tmp_path: Path):
    web, fine = _fine(tmp_path)
    _write(fine / "pkg" / "__init__.py", "")
    _write(fine / "pkg" / "node_modules" / "z.py", "import requests\n")
    _write(fine / "pkg" / "mod.py", "from .node_modules import z\nfrom ..build import w\n")
    report = plugin_boundary.run(web)
    assert _problems(report) == [
        ("mod.py", ".node_modules", f".node_modules is in pkg/node_modules/, {HIDDEN}"),
        ("mod.py", "..build", f"..build is in build/, {HIDDEN}"),
    ]


def _nested_hiding_places(fine: Path) -> None:
    """Skipped folders inside the plugin's own package, each holding code that imports requests."""
    _write(fine / "pkg" / "__init__.py", "")
    _write(fine / "pkg" / "node_modules" / "__init__.py", "import requests\n")
    _write(fine / "pkg" / "node_modules" / "evil.py", "import requests\nthing = 1\n")
    _write(fine / "pkg" / "tests" / "helper.py", "import requests\n")
    _write(fine / "pkg" / "__pycache__" / "x.py", "import requests\n")
    _write(fine / "pkg" / "impl" / "pyvenv.cfg", "")
    _write(fine / "pkg" / "impl" / "core.py", "import requests\n")


@pytest.mark.parametrize(
    ("body", "shown", "where"),
    [
        ("from pkg.node_modules.evil import thing\n", "pkg.node_modules.evil", "pkg/node_modules"),
        ("import pkg.tests.helper\n", "pkg.tests.helper", "pkg/tests"),
        ("import pkg.__pycache__.x\n", "pkg.__pycache__.x", "pkg/__pycache__"),
        ("from pkg.impl import core\n", "pkg.impl", "pkg/impl"),
        ("from pkg import node_modules\n", "pkg.node_modules", "pkg/node_modules"),
        ("from pkg import json, node_modules\n", "pkg.node_modules", "pkg/node_modules"),
        ("from .pkg.node_modules import evil\n", ".pkg.node_modules", "pkg/node_modules"),
        ("from .pkg import node_modules\n", ".pkg.node_modules", "pkg/node_modules"),
    ],
)
def test_a_skipped_folder_deeper_down_cannot_hide_plugin_code(tmp_path: Path, body: str, shown: str, where: str):
    web, fine = _fine(tmp_path, GOOD + body)
    _nested_hiding_places(fine)
    report = plugin_boundary.run(web)
    assert _problems(report) == [("plugin.py", shown, f"{shown} is in {where}/, {HIDDEN}")]
    assert where in report["skipped"]["bundled-plugins/fine"]


def test_a_dotted_relative_import_into_a_skipped_folder_is_a_problem(tmp_path: Path):
    web, fine = _fine(tmp_path, GOOD + "import pkg\n")
    _write(fine / "pkg" / "__init__.py", "from .sub.node_modules import z\n")
    _write(fine / "pkg" / "sub" / "__init__.py", "")
    _write(fine / "pkg" / "sub" / "node_modules" / "z.py", "import requests\n")
    report = plugin_boundary.run(web)
    assert _problems(report) == [
        ("__init__.py", ".sub.node_modules", f".sub.node_modules is in pkg/sub/node_modules/, {HIDDEN}")
    ]


def test_a_nested_symlinked_folder_cannot_hide_plugin_code(tmp_path: Path):
    web, fine = _fine(tmp_path, GOOD + "from pkg.shared import core\n")
    _write(fine / "pkg" / "__init__.py", "")
    outside = _write(tmp_path / "outside" / "shared" / "core.py", "import requests\n").parent
    try:
        os.symlink(outside, fine / "pkg" / "shared", target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"cannot create a symlink here: {exc}")
    report = plugin_boundary.run(web)
    assert "pkg/shared" in report["skipped"]["bundled-plugins/fine"]
    assert _problems(report) == [("plugin.py", "pkg.shared", f"pkg.shared is in pkg/shared/, {HIDDEN}")]


def test_a_virtualenv_named_after_a_stdlib_module_does_not_block_it(tmp_path: Path):
    """python -m venv venv: venv/ has no __init__.py, so import venv still loads the standard library."""
    web, fine = _fine(tmp_path, GOOD + "import venv\n")
    _write(fine / "venv" / "pyvenv.cfg", "home = /usr/bin\n")
    report = plugin_boundary.run(web)
    assert report["ok"], report["problems"]
    assert "venv" in report["skipped"]["bundled-plugins/fine"]


def test_a_skipped_package_named_after_a_stdlib_module_is_a_problem(tmp_path: Path):
    """With an __init__.py the plugin's venv/ comes first on sys.path, so it is what gets imported."""
    web, fine = _fine(tmp_path, GOOD + "import venv\n")
    _write(fine / "venv" / "pyvenv.cfg", "home = /usr/bin\n")
    _write(fine / "venv" / "__init__.py", "import requests\n")
    report = plugin_boundary.run(web)
    assert _problems(report) == [("plugin.py", "venv", f"venv is in venv/, {HIDDEN}")]


def test_a_folder_without_init_is_not_an_own_module(tmp_path: Path):
    """requests/ with no __init__.py loses to an installed requests, so import requests is not the plugin's own."""
    web, fine = _fine(tmp_path, GOOD + "import requests\nimport mine.util\n")
    _write(fine / "requests" / "README.md", "notes\n")
    _write(fine / "mine" / "__init__.py", "")
    _write(fine / "mine" / "util.py", "import json\n")
    report = plugin_boundary.run(web)
    assert _problems(report) == [
        (
            "plugin.py",
            "requests",
            "requests/ has no __init__.py, so import requests may load a requests installed elsewhere; "
            "add requests/__init__.py",
        )
    ]


def _compile(src: Path, body: str, mode: py_compile.PycInvalidationMode) -> Path:
    """Bytecode for ``body`` where Python looks for ``src``'s cache; ``src`` itself stays clean."""
    evil = _write(src.parent / "_evil_src.py", body)
    cfile = Path(importlib.util.cache_from_source(str(src)))
    py_compile.compile(str(evil), cfile=str(cfile), dfile=str(src), doraise=True, invalidation_mode=mode)
    evil.unlink()
    return cfile


def test_unchecked_bytecode_in_pycache_is_a_problem(tmp_path: Path):
    web, fine = _fine(tmp_path, GOOD + "import mod\nimport ok_checked\nimport ok_stamp\n")
    mode = py_compile.PycInvalidationMode
    unchecked = _compile(_write(fine / "mod.py", "import json\n"), "import requests\n", mode.UNCHECKED_HASH)
    _compile(_write(fine / "ok_checked.py", "import json\n"), "import json\n", mode.CHECKED_HASH)
    _compile(_write(fine / "ok_stamp.py", "import json\n"), "import json\n", mode.TIMESTAMP)
    report = plugin_boundary.run(web)
    assert _problems(report) == [
        (
            unchecked.name,
            "",
            "unchecked-hash bytecode, which Python runs in place of the source the boundary check reads; delete it",
        )
    ]


def test_bytecode_outside_pycache_is_a_problem(tmp_path: Path):
    web, fine = _fine(tmp_path, GOOD + "from pkg import helper\n")
    _write(fine / "pkg" / "__init__.py", "")
    _write(fine / "pkg" / "helper.pyc", b"\x00" * 16)
    _write(fine / "old.pyo", b"\x00" * 16)
    report = plugin_boundary.run(web)
    why = "compiled Python, which the boundary check cannot read; plugins ship source only"
    assert _problems(report) == [("old.pyo", "", why), ("helper.pyc", "", why)]


def test_pyw_files_are_read(tmp_path: Path):
    web, fine = _fine(tmp_path, GOOD + "from pkg import helper\nimport tool\n")
    _write(fine / "pkg" / "__init__.py", "")
    _write(fine / "pkg" / "helper.pyw", "import requests\n")
    _write(fine / "tool.pyw", "import json\n")
    report = plugin_boundary.run(web)
    assert _problems(report) == [("helper.pyw", "requests", NOT_ALLOWED)]


def test_importing_an_extension_module_from_the_plugin_is_a_problem(tmp_path: Path):
    web, fine = _fine(tmp_path, GOOD + "from pkg import fast\nimport native\nimport json\n")
    _write(fine / "pkg" / "__init__.py", "")
    _write(fine / "pkg" / "fast.cp310-win_amd64.pyd", b"MZ")
    _write(fine / "native" / "__init__.abi3.so", b"\x7fELF")
    # Native build output nothing imports is fine (a CAD kernel build, say).
    _write(fine / "kernel-build" / "lib" / "libTKernel.so", b"\x7fELF")
    _write(fine / "wheels" / "helper.pyd", b"MZ")
    report = plugin_boundary.run(web)
    assert _problems(report) == [
        ("plugin.py", "pkg.fast", f"pkg.fast loads pkg/fast.cp310-win_amd64.pyd, {EXTENSION}"),
        ("plugin.py", "native", f"native loads native/__init__.abi3.so, {EXTENSION}"),
    ]


def test_build_and_dist_deeper_down_are_read(tmp_path: Path):
    web, fine = _fine(tmp_path)
    _write(fine / "pkg" / "__init__.py", "")
    _write(fine / "pkg" / "build" / "mod.py", "import requests\n")
    _write(fine / "pkg" / "dist" / "mod.py", "import requests\n")
    report = plugin_boundary.run(web)
    assert [Path(p["file"]).parent.name for p in report["problems"]] == ["build", "dist"]
    assert {p["problem"] for p in report["problems"]} == {NOT_ALLOWED}


@pytest.mark.parametrize("folder", ["workspace", "wheels", "kernel-build", "src"])
def test_other_folders_are_read(tmp_path: Path, folder: str):
    web, fine = _fine(tmp_path)
    _write(fine / folder / "evil.py", "import requests\n")
    report = plugin_boundary.run(web)
    assert _problems(report) == [("evil.py", "requests", NOT_ALLOWED)]
    assert folder not in report["skipped"]["bundled-plugins/fine"]


def test_invalid_python_is_a_problem_not_a_crash(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    web, fine = _fine(tmp_path)
    _write(fine / "py2.py", 'import json\nprint "x"\n')
    _write(fine / "latin.py", b"name = '\xff'\n")
    _write(fine / "nul.py", b"x = 1\x00\n")
    _write(fine / "evil.py", "import requests\n")
    assert plugin_boundary.main(["--web-root", str(web)]) == 1
    report = json.loads(capsys.readouterr().out)
    rows = {Path(p["file"]).name: p for p in report["problems"]}
    assert set(rows) == {"py2.py", "latin.py", "nul.py", "evil.py"}
    for name in ("py2.py", "latin.py", "nul.py"):
        assert rows[name]["import"] == "" and rows[name]["problem"].startswith("not valid Python 3: ")
    assert rows["py2.py"]["line"] == 2
    assert rows["evil.py"]["problem"] == NOT_ALLOWED


def test_invalid_python_in_the_core_is_a_problem_not_a_crash(tmp_path: Path):
    web = _web(tmp_path)
    _write(web / "python" / "cfddesk" / "old.py", 'print "x"\n')
    report = plugin_boundary.run(web)
    assert [p["problem"][:20] for p in report["problems"]] == ["not valid Python 3: "]


def test_a_coding_cookie_is_honoured(tmp_path: Path):
    web, fine = _fine(tmp_path, GOOD + "import names\n")
    _write(fine / "names.py", b"# -*- coding: latin-1 -*-\nimport json\nNAME = 'caf\xe9'\n")
    _write(fine / "bom.py", b"\xef\xbb\xbfimport requests\n")
    report = plugin_boundary.run(web)
    assert _problems(report) == [("bom.py", "requests", NOT_ALLOWED)]


def test_a_deeply_nested_file_is_read_without_overflowing(tmp_path: Path):
    """A generated dispatch table or a long sum is valid Python and nests the AST about 1000 levels deep."""
    elifs = "".join(f"    elif x == {i}:\n        return {i}\n" for i in range(1, 1100))
    table = "def f(x):\n    if x == 0:\n        return 0\n" + elifs + "    import requests\n"
    web, fine = _fine(tmp_path, GOOD + "import dispatch\nimport total\n")
    _write(fine / "dispatch.py", table)
    _write(fine / "total.py", "X = " + "+".join(["1"] * 1200) + "\nimport requests\n")
    report = plugin_boundary.run(web)
    assert _problems(report) == [("dispatch.py", "requests", NOT_ALLOWED), ("total.py", "requests", NOT_ALLOWED)]


@pytest.mark.parametrize("error", [MemoryError, RecursionError])
def test_a_file_too_complex_to_parse_is_a_problem_not_a_crash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error: type[BaseException]
):
    """CPython's parser gives up on some valid files (MemoryError on 10000 elif branches in 3.10)."""
    web, fine = _fine(tmp_path)
    _write(fine / "huge.py", "import json\n")
    real_parse = plugin_boundary.ast.parse

    def parse(source, filename="<unknown>", *args, **kwargs):
        if str(filename).endswith("huge.py"):
            raise error()
        return real_parse(source, filename, *args, **kwargs)

    monkeypatch.setattr(plugin_boundary.ast, "parse", parse)
    report = plugin_boundary.run(web)
    assert _problems(report) == [("huge.py", "", f"too complex for Python to parse ({error.__name__})")]


def _link_dir(link: Path, target: Path) -> None:
    """A junction on Windows (no admin rights needed), a symlink elsewhere."""
    if sys.platform == "win32":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    else:
        os.symlink(target, link, target_is_directory=True)


def test_a_folder_loop_is_read_once(tmp_path: Path):
    web, fine = _fine(tmp_path)
    _write(fine / "pkg" / "__init__.py", "")
    _write(fine / "pkg" / "evil.py", "import requests\n")
    try:
        _link_dir(fine / "pkg" / "loop", fine / "pkg")
    except (OSError, AttributeError, NotImplementedError) as exc:
        pytest.skip(f"cannot link a folder here: {exc}")
    report = plugin_boundary.run(web)
    assert _problems(report) == [("evil.py", "requests", NOT_ALLOWED)]


def test_a_symlinked_folder_is_listed_and_cannot_hide_plugin_code(tmp_path: Path):
    web, fine = _fine(tmp_path, GOOD + "import shared\n")
    outside = _write(tmp_path / "outside" / "shared" / "__init__.py", "import requests\n").parent
    try:
        os.symlink(outside, fine / "shared", target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"cannot create a symlink here: {exc}")
    report = plugin_boundary.run(web)
    assert "shared" in report["skipped"]["bundled-plugins/fine"]
    assert _problems(report) == [("plugin.py", "shared", f"shared is in shared/, {HIDDEN}")]
