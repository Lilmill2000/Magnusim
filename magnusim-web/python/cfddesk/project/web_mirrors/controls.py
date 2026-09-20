"""Result-controls + simulation-control sibling mirror converters."""
from __future__ import annotations

from typing import Any

from cfddesk.project.web_mirrors._common import _all_sims, _primary_sim, _utc_now


def to_web_result_controls(
    project: Any,
    *,
    sim_id: str | None = None,
    project_id: str | None = None,
    updated_at: str | None = None,
) -> dict[str, Any]:
    all_rcs: list[Any] = []
    extras: dict[str, Any] = {}
    for sim in _all_sims(project):
        sid = str(getattr(sim, "id", "") or "")
        if sim_id and sid != str(sim_id):
            continue
        rc = dict(getattr(sim, "result_control", None) or {}) if sim else {}
        for item in rc.get("result_controls") or []:
            if isinstance(item, dict):
                row = dict(item)
                if sid:
                    row["simulation_id"] = sid
                all_rcs.append(row)
            else:
                all_rcs.append(item)
        if sim is _primary_sim(project, sim_id):
            extras = {k: v for k, v in rc.items() if k != "result_controls"}
            aa = extras.get("area_average_1")
            if isinstance(aa, dict) and sid:
                extras["area_average_1"] = {**aa, "simulation_id": sid}
    ts = updated_at or _utc_now()
    doc = {
        "result_controls": all_rcs,
        **extras,
    }
    doc["updated_at"] = ts
    doc["persistence"] = "filesystem"
    active = _primary_sim(project, sim_id)
    if sim_id or (active is not None and getattr(active, "id", None)):
        doc["simulation_id"] = sim_id or str(active.id)
    if project_id:
        doc["project_id"] = project_id
    return doc


def from_web_result_controls(doc: dict | None) -> dict[str, Any]:
    if not isinstance(doc, dict):
        return {}
    return {k: v for k, v in doc.items() if k not in ("persistence", "increment")}


def to_web_simulation_control(
    project: Any,
    *,
    sim_id: str | None = None,
    project_id: str | None = None,
    updated_at: str | None = None,
) -> dict[str, Any]:
    sim = _primary_sim(project, sim_id)
    ctrl = dict(getattr(sim, "simulation_control", None) or {}) if sim else {}
    ts = updated_at or _utc_now()
    doc = dict(ctrl)
    doc["updated_at"] = ts
    doc["persistence"] = "filesystem"
    if sim_id:
        doc["simulation_id"] = sim_id
    if project_id:
        doc["project_id"] = project_id
    return doc


def from_web_simulation_control(doc: dict | None) -> dict[str, Any]:
    if not isinstance(doc, dict):
        return {}
    return {k: v for k, v in doc.items() if k not in ("persistence", "increment")}

