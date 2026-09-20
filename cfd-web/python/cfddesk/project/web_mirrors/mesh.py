"""Mesh + mesh_refinements sibling mirror converters."""
from __future__ import annotations

import dataclasses
from typing import Any

from cfddesk.project.web_mirrors._common import (
    _algo_from_web,
    _algo_to_web,
    _all_sims,
    _primary_sim,
    _utc_now,
)


def _mesh_entry(m: Any, *, sim_id: str | None) -> dict[str, Any]:
    settings = m.settings.to_dict() if hasattr(m.settings, "to_dict") else {}
    meta = dict(getattr(m, "web_meta", None) or {})
    # Product mesh_engine (W20 Advanced):
    #   standard -> generate_standard.py / gmsh-hexcore (Cyclone Default bar)
    #   cfmesh   -> legacy cartesianMesh (explicit Advanced choice only)
    # Do NOT map hexcore_backend -> mesh_engine. hexcore_backend is an internal
    # Standard hex-core impl hint (cfmesh|bodyfit), not the generate path picker.
    # Mapping it flipped new meshes onto legacy cfMesh / away from Cyclone path.
    ui_engine = str(meta.get("ui_mesh_engine") or "standard").strip().lower()
    if ui_engine not in ("standard", "cfmesh"):
        ui_engine = "standard"
    web_settings = {
        "name": m.name,
        "algorithm": _algo_to_web(str(settings.get("algorithm") or "standard")),
        "sizing": "Automatic" if settings.get("sizing_mode", "automatic") == "automatic" else "Manual",
        "fineness": int(settings.get("fineness") or 5),
        "physics_based_meshing": bool(settings.get("physics_based", True)),
        "hex_element_core": bool(settings.get("hex_element_core", True)),
        "automatic_boundary_layers": bool(settings.get("add_layers", True)),
        "maximum_meshing_runtime": str(settings.get("max_meshing_runtime_s") or 18000.0),
        "maximum_meshing_runtime_unit": "s",
        "advanced": {
            "mesh_engine": ui_engine,
        },
    }
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
    for k, v in meta.items():
        if k not in entry and k != "live_mesh_result":
            entry[k] = v
    return entry


def to_web_mesh(
    project: Any,
    *,
    sim_id: str | None = None,
    project_id: str | None = None,
    updated_at: str | None = None,
) -> dict[str, Any]:
    sim = _primary_sim(project, sim_id)
    meshes_out: list[dict[str, Any]] = []
    for row in _all_sims(project):
        sid = str(getattr(row, "id", "") or "")
        if sim_id and sid != str(sim_id):
            continue
        for m in getattr(row, "meshes", None) or []:
            meshes_out.append(_mesh_entry(m, sim_id=sid))
    active_id = None
    top_live = None
    if sim:
        active_id = getattr(sim, "active_mesh_id", None) or (sim.meshes[0].id if sim.meshes else None)
        if active_id:
            for entry in meshes_out:
                if entry.get("id") == active_id and entry.get("simulation_id") == str(sim.id):
                    top_live = entry.get("live_mesh_result")
                    break
    ts = updated_at or _utc_now()
    doc: dict[str, Any] = {
        "active_id": active_id,
        "meshes": meshes_out,
        "updated_at": ts,
        "persistence": "filesystem",
    }
    scoped = [
        m
        for m in meshes_out
        if sim is None or str(m.get("simulation_id") or "") == str(getattr(sim, "id", ""))
    ]
    doc["meshes"] = scoped
    if scoped:
        primary = next((m for m in scoped if m.get("id") == active_id), scoped[0])
        doc["id"] = primary.get("id")
        doc["name"] = primary.get("name")
        doc["settings"] = primary.get("settings")
        if top_live is None:
            top_live = primary.get("live_mesh_result")
        if top_live:
            doc["live_mesh_result"] = top_live
    if sim_id or (sim is not None and getattr(sim, "id", None)):
        doc["simulation_id"] = sim_id or str(sim.id)
    if project_id:
        doc["project_id"] = project_id
    return doc


