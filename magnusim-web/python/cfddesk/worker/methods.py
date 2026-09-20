"""RPC methods registered on import."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from cfddesk.project import web_writes as ww
from cfddesk.registry import get_hub, load_all, reset_for_tests
from cfddesk.registry.schema import validate as validate_schema
from cfddesk.worker.paths import (
    active_id,
    project_dir,
    projects_root,
    read_sibling,
    set_active_id,
    web_root,
)
from cfddesk.worker.rpc import RpcError, rpc
from cfddesk.wsl.config import local_json_path

# ---------------------------------------------------------------------------
# worker
# ---------------------------------------------------------------------------


@rpc("worker.ping")
def worker_ping() -> dict[str, Any]:
    return {"ok": True, "worker": "cfddesk.worker"}


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------


@rpc("registry.describe")
def registry_describe() -> dict[str, Any]:
    hub = load_all(web_root=web_root())
    out: dict[str, Any] = {}
    for kind in ("analysis", "solver", "mesher", "bc", "material", "monitor", "filter"):
        out[kind] = hub.registry(kind).describe()
    out["plugins"] = [
        {
            "key": getattr(m, "key", ""),
            "name": getattr(m, "name", ""),
            "version": getattr(m, "version", "0.0.0"),
            "ui": getattr(m, "ui", None),
            "provides": getattr(m, "provides", {}) or {},
        }
        for m in hub.manifests.values()
    ]
    out["missing"] = []
    return out


@rpc("registry.describe_kind")
def registry_describe_kind(kind: str) -> dict[str, Any]:
    dump = registry_describe()
    key = str(kind or "")
    if key not in dump:
        raise RpcError(-32602, f"unknown registry kind: {key}")
    return {"kind": key, "items": dump[key]}


@rpc("registry.describe_key")
def registry_describe_key(kind: str, key: str) -> dict[str, Any]:
    items = registry_describe_kind(kind)["items"]
    for row in items:
        if isinstance(row, dict) and str(row.get("key")) == str(key):
            return row
    raise RpcError(-32602, f"unknown {kind} key: {key}")


@rpc("registry.reload")
def registry_reload() -> dict[str, Any]:
    reset_for_tests()
    return registry_describe()


# ---------------------------------------------------------------------------
# project store
# ---------------------------------------------------------------------------


def _require_dir(project_id: str) -> Path:
    root = project_dir(project_id)
    if not (root / "project.json").is_file():
        raise RpcError(-32004, "project not found", {"project_id": project_id})
    return root


def _root(project_id: str = "", project_dir_s: str = "") -> Path:
    if project_dir_s:
        root = Path(project_dir_s)
        if not root.is_dir():
            raise RpcError(-32004, "project dir not found", {"project_dir": project_dir_s})
        return root
    if not str(project_id or "").strip():
        raise RpcError(-32602, "project_id or project_dir required")
    return _require_dir(project_id)


def _list_projects() -> list[dict[str, Any]]:
    root = projects_root()
    if not root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    skip = {"active.json", "folders.json"}
    for child in sorted(root.iterdir(), key=lambda p: p.name):
        if not child.is_dir() or child.name in skip:
            continue
        proj = ww.read_json(child / "project.json")
        if not proj:
            continue
        proj.setdefault("id", child.name)
        out.append(proj)
    return out


def _folders() -> list[str]:
    data = ww.read_json(projects_root() / "folders.json")
    raw = data.get("folders") if isinstance(data, dict) else None
    names = [str(n).strip() for n in (raw or []) if str(n).strip()]
    for p in _list_projects():
        folder = str(p.get("folder") or "").strip()
        if folder:
            names.append(folder)
    return sorted(set(names))


def _reconcile_and_save(root: Path) -> bool:
    from cfddesk.project.web_mirrors import (
        apply_web_sibling_to_project,
        is_python_project_doc,
        load_or_synthesize_project,
        regenerate_web_mirrors,
        to_web_runs_catalog,
    )

    proj_path = root / "project.json"
    existing = ww.read_json(proj_path)
    if not existing:
        return False
    project, mode = load_or_synthesize_project(root)
    # Synthesize stamps a new project.json, so sibling mtimes can look stale.
    # Always bind live mesh/run ids before adopting orphan folders.
    mesh_doc = ww.read_json(root / "mesh.json")
    if mesh_doc:
        project = apply_web_sibling_to_project(project, "mesh", mesh_doc)
    catalog = ww.read_json(root / "runs" / "catalog.json")
    if catalog:
        project = apply_web_sibling_to_project(project, "runs", catalog)
    reconciled = project.reconcile_runs_from_disk(root)
    changed = reconciled is not project
    if changed and (is_python_project_doc(existing) or mode == "python"):
        try:
            reconciled.save(proj_path)
        except Exception:
            changed = True
    if changed:
        try:
            regenerate_web_mirrors(
                reconciled, root, project_id=root.name, kinds=["runs"]
            )
        except Exception:
            catalog = to_web_runs_catalog(reconciled)
            if isinstance(catalog, dict):
                ww.save_catalog(root, catalog)
    return changed


@rpc("project.hydrate")
def project_hydrate(id: str = "", project_id: str = "", simulation_id: str = "") -> dict[str, Any]:
    pid = str(id or project_id or "").strip()
    if not pid:
        raise RpcError(-32602, "project_id required")
    root = _require_dir(pid)
    _reconcile_and_save(root)
    proj = ww.read_json(root / "project.json")
    if not proj:
        raise RpcError(-32004, "project not found", {"project_id": pid})
    from cfddesk.project.paths import walk_studies

    studies = walk_studies(root)
    catalog = read_sibling(pid, "simulations.json") or {}
    sid = simulation_id or str(catalog.get("active_id") or "")
    if not sid and len(studies) == 1:
        sid = str(studies[0]["id"])

    def scoped(rel: str):
        return read_sibling(pid, rel, sid) or read_sibling(pid, rel)

    mesh = scoped("mesh.json")
    if mesh:
        slim = ww.slim_mesh_doc(mesh)
        if slim:
            mesh = slim
    materials = scoped("materials.json")
    if materials:
        materials = ww.strip_material_notes(materials)
    runs = scoped("runs/catalog.json")
    return {
        "ok": True,
        "project_id": pid,
        "project": proj,
        "simulation": read_sibling(pid, "simulations.json") or read_sibling(pid, "simulation.json"),
        "materials": materials,
        "bcs": scoped("boundary_conditions.json"),
        "mesh": mesh,
        "refinements": scoped("mesh_refinements.json"),
        "runs": runs,
        "result_controls": scoped("result_controls.json")
        or scoped("area_average.json"),
        "simulation_control": scoped("simulation_control.json"),
        "increment": "hydrate",
        "reconciled": True,
    }


@rpc("project.list")
def project_list() -> dict[str, Any]:
    raw = _list_projects()
    return {
        "ok": True,
        "projects": raw,
        "folders": _folders(),
        "active_project_id": active_id(),
        "projects_root": str(projects_root()),
        "increment": "W26",
    }


@rpc("project.get")
def project_get(id: str = "", project_id: str = "") -> dict[str, Any]:
    pid = str(id or project_id or active_id() or "").strip()
    if not pid:
        return {"ok": True, "active": False, "project": None, "projects_root": str(projects_root())}
    root = _require_dir(pid)
    proj = ww.read_json(root / "project.json")
    return {
        "ok": True,
        "active": active_id() == pid,
        "project": proj,
        "projects_root": str(projects_root()),
        "increment": "W16",
    }


@rpc("project.create")
def project_create(title: str = "", name: str = "", folder: str = "", **extra: Any) -> dict[str, Any]:
    import re
    import secrets
    from datetime import datetime, timezone

    label = str(title or name or extra.get("title") or "project")
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:40] or "project"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    pid = f"{slug}-{stamp}-{secrets.token_hex(3)}"
    root = projects_root() / pid
    root.mkdir(parents=True, exist_ok=True)
    (root / "geometry").mkdir(exist_ok=True)
    doc = {
        "id": pid,
        "title": label,
        "name": label,
        "folder": str(folder or extra.get("folder") or "") or None,
        "created_at": ww.now_iso(),
        "updated_at": ww.now_iso(),
        "persistence": "filesystem",
        "increment": "W16",
    }
    ww.write_project(root, doc)
    set_active_id(pid)
    return {"ok": True, "id": pid, "project": doc, "increment": "W16"}


@rpc("project.update")
def project_update(id: str = "", project_id: str = "", **patch: Any) -> dict[str, Any]:
    pid = str(id or project_id or "").strip()
    root = _require_dir(pid)
    proj = ww.read_json(root / "project.json")
    for k, v in patch.items():
        if k in ("id", "project_id"):
            continue
        proj[k] = v
    ww.write_project(root, proj)
    return {"ok": True, "project": proj}


@rpc("project.delete")
def project_delete(id: str = "", project_id: str = "") -> dict[str, Any]:
    import shutil

    pid = str(id or project_id or "").strip()
    root = _require_dir(pid)
    shutil.rmtree(root, ignore_errors=True)
    if active_id() == pid:
        set_active_id(None)
    return {"ok": True, "deleted": pid}


@rpc("project.move")
def project_move(id: str = "", project_id: str = "", folder: str = "") -> dict[str, Any]:
    return project_update(id=id or project_id, folder=folder)


@rpc("project.open")
def project_open(id: str = "", project_id: str = "") -> dict[str, Any]:
    pid = str(id or project_id or "").strip()
    _require_dir(pid)
    set_active_id(pid)
    return project_hydrate(id=pid)


@rpc("folders.list")
def folders_list() -> dict[str, Any]:
    return {"ok": True, "folders": _folders(), "increment": "W26"}


@rpc("folders.create")
def folders_create(name: str = "", folder: str = "", title: str = "") -> dict[str, Any]:
    label = str(name or folder or title or "").strip()
    if not label:
        raise RpcError(-32602, "folder name required")
    names = _folders()
    if label not in names:
        names.append(label)
    ww.atomic_write(
        projects_root() / "folders.json",
        {"folders": sorted(set(names)), "updated_at": ww.now_iso()},
    )
    return {"ok": True, "folders": _folders()}


# ---------------------------------------------------------------------------
# siblings
# ---------------------------------------------------------------------------


@rpc("sim.get")
def sim_get(id: str = "", project_id: str = "") -> Any:
    pid = str(id or project_id or active_id() or "")
    return read_sibling(pid, "simulations.json") or read_sibling(pid, "simulation.json")


@rpc("sim.set")
def sim_set(id: str = "", project_id: str = "", body: dict | None = None, **extra: Any) -> Any:
    pid = str(id or project_id or "")
    root = _require_dir(pid)
    doc = body if isinstance(body, dict) else extra
    return ww.write_simulation(root, doc, sim_id=str(doc.get("id") or extra.get("sim_id") or ""))


@rpc("sim.catalog.get")
def sim_catalog_get(id: str = "", project_id: str = "") -> Any:
    return sim_get(id=id, project_id=project_id)


@rpc("sim.catalog.set")
def sim_catalog_set(id: str = "", project_id: str = "", body: dict | None = None, **extra: Any) -> Any:
    pid = str(id or project_id or "")
    root = _require_dir(pid)
    doc = body if isinstance(body, dict) else extra
    return ww.save_sim_catalog(root, doc, sim_id=str(extra.get("sim_id") or ""))


@rpc("materials.get")
def materials_get(id: str = "", project_id: str = "") -> Any:
    pid = str(id or project_id or active_id() or "")
    return read_sibling(pid, "materials.json")


@rpc("materials.set")
def materials_set(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.set_materials(root, doc, sim_id=sim_id)


@rpc("bcs.get")
def bcs_get(id: str = "", project_id: str = "") -> Any:
    pid = str(id or project_id or active_id() or "")
    return read_sibling(pid, "boundary_conditions.json")


@rpc("bcs.set")
def bcs_set(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.set_bcs(root, doc, sim_id=sim_id)


@rpc("mesh.get")
def mesh_get(id: str = "", project_id: str = "") -> Any:
    pid = str(id or project_id or active_id() or "")
    return read_sibling(pid, "mesh.json")


@rpc("mesh.set")
def mesh_set(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.set_mesh_settings(root, doc, sim_id=sim_id)


@rpc("mesh.delete")
def mesh_delete(id: str = "", project_id: str = "") -> dict[str, Any]:
    pid = str(id or project_id or "")
    root = _require_dir(pid)
    path = root / "mesh.json"
    if path.is_file():
        path.unlink()
    return {"ok": True, "deleted": "mesh.json"}


@rpc("refinements.get")
def refinements_get(id: str = "", project_id: str = "") -> Any:
    pid = str(id or project_id or active_id() or "")
    return read_sibling(pid, "mesh_refinements.json")


@rpc("refinements.set")
def refinements_set(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.set_refinements(root, doc, sim_id=sim_id)


@rpc("result_controls.get")
def result_controls_get(id: str = "", project_id: str = "") -> Any:
    pid = str(id or project_id or active_id() or "")
    return read_sibling(pid, "result_controls.json") or read_sibling(pid, "area_average.json")


@rpc("result_controls.set")
def result_controls_set(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.set_result_controls(root, doc, sim_id=sim_id)


@rpc("sim_control.get")
def sim_control_get(id: str = "", project_id: str = "") -> Any:
    pid = str(id or project_id or active_id() or "")
    return read_sibling(pid, "simulation_control.json")


@rpc("sim_control.set")
def sim_control_set(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.set_sim_control(root, doc, sim_id=sim_id)


@rpc("runs.get")
def runs_get(id: str = "", project_id: str = "") -> Any:
    pid = str(id or project_id or active_id() or "")
    return read_sibling(pid, "runs/catalog.json")


@rpc("runs.catalog.set")
def runs_catalog_set(
    id: str = "",
    project_id: str = "",
    project_dir: str = "",
    body: dict | None = None,
    sim_id: str = "",
    **extra: Any,
) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.save_catalog(root, doc, sim_id=sim_id)


@rpc("runs.upsert")
def runs_upsert(
    id: str = "",
    project_id: str = "",
    project_dir: str = "",
    body: dict | None = None,
    run_id: str = "",
    sim_id: str = "",
    stamp_project: bool = False,
    **extra: Any,
) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.run_upsert(root, doc, sim_id=sim_id, run_id=run_id, stamp_project=stamp_project)


@rpc("runs.delete")
def runs_delete(id: str = "", project_id: str = "", project_dir: str = "", run_id: str = "", sim_id: str = "") -> Any:
    root = _root(id or project_id, project_dir)
    return ww.run_delete(root, run_id, sim_id=sim_id)


@rpc("mesh.result.persist")
def mesh_result_persist(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.mesh_result(root, doc, sim_id=sim_id)


@rpc("project.write_json")
def project_write_json(
    project_dir: str = "",
    rel: str = "",
    doc: dict | None = None,
    body: dict | None = None,
    sim_id: str = "",
    **extra: Any,
) -> Any:
    root = Path(project_dir)
    payload = doc if isinstance(doc, dict) else body if isinstance(body, dict) else extra
    return ww.write_json(root, rel, payload, sim_id=sim_id)


@rpc("project.write_project")
def project_write_project(project_dir: str = "", doc: dict | None = None, body: dict | None = None, **extra: Any) -> Any:
    root = Path(project_dir)
    payload = doc if isinstance(doc, dict) else body if isinstance(body, dict) else extra
    return ww.write_project(root, payload)


@rpc("project.write_simulation")
def project_write_simulation(
    project_dir: str = "",
    doc: dict | None = None,
    body: dict | None = None,
    sim_id: str = "",
    **extra: Any,
) -> Any:
    root = Path(project_dir)
    payload = doc if isinstance(doc, dict) else body if isinstance(body, dict) else extra
    return ww.write_simulation(root, payload, sim_id=sim_id)


@rpc("project.save_sim_catalog")
def project_save_sim_catalog(
    project_dir: str = "",
    doc: dict | None = None,
    body: dict | None = None,
    sim_id: str = "",
    **extra: Any,
) -> Any:
    root = Path(project_dir)
    payload = doc if isinstance(doc, dict) else body if isinstance(body, dict) else extra
    return ww.save_sim_catalog(root, payload, sim_id=sim_id)


# ---------------------------------------------------------------------------
# filters
# ---------------------------------------------------------------------------

_FILTER_ALIASES = {
    "particle_trace": "streamlines",
    "inspect": "inspect_point",
    "fields": "surface_field",
    "surface_field": "surface_field",
}


def _coerce_filter_value(kind: str, val: Any) -> Any:
    if kind in ("float", "int") and isinstance(val, str) and val.strip() != "":
        try:
            return int(val) if kind == "int" and "." not in val else float(val)
        except ValueError:
            return val
    if kind == "bool" and isinstance(val, str):
        lowered = val.strip().lower()
        if lowered in ("1", "true", "yes", "on"):
            return True
        if lowered in ("0", "false", "no", "off"):
            return False
    return val


@rpc("filter.validate")
def filter_validate(key: str, params: dict | None = None) -> dict[str, Any]:
    canon = _FILTER_ALIASES.get(str(key), str(key))
    load_all(web_root=web_root())
    hub = get_hub()
    try:
        spec = hub.registry("filter").get(canon)
    except Exception as exc:
        raise RpcError(-32602, f"unknown filter: {key}") from exc
    schema = getattr(spec, "params_schema", ()) or ()
    values = params if isinstance(params, dict) else {}
    known = {f.key: f for f in schema}
    subset: dict[str, Any] = {}
    for k, v in values.items():
        field = known.get(k)
        if field is None:
            continue
        subset[k] = _coerce_filter_value(field.kind, v)
    if schema:
        errs = validate_schema(subset, schema)
        # Query strings omit most fields; only fail on provided-value type errors.
        hard = [e for e in errs if not str(e).startswith("missing required field")]
        if hard:
            raise RpcError(-32602, "; ".join(hard), {"errors": hard})
    return {
        "ok": True,
        "key": spec.key,
        "tool": spec.tool,
        "cache_scope": spec.cache_scope,
        "output": spec.output,
        "params": values,
    }


# ---------------------------------------------------------------------------
# CAD
# ---------------------------------------------------------------------------


@rpc("cad.load")
def cad_load(step_path: str) -> dict[str, Any]:
    from cfddesk.cad.preview import count_sub, shape_bounds
    from cfddesk.worker.cad_cache import load_shape

    path = Path(step_path)
    if not path.is_file():
        raise RpcError(-32004, "STEP not found", {"step_path": step_path})
    shape = load_shape(path)
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID

    bounds, _box = shape_bounds(shape)
    return {
        "ok": True,
        "step_path": str(path),
        "n_solids": count_sub(shape, TopAbs_SOLID),
        "n_faces": count_sub(shape, TopAbs_FACE),
        "bounds": bounds,
        "cached": True,
    }


@rpc("cad.preview")
def cad_preview(step_path: str, edges: str, faces: str, meta: str | None = None) -> dict[str, Any]:
    from cfddesk.cad.preview import export_preview
    from cfddesk.worker.cad_cache import load_shape

    path = Path(step_path)
    if not path.is_file():
        raise RpcError(-32004, "STEP not found", {"step_path": step_path})
    shape = load_shape(path)
    result = export_preview(path, Path(edges), Path(faces), Path(meta) if meta else None, shape=shape)
    return {"ok": True, **result}


@rpc("cad.faces")
def cad_faces(step_path: str, meta: str | None = None) -> dict[str, Any]:
    from cfddesk.cad.preview import write_faces_into_meta
    from cfddesk.worker.cad_cache import load_shape

    path = Path(step_path)
    if not path.is_file():
        raise RpcError(-32004, "STEP not found")
    load_shape(path)
    meta_path = Path(meta) if meta else path.with_name("cad_preview.json")
    out = write_faces_into_meta(path, meta_path)
    return {"ok": True, "n_faces": len(out.get("faces") or []), "meta": out}


@rpc("cad.stl")
def cad_stl(step_path: str) -> dict[str, Any]:
    path = Path(step_path)
    if not path.is_file():
        raise RpcError(-32004, "STEP not found")
    from cfddesk.worker.cad_cache import load_shape

    load_shape(path)
    return {"ok": True, "step_path": str(path), "note": "STL is generated by convert_step_to_stl job/CLI"}


@rpc("cad.thumb")
def cad_thumb(step_path: str) -> dict[str, Any]:
    path = Path(step_path)
    if not path.is_file():
        raise RpcError(-32004, "STEP not found")
    from cfddesk.worker.cad_cache import load_shape

    load_shape(path)
    return {"ok": True, "step_path": str(path), "note": "thumb is generated by render_geometry_thumb CLI"}


# ---------------------------------------------------------------------------
# plugins
# ---------------------------------------------------------------------------


def _local_doc() -> dict[str, Any]:
    path = local_json_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_local(doc: dict[str, Any]) -> None:
    ww.atomic_write(local_json_path(), doc)


def _disabled() -> list[str]:
    data = _local_doc()
    plugins = data.get("plugins")
    if isinstance(plugins, dict):
        raw = plugins.get("disabled") or []
    else:
        raw = data.get("plugins.disabled") or []
    return [str(x) for x in raw] if isinstance(raw, list) else []


@rpc("plugins.list")
def plugins_list() -> dict[str, Any]:
    load_all(web_root=web_root())
    hub = get_hub()
    disabled = set(_disabled())
    items = []
    for m in hub.manifests.values():
        items.append(
            {
                "key": m.key,
                "name": m.name,
                "version": getattr(m, "version", "0.0.0"),
                "ui": getattr(m, "ui", None),
                "provides": getattr(m, "provides", {}) or {},
                "enabled": m.key not in disabled,
            }
        )
    # Folder plugins that are disabled never register; still list from disk.
    plugins_dir = web_root() / "plugins"
    if plugins_dir.is_dir():
        known = {i["key"] for i in items}
        for child in sorted(plugins_dir.iterdir()):
            if not child.is_dir() or child.name in known:
                continue
            manifest = child / "manifest.toml"
            if not manifest.is_file():
                continue
            items.append(
                {
                    "key": child.name,
                    "name": child.name,
                    "version": "0.0.0",
                    "ui": "ui",
                    "provides": {},
                    "enabled": child.name not in disabled,
                }
            )
    return {"ok": True, "plugins": items}


def _set_plugin_enabled(key: str, enabled: bool) -> dict[str, Any]:
    doc = _local_doc()
    plugins = doc.get("plugins")
    if not isinstance(plugins, dict):
        plugins = {}
    disabled = [str(x) for x in (plugins.get("disabled") or [])]
    key = str(key)
    if enabled:
        disabled = [d for d in disabled if d != key]
    elif key not in disabled:
        disabled.append(key)
    plugins["disabled"] = disabled
    doc["plugins"] = plugins
    _write_local(doc)
    registry_reload()
    return plugins_list()


@rpc("plugins.enable")
def plugins_enable(key: str) -> dict[str, Any]:
    return _set_plugin_enabled(key, True)


@rpc("plugins.disable")
def plugins_disable(key: str) -> dict[str, Any]:
    return _set_plugin_enabled(key, False)


# ---------------------------------------------------------------------------
# result filters (in-process; volume stays warm for particle trace)
# ---------------------------------------------------------------------------


def _pt_bool(val: Any, default: bool = True) -> bool:
    if val is None:
        return default
    if isinstance(val, str):
        return val.strip().lower() not in ("0", "false", "no", "off", "")
    return bool(val)


@rpc("filter.series_range")
def filter_series_range(case_dir: str = "", field: str = "magU") -> dict[str, Any]:
    case = str(case_dir or "").strip()
    if not case:
        raise RpcError(-32602, "case_dir required")
    from export_case_field import series_field_range

    try:
        return series_field_range(Path(case), str(field or "magU"))
    except Exception as exc:
        raise RpcError(-32004, str(exc), {"case_dir": case, "field": str(field or "magU")}) from exc


@rpc("filter.case_field")
def filter_case_field(
    case_dir: str = "",
    time: str = "",
    field: str = "magU",
    out_dir: str = "",
    **_extra: Any,
) -> dict[str, Any]:
    case = str(case_dir or "").strip()
    dest = str(out_dir or "").strip()
    if not case:
        raise RpcError(-32602, "case_dir required")
    if not dest:
        raise RpcError(-32602, "out_dir required")
    from export_case_field import export_field

    from cfddesk.worker.volume_cache import get_prepared

    t = str(time or "0")
    name = "magU" if str(field or "magU") == "magU" else "p"
    try:
        entry = get_prepared(case, t, pin=False)
        export_field(
            Path(case),
            t,
            name,
            Path(dest),
            mesh=entry.get("mesh"),
            source_vtu=str(entry.get("source") or "worker-cache"),
        )
    except RpcError:
        raise
    except Exception as exc:
        raise RpcError(-32004, str(exc), {"case_dir": case, "time": t, "field": name}) from exc
    return {
        "ok": True,
        "case_dir": case,
        "time": t,
        "field": name,
        "out_dir": dest,
        "volume_cached": True,
    }


@rpc("filter.prefetch_fields")
def filter_prefetch_fields(
    case_dir: str = "",
    field: str = "magU",
    jobs: Any = None,
    **_extra: Any,
) -> dict[str, Any]:
    case = str(case_dir or "").strip()
    if not case:
        raise RpcError(-32602, "case_dir required")
    name = "magU" if str(field or "magU") == "magU" else "p"
    rows = jobs if isinstance(jobs, list) else []
    done: list[str] = []
    errors: list[dict[str, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        t = str(row.get("time") or "")
        dest = str(row.get("out_dir") or "")
        if not t or not dest:
            continue
        vtp = Path(dest) / f"{name}.vtp"
        if vtp.is_file():
            done.append(t)
            continue
        try:
            filter_case_field(case_dir=case, time=t, field=name, out_dir=dest)
            done.append(t)
        except Exception as exc:
            errors.append({"time": t, "error": str(exc)})
    return {"ok": True, "field": name, "done": done, "errors": errors, "n_done": len(done)}


@rpc("filter.release_volume")
def filter_release_volume(**_extra: Any) -> dict[str, Any]:
    from cfddesk.worker.volume_cache import cached_count, clear

    n = cached_count()
    clear()
    return {"ok": True, "released": True, "n_cleared": int(n)}


@rpc("filter.warmup_volume")
def filter_warmup_volume(case_dir: str = "", time: str = "") -> dict[str, Any]:
    case = str(case_dir or "").strip()
    if not case:
        raise RpcError(-32602, "case_dir required")
    from cfddesk.worker.volume_cache import get_prepared

    try:
        entry = get_prepared(case, str(time or "0"), pin=True)
    except Exception as exc:
        raise RpcError(-32004, str(exc), {"case_dir": case, "time": str(time or "0")}) from exc
    return {
        "ok": True,
        "case_dir": case,
        "time": str(time or "0"),
        "source": entry.get("source"),
        "n_cells": entry.get("n_cells"),
        "n_points": entry.get("n_points"),
        "cached": True,
        "has_point_u": bool(entry.get("has_point_u")),
        "has_cell_u": bool(entry.get("has_cell_u")),
    }


@rpc("filter.cut_plane")
def filter_cut_plane(
    case_dir: str = "",
    time: str = "",
    out_dir: str = "",
    ox: Any = 0,
    oy: Any = 0,
    oz: Any = 0,
    nx: Any = 0,
    ny: Any = 1,
    nz: Any = 0,
    field: str = "magU",
    **_extra: Any,
) -> dict[str, Any]:
    case = str(case_dir or "").strip()
    dest = str(out_dir or "").strip()
    if not case:
        raise RpcError(-32602, "case_dir required")
    if not dest:
        raise RpcError(-32602, "out_dir required")
    from export_cut_plane import export_cut_plane

    t = str(time or "0")
    name = "p" if str(field or "magU") == "p" else "magU"
    mesh = None
    source = None
    try:
        from cfddesk.worker.volume_cache import get_prepared

        entry = get_prepared(case, t)
        mesh = entry.get("slice") or entry.get("grid") or entry.get("mesh")
        source = str(entry.get("source") or "worker-cache")
    except Exception:
        mesh = None
        source = None
    try:
        export_cut_plane(
            Path(case),
            t,
            Path(dest),
            ox=float(ox or 0),
            oy=float(oy or 0),
            oz=float(oz or 0),
            nx=float(nx or 0),
            ny=float(ny if ny is not None else 1),
            nz=float(nz or 0),
            field=name,
            mesh=mesh,
            source=source,
        )
    except RpcError:
        raise
    except Exception as exc:
        raise RpcError(-32004, str(exc), {"case_dir": case, "time": t, "field": name}) from exc
    return {
        "ok": True,
        "case_dir": case,
        "time": t,
        "field": name,
        "out_dir": dest,
        "volume_cached": mesh is not None,
    }


@rpc("filter.particle_trace")
def filter_particle_trace(
    case_dir: str = "",
    time: str = "",
    out_dir: str = "",
    seeds_h: Any = 10,
    seeds_v: Any = 10,
    spacing: Any = 0.015,
    size: Any = 0.0037,
    both: Any = True,
    pick: str = "",
    representation: str = "Cylinders",
    max_steps: Any = 50000,
    seed_mode: str = "grid",
    faces: Any = None,
    quantity_mode: str = "count",
    n_seeds: Any = 40,
    density: Any = 10000,
    region: str = "",
    **_extra: Any,
) -> dict[str, Any]:
    case = str(case_dir or "").strip()
    dest = str(out_dir or "").strip()
    if not case:
        raise RpcError(-32602, "case_dir required")
    if not dest:
        raise RpcError(-32602, "out_dir required")
    from export_particle_trace import export_particle_trace, parse_faces, parse_pick, parse_region

    from cfddesk.worker.volume_cache import get_prepared

    try:
        entry = get_prepared(case, str(time or "0"))
        export_particle_trace(
            Path(case),
            str(time or "0"),
            Path(dest),
            seeds_h=int(seeds_h or 10),
            seeds_v=int(seeds_v or 10),
            spacing=float(spacing or 0.015),
            size=float(size or 0.0037),
            both_directions=_pt_bool(both, True),
            pick_position=parse_pick(pick),
            representation=str(representation or "Cylinders"),
            max_steps=int(max_steps or 50000),
            seed_mode=str(seed_mode or "grid"),
            faces=faces if isinstance(faces, list) else parse_faces(faces),
            quantity_mode=str(quantity_mode or "count"),
            n_seeds=int(n_seeds or 0),
            density=float(density or 10000),
            region=parse_region(region),
            prepared_grid=entry["grid"],
            volume_source=str(entry.get("source") or "worker-cache"),
        )
    except RpcError:
        raise
    except Exception as exc:
        raise RpcError(-32004, str(exc), {"case_dir": case, "time": str(time or "0")}) from exc
    return {
        "ok": True,
        "case_dir": case,
        "time": str(time or "0"),
        "out_dir": dest,
        "volume_cached": True,
    }
