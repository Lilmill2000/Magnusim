#!/usr/bin/env python3
"""Plugin boundary check (CI job ``plugin-boundary``).

1. The core never imports a bundled plugin's modules.
2. Plugins import only ``magnusim_sdk``, ``cfddesk.registry`` and the standard
   library at module level, plus their own modules; numpy only inside a
   function (imported when used, so registering the plugin stays light).
3. A plugin with a ``[python]`` environment may also import the packages its
   own lock pins, in code that runs on that environment: its service module,
   its job tools registered with ``python="plugin"`` and the plugin modules that
   only those import. Code the host loads (plugin.py, what it imports, job
   tools that run on the core's Python) keeps rule 2.

``importlib.import_module("x")`` and ``__import__("x")`` (called by that name,
an ``as`` alias, ``from importlib import *``, or as ``<anything>.import_module``
/ ``.__import__``) count as ``import x``. A relative name is read the way
Python reads it: ``import_module`` against its ``package`` argument (a string,
or ``__package__``), ``__import__`` against the file's own package (its globals
absent or ``globals()``). In plugin code these are problems, because the check
cannot tell what they load: such a call whose module name, package, level,
globals or fromlist is not written out; the import functions used other than
as a direct call (assigned, passed, ``getattr(importlib, "import_module")``);
``exec``, ``eval`` and ``compile``; ``runpy``'s ``run_module``/``run_path``;
and a loader's ``exec_module``/``load_module``.

Relative imports are read against the package Python runs the file in. The host
loads plugin.py as ``cfddesk._bundled.<folder>``, so any relative import there
reaches the core's package (or another plugin): a problem. Elsewhere one that
climbs above the plugin's top-level package is a problem. ``from pkg import *``
loads the submodules ``pkg.__all__`` names (every submodule, when ``__all__`` is
not a literal list).

Environment code is found without loading the plugin: the manifest's
``[python] service`` module, and the job tools of the ``JobKind(...)`` calls in
the code the host loads. Code the host loads starts at plugin.py and includes
every log parser module a ``LogParserRef`` names (the core imports it on its
own Python). A tool path is read from the plugin folder, else from the folder
of the file that names it; a tool on the core's Python is every file whose path
ends with it. The check places a job only when its ``JobKind(...)`` goes straight
into ``hub.register_job(...)`` with its tool and ``python=`` written out, and a
log parser only when its module is written out. When anything in host code
registers a job or names a log parser some other way (a variable, a loop,
``dataclasses.replace``, an alias of ``JobKind``, ``setattr``), no file counts
as environment code: everything is held to rule 2.

The import names of a pinned distribution come from the plugin's environment
when it is built for this lock (``.cache/plugin-envs/<key>-<lock hash>``, or
``MAGNUSIM_PLUGIN_ENVS_DIR``): each ``*.dist-info``'s ``top_level.txt`` and
``RECORD``. Otherwise from ``IMPORT_NAMES`` (below) plus the distribution's
own name, normalized (``AeroSandbox`` -> ``aerosandbox``). A lock never
provides ``cfddesk``.

Checked plugins: every folder in ``bundled-plugins/``, the core's fixture
plugins in ``python/tests/fixtures/`` (``plugins/`` with the stub analysis
among them, ``workspace-plugins/``, ``env-plugins/`` and ``optional-plugins/``)
and the plugin template. There are no exceptions: Incompressible Flow's code
lives in its plugin (H9).

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
import csv
import hashlib
import json
import os
import posixpath
import re
import sys
import warnings
from pathlib import Path
from typing import Any

WEB_ROOT = Path(__file__).resolve().parents[2]

ALLOWED = ("magnusim_sdk", "cfddesk.registry")
LAZY_ONLY = ("numpy",)
# The host's own package: no plugin's lock provides it, whatever the lock says.
NEVER_FROM_A_LOCK = ("cfddesk",)

# Distributions whose import names are not their own names (keys PEP 503 normalized).
# Used when the plugin's environment is not built here; the normalized name always
# counts too. When the environment is built, its installed files say.
IMPORT_NAMES: dict[str, tuple[str, ...]] = {
    "attrs": ("attr", "attrs"),
    "beautifulsoup4": ("bs4",),
    "cadquery-ocp": ("OCP",),
    "fonttools": ("fontTools",),
    "matplotlib": ("matplotlib", "mpl_toolkits", "pylab"),
    "msgpack-python": ("msgpack",),
    "opencv-contrib-python": ("cv2",),
    "opencv-contrib-python-headless": ("cv2",),
    "opencv-python": ("cv2",),
    "opencv-python-headless": ("cv2",),
    "pillow": ("PIL",),
    "protobuf": ("google.protobuf",),
    "pycryptodome": ("Crypto",),
    "pyjwt": ("jwt",),
    "pymupdf": ("fitz", "pymupdf"),
    "pyqt5": ("PyQt5",),
    "pyqt6": ("PyQt6",),
    "pyserial": ("serial",),
    "pyside6": ("PySide6",),
    "python-dateutil": ("dateutil",),
    "pywin32": ("win32api", "win32con", "win32gui", "win32com", "pythoncom", "pywintypes"),
    "pyyaml": ("yaml",),
    "pyzmq": ("zmq",),
    "ruamel-yaml": ("ruamel.yaml",),
    "scikit-image": ("skimage",),
    "scikit-learn": ("sklearn",),
    "setuptools": ("setuptools", "pkg_resources", "_distutils_hack"),
    "vtk": ("vtk", "vtkmodules"),
}

# python/cfddesk/registry/plugin_env.py: <envs>/<key>-<lock hash>/, ready when its stamp names the hash.
ENV_STAMP = "magnusim-env.json"
LOCK_HASH_LEN = 16

SKIP_ANY_DEPTH = frozenset({"node_modules", "__pycache__", "site-packages", "tests"})
SKIP_AT_ROOT = frozenset({"build", "dist"})

# The core's test fixture plugins (under python/tests/fixtures/), held to the same rules.
FIXTURE_PLUGIN_FOLDERS = (
    "plugins",
    "workspace-plugins",
    "env-plugins",
    "optional-plugins",
    "kit-plugins",
    "foam-plugins",
    "hook-plugins",
    "flood-plugins",
)

SOURCES = (".py", ".pyw")
BYTECODE = (".pyc", ".pyo")
EXTENSIONS = (".pyd", ".so")

# (module, at_module_level, line, level, names taken from the module, how, unread): how is
# "" for an import statement, else the call as written ("importlib.import_module",
# "__import__"). names may hold "*". Module "" with level > 0 is the package the file is
# in (``from . import *``); module "" with level 0 is code the check cannot read, and
# unread says why (it is "" on every other row).
ImportRow = tuple[str, bool, int, int, tuple[str, ...], str, str]

DYNAMIC = ("import_module", "__import__")
# Calls that run code the check cannot read: builtins, runpy's, and a module loader's.
RUNS_CODE = ("exec", "eval", "compile")
RUNPY = ("run_module", "run_path")
LOADERS = ("exec_module", "load_module")
CANNOT_READ = "the check cannot read"
# The host loads plugin.py as cfddesk._bundled.<folder> (cfddesk._plugins.<folder> when installed).
PLUGIN_PY_PACKAGE = "cfddesk._bundled"


def _stdlib() -> set[str]:
    names = set(getattr(sys, "stdlib_module_names", ()))
    return names | {"__future__"}


def _parse(path: Path) -> ast.Module:
    with warnings.catch_warnings():
        # A bad escape in a string is not a boundary problem.
        warnings.simplefilter("ignore")
        # Bytes, so Python applies a BOM or coding cookie itself.
        return ast.parse(path.read_bytes(), filename=str(path))


def dynamic_aliases(tree: ast.AST) -> dict[str, str]:
    """Plain names that call an import function in this file: ``{name: "import_module" | "__import__"}``.

    ``__import__`` itself, and what ``from importlib import import_module as im``,
    ``from builtins import __import__ as imp`` or ``from importlib import *`` (its
    ``__all__`` holds both) binds.
    """
    out = {"__import__": "__import__"}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module in ("importlib", "builtins") and not node.level:
            for alias in node.names:
                if alias.name in DYNAMIC:
                    out[alias.asname or alias.name] = alias.name
                elif alias.name == "*" and node.module == "importlib":
                    out["import_module"] = "import_module"
    return out


def _literal(node: ast.AST | None) -> str | None:
    """A string the code spells out: a literal, literals joined with +, an f-string of literals."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _literal(node.left), _literal(node.right)
        return left + right if left is not None and right is not None else None
    if isinstance(node, ast.JoinedStr):
        parts = [_literal(v) for v in node.values]
        return "".join(p for p in parts if p is not None) if all(p is not None for p in parts) else None
    return None


