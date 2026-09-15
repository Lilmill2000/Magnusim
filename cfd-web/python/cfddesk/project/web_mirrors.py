"""Phase 2 land8: Project <-> web sibling JSON mirrors (v15).

`web_adapter` re-exports these `to_web_*` / `from_web_*` helpers so project_cli
can write Project then regenerate sibling mirrors.
"""
from __future__ import annotations

import dataclasses
import json
import re
import uuid
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


def to_web_materials(
    project: Any,
    *,
    sim_id: str | None = None,
    project_id: str | None = None,
    updated_at: str | None = None,
) -> dict[str, Any]:
    sim = _primary_sim(project, sim_id)
    mats_in = list(getattr(sim, "materials", None) or []) if sim else []
    out_mats: list[dict[str, Any]] = []
    for m in mats_in:
        if not isinstance(m, dict):
            continue
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
            d.setdefault("simulation_id", sim_id)
        if project_id:
            d.setdefault("project_id", project_id)
        out_mats.append(d)
    air = next((m for m in out_mats if re.search(r"air", str(m.get("name") or ""), re.I)), None)
    ts = updated_at or _utc_now()
    doc: dict[str, Any] = {
        "materials": out_mats,
        "updated_at": ts,
        "persistence": "filesystem",
    }
    if air is not None:
        doc["air"] = dict(air)
    if sim_id:
        doc["simulation_id"] = sim_id
    if project_id:
        doc["project_id"] = project_id
    return doc


def from_web_materials(doc: dict | list | None) -> list[dict[str, Any]]:
    if isinstance(doc, list):
        items = doc
    elif isinstance(doc, dict):
        items = doc.get("materials") if isinstance(doc.get("materials"), list) else []
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


def apply_web_sibling_to_project(
    project: Any,
    kind: str,
    doc: dict | None,
    *,
    sim_id: str | None = None,
) -> Any:
    from cfddesk.project.hierarchy import MeshNode

    sims = list(project.simulations or [])
    if not sims:
        return project
    idx = 0
    if sim_id:
        for i, s in enumerate(sims):
            if str(s.id) == str(sim_id):
                idx = i
                break
    sim = sims[idx]

    if kind == "materials":
        sim = dataclasses.replace(sim, materials=from_web_materials(doc))
    elif kind in ("boundary_conditions", "bcs"):
        bcs, _defaults = from_web_boundary_conditions(doc if isinstance(doc, dict) else None)
        sim = dataclasses.replace(sim, boundary_conditions=bcs)
    elif kind == "mesh":
        nodes, active = from_web_mesh(doc if isinstance(doc, dict) else None)
        if nodes:
            old_by_id = {m.id: m for m in sim.meshes}
            merged = []
            for n in nodes:
                old = old_by_id.get(n.id)
                refs = list(getattr(n, "refinements", None) or [])
                if not refs and old is not None:
                    refs = list(old.refinements)
                meta = getattr(n, "web_meta", None) or {}
                nn = MeshNode(
                    id=n.id,
                    name=n.name,
                    settings=n.settings,
                    last_mesh_fingerprint=n.last_mesh_fingerprint,
                    results_subdir=n.results_subdir,
                    n_cells=n.n_cells,
                    n_points=n.n_points,
                    refinements=list(refs),
                )
                nn.web_meta = meta  # type: ignore[attr-defined]
                merged.append(nn)
            sim = dataclasses.replace(sim, meshes=merged, active_mesh_id=active or merged[0].id)
    elif kind in ("mesh_refinements", "refinements"):
        refs = from_web_mesh_refinements(doc if isinstance(doc, dict) else None)
        mesh = sim.active_mesh()
        new_mesh = MeshNode(
            id=mesh.id,
            name=mesh.name,
            settings=mesh.settings,
            last_mesh_fingerprint=mesh.last_mesh_fingerprint,
            results_subdir=mesh.results_subdir,
            n_cells=mesh.n_cells,
            n_points=mesh.n_points,
            refinements=list(refs),
        )
        if hasattr(mesh, "web_meta"):
            new_mesh.web_meta = mesh.web_meta  # type: ignore[attr-defined]
        meshes = [new_mesh if m.id == mesh.id else m for m in sim.meshes]
        sim = dataclasses.replace(sim, meshes=meshes)
    elif kind in ("result_controls", "result_control"):
        sim = dataclasses.replace(
            sim, result_control=from_web_result_controls(doc if isinstance(doc, dict) else None)
        )
    elif kind in ("simulation_control", "sim_control"):
        sim = dataclasses.replace(
            sim,
            simulation_control=from_web_simulation_control(doc if isinstance(doc, dict) else None),
        )
    elif kind in ("runs", "runs_catalog", "catalog"):
        runs, active = from_web_runs_catalog(doc if isinstance(doc, dict) else None)
        sim = dataclasses.replace(sim, runs=runs, active_run_id=active)
    elif kind == "simulations":
        entries, _active = from_web_simulations(doc if isinstance(doc, dict) else None)
        by_id = {str(e.get("id")): e for e in entries}
        new_sims = []
        for s in sims:
            e = by_id.get(str(s.id))
            if e:
                s = dataclasses.replace(
                    s,
                    name=str(e.get("name") or s.name),
                    analysis_type=str(e.get("analysis_type") or s.analysis_type),
                )
                s.web_meta = {
                    k: v
                    for k, v in e.items()
                    if k not in ("id", "name", "analysis_type", "geometry_id")
                }  # type: ignore[attr-defined]
            new_sims.append(s)
        return dataclasses.replace(project, simulations=new_sims)
    else:
        return project

    sims[idx] = sim
    return dataclasses.replace(project, simulations=sims)


