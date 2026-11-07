"""The locks. Daniel (2026-11-07), after reviewing the second full run of the whole set: lock the 46
values inside their bands; k-omega SST on Standard's two (f and f_tau) report-only, shown with their
error and the known-limit note but no pass or fail. A locked value outside its band fails the run
(its verdict, which npm run test:validation checks), the report and its check; a report-only one
never does; the committed results all pass under the locks."""

from __future__ import annotations

import copy
import html
import json
import re
from collections import Counter
from pathlib import Path

import pytest
from magnusim_validation import cases
from magnusim_validation.evaluate import evaluate_dir
from magnusim_validation.paths import RESULTS
from magnusim_validation.plan import make_plan
from magnusim_validation.report import build_all, build_markdown, load_results
from test_cases_2_3 import _pipe_run
from validation_fakes import fake_run

pytestmark = pytest.mark.occt

KNOWN = "report only: known limit of k-omega SST on Standard's tetrahedra"
HEX_SST = "Turbulent pipe, Re = 50 000, Hex-dominant, k-omega SST"


def _committed(variant: str) -> dict:
    return json.loads((RESULTS / "c2_turbulent_pipe" / variant / "result.json").read_text(encoding="utf-8"))


def _moved(res: dict, key: str, value: float) -> dict:
    """``res`` with its ``key`` value moved to ``value``, its error and whether it is inside its band with it."""
    res = copy.deepcopy(res)
    q = next(q for q in res["quantities"] if q["key"] == key)
    ref = q["reference"]["value"]
    q["value"] = value
    q["error"] = {"abs": value - ref, "rel_pct": 100.0 * (value - ref) / abs(ref)}
    q["within"] = abs(q["error"]["rel_pct"]) <= q["tolerance"]["rel_pct"]
    return res


def _commit(root: Path, res: dict) -> None:
    d = root / res["case"] / res["variant"]
    d.mkdir(parents=True, exist_ok=True)
    (d / "result.json").write_text(json.dumps(res), encoding="utf-8")


def _table(text: str) -> list[dict[str, str]]:
    """VALIDATION.md's results table, a row per compared value, by column name."""
    lines = text.splitlines()
    at = next(i for i, line in enumerate(lines) if line.startswith("| Case | Run | Status"))

    def cells(line: str) -> list[str]:
        return [c.strip() for c in re.split(r"(?<!\\)\|", line)[1:-1]]

    head = cells(lines[at])
    out = []
    for line in lines[at + 2:]:
        if not line.startswith("|"):
            break
        out.append(dict(zip(head, cells(line), strict=True)))
    return out


def _paths(tmp_path: Path) -> dict:
    return {"root": tmp_path / "results", "md_path": tmp_path / "VALIDATION.md", "site_dir": tmp_path / "docs" / "validation"}


def test_a_locked_value_outside_its_band_fails_the_report_and_its_check(tmp_path: Path, capsys: pytest.CaptureFixture):
    p = _paths(tmp_path)
    res = _moved(_committed("hexdominant_sst"), "f", 0.0211 * 0.88)  # -12 %, its band ±10 %
    _commit(p["root"], res)
    assert build_all(**p) == 1
    err = capsys.readouterr().err
    assert "FAIL: 1 locked value does not pass (the tolerances were locked on 2026-11-07)" in err
    assert f"{HEX_SST}: f: 0.018568 against 0.0211 (-12.00 %) is outside its locked band ±10 %" in err
    # The report and the page say FAIL beside it; the page's results.json keeps the run's own verdict.
    text = p["md_path"].read_text(encoding="utf-8")
    rows = {r["Quantity"].split(" from ")[1].split(",")[0]: r for r in _table(text)}
    assert rows["the pressure drop"]["Verdict"] == "FAIL" and rows["the wall shear stress"]["Verdict"] == "pass"
    assert "(-12.00 %, band ±10 % (outside), FAIL)" in text
    page = (p["site_dir"] / "index.html").read_text(encoding="utf-8")
    assert "<td class=\"num out\">±10 % (outside)</td><td class=out>FAIL</td>" in page
    q = next(q for q in json.loads((p["site_dir"] / "results.json").read_text(encoding="utf-8"))["results"][0]["quantities"]
             if q["key"] == "f")
    assert q["verdict"] == "fail" and q["verdict_at_run"] == "report_only" and q["tolerance"]["locked"] is True
    # Its check says so too, with the texts up to date.
    assert build_all(check=True, **p) == 1
    err = capsys.readouterr().err
    assert "out of date" not in err and "is outside its locked band ±10 %" in err
    # Back inside its band: both pass.
    _commit(p["root"], _moved(res, "f", 0.0211 * 0.95))
    assert build_all(**p) == 0
    assert build_all(check=True, **p) == 0


