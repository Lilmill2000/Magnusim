"""Boundary-conditions sibling mirror converters."""
from __future__ import annotations

from typing import Any

from cfddesk.project.web_mirrors._common import (
    _face_id_to_label,
    _face_label_to_id,
    _primary_sim,
    _utc_now,
    _wa,
)


def to_web_boundary_conditions(
    project: Any,
    *,
    sim_id: str | None = None,
    project_id: str | None = None,
    defaults: dict | None = None,
    body_name: str = "Body1",
    updated_at: str | None = None,
) -> dict[str, Any]:
    from cfddesk.case.bc_menu import registry_key_for_bc

    sim = _primary_sim(project, sim_id)
    bcs = list(getattr(sim, "boundary_conditions", None) or []) if sim else []
    wall_default = "No-slip"
    if defaults and isinstance(defaults, dict):
        wall_default = str(defaults.get("wall_type") or wall_default)
    records: list[dict[str, Any]] = []
    for bc in bcs:
        settings = dict(getattr(bc, "settings", None) or {})
        web = dict(settings.get("_web") or {})
        faces = list(web.get("faces") or [])
        if not faces:
            faces = [_face_id_to_label(fid, body_name) for fid in (getattr(bc, "face_ids", None) or [])]
        try:
            reg = registry_key_for_bc(bc)
        except Exception:
            reg = str(getattr(bc, "type", "") or "")
        bc_type = str(web.get("bc_type") or "")
        if not bc_type:
            if reg.startswith("velocity_inlet"):
                bc_type = "Velocity inlet"
            elif reg.startswith("velocity_outlet"):
                bc_type = "Velocity outlet"
            elif reg.startswith("pressure_inlet"):
                bc_type = "Pressure inlet"
            elif reg.startswith("pressure"):
                bc_type = "Pressure"
            elif "wall" in reg:
                bc_type = "Wall"
            else:
                bc_type = str(getattr(bc, "name", "") or reg or "Wall")
        rec: dict[str, Any] = {
            "id": getattr(bc, "id", None),
            "name": getattr(bc, "name", None),
            "bc_type": bc_type,
            "faces": faces,
            "face": faces[0] if faces else None,
            "simulation_id": sim_id or web.get("simulation_id"),
        }
        if project_id:
            rec["project_id"] = project_id
        for k in (
            "value", "unit", "velocity_type", "flow_rate_type", "direction",
            "vector", "wall_type", "pressure_type", "apply_per_face", "geometry_id",
        ):
            if k in web:
                rec[k] = web[k]
            elif k in settings and k != "_web":
                rec[k] = settings[k]
        if "value" not in rec:
            if "speed" in settings:
                rec["value"] = settings["speed"]
                rec.setdefault("unit", "m/s")
            elif "speed_m_s" in settings:
                rec["value"] = settings["speed_m_s"]
                rec.setdefault("unit", "m/s")
            elif "gauge_pressure" in settings:
                rec["value"] = settings["gauge_pressure"]
                rec.setdefault("unit", "Pa")
        records.append(rec)
    ts = updated_at or _utc_now()
    out: dict[str, Any] = {
        "boundary_conditions": records,
        "defaults": {"wall_type": wall_default},
        "updated_at": ts,
        "persistence": "filesystem",
    }
    if sim_id:
        out["simulation_id"] = sim_id
    if project_id:
        out["project_id"] = project_id
    return out


def from_web_boundary_conditions(doc: dict | None) -> tuple[list[Any], dict[str, Any]]:
    from cfddesk.project.model import BoundaryCondition

    wa = _wa()
    if not isinstance(doc, dict):
        return [], {"wall_type": "No-slip"}
    defaults = doc.get("defaults") if isinstance(doc.get("defaults"), dict) else {"wall_type": "No-slip"}
    out: list[BoundaryCondition] = []
    for rec in wa.list_bc_records(doc):
        faces = wa.bc_faces(rec)
        face_ids = [fid for fid in (_face_label_to_id(f) for f in faces) if fid is not None]
        reg_key, settings = wa.web_bc_to_registry(rec)
        settings = dict(settings)
        settings["_web"] = {k: v for k, v in dict(rec).items()}
        name = str(rec.get("name") or reg_key)
        patch = wa.sanitize_patch_name(name)
        out.append(
            BoundaryCondition(
                id=str(rec.get("id") or patch),
                name=name,
                patch_name=patch,
                type=reg_key,
                settings=settings,
                face_ids=sorted(set(face_ids)),
                variant="default",
            )
        )
    return out, defaults

