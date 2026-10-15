"""A Heat Transfer run's monitor results and its energy balance (the analysis's ``run_monitors``).

Reads what heat_transfer.functions wrote, as the case's ``w27-case.json`` plans it:

- ``postProcessing/ht_wall_heat_flux/<start>/wallHeatFlux.dat``: per wall patch and
  iteration, the smallest and largest heat flux (W/m²) and the heat through it (W),
  positive into the fluid;
- ``ht_Tavg_<patch>`` / ``ht_Tmax_<patch>``: the area-averaged and the highest
  temperature on a patch (and the patch's area);
- ``ht_probe_<key>/<start>/T``: a thermocouple's temperatures;
- ``ht_enthalpy_<patch>``: the enthalpy the flow carries out through an opening (W).

Every monitor is one row (a thermocouple one row per point) with a series of
samples (heat_transfer.monitors.MONITOR_QUANTITIES). The answer's ``summary`` is
the energy balance: the heat that comes in and goes out through the walls and
the openings, and how far they differ.

A conjugate heat transfer case (its sidecar says ``cht``) is read region by
region: heat_transfer.cht_results.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, TypeGuard

from magnusim_sdk.foam import read_surface_field_value, restart_dat_files

from .monitors import (
    BALANCE_KEY,
    BALANCE_QUANTITIES,
    SURFACE_TEMPERATURE,
    SURFACE_TEMPERATURE_QUANTITIES,
    THERMOCOUPLE,
    THERMOCOUPLE_QUANTITIES,
    WALL_HEAT_FLUX,
    WALL_HEAT_FLUX_QUANTITIES,
)
from .settle import WALL_HEAT_FLUX_OBJECT

# An imbalance above this (%) makes the balance line a warning.
BALANCE_WARN_PCT = 1.0
_TIME_DIR = re.compile(r"\d+(\.\d+)?([eE][-+]?\d+)?")


def _finite(v: Any) -> TypeGuard[float]:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _meta(case_dir: Path) -> dict[str, Any]:
    try:
        doc = json.loads((case_dir / "w27-case.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def read_wall_heat_flux(case_dir: Path) -> dict[float, dict[str, tuple[float, float, float]]]:
    """{time: {patch: (min W/m², max W/m², heat W)}} over every start-time folder (a
    later folder's rows replace the earlier ones from its first time on)."""
    folder = Path(case_dir) / "postProcessing" / WALL_HEAT_FLUX_OBJECT
    if not folder.is_dir():
        return {}
    return read_wall_heat_flux_files(restart_dat_files(folder, "wallHeatFlux"))


def read_wall_heat_flux_files(files: list[Path]) -> dict[float, dict[str, tuple[float, float, float]]]:
    """{time: {patch: (min W/m², max W/m², heat W)}} of a wallHeatFlux object's files,
    oldest first (a later file's rows replace the earlier ones from its first time on)."""
    out: dict[float, dict[str, tuple[float, float, float]]] = {}
    for f in files:
        rows: dict[float, dict[str, tuple[float, float, float]]] = {}
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) < 5:
                continue
            try:
                t, lo, hi, q = float(parts[0]), float(parts[2]), float(parts[3]), float(parts[4])
            except ValueError:
                continue
            rows.setdefault(t, {})[parts[1]] = (lo, hi, q)
        if rows:
            first = min(rows)
            out = {t: v for t, v in out.items() if t < first}
            out.update(rows)
    return out


def read_probe_temperatures(case_dir: Path, key: str) -> tuple[list[list[float]], list[list[Any]]]:
    """(points, rows) of ``postProcessing/<key>/<start>/T``: rows are [t, T_0, T_1, ...]
    (None for a point outside the mesh)."""
    folder = Path(case_dir) / "postProcessing" / key
    points: list[list[float]] = []
    rows: list[list[Any]] = []
    if not folder.is_dir():
        return points, rows
    try:
        times = sorted((d.name for d in folder.iterdir() if d.is_dir() and _TIME_DIR.fullmatch(d.name)), key=float)
    except OSError:
        return points, rows
    for start in times:
        f = folder / start / "T"
        if not f.is_file():
            continue
        these = parse_probe_file(f, points)
        if these:
            first = these[0][0]
            rows = [r for r in rows if r[0] < first] + these
    return points, rows


def parse_probe_file(f: Path, points: list[list[float]] | None = None) -> list[list[Any]]:
    """The rows ``[t, T_0, T_1, ...]`` of one probes file (None for a point outside the
    mesh); its points' coordinates are added to ``points`` when given."""
    these: list[list[Any]] = []
    try:
        text = f.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return these
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            m = re.match(r"^#\s*Probe\s+(\d+)\s*\(([^)]*)\)", line)
            if points is not None and m and int(m.group(1)) >= len(points):
                try:
                    points.append([float(c) for c in m.group(2).split()])
                except ValueError:
                    points.append([])
            continue
        toks = line.split()
        try:
            vals: list[Any] = [float(toks[0])]
            for tok in toks[1:]:
                v = float(tok)
                vals.append(None if v <= -1e299 or not math.isfinite(v) else v)
        except (ValueError, IndexError):
            continue
        these.append(vals)
    return these


