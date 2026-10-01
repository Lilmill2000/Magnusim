"""gate:h9-no-core-physics and gate:h10-no-core-physics-ui: the core names no incompressible physics in code."""

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
    (web / "src" / "panels").mkdir(parents=True)
    (web / "src" / "panels" / "Panel.tsx").write_text(
        "// PIMPLE in a comment\nexport const A = () => <span>{'PIMPLE'}</span>;\n", encoding="utf-8"
    )
    (web / "src" / "panels" / "Panel.test.tsx").write_text("expect('SIMPLE');\n", encoding="utf-8")
    (web / "src" / "shell.html").write_text("<!-- simpleFoam -->\n<p>k-omega SST</p>\n", encoding="utf-8")
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
        ("src/panels/Panel.tsx", 2, "PIMPLE"),
        ("src/shell.html", 2, "k-omega"),
        ("python/tools/gone.py", 0, ""),
    }


def test_scan_catches_the_plugins_analysis_keys_but_not_generated_files(tmp_path: Path):
    """The core used to name the default analysis itself (incompressible_steady in
    Python, Node and the page); it is the plugin's [default_analysis] now."""
    web = tmp_path / "web"
    for d in ("python/cfddesk", "python/tools", "scripts", "src/api"):
        (web / d).mkdir(parents=True)
    (web / "python" / "cfddesk" / "a.py").write_text('DEFAULT = "incompressible_steady"\n', encoding="utf-8")
    (web / "scripts" / "b.js").write_text("export const K = 'incompressible_transient';\n", encoding="utf-8")
    (web / "src" / "api" / "registry.gen.ts").write_text("export type K = 'incompressible_steady';\n", encoding="utf-8")
    report = core_physics_scan.run(web, {})
    assert {(p["file"], p["word"]) for p in report["problems"]} == {
        ("python/cfddesk/a.py", "incompressible_steady"),
        ("scripts/b.js", "incompressible_transient"),
    }


def test_scan_allows_only_the_named_lines_of_a_line_entry(tmp_path: Path):
    web = tmp_path / "web"
    (web / "python" / "cfddesk").mkdir(parents=True)
    (web / "python" / "tools").mkdir(parents=True)
    (web / "scripts").mkdir()
    (web / "src").mkdir()
    (web / "python" / "cfddesk" / "req.py").write_text(
        'REQUIRED = {"flow": "Incompressible Flow"}\nNAME = "Incompressible"\n', encoding="utf-8"
    )
    report = core_physics_scan.run(web, {"python/cfddesk/req.py": ["REQUIRED ="]})
    assert [(p["file"], p["line"], p["word"]) for p in report["problems"]] == [
        ("python/cfddesk/req.py", 2, "Incompressible")
    ]
    assert report["allowed"] == {"python/cfddesk/req.py": 1}
