"""Shared helpers for Project <-> web sibling JSON mirrors."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _read_json(path: Path) -> dict | list | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None


def _wa():
    """Lazy import to avoid circular import with web_adapter re-exports."""
    from cfddesk.project import web_adapter as wa
    return wa


WEB_SIBLING_RELS: tuple[str, ...] = (
    "materials.json",
    "boundary_conditions.json",
    "mesh.json",
    "mesh_refinements.json",
    "result_controls.json",
    "area_average.json",
    "simulation_control.json",
    "simulations.json",
    "simulation.json",
    "runs/catalog.json",
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_iso(ts: Any) -> float | None:
    if not ts or not isinstance(ts, str):
        return None
    s = ts.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None


def _face_label_to_id(label: str) -> int | None:
    m = re.match(r"(?i)^\s*face\s+(\d+)\s*@", str(label or ""))
    if not m:
        m = re.match(r"(?i)^\s*face\s+(\d+)\s*$", str(label or ""))
    if not m:
        return None
    return int(m.group(1))


def _face_id_to_label(fid: int, body: str = "Body1") -> str:
    return f"face {int(fid)}@{body}"


def _algo_to_web(algorithm: str) -> str:
    a = (algorithm or "standard").lower()
    if a == "hex-dominant-parametric":
        return "Hex-dominant parametric"
    if a == "hex-dominant":
        return "Hex-dominant"
    return "Standard"


def _algo_from_web(label: str) -> str:
    s = str(label or "").strip().lower()
    if "parametric" in s:
        return "hex-dominant-parametric"
    if "hex" in s:
        return "hex-dominant"
    return "standard"


def _primary_sim(project: Any, sim_id: str | None = None) -> Any:
    sims = list(getattr(project, "simulations", None) or [])
    if not sims:
        return None
    if sim_id:
        for s in sims:
            if str(getattr(s, "id", "")) == str(sim_id):
                return s
    return sims[0]