def _surface(case_dir: Path, patch: str) -> tuple[float | None, dict[float, float], dict[float, float]]:
    """(area m², {t: T_avg}, {t: T_max}) of one patch."""
    avg = read_surface_field_value(case_dir, f"ht_Tavg_{patch}") or {"area": None, "rows": []}
    mx = read_surface_field_value(case_dir, f"ht_Tmax_{patch}") or {"area": None, "rows": []}
    a = {r[0]: r[1] for r in avg["rows"] if len(r) > 1 and _finite(r[1])}
    m = {r[0]: r[1] for r in mx["rows"] if len(r) > 1 and _finite(r[1])}
    return avg.get("area"), a, m


def _row(plan: dict[str, Any], key: str, series: list[dict[str, Any]], quantities: tuple[str, ...], default: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": plan.get("id"),
        "key": key,
        "name": str(plan.get("name") or "Monitor"),
        "type": plan.get("type"),
        "series": series,
        "last": series[-1] if series else None,
        "quantities": list(quantities),
        "default_quantity": default,
        **extra,
    }


def _wall_heat_flux_row(
    case: Path,
    plan: dict[str, Any],
    whf: dict[float, dict[str, tuple[float, float, float]]],
    *,
    area: float | None = None,
) -> dict[str, Any] | None:
    """A wall heat flux monitor's row; ``area`` (m²) when the caller knows it (a CHT
    case), else the patches' areas from their surface objects."""
    patches = list(plan.get("patches") or [])
    if not patches or not whf:
        return None
    if area is None:
        areas = [(_surface(case, p)[0] or 0.0) for p in patches]
        area = sum(areas) or None
    series = []
    for t in sorted(whf):
        got = [whf[t][p] for p in patches if p in whf[t]]
        if not got:
            continue
        q = sum(g[2] for g in got)
        # The face flux of largest magnitude, with its sign: on a cooled wall the most
        # negative one (each patch's row holds its min and max).
        largest = max((v for g in got for v in (g[0], g[1])), key=abs)
        series.append({"t": t, "Q_W": q, "q_avg_W_m2": q / area if area else None, "q_max_W_m2": largest})
    if not series:
        return None
    return _row(plan, f"htq_{plan.get('id')}", series, WALL_HEAT_FLUX_QUANTITIES, "Q", patches=patches, area_m2=area)


def _surface_row(case: Path, plan: dict[str, Any]) -> dict[str, Any] | None:
    patches = list(plan.get("patches") or [])
    data = [_surface(case, p) for p in patches]
    times = sorted({t for _a, avg, _m in data for t in avg})
    series = []
    for t in times:
        num = den = 0.0
        tmax: float | None = None
        for a, avg, mx in data:
            if t in avg:
                w = a or 1.0
                num += avg[t] * w
                den += w
            if t in mx:
                tmax = mx[t] if tmax is None else max(tmax, mx[t])
        series.append({"t": t, "T_avg_K": num / den if den else None, "T_max_K": tmax})
    if not series:
        return None
    area = sum(a or 0.0 for a, _x, _y in data) or None
    return _row(plan, f"htT_{plan.get('id')}", series, SURFACE_TEMPERATURE_QUANTITIES, "T_avg", patches=patches, area_m2=area)


def _thermocouple_rows(case: Path, plan: dict[str, Any]) -> list[dict[str, Any]]:
    points, rows = read_probe_temperatures(case, str(plan.get("key") or ""))
    want = list(plan.get("points") or [])
    out = []
    for i, point in enumerate(want):
        series = [{"t": r[0], "T_K": r[i + 1] if len(r) > i + 1 else None} for r in rows]
        name = str(plan.get("name") or "Thermocouple")
        if len(want) > 1:
            name = f"{name} · point {i + 1}"
        found = any(s["T_K"] is not None for s in series)
        out.append(
            _row(
                {**plan, "name": name},
                f"{plan.get('key')}_{i}",
                series,
                THERMOCOUPLE_QUANTITIES,
                "T_pt",
                point=point,
                **({} if found or not series else {"note": "This point is outside the fluid."}),
            )
        )
    return out


def _balance_at(walls: list[str], at: dict[str, tuple[float, float, float]], carried: float) -> dict[str, Any]:
    walls_in = walls_out = 0.0
    for p in walls:
        q = at.get(p)
        if q is None:
            continue
        if q[2] >= 0:
            walls_in += q[2]
        else:
            walls_out += -q[2]
    heat_in = walls_in + max(0.0, -carried)
    heat_out = walls_out + max(0.0, carried)
    big = max(heat_in, heat_out)
    return {
        "walls_in_W": walls_in,
        "walls_out_W": walls_out,
        "carried_out_W": carried,
        "heat_in_W": heat_in,
        "heat_out_W": heat_out,
        "imbalance": (heat_in - heat_out) / big if big > 0 else None,
    }