def regenerate_web_mirrors(
    project: Any,
    project_dir: str | Path,
    *,
    sim_id: str | None = None,
    project_id: str | None = None,
    kinds: list[str] | None = None,
) -> dict[str, Path]:
    root = Path(project_dir)
    root.mkdir(parents=True, exist_ok=True)
    pid = project_id or root.name
    sid = sim_id or (getattr(_primary_sim(project), "id", None) if _primary_sim(project) else None)
    ts = _utc_now()
    wanted = set(kinds) if kinds else {
        "materials", "boundary_conditions", "mesh", "mesh_refinements",
        "result_controls", "simulation_control", "simulations", "runs",
    }
    written: dict[str, Path] = {}

    def _write(rel: str, doc: dict) -> Path:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return path

    if "materials" in wanted:
        written["materials"] = _write(
            "materials.json", to_web_materials(project, sim_id=sid, project_id=pid, updated_at=ts)
        )
    if "boundary_conditions" in wanted:
        written["boundary_conditions"] = _write(
            "boundary_conditions.json",
            to_web_boundary_conditions(project, sim_id=sid, project_id=pid, updated_at=ts),
        )
    if "mesh" in wanted:
        written["mesh"] = _write(
            "mesh.json", to_web_mesh(project, sim_id=sid, project_id=pid, updated_at=ts)
        )
    if "mesh_refinements" in wanted:
        written["mesh_refinements"] = _write(
            "mesh_refinements.json",
            to_web_mesh_refinements(project, sim_id=sid, project_id=pid, updated_at=ts),
        )
    if "result_controls" in wanted:
        rc = to_web_result_controls(project, sim_id=sid, project_id=pid, updated_at=ts)
        written["result_controls"] = _write("result_controls.json", rc)
        aa = dict(rc)
        aa["mirror_of"] = "result_controls.json"
        written["area_average"] = _write("area_average.json", aa)
    if "simulation_control" in wanted:
        written["simulation_control"] = _write(
            "simulation_control.json",
            to_web_simulation_control(project, sim_id=sid, project_id=pid, updated_at=ts),
        )
    if "simulations" in wanted:
        cat = to_web_simulations(project, project_id=pid, updated_at=ts)
        written["simulations"] = _write("simulations.json", cat)
        active = next(
            (s for s in cat.get("simulations") or [] if str(s.get("id")) == str(cat.get("active_id"))),
            None,
        )
        if active:
            mirror = dict(active)
            mirror["simulation_json"] = str(root / "simulation.json")
            written["simulation"] = _write("simulation.json", mirror)
    if "runs" in wanted:
        catalog = to_web_runs_catalog(project, sim_id=sid, updated_at=ts)
        written["runs_catalog"] = _write("runs/catalog.json", catalog)
        (root / "runs").mkdir(parents=True, exist_ok=True)
        for r in catalog.get("runs") or []:
            rid = str(r.get("id") or "")
            if not rid:
                continue
            rel_name = f"{rid}.json" if rid.startswith("run-") else f"run-{rid}.json"
            _write(f"runs/{rel_name}", dict(r))
    return written


def sibling_updated_at(project_dir: Path, rel: str) -> float | None:
    path = project_dir / rel
    if not path.is_file():
        return None
    doc = _read_json(path)
    if isinstance(doc, dict):
        ts = _parse_iso(doc.get("updated_at"))
        if ts is not None:
            return ts
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def project_updated_at(project: Any, project_dir: Path | None = None) -> float | None:
    ts = _parse_iso(getattr(project, "updated_at", None))
    if ts is not None:
        return ts
    pers = getattr(project, "persistence", None) or {}
    if isinstance(pers, dict):
        ts = _parse_iso(pers.get("updated_at"))
        if ts is not None:
            return ts
    if project_dir is not None:
        path = Path(project_dir) / "project.json"
        if path.is_file():
            doc = _read_json(path)
            if isinstance(doc, dict):
                ts = _parse_iso(doc.get("updated_at"))
                if ts is not None:
                    return ts
            try:
                return path.stat().st_mtime
            except OSError:
                return None
    return None


