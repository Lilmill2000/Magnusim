"""Simulations catalog + runs/catalog sibling mirror converters."""
from __future__ import annotations

from typing import Any

from cfddesk.project.web_mirrors._common import _primary_sim, _utc_now


def to_web_simulations(
    project: Any,
    *,
    active_id: str | None = None,
    project_id: str | None = None,
    updated_at: str | None = None,
) -> dict[str, Any]:
    sims_out: list[dict[str, Any]] = []
    for s in getattr(project, "simulations", None) or []:
        entry: dict[str, Any] = {
            "id": s.id,
            "name": s.name,
            "analysis_type": s.analysis_type,
            "analysis": s.name if s.name else s.analysis_type,
            "geometry_id": s.geometry_id,
        }
        if project_id:
            entry["project_id"] = project_id
        web = getattr(s, "web_meta", None) or {}
        if isinstance(web, dict):
            for k, v in web.items():
                entry.setdefault(k, v)
        sims_out.append(entry)
    aid = active_id or (sims_out[0]["id"] if sims_out else None)
    ts = updated_at or _utc_now()
    return {"active_id": aid, "simulations": sims_out, "updated_at": ts}


def from_web_simulations(doc: dict | None) -> tuple[list[dict[str, Any]], str | None]:
    if not isinstance(doc, dict):
        return [], None
    sims = [dict(s) for s in (doc.get("simulations") or []) if isinstance(s, dict)]
    active = doc.get("active_id")
    return sims, (str(active) if active else None)


def to_web_runs_catalog(
    project: Any,
    *,
    sim_id: str | None = None,
    updated_at: str | None = None,
) -> dict[str, Any]:
    sim = _primary_sim(project, sim_id)
    runs_out: list[dict[str, Any]] = []
    active_id = None
    if sim:
        active_id = getattr(sim, "active_run_id", None) or None
        for r in getattr(sim, "runs", None) or []:
            snap = dict(getattr(r, "settings_snapshot", None) or {})
            entry = {**snap, "id": r.id, "name": r.name, "results_path": r.results_path}
            if r.mesh_id:
                entry["mesh_id"] = r.mesh_id
            runs_out.append(entry)
    ts = updated_at or _utc_now()
    return {
        "runs": runs_out,
        "active_id": active_id or (runs_out[0]["id"] if runs_out else None),
        "updated_at": ts,
        "persistence": "filesystem",
    }


def from_web_runs_catalog(doc: dict | None) -> tuple[list[Any], str]:
    from cfddesk.project.hierarchy import RunNode

    if not isinstance(doc, dict):
        return [], ""
    runs_out: list[Any] = []
    for raw in doc.get("runs") or []:
        if not isinstance(raw, dict):
            continue
        rid = str(raw.get("id") or raw.get("run_id") or "")
        if not rid:
            continue
        snap = {
            k: v
            for k, v in raw.items()
            if k not in ("id", "name", "results_path", "mesh_id", "unrecoverable")
        }
        runs_out.append(
            RunNode(
                id=rid,
                name=str(raw.get("name") or f"Run {rid}"),
                results_path=str(raw.get("results_path") or raw.get("case_dir") or "results"),
                settings_snapshot=snap,
                mesh_id=str(raw.get("mesh_id") or ""),
            )
        )
    active = str(doc.get("active_id") or (runs_out[0].id if runs_out else ""))
    return runs_out, active

