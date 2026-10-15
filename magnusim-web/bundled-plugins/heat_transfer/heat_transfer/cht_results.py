"""A conjugate heat transfer run's monitor results and energy balance (heat_transfer.results
calls it for a case whose ``w27-case.json`` says ``cht``).

Reads what heat_transfer.cht_functions wrote, region by region:

- ``postProcessing/<r>/ht_wall_heat_flux_<r>/<start>/wallHeatFlux.dat``: per patch of
  region r (its outer walls and its interfaces) and iteration, the smallest and
  largest heat flux (W/m²) and the heat through it (W), positive into the region;
- ``postProcessing/<r>/ht_Tavg_<r>_<patch>`` / ``ht_Tmax_<r>_<patch>``: a monitored
  boundary's part in region r;
- ``postProcessing/<key>/<r>/<start>/T``: a thermocouple's points in region r;
- ``postProcessing/<f>/ht_enthalpy_<patch>``: the enthalpy the flow carries out of
  an opening of the fluid region f (W);
- ``postProcessing/<s>/ht_Tbody_avg_<s>`` / ``ht_Tbody_max_<s>``: each solid's
  average and highest temperature.

The energy balance: heat in = the heat sources + the heat into the bodies through
their outer faces + the enthalpy the flow brings in; heat out = the heat out
through the outer faces + the enthalpy the flow takes out. The faces two bodies
share are inside: their heat is not counted.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from magnusim_sdk.foam import (
    function_object_files,
    parse_surface_field_value,
    read_surface_field_value,
)

from .cht_functions import body_objects, surface_objects, wall_heat_flux_object
from .monitors import (
    BALANCE_KEY,
    BALANCE_QUANTITIES,
    SURFACE_TEMPERATURE,
    SURFACE_TEMPERATURE_QUANTITIES,
    THERMOCOUPLE,
    WALL_HEAT_FLUX,
)
from .results import (
    _finite,
    _row,
    _wall_heat_flux_row,
    balance_summary,
    parse_probe_file,
    read_wall_heat_flux_files,
)

Whf = dict[float, dict[str, tuple[float, float, float]]]


def region_wall_heat_flux(case: Path, region: str) -> Whf:
    """{time: {patch: (min, max, W)}} of a region's wallHeatFlux object."""
    return read_wall_heat_flux_files(function_object_files(case, wall_heat_flux_object(region), "wallHeatFlux.dat", region))


