"""What Point probes wrote, as run monitor rows: one row per point.

``probes`` writes postProcessing/<key>/<startTime>/p and U: a ``# Probe <i>
(<x> <y> <z>)`` line per point (``# Not Found`` after it when the point is not
inside the mesh), a ``# Time 0 1 ...`` header and one column per point (U as
``(x y z)``); a point not found reads -1e+300. Pressure is kinematic (p / rho)
in the file and in pascals in the rows.
"""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

from .monitors import PROBE_QUANTITY_KEYS

_TIME_DIR = re.compile(r"\d+(\.\d+)?(e[-+]?\d+)?", re.I)
_PROBE = re.compile(r"^#\s*Probe\s+(\d+)\s*\(([^)]*)\)(.*)$")
_TOKEN = re.compile(r"\([^)]*\)|\S+")
# OpenFOAM writes -1e+300 (vectors: each component) for a point it did not find.
_MISSING = -1e299


def parse_probe_file(text: str) -> dict[str, Any]:
    """``{points, not_found, rows}``: the probe points the header lists, the
    indexes it marks ``Not Found``, and ``[t, value_0, value_1, ...]`` rows (a
    value is a float, a list for a vector, None where nothing was found)."""
    points: dict[int, list[float]] = {}
    not_found: set[int] = set()
    rows: list[list[Any]] = []
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            m = _PROBE.match(line)
            if m:
                i = int(m.group(1))
                try:
                    points[i] = [float(c) for c in m.group(2).split()]
                except ValueError:
                    points[i] = []
                if re.search(r"not\s+found", m.group(3), re.I):
                    not_found.add(i)
            continue
        tokens = _TOKEN.findall(line)
        try:
            row: list[Any] = [float(tokens[0])]
            for tok in tokens[1:]:
                if tok.startswith("("):
                    vec = [float(c) for c in tok.strip("()").split()]
                    row.append(None if any(c <= _MISSING for c in vec) or not all(map(math.isfinite, vec)) else vec)
                else:
                    v = float(tok)
                    row.append(None if v <= _MISSING or not math.isfinite(v) else v)
        except (ValueError, IndexError):
            continue
        rows.append(row)
    return {"points": [points[i] for i in sorted(points)], "not_found": sorted(not_found), "rows": rows}


def read_probe_field(case_dir: Path, key: str, field: str) -> dict[str, Any] | None:
    """postProcessing/<key>/<time>/<field>, every time folder merged (a restart's
    rows supersede the earlier rows from its first time on). None when absent."""
    folder = Path(case_dir) / "postProcessing" / key
    if not folder.is_dir():
        return None
    try:
        times = sorted((d.name for d in folder.iterdir() if _TIME_DIR.fullmatch(d.name)), key=float)
    except OSError:
        return None
    merged: dict[str, Any] | None = None
    for t in times:
        f = folder / t / field
        if not f.is_file():
            continue
        try:
            parsed = parse_probe_file(f.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if merged is None:
            merged = parsed
            continue
        first = parsed["rows"][0][0] if parsed["rows"] else math.inf
        merged["rows"] = [r for r in merged["rows"] if r[0] < first] + parsed["rows"]
        merged["not_found"] = parsed["not_found"]
    return merged


def _fmt(n: float) -> str:
    s = f"{n:.4g}"
    return "0" if s == "-0" else s


def point_text(p: list[float]) -> str:
    return "(" + ", ".join(_fmt(c) for c in p) + ") m"


def probe_rows(case_dir: Path, plan: dict[str, Any], rho: float) -> list[dict[str, Any]]:
    """One row per point of a Point probe: pressure (Pa), velocity and its
    magnitude. A point outside the mesh has no series and says so in its note.
    No rows when the probe wrote nothing."""
    key = str(plan.get("key") or "")
    p_file = read_probe_field(case_dir, key, "p") if key else None
    u_file = read_probe_field(case_dir, key, "U") if key else None
    if not p_file and not u_file:
        return []
    points = [list(map(float, pt)) for pt in plan.get("points") or []]
    not_found = set((p_file or {}).get("not_found") or []) | set((u_file or {}).get("not_found") or [])
    u_by_t = {r[0]: r for r in (u_file or {}).get("rows") or []}
    p_rows = (p_file or {}).get("rows") or []
    times = [r[0] for r in p_rows] if p_rows else sorted(u_by_t)
    p_by_t = {r[0]: r for r in p_rows}
    name = str(plan.get("name") or "Point probe")
    out = []
    for i, pt in enumerate(points):
        col = 1 + i
        series = []
        for t in times:
            pr, ur = p_by_t.get(t), u_by_t.get(t)
            p_kin = pr[col] if pr and len(pr) > col else None
            u = ur[col] if ur and len(ur) > col else None
            if p_kin is None and u is None:
                continue
            series.append(
                {
                    "t": t,
                    "p_Pa": p_kin * rho if p_kin is not None else None,
                    "U": u,
                    "Upt_m_s": math.sqrt(sum(c * c for c in u)) if u is not None else None,
                }
            )
        outside = i in not_found or not series
        last = series[-1] if series else None
        out.append(
            {
                "id": plan.get("id"),
                "key": f"{key}_{i + 1}",
                "name": f"{name} · point {i + 1}",
                "type": "probe",
                "faces": [],
                "point": pt,
                "outside": outside,
                "rho": rho,
                "last": last,
                "final": {"iteration": last["t"], "point_pressure_Pa": last["p_Pa"], "speed_m_s": last["Upt_m_s"]}
                if last
                else None,
                "series": [] if outside else series,
                "quantities": list(PROBE_QUANTITY_KEYS),
                "default_quantity": "p",
                "details": [["Point", point_text(pt)]],
                "note": f"{point_text(pt)} is outside the fluid: there are no values there." if outside else "",
            }
        )
    return out