def ingest_web_siblings_if_newer(project: Any, project_dir: str | Path) -> Any:
    root = Path(project_dir)
    proj_ts = project_updated_at(project, root)
    kind_map = {
        "materials.json": "materials",
        "boundary_conditions.json": "boundary_conditions",
        "mesh.json": "mesh",
        "mesh_refinements.json": "mesh_refinements",
        "result_controls.json": "result_controls",
        "simulation_control.json": "simulation_control",
        "simulations.json": "simulations",
        "runs/catalog.json": "runs",
    }
    for rel, kind in kind_map.items():
        sib_ts = sibling_updated_at(root, rel)
        if sib_ts is None:
            continue
        if proj_ts is None or sib_ts > proj_ts + 1e-6:
            doc = _read_json(root / rel)
            if isinstance(doc, dict):
                project = apply_web_sibling_to_project(project, kind, doc)
    pers = getattr(project, "persistence", None)
    if isinstance(pers, str):
        pers_d: dict[str, Any] = {"legacy": pers}
    else:
        pers_d = dict(pers or {})
    pers_d["web_mirrors"] = "derived"
    kwargs: dict[str, Any] = {
        "persistence": pers_d,
        "version": max(int(getattr(project, "version", 15) or 15), 15),
        "updated_at": getattr(project, "updated_at", None) or _utc_now(),
    }
    try:
        return dataclasses.replace(project, **kwargs)
    except TypeError:
        for k, v in kwargs.items():
            try:
                object.__setattr__(project, k, v)
            except Exception:
                setattr(project, k, v)
        return project


def is_python_project_doc(doc: dict | None) -> bool:
    return bool(
        isinstance(doc, dict)
        and isinstance(doc.get("version"), int)
        and isinstance(doc.get("units"), dict)
        and "simulations" in doc
    )


def load_or_synthesize_project(project_dir: str | Path) -> tuple[Any, str]:
    from cfddesk.project.hierarchy import Geometry, MeshNode, Simulation
    from cfddesk.project.model import PROJECT_VERSION, Project
    from cfddesk.project.settings import MeshSettings

    root = Path(project_dir)
    path = root / "project.json"
    doc = _read_json(path) if path.is_file() else None
    if is_python_project_doc(doc if isinstance(doc, dict) else None):
        return Project.from_dict(doc, project_dir=root), "python"  # type: ignore[arg-type]

    gid = uuid.uuid4().hex[:12]
    mid = uuid.uuid4().hex[:12]
    sid = "sim-1"
    for rel in ("simulations.json", "materials.json", "boundary_conditions.json", "mesh.json"):
        d = _read_json(root / rel)
        if isinstance(d, dict) and d.get("simulation_id"):
            sid = str(d["simulation_id"])
            break
        if isinstance(d, dict) and d.get("active_id") and rel == "simulations.json":
            sid = str(d["active_id"])
            break
    geom = Geometry(id=gid, name="Geometry 1", step_path="", faces=[], bodies=[])
    sim = Simulation(
        id=sid,
        name="Incompressible",
        analysis_type="incompressible",
        geometry_id=gid,
        boundary_conditions=[],
        meshes=[MeshNode(id=mid, name="Mesh 1", settings=MeshSettings())],
        runs=[],
        active_mesh_id=mid,
    )
    proj = Project(
        version=PROJECT_VERSION,
        scale_to_metres=0.001,
        native_unit="MM",
        declared_unit=None,
        units_confirmed=False,
        units_ambiguous=True,
        geometries=[geom],
        simulations=[sim],
    )
    proj = ingest_web_siblings_if_newer(proj, root)
    return proj, "synthesized"


def mark_web_mirrors_derived(project: Any) -> Any:
    pers = getattr(project, "persistence", None)
    if isinstance(pers, str):
        pers_d: dict[str, Any] = {"legacy": pers}
    else:
        pers_d = dict(pers or {})
    pers_d["web_mirrors"] = "derived"
    try:
        return dataclasses.replace(
            project,
            persistence=pers_d,
            updated_at=_utc_now(),
            version=max(int(getattr(project, "version", 15) or 15), 15),
        )
    except TypeError:
        project.persistence = pers_d
        project.updated_at = _utc_now()
        return project
