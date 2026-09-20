"""Shared web-sibling write helpers (CLI + worker).

Node used to spawn project_cli per request. The long-lived worker calls these
in-process; the CLI stays a thin argparse wrapper over the same functions.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_WIN_LOCK_ERRNOS = {13, 16}
_WIN_LOCK_WINERRORS = {5, 32}

ALLOWED_WRITE_JSON_RELS = frozenset(
    {
        "materials.json",
        "boundary_conditions.json",
        "mesh.json",
        "mesh_refinements.json",
        "result_controls.json",
        "area_average.json",
        "simulation_control.json",
        "runs/catalog.json",
    }
)

_WRITE_JSON_KIND: dict[str, str] = {
    "materials.json": "materials",
    "boundary_conditions.json": "boundary_conditions",
    "mesh.json": "mesh",
    "mesh_refinements.json": "mesh_refinements",
    "result_controls.json": "result_controls",
    "area_average.json": "result_controls",
    "simulation_control.json": "simulation_control",
    "runs/catalog.json": "catalog",
}

_WRITE_JSON_INCREMENT: dict[str, str] = {
    "materials.json": "W18",
    "boundary_conditions.json": "W19",
    "mesh.json": "W20",
    "mesh_refinements.json": "W26",
    "result_controls.json": "W22",
    "area_average.json": "W22",
    "simulation_control.json": "W17",
    "runs/catalog.json": "W27",
}

_MESH_EXTRAS = ("live_mesh_result", "meshes", "bank_exact", "generated", "id", "name", "active_id")

_SIBLING_LIST_KEY = {
    "materials": "materials",
    "boundary_conditions": "boundary_conditions",
    "bcs": "boundary_conditions",
    "mesh": "meshes",
    "mesh_refinements": "refinements",
    "refinements": "refinements",
    "result_controls": "result_controls",
    "runs": "runs",
    "catalog": "runs",
}

MATERIALS_MAX_BYTES = 256 * 1024
MESH_LOG_EXCERPT_MAX = 4000


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _is_replace_lock(exc: BaseException) -> bool:
    if isinstance(exc, PermissionError):
        return True
    if not isinstance(exc, OSError):
        return False
    win = getattr(exc, "winerror", None)
    if win in _WIN_LOCK_WINERRORS:
        return True
    return exc.errno in _WIN_LOCK_ERRNOS


def atomic_write(path: Path, doc: dict[str, Any]) -> None:
    """Write JSON next to ``path`` then replace. Retry Windows lock (WinError 5/32)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        last: BaseException | None = None
        for attempt in range(8):
            try:
                os.replace(tmp, path)
                return
            except OSError as exc:
                last = exc
                if not _is_replace_lock(exc) or attempt == 7:
                    raise
                time.sleep(0.05 * (attempt + 1))
        if last:
            raise last
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _row_sim_id(rec: Any) -> str:
    if not isinstance(rec, dict):
        return ""
    raw = rec.get("simulation_id")
    return str(raw).strip() if raw is not None else ""


def live_simulation_ids(project_dir: Path | None) -> set[str] | None:
    """Ids in simulations.json, or None when that catalog is missing (do not guess)."""
    if project_dir is None:
        return None
    cat = read_json(Path(project_dir) / "simulations.json")
    if not cat:
        return None
    sims = cat.get("simulations")
    if not isinstance(sims, list):
        return set()
    return {str(s.get("id") or "").strip() for s in sims if isinstance(s, dict) and s.get("id")}


def _as_id_set(values: Any) -> set[str]:
    if not values:
        return set()
    if isinstance(values, (str, int)):
        values = [values]
    return {str(v).strip() for v in values if v is not None and str(v).strip()}


def merge_other_studies(
    existing: dict[str, Any] | None,
    outgoing: dict[str, Any],
    *,
    kind: str,
    incoming: dict[str, Any] | None = None,
    project_dir: Path | None = None,
    drop_ids: Any = None,
    drop_simulation_ids: Any = None,
) -> dict[str, Any]:
    """No-op. Each study lives in its own folder; never merge another study's rows."""
    return outgoing if isinstance(outgoing, dict) else (existing or {})


