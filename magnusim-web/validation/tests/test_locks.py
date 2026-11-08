"""The locks. Daniel (2026-11-07), after reviewing the second full run of the whole set: lock the 46
values inside their bands; k-omega SST on Standard's two (f and f_tau) report-only, shown with their
error and the known-limit note but no pass or fail. A locked value outside its band fails the run
(its verdict, which npm run test:validation checks), the report and its check; a report-only one
never does; the committed results all pass under the locks."""

from __future__ import annotations

import copy
import dataclasses
import html
import json
import re
from collections import Counter
from pathlib import Path

import pytest
from magnusim_validation import cases, locks
from magnusim_validation.evaluate import evaluate_dir, specs_of
from magnusim_validation.paths import RESULTS, SITE, WEB
from magnusim_validation.plan import make_plan
from magnusim_validation.report import build_all, build_markdown, load_results
from test_cases_2_3 import _pipe_run
from validation_fakes import fake_run

pytestmark = pytest.mark.occt

KNOWN = "report only: known limit of k-omega SST on Standard's tetrahedra"
HEX_SST = "Turbulent pipe, Re = 50 000, Hex-dominant, k-omega SST"


def _committed(variant: str, case: str = "c2_turbulent_pipe") -> dict:
    return json.loads((RESULTS / case / variant / "result.json").read_text(encoding="utf-8"))


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
    # The run's own verdict stays beside it: the committed run's (it ran on the locked bands, inside them).
    assert q["verdict"] == "fail" and q["verdict_at_run"] == "pass" and q["tolerance"]["locked"] is True
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
    """The committed run (the fourth full run, commit 678cbdbd, the first on the locked bands): 46 values
    pass their locked bands, the two of k-omega SST on Standard are report-only, the lock moved no band,
    and each run's own verdict is the one the locks give."""
    results = load_results()
    rows = _table(build_markdown(results))
    assert len(rows) == 48
    assert Counter(r["Verdict"] for r in rows) == {"pass": 46, KNOWN: 2}
    assert {(r["Case"], r["Run"]) for r in rows if r["Verdict"] == KNOWN} == {("Turbulent pipe, Re = 50 000", "Standard, k-omega SST")}
    judged, failures = locks.judge(results)
    assert failures == []
    assert locks.counts(judged) == {"all": 48, "locked": 46, "known_limit": 2, "not_locked": 0}
    for res, done in zip(results, judged, strict=True):
        for q, j in zip(res["quantities"], done["quantities"], strict=True):
            assert (j["tolerance"]["rel_pct"], j["tolerance"]["abs_tol"]) == (q["tolerance"]["rel_pct"], q["tolerance"]["abs_tol"])
            assert j["within"] is q["within"] and j["verdict_at_run"] == q["verdict"] == j["verdict"]
            assert j["verdict"] == ("pass" if j["tolerance"]["locked"] else "report_only")
    # Judging judged results again gives the same.
    assert locks.judge(judged) == (judged, [])


def test_a_reference_moved_after_its_run_fails(tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch):
    """A band is the reference and its tolerance: a run compared with another reference than its case's now (a corrected
    refs/ file or case) fails the report and its check, and its row reads FAIL with why, not pass, until it is run again."""
    p = _paths(tmp_path)
    res = _committed("hexdominant", "c1_laminar_pipe")
    _commit(p["root"], res)
    c1 = cases.get("c1")
    spec = c1.QUANTITIES["fRe"]
    monkeypatch.setitem(c1.QUANTITIES, "fRe", dataclasses.replace(spec, reference=dataclasses.replace(spec.reference, value=70.0)))
    moved = "its run was compared with the reference 64, not its reference now, 70"
    assert build_all(**p) == 1
    err = capsys.readouterr().err
    assert "FAIL: 1 locked value does not pass" in err
    assert f"Laminar pipe, Re = 100, Hex-dominant: fRe: {moved} (run it again)" in err
    text = p["md_path"].read_text(encoding="utf-8")
    verdicts = {r["Quantity"]: r["Verdict"] for r in _table(text)}
    assert verdicts["Darcy friction factor × Re, developed part (x/D 10 to 13)"] == f"FAIL: {moved}", verdicts
    assert sorted(verdicts.values()) == sorted([f"FAIL: {moved}", "pass", "pass"])
    assert f"band ±2 % (inside), FAIL: {moved})" in text
    page = (p["site_dir"] / "index.html").read_text(encoding="utf-8")
    assert f"<td class=out>FAIL: {moved}</td>" in page
    assert build_all(check=True, **p) == 1
    err = capsys.readouterr().err
    assert "out of date" not in err and f"fRe: {moved} (run it again)" in err
    # Judging judged results again gives the same: the failure stays until the run is run again.
    judged, failures = locks.judge([res])
    assert locks.judge(judged) == (judged, failures) and len(failures) == 1
    # Its reference back: both pass.
    monkeypatch.undo()
    assert build_all(**p) == 0
    assert build_all(check=True, **p) == 0