def _volume_rows(case: Path, name: str, region: str) -> dict[float, float]:
    rows: dict[float, float] = {}
    for f in function_object_files(case, name, "volFieldValue.dat", region):
        try:
            parsed = parse_surface_field_value(f.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        these = {r[0]: r[1] for r in parsed["rows"] if len(r) > 1 and _finite(r[1])}
        if these:
            first = min(these)
            rows = {t: v for t, v in rows.items() if t < first}
            rows.update(these)
    return rows


def _surface(case: Path, region: str, patch: str) -> tuple[float | None, dict[float, float], dict[float, float]]:
    avg_name, max_name = surface_objects(region, patch)
    avg = read_surface_field_value(case, avg_name, region) or {"area": None, "rows": []}
    mx = read_surface_field_value(case, max_name, region) or {"area": None, "rows": []}
    a = {r[0]: r[1] for r in avg["rows"] if len(r) > 1 and _finite(r[1])}
    m = {r[0]: r[1] for r in mx["rows"] if len(r) > 1 and _finite(r[1])}
    return avg.get("area"), a, m


def _wall_rows(case: Path, plan: dict[str, Any], whf: dict[str, Whf]) -> dict[str, Any] | None:
    """A wall heat flux monitor: the heat through its boundaries' parts, every region summed."""
    targets = list(plan.get("targets") or [])
    if not targets:
        return None
    merged: Whf = {}
    areas = 0.0
    for t in targets:
        r, p = str(t["region"]), str(t["patch"])
        key = f"{r}/{p}"
        for time, rows in whf.get(r, {}).items():
            if p in rows:
                merged.setdefault(time, {})[key] = rows[p]
        areas += _surface(case, r, p)[0] or 0.0
    keys = [f"{t['region']}/{t['patch']}" for t in targets]
    return _wall_heat_flux_row(case, {**plan, "patches": keys}, merged, area=areas or None)


def _surface_row(case: Path, plan: dict[str, Any]) -> dict[str, Any] | None:
    targets = list(plan.get("targets") or [])
    data = [_surface(case, str(t["region"]), str(t["patch"])) for t in targets]
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
    return _row(plan, f"htT_{plan.get('id')}", series, SURFACE_TEMPERATURE_QUANTITIES, "T_avg",
                patches=list(plan.get("patches") or []), area_m2=area)


def _thermocouple_rows(case: Path, plan: dict[str, Any]) -> list[dict[str, Any]]:
    from .monitors import THERMOCOUPLE_QUANTITIES

    want = list(plan.get("points") or [])
    by_point: dict[int, list[tuple[float, Any]]] = {}
    region_of: dict[int, str] = {}
    for probe in plan.get("probes") or []:
        region = str(probe["region"])
        rows: list[list[Any]] = []
        for f in function_object_files(case, str(probe["key"]), "T", region):
            these = parse_probe_file(f)
            if these:
                first = these[0][0]
                rows = [r for r in rows if r[0] < first] + these
        for j, i in enumerate(probe["index"]):
            region_of[int(i)] = region
            by_point[int(i)] = [(r[0], r[j + 1] if len(r) > j + 1 else None) for r in rows]
    out = []
    for i, point in enumerate(want):
        series = [{"t": t, "T_K": v} for t, v in by_point.get(i, [])]
        name = str(plan.get("name") or "Thermocouple")
        if len(want) > 1:
            name = f"{name} · point {i + 1}"
        found = any(s["T_K"] is not None for s in series)
        extra: dict[str, Any] = {"point": point}
        if i in region_of:
            extra["region"] = region_of[i]
        if not found:
            extra["note"] = "This point is outside the mesh." if i in (plan.get("outside") or []) or not series else (
                "This point is outside the mesh."
            )
        out.append(_row({**plan, "name": name}, f"{plan.get('key')}_{i}", series, THERMOCOUPLE_QUANTITIES, "T_pt", **extra))
    return out


def _body_rows(case: Path, meta: dict[str, Any]) -> list[dict[str, Any]]:
    """One row per solid region: its average and highest temperature."""
    out = []
    for row in meta.get("region_rows") or []:
        if not isinstance(row, dict) or row.get("role") != "solid":
            continue
        r = str(row["name"])
        avg_name, max_name = body_objects(r)
        avg = _volume_rows(case, avg_name, r)
        mx = _volume_rows(case, max_name, r)
        times = sorted(set(avg) | set(mx))
        series = [{"t": t, "T_avg_K": avg.get(t), "T_max_K": mx.get(t)} for t in times]
        if not series:
            continue
        out.append(
            _row(
                {"id": f"body_{r}", "name": str(row.get("label") or r), "type": "ht_body_temperature"},
                f"htB_{r}",
                series,
                SURFACE_TEMPERATURE_QUANTITIES,
                "T_max",
                region=r,
            )
        )
    return out


def balance_series(case: Path, meta: dict[str, Any], whf: dict[str, Whf]) -> list[dict[str, Any]]:
    """The energy balance at every iteration (or time step) every region wrote."""
    sources = float(meta.get("sources_W") or 0.0)
    fluid = str(meta.get("fluid_region") or "")
    openings = [str(p) for p in meta.get("opening_patches") or []]
    carried: dict[float, float] = {}
    counted: dict[float, int] = {}
    for p in openings:
        sfv = read_surface_field_value(case, f"ht_enthalpy_{p}", fluid)
        for r in (sfv or {}).get("rows", []):
            if len(r) > 1 and _finite(r[1]):
                carried[r[0]] = carried.get(r[0], 0.0) + float(r[1])
                counted[r[0]] = counted.get(r[0], 0) + 1
    walls: dict[str, list[str]] = {}
    for row in meta.get("region_rows") or []:
        if isinstance(row, dict) and row.get("walls"):
            walls[str(row["name"])] = [str(p) for p in row["walls"]]
    wall_regions = [r for r in walls if whf.get(r)]
    times_sets = [set(whf[r]) for r in wall_regions]
    if openings:
        times_sets.append({t for t in counted if counted[t] == len(openings)})
    if not times_sets:
        return []
    times = sorted(set.intersection(*times_sets))
    out = []
    for t in times:
        walls_in = walls_out = 0.0
        for r in wall_regions:
            at = whf[r].get(t, {})
            for p in walls[r]:
                q = at.get(p)
                if q is None:
                    continue
                if q[2] >= 0:
                    walls_in += q[2]
                else:
                    walls_out += -q[2]
        c = carried.get(t, 0.0)
        heat_in = sources + walls_in + max(0.0, -c)
        heat_out = walls_out + max(0.0, c)
        big = max(heat_in, heat_out)
        out.append(
            {
                "t": t,
                "sources_W": sources,
                "walls_in_W": walls_in,
                "walls_out_W": walls_out,
                "carried_out_W": c,
                "heat_in_W": heat_in,
                "heat_out_W": heat_out,
                "imbalance": (heat_in - heat_out) / big if big > 0 else None,
            }
        )
    return out


def interface_heat(meta: dict[str, Any], whf: dict[str, Whf]) -> list[dict[str, Any]]:
    """The heat through each interface at the last iteration: ``{from, to, W}`` (W from the
    first region into the second; the wallHeatFlux of the second region's side)."""
    out = []
    labels = {str(r["name"]): str(r.get("label") or r["name"]) for r in meta.get("region_rows") or [] if isinstance(r, dict)}
    for pair in meta.get("touching") or []:
        a, b = str(pair[0]), str(pair[1])
        rows = whf.get(b) or {}
        if not rows:
            continue
        last = rows[max(rows)]
        q = last.get(f"{b}_to_{a}")
        if q is None:
            continue
        out.append({"from": a, "to": b, "from_label": labels.get(a, a), "to_label": labels.get(b, b), "W": q[2]})
    return out


def cht_run_monitors(case: Path, meta: dict[str, Any]) -> dict[str, Any]:
    """``{rho, monitors, custom, balance, summary, summary_warn, interfaces}`` of a CHT case."""
    try:
        rho = float(meta.get("rho") or 0) or None
    except (TypeError, ValueError):
        rho = None
    regions = [str(r["name"]) for r in meta.get("region_rows") or [] if isinstance(r, dict) and r.get("name")]
    whf = {r: region_wall_heat_flux(case, r) for r in regions}
    custom: list[dict[str, Any]] = []
    for plan in meta.get("ht_monitors") or []:
        if not isinstance(plan, dict):
            continue
        kind = plan.get("type")
        if kind == WALL_HEAT_FLUX:
            row = _wall_rows(case, plan, whf)
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
    points = [
        {
            "t": s["t"],
            "Q_in_W": s["heat_in_W"],
            "Q_out_W": s["heat_out_W"],
            "imbalance_pct": abs(s["imbalance"]) * 100.0 if _finite(s["imbalance"]) else None,
        }
        for s in series
    ]
    rows: list[dict[str, Any]] = []
    if points and any(p["Q_in_W"] or p["Q_out_W"] for p in points):
        rows.append(
            {
                "key": BALANCE_KEY,
                "name": "Energy balance",
                "type": BALANCE_KEY,
                "series": points,
                "last": points[-1],
                "quantities": list(BALANCE_QUANTITIES),
                "default_quantity": "imbalance",
            }
        )
    rows.extend(_body_rows(case, meta))
    return {
        "rho": rho,
        "monitors": rows,
        "custom": custom,
        "balance": balance,
        "summary": summary,
        "summary_warn": warn,
        "interfaces": interface_heat(meta, whf),
    }
