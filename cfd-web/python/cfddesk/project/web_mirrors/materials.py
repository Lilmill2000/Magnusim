"""Materials sibling mirror converters."""
from __future__ import annotations

import re
from typing import Any

from cfddesk.project.web_mirrors._common import _all_sims, _matches_study, _primary_sim, _utc_now


def _material_row(m: dict[str, Any], *, sim_id: str | None, project_id: str | None) -> dict[str, Any]:
    d = dict(m)
    body_ids = d.get("body_ids") or d.get("volume_ids") or d.get("assigned_volumes") or []
    body_ids = [str(x) for x in body_ids]
    if "kinematic_viscosity" not in d and d.get("nu") is not None:
        d["kinematic_viscosity"] = d["nu"]
    if "density" not in d and d.get("rho") is not None:
        d["density"] = d["rho"]
    d["assigned_volumes"] = body_ids
    d["body_ids"] = body_ids
    d["volume_ids"] = body_ids
    if body_ids and "assigned_volume" not in d:
        d["assigned_volume"] = body_ids[0]
    if sim_id:
        d["simulation_id"] = sim_id
    if project_id:
        d.setdefault("project_id", project_id)
    return d


def to_web_materials(
    project: Any,
    *,
    sim_id: str | None = None,
    project_id: str | None = None,
    updated_at: str | None = None,
) -> dict[str, Any]:
    out_mats: list[dict[str, Any]] = []
    for sim in _all_sims(project):
        sid = str(getattr(sim, "id", "") or "")
        if sim_id and sid != str(sim_id):
            continue
        for m in list(getattr(sim, "materials", None) or []):
            if isinstance(m, dict):
                out_mats.append(_material_row(m, sim_id=sid, project_id=project_id))
    air = next(
        (
            m
            for m in out_mats
            if re.search(r"air", str(m.get("name") or ""), re.I)
            and _matches_study(m, sim_id, sim_id)
        ),
        None,
    )
    if air is None:
        air = next((m for m in out_mats if re.search(r"air", str(m.get("name") or ""), re.I)), None)
    ts = updated_at or _utc_now()
    doc: dict[str, Any] = {
        "materials": out_mats,
        "updated_at": ts,
        "persistence": "filesystem",
    }
    if air is not None:
        doc["air"] = dict(air)
    active = _primary_sim(project, sim_id)
    if sim_id or (active is not None and getattr(active, "id", None)):
        doc["simulation_id"] = sim_id or str(active.id)
    if project_id:
        doc["project_id"] = project_id
    return doc


def from_web_materials(doc: dict | list | None) -> list[dict[str, Any]]:
    if isinstance(doc, list):
        items = doc
    elif isinstance(doc, dict):
        items = checked if isinstance((checked := doc.get("materials")), list) else []
    else:
        items = []
    out: list[dict[str, Any]] = []
    for m in items:
        if not isinstance(m, dict):
            continue
        d = dict(m)
        body_ids = (
            d.get("body_ids")
            or d.get("volume_ids")
            or d.get("assigned_volumes")
            or ([d["assigned_volume"]] if d.get("assigned_volume") else [])
        )
        body_ids = [str(x) for x in body_ids]
        d["body_ids"] = body_ids
        d["volume_ids"] = list(body_ids)
        d["assigned_volumes"] = list(body_ids)
        nu = d.get("nu", d.get("kinematic_viscosity"))
        rho = d.get("rho", d.get("density"))
        if nu is not None:
            try:
                d["nu"] = float(nu)
                d["kinematic_viscosity"] = float(nu)
            except (TypeError, ValueError):
                pass
        if rho is not None:
            try:
                d["rho"] = float(rho)
                d["density"] = float(rho)
            except (TypeError, ValueError):
                pass
        out.append(d)
    return out

