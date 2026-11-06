"""Words the case notes build from a reported run's result (cases 4 to 6): its checkMesh, how
its solve ended, what the pre-run check estimated against what the solve took. A note quotes the
result itself, so it never says what an earlier run of the same settings gave
(``report.case_notes``).
"""

from __future__ import annotations

from typing import Any


def and_list(items: list[str]) -> str:
    """"a", "a and b", "a, b and c"."""
    items = [str(x) for x in items]
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1] if items else ""


def checkmesh_words(res: dict[str, Any]) -> str:
    """"checkMesh OK (its most non-orthogonal face 24.0°, …)" for a result's mesh."""
    from .report import num

    q = (res.get("mesh") or {}).get("quality") or {}
    if not q.get("known"):
        return "checkMesh not recorded"
    head = "checkMesh OK" if q.get("ok") else "checkMesh not OK"
    return (f"{head} (its most non-orthogonal face {num(q.get('max_non_orthogonality'), 3)}°, max skewness "
            f"{num(q.get('max_skewness'), 3)}, max aspect ratio {num(q.get('max_aspect_ratio'), 3)})")


def _residual_history(res: dict[str, Any], name: str) -> tuple[list[float], list[float]]:
    r = (res.get("series") or {}).get("residuals") or {}
    t, v = r.get("t") or [], r.get(name) or []
    pairs = [(float(a), float(b)) for a, b in zip(t, v, strict=False) if a is not None and b is not None and b > 0]
    return [a for a, _ in pairs], [b for _, b in pairs]


def run_words(res: dict[str, Any], *, residual: str = "U") -> str:
    """How a reported run's solve ended, from its result: "met its residual targets at iteration
    548 in 236 s of solve", or for a steady run that stopped at its limit its lowest ``residual``
    residual, the range over its last 10 % of iterations and what its settle histories moved."""
    from .report import cells_text, num

    r = res.get("run") or {}
    solve = f"{num(r.get('wall_s'), 3)} s of solve" if r.get("wall_s") is not None else "an unrecorded solve time"
    if r.get("transient"):
        steps = r.get("time_steps")
        return (f"ran {num(r.get('sim_time'), 4)} s of flow"
                + (f" in {cells_text(steps)} time steps" if steps else "") + f" and {solve}")
    if r.get("converged"):
        return f"met its residual targets at iteration {r.get('converged_at')}, in {solve}"
    text = f"stopped at its limit of {r.get('end_time_set')} iterations without meeting its residual targets ({solve})"
    t, v = _residual_history(res, residual)
    if v:
        i = min(range(len(v)), key=v.__getitem__)
        end = float(r.get("iterations") or t[-1])
        tail = [b for a, b in zip(t, v, strict=True) if a >= 0.9 * end]
        text += f": its lowest {residual} residual was {num(v[i], 2)}, at iteration {int(t[i])}"
        if tail:
            text += f", and over its last 10 % of iterations it stayed between {num(min(tail), 2)} and {num(max(tail), 2)}"
    settle = r.get("settle") or {}
    drifts = [h for h in settle.get("histories") or [] if h.get("drift") is not None]
    if drifts:
        moved = max(float(h["drift"]) for h in drifts)
        text += (f"; {and_list([str(h['label']) for h in drifts])} moved by at most {num(moved, 2)} of their values "
                 "over those iterations")
        if settle.get("settled"):
            text += ": settled, by this harness's rule, without meeting its targets"
        elif settle.get("settled") is False:
            text += ": not settled"
    return text


def precheck_note(by: dict[str, dict[str, Any]], labels: dict[str, str]) -> str | None:
    """The pre-run check's time estimates (each run's facts give its whole line) against what
    the solves took: "~21 minutes" before a 112 s solve reads as the check's own rate, not this run's."""
    from .report import num

    parts = []
    default = False
    for v, label in labels.items():
        res = by.get(v)
        if not res:
            continue
        est = (res.get("precheck") or {}).get("estimate") or {}
        wall = est.get("wall_s")
        took = (res.get("run") or {}).get("wall_s")
        if wall is None or took is None:
            continue
        default = default or est.get("rate_source") == "default"
        parts.append(f"{label} about {num(float(wall) / 60.0, 2)} minutes, the solve {num(took, 3)} s")
    if not parts:
        return None
    rate = " from its default solve rate" if default else ""
    return (f"The pre-run check's time estimates{rate} against what the solves took: " + "; ".join(parts)
            + " (each run's facts give the check's whole line).")