def from_web_mesh(doc: dict | None) -> tuple[list[Any], str]:
    from cfddesk.project.hierarchy import MeshNode
    from cfddesk.project.settings import MeshSettings

    if not isinstance(doc, dict):
        return [], ""
    raw_meshes = checked if isinstance((checked := doc.get("meshes")), list) else None
    if not raw_meshes:
        raw_meshes = [doc] if doc.get("id") or doc.get("settings") else []
    nodes: list[Any] = []
    for raw in raw_meshes:
        if not isinstance(raw, dict):
            continue
        settings_raw = checked if isinstance((checked := raw.get("settings")), dict) else {}
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
                settings_raw.get("automatic_boundary_layers", settings_raw.get("add_layers", True))
            ),
            algorithm=_algo_from_web(str(settings_raw.get("algorithm") or "Standard")),  # type: ignore[arg-type]
            hex_element_core=bool(settings_raw.get("hex_element_core", True)),
        )
        adv = checked if isinstance((checked := settings_raw.get("advanced")), dict) else {}
        # Build meta first so we can detect an *explicit* ui_mesh_engine stamp before
        # reading advanced.mesh_engine (post-0c6be39 hydrate migrate).
        # Never inherit the file-level live onto another mesh. Settings-only
        # copies used to pick up the active study's generated result that way.
        live = raw.get("live_mesh_result")
        if not isinstance(live, dict):
            live = None
        meta = {
            k: v
            for k, v in raw.items()
            if k not in ("id", "name", "settings", "meshes", "simulation_id", "n_cells", "n_points")
        }
        # Product mesh_engine:
        #   explicit ui_mesh_engine=cfmesh -> real Advanced pick, keep cfmesh
        #   absent ui_mesh_engine + adv.mesh_engine=cfmesh -> old hexcore_backend-coupled
        #     bug stamp; coerce to standard and persist ui_mesh_engine=standard
        # Soft-pass kill: do NOT blind-rewrite every cfmesh->standard.
        if "ui_mesh_engine" in meta:
            ui_engine = str(meta.get("ui_mesh_engine") or "standard").strip().lower()
        else:
            adv_engine = str(adv.get("mesh_engine") or "standard").strip().lower()
            if adv_engine not in ("standard", "cfmesh"):
                adv_engine = "standard"
            ui_engine = "standard" if adv_engine == "cfmesh" else adv_engine
        if ui_engine not in ("standard", "cfmesh"):
            ui_engine = "standard"
        # Explicit legacy Advanced=cfmesh only. Do not treat default hexcore_backend as
        # product mesh_engine (that routed Standard generates off Cyclone gmsh-hexcore).
        if ui_engine == "cfmesh":
            ms = dataclasses.replace(ms, hexcore_backend="cfmesh")
        runtime = settings_raw.get("maximum_meshing_runtime")
        if runtime is not None:
            try:
                ms = dataclasses.replace(ms, max_meshing_runtime_s=float(runtime))
            except (TypeError, ValueError):
                pass
        meta["ui_mesh_engine"] = ui_engine
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
    refs: list[dict[str, Any]] = []
    for sim in _all_sims(project):
        sid = str(getattr(sim, "id", "") or "")
        if not getattr(sim, "meshes", None):
            continue
        mesh = sim.active_mesh() if hasattr(sim, "active_mesh") else None
        for r in getattr(mesh, "refinements", None) or []:
            if hasattr(r, "to_dict"):
                row = r.to_dict()
            elif isinstance(r, dict):
                row = dict(r)
            else:
                continue
            if sid:
                row["simulation_id"] = sid
            if project_id:
                row.setdefault("project_id", project_id)
            refs.append(row)
    ts = updated_at or _utc_now()
    out: dict[str, Any] = {
        "refinements": refs,
        "updated_at": ts,
        "persistence": "filesystem",
    }
    active = _primary_sim(project, sim_id)
    if sim_id or (active is not None and getattr(active, "id", None)):
        out["simulation_id"] = sim_id or str(active.id)
    if project_id:
        out["project_id"] = project_id
    return out


def from_web_mesh_refinements(doc: dict | None) -> list[Any]:
    from cfddesk.project.mesh_refinements import parse_refinement_stubs

    if not isinstance(doc, dict):
        return []
    return parse_refinement_stubs(doc.get("refinements") or doc.get("mesh_refinements") or [])

