#!/usr/bin/env python3
"""Plugin boundary check (CI job ``plugin-boundary``).

1. The core never imports a bundled plugin's modules.
2. Plugins import only ``magnusim_sdk``, ``cfddesk.registry`` and the standard
   library at module level, plus their own modules; numpy only inside a
   function (imported when used, so registering the plugin stays light).

Checked plugins: every folder in ``bundled-plugins/``, the fixture plugins in
``python/tests/fixtures/plugins/`` (the stub analysis among them) and the
plugin template. There are no exceptions: Incompressible Flow's code lives in
its plugin (H9).

Folders not read (vendored tools, environments, build output):

- at any depth: ``node_modules``, ``__pycache__``, ``site-packages``,
  ``tests``, any folder whose name starts with ``.`` (``.venv``, ``.git``,
  caches), any ``*.egg-info`` folder and any folder holding a ``pyvenv.cfg``
  (a virtualenv under any name);
- at the plugin root only: ``build`` and ``dist``;
- symlinked folders (not followed). A junction is followed, but a folder
  reached twice is read once.

Everything else is read, ``.py`` and ``.pyw`` files (``workspace/``, ``src/``,
a ``build`` subpackage deeper down). Skipping cannot hide code:

- an import that reaches a skipped folder at any depth is a problem
  (``import pkg.node_modules.x``, ``from pkg import tests``,
  ``from .sub.node_modules import y``). A folder with no ``__init__`` named after a
  standard library module (``venv/`` from ``python -m venv venv``) loses to
  that module, so ``import venv`` is fine;
- an import that loads a compiled extension module (``.pyd``, ``.so``) from
  the plugin is a problem. Native files nothing imports are not;
- ``.pyc``/``.pyo`` files outside ``__pycache__`` are a problem, and so are
  unchecked-hash ``.pyc`` files in it (Python runs those without looking at
  the source);
- a top-level folder counts as the plugin's own module only when it is a
  package (it holds an ``__init__``); Python may import an installed package
  of the same name instead of a plain folder.

A file Python cannot parse is a problem, not a crash. The report lists the
folders skipped per plugin, relative to the plugin, under ``skipped``.

CLI: tools/plugin_boundary.py [--web-root PATH]. Prints a JSON report; exit 1 on a violation.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import sys
import warnings
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parents[2]

ALLOWED = ("magnusim_sdk", "cfddesk.registry")
LAZY_ONLY = ("numpy",)

SKIP_ANY_DEPTH = frozenset({"node_modules", "__pycache__", "site-packages", "tests"})
SKIP_AT_ROOT = frozenset({"build", "dist"})

SOURCES = (".py", ".pyw")
BYTECODE = (".pyc", ".pyo")
EXTENSIONS = (".pyd", ".so")

# (module, at_module_level, line, level, names taken from the module)
ImportRow = tuple[str, bool, int, int, tuple[str, ...]]


def _stdlib() -> set[str]:
    names = set(getattr(sys, "stdlib_module_names", ()))
    return names | {"__future__"}


def _imports(path: Path) -> list[ImportRow]:
    """(module, at_module_level, line, level, names) for every import in ``path``.

    level > 0 is a relative import; ``from . import a`` gives ``("a", ..., 1, ())``.
    names are what ``from x import ...`` takes from ``x``; each may be a submodule.
    """
    with warnings.catch_warnings():
        # A bad escape in a string is not a boundary problem.
        warnings.simplefilter("ignore")
        # Bytes, so Python applies a BOM or coding cookie itself.
        tree = ast.parse(path.read_bytes(), filename=str(path))
    out: list[ImportRow] = []
    # A loop, not recursion: a long generated expression must not overflow the stack.
    stack: list[tuple[ast.AST, bool]] = [(tree, True)]
    while stack:
        node, top = stack.pop()
        if isinstance(node, ast.Import):
            out.extend((alias.name, top, node.lineno, 0, ()) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            level = node.level or 0
            names = tuple(alias.name for alias in node.names if alias.name != "*")
            if node.module:
                out.append((node.module, top, node.lineno, level, names))
            else:
                out.extend((name, top, node.lineno, level, ()) for name in names)
        # Reversed, so rows come out in source order.
        for child in reversed(list(ast.iter_child_nodes(node))):
            nested = isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda))
            stack.append((child, top and not nested))
    return out


def _read_imports(py: Path, problems: list[dict[str, object]]) -> list[ImportRow]:
    """``_imports(py)``, or none plus a problem row when ``py`` cannot be parsed."""
    try:
        return _imports(py)
    except (SyntaxError, ValueError) as exc:  # ValueError: null bytes
        line = getattr(exc, "lineno", None) or 0
        why = f"not valid Python 3: {exc.msg if isinstance(exc, SyntaxError) else exc}"
    except (MemoryError, RecursionError) as exc:  # the parser's own limits
        line, why = 0, f"too complex for Python to parse ({type(exc).__name__})"
    except OSError as exc:
        line, why = 0, f"could not be read: {exc.strerror or exc}"
    problems.append({"file": str(py), "line": line, "import": "", "problem": why})
    return []


def _under(name: str, prefix: str) -> bool:
    return name == prefix or name.startswith(prefix + ".")


def _skips(folder: Path, at_root: bool) -> bool:
    name = folder.name
    if name in SKIP_ANY_DEPTH or name.startswith(".") or name.endswith(".egg-info"):
        return True
    if at_root and name in SKIP_AT_ROOT:
        return True
    return os.path.islink(folder) or (folder / "pyvenv.cfg").is_file()


def plugin_files(plugin_dir: Path) -> tuple[list[Path], list[Path], list[Path]]:
    """(source files the check reads, folders it skips, bytecode files) under ``plugin_dir``.

    Bytecode is every ``.pyc``/``.pyo`` in a read folder or in a ``__pycache__``
    right inside one.
    """
    files: list[Path] = []
    skipped: list[Path] = []
    bytecode: list[Path] = []
    # Python 3.10 does not report junctions as links, so os.walk follows them;
    # a folder already reached (a junction loop) is not walked again.
    seen = {os.path.realpath(plugin_dir)}
    for top, dirs, names in os.walk(plugin_dir, followlinks=False):
        here = Path(top)
        keep: list[str] = []
        for d in sorted(dirs):
            folder = here / d
            if _skips(folder, at_root=here == plugin_dir):
                skipped.append(folder)
                if d == "__pycache__" and not os.path.islink(folder):
                    bytecode += [p for p in folder.iterdir() if p.name.endswith(BYTECODE) and p.is_file()]
                continue
            real = os.path.realpath(folder)
            if real not in seen:
                seen.add(real)
                keep.append(d)
        dirs[:] = keep
        files += [here / n for n in names if n.endswith(SOURCES)]
        bytecode += [here / n for n in names if n.endswith(BYTECODE)]
    return sorted(files), skipped, sorted(bytecode)


def _bytecode_problem(pyc: Path) -> str | None:
    if pyc.parent.name != "__pycache__":
        return "compiled Python, which the boundary check cannot read; plugins ship source only"
    try:
        with pyc.open("rb") as f:
            head = f.read(8)
    except OSError as exc:
        return f"could not be read: {exc.strerror or exc}"
    flags = int.from_bytes(head[4:8], "little") if len(head) == 8 else 0
    # PEP 552: bit 0 hash-based, bit 1 check the source.
    if flags & 0b01 and not flags & 0b10:
        return "unchecked-hash bytecode, which Python runs in place of the source the boundary check reads; delete it"
    return None


def _extension(folder: Path, name: str) -> Path | None:
    """The extension module file for ``name`` in ``folder`` (``name.pyd``, ``name.abi3.so`` ...), if any."""
    for p in sorted(folder.glob(f"{name}.*")):
        rest = p.name[len(name):]
        if p.name.startswith(name + ".") and rest.endswith(EXTENSIONS) and rest.count(".") <= 2 and p.is_file():
            return p
    return None


def _package(folder: Path) -> bool:
    """Whether ``folder`` is a regular package (it holds an ``__init__``)."""
    inits = [folder / f"__init__{suffix}" for suffix in (*SOURCES, ".pyc")]
    return any(p.is_file() for p in inits) or _extension(folder, "__init__") is not None


def _reaches(base: Path, parts: list[str], hidden: set[Path]) -> Path | None:
    """The skipped folder or extension module that importing ``parts`` from ``base`` loads, if any."""
    here = base
    for part in parts:
        target = here / part
        found = target if target in hidden else _extension(here, part)
        if found is None and target.is_dir():
            found = _extension(target, "__init__")
        if found is not None:
            return found
        if not target.is_dir():
            return None
        here = target
    return None


def _unread_import(
    plugin_dir: Path, py: Path, row: ImportRow, hidden: set[Path], stdlib: set[str]
) -> tuple[str, str] | None:
    """(import as written, problem) when ``row`` loads plugin code the check does not read."""
    mod, _top, _line, level, names = row
    base = py.parent if level else plugin_dir
    for _ in range(level - 1):
        base = base.parent
    if base != plugin_dir and plugin_dir not in base.parents:
        return None
    parts = mod.split(".")
    for dotted in [parts] + [parts + [n] for n in names]:
        first = plugin_dir / dotted[0]
        if not level and dotted[0] in stdlib and first in hidden and not _package(first):
            continue  # a folder with no __init__ loses to the standard library module
        found = _reaches(base, dotted, hidden)
        if found is None:
            continue
        shown = "." * level + ".".join(dotted)
        where = found.relative_to(plugin_dir).as_posix()
        if found in hidden:
            return shown, f"{shown} is in {where}/, which the boundary check does not read; plugin code must not import from it"
        return shown, f"{shown} loads {where}, a compiled extension module the boundary check cannot read"
    return None


def _own_modules(plugin_dir: Path, hidden: set[Path]) -> set[str]:
    """Top-level source files and packages; skipped folders are not the plugin's own."""
    own: set[str] = set()
    for p in plugin_dir.iterdir():
        if p.is_file() and p.name.endswith(SOURCES):
            own.add(p.stem)
        elif p.is_dir() and p not in hidden and _package(p):
            own.add(p.name)
    return own


