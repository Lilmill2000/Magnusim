"""What a case compares: each quantity with its reference (the value, its citation, the
conditions it holds for and how sure the value is) and its tolerance, and the comparison of
a run's value with them (``compare``).

The verdict (``verdict_of``): a ``locked`` band gives ``pass`` or ``fail``, and a failed locked
quantity fails the run and the report's check (and blocks a release); a band that is
``report_only`` (with its reason: a known limit) or not locked yet gives ``report_only``, never a
failure, and its row still says whether the value is inside the band. The tolerances were locked
on 2026-11-07, after Daniel reviewed the second full run of the whole set (``locks.py``).
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Any

KINDS = ("exact", "numerical", "experimental", "correlation")
CONFIDENCE = ("CONFIRMED", "SECONDARY")


@dataclass(frozen=True)
class Reference:
    """A published value. ``citation`` names the authors, year, title, journal or report;
    ``where`` the equation, table or figure; ``conditions`` what it holds for (Re, geometry,
    inlet); ``confidence`` how it was checked (CONFIRMED: read in the primary source or exact;
    SECONDARY: read in a compilation that reproduces it)."""

    value: float
    unit: str
    kind: str
    confidence: str
    citation: str
    where: str
    conditions: str
    note: str = ""

    def __post_init__(self) -> None:
        if self.kind not in KINDS:
            raise ValueError(f"reference kind {self.kind!r} is not one of {KINDS}")
        if self.confidence not in CONFIDENCE:
            raise ValueError(f"reference confidence {self.confidence!r} is not one of {CONFIDENCE}")
        if not (self.citation.strip() and self.where.strip() and self.conditions.strip()):
            raise ValueError("a reference needs its citation, where in it, and its conditions")
        # Zero is a reference too (a difference that should vanish, a profile's RMS
        # difference): it is then compared within an absolute band (Tolerance.abs_tol).
        if not math.isfinite(self.value):
            raise ValueError("a reference value must be a finite number")

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Tolerance:
    """A band around the reference: in per cent of it (``rel_pct``), or in the quantity's own
    unit (``abs_tol``: a reference of zero, a profile within 0.01 U, a vortex centre within
    0.01 L); exactly one of the two. ``locked``: the band gives pass or fail (2026-11-07, after
    Daniel reviewed the second full run of the whole set). ``report_only``: why the band gives no
    pass or fail although the set is locked, in plain words (a known limit; the report shows
    "report only: <why>"); cleared and ``locked`` set once the limit is fixed. Neither: a proposed
    band, not locked yet (report-only)."""

    rel_pct: float | None = None
    locked: bool = False
    note: str = ""
    abs_tol: float | None = None
    report_only: str = ""

    def __post_init__(self) -> None:
        given = [v for v in (self.rel_pct, self.abs_tol) if v is not None]
        if len(given) != 1:
            raise ValueError("a tolerance is either relative (rel_pct) or absolute (abs_tol), one of the two")
        if not (math.isfinite(given[0]) and given[0] > 0):
            raise ValueError("a tolerance must be a finite, positive number")
        if self.locked and self.report_only.strip():
            raise ValueError("a band is locked or report-only (with its reason), not both")

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class QuantitySpec:
    """One compared quantity of a case: what it is, how the run's value is measured
    (``how``), where that value comes from (``source``: ``route:<path>``, ``app_sampling``
    or ``case_file:<file>``), its reference and its tolerance."""

    key: str
    label: str
    unit: str
    how: str
    source: str
    reference: Reference
    tolerance: Tolerance

    def __post_init__(self) -> None:
        if self.tolerance.rel_pct is not None and self.reference.value == 0:
            raise ValueError(f"{self.key}: a reference of zero needs an absolute tolerance (abs_tol)")


def error_of(value: float, reference: float) -> dict[str, float | None]:
    """The run's value against the reference: absolute and relative (%) error (no relative
    error against a reference of zero)."""
    rel = 100.0 * (value - reference) / abs(reference) if reference != 0 else None
    return {"abs": value - reference, "rel_pct": rel}


def verdict_of(tolerance: Tolerance, within: bool | None) -> str:
    """A compared value's verdict: ``missing`` without a value (``within`` None), ``pass`` or
    ``fail`` in a locked band, else ``report_only`` (a report-only band never fails)."""
    if within is None:
        return "missing"
    if tolerance.locked:
        return "pass" if within else "fail"
    return "report_only"


def compare(spec: QuantitySpec, value: float | None, *, uncertainty: dict[str, Any] | None = None,
            detail: str = "") -> dict[str, Any]:
    """The quantity's row of ``result.json``: the value, its error against the reference,
    whether it is inside the tolerance band, and the verdict (``verdict_of``).
    A value the run could not give is ``None``: its verdict is ``missing``."""
    row: dict[str, Any] = {
        "key": spec.key,
        "label": spec.label,
        "unit": spec.unit,
        "value": None,
        "uncertainty": uncertainty,
        "how": spec.how,
        "source": spec.source,
        "reference": spec.reference.as_dict(),
        "tolerance": spec.tolerance.as_dict(),
        "error": None,
        "within": None,
        "verdict": "missing",
        "detail": detail,
    }
    if value is None or not math.isfinite(float(value)):
        return row
    v = float(value)
    err = error_of(v, spec.reference.value)
    tol = spec.tolerance
    if tol.abs_tol is not None:
        within = abs(float(err["abs"] or 0.0)) <= tol.abs_tol
    else:
        within = abs(float(err["rel_pct"] or 0.0)) <= float(tol.rel_pct or 0.0)
    row.update({"value": v, "error": err, "within": within, "verdict": verdict_of(tol, within)})
    return row
