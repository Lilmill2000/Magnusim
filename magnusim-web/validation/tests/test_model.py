"""References, tolerances and the comparison of a run's value with them; the result checker."""

from __future__ import annotations

import pytest
from magnusim_validation.model import QuantitySpec, Reference, Tolerance, compare, error_of
from magnusim_validation.result import problems

REF = Reference(value=64.0, unit="", kind="exact", confidence="CONFIRMED", citation="A. Author (1900), J. 1:1-2",
                where="eq. 1", conditions="Re = 100")


def spec(locked: bool = False) -> QuantitySpec:
    return QuantitySpec(key="fRe", label="f Re", unit="", how="a fit", source="route:/api/plot-over-path",
                        reference=REF, tolerance=Tolerance(rel_pct=2.0, locked=locked))


def test_a_reference_must_carry_its_citation_and_conditions():
    with pytest.raises(ValueError):
        Reference(value=1.0, unit="", kind="exact", confidence="CONFIRMED", citation="", where="eq. 1", conditions="x")
    with pytest.raises(ValueError):
        Reference(value=1.0, unit="", kind="guess", confidence="CONFIRMED", citation="c", where="w", conditions="x")
    with pytest.raises(ValueError):
        Reference(value=1.0, unit="", kind="exact", confidence="UNCONFIRMED", citation="c", where="w", conditions="x")
    with pytest.raises(ValueError):
        Reference(value=float("nan"), unit="", kind="exact", confidence="CONFIRMED", citation="c", where="w", conditions="x")


def test_a_reference_of_zero_is_compared_within_an_absolute_band():
    zero = Reference(value=0.0, unit="U", kind="numerical", confidence="CONFIRMED", citation="c", where="w",
                     conditions="x")
    with pytest.raises(ValueError, match="absolute tolerance"):
        QuantitySpec(key="rms", label="RMS", unit="U", how="h", source="s", reference=zero,
                     tolerance=Tolerance(rel_pct=2.0))
    q = QuantitySpec(key="rms", label="RMS", unit="U", how="h", source="s", reference=zero,
                     tolerance=Tolerance(abs_tol=0.01))
    row = compare(q, 0.008)
    assert row["within"] is True and row["error"] == {"abs": 0.008, "rel_pct": None}
    assert compare(q, 0.012)["within"] is False
    assert compare(q, -0.012)["within"] is False


def test_a_tolerance_is_relative_or_absolute():
    for bad in ({}, {"rel_pct": 2.0, "abs_tol": 0.1}, {"rel_pct": 0.0}, {"abs_tol": -1.0}, {"rel_pct": float("inf")}):
        with pytest.raises(ValueError):
            Tolerance(**bad)


def test_report_only_until_locked():
    row = compare(spec(), 63.0)
    assert row["verdict"] == "report_only"
    assert row["within"] is True
    assert row["error"] == pytest.approx({"abs": -1.0, "rel_pct": -1.5625})
    assert compare(spec(), 60.0)["within"] is False
    assert compare(spec(locked=True), 63.0)["verdict"] == "pass"
    assert compare(spec(locked=True), 60.0)["verdict"] == "fail"


def test_a_value_the_run_did_not_give_is_missing():
    for v in (None, float("nan"), float("inf")):
        row = compare(spec(), v)
        assert row["verdict"] == "missing" and row["value"] is None and row["error"] is None


def test_error_of():
    assert error_of(2.1, 2.0) == pytest.approx({"abs": 0.1, "rel_pct": 5.0})
    assert error_of(-1.1, -1.0)["rel_pct"] == pytest.approx(-10.0)
    assert error_of(0.5, 0.0) == {"abs": 0.5, "rel_pct": None}


def _doc(**over):
    doc = {k: {} for k in ("when", "app", "setup", "mesh", "precheck", "run", "series", "shown")}
    doc.update({"schema": "magnusim-validation-result/1", "case": "c", "variant": "v", "title": "t", "group": "g",
                "status": "ok", "status_detail": "", "coarse": False, "warnings": [],
                "quantities": [compare(spec(), 63.0)]})
    doc.update(over)
    return doc


def test_the_result_checker():
    assert problems(_doc()) == []
    assert any("status" in p for p in problems(_doc(status="great")))
    assert any("no compared quantities" in p for p in problems(_doc(quantities=[])))
    q = compare(spec(), 63.0)
    q["reference"] = {**q["reference"], "citation": ""}
    assert any("citation" in p for p in problems(_doc(quantities=[q])))
    q = compare(spec(), 63.0)
    q["how"] = " "
    assert any("empty how" in p for p in problems(_doc(quantities=[q])))
    # An ok result has every value; a failed one may have none.
    missing = compare(spec(), None)
    assert any("no value in an ok result" in p for p in problems(_doc(quantities=[missing])))
    assert problems(_doc(status="mesh_failed", quantities=[missing])) == []