def _scope_doc_to_study(doc: dict[str, Any], kind: str, sim_id: str) -> dict[str, Any]:
    if not sim_id or not isinstance(doc, dict):
        return doc
    out = dict(doc)
    key = _SIBLING_LIST_KEY.get(kind)
    if key:
        rows = []
        for rec in out.get(key) or []:
            if not isinstance(rec, dict):
                continue
            sid = _row_sim_id(rec)
            if sid and sid != sim_id:
                continue
            row = dict(rec)
            row["simulation_id"] = sim_id
            rows.append(row)
        out[key] = rows
    defs = out.get("defaults_by_simulation")
    if isinstance(defs, dict):
        keep = defs.get(sim_id)
        out["defaults_by_simulation"] = {sim_id: keep} if keep is not None else {}
    out["simulation_id"] = sim_id
    return out


def assemble_mesh_doc(project_dir: Path, sim_id: str, want_id: str | None = None) -> dict[str, Any]:
    from cfddesk.project.paths import walk_meshes

    meshes = walk_meshes(project_dir, sim_id)
    want = str(want_id or "").strip()
    active = next((m for m in meshes if str(m.get("id")) == want), None) if want else None
    return stamp(
        {
            "meshes": meshes,
            "active_id": (active or {}).get("id"),
            "id": (active or {}).get("id"),
            "name": (active or {}).get("name"),
            "settings": (active or {}).get("settings"),
            "generated": bool(active and active.get("generated")),
            "live_mesh_result": (active or {}).get("live_mesh_result"),
            "simulation_id": sim_id,
        },
        sim_id=sim_id,
        increment="W20",
    )


def persist_mesh_doc(project_dir: Path, sim_id: str, doc: dict[str, Any]) -> dict[str, Any]:
    import shutil

    from cfddesk.project.paths import (
        bind_mesh_case_paths,
        create_mesh_folder,
        ensure_study_folder,
        find_study,
        walk_meshes,
    )

    if not sim_id:
        raise ValueError("simulation_id required to persist meshes")
    if not find_study(project_dir, sim_id):
        ensure_study_folder(project_dir, sim_id)
    if not find_study(project_dir, sim_id):
        raise ValueError(f"study folder missing for {sim_id}")
    existing = walk_meshes(project_dir, sim_id)
    by_id = {str(m.get("id")): m for m in existing}
    keep: set[str] = set()
    for m in doc.get("meshes") or []:
        if not isinstance(m, dict) or not m.get("id"):
            continue
        sid = _row_sim_id(m)
        if sid and sid != sim_id:
            continue
        mid = str(m["id"])
        keep.add(mid)
        folder = by_id.get(mid)
        folder_dir = (
            Path(folder["dir"]) if folder else Path(create_mesh_folder(project_dir, sim_id, m)["dir"])
        )
        rec = {**m, "simulation_id": sim_id}
        bind_mesh_case_paths(rec, folder_dir)
        rec.pop("dir", None)
        atomic_write(
            folder_dir / "id.json",
            {"id": rec["id"], "name": rec.get("name"), "simulation_id": sim_id, "kind": "mesh"},
        )
        atomic_write(folder_dir / "mesh.json", slim_mesh_doc(rec) or rec)
    if doc.get("prune"):
        for m in existing:
            if str(m.get("id")) not in keep:
                shutil.rmtree(m["dir"], ignore_errors=True)
    return assemble_mesh_doc(project_dir, sim_id, doc.get("active_id") or doc.get("id"))


def _study_dest(project_dir: Path, rel: str, sim_id: str) -> Path:
    from cfddesk.project.paths import ensure_study_folder, study_json_path

    path = study_json_path(project_dir, sim_id, rel)
    if path is None:
        ensure_study_folder(project_dir, sim_id)
        path = study_json_path(project_dir, sim_id, rel)
    if path is None:
        raise ValueError(f"study folder missing for {sim_id!r}")
    return path


def stamp(doc: dict[str, Any], *, sim_id: str | None, increment: str) -> dict[str, Any]:
    out = dict(doc)
    out["updated_at"] = now_iso()
    out["persistence"] = "filesystem"
    out["increment"] = increment
    if sim_id:
        out["simulation_id"] = sim_id
    return out


def slim_log_excerpt(text: Any, max_len: int = MESH_LOG_EXCERPT_MAX) -> Any:
    if text is None:
        return None
    s = str(text)
    if not s:
        return ""
    return s[-max_len:] if len(s) > max_len else s


