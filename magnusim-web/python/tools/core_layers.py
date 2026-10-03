#!/usr/bin/env python3
"""Core package dependencies (CI job ``plugin-boundary``).

``cfddesk`` is split into packages (``wsl``, ``runner``, ``mesh``, ``case``,
``project``, ``registry``, ``worker`` ...), but nothing stopped one package
importing from any other, so a change in one could reach any of them. This
check fixes which packages each package may import (``ALLOWED`` below), so the
graph only changes on purpose and in review:

- a module importing a ``cfddesk`` package its package may not import is a
  problem (a new dependency: add it to ``ALLOWED`` in the same change, or
  don't add it);
- an entry in ``ALLOWED`` nothing uses any more is a problem too, so the table
  shrinks as dependencies are removed and cannot grow back unnoticed;
- a package missing from ``ALLOWED`` is a problem (a new package says what it
  needs).

Imports anywhere in a module count, inside functions too: a function-level
import still makes the package depend on the other.

``ALLOWED`` started as the graph on 2026-10-01, which is not layered: nine
pairs of packages import each other (the report lists them under ``cycles``). The
intended direction, bottom to top, is ``units``/``jobs`` → ``wsl``/``runner`` →
``cad`` → ``mesh``/``case`` → ``results`` → ``project`` →
``registry``/``builtin`` → ``worker``; removing an edge that points down the
wrong way is progress, adding one is not.

CLI: tools/core_layers.py [--root PATH]. Prints a JSON report; exit 1 on a problem.
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "cfddesk"

# Package -> the other cfddesk packages it may import. "<top>" is cfddesk/__init__.py.
ALLOWED: dict[str, set[str]] = {
    "<top>": set(),
    "builtin": {"project", "registry", "results"},
    "cad": {"case", "project"},
    "case": {"registry"},
    "jobs": set(),
    "mesh": {"cad", "case", "project"},
    "project": {"cad", "case", "mesh", "registry", "results"},
    "registry": {"builtin", "project", "wsl"},
    "results": set(),
    "runner": {"wsl"},
    "units": set(),
    "worker": {"cad", "case", "project", "registry", "wsl"},
    "wsl": {"jobs", "registry", "runner"},
}

SKIP_PARTS = {"__pycache__"}


def _package(rel: tuple[str, ...]) -> str:
    return rel[0] if len(rel) > 1 else "<top>"


def _imports(tree: ast.AST, rel: tuple[str, ...]) -> list[tuple[int, str]]:
    """(line, absolute dotted name) for every import in the module."""
    # The module's own package, as cfddesk-relative parts (for __init__ it is its folder).
    pkg = ["cfddesk", *rel[:-1]]
    out: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.extend((node.lineno, a.name) for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                if node.level - 1 > len(pkg) - 1:
                    continue  # above cfddesk: not ours
                base = pkg[: len(pkg) - (node.level - 1)]
                if node.module:
                    out.append((node.lineno, ".".join([*base, node.module])))
                else:
                    out.extend((node.lineno, ".".join([*base, a.name])) for a in node.names)
            elif node.module:
                out.append((node.lineno, node.module))
    return out


def run(root: Path = ROOT, allowed: dict[str, set[str]] | None = None) -> dict:
    allowed = ALLOWED if allowed is None else allowed
    packages = sorted(
        p.name
        for p in root.iterdir()
        if p.is_dir() and p.name not in SKIP_PARTS and any(p.rglob("*.py"))
    )
    problems: list[dict] = []
    used: dict[str, set[str]] = {}
    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root).with_suffix("").parts
        if SKIP_PARTS & set(rel):
            continue
        src = _package(rel)
        shown = path.relative_to(root.parent).as_posix()
        try:
            tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=shown)
        except SyntaxError as e:
            problems.append({"file": shown, "line": e.lineno, "problem": f"cannot parse: {e.msg}"})
            continue
        for line, name in _imports(tree, rel):
            parts = name.split(".")
            if parts[0] != "cfddesk" or len(parts) < 2:
                continue
            target = parts[1] if parts[1] in packages else "<top>"
            if target == src:
                continue
            used.setdefault(src, set()).add(target)
            if src not in allowed:
                continue
            if target not in allowed[src]:
                problems.append(
                    {
                        "file": shown,
                        "line": line,
                        "problem": f"cfddesk.{src} may not import cfddesk.{target} ({name}); "
                        "add it to ALLOWED in tools/core_layers.py if the dependency is meant",
                    }
                )
    for pkg in packages:
        if pkg not in allowed:
            problems.append(
                {
                    "package": pkg,
                    "problem": f"cfddesk.{pkg} is not in ALLOWED: list what it may import",
                }
            )
    for pkg, targets in sorted(allowed.items()):
        for target in sorted(targets - used.get(pkg, set())):
            problems.append(
                {
                    "package": pkg,
                    "problem": f"cfddesk.{pkg} no longer imports cfddesk.{target}: remove it from ALLOWED",
                }
            )
    cycles = sorted(
        {tuple(sorted((a, b))) for a, ts in used.items() for b in ts if a in used.get(b, set())}
    )
    return {
        "ok": not problems,
        "problems": problems,
        "graph": {k: sorted(v) for k, v in sorted(used.items())},
        "cycles": [list(c) for c in cycles],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", type=Path, default=ROOT)
    report = run(ap.parse_args(argv).root)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