def test_a_report_only_value_never_fails(tmp_path: Path):
    p = _paths(tmp_path)
    # The committed run (f -14.25 %, f_tau -17.05 %) with f moved further out still: -40 %.
    _commit(p["root"], _moved(_committed("standard_sst"), "f", 0.0211 * 0.6))
    assert build_all(**p) == 0
    assert build_all(check=True, **p) == 0
    text = p["md_path"].read_text(encoding="utf-8")
    assert [r["Verdict"] for r in _table(text)] == [KNOWN, KNOWN]
    assert [r["Band"] for r in _table(text)] == ["±10 % (outside)", "±10 % (outside)"]
    assert f"(-40.00 %, band ±10 % (outside), {KNOWN})" in text
    flat = " ".join(text.split())
    assert ("Report-only until its limit is fixed, compared and shown with its band and error but with no pass or fail: "
            "Turbulent pipe, Re = 50 000, Standard, k-omega SST: f and f_tau (known limit of k-omega SST on Standard's "
            "tetrahedra)") in flat
    # The case's note says why, and that the two give no pass or fail until the limit is fixed.
    assert "This is a limitation, not fixed" in flat
    assert ("So its two values are report-only (known limit of k-omega SST on Standard's tetrahedra): the tolerances were "
            "locked on 2026-11-07") in flat
    page = (p["site_dir"] / "index.html").read_text(encoding="utf-8")
    assert f"<td>{html.escape(KNOWN, quote=True)}</td>" in page


def test_a_band_changed_after_its_run_fails(tmp_path: Path, capsys: pytest.CaptureFixture):
    """Locking moves no band: a result compared with another band than its case's now fails until it is run again."""
    p = _paths(tmp_path)
    res = copy.deepcopy(_committed("hexdominant_kepsilon"))
    for q in res["quantities"]:
        q["tolerance"]["rel_pct"] = 8.0
        q["within"] = abs(q["error"]["rel_pct"]) <= 8.0
    _commit(p["root"], res)
    assert build_all(**p) == 1
    err = capsys.readouterr().err
    assert ("Turbulent pipe, Re = 50 000, Hex-dominant, k-epsilon: f: its run was compared with the band ±8 %, not its "
            "band now, ±10 % (run it again)") in err


def test_a_locked_value_the_run_did_not_give_fails(tmp_path: Path, capsys: pytest.CaptureFixture):
    p = _paths(tmp_path)
    run_dir = p["root"] / "c1_laminar_pipe" / "hexdominant"
    make_plan(cases.get("c1"), "hexdominant", run_dir, cores=4)
    fake_run(run_dir, lines=False, driver={"outcome": "failed", "failed_step": "mesh", "error": "the mesh failed",
                                           "ids": {}, "app": {}})
    assert evaluate_dir(run_dir)["status"] == "mesh_failed"
    assert build_all(**p) == 1
    err = capsys.readouterr().err
    assert "FAIL: 3 locked values do not pass" in err
    assert "Laminar pipe, Re = 100, Hex-dominant: fRe: no value, and its band is locked (mesh_failed)" in err


def test_a_new_run_is_judged_by_the_locks_when_it_is_evaluated(tmp_path: Path):
    """npm run test:validation fails a run whose result has a value with the verdict fail (a locked value outside
    its band); the same value on Standard with k-omega SST is report-only, and nothing fails."""
    hexd = _pipe_run(tmp_path, "hexdominant_sst", 0.0211 * 0.85)
    std = _pipe_run(tmp_path, "standard_sst", 0.0211 * 0.85)
    assert [(q["key"], q["verdict"]) for q in hexd["quantities"]] == [("f", "fail"), ("f_tau", "fail")]
    assert all(q["tolerance"]["locked"] and q["within"] is False for q in hexd["quantities"])
    assert [(q["key"], q["verdict"]) for q in std["quantities"]] == [("f", "report_only"), ("f_tau", "report_only")]
    assert all(q["tolerance"]["report_only"] == "known limit of k-omega SST on Standard's tetrahedra"
               and not q["tolerance"]["locked"] and q["within"] is False for q in std["quantities"])
    # The other two variants' bands are locked.
    for variant in ("hexdominant_kepsilon", "standard_kepsilon"):
        assert all(s.tolerance.locked and not s.tolerance.report_only for s in cases.get("c2").quantities(variant))


def test_the_committed_results_pass_under_the_locks():
    """The second full run (commit 977c1480): 46 values pass their locked bands, the two of k-omega SST on
    Standard are report-only, and the lock moved no band."""
    results = load_results()
    rows = _table(build_markdown(results))
    assert len(rows) == 48
    assert Counter(r["Verdict"] for r in rows) == {"pass": 46, KNOWN: 2}
    assert {(r["Case"], r["Run"]) for r in rows if r["Verdict"] == KNOWN} == {("Turbulent pipe, Re = 50 000", "Standard, k-omega SST")}
    from magnusim_validation import locks

    judged, failures = locks.judge(results)
    assert failures == []
    assert locks.counts(judged) == {"all": 48, "locked": 46, "known_limit": 2, "not_locked": 0}
    for res, done in zip(results, judged, strict=True):
        for q, j in zip(res["quantities"], done["quantities"], strict=True):
            assert (j["tolerance"]["rel_pct"], j["tolerance"]["abs_tol"]) == (q["tolerance"]["rel_pct"], q["tolerance"]["abs_tol"])
            assert j["within"] is q["within"] and j["verdict_at_run"] == q["verdict"] == "report_only"
            assert j["verdict"] == ("pass" if j["tolerance"]["locked"] else "report_only")
    # Judging judged results again gives the same.
    assert locks.judge(judged) == (judged, [])
