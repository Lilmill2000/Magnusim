#!/usr/bin/env python3
"""No-core-physics scan (gate:h9-no-core-physics, gate:h10-no-core-physics-ui;
CI job ``plugin-boundary``).

Incompressible Flow lives in its bundled plugin. The core's Python
(``python/cfddesk``, ``python/tools``), its Node server (``scripts/``), its
page (``src/``, the app shell included), the plugin SDK
(``python/sdk/magnusim_sdk``) and the published plugin typings
(``docs/plugins/*.d.ts``, ``docs/plugins/plugin-sdk.json``) are scanned in two
tiers.

Tier 1, PHYSICS (hard): no solver, turbulence model or fvSolution algorithm
names in code: no ``simpleFoam`` / ``pimpleFoam`` literals, no turbulence model
lists, no SIMPLE/PIMPLE dictionary bodies or labels, no ``Incompressible``
word (``Incompressible_Steady-state`` included), no analysis keys. Each
exception is a file in the allowlist's ``files`` with its reason (or only the
lines that contain one of its ``line_contains``); an entry whose file no
longer has a hit is reported too (stale allowlist).

Tier 2, IF_VOCAB (ratcheted): Incompressible Flow's own vocabulary
(``velocity_inlet``, ``Velocity inlet``, ``Pressure outlet``, ``magU``,
``kinematic_viscosity``, an ``'Air'`` literal, ``incompressible-defaults`` and
``("U", "p")`` pair literals). A file with hits needs an ``if_vocab`` (core)
or ``if_vocab_sdk`` (SDK) entry ``{file, max_hits, reason}``. The scan fails
when a file's count rises above max_hits ("IF vocabulary grew") and when it
drops below ("lower max_hits to N"), so the ceiling only goes down, in the
commit that removes the words. A U/p pair is allowed (not counted) on a line
that names ``LEGACY_FRAME_FIELDS``, the one documented legacy constant.

Comments and docstrings may mention any of it. Deliberately not scanned:
``co_max`` (the generic Courant aggregation every transient run reports) and
``kinematic_fields`` (the documented 1.1 sidecar key) are not vocabulary;
prose ``.md`` files (docs explain the plugin by name); the generated
``docs/plugins/registry.json`` and ``*.gen.ts`` (they list every shipped
plugin's keys); tests.

CLI: tools/core_physics_scan.py [--web-root PATH]. Prints a JSON report; exit 1 on a problem.
"""

from __future__ import annotations

import argparse
import ast
import io
import json
import re
import tokenize
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parents[1].parent
ALLOWLIST = Path(__file__).resolve().parent / "core_physics_allowlist.json"

PHYSICS = re.compile(
    r"\b(simpleFoam|pimpleFoam|kOmegaSST|kOmega|kEpsilon|realizableKE|LaunderSharmaKE|"
    r"nOuterCorrectors|nCorrectors|nNonOrthogonalCorrectors|residualControl|PIMPLE|SIMPLE)\b"
    r"|k-omega|k-epsilon|\bIncompressible(?=\b|_)"
    # Its analysis keys: the default analysis comes from its manifest ([default_analysis]).
    r"|incompressible_steady|incompressible_transient"
)

IF_VOCAB = re.compile(
    r"velocity_inlet|Velocity inlet|Pressure outlet|\bmagU\b|kinematic_viscosity"
    r"|(?P<q>['\"])Air(?P=q)"
    r"|incompressible-defaults"
    r"|[\(\[]\s*['\"]U['\"]\s*,\s*['\"]p['\"]\s*[\)\]]"
)
UP_PAIR = re.compile(r"[\(\[]\s*['\"]U['\"]")
# The one place a U/p pair may stand: python/cfddesk/registry/contract.py and
# scripts/project-layout.js define it, its readers name it.
LEGACY_LINE = "LEGACY_FRAME_FIELDS"

