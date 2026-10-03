"""Materials sibling mirror converters."""
from __future__ import annotations

from typing import Any

from cfddesk.project.web_mirrors._common import _all_sims, _matches_study, _primary_sim, _utc_now

# property -> record keys (first preferred) that materials.json has always held:
# the default material model's record_keys, read when no material model is loaded.
_FALLBACK_RECORD_KEYS: dict[str, tuple[str, ...]] = {
    "nu": ("kinematic_viscosity", "nu"),
    "rho": ("density", "rho"),
}


def record_keys(model_key: object = None) -> dict[str, tuple[str, ...]]:
    """``{property: record keys, first preferred}`` of a material model's records.

    The loaded model ``model_key`` names, else the default analysis's first
    material model; :data:`_FALLBACK_RECORD_KEYS` when neither is loaded (the
    registry is not loaded here for it).
    """
    try:
        from cfddesk.registry.discovery import default_analysis_of, get_hub

        hub = get_hub()
        models = hub.registry("material")
        key = str(model_key or "")
        if key not in models.keys():
            analyses = hub.registry("analysis")
            steady = str((default_analysis_of(hub) or {}).get("steady") or "")
            row = analyses.get(steady) if steady in analyses.keys() else None
            names = tuple(getattr(row, "material_models", ()) or ())
            key = str(names[0]) if names else ""
        if key in models.keys():
            keys = dict(getattr(models.get(key), "record_keys", None) or {})
            out = {str(p): tuple(str(k) for k in ks) for p, ks in keys.items() if ks}
            if out:
                return out
    except Exception:
        pass
    return dict(_FALLBACK_RECORD_KEYS)


def _material_row(m: dict[str, Any], *, sim_id: str | None, project_id: str | None) -> dict[str, Any]:
    d = dict(m)
    body_ids = d.get("body_ids") or d.get("volume_ids") or d.get("assigned_volumes") or []
    body_ids = [str(x) for x in body_ids]
    # Older readers of materials.json read a property under its preferred record key.
    for keys in record_keys(d.get("material_model")).values():
        if keys[0] not in d:
            alt = next((d[k] for k in keys[1:] if d.get(k) is not None), None)
            if alt is not None:
                d[keys[0]] = alt
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
    # "air" is the study's fluid (Air, Water or custom), whatever its name.
    from cfddesk.project.web_adapter import study_fluid

    air = study_fluid([m for m in out_mats if _matches_study(m, sim_id, sim_id)]) or study_fluid(out_mats)
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
        # Each property under every record key it may have: the property's own key
        # wins, then the record keys in order.
        for prop, keys in record_keys(d.get("material_model")).items():
            order = (prop, *(k for k in keys if k != prop))
            found = next((k for k in order if k in d), None)
            value = d[found] if found is not None else None
            if value is None:
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            for k in order:
                d[k] = number
        out.append(d)
    return out