def check_plugin(plugin_dir: Path, key: str) -> tuple[list[dict[str, object]], list[str]]:
    """Problems in one plugin, and the folders the check skipped (relative to the plugin)."""
    stdlib = _stdlib()
    files, skipped, bytecode = plugin_files(plugin_dir)
    hidden = set(skipped)
    own = _own_modules(plugin_dir, hidden)
    problems: list[dict[str, object]] = []
    for py in files:
        for row in _read_imports(py, problems):
            mod, top, line, level, _names = row
            unread = _unread_import(plugin_dir, py, row, hidden, stdlib)
            if unread:
                problems.append({"file": str(py), "line": line, "import": unread[0], "problem": unread[1]})
                continue
            if level:
                continue
            root = mod.split(".")[0]
            if root in stdlib or root in own:
                continue
            if any(_under(mod, a) for a in ALLOWED):
                continue
            if any(_under(mod, lazy) for lazy in LAZY_ONLY):
                if not top:
                    continue
                why = f"{mod} must be imported inside the function that uses it"
            elif (plugin_dir / root).is_dir():
                why = f"{root}/ has no __init__.py, so import {mod} may load a {root} installed elsewhere; add {root}/__init__.py"
            else:
                why = f"plugins may import only magnusim_sdk, cfddesk.registry and the standard library, not {mod}"
            problems.append({"file": str(py), "line": line, "import": mod, "problem": why})
    for pyc in bytecode:
        why = _bytecode_problem(pyc)
        if why:
            problems.append({"file": str(pyc), "line": 0, "import": "", "problem": why})
    return problems, sorted(d.relative_to(plugin_dir).as_posix() for d in skipped)


