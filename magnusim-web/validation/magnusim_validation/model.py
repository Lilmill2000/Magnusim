"""What a case compares: each quantity with its reference (the value, its citation, the
conditions it holds for and how sure the value is) and its tolerance, and the comparison of
a run's value with them (``compare``).

Report-only until locked: a quantity's verdict is ``report_only`` (its row still says whether
the value is inside the proposed band) until its tolerance is ``locked``; then it is ``pass`` or
``fail``, and a failed locked quantity fails the run (and blocks a release).
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
        if not math.isfinite(self.value) or self.value == 0:
            raise ValueError("a reference value must be a finite, non-zero number")

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Tolerance:
    """A band around the reference, in per cent of it. ``locked`` once the first full run
    has been reviewed; until then the band is proposed (report-only)."""

    rel_pct: float
    locked: bool = False
    note: str = ""

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


def error_of(value: float, reference: float) -> dict[str, float]:
    """The run's value against the reference: absolute and relative (%) error."""
    return {"abs": value - reference, "rel_pct": 100.0 * (value - reference) / abs(reference)}


def compare(spec: QuantitySpec, value: float | None, *, uncertainty: dict[str, Any] | None = None,
            detail: str = "") -> dict[str, Any]:
    """The quantity's row of ``result.json``: the value, its error against the reference,
    whether it is inside the tolerance band, and the verdict (report-only until locked).
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
    within = abs(err["rel_pct"]) <= spec.tolerance.rel_pct
    row.update({"value": v, "error": err, "within": within})
    if spec.tolerance.locked:
        row["verdict"] = "pass" if within else "fail"
    else:
        row["verdict"] = "report_only"
    return row
