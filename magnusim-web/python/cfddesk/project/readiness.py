"""Readiness of a run, asked of its analysis through the contract.

The core checks what every analysis needs (a study, a generated mesh); the
analysis's ``validate_ready`` decides the rest (materials, boundary
conditions, its own settings).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from cfddesk.registry.contract import ReadyContext


def study_doc(project_dir: Path | str, sim_id: str | None) -> dict[str, Any]:
    """The study's settings: its catalog row (every field the study panel saved)
    with its folder's id.json on top (the identity), without folder paths."""
    from cfddesk.project.paths import find_study

    sid = str(sim_id or "").strip()
    if not sid:
        return {}
    root = Path(project_dir)
    merged = {**(study_record(root, sid) or {}), **(find_study(root, sid) or {})}
    return {k: v for k, v in merged.items() if k not in ("dir", "geometry_dir", "folder")}


def ready_context(
    project_dir: Path | str,
    *,
    simulation_id: str | None,
    run_id: str = "",
    mesh_id: str = "",
) -> ReadyContext:
    """The study, its mesh and its JSON documents, as :func:`validate_ready` sees them."""
    from cfddesk.project.paths import assemble_study_bcs, assemble_study_materials, study_json_path
    from cfddesk.project.web_adapter import resolve_mesh, resolve_study_id

    root = Path(project_dir)
    sid = resolve_study_id(root, simulation_id, mesh_id or None) or ""
    mesh = resolve_mesh(root, mesh_id=mesh_id or None, simulation_id=sid or None, require_poly=False)
    study = study_doc(root, sid)

    def read_study(name: str) -> Any:
        rel = name if name.endswith(".json") else f"{name}.json"
        path = study_json_path(root, sid, rel) if sid else None
        if path is None or not Path(path).is_file():
            return None
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    case_dir = mesh.get("case_dir")
    return ReadyContext(
        project_dir=root,
        simulation_id=sid,
        run_id=str(run_id or ""),
        mesh_id=str(mesh.get("mesh_id") or mesh_id or ""),
        mesh_case_dir=Path(case_dir) if case_dir else None,
        patches=tuple(mesh.get("patches") or ()),
        study=study,
        read_study=read_study,
        mesh={
            "mesh_id": mesh.get("mesh_id"),
            "mesh_name": mesh.get("mesh_name"),
            "ok": bool(mesh.get("ok")),
            **_mesh_regions(root, sid, mesh),
        },
        materials=tuple(assemble_study_materials(root, sid)) if sid else (),
        bcs=tuple(assemble_study_bcs(root, sid)) if sid else (),
    )


def _mesh_regions(root: Path, sid: str, mesh: dict[str, Any]) -> dict[str, Any]:
    """Host API 1.8: a mesh of several regions gives its ``regions`` ([{name, role, bodies,
    cells}], as ``RunInputs.mesh``); a mesh whose regions are not the ones the study's
    materials make now (a body given another material, or a solid one, after it was made)
    gets ``out_of_date_materials`` (the tree's rule, ``cfddesk.project.scope``); ``engine``
    is the mesher it was made with (``standard``, ``snappy_hexdominant``, ``cfmesh``)."""
    out: dict[str, Any] = {}
    regions = mesh.get("regions")
    if isinstance(regions, list) and regions:
        out["regions"] = [dict(r) for r in regions if isinstance(r, dict)]
    if mesh.get("engine"):
        out["engine"] = str(mesh["engine"])
    if not sid or not mesh.get("ok"):
        return out
    try:
        from cfddesk.project.paths import find_geometry, find_study
        from cfddesk.project.regions import regions_for_mesh, regions_signature
        from cfddesk.project.scope import body_names

        study = find_study(root, sid) or {}
        geom = find_geometry(root, str(study.get("geometry_id") or "")) or {}
        proj = _read(root / "project.json") or {}
        n_bodies = len(body_names(geom, proj if isinstance(proj, dict) else {}))
        if n_bodies > 0 and regions_signature(out.get("regions")) != regions_signature(regions_for_mesh(root, sid, n_bodies)):
            out["out_of_date_materials"] = True
    except Exception as exc:
        # Not out of date as far as this check knows; say why it could not tell.
        print(f"[readiness] the mesh's regions could not be checked against the materials: {exc!r}", file=sys.stderr)
    return out


def _read(path: Path) -> Any:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None


def study_record(project_dir: Path | str, sim_id: str | None) -> dict[str, Any] | None:
    """The study's record: its ``simulations.json`` entry, else a matching ``simulation.json``."""
    root = Path(project_dir)
    catalog = _read(root / "simulations.json")
    if isinstance(catalog, dict) and isinstance(catalog.get("simulations"), list):
        want = sim_id or catalog.get("active_id")
        for rec in catalog["simulations"]:
            if isinstance(rec, dict) and want and str(rec.get("id")) == str(want):
                return rec
    single = _read(root / "simulation.json")
    if isinstance(single, dict) and (not sim_id or str(single.get("id") or "") == str(sim_id)):
        return single
    return None
