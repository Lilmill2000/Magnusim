"""gate:h9-no-core-physics: the core names no incompressible physics in code."""

from __future__ import annotations

import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(TOOLS))

import core_physics_scan  # noqa: E402


def test_core_has_no_incompressible_physics():
    report = core_physics_scan.run(core_physics_scan.WEB_ROOT)
    assert report["problems"] == []


def test_scan_catches_a_literal_and_a_stale_allowlist_entry(tmp_path: Path):
    web = tmp_path / "web"
    (web / "python" / "cfddesk").mkdir(parents=True)
    (web / "python" / "tools").mkdir(parents=True)
    (web / "scripts").mkdir()
    (web / "python" / "cfddesk" / "leak.py").write_text(
        '"""Mentions simpleFoam in a docstring: fine."""\nAPP = "pimpleFoam"  # simpleFoam in a comment: fine\n',
        encoding="utf-8",
    )
    (web / "scripts" / "leak.js").write_text(
        "// simpleFoam in a comment\n/* kOmegaSST\n block */\nconst url = 'http://x//y';\nconst m = ['kEpsilon'];\n",
        encoding="utf-8",
    )
    report = core_physics_scan.run(web, {"python/tools/gone.py": "old"})
    got = {(p["file"], p["line"], p["word"]) for p in report["problems"]}
    assert got == {
        ("python/cfddesk/leak.py", 2, "pimpleFoam"),
        ("scripts/leak.js", 5, "kEpsilon"),
        ("python/tools/gone.py", 0, ""),
    }
