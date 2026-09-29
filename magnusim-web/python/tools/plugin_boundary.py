#!/usr/bin/env python3
"""Plugin boundary check (CI job ``plugin-boundary``).

1. The core never imports a bundled plugin's modules.
2. Plugins import only ``magnusim_sdk``, ``cfddesk.registry`` and the standard
   library at module level, plus their own modules; numpy only inside a
   function (imported when used, so registering the plugin stays light).

Checked plugins: every folder in ``bundled-plugins/``, the fixture plugins in
``python/tests/fixtures/plugins/`` (the stub analysis among them) and the
plugin template. The one allowed exception, until H9 moves its code into the
plugin: the Incompressible Flow shell imports the core modules that still hold
its implementation (:data:`H9_EXCEPTIONS`).

CLI: tools/plugin_boundary.py [--web-root PATH]. Prints a JSON report; exit 1 on a violation.
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parents[2]

ALLOWED = ("magnusim_sdk", "cfddesk.registry")
LAZY_ONLY = ("numpy",)
H9_EXCEPTIONS: dict[str, tuple[str, ...]] = {
    "incompressible_flow": ("cfddesk.builtin.incompressible", "cfddesk.builtin.solvers_openfoam"),
}


def _stdlib() -> set[str]:
    names = set(getattr(sys, "stdlib_module_names", ()))
    return names | {"__future__"}


def _imports(path: Path) -> list[tuple[str, bool, int]]:
    """(module, at_module_level, line) for every absolute import in ``path``."""
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    out: list[tuple[str, bool, int]] = []

    def visit(node: ast.AST, top: bool) -> None:
        for child in ast.iter_child_nodes(node):
            nested = isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda))
            if isinstance(child, ast.Import):
                out.extend((alias.name, top, child.lineno) for alias in child.names)
            elif isinstance(child, ast.ImportFrom) and child.module and not child.level:
                out.append((child.module, top, child.lineno))
            visit(child, top and not nested)

    visit(tree, True)
    return out


def _under(name: str, prefix: str) -> bool:
    return name == prefix or name.startswith(prefix + ".")


def _own_modules(plugin_dir: Path) -> set[str]:
    return {p.stem for p in plugin_dir.glob("*.py")} | {p.name for p in plugin_dir.iterdir() if p.is_dir()}


def check_plugin(plugin_dir: Path, key: str) -> list[dict[str, object]]:
    stdlib = _stdlib()
    own = _own_modules(plugin_dir)
    allowed_extra = H9_EXCEPTIONS.get(key, ())
    problems: list[dict[str, object]] = []
    for py in sorted(plugin_dir.rglob("*.py")):
        if "tests" in py.relative_to(plugin_dir).parts:
            continue
        for mod, top, line in _imports(py):
            root = mod.split(".")[0]
            if root in stdlib or root in own:
                continue
            if any(_under(mod, a) for a in ALLOWED) or any(_under(mod, a) for a in allowed_extra):
                continue
            if any(_under(mod, lazy) for lazy in LAZY_ONLY):
                if not top:
                    continue
                why = f"{mod} must be imported inside the function that uses it"
            else:
                why = f"plugins may import only magnusim_sdk, cfddesk.registry and the standard library, not {mod}"
            problems.append({"file": str(py), "line": line, "import": mod, "problem": why})
    return problems


def check_core(core_dirs: list[Path], bundled_names: set[str]) -> list[dict[str, object]]:
    problems: list[dict[str, object]] = []
    banned = {n for n in bundled_names} | {"cfddesk._bundled"}
    for folder in core_dirs:
        for py in sorted(folder.rglob("*.py")):
            if "__pycache__" in py.parts:
                continue
            for mod, _top, line in _imports(py):
                if any(_under(mod, b) for b in banned):
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
    for d in plugin_dirs:
        problems += check_plugin(d, _plugin_key(d))
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
        "exceptions": {k: list(v) for k, v in H9_EXCEPTIONS.items()},
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