def _arg(call: ast.Call, index: int, name: str) -> ast.AST | None:
    if len(call.args) > index:
        return call.args[index]
    return next((kw.value for kw in call.keywords if kw.arg == name), None)


def resolve_name(name: str, package: str) -> str | None:
    """importlib.util.resolve_name as string arithmetic: ``("..b", "x.y") -> "x.b"``;
    None when the name climbs above the package or the package is not a dotted name."""
    dots = len(name) - len(name.lstrip("."))
    if not dots:
        return name
    if not _dotted(package):
        return None
    bits = package.rsplit(".", dots - 1)
    if len(bits) < dots:
        return None
    rest = name[dots:]
    return f"{bits[0]}.{rest}" if rest else bits[0]


def _is_globals_call(node: ast.AST | None) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "globals"
        and not node.args
        and not node.keywords
    )


def dynamic_import(
    call: ast.Call, aliases: dict[str, str]
) -> tuple[str, str, int, tuple[str, ...], str] | None:
    """(how, module, level, names, unread) when ``call`` imports by name.

    ``x.import_module(...)`` and ``x.__import__(...)`` count whatever ``x`` is, so an
    alias of importlib or builtins is no way around the check. A relative name is read
    the way Python reads it: ``import_module`` against a literal ``package`` (giving an
    absolute module, level 0) or ``__package__`` (a relative row, like the statement);
    ``__import__`` with ``level > 0`` against the file's own package, when its globals
    are absent or ``globals()``. Module "" with ``unread`` set when the check cannot
    tell what the call loads (the name, package, level, globals or fromlist is not
    written out); module "" with level > 0 is the file's own package."""
    func = call.func
    if isinstance(func, ast.Name) and func.id in aliases:
        how, kind = func.id, aliases[func.id]
    elif isinstance(func, ast.Attribute) and func.attr in DYNAMIC:
        how, kind = ast.unparse(func), func.attr
    else:
        return None
    if any(isinstance(a, ast.Starred) for a in call.args) or any(kw.arg is None for kw in call.keywords):
        return how, "", 0, (), f"with arguments unpacked from a variable, which {CANNOT_READ}"
    name = _literal(_arg(call, 0, "name"))
    if name is None:
        return how, "", 0, (), f"with a module name {CANNOT_READ}"
    if kind == "import_module":
        dots = len(name) - len(name.lstrip("."))
        if not dots:
            return how, name, 0, (), ""
        pkg_node = _arg(call, 1, "package")
        if isinstance(pkg_node, ast.Name) and pkg_node.id == "__package__":
            return how, name[dots:], dots, (), ""
        if pkg_node is None or (isinstance(pkg_node, ast.Constant) and pkg_node.value is None):
            return how, "", 0, (), f"with a relative name and no package, which {CANNOT_READ}"
        package = _literal(pkg_node)
        if package is None:
            return how, "", 0, (), f"with a package {CANNOT_READ}"
        resolved = resolve_name(name, package)
        if resolved is None:
            return how, "", 0, (), f"with a relative name that climbs above its package, which {CANNOT_READ}"
        return how, resolved, 0, (), ""
    level_node = _arg(call, 4, "level")
    if level_node is None:
        level = 0
    elif isinstance(level_node, ast.Constant) and type(level_node.value) is int and level_node.value >= 0:
        level = level_node.value
    else:
        return how, "", 0, (), f"with a level {CANNOT_READ}"
    if level and not (_arg(call, 1, "globals") is None or _is_globals_call(_arg(call, 1, "globals"))):
        # __import__ takes the package a relative name starts from out of its globals.
        return how, "", 0, (), f"with a relative name and globals other than globals(), which {CANNOT_READ}"
    names: tuple[str, ...] = ()
    fromlist = _arg(call, 3, "fromlist")
    if fromlist is not None and not (isinstance(fromlist, ast.Constant) and fromlist.value is None):
        values = [_literal(e) for e in fromlist.elts] if isinstance(fromlist, (ast.Tuple, ast.List)) else [None]
        if any(v is None for v in values):
            return how, "", 0, (), f"with a fromlist {CANNOT_READ}"
        names = tuple(v for v in values if v)
    return how, name, level, names, ""


