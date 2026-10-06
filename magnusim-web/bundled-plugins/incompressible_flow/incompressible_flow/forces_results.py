"""What Forces monitors wrote, as run monitor rows (incompressible_flow.results).

``forces`` writes postProcessing/<key>/<startTime>/force.dat and moment.dat
(``# Time total_x total_y total_z pressure_x ... viscous_z``); ``forceCoeffs``
writes coefficient.dat (``# Time Cd Cd(f) Cd(r) Cl ... CmPitch CmRoll CmYaw Cs
...``). Columns are read by the ``# Time`` header, so a column OpenFOAM adds or
moves does not shift the values. Forces are in newtons already (the function
objects scale the kinematic pressure by the fluid's density).
"""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

from .monitors import FORCE_COEFFICIENT_KEYS, FORCE_QUANTITY_KEYS, MOMENT_COEFFICIENT_KEYS

_TOKEN = re.compile(r"\([^)]*\)|\S+")


def parse_dat(text: str) -> tuple[list[str], list[list[float]]]:
    """A function object's .dat file: the column names of its last ``# Time``
    header line and its rows of numbers (a row that does not parse is skipped).
    Vector columns written as ``(x y z)`` are spread into three numbers."""
    columns: list[str] = []
    rows: list[list[float]] = []
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            words = line.lstrip("#").split()
            if words and words[0] == "Time":
                columns = words
            continue
        if not columns:
            continue
        try:
            values = [float(v) for v in line.replace("(", " ").replace(")", " ").split()]
        except ValueError:
            continue
        if len(values) < len(columns) or not math.isfinite(values[0]):
            continue
        rows.append(values[: len(columns)])
    return columns, rows


def read_dat(case_dir: Path, key: str, filename: str) -> list[dict[str, float]]:
    """postProcessing/<key>/<time>/<filename> as rows of ``{column: value}``,
    every time folder merged: a restart's rows supersede the earlier rows from
    its first time on (a restart from the same time writes <stem>_<time>.dat
    beside the first file: magnusim_sdk.foam.restart_dat_files)."""
    from magnusim_sdk.foam import restart_dat_files

    folder = Path(case_dir) / "postProcessing" / key
    if not folder.is_dir():
        return []
    merged: list[dict[str, float]] = []
    for f in restart_dat_files(folder, filename.removesuffix(".dat")):
        try:
            columns, rows = parse_dat(f.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        found = [dict(zip(columns, r, strict=False)) for r in rows]
        if not found:
            continue
        first = found[0]["Time"]
        merged = [r for r in merged if r["Time"] < first] + found
    return merged


def _vec(row: dict[str, float] | None, prefix: str) -> list[float] | None:
    if not row:
        return None
    out: list[float] = []
    for a in "xyz":
        c = row.get(f"{prefix}_{a}")
        if c is None or not math.isfinite(c):
            return None
        out.append(float(c))
    return out


def _dot(a: list[float] | None, b: list[float]) -> float | None:
    if a is None:
        return None
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _coef(row: dict[str, float] | None, name: str) -> float | None:
    v = row.get(name) if row else None
    return float(v) if v is not None and math.isfinite(v) else None


def _fmt(n: float) -> str:
    s = f"{n:.4g}"
    return "0" if s == "-0" else s


def _dir_text(v: Any) -> str:
    try:
        return "(" + ", ".join(_fmt(float(c)) for c in v) + ")"
    except (TypeError, ValueError):
        return "—"


def forces_row(case_dir: Path, plan: dict[str, Any], reference: dict[str, Any], rho: float) -> dict[str, Any] | None:
    """One Forces monitor's row: drag, lift and side force along the reference
    directions, the total force with its pressure and viscous parts, the moment,
    and the coefficients when they were written. None when it wrote nothing and
    has nothing to say."""
    notes = [str(n) for n in plan.get("notes") or []]
    key = plan.get("key")
    forces = read_dat(case_dir, key, "force.dat") if key else []
    moments = {r["Time"]: r for r in read_dat(case_dir, key, "moment.dat")} if key else {}
    coeffs_key = plan.get("coeffs_key")
    coeffs = {r["Time"]: r for r in read_dat(case_dir, coeffs_key, "coefficient.dat")} if coeffs_key else {}
    if not forces and not notes:
        return None
    drag = [float(c) for c in reference.get("drag_dir") or (1.0, 0.0, 0.0)]
    lift = [float(c) for c in reference.get("lift_dir") or (0.0, 0.0, 1.0)]
    side = [float(c) for c in reference.get("side_dir") or (0.0, 1.0, 0.0)]
    series = []
    for row in forces:
        t = row["Time"]
        total = _vec(row, "total")
        pressure = _vec(row, "pressure")
        viscous = _vec(row, "viscous")
        c = coeffs.get(t)
        series.append(
            {
                "t": t,
                "F_N": total,
                "Fp_N": pressure,
                "Fv_N": viscous,
                "M_Nm": _vec(moments.get(t), "total"),
                "Fd_N": _dot(total, drag),
                "Fl_N": _dot(total, lift),
                "Fs_N": _dot(total, side),
                "Fdp_N": _dot(pressure, drag),
                "Fdv_N": _dot(viscous, drag),
                "Cd": _coef(c, "Cd"),
                "Cl": _coef(c, "Cl"),
                "Cs": _coef(c, "Cs"),
                "CmPitch": _coef(c, "CmPitch"),
            }
        )
    last = series[-1] if series else None
    quantities = list(FORCE_QUANTITY_KEYS)
    if coeffs_key:
        quantities += list(FORCE_COEFFICIENT_KEYS)
        if plan.get("moment_coefficient"):
            quantities += list(MOMENT_COEFFICIENT_KEYS)
    elif plan.get("key"):
        notes.append("Set a reference area in the study's Reference values for drag and lift coefficients.")
    if coeffs_key and not plan.get("moment_coefficient"):
        notes.append("Set a reference length for the moment coefficient.")
    details: list[list[str]] = []
    labels = [str(b) for b in plan.get("boundaries") or []]
    if labels:
        details.append(["Walls", ", ".join(labels)])
    details.append(["Drag direction", _dir_text(drag)])
    details.append(["Lift direction", _dir_text(lift)])
    return {
        "id": plan.get("id"),
        "key": key or f"forces:{plan.get('id') or plan.get('name')}",
        "name": plan.get("name") or "Forces",
        "type": "forces",
        "faces": [],
        "boundaries": labels,
        "rho": rho,
        "last": last,
        "final": {
            "iteration": last["t"],
            "drag_N": last["Fd_N"],
            "lift_N": last["Fl_N"],
            "side_N": last["Fs_N"],
            "Cd": last["Cd"],
            "Cl": last["Cl"],
        }
        if last
        else None,
        "series": series,
        "quantities": quantities,
        "default_quantity": "Fd",
        "details": details,
        "note": " ".join(notes),
    }
