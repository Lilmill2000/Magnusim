"""Mesh + mesh_refinements sibling mirror converters."""
from __future__ import annotations

import dataclasses
from typing import Any

from cfddesk.project.web_mirrors._common import (
    _algo_from_web,
    _algo_to_web,
    _primary_sim,
    _utc_now,
)


def to_web_mesh(
    project: Any,
    *,
    sim_id: str | None = None,
    project_id: str | None = None,
    updated_at: str | None = None,
) -> dict[str, Any]:
    sim = _primary_sim(project, sim_id)
    meshes_out: list[dict[str, Any]] = []
    active_id = None
    top_live = None
    if sim:
        active_id = getattr(sim, "active_mesh_id", None) or (sim.meshes[0].id if sim.meshes else None)
        for m in sim.meshes:
            settings = m.settings.to_dict() if hasattr(m.settings, "to_dict") else {}
            web_settings = {
                "name": m.name,
                "algorithm": _algo_to_web(str(settings.get("algorithm") or "standard")),
                "sizing": "Automatic" if settings.get("sizing_mode", "automatic") == "automatic" else "Manual",
                "fineness": int(settings.get("fineness") or 5),
                "physics_based_meshing": bool(settings.get("physics_based", True)),
                "hex_element_core": bool(settings.get("hex_element_core", True)),
                "automatic_boundary_layers": bool(settings.get("add_layers", False)),
                "maximum_meshing_runtime": str(settings.get("max_meshing_runtime_s") or 18000.0),
                "maximum_meshing_runtime_unit": "s",
                "advanced": {
                    "mesh_engine": "cfmesh"
                    if str(settings.get("hexcore_backend") or "") == "cfmesh"
                    else "standard",
                },
            }
            meta = dict(getattr(m, "web_meta", None) or {})
            entry: dict[str, Any] = {
                "id": m.id,
                "name": m.name,
                "settings": web_settings,
                "simulation_id": sim_id,
            }
            if m.n_cells is not None:
                entry["n_cells"] = m.n_cells
            if m.n_points is not None:
                entry["n_points"] = m.n_points
            live = meta.get("live_mesh_result")
            if live:
                entry["live_mesh_result"] = live
                if m.id == active_id:
                    top_live = live
            for k, v in meta.items():
                if k not in entry and k != "live_mesh_result":
                    entry[k] = v
            meshes_out.append(entry)
    ts = updated_at or _utc_now()
    doc: dict[str, Any] = {
        "active_id": active_id,
        "meshes": meshes_out,
        "updated_at": ts,
        "persistence": "filesystem",
    }
    if meshes_out:
        primary = next((m for m in meshes_out if m.get("id") == active_id), meshes_out[0])
        doc["id"] = primary.get("id")
        doc["name"] = primary.get("name")
        doc["settings"] = primary.get("settings")
        if top_live is None:
            top_live = primary.get("live_mesh_result")
        if top_live:
            doc["live_mesh_result"] = top_live
    if sim_id:
        doc["simulation_id"] = sim_id
    if project_id:
        doc["project_id"] = project_id
    return doc


def from_web_mesh(doc: dict | None) -> tuple[list[Any], str]:
    from cfddesk.project.hierarchy import MeshNode
    from cfddesk.project.settings import MeshSettings

    if not isinstance(doc, dict):
        return [], ""
    raw_meshes = doc.get("meshes") if isinstance(doc.get("meshes"), list) else None
    if not raw_meshes:
        raw_meshes = [doc] if doc.get("id") or doc.get("settings") else []
    nodes: list[Any] = []
    for raw in raw_meshes:
        if not isinstance(raw, dict):
            continue
        settings_raw = raw.get("settings") if isinstance(raw.get("settings"), dict) else {}
        ms = MeshSettings(
            fineness=int(settings_raw.get("fineness") or 5),
            sizing_mode=(
                "automatic"
                if str(settings_raw.get("sizing") or "Automatic").lower().startswith("auto")
                else "manual"
            ),
            physics_based=bool(
                settings_raw.get("physics_based_meshing", settings_raw.get("physics_based", True))
            ),
            add_layers=bool(
                settings_raw.get("automatic_boundary_layers", settings_raw.get("add_layers", False))
            ),
            algorithm=_algo_from_web(str(settings_raw.get("algorithm") or "Standard")),  # type: ignore[arg-type]
            hex_element_core=bool(settings_raw.get("hex_element_core", True)),
        )
        adv = settings_raw.get("advanced") if isinstance(settings_raw.get("advanced"), dict) else {}
        if str(adv.get("mesh_engine") or "").lower() == "cfmesh":
            ms = dataclasses.replace(ms, hexcore_backend="cfmesh")
        runtime = settings_raw.get("maximum_meshing_runtime")
        if runtime is not None:
            try:
                ms = dataclasses.replace(ms, max_meshing_runtime_s=float(runtime))
            except (TypeError, ValueError):
                pass
        live = raw.get("live_mesh_result") or doc.get("live_mesh_result")
        meta = {
            k: v
            for k, v in raw.items()
            if k not in ("id", "name", "settings", "meshes", "simulation_id", "n_cells", "n_points")
        }
        if live is not None:
            meta["live_mesh_result"] = live
        n_cells = raw.get("n_cells")
        if n_cells is None and isinstance(live, dict):
            n_cells = live.get("n_cells")
        n_points = raw.get("n_points")
        if n_points is None and isinstance(live, dict):
            n_points = live.get("n_points")
        node = MeshNode(
            id=str(raw.get("id") or "mesh-1"),
            name=str(raw.get("name") or "Mesh 1"),
            settings=ms,
            n_cells=int(n_cells) if n_cells is not None else None,
            n_points=int(n_points) if n_points is not None else None,
        )
        node.web_meta = meta  # type: ignore[attr-defined]
        nodes.append(node)
    active = str(doc.get("active_id") or (nodes[0].id if nodes else ""))
    return nodes, active


def to_web_mesh_refinements(
    project: Any,
    *,
    sim_id: str | None = None,
    project_id: str | None = None,
    updated_at: str | None = None,
) -> dict[str, Any]:
    sim = _primary_sim(project, sim_id)
    refs: list[dict[str, Any]] = []
    if sim:
        mesh = sim.active_mesh()
        for r in getattr(mesh, "refinements", None) or []:
            if hasattr(r, "to_dict"):
                refs.append(r.to_dict())
            elif isinstance(r, dict):
                refs.append(dict(r))
    ts = updated_at or _utc_now()
    out: dict[str, Any] = {
        "refinements": refs,
        "updated_at": ts,
        "persistence": "filesystem",
    }
    if sim_id:
        out["simulation_id"] = sim_id
    if project_id:
        out["project_id"] = project_id
    return out


def from_web_mesh_refinements(doc: dict | None) -> list[Any]:
    from cfddesk.project.mesh_refinements import parse_refinement_stubs

    if not isinstance(doc, dict):
        return []
    return parse_refinement_stubs(doc.get("refinements") or doc.get("mesh_refinements") or [])

