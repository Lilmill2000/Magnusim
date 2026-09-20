"""Project root + sibling JSON helpers for the worker."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from cfddesk.project.web_writes import (
    MATERIALS_MAX_BYTES,
    read_json,
    slim_mesh_doc,
    strip_material_notes,
)


def web_root() -> Path:
    env = (os.environ.get("MAGNUSIM_WEB_ROOT") or os.environ.get("CFDDESK_WEB_ROOT") or "").strip()
    if env:
        return Path(env)
    try:
        from cfddesk.wsl.config import web_root as _wr

        return _wr()
    except Exception:
        return Path(__file__).resolve().parents[3]


def projects_root() -> Path:
    env = (os.environ.get("MAGNUSIM_PROJECTS_ROOT") or os.environ.get("CFDDESK_PROJECTS_ROOT") or "").strip()
    if env:
        return Path(env)
    return web_root() / "projects"


def project_dir(project_id: str) -> Path:
    pid = str(project_id or "").strip()
    if not pid or "/" in pid or "\\" in pid or pid in {".", ".."}:
        raise ValueError("invalid project id")
    return projects_root() / pid


def active_id() -> str | None:
    path = projects_root() / "active.json"
    data = read_json(path)
    aid = data.get("project_id")
    return str(aid) if aid else None


def set_active_id(project_id: str | None) -> None:
    from cfddesk.project.web_writes import atomic_write, now_iso

    atomic_write(
        projects_root() / "active.json",
        {"project_id": project_id, "updated_at": now_iso()},
    )


def read_sibling(project_id: str, rel: str, sim_id: str | None = None) -> dict[str, Any] | None:
    from cfddesk.project.paths import study_json_path
    from cfddesk.project.web_writes import assemble_mesh_doc

    sid = str(sim_id or "").strip() or None
    if rel == "mesh.json" and sid:
        return assemble_mesh_doc(project_dir(project_id), sid)
    study_path = study_json_path(project_dir(project_id), sid, rel) if sid else None
    path = study_path if study_path is not None else project_dir(project_id) / rel
    if not path.is_file():
        return None
    try:
        if rel == "materials.json" and path.stat().st_size > MATERIALS_MAX_BYTES:
            return None
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    if rel == "materials.json":
        return strip_material_notes(data)
    if rel == "mesh.json":
        return slim_mesh_doc(data)
    return data
