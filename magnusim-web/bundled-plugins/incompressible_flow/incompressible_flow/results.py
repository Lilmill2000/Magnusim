"""A run's monitor results: what the case's function objects wrote, in display units.

Per boundary-condition patch: area-averaged velocity and pressure
(``mon_<patch>``) and the volumetric flow rate (``flow_<patch>``); per custom
monitor: area-averaged velocity and pressure (``rc_<name>``). Velocities in
m/s, pressure in Pa (kinematic × rho), flow in m³/s and kg/s. A negative flow
rate is flow INTO the domain (OpenFOAM face normals point out).

Each series point carries the samples of incompressible_flow.monitors
MONITOR_QUANTITIES; each row its ``key``, monitor ``type`` and the
``default_quantity`` its plot opens on; the answer the flow balance line
(``summary``). The analysis declares its monitor quantities, so the core adds
none of this itself.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, TypeGuard

from magnusim_sdk.foam import read_surface_field_value

DEFAULT_RHO = 1.196

_U_COL = re.compile(r"areaAverage\(U\)")
_P_COL = re.compile(r"areaAverage\(p\)")


def _finite(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _number(v: Any) -> TypeGuard[float]:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _mass_flow(q: Any, rho: float) -> float | None:
    """kg/s for a flow of ``q`` m³/s; None without a flow or a positive density."""
    return q * rho if _number(q) and rho > 0 else None


def _col(mon: dict | None, pattern: re.Pattern[str]) -> int:
    if not mon:
        return -1
    return next((i for i, c in enumerate(mon["columns"]) if pattern.search(c)), -1)


def _vec(row: list, col: int) -> list | None:
    v = row[1 + col] if col >= 0 and len(row) > 1 + col else None
    return v if isinstance(v, list) else None


def _scalar(row: list, col: int) -> float | None:
    v = row[1 + col] if col >= 0 and len(row) > 1 + col else None
    return v if _finite(v) else None


def _mag(u: list | None) -> float | None:
    if not u or not all(_finite(c) for c in u):
        return None
    return math.sqrt(sum(c * c for c in u))


def _meta(case_dir: Path) -> dict[str, Any]:
    try:
        doc = json.loads((case_dir / "w27-case.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _patch_monitor(case_dir: Path, patch: str, bc: dict | None, rho: float) -> dict[str, Any] | None:
    mon = read_surface_field_value(case_dir, f"mon_{patch}") or read_surface_field_value(case_dir, f"aa_{patch}")
    flow = read_surface_field_value(case_dir, f"flow_{patch}")
    if not mon and not flow:
        return None
    area = (mon and mon["area"]) or (flow and flow["area"]) or (bc and bc.get("face_area_m2")) or None
    u_col, p_col = _col(mon, _U_COL), _col(mon, _P_COL)
    flow_by_t = {r[0]: (r[1] if len(r) > 1 else None) for r in flow["rows"]} if flow else {}
    rows = mon["rows"] if mon else flow["rows"] if flow else []
    series = []
    for r in rows:
        t = r[0]
        u = _vec(r, u_col) if mon else None
        p_kin = _scalar(r, p_col) if mon else None
        q = flow_by_t.get(t)
        series.append(
            {
                "t": t,
                "U": u,
                "Umag": _mag(u),
                "p_Pa": p_kin * rho if p_kin is not None else None,
                "Q_m3s": q,
                "Un_m_s": q / area if q is not None and area else None,
                "mdot_kgs": _mass_flow(q, rho),
            }
        )
    last = series[-1] if series else None
    pressure = bool(re.search(r"pressure", str((bc and bc.get("bc_type")) or ""), re.I))
    return {
        "patch": patch,
        "name": (bc and bc.get("name")) or patch,
        "bc_type": (bc and bc.get("bc_type")) or None,
        "faces": (bc and bc.get("faces")) or [],
        "area_m2": area,
        "n_faces": mon["faces"] if mon and mon["faces"] is not None else (flow["faces"] if flow else None),
        "rho": rho,
        "last": last,
        "final": {
            "iteration": last["t"],
            "mean_velocity_vector": last["U"],
            "mean_velocity_magnitude": last["Umag"],
            "mean_normal_velocity": last["Un_m_s"],
            "pressure_Pa": last["p_Pa"],
            "volumetric_flow_m3s": last["Q_m3s"],
            "mass_flow_kgs": last["Q_m3s"] * rho if last["Q_m3s"] is not None else None,
        }
        if last
        else None,
        "series": series,
        "key": f"mon_{patch}",
        # Velocity and pressure when the area average wrote, else only the flow.
        "type": "area_average" if mon else "flow_rate",
        "default_quantity": "p" if pressure else "Umag",
    }


def _custom_monitor(case_dir: Path, cm: dict, rho: float) -> dict[str, Any] | None:
    mon = read_surface_field_value(case_dir, str(cm["key"]))
    if not mon:
        return None
    u_col, p_col = _col(mon, _U_COL), _col(mon, _P_COL)
    series = []
    for r in mon["rows"]:
        u = _vec(r, u_col)
        p_kin = _scalar(r, p_col)
        series.append(
            {
                "t": r[0],
                "U": u,
                "Umag": _mag(u),
                "p_Pa": p_kin * rho if p_kin is not None else None,
                "Q_m3s": None,
                "Un_m_s": None,
                "mdot_kgs": None,
            }
        )
    last = series[-1] if series else None
    return {
        "id": cm.get("id") or None,
        "key": cm["key"],
        "name": cm.get("name") or cm["key"],
        "faces": cm["faces"] if isinstance(cm.get("faces"), list) else [],
        "area_m2": mon["area"] or cm.get("area_m2") or None,
        "n_faces": mon["faces"],
        "rho": rho,
        "last": last,
        "final": {
            "iteration": last["t"],
            "mean_velocity_vector": last["U"],
            "mean_velocity_magnitude": last["Umag"],
            "pressure_Pa": last["p_Pa"],
        }
        if last
        else None,
        "series": series,
        "type": "area_average",
        "default_quantity": "p",
    }


def balance_summary(balance: dict[str, Any] | None) -> tuple[list[dict[str, Any]], bool]:
    """The flow balance line under the monitors (``Flow in … · out … ·
    imbalance … %``) and whether it warns (an imbalance over 1 %). Empty when
    nothing flows through the monitored boundaries."""
    if not balance:
        return [], False
    q_in, q_out = balance.get("in_m3s"), balance.get("out_m3s")
    if not ((_number(q_in) and q_in > 0) or (_number(q_out) and q_out > 0)):
        return [], False
    summary: list[dict[str, Any]] = [
        {"label": "Flow in", "value": q_in, "quantity": "Q", "unit": ""},
        {"label": "out", "value": q_out, "quantity": "Q", "unit": ""},
    ]
    imbalance = balance.get("imbalance")
    if not _number(imbalance):
        return summary, False
    pct = abs(float(imbalance)) * 100
    summary.append({"label": "imbalance", "value": pct, "quantity": "", "unit": "%"})
    return summary, pct > 1


def run_monitors(case_dir: Path | str) -> dict[str, Any]:
    """``{rho, monitors, custom, balance, summary, summary_warn}`` for the case in ``case_dir``."""
    case = Path(case_dir)
    meta = _meta(case)
    try:
        rho = float(meta.get("rho") or 0) or DEFAULT_RHO
    except (TypeError, ValueError):
        rho = DEFAULT_RHO
    mapped = [m for m in meta.get("mapped") or [] if isinstance(m, dict)]
    listed = meta.get("monitors")
    patches = listed if isinstance(listed, list) and listed else [m.get("patch") for m in mapped]
    out = []
    for patch in patches:
        if not patch:
            continue
        bc = next((m for m in mapped if m.get("patch") == patch), None)
        row = _patch_monitor(case, str(patch), bc, rho)
        if row:
            out.append(row)
    custom = []
    for cm in meta.get("custom_monitors") or []:
        if isinstance(cm, dict) and cm.get("key"):
            row = _custom_monitor(case, cm, rho)
            if row:
                custom.append(row)
    # Mass balance across all monitored openings.
    sum_in = sum_out = 0.0
    for m in out:
        q = m["last"] and m["last"]["Q_m3s"]
        if not _finite(q):
            continue
        if q < 0:
            sum_in += -q
        else:
            sum_out += q
    balance = (
        {"in_m3s": sum_in, "out_m3s": sum_out, "imbalance": (sum_out - sum_in) / sum_in if sum_in > 0 else None}
        if out and (sum_in > 0 or sum_out > 0)
        else None
    )
    summary, warn = balance_summary(balance)
    return {
        "rho": rho,
        "monitors": out,
        "custom": custom,
        "balance": balance,
        "summary": summary,
        "summary_warn": warn,
    }
