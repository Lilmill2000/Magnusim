"""The core's tests never import the Incompressible Flow package, so the core and the
plugin are tested apart: the plugin's own tests are in
bundled-plugins/incompressible_flow/tests.

Test plugins under tests/fixtures (a folder with a manifest.toml) are plugins
themselves and may name another plugin; they are not scanned.
"""

from __future__ import annotations

import ast
from pathlib import Path

TESTS = Path(__file__).resolve().parents[1]
FIXTURES = TESTS / "fixtures"
PACKAGE = "incompressible_flow"


def _in_fixture_plugin(path: Path) -> bool:
    if FIXTURES not in path.parents:
        return False
    for folder in path.parents:
        if folder == FIXTURES:
            return False
        if (folder / "manifest.toml").is_file():
            return True
    return False


def _imports_package(tree: ast.AST) -> list[int]:
    lines = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names = [node.module]
        else:
            continue
        if any(n == PACKAGE or n.startswith(PACKAGE + ".") for n in names):
            lines.append(node.lineno)
    return lines


def test_core_tests_do_not_import_incompressible_flow():
    offenders = []
    for path in sorted(TESTS.rglob("*.py")):
        if _in_fixture_plugin(path):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
        for line in _imports_package(tree):
            offenders.append(f"{path.relative_to(TESTS.parent).as_posix()}:{line}")
    assert not offenders, (
        "core tests import the Incompressible Flow package (move these tests to "
        "bundled-plugins/incompressible_flow/tests): " + ", ".join(offenders)
    )
