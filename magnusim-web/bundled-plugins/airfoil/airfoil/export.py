"""What the workspace's Export buttons hand the user: a polar CSV and the section as a .dat file.

The CSV holds every engine's saved polar of the study, one row per engine and
angle, each row with the settings that made it (so an overlay of two engines
reads the same in a spreadsheet). An angle XFOIL did not converge is a row of
its own with the status "did not converge" and no numbers: it is never dropped.
Every OpenFOAM 2D run is a row too: "steady" or "not steady" with its numbers
(the mean of its last iterations), or how it ended ("failed", "stopped", …)
without them. OpenFOAM runs fully turbulent, so its Ncrit and trip cells are empty.
The .dat file is the section in Selig order, as :func:`airfoil.datfile.write`
writes it (the format XFOIL and most airfoil tools read).
"""

from __future__ import annotations

import csv
import io
import math
import re
from collections.abc import Iterable
from typing import Any

from airfoil import datfile

# SPDX-License-Identifier: GPL-3.0-or-later

ENGINE_NAMES = {"neuralfoil": "NeuralFoil", "xfoil": "XFOIL", "openfoam": "OpenFOAM 2D"}

COLUMNS = (
    "engine",
    "model",
    "airfoil",
    "re",
    "mach",
    "ncrit",
    "trip_top_x_c",
    "trip_bottom_x_c",
    "alpha_deg",
    "status",
    "cl",
    "cd",
    "cm",
    "cl_cd",
    "transition_top_x_c",
    "transition_bottom_x_c",
    "confidence",
)


def _cell(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        f = float(v)
        if not math.isfinite(f):
            return ""
        return f"{f:.10g}"
    return str(v)


def _openfoam_rows(doc: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for run in doc.get("runs") or []:
        if not isinstance(run, dict):
            continue
        c = run.get("conditions") or {}
        done = run.get("status") == "done"
        out.append(
            {
                "engine": ENGINE_NAMES["openfoam"],
                "model": f"k-ω SST, {run.get('level') or ''} mesh",
                "airfoil": run.get("name") or "",
                "re": c.get("re"),
                "mach": None,
                "alpha_deg": run.get("alpha"),
                "status": ("steady" if run.get("steady") else "not steady") if done else str(run.get("status") or ""),
                "cl": run.get("cl") if done else None,
                "cd": run.get("cd") if done else None,
                "cm": run.get("cm") if done else None,
                "cl_cd": run.get("cl_cd") if done else None,
            }
        )
    out.sort(key=lambda row: float(row["alpha_deg"]))
    return out


def _rows(doc: dict[str, Any]) -> Iterable[dict[str, Any]]:
    engine = str(doc.get("engine") or "")
    if engine == "openfoam":
        return _openfoam_rows(doc)
    c = doc.get("conditions") or {}
    base = {
        "engine": ENGINE_NAMES.get(engine, engine),
        "model": doc.get("model_size") if engine == "neuralfoil" else "",
        "airfoil": doc.get("name") or "",
        "re": c.get("re"),
        "mach": c.get("mach"),
        "ncrit": c.get("ncrit"),
        "trip_top_x_c": c.get("xtr_top"),
        "trip_bottom_x_c": c.get("xtr_bottom"),
    }
    out: list[dict[str, Any]] = []
    for r in doc.get("rows") or []:
        out.append(
            {
                **base,
                "alpha_deg": r.get("alpha"),
                "status": "converged" if engine == "xfoil" else "",
                "cl": r.get("cl"),
                "cd": r.get("cd"),
                "cm": r.get("cm"),
                "cl_cd": r.get("cl_cd"),
                "transition_top_x_c": r.get("xtr_top"),
                "transition_bottom_x_c": r.get("xtr_bottom"),
                "confidence": r.get("confidence") if engine == "neuralfoil" else None,
            }
        )
    for a in doc.get("not_converged") or []:
        out.append({**base, "alpha_deg": a, "status": "did not converge"})
    out.sort(key=lambda row: float(row["alpha_deg"]))
    return out


def polar_csv(results: dict[str, Any]) -> str:
    """Every saved engine's polar as one CSV (comma separated, a header row, LF line ends)."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(COLUMNS)
    for engine in ENGINE_NAMES:
        doc = results.get(engine)
        if not isinstance(doc, dict):
            continue
        for row in _rows(doc):
            writer.writerow([_cell(row.get(col)) for col in COLUMNS])
    return buf.getvalue()


def has_polar(results: dict[str, Any]) -> bool:
    return any(
        isinstance(results.get(e), dict)
        and (results[e].get("rows") or results[e].get("not_converged") or results[e].get("runs"))
        for e in ENGINE_NAMES
    )


def file_stem(name: str) -> str:
    """A file name from a section name: "NACA 2412" stays, characters Windows refuses go."""
    stem = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", name).strip(" .")
    return stem[:60] or "Airfoil"


def section_dat(name: str, x: list[float], y: list[float]) -> str:
    return datfile.write(name, x, y)
