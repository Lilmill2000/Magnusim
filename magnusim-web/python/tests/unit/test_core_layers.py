"""Core package dependencies (tools/core_layers.py, the CI step in plugin-boundary)."""

from __future__ import annotations

from pathlib import Path

import core_layers


def _tree(root: Path, files: dict[str, str]) -> Path:
    for rel, body in files.items():
        path = root / "cfddesk" / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    return root / "cfddesk"


def test_the_core_keeps_its_package_graph():
    report = core_layers.run()
    assert report["ok"], report["problems"]
    # worker is the top: nothing imports it.
    assert all("worker" not in targets for targets in report["graph"].values())


def test_a_new_dependency_is_a_problem(tmp_path: Path):
    root = _tree(
        tmp_path,
        {
            "__init__.py": "",
            "wsl/__init__.py": "",
            "wsl/run.py": "def go():\n    from cfddesk.mesh import grid\n",
            "mesh/__init__.py": "",
            "mesh/grid.py": "from cfddesk.wsl import run\n",
        },
    )
    report = core_layers.run(root, {"<top>": set(), "wsl": set(), "mesh": {"wsl"}})
    assert not report["ok"]
    [p] = report["problems"]
    assert p["file"] == "cfddesk/wsl/run.py" and p["line"] == 2
    assert "cfddesk.wsl may not import cfddesk.mesh" in p["problem"]
    assert report["cycles"] == [["mesh", "wsl"]]


def test_relative_imports_count(tmp_path: Path):
    root = _tree(
        tmp_path,
        {
            "__init__.py": "",
            "mesh/__init__.py": "from ..wsl import run\n",
            "mesh/sub/__init__.py": "",
            "mesh/sub/deep.py": "from ...case import writer\nfrom .. import grid\n",
            "mesh/grid.py": "",
            "wsl/__init__.py": "",
            "wsl/run.py": "",
            "case/__init__.py": "",
            "case/writer.py": "",
        },
    )
    report = core_layers.run(root, {"<top>": set(), "mesh": set(), "wsl": set(), "case": set()})
    found = sorted(p["problem"].split(" (")[0] for p in report["problems"])
    assert found == [
        "cfddesk.mesh may not import cfddesk.case",
        "cfddesk.mesh may not import cfddesk.wsl",
    ]


def test_unused_allowance_and_unknown_package_are_problems(tmp_path: Path):
    root = _tree(
        tmp_path,
        {
            "__init__.py": "",
            "mesh/__init__.py": "",
            # A byte order mark does not stop the parse.
            "results/__init__.py": "﻿import json\n",
        },
    )
    report = core_layers.run(root, {"<top>": set(), "mesh": {"results"}})
    problems = sorted(p["problem"] for p in report["problems"])
    assert problems == [
        "cfddesk.mesh no longer imports cfddesk.results: remove it from ALLOWED",
        "cfddesk.results is not in ALLOWED: list what it may import",
    ]
