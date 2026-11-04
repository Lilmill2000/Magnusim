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
            if q["value"] is not None:
                rel = 100 * (q["value"] - q["reference"]["value"]) / abs(q["reference"]["value"])
                assert abs(rel - q["error"]["rel_pct"]) < 1e-9
    # Hex-dominant for every case, Standard on the pipes as well (the validation scope).
    by_case: dict[str, set[str]] = {}
    for res in results:
        by_case.setdefault(res["case"], set()).add(res["variant"])
    for cid, variants in by_case.items():
        assert "hexdominant" in variants, cid
        if "pipe" in cid:
            assert "standard" in variants, cid
