"""Loads this template from a plugins/ folder and checks the cloned analysis."""

from __future__ import annotations

import shutil
from pathlib import Path

from cfddesk.registry import get_registry, load_all, reset_for_tests

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def test_template_registers(tmp_path: Path):
    web = tmp_path / "web"
    dest = web / "plugins" / "template-demo"
    dest.parent.mkdir(parents=True)
    shutil.copytree(
        PLUGIN_DIR,
        dest,
        ignore=shutil.ignore_patterns("tests", "__pycache__", "*.pyc"),
    )
    reset_for_tests()
    load_all(web_root=web, force=True)
    spec = get_registry("analysis").get("template_demo")
    assert spec.label == "Template"
    assert spec.write_case is not None
