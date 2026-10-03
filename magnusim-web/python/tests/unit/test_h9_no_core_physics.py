"""gate:h9-no-core-physics and gate:h10-no-core-physics-ui: the core names no incompressible physics in code."""

from __future__ import annotations

import json
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


def _web(tmp_path: Path) -> Path:
    web = tmp_path / "web"
    for d in ("python/cfddesk", "python/tools", "python/sdk/magnusim_sdk", "scripts", "src", "docs/plugins"):
        (web / d).mkdir(parents=True)
    return web


def test_scan_catches_incompressible_joined_by_an_underscore(tmp_path: Path):
    web = _web(tmp_path)
    (web / "scripts" / "label.js").write_text(
        "// Incompressible_Steady-state in a comment\nconst L = 'Incompressible_Steady-state';\nconst M = 'IncompressibleX';\n",
        encoding="utf-8",
    )
    report = core_physics_scan.run(web, {})
    assert [(p["file"], p["line"], p["word"]) for p in report["problems"]] == [
        ("scripts/label.js", 2, "Incompressible")
    ]


def test_scan_catches_new_if_vocabulary_in_a_core_file(tmp_path: Path):
    web = _web(tmp_path)
    (web / "python" / "cfddesk" / "field.py").write_text(
        '"""Colours by magU (docstring: fine)."""\n'
        "# magU in a comment: fine\n"
        'FIELD = "magU"\n'
        "def f(kinematic_viscosity=1.0):\n"
        "    return kinematic_viscosity\n",
        encoding="utf-8",
    )
    (web / "src" / "Panel.tsx").write_text(
        "// 'Air' and Velocity inlet in a comment\n"
        "const name = 'Air';\nconst t = \"Pressure outlet\";\nconst id = 'panel-incompressible-defaults';\n"
        "const air = 'Airfoil';\nconst bc = 'velocity_inlet_fixed';\n",
        encoding="utf-8",
    )
    report = core_physics_scan.run(web, {})
    got = {(p["file"], p["line"], p["word"]) for p in report["problems"]}
    assert got == {
        ("python/cfddesk/field.py", 3, "magU"),
        ("python/cfddesk/field.py", 4, "kinematic_viscosity"),
        ("python/cfddesk/field.py", 5, "kinematic_viscosity"),
        ("src/Panel.tsx", 2, "'Air'"),
        ("src/Panel.tsx", 3, "Pressure outlet"),
        ("src/Panel.tsx", 4, "incompressible-defaults"),
        ("src/Panel.tsx", 6, "velocity_inlet"),
    }
    assert all(p["problem"] == "IF vocabulary in the core" for p in report["problems"])
    assert report["if_vocab"] == {"python/cfddesk/field.py": 3, "src/Panel.tsx": 4}


def test_max_hits_fails_when_the_count_rises_and_when_it_falls(tmp_path: Path):
    web = _web(tmp_path)
    leak = web / "scripts" / "leak.js"
    leak.write_text("const a = 'magU';\nconst b = 'magU';\n", encoding="utf-8")

    assert core_physics_scan.run(web, {}, {"scripts/leak.js": 2})["problems"] == []

    grew = core_physics_scan.run(web, {}, {"scripts/leak.js": 1})["problems"]
    assert [(p["file"], p["problem"]) for p in grew] == [("scripts/leak.js", "IF vocabulary grew: 2 hits, max_hits 1")]
    assert grew[0]["hits"] == [[1, "magU"], [2, "magU"]]

    fell = core_physics_scan.run(web, {}, {"scripts/leak.js": 3})["problems"]
    assert [(p["file"], p["problem"]) for p in fell] == [("scripts/leak.js", "lower max_hits to 2")]

    leak.write_text("const a = 'field';\n", encoding="utf-8")
    gone = core_physics_scan.run(web, {}, {"scripts/leak.js": 2})["problems"]
    assert [(p["file"], p["problem"]) for p in gone] == [
        ("scripts/leak.js", "no IF vocabulary left (remove the entry)")
    ]


def test_a_u_p_pair_passes_only_on_a_legacy_frame_fields_line(tmp_path: Path):
    web = _web(tmp_path)
    (web / "python" / "cfddesk" / "frames.py").write_text(
        'LEGACY_FRAME_FIELDS: tuple[str, ...] = ("U", "p")\n'
        'FRAMES = ["U", "p"]\n'
        'MORE = ("U", "p", "k")\n',
        encoding="utf-8",
    )
    (web / "scripts" / "layout.js").write_text(
        "export const LEGACY_FRAME_FIELDS = Object.freeze(['U', 'p']);\nconst f = x || [ 'U' , 'p' ];\n",
        encoding="utf-8",
    )
    report = core_physics_scan.run(web, {})
    assert {(p["file"], p["line"], p["word"]) for p in report["problems"]} == {
        ("python/cfddesk/frames.py", 2, '["U","p"]'),
        ("scripts/layout.js", 2, "['U','p']"),
    }


def test_the_sdk_and_published_typings_are_scanned_but_prose_is_not(tmp_path: Path):
    web = _web(tmp_path)
    (web / "python" / "sdk" / "magnusim_sdk" / "fluids.py").write_text('NAME = "Air"\n', encoding="utf-8")
    (web / "python" / "sdk" / "magnusim_sdk" / "solver.py").write_text('APP = "simpleFoam"\n', encoding="utf-8")
    (web / "docs" / "plugins" / "plugin-ui.d.ts").write_text(
        "/** magU in a doc comment */\nexport type F = 'magU';\n", encoding="utf-8"
    )
    (web / "docs" / "plugins" / "plugin-sdk.json").write_text('{"bc": "velocity_inlet"}\n', encoding="utf-8")
    (web / "docs" / "plugins" / "API.md").write_text("magU, 'Air' and simpleFoam in prose\n", encoding="utf-8")
    (web / "docs" / "plugins" / "registry.json").write_text('{"bc": "velocity_inlet_fixed"}\n', encoding="utf-8")
    report = core_physics_scan.run(web, {}, {"python/sdk/magnusim_sdk/fluids.py": 1})
    assert {(p["file"], p["line"], p["word"]) for p in report["problems"]} == {
        ("python/sdk/magnusim_sdk/solver.py", 1, "simpleFoam"),
        ("docs/plugins/plugin-ui.d.ts", 2, "magU"),
        ("docs/plugins/plugin-sdk.json", 1, "velocity_inlet"),
    }
    assert report["if_vocab"]["python/sdk/magnusim_sdk/fluids.py"] == 1


def test_the_real_allowlist_ceilings_are_seeded_and_sdk_entries_are_kept_apart():
    doc = json.loads(core_physics_scan.ALLOWLIST.read_text(encoding="utf-8"))
    for section in ("if_vocab", "if_vocab_sdk"):
        for e in doc[section]:
            assert isinstance(e["max_hits"], int) and e["max_hits"] > 0, e
            assert e["reason"].strip(), e
    assert all(
        e["file"].startswith(("python/sdk/magnusim_sdk/", "docs/plugins/")) for e in doc["if_vocab_sdk"]
    )
    assert not any(e["file"].startswith("python/sdk/") for e in doc["if_vocab"])
    w27 = next(e for e in doc["if_vocab"] if e["file"] == "scripts/w27-solve.js")
    assert "runner" in w27["reason"]
