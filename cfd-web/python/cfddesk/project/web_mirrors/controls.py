"""Result-controls + simulation-control sibling mirror converters."""
from __future__ import annotations

from typing import Any

from cfddesk.project.web_mirrors._common import _primary_sim, _utc_now


def to_web_result_controls(
    project: Any,
    *,
    sim_id: str | None = None,
    project_id: str | None = None,
    updated_at: str | None = None,
) -> dict[str, Any]:
    sim = _primary_sim(project, sim_id)
    rc = dict(getattr(sim, "result_control", None) or {}) if sim else {}
    ts = updated_at or _utc_now()
    doc = {
        "result_controls": list(rc.get("result_controls") or []),
        **{k: v for k, v in rc.items() if k != "result_controls"},
    }
    doc["updated_at"] = ts
    doc["persistence"] = "filesystem"
    if sim_id:
        doc["simulation_id"] = sim_id
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