def check_core(core_dirs: list[Path], bundled_names: set[str]) -> list[dict[str, object]]:
    problems: list[dict[str, object]] = []
    banned = {n for n in bundled_names} | {"cfddesk._bundled"}
    for folder in core_dirs:
        for py in sorted(folder.rglob("*.py")):
            if "__pycache__" in py.parts:
                continue
            for mod, _top, line, level, _names in _read_imports(py, problems):
                if not level and any(_under(mod, b) for b in banned):
                    problems.append(
                        {"file": str(py), "line": line, "import": mod, "problem": "the core imports a bundled plugin"}
                    )
    return problems


def _plugin_key(plugin_dir: Path) -> str:
    manifest = plugin_dir / "manifest.toml"
    if manifest.is_file():
        for raw in manifest.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line.startswith("key") and "=" in line:
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return plugin_dir.name


def run(web_root: Path) -> dict[str, object]:
    bundled = web_root / "bundled-plugins"
    plugin_dirs: list[Path] = []
    for parent in (bundled, web_root / "python" / "tests" / "fixtures" / "plugins"):
        if parent.is_dir():
            plugin_dirs += [d for d in sorted(parent.iterdir()) if (d / "plugin.py").is_file()]
    template = web_root / "templates" / "plugin"
    if template.is_dir():
        plugin_dirs.append(template)
    problems: list[dict[str, object]] = []
    skipped: dict[str, list[str]] = {}
    for d in plugin_dirs:
        found, folders = check_plugin(d, _plugin_key(d))
        problems += found
        skipped[d.relative_to(web_root).as_posix()] = folders
    bundled_names: set[str] = set()
    if bundled.is_dir():
        for d in bundled.iterdir():
            if d.is_dir():
                bundled_names.add(d.name)
                bundled_names |= {p.stem for p in d.glob("*.py") if p.stem != "plugin"}
    problems += check_core([web_root / "python" / "cfddesk", web_root / "python" / "tools"], bundled_names)
    return {
        "ok": not problems,
        "plugins": [d.relative_to(web_root).as_posix() for d in plugin_dirs],
        "skipped": skipped,
        "problems": problems,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Check the plugin import boundary.")
    p.add_argument("--web-root", type=Path, default=WEB_ROOT)
    args = p.parse_args(argv)
    report = run(args.web_root)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
