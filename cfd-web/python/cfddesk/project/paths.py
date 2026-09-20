"""Tree-aligned project folders. Same layout as scripts/project-layout.js."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

LAYOUT_VERSION = 2
_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitize_folder_name(name: str, fallback: str = "item") -> str:
    s = _UNSAFE.sub("_", str(name or ""))
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")[:80]
    s = s.rstrip(". ")
    if not s or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", s, re.I):
        return fallback
    return s


def geometry_folder_name(filename_or_name: str) -> str:
    raw = str(filename_or_name or "Geometry")
    stem = re.sub(r"\.[^.\\/]+$", "", raw)
    return "Geometry_" + sanitize_folder_name(stem, "Geometry")


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _folders(dir_path: Path) -> list[Path]:
    if not dir_path.is_dir():
        return []
    return [p for p in dir_path.iterdir() if p.is_dir() and not p.name.startswith(".")]


def geometries_root(project_dir: Path) -> Path:
    return Path(project_dir) / "geometries"


def walk_geometries(project_dir: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for folder in _folders(geometries_root(Path(project_dir))):
        rec = _read_json(folder / "id.json")
        if not rec or not rec.get("id"):
            continue
        out.append({**rec, "folder": folder.name, "dir": folder})
    return out


def find_geometry(project_dir: Path, geom_id: str | None) -> dict[str, Any] | None:
    want = str(geom_id or "").strip()
    if not want:
        return None
    for g in walk_geometries(project_dir):
        if str(g.get("id")) == want:
            return g
    return None


def walk_studies(project_dir: Path, geom_id: str | None = None) -> list[dict[str, Any]]:
    geoms = [find_geometry(project_dir, geom_id)] if geom_id else walk_geometries(project_dir)
    out: list[dict[str, Any]] = []
    for g in geoms:
        if not g:
            continue
        sims_root = Path(g["dir"]) / "simulations"
        for folder in _folders(sims_root):
            rec = _read_json(folder / "id.json")
            if not rec or not rec.get("id"):
                continue
            out.append(
                {
                    **rec,
                    "folder": folder.name,
                    "dir": folder,
                    "geometry_id": rec.get("geometry_id") or g.get("id"),
                    "geometry_dir": g["dir"],
                }
            )

    def _sort_key(row: dict[str, Any]) -> tuple[int, float]:
        raw = row.get("sort_index")
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            return (1, 0.0)
        return (0, float(raw))

    out.sort(key=_sort_key)
    return out


def find_study(project_dir: Path, sim_id: str | None) -> dict[str, Any] | None:
    want = str(sim_id or "").strip()
    if not want:
        return None
    for s in walk_studies(project_dir):
        if str(s.get("id")) == want:
            return s
    return None


def bind_mesh_case_paths(rec: dict[str, Any], folder: Path) -> dict[str, Any]:
    """Pin case_dir / mesh_path to this mesh folder. Folder renames leave stale paths in mesh.json."""
    case_dir = str(folder / "case")
    rec["case_dir"] = case_dir
    live = rec.get("live_mesh_result")
    if isinstance(live, dict) and live.get("status") == "done":
        poly = str(Path(case_dir) / "constant" / "polyMesh")
        next_live = {**live, "case_dir": case_dir, "mesh_path": poly}
        fp = next_live.get("fingerprint_after")
        if isinstance(fp, dict):
            next_live["fingerprint_after"] = {
                **fp,
                "points_path": str(Path(poly) / "points"),
                "owner_path": str(Path(poly) / "owner"),
            }
        rec["live_mesh_result"] = next_live
    return rec


def bind_run_case_paths(rec: dict[str, Any], folder: Path) -> dict[str, Any]:
    rec["case_dir"] = str(folder / "case")
    return rec


def walk_meshes(project_dir: Path, sim_id: str) -> list[dict[str, Any]]:
    study = find_study(project_dir, sim_id)
    if not study:
        return []
    out: list[dict[str, Any]] = []
    for folder in _folders(Path(study["dir"]) / "meshes"):
        ident = _read_json(folder / "id.json") or {}
        mesh = _read_json(folder / "mesh.json") or {}
        if not ident and not mesh:
            continue
        rec = {**mesh, **ident, "folder": folder.name, "dir": folder}
        rec["id"] = rec.get("id") or ident.get("id")
        rec["simulation_id"] = rec.get("simulation_id") or study.get("id")
        rec["geometry_id"] = rec.get("geometry_id") or study.get("geometry_id")
        bind_mesh_case_paths(rec, folder)
        out.append(rec)
    return out


def walk_all_meshes(project_dir: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for s in walk_studies(project_dir):
        out.extend(walk_meshes(project_dir, str(s["id"])))
    return out


def find_mesh(project_dir: Path, mesh_id: str | None, sim_id: str | None = None) -> dict[str, Any] | None:
    want = str(mesh_id or "").strip()
    if not want:
        return None
    if sim_id:
        for m in walk_meshes(project_dir, sim_id):
            if str(m.get("id")) == want:
                return m
        return None
    for s in walk_studies(project_dir):
        for m in walk_meshes(project_dir, str(s["id"])):
            if str(m.get("id")) == want:
                return m
    return None


def walk_runs(project_dir: Path, sim_id: str) -> list[dict[str, Any]]:
    study = find_study(project_dir, sim_id)
    if not study:
        return []
    out: list[dict[str, Any]] = []
    for folder in _folders(Path(study["dir"]) / "simulation_runs"):
        ident = _read_json(folder / "id.json") or {}
        run = _read_json(folder / "run.json") or {}
        if not ident and not run:
            continue
        rec = {**run, **ident, "folder": folder.name, "dir": folder}
        rec["id"] = rec.get("id") or rec.get("run_id") or ident.get("id")
        rec["run_id"] = rec.get("run_id") or rec.get("id")
        rec["simulation_id"] = rec.get("simulation_id") or study.get("id")
        folder_rcs = []
        have = set()
        for row in walk_child_items(folder / "result_controls", "result_control.json"):
            item = {k: v for k, v in row.items() if k not in ("dir", "folder", "kind")}
            if item.get("id") is not None:
                have.add(str(item["id"]))
                folder_rcs.append(item)
        extra = [
            r
            for r in (rec.get("result_controls") or [])
            if isinstance(r, dict) and r.get("id") is not None and str(r["id"]) not in have
        ]
        rec["result_controls"] = folder_rcs + extra
        bind_run_case_paths(rec, folder)
        out.append(rec)
    return out


def find_run(project_dir: Path, run_id: str | None, sim_id: str | None = None) -> dict[str, Any] | None:
    want = str(run_id or "").strip()
    if not want:
        return None
    pools = (
        [walk_runs(project_dir, sim_id)]
        if sim_id
        else [walk_runs(project_dir, str(s["id"])) for s in walk_studies(project_dir)]
    )
    for rows in pools:
        for r in rows:
            if str(r.get("id")) == want or str(r.get("run_id")) == want:
                return r
    return None


def study_file(study_dir: Path, name: str) -> Path:
    return Path(study_dir) / name


def _write_json(path: Path, doc: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _unique_child(parent: Path, wanted: str) -> Path:
    parent.mkdir(parents=True, exist_ok=True)
    name = wanted
    n = 2
    while (parent / name).exists():
        name = f"{wanted}_{n}"
        n += 1
    return parent / name


def create_geometry_folder(project_dir: Path, rec: dict[str, Any]) -> dict[str, Any]:
    root = geometries_root(project_dir)
    root.mkdir(parents=True, exist_ok=True)
    wanted = geometry_folder_name(str(rec.get("original_filename") or rec.get("name") or rec.get("id") or "Geometry"))
    dest = _unique_child(root, wanted)
    dest.mkdir(parents=True, exist_ok=True)
    ident = {
        "id": rec["id"],
        "name": rec.get("name") or dest.name,
        "original_filename": rec.get("original_filename"),
        "kind": "geometry",
    }
    _write_json(dest / "id.json", ident)
    (dest / "simulations").mkdir(parents=True, exist_ok=True)
    return {**rec, "folder": dest.name, "dir": dest, "name": ident["name"]}


def create_study_folder(project_dir: Path, geom_id: str, sim: dict[str, Any]) -> dict[str, Any]:
    geom = find_geometry(project_dir, geom_id)
    if not geom:
        raise ValueError(f"geometry folder missing for {geom_id}")
    sims_root = Path(geom["dir"]) / "simulations"
    wanted = sanitize_folder_name(str(sim.get("name") or "Incompressible_Steady-state"), "Study")
    dest = _unique_child(sims_root, wanted)
    dest.mkdir(parents=True, exist_ok=True)
    ident = {
        "id": sim["id"],
        "name": sim.get("name"),
        "geometry_id": geom_id,
        "kind": "simulation",
    }
    _write_json(dest / "id.json", ident)
    (dest / "meshes").mkdir(parents=True, exist_ok=True)
    (dest / "simulation_runs").mkdir(parents=True, exist_ok=True)
    (dest / "materials").mkdir(parents=True, exist_ok=True)
    (dest / "boundary_conditions").mkdir(parents=True, exist_ok=True)
    (dest / "result_controls").mkdir(parents=True, exist_ok=True)
    return {**sim, "folder": dest.name, "dir": dest, "geometry_dir": geom["dir"], "geometry_id": geom_id}


def create_mesh_folder(project_dir: Path, sim_id: str, mesh: dict[str, Any]) -> dict[str, Any]:
    study = find_study(project_dir, sim_id)
    if not study:
        raise ValueError(f"study folder missing for {sim_id}")
    root = Path(study["dir"]) / "meshes"
    wanted = sanitize_folder_name(str(mesh.get("name") or "Mesh_1"), "Mesh_1")
    dest = _unique_child(root, wanted)
    dest.mkdir(parents=True, exist_ok=True)
    ident = {
        "id": mesh["id"],
        "name": mesh.get("name") or dest.name,
        "simulation_id": sim_id,
        "kind": "mesh",
    }
    _write_json(dest / "id.json", ident)
    (dest / "refinements").mkdir(parents=True, exist_ok=True)
    return {**mesh, "folder": dest.name, "dir": dest, "case_dir": str(dest / "case")}


def create_run_folder(project_dir: Path, sim_id: str, run: dict[str, Any]) -> dict[str, Any]:
    study = find_study(project_dir, sim_id)
    if not study:
        raise ValueError(f"study folder missing for {sim_id}")
    root = Path(study["dir"]) / "simulation_runs"
    wanted = sanitize_folder_name(str(run.get("name") or "Run_1"), "Run_1")
    dest = _unique_child(root, wanted)
    dest.mkdir(parents=True, exist_ok=True)
    ident = {
        "id": run.get("id") or run.get("run_id"),
        "name": run.get("name") or dest.name,
        "simulation_id": sim_id,
        "mesh_id": run.get("mesh_id"),
        "kind": "run",
    }
    _write_json(dest / "id.json", ident)
    (dest / "result_controls").mkdir(parents=True, exist_ok=True)
    return {**run, "folder": dest.name, "dir": dest, "case_dir": str(dest / "case")}


def ensure_study_folder(project_dir: Path, sim_id: str | None) -> dict[str, Any] | None:
    want = str(sim_id or "").strip()
    if not want:
        return None
    found = find_study(project_dir, want)
    if found:
        return found
    cat = _read_json(Path(project_dir) / "simulations.json") or {}
    sim = next(
        (s for s in (cat.get("simulations") or []) if isinstance(s, dict) and str(s.get("id")) == want),
        {"id": want, "name": want},
    )
    geoms = walk_geometries(project_dir)
    if not geoms:
        geom = create_geometry_folder(
            project_dir, {"id": "geom-default", "name": "Geometry", "original_filename": "Geometry"}
        )
        gid = str(geom["id"])
    else:
        gid = str(geoms[0]["id"])
    return create_study_folder(project_dir, gid, sim)


_ITEM_KIND = {
    "material": ("Material_", "material.json", "Material"),
    "bc": ("BC_", "bc.json", "BC"),
    "rc": ("RC_", "result_control.json", "RC"),
    "refinement": ("Ref_", "refinement.json", "Ref"),
}


def walk_child_items(parent: Path, json_name: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for folder in _folders(parent):
        rec = _read_json(folder / json_name)
        if not rec or rec.get("id") is None:
            continue
        ident = _read_json(folder / "id.json") or {}
        row = {**ident, **rec, "folder": folder.name, "dir": folder}
        row.pop("kind", None)
        out.append(row)
    return out


def _strip_item_meta(rec: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in rec.items() if k not in ("dir", "folder", "kind")}


def assemble_mesh_refinements(project_dir: Path | str, mesh_id: str | None) -> list[dict[str, Any]]:
    """Folder Ref_*/refinement.json first. Leftover refinements.json cannot hide them.

    Matches scripts/study-io.js readMeshRefinements. Generate used to read only
    refinements.json / mesh_refinements.json, so a saved Ref_* folder never
    reached the mesher.
    """
    root = Path(project_dir)
    found = find_mesh(root, mesh_id)
    folder_rows: list[dict[str, Any]] = []
    legacy: list[dict[str, Any]] = []
    if found:
        for row in walk_child_items(Path(found["dir"]) / "refinements", "refinement.json"):
            folder_rows.append(_strip_item_meta(row))
        doc = _read_json(Path(found["dir"]) / "refinements.json") or {}
        legacy = [r for r in (doc.get("refinements") or []) if isinstance(r, dict)]
        if not folder_rows and not legacy:
            sid = str(found.get("simulation_id") or "").strip()
            if sid:
                study_path = study_json_path(root, sid, "mesh_refinements.json")
                if study_path:
                    study = _read_json(study_path) or {}
                    legacy = [r for r in (study.get("refinements") or []) if isinstance(r, dict)]
    if not folder_rows and not legacy:
        doc = _read_json(root / "mesh_refinements.json") or {}
        legacy = [r for r in (doc.get("refinements") or []) if isinstance(r, dict)]
    have = {str(r.get("id")) for r in folder_rows if r.get("id") is not None}
    extra = [r for r in legacy if r.get("id") is None or str(r.get("id")) not in have]
    return folder_rows + extra


def assemble_study_bcs(project_dir: Path | str, sim_id: str | None) -> list[dict[str, Any]]:
    """Folder BCs first, leftover aggregate JSON only for ids not already on disk.

    Matches scripts/study-io.js assembleStudyCollection('bcs'). Generate and Start
    must both use this so an empty boundary_conditions.json cannot hide BC_* folders.
    """
    root = Path(project_dir)
    sid = str(sim_id or "").strip() or None
    study = find_study(root, sid) if sid else None
    folder_rows: list[dict[str, Any]] = []
    legacy: list[dict[str, Any]] = []
    if study:
        for row in walk_child_items(Path(study["dir"]) / "boundary_conditions", "bc.json"):
            folder_rows.append(_strip_item_meta(row))
        doc = _read_json(Path(study["dir"]) / "boundary_conditions.json") or {}
        legacy = [b for b in (doc.get("boundary_conditions") or []) if isinstance(b, dict)]
    else:
        doc = _read_json(root / "boundary_conditions.json") or {}
        legacy = [b for b in (doc.get("boundary_conditions") or []) if isinstance(b, dict)]
    have = {str(b.get("id")) for b in folder_rows if b.get("id") is not None}
    extra = [b for b in legacy if b.get("id") is None or str(b.get("id")) not in have]
    return folder_rows + extra


def assemble_study_bc_defaults(project_dir: Path | str, sim_id: str | None) -> dict[str, Any]:
    """Wall default for this study. Folder defaults.json wins, then this study's
    defaults_by_simulation row (a clone can leave another study's No-slip in the
    same file). Matches scripts/study-io.js assembleStudyCollection('bcs').
    """
    root = Path(project_dir)
    sid = str(sim_id or "").strip() or None
    study = find_study(root, sid) if sid else None
    doc: dict[str, Any] = {}
    if study:
        doc = _read_json(Path(study["dir"]) / "boundary_conditions" / "defaults.json") or {}
        if not doc:
            doc = _read_json(Path(study["dir"]) / "boundary_conditions.json") or {}
    else:
        doc = _read_json(root / "boundary_conditions.json") or {}
    if not isinstance(doc, dict):
        doc = {}
    defaults = doc.get("defaults") if isinstance(doc.get("defaults"), dict) else {}
    by_sim = doc.get("defaults_by_simulation") if isinstance(doc.get("defaults_by_simulation"), dict) else {}
    scoped = by_sim.get(sid) if sid and isinstance(by_sim.get(sid), dict) else None
    if scoped and scoped.get("wall_type"):
        return {"wall_type": scoped.get("wall_type")}
    if defaults.get("wall_type"):
        return {"wall_type": defaults.get("wall_type")}
    return {"wall_type": "No-slip"}


def persist_child_item(parent: Path, kind: str, rec: dict[str, Any]) -> dict[str, Any]:
    spec = _ITEM_KIND.get(kind)
    if not spec:
        raise ValueError(f"unknown item kind {kind}")
    prefix, json_name, fallback = spec
    if not rec or rec.get("id") is None:
        raise ValueError(f"{kind} id required")
    parent.mkdir(parents=True, exist_ok=True)
    found = None
    want = str(rec["id"])
    for folder in _folders(parent):
        data = _read_json(folder / json_name) or {}
        if str(data.get("id") or "") == want:
            found = folder
            break
    if found is None:
        wanted = prefix + sanitize_folder_name(str(rec.get("name") or rec["id"]), fallback)
        found = _unique_child(parent, wanted)
        found.mkdir(parents=True, exist_ok=True)
    bound = {k: v for k, v in rec.items() if k not in ("dir", "folder")}
    _write_json(
        found / "id.json",
        {
            "id": rec["id"],
            "name": rec.get("name") or found.name,
            "simulation_id": rec.get("simulation_id"),
            "mesh_id": rec.get("mesh_id"),
            "run_id": rec.get("run_id"),
            "kind": kind,
        },
    )
    _write_json(found / json_name, bound)
    return {**bound, "folder": found.name, "dir": found}


def remove_child_item(parent: Path, json_name: str, item_id: str) -> bool:
    import shutil

    want = str(item_id or "").strip()
    if not want:
        return False
    for folder in _folders(parent):
        data = _read_json(folder / json_name) or {}
        if str(data.get("id") or "") == want:
            shutil.rmtree(folder, ignore_errors=True)
            return True
    return False


def study_json_path(project_dir: Path, sim_id: str | None, rel: str) -> Path | None:
    study = find_study(project_dir, sim_id)
    if not study:
        return None
    name = str(rel or "").replace("\\", "/").split("/")[-1]
    if name == "area_average.json":
        name = "result_controls.json"
    return Path(study["dir"]) / name


def resolve_step_for_study(
    project_dir: Path,
    simulation_id: str | None = None,
    mesh_id: str | None = None,
) -> Path | None:
    """STEP for this study/mesh geometry — not the first folder under geometries/."""
    geom_id = None
    sid = str(simulation_id or "").strip() or None
    mid = str(mesh_id or "").strip() or None
    if sid:
        study = find_study(project_dir, sid)
        if study:
            geom_id = study.get("geometry_id")
    if not geom_id and mid:
        mesh = find_mesh(project_dir, mid, sid)
        if mesh:
            geom_id = mesh.get("geometry_id")
    return resolve_step(project_dir, geom_id)


def resolve_step(project_dir: Path, geom_id: str | None = None) -> Path | None:
    root = Path(project_dir)
    proj = _read_json(root / "project.json") or {}
    geom = checked if isinstance((checked := proj.get("geometry")), dict) else {}
    geoms = [find_geometry(root, geom_id)] if geom_id else walk_geometries(root)
    for g in geoms:
        if not g:
            continue
        step = Path(g["dir"]) / "source.step"
        if step.is_file():
            return step
        part = (proj.get("geometries") or []) if isinstance(proj, dict) else []
        for row in part:
            if isinstance(row, dict) and str(row.get("id")) == str(g.get("id")) and row.get("step_path"):
                p = Path(row["step_path"])
                if p.is_file():
                    return p
    listed = geom.get("step_path")
    if listed and Path(listed).is_file():
        return Path(listed)
    return None


def case_under_owner(case_path: str | Path | None, owner_dir: str | Path | None) -> bool:
    if not case_path or not owner_dir:
        return False
    a = str(case_path).replace("\\", "/").lower().rstrip("/")
    b = str(owner_dir).replace("\\", "/").lower().rstrip("/")
    return a == b or a.startswith(b + "/")