def slim_live_mesh_result(live: Any) -> Any:
    if not isinstance(live, dict) or "log_excerpt" not in live:
        return live
    excerpt = slim_log_excerpt(live.get("log_excerpt"))
    if excerpt == live.get("log_excerpt"):
        return live
    out = dict(live)
    out["log_excerpt"] = excerpt
    return out


def slim_mesh_doc(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(doc, dict):
        return doc
    changed = False
    live = slim_live_mesh_result(doc.get("live_mesh_result"))
    if live is not doc.get("live_mesh_result"):
        changed = True
    meshes = doc.get("meshes")
    new_meshes = meshes
    if isinstance(meshes, list):
        rebuilt: list[Any] = []
        for m in meshes:
            if not isinstance(m, dict) or "live_mesh_result" not in m:
                rebuilt.append(m)
                continue
            sl = slim_live_mesh_result(m.get("live_mesh_result"))
            if sl is m.get("live_mesh_result"):
                rebuilt.append(m)
            else:
                changed = True
                rebuilt.append({**m, "live_mesh_result": sl})
        new_meshes = rebuilt
    if not changed:
        return doc
    out = dict(doc)
    out["live_mesh_result"] = live
    out["meshes"] = new_meshes
    return out


def strip_material_notes(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(doc, dict):
        return doc
    next_doc = dict(doc)
    next_doc.pop("note", None)
    air = next_doc.get("air")
    if isinstance(air, dict):
        air = dict(air)
        air.pop("note", None)
        next_doc["air"] = air
    mats = next_doc.get("materials")
    if isinstance(mats, list):
        cleaned = []
        for m in mats:
            if not isinstance(m, dict):
                cleaned.append(m)
                continue
            row = dict(m)
            row.pop("note", None)
            cleaned.append(row)
        next_doc["materials"] = cleaned
    return next_doc


def write_through_project(
    project_dir: Path, kind: str, body: dict, *, sim_id: str = ""
) -> tuple[object, str, dict]:
    from cfddesk.project.web_mirrors import (
        apply_web_sibling_to_project,
        is_python_project_doc,
        load_or_synthesize_project,
        mark_web_mirrors_derived,
        regenerate_web_mirrors,
        to_web_boundary_conditions,
        to_web_materials,
        to_web_mesh,
        to_web_mesh_refinements,
        to_web_result_controls,
        to_web_runs_catalog,
        to_web_simulation_control,
        to_web_simulations,
    )

    proj, mode = load_or_synthesize_project(project_dir)
    proj = apply_web_sibling_to_project(
        proj, kind, body if isinstance(body, dict) else {}, sim_id=sim_id or None
    )
    proj = mark_web_mirrors_derived(proj)
    proj_path = project_dir / "project.json"
    existing = read_json(proj_path)
    if is_python_project_doc(existing) or mode == "python":
        try:
            proj.save(proj_path)
            mode = "python"
        except Exception:
            mode = mode if mode != "python" else "synthesized"
    kinds = [kind if kind != "bcs" else "boundary_conditions"]
    if kind in ("boundary_conditions", "bcs"):
        kinds = ["boundary_conditions"]
    elif kind == "refinements":
        kinds = ["mesh_refinements"]
    elif kind == "sim_control":
        kinds = ["simulation_control"]
    elif kind == "catalog":
        kinds = ["runs"]
    regenerate_web_mirrors(
        proj, project_dir, sim_id=sim_id or None, project_id=project_dir.name, kinds=kinds
    )
    to_map: dict[str, Any] = {
        "materials": to_web_materials,
        "boundary_conditions": to_web_boundary_conditions,
        "bcs": to_web_boundary_conditions,
        "mesh": to_web_mesh,
        "mesh_refinements": to_web_mesh_refinements,
        "refinements": to_web_mesh_refinements,
        "result_controls": to_web_result_controls,
        "simulation_control": to_web_simulation_control,
        "sim_control": to_web_simulation_control,
        "simulations": to_web_simulations,
        "runs": to_web_runs_catalog,
        "catalog": to_web_runs_catalog,
    }
    fn = to_map.get(kind, to_web_materials)
    if kind in ("runs", "catalog"):
        mirror = fn(proj, sim_id=sim_id or None)
    else:
        mirror = fn(proj, sim_id=sim_id or None, project_id=project_dir.name)
    return proj, mode, mirror


def set_materials(project_dir: Path, body: dict[str, Any], *, sim_id: str = "") -> dict[str, Any]:
    from cfddesk.project.paths import find_study, persist_child_item

    raw = body if isinstance(body, dict) else {"materials": body}
    raw = strip_material_notes(raw) or raw
    sid = str(sim_id or raw.get("simulation_id") or "").strip()
    path = _study_dest(project_dir, "materials.json", sid)
    _proj, mode, mirror = write_through_project(project_dir, "materials", raw, sim_id=sid)
    src = mirror if isinstance(mirror, dict) and (mirror.get("materials") or mirror.get("air")) else raw
    doc = _scope_doc_to_study(stamp(src, sim_id=sid, increment="W18"), "materials", sid)
    only = str(raw.get("only_id") or "").strip()
    study = find_study(project_dir, sid)
    if study:
        parent = Path(study["dir"]) / "materials"
        for rec in doc.get("materials") or []:
            if not isinstance(rec, dict) or rec.get("id") is None:
                continue
            if only and str(rec.get("id")) != only:
                continue
            persist_child_item(parent, "material", {**rec, "simulation_id": sid})
    proj_path = project_dir / "project.json"
    proj = read_json(proj_path)
    if proj and mode != "python":
        air = doc.get("air") or (doc.get("materials") or [None])[0]
        proj["materials"] = {
            "air": (
                {
                    "id": air.get("id"),
                    "name": air.get("name"),
                    "assigned_volumes": air.get("assigned_volumes"),
                    "materials_json": str(path),
                    "updated_at": doc["updated_at"],
                }
                if isinstance(air, dict)
                else None
            ),
            "materials_json": str(path),
            "count": len(doc.get("materials") or []),
        }
        proj["updated_at"] = doc["updated_at"]
        proj["increment"] = "W18"
        atomic_write(proj_path, proj)
    return doc


def set_bcs(project_dir: Path, body: dict[str, Any], *, sim_id: str = "") -> dict[str, Any]:
    from cfddesk.project.paths import assemble_study_bcs, find_study, persist_child_item

    raw = body if isinstance(body, dict) else {"boundary_conditions": body}
    sid = str(sim_id or (raw.get("simulation_id") if isinstance(raw, dict) else "") or "").strip()
    path = _study_dest(project_dir, "boundary_conditions.json", sid)
    _proj, mode, mirror = write_through_project(
        project_dir, "boundary_conditions", raw, sim_id=sid
    )
    src = (
        mirror
        if isinstance(mirror, dict) and (mirror.get("boundary_conditions") or [])
        else raw
    )
    doc = _scope_doc_to_study(stamp(src, sim_id=sid, increment="W19"), "boundary_conditions", sid)
    only = str(raw.get("only_id") or "").strip()
    study = find_study(project_dir, sid)
    if study:
        parent = Path(study["dir"]) / "boundary_conditions"
        for rec in doc.get("boundary_conditions") or []:
            if not isinstance(rec, dict) or rec.get("id") is None:
                continue
            if only and str(rec.get("id")) != only:
                continue
            persist_child_item(parent, "bc", {**rec, "simulation_id": sid})
        rows = assemble_study_bcs(project_dir, sid)
        doc["boundary_conditions"] = rows
        atomic_write(path, {**doc, "boundary_conditions": rows, "simulation_id": sid})
        atomic_write(
            parent / "defaults.json",
            {
                "defaults": doc.get("defaults"),
                "defaults_by_simulation": doc.get("defaults_by_simulation") or {},
                "simulation_id": sid,
            },
        )
    proj_path = project_dir / "project.json"
    proj = read_json(proj_path)
    if proj and mode != "python":
        bcs = list(doc.get("boundary_conditions") or [])
        proj["boundary_conditions"] = {
            "count": len(bcs),
            "names": [b.get("name") for b in bcs if isinstance(b, dict)],
            "types": [b.get("bc_type") for b in bcs if isinstance(b, dict)],
            "boundary_conditions_json": str(path),
            "updated_at": doc["updated_at"],
        }
        proj["updated_at"] = doc["updated_at"]
        proj["increment"] = "W19"
        atomic_write(proj_path, proj)
    return doc


def set_mesh_settings(project_dir: Path, body: dict[str, Any], *, sim_id: str = "") -> dict[str, Any]:
    raw = body if isinstance(body, dict) else {"settings": body}
    sid = str(sim_id or (raw.get("simulation_id") if isinstance(raw, dict) else "") or "").strip()
    _proj, mode, mirror = write_through_project(project_dir, "mesh", raw, sim_id=sid)
    inc = str(body.get("increment") or "W20") if isinstance(body, dict) else "W20"
    doc = stamp(mirror, sim_id=sid, increment=inc)
    if isinstance(body, dict):
        for k in _MESH_EXTRAS:
            if k in body and (k not in doc or k in ("live_mesh_result", "meshes")):
                doc[k] = body[k]
    doc = _scope_doc_to_study(slim_mesh_doc(doc) or doc, "mesh", sid)
    doc = persist_mesh_doc(project_dir, sid, doc)
    path = _study_dest(project_dir, "mesh.json", sid)
    proj_path = project_dir / "project.json"
    proj = read_json(proj_path)
    if proj and mode != "python":
        settings = checked if isinstance((checked := doc.get("settings")), dict) else {}
        proj["mesh"] = {
            "id": doc.get("id") or doc.get("active_id"),
            "name": doc.get("name"),
            "algorithm": settings.get("algorithm"),
            "sizing": settings.get("sizing"),
            "fineness": settings.get("fineness"),
            "bank_exact": doc.get("bank_exact"),
            "mesh_json": str(path),
            "active_id": doc.get("active_id"),
            "mesh_count": len(doc.get("meshes") or []) or 1,
            "updated_at": doc["updated_at"],
        }
        proj["updated_at"] = doc["updated_at"]
        proj["increment"] = inc
        atomic_write(proj_path, proj)
    return doc


def set_refinements(project_dir: Path, body: dict[str, Any], *, sim_id: str = "") -> dict[str, Any]:
    from cfddesk.project.paths import walk_meshes

    raw = body if isinstance(body, dict) else {"refinements": body}
    sid = str(sim_id or (raw.get("simulation_id") if isinstance(raw, dict) else "") or "").strip()
    _proj, mode, mirror = write_through_project(
        project_dir, "mesh_refinements", raw, sim_id=sid
    )
    doc = _scope_doc_to_study(stamp(mirror, sim_id=sid, increment="W26"), "mesh_refinements", sid)
    refs = [r for r in (doc.get("refinements") or []) if isinstance(r, dict)]
    meshes = walk_meshes(project_dir, sid)
    by_mesh: dict[str, list] = {}
    for r in refs:
        mid = str(r.get("mesh_id") or "")
        if not mid:
            continue
        r = {**r, "mesh_id": mid, "simulation_id": sid}
        by_mesh.setdefault(mid, []).append(r)
    written = []
    path = None
    for m in meshes:
        mid = str(m.get("id") or "")
        rows = by_mesh.get(mid, [])
        dest = Path(m["dir"]) / "refinements.json"
        from cfddesk.project.paths import persist_child_item

        only = str(raw.get("only_id") or "").strip()
        for rec in rows:
            if only and str(rec.get("id") or "") != only:
                continue
            persist_child_item(Path(m["dir"]) / "refinements", "refinement", rec)
        path = dest
        written.extend(rows)
    doc["refinements"] = written
    proj_path = project_dir / "project.json"
    proj = read_json(proj_path)
    if proj and mode != "python":
        refs = list(doc.get("refinements") or [])
        proj["mesh_refinements"] = {
            "count": len(refs),
            "names": [r.get("name") for r in refs if isinstance(r, dict)],
            "types": [r.get("type") for r in refs if isinstance(r, dict)],
            "mesh_refinements_json": str(path) if path else None,
            "updated_at": doc["updated_at"],
        }
        proj["updated_at"] = doc["updated_at"]
        proj["increment"] = "W26"
        atomic_write(proj_path, proj)
    return doc


def set_result_controls(project_dir: Path, body: dict[str, Any], *, sim_id: str = "") -> dict[str, Any]:
    only_aa = isinstance(body, dict) and body.get("_file") == "area_average.json"
    if only_aa and isinstance(body, dict):
        body = {k: v for k, v in body.items() if k != "_file"}
    raw = body if isinstance(body, dict) else {"controls": body}
    sid = str(sim_id or (raw.get("simulation_id") if isinstance(raw, dict) else "") or "").strip()
    _proj, mode, mirror = write_through_project(project_dir, "result_controls", raw, sim_id=sid)
    doc = _scope_doc_to_study(
        stamp(mirror if isinstance(mirror, dict) else raw, sim_id=sid, increment="W22"),
        "result_controls",
        sid,
    )
    rc_path = _study_dest(project_dir, "result_controls.json", sid)
    aa_path = rc_path
    from cfddesk.project.paths import find_study, persist_child_item

    study = find_study(project_dir, sid)
    if study:
        parent = Path(study["dir"]) / "result_controls"
        for rec in doc.get("result_controls") or []:
            if isinstance(rec, dict) and rec.get("id") is not None:
                persist_child_item(parent, "rc", {**rec, "simulation_id": sid})
    proj_path = project_dir / "project.json"
    proj = read_json(proj_path)
    if proj:
        rcs = list(doc.get("result_controls") or [])
        aa = doc.get("area_average_1")
        aa_sum = None
        if isinstance(aa, dict):
            aa_sum = {
                "name": aa.get("name"),
                "kind": aa.get("kind"),
                "category": aa.get("category"),
                "write_control": aa.get("write_control"),
                "faces": aa.get("faces"),
                "both_faces": True,
                "results_available": False,
            }
        proj["result_controls"] = {
            "count": len(rcs),
            "names": [r.get("name") for r in rcs if isinstance(r, dict)],
            "area_average_1": aa_sum,
            "result_controls_json": str(rc_path),
            "area_average_json": str(aa_path),
            "updated_at": doc["updated_at"],
        }
        proj["updated_at"] = doc["updated_at"]
        proj["increment"] = "W22"
        atomic_write(proj_path, proj)
    return doc


def set_sim_control(project_dir: Path, body: dict[str, Any], *, sim_id: str = "") -> dict[str, Any]:
    raw = body if isinstance(body, dict) else {}
    sid = str(sim_id or (raw.get("simulation_id") if isinstance(raw, dict) else "") or "").strip()
    _proj, _mode, mirror = write_through_project(
        project_dir, "simulation_control", raw, sim_id=sid
    )
    doc = stamp(mirror, sim_id=sid, increment="W17")
    atomic_write(_study_dest(project_dir, "simulation_control.json", sid), doc)
    return doc


def _run_sidecar_path(runs_dir: Path, run_id: str) -> Path:
    rid = str(run_id or "").strip()
    if rid.startswith("run-"):
        return runs_dir / f"{rid}.json"
    return runs_dir / f"run-{rid}.json"


def stamp_run_on_project(project_dir: Path, body: dict[str, Any]) -> None:
    proj_path = project_dir / "project.json"
    proj = read_json(proj_path)
    if not proj:
        return
    run_id = str(body.get("id") or body.get("run_id") or "")
    proj["run_1"] = {
        "run_id": run_id,
        "name": body.get("name"),
        "status": body.get("status"),
        "pid": body.get("pid"),
        "case_dir": body.get("case_dir"),
        "log_path": body.get("log_path"),
        "increment": body.get("increment") or "W27",
        "updated_at": body.get("finished_at")
        or body.get("started_at")
        or body.get("updated_at")
        or now_iso(),
    }
    proj["updated_at"] = now_iso()
    proj["increment"] = "W27"
    atomic_write(proj_path, proj)


def run_upsert(
    project_dir: Path,
    body: dict[str, Any],
    *,
    sim_id: str = "",
    run_id: str = "",
    stamp_project: bool = False,
) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("body must be object")
    from cfddesk.project.paths import create_run_folder, ensure_study_folder, find_run

    sid = str(sim_id or body.get("simulation_id") or "").strip()
    if not sid:
        cat = read_json(project_dir / "simulations.json")
        sims = cat.get("simulations") or []
        sid = str((sims[0] or {}).get("id") or "") if sims else ""
    if not sid:
        sid = "sim-default"
    ensure_study_folder(project_dir, sid)
    rid = str(body.get("id") or body.get("run_id") or run_id or "")
    if not rid:
        raise ValueError("run id required")
    body = stamp(body, sim_id=sid, increment="W27")
    body["id"] = rid
    body["run_id"] = rid
    folder = find_run(project_dir, rid, sid)
    if not folder:
        folder = create_run_folder(project_dir, sid, body)
    folder_dir = Path(folder["dir"])
    existing = read_json(folder_dir / "run.json")
    incoming_status = str(body.get("status") or "")
    fresh_start = incoming_status in {"running", "starting"} and body.get("has_results") is False
    if existing:
        merged = {**existing, **body}
        if incoming_status in {"running", "starting"}:
            merged["stop_requested"] = body.get("stop_requested") is True
            if fresh_start:
                merged["finished_at"] = None
                if merged.get("stage") in {None, "", "stopping", "copy", "reconstruct"}:
                    merged["stage"] = body.get("stage") or "starting"
        if not merged.get("mesh_id") and existing.get("mesh_id"):
            merged["mesh_id"] = existing.get("mesh_id")
            merged["mesh_name"] = merged.get("mesh_name") or existing.get("mesh_name")
        if not fresh_start:
            if existing.get("has_results"):
                merged["has_results"] = True
            exist_n = existing.get("n_saved_times") or 0
            next_n = merged.get("n_saved_times") or 0
            try:
                if int(exist_n) > int(next_n or 0):
                    merged["n_saved_times"] = exist_n
                    if existing.get("last_saved_iteration") not in (None, 0, ""):
                        merged["last_saved_iteration"] = existing.get("last_saved_iteration")
            except (TypeError, ValueError):
                pass
        keep_status = str(existing.get("status") or "")
        if keep_status in {"running", "starting", "done", "failed", "stopped"} and incoming_status in {
            "",
            "draft",
            "idle",
        }:
            merged["status"] = keep_status
        body = merged
    if not fresh_start:
        stage = str(body.get("stage") or "")
        evidence = 0.0
        for key in ("n_saved_times", "last_saved_iteration", "sim_time"):
            try:
                evidence = max(evidence, float(body.get(key) or 0))
            except (TypeError, ValueError):
                pass
        if evidence > 0 and stage in {"", "starting", "decompose"}:
            body["stage"] = "solve"
    body["case_dir"] = str(folder_dir / "case")
    atomic_write(
        folder_dir / "id.json",
        {
            "id": rid,
            "name": body.get("name"),
            "simulation_id": sid,
            "mesh_id": body.get("mesh_id") or (existing.get("mesh_id") if existing else None),
            "kind": "run",
        },
    )
    atomic_write(folder_dir / "run.json", body)
    if stamp_project:
        stamp_run_on_project(project_dir, body)
    return body


def run_delete(project_dir: Path, run_id: str, *, sim_id: str = "") -> dict[str, Any]:
    import shutil

    from cfddesk.project.paths import find_run

    folder = find_run(project_dir, run_id, sim_id or None)
    if folder and folder.get("dir"):
        shutil.rmtree(folder["dir"], ignore_errors=True)
    return {"ok": True, "deleted": run_id}


def mesh_result(project_dir: Path, body: dict[str, Any], *, sim_id: str = "") -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("body must be object")
    from cfddesk.project.paths import find_mesh

    sid = str(sim_id or body.get("simulation_id") or "").strip()
    mesh_id = body.get("mesh_id")
    found = find_mesh(project_dir, mesh_id, sid or None)
    if not found:
        raise ValueError("mesh folder missing")
    path = Path(found["dir"]) / "mesh.json"
    existing = read_json(path)
    now = now_iso()
    live = slim_live_mesh_result(body.get("live_mesh_result") or body)
    if isinstance(live, dict) and live.get("status") == "done":
        case_dir = str(Path(found["dir"]) / "case")
        live = {**live, "case_dir": case_dir, "mesh_path": str(Path(case_dir) / "constant" / "polyMesh")}
    existing["live_mesh_result"] = live
    existing["generated"] = live.get("status") == "done" if isinstance(live, dict) else existing.get("generated")
    existing["updated_at"] = now
    existing["persistence"] = "filesystem"
    existing["increment"] = body.get("increment") or "W21"
    existing["simulation_id"] = sid or existing.get("simulation_id")
    existing["case_dir"] = str(Path(found["dir"]) / "case")
    existing = slim_mesh_doc(existing) or existing
    atomic_write(path, existing)
    return assemble_mesh_doc(project_dir, sid or str(existing.get("simulation_id") or ""), mesh_id)


def write_json(project_dir: Path, rel: str, body: dict[str, Any], *, sim_id: str = "") -> dict[str, Any]:
    rel = str(rel or "").replace("\\", "/").lstrip("/")
    if rel not in ALLOWED_WRITE_JSON_RELS:
        raise ValueError(f"rel not allowlisted: {rel}")
    if not isinstance(body, dict):
        raise ValueError("body must be object")
    kind = _WRITE_JSON_KIND[rel]
    raw = dict(body)
    if rel == "area_average.json":
        raw = {k: v for k, v in raw.items() if k != "_file"}
    raw.pop("_drop_ids", None)
    raw.pop("_drop_simulation_ids", None)
    sid = str(sim_id or raw.get("simulation_id") or "")
    raw.pop("_fast_merge", None)
    inc = str(body.get("increment") or _WRITE_JSON_INCREMENT.get(rel, "W17"))
    doc = stamp(raw, sim_id=sid, increment=inc)
    if kind == "mesh":
        doc = slim_mesh_doc(doc) or doc
        return persist_mesh_doc(project_dir, sid, _scope_doc_to_study(doc, kind, sid))
    if kind == "materials":
        doc = strip_material_notes(doc) or doc
    if kind == "mesh_refinements":
        return set_refinements(project_dir, doc, sim_id=sid)
    if kind in ("runs", "catalog"):
        return save_catalog(project_dir, doc, sim_id=sid)
    doc = _scope_doc_to_study(doc, kind, sid)
    dest = _study_dest(project_dir, rel, sid)
    atomic_write(dest, doc)
    return doc


def write_project(project_dir: Path, body: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("body must be object")
    path = project_dir / "project.json"
    if not body.get("id"):
        body = {**body, "id": project_dir.name}
    body = dict(body)
    body["updated_at"] = body.get("updated_at") or now_iso()
    body["persistence"] = "filesystem"
    atomic_write(path, body)
    return body


def save_catalog(project_dir: Path, body: dict[str, Any], *, sim_id: str = "") -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("body must be object")
    from cfddesk.project.paths import find_study, walk_runs

    sid = str(sim_id or body.get("simulation_id") or "").strip()
    study = find_study(project_dir, sid) if sid else None
    only = str(body.get("only_run_id") or "").strip()
    persist_runs = bool(body.get("persist_runs"))
    if persist_runs or only:
        for rec in list(body.get("runs") or []):
            if not isinstance(rec, dict) or not rec.get("id"):
                continue
            if only and str(rec.get("id")) != only:
                continue
            run_upsert(project_dir, rec, sim_id=sid, run_id=str(rec.get("id")))
    assembled = walk_runs(project_dir, sid) if sid else []
    doc = stamp({"runs": assembled, "active_id": body.get("active_id")}, sim_id=sid, increment="W27")
    if study:
        atomic_write(
            Path(study["dir"]) / "simulation_runs" / "catalog.json",
            {"active_id": body.get("active_id"), "simulation_id": sid},
        )
    return doc


def write_simulation(project_dir: Path, body: dict[str, Any], *, sim_id: str = "") -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("body must be object")
    path = project_dir / "simulation.json"
    doc = dict(body)
    doc["simulation_json"] = str(path)
    if sim_id and not doc.get("id"):
        doc["id"] = sim_id
    doc["updated_at"] = doc.get("updated_at") or now_iso()
    doc["persistence"] = "filesystem"
    atomic_write(path, doc)
    return doc


def save_sim_catalog(project_dir: Path, body: dict[str, Any], *, sim_id: str = "") -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("body must be object")
    simulations = list(body.get("simulations") or [])
    active_id = body.get("active_id")
    if active_id and not any(
        str(s.get("id")) == str(active_id) for s in simulations if isinstance(s, dict)
    ):
        active_id = (
            simulations[0]["id"]
            if simulations and isinstance(simulations[0], dict)
            else None
        )
    if not active_id and simulations and isinstance(simulations[0], dict):
        active_id = simulations[0].get("id")
    doc = {
        "active_id": active_id,
        "simulations": simulations,
        "updated_at": body.get("updated_at") or now_iso(),
    }
    if sim_id:
        doc["simulation_id"] = sim_id
    atomic_write(project_dir / "simulations.json", doc)
    mirror = project_dir / "simulation.json"
    active = next(
        (
            s
            for s in simulations
            if isinstance(s, dict) and str(s.get("id")) == str(active_id)
        ),
        None,
    )
    if active:
        mirrored = dict(active)
        mirrored["simulation_json"] = str(mirror)
        atomic_write(mirror, mirrored)
    elif mirror.exists():
        try:
            mirror.unlink()
        except OSError:
            pass
    return doc
