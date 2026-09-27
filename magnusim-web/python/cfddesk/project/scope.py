"""ScopeId plus one-time move of project-root setup files into the single study."""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cfddesk.project.paths import (
    assemble_study_bcs,
    create_mesh_folder,
    create_run_folder,
    walk_child_items,
    walk_geometries,
    walk_meshes,
    walk_runs,
    walk_studies,
)

_SIBLING_JSON = (
    "materials.json",
    "boundary_conditions.json",
    "mesh_refinements.json",
    "result_controls.json",
    "simulation_control.json",
    "mesh.json",
)


@dataclass(frozen=True)
class ScopeId:
    project_id: str
    geometry_id: str = ""
    study_id: str = ""
    mesh_id: str = ""
    run_id: str = ""
    item_id: str = ""

    def key(self) -> str:
        parts = [f"p:{self.project_id}"]
        if self.geometry_id:
            parts.append(f"g:{self.geometry_id}")
        if self.study_id:
            parts.append(f"s:{self.study_id}")
        if self.mesh_id:
            parts.append(f"mesh:{self.mesh_id}")
        if self.run_id:
            parts.append(f"run:{self.run_id}")
        if self.item_id:
            parts.append(f"item:{self.item_id}")
        return "/".join(parts)


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _write_json(path: Path, doc: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _rows(doc: dict[str, Any] | None, *keys: str) -> list[dict[str, Any]]:
    if not isinstance(doc, dict):
        return []
    for key in keys:
        raw = doc.get(key)
        if isinstance(raw, list):
            return [row for row in raw if isinstance(row, dict)]
    return []


def _mark_migration(project_dir: Path, value: bool | str) -> None:
    path = Path(project_dir) / "project.json"
    doc = _read_json(path)
    if not doc or doc.get("siblings_migrated") == value:
        return
    doc["siblings_migrated"] = value
    _write_json(path, doc)


def _copy_if_newer(src: Path, dest: Path) -> bool:
    if not src.is_file():
        return False
    if dest.is_file() and dest.stat().st_mtime >= src.stat().st_mtime:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    return True


def _same_study(row: dict[str, Any], study_id: str) -> bool:
    tagged = str(row.get("simulation_id") or "").strip()
    return not tagged or tagged == study_id


def migrate_root_siblings(project_dir: Path) -> bool:
    """Copy root setup JSON into the only study. Two studies are left untouched."""
    root = Path(project_dir)
    proj = _read_json(root / "project.json") or {}
    if proj.get("siblings_migrated") == "skipped-multi":
        return False
    studies = walk_studies(root)
    if len(studies) > 1:
        _mark_migration(root, "skipped-multi")
        return False
    if len(studies) != 1:
        return False
    study = studies[0]
    study_dir = Path(study["dir"])
    sid = str(study.get("id") or "")
    changed = False
    for name in _SIBLING_JSON:
        if _copy_if_newer(root / name, study_dir / name):
            changed = True
    if _copy_if_newer(root / "area_average.json", study_dir / "result_controls.json"):
        changed = True
    if _copy_if_newer(root / "runs" / "catalog.json", study_dir / "catalog.json"):
        changed = True
    if sid and not walk_meshes(root, sid):
        doc = _read_json(root / "mesh.json") or {}
        for row in _rows(doc, "meshes"):
            if not row.get("id") or not _same_study(row, sid):
                continue
            created = create_mesh_folder(root, sid, row)
            mesh_path = Path(created["dir"]) / "mesh.json"
            if not mesh_path.is_file():
                stored = {k: v for k, v in row.items() if k not in {"dir", "folder"}}
                stored["simulation_id"] = sid
                _write_json(mesh_path, stored)
            changed = True
    if sid and not walk_runs(root, sid):
        catalog = _read_json(root / "runs" / "catalog.json") or _read_json(study_dir / "catalog.json") or {}
        for row in _rows(catalog, "runs"):
            if not (row.get("id") or row.get("run_id")) or not _same_study(row, sid):
                continue
            created = create_run_folder(root, sid, row)
            run_path = Path(created["dir"]) / "run.json"
            if not run_path.is_file():
                stored = {k: v for k, v in row.items() if k not in {"dir", "folder"}}
                stored["simulation_id"] = sid
                _write_json(run_path, stored)
            changed = True
    _mark_migration(root, True)
    return changed


def _body_names(geom: dict[str, Any], proj: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for src in (geom.get("bodies"), geom.get("assembly_bodies")):
        if not isinstance(src, list):
            continue
        for body in src:
            if isinstance(body, str) and body:
                names.append(body)
            elif isinstance(body, dict) and body.get("name"):
                names.append(str(body["name"]))
    if names:
        return names
    gid = str(geom.get("id") or "")
    raw_geoms = proj.get("geometries")
    rows = raw_geoms if isinstance(raw_geoms, list) else []
    for row in rows:
        if isinstance(row, dict) and str(row.get("id") or "") == gid:
            return _body_names(row, {})
    return []


def _faces(row: dict[str, Any]) -> list[str]:
    raw = row.get("faces")
    if not isinstance(raw, list):
        return []
    return [str(face) for face in raw if str(face)]


def _material_name(study_dir: Path) -> str:
    for doc in [_read_json(study_dir / "materials.json"), *walk_child_items(study_dir / "materials", "material.json")]:
        for row in _rows(doc, "materials") or ([doc] if isinstance(doc, dict) and doc.get("name") else []):
            assigned = row.get("assigned_volumes")
            if isinstance(assigned, list) and assigned and row.get("name"):
                return str(row.get("name"))
    return "Air"


def _material_volumes(study_dir: Path) -> list[str]:
    vols: list[str] = []
    docs = [_read_json(study_dir / "materials.json")]
    for row in walk_child_items(study_dir / "materials", "material.json"):
        docs.append(row)
    for doc in docs:
        rows = _rows(doc, "materials")
        if not rows and isinstance(doc, dict) and doc.get("assigned_volumes"):
            rows = [doc]
        for row in rows:
            assigned = row.get("assigned_volumes")
            if isinstance(assigned, list):
                vols.extend(str(v) for v in assigned if str(v))
    return list(dict.fromkeys(vols))


def _bcs(root: Path, scope: ScopeId) -> list[dict[str, Any]]:
    """Same rows (and legacy ids) GET /api/bcs and hydrate return for this study."""
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in assemble_study_bcs(root, scope.study_id):
        item_id = str(row.get("id") or "")
        if item_id and item_id in seen:
            continue
        if item_id:
            seen.add(item_id)
        item_scope = ScopeId(
            scope.project_id,
            scope.geometry_id,
            scope.study_id,
            item_id=item_id,
        )
        rows.append(
            {
                "id": item_id,
                "name": str(row.get("name") or "BC"),
                "faces": _faces(row),
                "key": item_scope.key(),
            }
        )
    return rows


def _wall(study_dir: Path, study_id: str) -> str:
    """The same rule as the solve (paths.assemble_study_bc_defaults): the folder's
    defaults.json wins; the legacy boundary_conditions.json only when it is missing.
    The legacy file can still hold the old No-slip after the default is changed."""
    doc = _read_json(study_dir / "boundary_conditions" / "defaults.json") or {}
    if not doc:
        doc = _read_json(study_dir / "boundary_conditions.json") or {}
    row = _dict(_dict(doc.get("defaults_by_simulation")).get(study_id))
    wall = row.get("wall_type") or _dict(doc.get("defaults")).get("wall_type")
    return "Slip" if str(wall or "").strip().lower() == "slip" else "No-slip"


def _refinements(mesh_dir: Path, scope: ScopeId) -> list[dict[str, Any]]:
    folder_rows = walk_child_items(mesh_dir / "refinements", "refinement.json")
    legacy = _rows(_read_json(mesh_dir / "refinements.json"), "refinements")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in folder_rows + legacy:
        item_id = str(row.get("id") or "")
        if item_id and item_id in seen:
            continue
        if item_id:
            seen.add(item_id)
        out.append(
            {
                "id": item_id,
                "name": str(row.get("name") or "Refinement"),
                "faces": _faces(row),
                "key": ScopeId(
                    scope.project_id,
                    scope.geometry_id,
                    scope.study_id,
                    scope.mesh_id,
                    item_id=item_id,
                ).key(),
            }
        )
    return out


def _mesh_node(project_id: str, geometry_id: str, study_id: str, mesh: dict[str, Any]) -> dict[str, Any]:
    live = _dict(mesh.get("live_mesh_result"))
    scope = ScopeId(project_id, geometry_id, study_id, mesh_id=str(mesh.get("id") or ""))
    cells = live.get("n_cells", mesh.get("n_cells"))
    return {
        "id": str(mesh.get("id") or ""),
        "name": str(mesh.get("name") or "Mesh"),
        "key": scope.key(),
        "simulation_id": study_id,
        "geometry_id": geometry_id,
        "generated": bool(mesh.get("generated")),
        "case_dir": str(live.get("case_dir") or mesh.get("case_dir") or ""),
        "n_cells": cells if isinstance(cells, (int, float)) and not isinstance(cells, bool) else None,
        "live_status": str(live.get("status") or mesh.get("status") or ""),
        "refinements": _refinements(Path(mesh["dir"]), scope) if mesh.get("dir") else [],
    }


def _run_node(project_id: str, geometry_id: str, study_id: str, run: dict[str, Any]) -> dict[str, Any]:
    run_id = str(run.get("id") or run.get("run_id") or "")
    scope = ScopeId(project_id, geometry_id, study_id, run_id=run_id)
    controls = []
    for row in run.get("result_controls") or []:
        if not isinstance(row, dict):
            continue
        item_id = str(row.get("id") or row.get("name") or "")
        controls.append(
            {
                "id": item_id,
                "name": str(row.get("name") or row.get("kind") or "Result"),
                "faces": _faces(row),
                "key": ScopeId(
                    project_id,
                    geometry_id,
                    study_id,
                    run_id=run_id,
                    item_id=item_id,
                ).key(),
            }
        )
    return {
        "id": run_id,
        "name": str(run.get("name") or "Run"),
        "key": scope.key(),
        "mesh_id": str(run.get("mesh_id") or ""),
        "mesh_name": str(run.get("mesh_name") or ""),
        "simulation_id": study_id,
        "status": str(run.get("status") or ""),
        "case_dir": str(run.get("case_dir") or ""),
        "n_saved_times": run.get("n_saved_times"),
        "last_saved_iteration": run.get("last_saved_iteration"),
        "has_results": bool(run.get("has_results")),
        "result_controls": controls,
    }


def build_project_tree(project_dir: Path, project_id: str) -> dict[str, Any]:
    """Geometries, studies, meshes, and runs that belong to this project on disk."""
    root = Path(project_dir)
    proj = _read_json(root / "project.json") or {}
    catalog = _read_json(root / "simulations.json") or {}
    studies = walk_studies(root)
    active = str(catalog.get("active_id") or "")
    if not active and len(studies) == 1:
        active = str(studies[0].get("id") or "")
    geometries = []
    for geom in walk_geometries(root):
        gid = str(geom.get("id") or "")
        gscope = ScopeId(project_id, gid)
        study_nodes = []
        for study in studies:
            if str(study.get("geometry_id") or "") != gid:
                continue
            sid = str(study.get("id") or "")
            sscope = ScopeId(project_id, gid, sid)
            study_dir = Path(study["dir"])
            study_nodes.append(
                {
                    "id": sid,
                    "name": str(study.get("name") or "Incompressible"),
                    "geometry_id": gid,
                    "key": sscope.key(),
                    "sort_index": study.get("sort_index"),
                    "active": sid == active,
                    "wall_default": _wall(study_dir, sid),
                    "material_name": _material_name(study_dir),
                    "material_volumes": _material_volumes(study_dir),
                    "bcs": _bcs(root, sscope),
                    "meshes": [
                        _mesh_node(project_id, gid, sid, mesh) for mesh in walk_meshes(root, sid)
                    ],
                    "runs": [_run_node(project_id, gid, sid, run) for run in walk_runs(root, sid)],
                }
            )
        geometries.append(
            {
                "id": gid,
                "name": str(geom.get("name") or geom.get("original_filename") or "Geometry"),
                "key": gscope.key(),
                "bodies": _body_names(geom, proj),
                "studies": study_nodes,
            }
        )
    return {"ok": True, "project_id": project_id, "geometries": geometries}
