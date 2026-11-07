"""The committed results: complete, never coarse, Hex-dominant for every case and Standard on
the pipes as well; VALIDATION.md and the public page are what they give."""

from __future__ import annotations

import pytest
from magnusim_validation import cases
from magnusim_validation.paths import RESULTS
from magnusim_validation.report import build_all, load_results
from magnusim_validation.result import problems

pytestmark = pytest.mark.occt


def test_the_committed_report_and_page_are_what_the_results_give():
    assert build_all(check=True) == 0, "out of date: run npm run validation:report"


def test_every_committed_result_is_complete():
    results = load_results()
    assert results, f"no results under {RESULTS}"
    for res in results:
        assert problems(res) == []
        assert not res["coarse"], f"{res['case']}/{res['variant']} is a coarse run"
        assert res["variant"] in cases.get(res["case"]).VARIANTS
        for q in res["quantities"]:
            if q["value"] is None:
                continue
            ref = q["reference"]["value"]
            assert q["error"]["abs"] == pytest.approx(q["value"] - ref, abs=1e-12)
            # A reference of zero (a difference that should vanish) has no relative error;
            # its band is absolute.
            if ref == 0:
                assert q["error"]["rel_pct"] is None and q["tolerance"]["abs_tol"] is not None
            else:
                assert abs(100 * (q["value"] - ref) / abs(ref) - q["error"]["rel_pct"]) < 1e-9
            band = q["tolerance"]
            inside = (abs(q["error"]["abs"]) <= band["abs_tol"] if band.get("abs_tol") is not None
                      else abs(q["error"]["rel_pct"]) <= band["rel_pct"])
            assert q["within"] is inside
    # Hex-dominant for every case, Standard on the pipes as well (the validation scope), by
    # the mesher each run used.
    by_case: dict[str, set[str]] = {}
    for res in results:
        by_case.setdefault(res["case"], set()).add(str(res["mesh"]["mesher"]))
    for cid, meshers in by_case.items():
        assert "snappy_hexdominant" in meshers, cid
        if "pipe" in cid:
            assert "standard" in meshers, cid


def test_every_committed_result_comes_from_one_commit_with_no_changes_and_its_own_settings():
    """The report is one run of the whole set: every result records the same commit, a tree with no
    changes (driver.gitFacts: tracked changes, and untracked files of the app's) and no settings
    changed by hand (``overrides``), so a probe or a run from a changed tree never reaches it."""
    results = load_results()
    assert results, f"no results under {RESULTS}"
    commits = {str((res.get("app") or {}).get("commit") or "") for res in results}
    assert len(commits) == 1 and "" not in commits, f"the results come from {sorted(commits)}"
    for res in results:
        name = f"{res['case']}/{res['variant']}"
        assert res["app"].get("dirty") is False, f"{name} ran on a tree with changes"
        assert not res.get("overrides"), f"{name} ran with settings changed by hand: {res.get('overrides')}"
