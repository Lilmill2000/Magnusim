"""The shipped xfoil.exe against the committed golden (NACA 2412, Re 1e6, Mach 0,
Ncrit 9, free transition, α −4…10° in steps of 1°), and the ``xfoil_polar`` job
running the shipped program.

The golden is written by ``python tools/make_xfoil_golden.py`` from the shipped
program and committed. It records the program's SHA-256 and the exact session
the plugin sent, so a changed program or a changed session is caught here and
the golden is remade knowingly. Cl at α = 4° must match within 2 % (gate:h17-e2e),
the other angles within 2 % or 0.005, and the same angles must fail to converge
(none for this case).

xfoil.exe is MIT's Windows build, so these run on Windows; elsewhere they are
skipped with that reason (the plugin says the same in its XFOIL card).
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

from airfoil import naca, settings, xfoil

PLUGIN_DIR = Path(__file__).resolve().parents[1]
if str(PLUGIN_DIR / "tools") not in sys.path:
    sys.path.append(str(PLUGIN_DIR / "tools"))

GOLDEN = PLUGIN_DIR / "tests" / "goldens" / "xfoil_naca2412_re1e6.json"
EXE = xfoil.default_exe()

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="xfoil.exe is MIT's Windows build: it runs on Windows only")


def _golden() -> dict:
    assert GOLDEN.is_file(), "no golden: run python tools/make_xfoil_golden.py with the shipped xfoil.exe and commit it"
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def test_the_program_ships_and_the_golden_names_it():
    # Not skipped anywhere: the plugin ships the program, and the golden is of that program.
    assert EXE.is_file(), "xfoil/bin/xfoil.exe is not shipped"
    golden = _golden()
    assert golden["xfoil"]["sha256"] == hashlib.sha256(EXE.read_bytes()).hexdigest(), (
        "xfoil.exe changed since the golden was made: check the new program, then remake the golden"
    )
    assert golden["xfoil"]["version"] == "6.99"


def test_the_golden_records_the_session_the_plugin_sends():
    """The exact XFOIL settings: what the plugin would send for these inputs today."""
    from make_xfoil_golden import golden_inputs

    golden = _golden()
    airfoil, conditions = golden_inputs()
    assert golden["airfoil"] == airfoil
    assert golden["conditions"] == conditions
    assert golden["iterations"] == xfoil.ITERATIONS == 100
    order = xfoil.sweep_order(settings.alpha_list(conditions))
    assert golden["sweep_order"] == order
    assert golden["session"] == xfoil.build_script(order, conditions).splitlines(), (
        "the XFOIL session changed: remake the golden (python tools/make_xfoil_golden.py) and say why in the commit"
    )
    sec = naca.generate(airfoil["code"], airfoil["points_per_side"], closed_te=airfoil["closed_te"])
    assert golden["section"]["points"] == len(sec.x) == 161


@windows_only
def test_xfoil_naca_2412_matches_the_golden(tmp_path):
    golden = _golden()
    conditions = settings.normalize_conditions(golden["conditions"])
    a = golden["airfoil"]
    sec = naca.generate(a["code"], a["points_per_side"], closed_te=a["closed_te"])
    got = xfoil.run(sec.name, sec.x, sec.y, settings.alpha_list(conditions), conditions, tmp_path / "run")
    assert got.not_converged == golden["not_converged"] == []
    assert got.failed_reported == 0
    by_alpha = {r["alpha"]: r for r in got.rows}
    want = {r["alpha"]: r for r in golden["rows"]}
    assert sorted(by_alpha) == sorted(want) == [float(x) for x in range(-4, 11)]
    assert by_alpha[4.0]["cl"] == pytest.approx(want[4.0]["cl"], rel=0.02)
    for alpha, row in want.items():
        assert by_alpha[alpha]["cl"] == pytest.approx(row["cl"], rel=0.02, abs=0.005), alpha
        assert by_alpha[alpha]["cd"] == pytest.approx(row["cd"], rel=0.02), alpha
    # And it is the real program: NACA 2412 at Re 1e6 has Cl ≈ 0.72 at 4°, zero lift near −2°.
    assert 0.65 < by_alpha[4.0]["cl"] < 0.78
    assert abs(by_alpha[-2.0]["cl"]) < 0.06
    # One Cp(x) curve per converged α, on XFOIL's 160 panel nodes.
    assert len(got.cp) == 15 and len(got.cp["4"]["x"]) == 160


@windows_only
def test_a_real_alpha_that_does_not_converge_is_listed(tmp_path):
    """NACA 0012 at Re 1e5, α 10…20°: XFOIL 6.99 fails at 18° (and converges again at 19°)."""
    conditions = settings.normalize_conditions({"re": 1e5, "alpha_start": 10, "alpha_end": 20, "alpha_step": 1})
    sec = naca.generate("0012")
    got = xfoil.run(sec.name, sec.x, sec.y, settings.alpha_list(conditions), conditions, tmp_path / "run")
    assert got.not_converged == [18.0]
    assert got.failed_reported == 1  # XFOIL's own "VISCAL:  Convergence failed", once
    assert 18.0 not in [r["alpha"] for r in got.rows] and len(got.rows) == 10
    assert xfoil.describe_not_converged(got.not_converged) == ["α = 18°: did not converge"]


class _Events:
    def __init__(self):
        self.items: list[tuple[str, dict]] = []

    def __call__(self, kind, **data):
        self.items.append((kind, data))

    def of(self, kind):
        return [d for k, d in self.items if k == kind]


@windows_only
def test_the_job_finds_the_shipped_program_and_saves_the_polar(project):
    """``xfoil_polar`` with no program given: the shipped xfoil.exe, the study's defaults."""
    from airfoil import store
    from jobs.xfoil_polar import run_job

    data, _scope, sid = project
    data.update_study(sid, settings.defaults(), 1)
    events = _Events()
    assert run_job(sid, data, emit_fn=events) == 0, events.items
    assert events.of("error") == []
    progress = events.of("progress")
    assert [p["done"] for p in progress] == list(range(1, 16))
    assert [p["alpha"] for p in progress] == xfoil.sweep_order(range(-4, 11))
    (result,) = events.of("result")
    assert result == {"engine": "xfoil", "total": 15, "converged": 15, "not_converged": []}
    saved = store.read_result(data, sid, "xfoil")
    golden = _golden()
    want4 = next(r for r in golden["rows"] if r["alpha"] == 4.0)
    got4 = next(r for r in saved["rows"] if r["alpha"] == 4.0)
    assert got4["cl"] == pytest.approx(want4["cl"], rel=0.02)
    assert saved["not_converged"] == [] and len(saved["cp"]) == 15


@windows_only
def test_the_job_logs_each_alpha_that_did_not_converge(project):
    from jobs.xfoil_polar import run_job

    data, _scope, sid = project
    cfg = settings.defaults()
    cfg["airfoil"]["code"] = "0012"
    cfg["conditions"].update({"re": 1e5, "alpha_start": 10.0, "alpha_end": 20.0, "alpha_step": 1.0})
    data.update_study(sid, cfg, 1)
    events = _Events()
    assert run_job(sid, data, emit_fn=events) == 0, events.items
    assert [e["line"] for e in events.of("log")] == ["α = 18°: did not converge"]
    (result,) = events.of("result")
    assert result["not_converged"] == [18.0] and result["converged"] == 10
