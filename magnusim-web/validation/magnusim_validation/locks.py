"""The locks: every committed value judged against its case's band as it stands now.

The tolerances were locked on 2026-11-07, after Daniel reviewed the second full run of the whole
set (46 of its 48 values inside their bands). A run's ``result.json`` keeps the verdict its own
evaluation gave (the committed runs were evaluated before the lock: ``report_only``), so the
report judges each value again against its case's tolerance (``evaluate.specs_of``): a locked
band gives ``pass`` or ``fail``; a report-only band (``Tolerance.report_only``, a known limit) or
one not locked yet gives ``report_only`` and never fails.

A locked value outside its band, a locked value the run did not give, a locked value from a run
that did not end ok (a solve whose health failed, a transient that never settled: its values are
kept, and may sit inside their bands), and a band or a reference that is not the one the run was
compared with (changed after the run: locking moves no band) are failures: ``report`` and
``report --check`` say which and exit 1, so ``npm run test:validation`` fails on them too, beside
its own check of each new run's verdicts. Such a locked value reads FAIL with the reason
(``verdict_why``), never pass.
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


def _ref(value: Any, unit: str) -> str:
    return f"{float(value):g}{(' ' + unit) if unit else ''}" if value is not None else "none"


def judge(results: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """``results`` judged by the locks (copies: each quantity's ``label``, ``tolerance`` and
    ``verdict`` as its case gives them now, the verdict its run gave in ``verdict_at_run``, the band
    it was compared with in ``tolerance_at_run`` when that is not its band now, and why a locked
    value fails although it is inside its band in ``verdict_why``) and the failures, in plain words
    (none when every locked value passes). Judging judged results again gives the same."""
    judged: list[dict[str, Any]] = []
    failures: list[str] = []
    for res in results:
        case = cases.get(res["case"])
        specs = {s.key: s for s in specs_of(case, res["variant"])}
        status = str(res.get("status"))
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
            unit = str(q.get("unit") or "")
            ran = q.get("tolerance_at_run") or q.get("tolerance") or {}
            ref = q.get("reference") or {}
            has = q.get("value") is not None
            why: list[str] = []
            if (ran.get("rel_pct"), ran.get("abs_tol")) != (tol.rel_pct, tol.abs_tol):
                q["tolerance_at_run"] = copy.deepcopy(ran)
                why.append(f"its run was compared with the band {_band(ran, unit)}, not its band now, {_band(tol, unit)}")
            if (ref.get("value"), ref.get("unit", "")) != (spec.reference.value, spec.reference.unit):
                why.append(f"its run was compared with the reference {_ref(ref.get('value'), str(ref.get('unit') or ''))}, "
                           f"not its reference now, {_ref(spec.reference.value, spec.reference.unit)}")
            if has and tol.locked and status != "ok":
                why.append(f"its run did not end ok ({status.replace('_', ' ')}), so its value cannot pass")
            failures.extend(f"{name}: {w} (run it again)" for w in why)
            q.setdefault("verdict_at_run", q.get("verdict"))
            q["label"] = spec.label
            q["tolerance"] = tol.as_dict()
            q["verdict"] = verdict_of(tol, bool(q.get("within")) if has else None)
            q.pop("verdict_why", None)
            if has and tol.locked and why:
                q["verdict"] = "fail"
                q["verdict_why"] = "; ".join(w.split(", so ")[0] for w in why)
            elif q["verdict"] == "fail":
                err = q.get("error") or {}
                off = (f"{err['rel_pct']:+.2f} %" if err.get("rel_pct") is not None and tol.abs_tol is None
                       else f"{float(err.get('abs') or 0):+.3g}{(' ' + unit) if unit else ''}")
                failures.append(f"{name}: {float(q['value']):.5g} against {q['reference']['value']:g} ({off}) is outside "
                                f"its locked band {_band(tol, unit)}")
            elif q["verdict"] == "missing" and tol.locked:
                failures.append(f"{name}: no value, and its band is locked ({status})")
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