SKIP_PARTS = {"__pycache__", "__tests__", "generated", "build", "node_modules", "test"}
# Tests, and files generated from the shipped registry (src/api/registry.gen.ts
# lists every shipped key, the bundled plugins' included).
TEST_FILE = re.compile(r"\.test\.(ts|tsx|js|mjs)$|\.gen\.ts$")
SDK_DIR = ("python", "sdk", "magnusim_sdk")


def _docstring_nodes(tree: ast.AST) -> list[ast.Constant]:
    out: list[ast.Constant] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                out.append(body[0].value)
    return out


def python_hits(path: Path) -> list[tuple[int, str]]:
    """(line, word) for physics words in code: string literals (not docstrings) and names."""
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    docs = {id(n) for n in _docstring_nodes(tree)}
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


def python_code(src: str) -> str:
    """Python source with comments and docstrings blanked (lines and columns kept)."""
    lines = src.splitlines(keepends=True)

    def blank(r0: int, c0: int, r1: int, c1: int) -> None:
        # Rows 1-based, columns in characters; the line ends stay.
        for r in range(r0, r1 + 1):
            line = lines[r - 1]
            body = line.rstrip("\r\n")
            a = c0 if r == r0 else 0
            b = c1 if r == r1 else len(body)
            lines[r - 1] = body[:a] + " " * (b - a) + body[b:] + line[len(body) :]

    def char_col(row: int, byte_col: int) -> int:
        return len(lines[row - 1].encode("utf-8")[:byte_col].decode("utf-8", "ignore"))

    for node in _docstring_nodes(ast.parse(src)):
        end_row, end_col = node.end_lineno or node.lineno, node.end_col_offset or 0
        blank(node.lineno, char_col(node.lineno, node.col_offset), end_row, char_col(end_row, end_col))
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type == tokenize.COMMENT:
            blank(tok.start[0], tok.start[1], tok.end[0], tok.end[1])
    return "".join(lines)


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


def code_text(path: Path, raw: str) -> str:
    """The file's code with comments (and Python docstrings) blanked; JSON as is."""
    if path.suffix == ".py":
        return python_code(raw)
    if path.suffix == ".html":
        return strip_html_comments(raw)
    if path.suffix == ".json":
        return raw
    return strip_js_comments(raw)


def js_hits(path: Path) -> list[tuple[int, str]]:
    code = code_text(path, path.read_text(encoding="utf-8-sig"))
    return [(code.count("\n", 0, m.start()) + 1, m.group(0)) for m in PHYSICS.finditer(code)]


def vocab_hits(path: Path) -> list[tuple[int, str]]:
    """(line, word) for IF_VOCAB in code; a U/p pair on a LEGACY_FRAME_FIELDS line is not a hit."""
    raw = path.read_text(encoding="utf-8-sig")
    code = code_text(path, raw)
    lines = raw.splitlines()
    hits: list[tuple[int, str]] = []
    for m in IF_VOCAB.finditer(code):
        line = code.count("\n", 0, m.start()) + 1
        word = m.group(0)
        if UP_PAIR.match(word):
            word = re.sub(r"\s+", "", word)
            if 0 < line <= len(lines) and LEGACY_LINE in lines[line - 1]:
                continue
        hits.append((line, word))
    return hits


def core_files(web_root: Path) -> list[Path]:
    files: list[Path] = []
    for folder, globs in (
        (web_root / "python" / "cfddesk", ("*.py",)),
        (web_root / "python" / "tools", ("*.py",)),
        (web_root.joinpath(*SDK_DIR), ("*.py",)),
        (web_root / "scripts", ("*.js", "*.mjs", "*.ts")),
        (web_root / "src", ("*.js", "*.ts", "*.tsx", "*.html")),
        (web_root / "docs" / "plugins", ("*.d.ts", "plugin-sdk.json")),
    ):
        for g in globs:
            files += [
                p
                for p in folder.rglob(g)
                if not SKIP_PARTS & set(p.relative_to(folder).parts) and not TEST_FILE.search(p.name)
            ]
    return sorted(set(files))


def _doc(path: Path) -> dict[str, list[dict[str, object]]]:
    doc: dict[str, list[dict[str, object]]] = json.loads(path.read_text(encoding="utf-8"))
    return doc


