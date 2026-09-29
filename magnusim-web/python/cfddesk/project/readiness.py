"""Readiness of a run, asked of its analysis through the contract.

The core checks what every analysis needs (a study, a generated mesh); the
analysis's ``validate_ready`` decides the rest (materials, boundary
conditions, its own settings).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from cfddesk.registry.contract import ReadyContext


def study_doc(project_dir: Path | str, sim_id: str | None) -> dict[str, Any]:
    """The study's settings: its catalog row (every field the study panel saved)
    with its folder's id.json on top (the identity), without folder paths."""
    from cfddesk.project.paths import find_study
    from cfddesk.project.study_physics import study_record

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
    from cfddesk.project.paths import study_json_path
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
        mesh={"mesh_id": mesh.get("mesh_id"), "mesh_name": mesh.get("mesh_name"), "ok": bool(mesh.get("ok"))},
    )
