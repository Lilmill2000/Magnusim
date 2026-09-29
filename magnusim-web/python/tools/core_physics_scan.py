#!/usr/bin/env python3
"""No-core-physics scan (gate:h9-no-core-physics, gate:h10-no-core-physics-ui;
CI job ``plugin-boundary``).

Incompressible Flow lives in its bundled plugin. The core's Python
(``python/cfddesk``, ``python/tools``), its Node server (``scripts/``) and its
page (``src/``, the app shell included) must not name its solvers, turbulence
models or fvSolution algorithm keywords in code: no ``simpleFoam`` /
``pimpleFoam`` literals, no turbulence model lists, no SIMPLE/PIMPLE
dictionary bodies or labels. Comments and docstrings may mention them.

Each exception is a file in ``core_physics_allowlist.json`` with its reason;
an entry whose file no longer has a hit is reported too (stale allowlist).

CLI: tools/core_physics_scan.py [--web-root PATH]. Prints a JSON report; exit 1 on a problem.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parents[1].parent
ALLOWLIST = Path(__file__).resolve().parent / "core_physics_allowlist.json"

PHYSICS = re.compile(
    r"\b(simpleFoam|pimpleFoam|kOmegaSST|kOmega|kEpsilon|realizableKE|LaunderSharmaKE|"
    r"nOuterCorrectors|nCorrectors|nNonOrthogonalCorrectors|residualControl|PIMPLE|SIMPLE)\b"
    r"|k-omega|k-epsilon"
)

SKIP_PARTS = {"__pycache__", "__tests__", "generated", "build", "node_modules", "test"}
TEST_FILE = re.compile(r"\.test\.(ts|tsx|js|mjs)$")


def _docstring_nodes(tree: ast.AST) -> set[int]:
    out: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                out.add(id(body[0].value))
    return out


def python_hits(path: Path) -> list[tuple[int, str]]:
    """(line, word) for physics words in code: string literals (not docstrings) and names."""
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    docs = _docstring_nodes(tree)
    hits: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        text = None
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs:
            text = node.value
        elif isinstance(node, ast.Name):
            text = node.id
        elif isinstance(node, ast.Attribute):
            text = node.attr
        if text:
            hits += [(getattr(node, "lineno", 0), m.group(0)) for m in PHYSICS.finditer(text)]
    return hits


def strip_js_comments(src: str) -> str:
    """The source with // and /* */ comments blanked (strings and templates kept; lines kept)."""
    out: list[str] = []
    i, n = 0, len(src)
    quote = ""
    while i < n:
        c = src[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if c == quote:
                quote = ""
            i += 1
            continue
        if c in "'\"`":
            quote = c
            out.append(c)
            i += 1
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("\n" * src.count("\n", i, j))
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out)


def strip_html_comments(src: str) -> str:
    """The page with <!-- --> comments blanked (lines kept)."""
    return re.sub(r"<!--.*?-->", lambda m: "\n" * m.group(0).count("\n"), src, flags=re.S)


def js_hits(path: Path) -> list[tuple[int, str]]:
    raw = path.read_text(encoding="utf-8-sig")
    code = strip_html_comments(raw) if path.suffix == ".html" else strip_js_comments(raw)
    return [(code.count("\n", 0, m.start()) + 1, m.group(0)) for m in PHYSICS.finditer(code)]


def core_files(web_root: Path) -> list[Path]:
    files: list[Path] = []
    for folder, globs in (
        (web_root / "python" / "cfddesk", ("*.py",)),
        (web_root / "python" / "tools", ("*.py",)),
        (web_root / "scripts", ("*.js", "*.mjs", "*.ts")),
        (web_root / "src", ("*.js", "*.ts", "*.tsx", "*.html")),
    ):
        for g in globs:
            files += [
                p
                for p in folder.rglob(g)
                if not SKIP_PARTS & set(p.relative_to(folder).parts) and not TEST_FILE.search(p.name)
            ]
    return sorted(files)


def load_allowlist(path: Path = ALLOWLIST) -> dict[str, str]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    return {str(e["file"]): str(e["reason"]) for e in doc["files"]}


def run(web_root: Path, allowlist: dict[str, str] | None = None) -> dict[str, object]:
    allowed = load_allowlist() if allowlist is None else allowlist
    problems: list[dict[str, object]] = []
    allowed_hits: dict[str, int] = {}
    for path in core_files(web_root):
        if path.resolve() == Path(__file__).resolve():
            continue
        rel = path.relative_to(web_root).as_posix()
        hits = python_hits(path) if path.suffix == ".py" else js_hits(path)
        if not hits:
            continue
        if rel in allowed:
            allowed_hits[rel] = len(hits)
            continue
        problems += [
            {"file": rel, "line": line, "word": word, "problem": "incompressible physics in the core"}
            for line, word in hits
        ]
    for rel in sorted(set(allowed) - set(allowed_hits)):
        problems.append({"file": rel, "line": 0, "word": "", "problem": "allowlisted but has no hit (remove the entry)"})
    return {"ok": not problems, "allowed": allowed_hits, "problems": problems}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--web-root", type=Path, default=WEB_ROOT)
    args = p.parse_args(argv)
    report = run(args.web_root)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