def test_a_locked_value_from_a_run_that_did_not_end_ok_fails(tmp_path: Path, capsys: pytest.CaptureFixture):
    """A run whose solve's health failed or whose signal never settled keeps its values, and they may sit inside their
    bands: a locked one reads FAIL with why (never pass) and fails the report and its check; a report-only one still
    never fails."""
    p = _paths(tmp_path)
    c1 = dict(_committed("hexdominant", "c1_laminar_pipe"), status="solve_failed", status_detail="run health: failed")
    c6 = dict(_committed("re100", "c6_sphere"), status="not_settled", status_detail="its drag moved 3 % over the last 10 %")
    sst = dict(_committed("standard_sst"), status="not_settled", status_detail="its pressure drop moved")
    for res in (c1, c6, sst):
        assert all(q["within"] for q in res["quantities"] if res is not sst)
        _commit(p["root"], res)
    assert build_all(**p) == 1
    err = capsys.readouterr().err
    assert "FAIL: 5 locked values do not pass" in err
    assert ("Laminar pipe, Re = 100, Hex-dominant: fRe: its run did not end ok (solve failed), so its value cannot pass "
            "(run it again)") in err
    assert "Sphere, Re = 100, steady, Hex-dominant: cd: its run did not end ok (not settled), so its value cannot pass" in err
    assert "Turbulent pipe" not in err
    rows = _table(p["md_path"].read_text(encoding="utf-8"))
    assert [(r["Status"], r["Verdict"]) for r in rows] == (
        [("SOLVE FAILED", "FAIL: its run did not end ok (solve failed)")] * 3
        + [("NOT SETTLED", KNOWN)] * 2
        + [("NOT SETTLED", "FAIL: its run did not end ok (not settled)")] * 2)
    assert all(r["Band"].endswith("(inside)") for r in rows if r["Verdict"] != KNOWN)
    page = (p["site_dir"] / "index.html").read_text(encoding="utf-8")
    assert "<td class=out>FAIL: its run did not end ok (solve failed)</td>" in page and "<td class=in>pass</td>" not in page
    site = json.loads((p["site_dir"] / "results.json").read_text(encoding="utf-8"))["results"]
    assert {(q["verdict"], q["verdict_at_run"]) for r in site for q in r["quantities"] if r["case"] != "c2_turbulent_pipe"} == {
        ("fail", "pass")}
    assert build_all(check=True, **p) == 1
    assert "so its value cannot pass" in capsys.readouterr().err


LOCK_UNSAID = re.compile(r"information|informative|reported only|report[- ]only|not gated", re.IGNORECASE)


def test_no_locked_value_is_called_information_or_reported_only():
    """Daniel locked 46 values (2026-11-07): none of them is named or noted as information or reported only (case 5's
    mean L/D at Re 100 read "information" beside its pass, case 4's top-wall bubble "(reported only)"), and no text says
    so of them."""
    for cid, case in cases.CASES.items():
        for variant in case.VARIANTS:
            for spec in specs_of(case, variant):
                if spec.tolerance.locked:
                    assert not LOCK_UNSAID.search(spec.label), (cid, variant, spec.label)
                    assert not LOCK_UNSAID.search(spec.tolerance.note), (cid, variant, spec.tolerance.note)
    judged = locks.judge(load_results())[0]
    for res in judged:
        for q in res["quantities"]:
            if q["tolerance"]["locked"]:
                assert not LOCK_UNSAID.search(q["label"] + " " + q["tolerance"]["note"]), (res["case"], q["key"])
    said = re.compile(r"(?<!had it )as information|reported only|, information\)")
    for path in (WEB / "validation" / "README.md", WEB / "validation" / "VALIDATION.md", SITE / "index.html",
                 SITE / "results.json", WEB / "validation" / "magnusim_validation" / "cases" / "c5_cylinder.py",
                 WEB / "validation" / "magnusim_validation" / "cases" / "c4_backward_step.py"):
        text = " ".join(path.read_text(encoding="utf-8").split())
        assert said.findall(text) == [], path.name
