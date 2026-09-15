"""Transient (pimpleFoam) control model — port of w30-transient.js.

Mirrors normalizeTransient / resolveTransientControl / estimateDeltaT /
flowThroughTime and the numbers writers need for controlDict / fvSchemes /
fvSolution. Steady path is untouched.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal, Mapping

TimeScheme = Literal["Euler", "backward"]
TimeStepMode = Literal["adjustable", "fixed"]

TRANSIENT_DEFAULTS: dict[str, Any] = {
    "end_time": 5.0,
    "write_count": 50,
    "time_step_mode": "adjustable",
    "max_co": 1.0,
    "delta_t": None,
    "max_delta_t": None,
    "time_scheme": "Euler",
    "n_outer_correctors": 1,
    "n_correctors": 2,
    "n_non_orth_correctors": 0,
}


def foam_num(v: float | int | None) -> str:
    """Physical time → shortest string OpenFOAM reads back (w30 foamNum)."""
    try:
        n = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "0"
    if not math.isfinite(n):
        return "0"
    if n == 0:
        return "0"
    a = abs(n)
    if 1e-3 <= a < 1e6:
        return f"{float(f'{n:.8g}'):.15g}"
    # Match JS: toExponential(6).replace(/\.?0+e/, 'e')
    s = f"{n:.6e}"
    # trim trailing zeros in mantissa before e
    if "e" in s or "E" in s:
        mant, exp = s.lower().split("e")
        if "." in mant:
            mant = mant.rstrip("0").rstrip(".")
        return f"{mant}e{exp}"
    return s


def _num(v: Any, fallback: float) -> float:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return fallback
    return n if math.isfinite(n) else fallback


def _pos_or_none(v: Any) -> float | None:
    if v is None or v == "" or v == "auto":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) and n > 0 else None


@dataclass(frozen=True)
class TransientControl:
    """Resolved transient knobs ready for dictionary writers."""

    end_time: float
    delta_t: float
    write_interval: float
    adjust_time_step: bool
    max_co: float
    max_delta_t: float
    time_scheme: TimeScheme
    n_outer_correctors: int
    n_correctors: int
    n_non_orthogonal_correctors: int
    # Bookkeeping (optional; not written to FoamFile)
    write_count: int = 50
    time_step_mode: TimeStepMode = "adjustable"
    source: Mapping[str, str] | None = None
    estimate: Mapping[str, Any] | None = None

    @classmethod
    def from_web(cls, d: dict | None, ctx: dict | None = None) -> "TransientControl":
        """normalizeTransient + resolveTransientControl (w30)."""
        t = normalize_transient(d)
        return resolve_transient_control(t, ctx or {})


def normalize_transient(partial: dict | None, base: dict | None = None) -> dict[str, Any]:
    """Coerce a partial / stored transient block (w30 normalizeTransient)."""
    b = {**TRANSIENT_DEFAULTS, **(base or {})}
    p = partial if isinstance(partial, dict) else {}
    out = dict(b)
    if p.get("end_time") is not None or p.get("endTime") is not None:
        raw = p["end_time"] if p.get("end_time") is not None else p.get("endTime")
        v = _num(raw, float(b["end_time"]))
        out["end_time"] = v if v > 0 else float(b["end_time"])
    if p.get("write_count") is not None:
        v = int(round(_num(p["write_count"], float(b["write_count"]))))
        out["write_count"] = min(v, 5000) if v >= 1 else int(b["write_count"])
    if p.get("time_step_mode") is not None:
        s = str(p["time_step_mode"])
        out["time_step_mode"] = (
            "fixed" if ("fixed" in s.lower() or "constant" in s.lower()) else "adjustable"
        )
    if p.get("max_co") is not None:
        v = _num(p["max_co"], float(b["max_co"]))
        out["max_co"] = min(v, 50.0) if v > 0 else float(b["max_co"])
    if "delta_t" in p:
        out["delta_t"] = _pos_or_none(p.get("delta_t"))
    if "max_delta_t" in p:
        out["max_delta_t"] = _pos_or_none(p.get("max_delta_t"))
    if p.get("time_scheme") is not None:
        s = str(p["time_scheme"]).lower()
        out["time_scheme"] = (
            "backward" if ("backward" in s or "2nd" in s or "second" in s) else "Euler"
        )
    if p.get("n_outer_correctors") is not None:
        v = int(round(_num(p["n_outer_correctors"], float(b["n_outer_correctors"]))))
        out["n_outer_correctors"] = min(max(v, 1), 50)
    if p.get("n_correctors") is not None:
        v = int(round(_num(p["n_correctors"], float(b["n_correctors"]))))
        out["n_correctors"] = min(max(v, 1), 10)
    # Accept both JS key and plan key
    raw_non = p.get("n_non_orth_correctors", p.get("n_non_orthogonal_correctors"))
    if raw_non is not None:
        v = int(round(_num(raw_non, float(b["n_non_orth_correctors"]))))
        out["n_non_orth_correctors"] = min(max(v, 0), 5)
    return out


def estimate_delta_t(
    *,
    mesh_meta: dict | None = None,
    n_cells: int | None = None,
    speed_ref: float | None = None,
    max_co: float | None = None,
) -> dict[str, Any] | None:
    """dt ≈ 0.5 · maxCo · h_min / U (w30 estimateDeltaT)."""
    U = max(_num(speed_ref, 0.0), 0.05)
    h: float | None = None
    basis: str | None = None
    meta = mesh_meta or {}
    min_vol = _num(meta.get("min_cell_volume_m3"), float("nan"))
    if min_vol > 0:
        h = min_vol ** (1.0 / 3.0)
        basis = "min_cell"
    sz = meta.get("sizing") if isinstance(meta.get("sizing"), dict) else None
    if not (h and h > 0) and sz:
        cands = [
            _num(sz.get("surface_size_m"), float("nan")),
            _num(sz.get("core_size_m"), float("nan")),
        ]
        cands = [v for v in cands if v > 0]
        if cands:
            h = min(cands)
            basis = "surface_size"
    if not (h and h > 0) and sz and n_cells and n_cells > 0:
        bbox = sz.get("bbox_m")
        if isinstance(bbox, (list, tuple)) and len(bbox) == 3:
            vol = 1.0
            for b in bbox:
                vol *= max(_num(b, 0.0), 1e-9)
            h = ((0.4 * vol) / float(n_cells)) ** (1.0 / 3.0)
            basis = "bbox"
    if not (h and h > 0):
        return None
    co = _num(max_co, float(TRANSIENT_DEFAULTS["max_co"])) or 1.0
    dt = 0.5 * co * (h / U)
    return {"delta_t": dt, "h_m": h, "u_ref": U, "basis": basis}


def flow_through_time(mesh_meta: dict | None, speed_ref: float | None) -> float | None:
    """Longest bbox side / reference speed (w30 flowThroughTime)."""
    meta = mesh_meta or {}
    sz = meta.get("sizing") if isinstance(meta.get("sizing"), dict) else None
    U = _num(speed_ref, 0.0)
    if not sz or U <= 0:
        return None
    bbox = sz.get("bbox_m")
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 3:
        return None
    L = max(_num(b, 0.0) for b in bbox)
    return L / U if L > 0 else None


def resolve_transient_control(
    settings: dict | None, ctx: dict | None = None
) -> TransientControl:
    """Resolve every number the writer needs (w30 resolveTransientControl)."""
    t = normalize_transient(settings)
    c = ctx or {}
    end_time = float(t["end_time"])
    write_count = max(1, int(t["write_count"]))
    write_interval = end_time / write_count
    est = estimate_delta_t(
        mesh_meta=c.get("meshMeta") or c.get("mesh_meta"),
        n_cells=c.get("nCells") if c.get("nCells") is not None else c.get("n_cells"),
        speed_ref=c.get("speedRef") if c.get("speedRef") is not None else c.get("speed_ref"),
        max_co=float(t["max_co"]),
    )
    source: dict[str, str] = {}
    delta_t = t.get("delta_t")
    if not (isinstance(delta_t, (int, float)) and delta_t > 0):
        delta_t = est["delta_t"] if est else write_interval / 100.0
        source["delta_t"] = "auto"
    else:
        source["delta_t"] = "user"
        delta_t = float(delta_t)
    delta_t = min(float(delta_t), write_interval)
    max_delta_t = t.get("max_delta_t")
    if not (isinstance(max_delta_t, (int, float)) and max_delta_t > 0):
        max_delta_t = write_interval
        source["max_delta_t"] = "auto"
    else:
        source["max_delta_t"] = "user"
        max_delta_t = float(max_delta_t)
    if max_delta_t > write_interval:
        max_delta_t = write_interval
        if source.get("max_delta_t") == "user":
            source["max_delta_t"] = "capped"
    adjust = t["time_step_mode"] != "fixed"
    if adjust:
        steps_est = (
            round(end_time / max(est["delta_t"], 1e-12)) if est else None
        )
    else:
        steps_est = round(end_time / delta_t)
    mesh_meta = c.get("meshMeta") or c.get("mesh_meta")
    speed = c.get("speedRef") if c.get("speedRef") is not None else c.get("speed_ref")
    estimate = {
        "delta_t": est["delta_t"] if est else None,
        "h_m": est["h_m"] if est else None,
        "basis": est["basis"] if est else None,
        "u_ref": est["u_ref"] if est else (float(speed) if speed is not None else None),
        "steps": steps_est,
        "flow_through_s": flow_through_time(mesh_meta, speed),
    }
    scheme: TimeScheme = "backward" if t["time_scheme"] == "backward" else "Euler"
    mode: TimeStepMode = "fixed" if t["time_step_mode"] == "fixed" else "adjustable"
    return TransientControl(
        end_time=end_time,
        delta_t=float(delta_t),
        write_interval=float(write_interval),
        adjust_time_step=bool(adjust),
        max_co=float(t["max_co"]),
        max_delta_t=float(max_delta_t),
        time_scheme=scheme,
        n_outer_correctors=int(t["n_outer_correctors"]),
        n_correctors=int(t["n_correctors"]),
        n_non_orthogonal_correctors=int(t["n_non_orth_correctors"]),
        write_count=write_count,
        time_step_mode=mode,
        source=source,
        estimate=estimate,
    )