def balance_series(case: Path, meta: dict[str, Any], whf: dict[float, dict[str, tuple[float, float, float]]]) -> list[dict[str, Any]]:
    """The energy balance at every iteration (or time step) both the walls and the
    openings wrote: heat in and out through the walls (wallHeatFlux, positive into the
    fluid) and carried by the flow through the openings (h·phi, out positive)."""
    walls = [str(p) for p in meta.get("wall_patches") or []]
    openings = [str(p) for p in meta.get("opening_patches") or []]
    carried: dict[float, float] = {}
    counted: dict[float, int] = {}
    for p in openings:
        sfv = read_surface_field_value(case, f"ht_enthalpy_{p}")
        for r in (sfv or {}).get("rows", []):
            if len(r) > 1 and _finite(r[1]):
                carried[r[0]] = carried.get(r[0], 0.0) + float(r[1])
                counted[r[0]] = counted.get(r[0], 0) + 1
    if openings:
        times = sorted(t for t in counted if counted[t] == len(openings) and (t in whf or not walls))
    else:
        times = sorted(whf)
    return [{"t": t, **_balance_at(walls, whf.get(t, {}), carried.get(t, 0.0))} for t in times]


def energy_balance(case: Path, meta: dict[str, Any], whf: dict[float, dict[str, tuple[float, float, float]]]) -> dict[str, Any] | None:
    """The last point of :func:`balance_series` (``time`` and the heat flows), or None."""
    series = balance_series(case, meta, whf)
    if not series:
        return None
    last = dict(series[-1])
    last["time"] = last.pop("t")
    return last


def _balance_row(series: list[dict[str, Any]]) -> dict[str, Any] | None:
    points = [
        {
            "t": s["t"],
            "Q_in_W": s["heat_in_W"],
            "Q_out_W": s["heat_out_W"],
            "imbalance_pct": abs(s["imbalance"]) * 100.0 if _finite(s["imbalance"]) else None,
        }
        for s in series
    ]
    if not points or not any(p["Q_in_W"] or p["Q_out_W"] for p in points):
        return None
    return {
        "key": BALANCE_KEY,
        "name": "Energy balance",
        "type": BALANCE_KEY,
        "series": points,
        "last": points[-1],
        "quantities": list(BALANCE_QUANTITIES),
        "default_quantity": "imbalance",
    }


def balance_summary(balance: dict[str, Any] | None, *, transient: bool = False) -> tuple[list[dict[str, Any]], bool]:
    """The energy balance line: "Heat in … · out … · imbalance … %"; empty with no heat at all.

    A transient run is not in balance while it warms or cools: its line says the heat
    being stored ("stored", W: in minus out; negative while the fluid gives heat up)
    and never warns.
    """
    if not balance or not (balance["heat_in_W"] > 0 or balance["heat_out_W"] > 0):
        return [], False
    items: list[dict[str, Any]] = [
        {"label": "Heat in", "value": balance["heat_in_W"], "quantity": "Q", "unit": ""},
        {"label": "out", "value": balance["heat_out_W"], "quantity": "Q", "unit": ""},
    ]
    if transient:
        items.append({"label": "stored", "value": balance["heat_in_W"] - balance["heat_out_W"], "quantity": "Q", "unit": ""})
        return items, False
    imb = balance.get("imbalance")
    if not _finite(imb):
        return items, False
    pct = abs(float(imb)) * 100.0
    items.append({"label": "imbalance", "value": pct, "quantity": "", "unit": "%"})
    return items, pct > BALANCE_WARN_PCT


def run_monitors(case_dir: Path | str) -> dict[str, Any]:
    """``{rho, monitors, custom, balance, summary, summary_warn}`` for the case in ``case_dir``."""
    case = Path(case_dir)
    meta = _meta(case)
    if meta.get("cht"):
        from .cht_results import cht_run_monitors

        return cht_run_monitors(case, meta)
    try:
        rho = float(meta.get("rho") or 0) or None
    except (TypeError, ValueError):
        rho = None
    whf = read_wall_heat_flux(case)
    custom: list[dict[str, Any]] = []
    for plan in meta.get("ht_monitors") or []:
        if not isinstance(plan, dict):
            continue
        kind = plan.get("type")
        if kind == WALL_HEAT_FLUX:
            row = _wall_heat_flux_row(case, plan, whf)
            if row:
                custom.append(row)
        elif kind == SURFACE_TEMPERATURE:
            row = _surface_row(case, plan)
            if row:
                custom.append(row)
        elif kind == THERMOCOUPLE:
            custom.extend(_thermocouple_rows(case, plan))
    series = balance_series(case, meta, whf)
    balance = None
    if series:
        balance = dict(series[-1])
        balance["time"] = balance.pop("t")
    transient = str(meta.get("time_dependency") or "").strip().lower().startswith("transient")
    summary, warn = balance_summary(balance, transient=transient)
    row = _balance_row(series)
    return {
        "rho": rho,
        "monitors": [row] if row else [],
        "custom": custom,
        "balance": balance,
        "summary": summary,
        "summary_warn": warn,
    }
