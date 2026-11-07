"""The locks: every committed value judged against its case's band as it stands now.

The tolerances were locked on 2026-11-07, after Daniel reviewed the second full run of the whole
set (46 of its 48 values inside their bands). A run's ``result.json`` keeps the verdict its own
evaluation gave (the committed runs were evaluated before the lock: ``report_only``), so the
report judges each value again against its case's tolerance (``evaluate.specs_of``): a locked
band gives ``pass`` or ``fail``; a report-only band (``Tolerance.report_only``, a known limit) or
one not locked yet gives ``report_only`` and never fails.

A locked value outside its band, a locked value the run did not give, and a band that is not the
one the run was compared with (a band changed after the run: locking moves no band) are
failures: ``report`` and ``report --check`` say which and exit 1, so ``npm run test:validation``
fails on them too, beside its own check of each new run's verdicts.
"""

from __future__ import annotations

import copy
from typing import Any

from . import cases
from .evaluate import specs_of
from .model import Tolerance, verdict_of

LOCKED_ON = "2026-11-07"
LOCKED_WORDS = f"The tolerances were locked on {LOCKED_ON}, after Daniel reviewed the second full run of the whole set"


def _band(tol: dict[str, Any] | Tolerance, unit: str) -> str:
    rel = tol.get("rel_pct") if isinstance(tol, dict) else tol.rel_pct
    absolute = tol.get("abs_tol") if isinstance(tol, dict) else tol.abs_tol
    if absolute is not None:
        return f"±{float(absolute):g}{(' ' + unit) if unit else ''}"
    return f"±{float(rel):g} %" if rel is not None else "no band"


def _name(case: Any, res: dict[str, Any], key: str) -> str:
    label = case.VARIANT_LABELS.get(res["variant"], res["variant"])
    return f"{case.TITLE}, {label}: {key}"


def judge(results: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """``results`` judged by the locks (copies: each quantity's ``tolerance`` and ``verdict`` as its
    case gives them now, the verdict its run gave in ``verdict_at_run``) and the failures, in
    plain words (none when every locked value passes). Judging judged results again gives the
    same."""
    judged: list[dict[str, Any]] = []
    failures: list[str] = []
    for res in results:
        case = cases.get(res["case"])
        specs = {s.key: s for s in specs_of(case, res["variant"])}
        out = copy.deepcopy(res)
        seen = set()
        for q in out["quantities"]:
            seen.add(q["key"])
            name = _name(case, res, q["key"])
            spec = specs.get(q["key"])
            if spec is None:
                failures.append(f"{name}: not one of the case's compared quantities now (run it again)")
                continue
            tol = spec.tolerance
            ran = q.get("tolerance") or {}
            if (ran.get("rel_pct"), ran.get("abs_tol")) != (tol.rel_pct, tol.abs_tol):
                failures.append(f"{name}: its run was compared with the band {_band(ran, q.get('unit', ''))}, not its band "
                                f"now, {_band(tol, q.get('unit', ''))} (run it again)")
            q.setdefault("verdict_at_run", q.get("verdict"))
            q["tolerance"] = tol.as_dict()
            q["verdict"] = verdict_of(tol, None if q.get("value") is None else bool(q.get("within")))
            if q["verdict"] == "fail":
                err = q.get("error") or {}
                off = (f"{err['rel_pct']:+.2f} %" if err.get("rel_pct") is not None and tol.abs_tol is None
                       else f"{float(err.get('abs') or 0):+.3g}{(' ' + q['unit']) if q.get('unit') else ''}")
                failures.append(f"{name}: {float(q['value']):.5g} against {q['reference']['value']:g} ({off}) is outside "
                                f"its locked band {_band(tol, q.get('unit', ''))}")
            elif q["verdict"] == "missing" and tol.locked:
                failures.append(f"{name}: no value, and its band is locked ({res.get('status')})")
        for key, spec in specs.items():
            if key not in seen and spec.tolerance.locked:
                failures.append(f"{_name(case, res, key)}: not in its result, and its band is locked (run it again)")
        judged.append(out)
    return judged, failures


def counts(results: list[dict[str, Any]]) -> dict[str, int]:
    """How many of the judged ``results``' values are locked, report-only with a reason (a known
    limit), or in a band not locked yet."""
    qs = [q for res in results for q in res["quantities"]]
    locked = sum(1 for q in qs if (q.get("tolerance") or {}).get("locked"))
    known = sum(1 for q in qs if (q.get("tolerance") or {}).get("report_only"))
    return {"all": len(qs), "locked": locked, "known_limit": known, "not_locked": len(qs) - locked - known}
