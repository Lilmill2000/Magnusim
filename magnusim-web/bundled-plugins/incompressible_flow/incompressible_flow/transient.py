"""Run control: the transient (pimpleFoam) model and the steady defaults.

The one place the time-step estimate is computed. The written case
(prepare_run → load_run_spec) and the Run panel preview (worker RPC
analysis.run_preview) both call resolve_transient_control with the same
mesh metadata and reference speed, so the Δt a user is shown is the Δt that is
written. TRANSIENT_DEFAULTS / STEADY_DEFAULTS are the only copies of the
defaults: the registered control_schema is built from them and Node and the
page read them from the registry.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

TimeScheme = Literal["Euler", "backward"]
TimeStepMode = Literal["adjustable", "fixed"]

# Steady runs: iteration limit and write interval (in iterations).
STEADY_DEFAULTS: dict[str, Any] = {
    "end_time": 200,
    "write_interval": 50,
}

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
        # JS writes the exponent unpadded with its sign: 1e-4, 2.5e+6.
        return f"{mant}e{int(exp):+d}"
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
    def from_web(cls, d: dict | None, ctx: dict | None = None) -> TransientControl:
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
        out["max_co"] = v if v > 0 else float(b["max_co"])
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
    # A max time step longer than one frame would skip frames: at most one frame
    # interval, as the Run panel has always stored it (ui/transient.ts).
    mdt = out.get("max_delta_t")
    frames = max(1, int(round(_num(out.get("write_count"), 1.0))))
    interval = float(out["end_time"]) / frames if _num(out.get("end_time"), 0.0) > 0 else 0.0
    if isinstance(mdt, (int, float)) and interval > 0 and mdt > interval:
        out["max_delta_t"] = interval
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
    sz = checked if isinstance((checked := meta.get("sizing")), dict) else None
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
    sz = checked if isinstance((checked := meta.get("sizing")), dict) else None
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


_NUM = r"([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)"
_MIN_VOLUME = re.compile(r"Min volume\s*=\s*" + _NUM)
_TOTAL_VOLUME = re.compile(r"Total volume\s*=\s*" + _NUM)


def load_mesh_meta(case_dir: str | Path | None) -> dict[str, Any] | None:
    """Mesh-generation metadata the time-step estimate reads.

    standard-meta.json (recorded cell sizes, bounding box) plus checkMesh's
    smallest and total cell volume from log.checkMesh. None without a case dir.
    """
    if not case_dir:
        return None
    root = Path(case_dir)
    meta: dict[str, Any] = {}
    try:
        raw = json.loads((root / "standard-meta.json").read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            meta = raw
    except (OSError, ValueError):
        meta = {}
    try:
        txt = (root / "log.checkMesh").read_text(encoding="utf-8", errors="replace")
    except OSError:
        txt = ""
    if txt:
        # "Min volume = 4.97e-09. Max volume = ..." — the sentence period is not part of the number.
        mv = _MIN_VOLUME.search(txt)
        tv = _TOTAL_VOLUME.search(txt)
        if mv and float(mv.group(1)) > 0:
            meta["min_cell_volume_m3"] = float(mv.group(1))
        if tv and float(tv.group(1)) > 0:
            meta["total_volume_m3"] = float(tv.group(1))
    return meta


def control_to_web(tc: TransientControl, settings: dict | None = None) -> dict[str, Any]:
    """The resolved control in the shape the run record and the Run panel use.

    The user's settings (normalized) first, then the resolved numbers: Δt and
    max Δt as written, the write interval, adjust flag, which values were
    calculated (source) and the estimate behind them.
    """
    t = normalize_transient(settings)
    return {
        **t,
        "end_time": tc.end_time,
        "write_count": tc.write_count,
        "write_interval": tc.write_interval,
        "delta_t": tc.delta_t,
        "max_delta_t": tc.max_delta_t,
        "adjust_time_step": tc.adjust_time_step,
        "source": dict(tc.source or {}),
        "estimate": dict(tc.estimate or {}),
    }


def describe_transient(ctrl: dict[str, Any] | None) -> str:
    """The run note's summary: "5 s · 50 frames · Co ≤ 1" (or "· fixed Δt 1e-4 s")."""
    c = ctrl or {}
    bits: list[str] = []
    if c.get("end_time") is not None:
        bits.append(f"{foam_num(c['end_time'])} s")
    if c.get("write_count") is not None:
        bits.append(f"{c['write_count']} frames")
    if c.get("adjust_time_step") is False:
        bits.append(f"fixed Δt {foam_num(c.get('delta_t'))} s")
    elif c.get("max_co") is not None:
        bits.append(f"Co ≤ {foam_num(c['max_co'])}")
    return " · ".join(bits)