def load_allowlist(path: Path = ALLOWLIST) -> dict[str, str | list[str]]:
    """Tier 1: ``{file: reason}`` for whole files, or ``{file: [line substrings]}`` when an
    entry allows only the lines that contain one of its ``line_contains``."""
    out: dict[str, str | list[str]] = {}
    for e in _doc(path)["files"]:
        lines = e.get("line_contains")
        out[str(e["file"])] = [str(x) for x in lines] if isinstance(lines, list) and lines else str(e["reason"])
    return out


def load_vocab_ceilings(path: Path = ALLOWLIST) -> dict[str, int]:
    """Tier 2: ``{file: max_hits}`` from the ``if_vocab`` (core) and ``if_vocab_sdk`` (SDK) sections."""
    doc = _doc(path)
    out: dict[str, int] = {}
    for section in ("if_vocab", "if_vocab_sdk"):
        for e in doc.get(section, []):
            out[str(e["file"])] = int(str(e["max_hits"]))
    return out


def run(
    web_root: Path,
    allowlist: dict[str, str | list[str]] | None = None,
    ceilings: dict[str, int] | None = None,
) -> dict[str, object]:
    """Scan ``web_root``. With no ``allowlist`` both tiers come from the allowlist file;
    a caller that passes ``allowlist`` and no ``ceilings`` gets no IF_VOCAB entries."""
    allowed = load_allowlist() if allowlist is None else allowlist
    if ceilings is None:
        ceilings = load_vocab_ceilings() if allowlist is None else {}
    problems: list[dict[str, object]] = []
    allowed_hits: dict[str, int] = {}
    vocab_counts: dict[str, int] = {}
    for path in core_files(web_root):
        if path.resolve() == Path(__file__).resolve():
            continue
        rel = path.relative_to(web_root).as_posix()
        vocab = vocab_hits(path)
        if vocab:
            vocab_counts[rel] = len(vocab)
            ceiling = ceilings.get(rel)
            if ceiling is None:
                problems += [
                    {"file": rel, "line": line, "word": word, "problem": "IF vocabulary in the core"}
                    for line, word in vocab
                ]
            elif len(vocab) > ceiling:
                problems.append(
                    {
                        "file": rel,
                        "line": vocab[0][0],
                        "word": ", ".join(sorted({w for _, w in vocab})),
                        "problem": f"IF vocabulary grew: {len(vocab)} hits, max_hits {ceiling}",
                        "hits": [list(h) for h in vocab],
                    }
                )
        hits = python_hits(path) if path.suffix == ".py" else js_hits(path)
        if not hits:
            continue
        rule = allowed.get(rel)
        if isinstance(rule, list):
            # Only the named lines are allowed; any other hit in the file is a problem.
            text = path.read_text(encoding="utf-8-sig").splitlines()
            ok = [(n, w) for n, w in hits if 0 < n <= len(text) and any(sub in text[n - 1] for sub in rule)]
            if ok:
                allowed_hits[rel] = len(ok)
            hits = [h for h in hits if h not in ok]
        elif rule is not None:
            allowed_hits[rel] = len(hits)
            continue
        problems += [
            {"file": rel, "line": line, "word": word, "problem": "incompressible physics in the core"}
            for line, word in hits
        ]
    for rel in sorted(set(allowed) - set(allowed_hits)):
        problems.append({"file": rel, "line": 0, "word": "", "problem": "allowlisted but has no hit (remove the entry)"})
    for rel, ceiling in sorted(ceilings.items()):
        n = vocab_counts.get(rel, 0)
        if n < ceiling:
            what = f"lower max_hits to {n}" if n else "no IF vocabulary left (remove the entry)"
            problems.append({"file": rel, "line": 0, "word": "", "problem": what})
    return {"ok": not problems, "allowed": allowed_hits, "if_vocab": vocab_counts, "problems": problems}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--web-root", type=Path, default=WEB_ROOT)
    args = p.parse_args(argv)
    report = run(args.web_root)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