def _bound_names(tree: ast.AST) -> set[str]:
    """Names the file binds itself (def, class, assignment, import as): a local ``compile`` is not the builtin."""
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(node.name)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            out.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            out |= {(a.asname or a.name).split(".")[0] for a in node.names if a.name != "*"}
        elif isinstance(node, ast.arg):
            out.add(node.arg)
    return out


def _imports(path: Path) -> list[ImportRow]:
    """(module, at_module_level, line, level, names, how, unread) for every import in ``path``.

    level > 0 is a relative import; ``from . import a`` gives ``("a", ..., 1, (), "", "")``.
    names are what ``from x import ...`` takes from ``x``; each may be a submodule, or "*".
    Code that loads modules in a way the check cannot read gives a row with module ""
    and level 0, ``how`` as written and ``unread`` saying why.
    """
    tree = _parse(path)
    aliases = dynamic_aliases(tree)
    bound = _bound_names(tree)
    builtins_mods = {
        a.asname or a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names if a.name == "builtins"
    }
    out: list[ImportRow] = []
    called: set[int] = set()  # the func node of every call seen
    # A loop, not recursion: a long generated expression must not overflow the stack.
    stack: list[tuple[ast.AST, bool]] = [(tree, True)]
    while stack:
        node, top = stack.pop()
        line = getattr(node, "lineno", 0)

        def unread(how: str, why: str, top: bool = top, line: int = line) -> None:
            out.append(("", top, line, 0, (), how, why))

        if isinstance(node, ast.Import):
            out.extend((alias.name, top, line, 0, (), "", "") for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            level = node.level or 0
            names = tuple(alias.name for alias in node.names)
            if node.module == "runpy" and not level and any(n in (*RUNPY, "*") for n in names):
                unread("from runpy import " + ", ".join(names), f"runs a module or file {CANNOT_READ}")
            if node.module:
                out.append((node.module, top, line, level, names, "", ""))
            elif "*" in names:
                out.append(("", top, line, level, ("*",), "", ""))
            else:
                out.extend((name, top, line, level, (), "", "") for name in names)
        elif isinstance(node, ast.Call):
            called.add(id(node.func))
            func = node.func
            found = dynamic_import(node, aliases)
            if found is not None:
                how, mod, level, names, why = found
                if why:
                    unread(how + "()", why)
                elif not mod and level and names:  # __import__("", globals(), None, ["a"], 1): from . import a
                    out.extend((n, top, line, level, (), how, "") for n in names)
                else:
                    out.append((mod, top, line, level, names, how, ""))
            elif (isinstance(func, ast.Name) and func.id in RUNS_CODE and func.id not in bound) or (
                isinstance(func, ast.Attribute)
                and func.attr in RUNS_CODE
                and isinstance(func.value, ast.Name)
                and func.value.id in builtins_mods
            ):
                unread(ast.unparse(func) + "()", f"runs code from a string, which {CANNOT_READ}")
            elif isinstance(func, ast.Name) and func.id == "getattr" and len(node.args) > 1:
                attr = _literal(node.args[1])
                if attr in (*DYNAMIC, *RUNS_CODE, *RUNPY, *LOADERS):
                    unread(ast.unparse(node), f"looks up an import function by name, which {CANNOT_READ}")
        elif isinstance(node, ast.Attribute):
            if node.attr in RUNPY or node.attr in LOADERS:
                unread(ast.unparse(node), f"runs a module or file {CANNOT_READ}")
            elif node.attr in DYNAMIC and id(node) not in called:
                unread(ast.unparse(node), f"used other than as a direct call with the name written out, which {CANNOT_READ}")
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and id(node) not in called:
            if node.id in aliases or (node.id in RUNS_CODE and node.id not in bound):
                unread(node.id, f"used other than as a direct call with the name written out, which {CANNOT_READ}")
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
    mod, _top, _line, level, names, _how, _unread = row
    if not mod and not level:
        return None
    base = py.parent if level else plugin_dir
    for _ in range(level - 1):
        base = base.parent
    if base != plugin_dir and plugin_dir not in base.parents:
        return None
    parts = mod.split(".") if mod else []
    members = [m for n in names for m in (_star_members(base.joinpath(*parts)) if n == "*" else [n])]
    for dotted in ([parts] if parts else []) + [parts + [n] for n in members]:
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


def _declared_all(tree: ast.Module) -> list[str] | None:
    """A module's ``__all__`` when it is one literal list or tuple of strings; [] when it
    has none; None when the check cannot read it (built, extended or named in a string)."""
    mentions = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id == "__all__":
            mentions += 1
        elif isinstance(node, ast.Constant) and node.value == "__all__":
            return None
    if not mentions:
        return []
    declared: list[str] | None = None
    literal = 0
    for stmt in tree.body:
        if (
            isinstance(stmt, ast.Assign)
            and len(stmt.targets) == 1
            and isinstance(stmt.targets[0], ast.Name)
            and stmt.targets[0].id == "__all__"
            and isinstance(stmt.value, (ast.List, ast.Tuple))
        ):
            values = [_literal(e) for e in stmt.value.elts]
            if any(v is None for v in values):
                return None
            declared = [v for v in values if v is not None]
            literal += 1
    return declared if literal == mentions else None


def _star_members(folder: Path) -> list[str]:
    """The submodules ``from <folder's package> import *`` may load: those its ``__all__``
    names, or every submodule and subfolder when the check cannot read ``__all__``."""
    if not folder.is_dir():
        return []
    init = next((folder / f"__init__{s}" for s in SOURCES if (folder / f"__init__{s}").is_file()), None)
    declared: list[str] | None
    if init is None:
        declared = None if _package(folder) else []  # a compiled __init__ / a namespace folder
    else:
        try:
            declared = _declared_all(_parse(init))
        except (SyntaxError, ValueError, OSError, MemoryError, RecursionError):
            declared = None
    if declared is not None:
        return declared
    names = {p.name.split(".")[0] for p in folder.iterdir() if p.is_file() and p.name.endswith((*SOURCES, *EXTENSIONS))}
    names |= {p.name for p in folder.iterdir() if p.is_dir()}
    return sorted(n for n in names if n.isidentifier() and n != "__init__")


def _own_modules(plugin_dir: Path, hidden: set[Path]) -> set[str]:
    """Top-level source files and packages; skipped folders are not the plugin's own."""
    own: set[str] = set()
    for p in plugin_dir.iterdir():
        if p.is_file() and p.name.endswith(SOURCES):
            own.add(p.stem)
        elif p.is_dir() and p not in hidden and _package(p):
            own.add(p.name)
    return own


# -- the plugin's own environment -------------------------------------------------------


def normalize_dist(name: str) -> str:
    """PEP 503: lower case, runs of ``-``, ``_`` and ``.`` as one ``-``."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _decode(data: bytes) -> str:
    """Text by its byte-order mark (as pip reads a requirements file), else UTF-8."""
    for bom, codec in (
        (b"\xff\xfe\x00\x00", "utf-32"),
        (b"\x00\x00\xfe\xff", "utf-32"),
        (b"\xef\xbb\xbf", "utf-8-sig"),
        (b"\xff\xfe", "utf-16"),
        (b"\xfe\xff", "utf-16"),
    ):
        if data.startswith(bom):
            return data.decode(codec, errors="replace")
    return data.decode("utf-8", errors="replace")


def lock_distributions(text: str) -> list[str]:
    """The distributions a requirements lock pins (``name==version``), as written."""
    out: list[str] = []
    for raw in re.sub(r"\\\r?\n", " ", text).splitlines():
        line = re.sub(r"(^|\s)#.*$", "", raw).strip()
        if not line or line.startswith("-"):
            continue
        m = re.match(r"([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*===?", line)
        if m:
            out.append(m.group(1))
    return out


def lock_hash(lock: Path) -> str:
    """cfddesk.registry.plugin_env.lock_hash: SHA-256 of the lock, CRLF read as LF, first 16 hex."""
    return hashlib.sha256(lock.read_bytes().replace(b"\r\n", b"\n")).hexdigest()[:LOCK_HASH_LEN]


def env_site_packages(web_root: Path, key: str, lock: Path) -> list[Path]:
    """site-packages of the plugin's environment when it is built for this lock, else []."""
    override = os.environ.get("MAGNUSIM_PLUGIN_ENVS_DIR", "").strip()
    root = Path(override) if override else web_root / ".cache" / "plugin-envs"
    want = lock_hash(lock)
    env = root / f"{key}-{want}"
    try:
        stamp = json.loads((env / ENV_STAMP).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(stamp, dict) or stamp.get("lock_hash") != want:
        return []
    found = [env / "Lib" / "site-packages", *sorted((env / "lib").glob("python3*/site-packages"))]
    return [p for p in found if p.is_dir()]


def _dotted(name: str) -> bool:
    return bool(name) and all(part.isidentifier() for part in name.split("."))


def installed_import_names(site: Path) -> dict[str, set[str]]:
    """{normalized distribution: its top-level import names}, from each ``*.dist-info``'s
    ``top_level.txt`` and ``RECORD`` (the files pip installed)."""
    out: dict[str, set[str]] = {}
    for info in sorted(site.glob("*.dist-info")):
        dist = normalize_dist(info.name[: -len(".dist-info")].rsplit("-", 1)[0])
        names: set[str] = set()
        try:
            top = (info / "top_level.txt").read_text(encoding="utf-8")
        except OSError:
            top = ""
        names |= {n.strip().replace("/", ".") for n in top.splitlines() if _dotted(n.strip().replace("/", "."))}
        try:
            with (info / "RECORD").open(encoding="utf-8", newline="") as f:
                paths = [row[0] for row in csv.reader(f) if row]
        except OSError:
            paths = []
        for path in paths:
            first, sep, _rest = path.replace("\\", "/").partition("/")
            if first in ("..", "__pycache__") or first.endswith((".dist-info", ".data")):
                continue
            if sep:
                name = first  # a folder: a package (numpy.libs and the like are not names)
            elif first.endswith((*SOURCES, *EXTENSIONS)):
                name = first.split(".", 1)[0]  # gmsh.py, _cffi_backend.cp310-win_amd64.pyd
            else:
                continue
            if name.isidentifier():
                names.add(name)
        out.setdefault(dist, set()).update(names)
    return out


def _read_manifest(plugin_dir: Path) -> dict[str, Any]:
    """manifest.toml as a table; {} when it cannot be read (then nothing counts as environment code)."""
    try:
        text = _decode((plugin_dir / "manifest.toml").read_bytes())
    except OSError:
        return {}
    loads: Any = None
    try:
        import tomllib

        loads = tomllib.loads
    except ImportError:
        try:
            import tomli

            loads = tomli.loads
        except ImportError:
            loads = None
    if loads is None:
        return {}
    try:
        meta = loads(text)
    except Exception:  # a manifest that does not parse is plugin:check's finding
        return {}
    return meta if isinstance(meta, dict) else {}


def lock_import_names(plugin_dir: Path, key: str, python: dict[str, Any], web_root: Path) -> tuple[dict[str, str], str]:
    """({import name: the distribution pinned in the plugin's lock}, where the names came from:
    "installed" or "lock"). Empty when the plugin has no lock."""
    lock = (plugin_dir / str(python.get("requirements") or "requirements.lock")).resolve()
    root = plugin_dir.resolve()
    if root not in lock.parents or not lock.is_file():
        return {}, ""
    dists = lock_distributions(_decode(lock.read_bytes()))
    installed: dict[str, set[str]] = {}
    for site in env_site_packages(web_root, key, lock):
        for dist, names in installed_import_names(site).items():
            installed.setdefault(dist, set()).update(names)
    out: dict[str, str] = {}
    for dist in dists:
        norm = normalize_dist(dist)
        names = {norm.replace("-", "_"), *IMPORT_NAMES.get(norm, ()), *installed.get(norm, ())}
        for name in names:
            if _dotted(name) and not any(_under(name, host) for host in NEVER_FROM_A_LOCK):
                out.setdefault(name, dist)
    return out, ("installed" if installed else "lock") if dists else ""


PLACED = ("JobKind", "LogParserRef")
# Names that, written in a string, let host code reach a job or a log parser by getattr.
PLACED_STRINGS = (*PLACED, "register_job")


def _splat(call: ast.Call) -> bool:
    return any(isinstance(a, ast.Starred) for a in call.args) or any(kw.arg is None for kw in call.keywords)


def _registrations(tree: ast.AST, where: str) -> tuple[list[tuple[str, str]], list[str], list[str]]:
    """What one host-loaded file registers: ([(tool, python)] of its jobs, [module] of the
    log parsers it names, [why the check cannot place something]).

    A job is placed when ``JobKind(...)`` (any alias the file imports it as) is the job
    argument of a ``<x>.register_job(...)`` call and its tool and ``python=`` (default
    "core") are written out. A log parser is placed when ``LogParserRef(...)``'s module
    is written out (``dataclasses.replace(..., module="x")`` names one too). Anything
    else that could register a job or name a log parser is a reason."""
    jobs: list[tuple[str, str]] = []
    parsers: list[str] = []
    unplaced: list[str] = []

    def bad(node: ast.AST, why: str) -> None:
        unplaced.append(f"{where}:{getattr(node, 'lineno', 0)}: {why}")

    classes: dict[str, set[str]] = {name: {name} for name in PLACED}
    replace_names: set[str] = set()  # dataclasses.replace / copy.replace, imported by name
    replace_mods: set[str] = set()  # the dataclasses and copy modules
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for a in node.names:
                if a.name in PLACED:
                    classes[a.name].add(a.asname or a.name)
                if node.module in ("dataclasses", "copy") and a.name in ("replace", "*"):
                    replace_names.add(a.asname or "replace")
        elif isinstance(node, ast.Import):
            replace_mods |= {a.asname or a.name for a in node.names if a.name in ("dataclasses", "copy")}
    parents = {id(child): node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    # A type annotation or isinstance()'s class argument names the class without making one.
    exempt: set[int] = set()
    for node in ast.walk(tree):
        held: list[ast.AST | None] = []
        if isinstance(node, ast.arg):
            held = [node.annotation]
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            held = [node.returns]
        elif isinstance(node, ast.AnnAssign):
            held = [node.annotation]
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in ("isinstance", "issubclass")
            and len(node.args) == 2
        ):
            held = [node.args[1]]
        for h in held:
            if h is not None:
                exempt |= {id(n) for n in ast.walk(h)}

    def kind_of(func: ast.AST) -> str | None:
        if isinstance(func, ast.Name):
            return next((k for k, names in classes.items() if func.id in names), None)
        if isinstance(func, ast.Attribute) and func.attr in PLACED:
            return func.attr
        return None

    def is_replace(func: ast.AST) -> bool:
        if isinstance(func, ast.Name):
            return func.id in replace_names
        return (
            isinstance(func, ast.Attribute)
            and func.attr == "replace"
            and isinstance(func.value, ast.Name)
            and func.value.id in replace_mods
        )

    for node in ast.walk(tree):
        parent = parents.get(id(node))
        as_call = isinstance(parent, ast.Call) and parent.func is node
        if isinstance(node, ast.Constant) and node.value in PLACED_STRINGS:
            bad(node, f"{node.value!r} written in a string")
        elif isinstance(node, (ast.Name, ast.Attribute)) and not as_call and id(node) not in exempt:
            if kind_of(node) or is_replace(node):
                bad(node, f"{ast.unparse(node)} used other than as a direct call")
            elif isinstance(node, ast.Attribute) and node.attr == "register_job":
                bad(node, f"{ast.unparse(node)} used other than as a direct call")
        elif isinstance(node, ast.Call):
            kind = kind_of(node.func)
            func = node.func
            if kind == "JobKind":
                direct = (
                    isinstance(parent, ast.Call)
                    and isinstance(parent.func, ast.Attribute)
                    and parent.func.attr == "register_job"
                    and _arg(parent, 0, "spec") is node
                )
                tool = _literal(_arg(node, 1, "tool"))
                py_node = _arg(node, 4, "python")
                runtime = "core" if py_node is None else _literal(py_node)
                if not direct:
                    bad(node, "a JobKind(...) not passed straight to hub.register_job(...)")
                elif _splat(node) or not tool or not runtime:
                    bad(node, "a JobKind(...) whose tool or python= is not written out")
                else:
                    jobs.append((tool, runtime))
            elif kind == "LogParserRef":
                module = _literal(_arg(node, 0, "module"))
                if _splat(node) or not module:
                    bad(node, "a LogParserRef(...) whose module is not written out")
                else:
                    parsers.append(module)
            elif isinstance(func, ast.Attribute) and func.attr == "register_job":
                spec = _arg(node, 0, "spec")
                if _splat(node) or not (isinstance(spec, ast.Call) and kind_of(spec.func) == "JobKind"):
                    bad(node, f"{ast.unparse(func)}(...) with a job that is not a JobKind(...) written in the call")
            elif is_replace(func):
                for kw in node.keywords:
                    module = _literal(kw.value) if kw.arg == "module" else ""
                    if kw.arg in ("tool", "python"):
                        bad(node, f"{ast.unparse(func)}(...) that changes a job's {kw.arg}")
                    elif kw.arg is None or module is None:
                        bad(node, f"{ast.unparse(func)}(...) with a module that is not written out")
                    elif module:
                        parsers.append(module)
            elif (isinstance(func, ast.Name) and func.id == "setattr") or (
                isinstance(func, ast.Attribute) and func.attr == "__setattr__"
            ):
                bad(node, f"{ast.unparse(func)}(...), which can change a registered job or log parser")
    return jobs, parsers, unplaced


def _own_targets(plugin_dir: Path, py: Path, row: ImportRow, own: set[str]) -> list[Path]:
    """The plugin's own source files that importing ``row`` from ``py`` runs."""
    mod, _top, _line, level, names, _how, _unread = row
    parts = mod.split(".") if mod else []
    out: list[Path] = []
    if level:
        base = py.parent
        for _ in range(level - 1):
            base = base.parent
        if base != plugin_dir and plugin_dir not in base.parents:
            return []
        if (base / "__init__.py").is_file():
            out.append(base / "__init__.py")
    elif parts and parts[0] in own:
        base = plugin_dir
    else:
        return []
    here: Path | None = base
    for part in parts:
        assert here is not None
        if (here / part / "__init__.py").is_file():
            here = here / part
            out.append(here / "__init__.py")
            continue
        out += [here / f"{part}{suffix}" for suffix in SOURCES if (here / f"{part}{suffix}").is_file()][:1]
        here = None
        break
    if here is not None:
        # from package import name: name may be a submodule; * loads what __all__ names.
        for sub in [m for n in names for m in (_star_members(here) if n == "*" else [n])]:
            for cand in (here / sub / "__init__.py", *(here / f"{sub}{suffix}" for suffix in SOURCES)):
                if cand.is_file():
                    out.append(cand)
                    break
    return out


def _reach(starts: list[Path], rows: dict[Path, list[ImportRow]], plugin_dir: Path, own: set[str]) -> set[Path]:
    """``starts`` and every file of the plugin they import, at any depth, lazily or not."""
    seen: set[Path] = set()
    stack = [p for p in starts if p in rows]
    while stack:
        py = stack.pop()
        if py in seen:
            continue
        seen.add(py)
        for row in rows.get(py, []):
            stack += [t for t in _own_targets(plugin_dir, py, row, own) if t in rows and t not in seen]
    return seen


def _module_file(plugin_dir: Path, dotted: str) -> list[Path]:
    """The files importing module ``dotted`` from the plugin folder runs (its packages' __init__ too)."""
    if not _dotted(dotted):
        return []
    here, out = plugin_dir, []
    parts = dotted.split(".")
    for i, part in enumerate(parts):
        if (here / part / "__init__.py").is_file():
            here = here / part
            out.append(here / "__init__.py")
            continue
        if i == len(parts) - 1:
            out += [here / f"{part}{suffix}" for suffix in SOURCES if (here / f"{part}{suffix}").is_file()][:1]
            return out
        return []
    return out


def environment_files(
    plugin_dir: Path, rows: dict[Path, list[ImportRow]], own: set[str], meta: dict[str, Any]
) -> tuple[set[Path], list[Path], list[str]]:
    """(the files that run only on the plugin's environment, its entry points there, why
    the check cannot place the plugin's jobs and log parsers).

    Host code: plugin.py, every log parser module host code names, and what they import.
    Entries: the [python] service module and the job tools host code registers with
    python="plugin". A file the host loads, or a job tool on the core's Python imports,
    is never environment code, even when environment code imports it too. When host code
    registers a job or names a log parser in a way the check cannot place, no file is
    environment code."""
    python = meta.get("python")
    if not isinstance(python, dict):
        return set(), [], []
    # A log parser's module is imported from a folder its LogParserRef names: any of the plugin's.
    folders = {plugin_dir} | {a for p in rows for a in (p.parent, *p.parent.parents) if plugin_dir in (a, *a.parents)}
    starts = [plugin_dir / "plugin.py"]
    scanned: set[Path] = set()
    jobs: list[tuple[str, str, Path]] = []
    unplaced: list[str] = []
    while True:
        host = _reach(starts, rows, plugin_dir, own)
        new = sorted(host - scanned)
        if not new:
            break
        for py in new:
            scanned.add(py)
            try:
                tree = _parse(py)
            except (SyntaxError, ValueError, OSError, MemoryError, RecursionError):
                continue  # reported as a problem already
            found, parsers, why = _registrations(tree, py.relative_to(plugin_dir).as_posix())
            jobs += [(tool, runtime, py) for tool, runtime in found]
            unplaced += why
            for module in parsers:
                starts += [f for base in sorted(folders) for f in _module_file(base, module) if f in rows]
    if unplaced:
        return set(), [], unplaced
    env_entries: list[Path] = []
    core_entries: list[Path] = []
    service = python.get("service")
    if isinstance(service, str) and service:
        env_entries += _module_file(plugin_dir, service)
    rels = {p: p.relative_to(plugin_dir).as_posix() for p in rows}
    for tool, runtime, py in jobs:
        rel = posixpath.normpath(tool.replace("\\", "/"))
        if runtime == "plugin":
            for base in (plugin_dir, py.parent):
                cand = base / rel
                if cand.suffix in SOURCES and cand in rows:
                    env_entries.append(cand)
                    break
        else:
            # Run from whatever package folder register_job was given: every file it can be.
            core_entries += [p for p, r in rels.items() if r == rel or r.endswith("/" + rel)]
    env = _reach(env_entries, rows, plugin_dir, own)
    not_env = host | _reach(core_entries, rows, plugin_dir, own)
    return env - not_env, [e for e in env_entries if e not in not_env], []


def _provider(mod: str, names: dict[str, str]) -> str | None:
    """The pinned distribution that provides module ``mod``, if any."""
    return next((dist for name, dist in names.items() if _under(mod, name)), None)


def check_plugin(
    plugin_dir: Path, key: str, *, web_root: Path | None = None, info: dict[str, Any] | None = None
) -> tuple[list[dict[str, object]], list[str]]:
    """Problems in one plugin, and the folders the check skipped (relative to the plugin).

    ``info`` (optional) receives what counted as environment code and where the lock's
    import names came from."""
    stdlib = _stdlib()
    files, skipped, bytecode = plugin_files(plugin_dir)
    hidden = set(skipped)
    own = _own_modules(plugin_dir, hidden)
    problems: list[dict[str, object]] = []
    rows = {py: _read_imports(py, problems) for py in files}
    meta = _read_manifest(plugin_dir)
    env_files, _entries, unplaced = environment_files(plugin_dir, rows, own, meta)
    python = meta.get("python")
    lock_names: dict[str, str] = {}
    names_from = ""
    if isinstance(python, dict):
        lock_names, names_from = lock_import_names(plugin_dir, key, python, web_root or WEB_ROOT)
    if info is not None:
        info.update(
            {
                "environment_files": sorted(p.relative_to(plugin_dir).as_posix() for p in env_files),
                "lock_names": sorted(lock_names),
                "names_from": names_from,
                # Why no file counts as environment code, when the check cannot place a job or log parser.
                "unplaced": unplaced,
            }
        )
    plugin_py = plugin_dir / "plugin.py"
    for py in files:
        package = py.relative_to(plugin_dir).parts[:-1]  # the package Python runs the file in
        for row in rows[py]:
            mod, top, line, level, _names, how, cannot = row
            if not mod and not level:
                why = (
                    f"{how} {cannot}: write the full module name as a string in a direct call (or use an "
                    "import statement), so the boundary check sees what it loads"
                )
                problems.append({"file": str(py), "line": line, "import": how, "problem": why})
                continue
            # Plugin code the check does not read is named first, wherever the import points.
            unread = _unread_import(plugin_dir, py, row, hidden, stdlib)
            if unread:
                problems.append({"file": str(py), "line": line, "import": unread[0], "problem": unread[1]})
                continue
            shown = "." * level + mod
            if level and py == plugin_py:
                why = (
                    f"plugin.py runs as {PLUGIN_PY_PACKAGE}.<folder>, so the relative import {shown} loads from "
                    "the core's package or another plugin, not this one: import the plugin's own modules by "
                    "their full name"
                )
                problems.append({"file": str(py), "line": line, "import": shown, "problem": why})
                continue
            if level > len(package):
                why = (
                    f"the relative import {shown} climbs above the plugin's top-level package (Python refuses it, "
                    "or loads it from outside the plugin): import the plugin's own modules by their full name"
                )
                problems.append({"file": str(py), "line": line, "import": shown, "problem": why})
                continue
            if level:
                continue
            root = mod.split(".")[0]
            if root in stdlib or root in own:
                continue
            if any(_under(mod, a) for a in ALLOWED):
                continue
            dist = _provider(mod, lock_names)
            if dist and py in env_files:
                continue
            if any(_under(mod, lazy) for lazy in LAZY_ONLY):
                if not top:
                    continue
                why = f"{mod} must be imported inside the function that uses it"
            elif (plugin_dir / root).is_dir():
                why = f"{root}/ has no __init__.py, so import {mod} may load a {root} installed elsewhere; add {root}/__init__.py"
            elif dist and unplaced:
                why = (
                    f"{mod} comes from {dist}, pinned in the plugin's lock, but the check cannot place every job "
                    f"and log parser this plugin registers ({unplaced[0]}), so no file counts as running only on "
                    "the plugin's environment: pass each JobKind(...) straight to hub.register_job(...) with its "
                    "tool and python= written out, and write each LogParserRef's module as a string"
                )
            elif dist:
                why = (
                    f"{mod} comes from {dist}, pinned in the plugin's lock, but this file does not run only on the "
                    "plugin's environment: import it only in the [python] service module, a job tool registered "
                    'with python="plugin", or a module that only those import (code the host loads, from '
                    "plugin.py on, may not)"
                )
            elif lock_names:
                why = (
                    "plugins may import only magnusim_sdk, cfddesk.registry, the standard library and, in code "
                    f"that runs on the plugin's environment, the packages its lock pins, not {mod}"
                )
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
            # A call with a name the AST cannot read is the core's own business (its loader).
            for mod, _top, line, level, _names, _how, _unread in _read_imports(py, problems):
                if mod and not level and any(_under(mod, b) for b in banned):
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
    fixtures = web_root / "python" / "tests" / "fixtures"
    for parent in (bundled, *(fixtures / name for name in FIXTURE_PLUGIN_FOLDERS)):
        if parent.is_dir():
            plugin_dirs += [d for d in sorted(parent.iterdir()) if (d / "plugin.py").is_file()]
    template = web_root / "templates" / "plugin"
    if template.is_dir():
        plugin_dirs.append(template)
    problems: list[dict[str, object]] = []
    skipped: dict[str, list[str]] = {}
    environment: dict[str, dict[str, Any]] = {}
    for d in plugin_dirs:
        info: dict[str, Any] = {}
        found, folders = check_plugin(d, _plugin_key(d), web_root=web_root, info=info)
        problems += found
        rel = d.relative_to(web_root).as_posix()
        skipped[rel] = folders
        if info.get("environment_files") or info.get("lock_names"):
            environment[rel] = info
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
        # Per plugin with a [python] environment: the files held to rule 3, not rule 2.
        "environment": environment,
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
