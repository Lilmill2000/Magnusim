"""RPC methods registered on import."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from cfddesk.project import web_writes as ww
from cfddesk.registry import get_hub, load_all, reset_for_tests
from cfddesk.registry.base import RegistryError
from cfddesk.registry.discovery import plugin_catalog, start_action_row
from cfddesk.registry.schema import validate as validate_schema
from cfddesk.worker import (
    volume_cache as _volume_cache,  # noqa: F401 — puts python/tools on sys.path for the export_* imports
)
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
            "tier": getattr(m, "tier", "user"),
            "required": bool(getattr(m, "required", False)),
        }
        for m in hub.manifests.values()
    ]
    out["missing"] = []
    # Required bundled plugins that did not load: the page blocks creating and
    # running simulations and says why (never an empty picker).
    out["required_missing"] = [dict(row) for row in hub.required_failures]
    # The analysis a study gets when none is named (the required plugin's
    # [default_analysis]: steady, transient, aliases); None without it.
    from cfddesk.registry.discovery import default_analysis

    out["default_analysis"] = default_analysis()
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
    from cfddesk.project.scope import migrate_root_siblings

    migrate_root_siblings(root)
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
    from cfddesk.project.paths import drop_missing_studies, walk_studies

    # The index before the walk (see paths.drop_missing_studies): a row whose study
    # folder is gone is neither listed nor opened as the active study.
    index = read_sibling(pid, "simulations.json")
    studies = walk_studies(root)
    listed = drop_missing_studies(index, studies)
    catalog = listed or {}
    sid = simulation_id or str(catalog.get("active_id") or "")
    if not sid and len(studies) == 1:
        sid = str(studies[0]["id"])

    def scoped(rel: str):
        if not sid:
            return None
        return read_sibling(pid, rel, sid)

    mesh = scoped("mesh.json")
    if mesh:
        slim = ww.slim_mesh_doc(mesh)
        if slim:
            mesh = slim
    materials = scoped("materials.json")
    if materials:
        materials = ww.strip_material_notes(materials)
    runs = scoped("runs/catalog.json")
    bcs = scoped("boundary_conditions.json")
    if sid and any(str(s.get("id")) == sid for s in studies):
        from cfddesk.project.paths import assemble_study_bc_defaults, assemble_study_bcs

        # Folder rows plus legacy aggregate/root rows, with the ids the tree and GET /api/bcs use.
        rows = assemble_study_bcs(root, sid)
        if bcs is not None or rows:
            # The wall default as the solve reads it: the legacy aggregate can hold an old one.
            defaults = assemble_study_bc_defaults(root, sid)
            bcs = {
                **(bcs or {}),
                "boundary_conditions": rows,
                "defaults": defaults,
                "defaults_by_simulation": {sid: dict(defaults)},
                "simulation_id": sid,
            }
    return {
        "ok": True,
        "project_id": pid,
        "project": proj,
        "simulation": listed or read_sibling(pid, "simulation.json"),
        "materials": materials,
        "bcs": bcs,
        "mesh": mesh,
        "refinements": scoped("mesh_refinements.json"),
        "runs": runs,
        "result_controls": scoped("result_controls.json")
        or scoped("area_average.json"),
        "simulation_control": scoped("simulation_control.json"),
        "increment": "hydrate",
        "reconciled": True,
    }


@rpc("project.tree")
def project_tree(id: str = "", project_id: str = "") -> dict[str, Any]:
    pid = str(id or project_id or "").strip()
    if not pid:
        raise RpcError(-32602, "project_id required")
    root = _require_dir(pid)
    from cfddesk.project.scope import build_project_tree, migrate_root_siblings

    migrate_root_siblings(root)
    tree = build_project_tree(root, pid)
    extra: list[Any] = []
    try:
        from cfddesk.registry.hooks import get_hooks

        load_all(web_root=web_root())
        get_hooks().call("ui.tree.transform", nodes=extra, project_id=pid, tree=tree)
    except Exception:
        extra = []
    tree["geometries"] = _filter_tree_nodes(tree.get("geometries"), pid, "geometries")
    tree["plugin_nodes"] = [
        node
        for node in extra
        if isinstance(node, dict)
        and _node_project(node) == pid
        and str(node.get("label") or node.get("name") or "").strip()
    ]
    try:
        studies, kinds = _plugin_study_catalog(root, pid)
    except Exception:
        studies, kinds = [], []
    tree["plugin_studies"] = studies
    tree["plugin_study_kinds"] = kinds
    return tree


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


def _bound_project(id: str = "", project_id: str = "") -> str:
    pid = str(id or project_id or "").strip()
    if not pid:
        raise RpcError(-32602, "project_id required")
    return pid


def _bound_study(sim_id: str = "", simulation_id: str = "") -> str:
    sid = str(sim_id or simulation_id or "").strip()
    if not sid:
        raise RpcError(-32602, "simulation_id required")
    return sid


def _study_for_write(doc: dict | None, sim_id: str, extra: dict) -> str:
    nested = str(doc.get("simulation_id") or "") if isinstance(doc, dict) else ""
    return _bound_study(sim_id, nested or str(extra.get("simulation_id") or extra.get("sim_id") or ""))


def _node_project(node: dict[str, Any]) -> str:
    explicit = str(node.get("projectId") or node.get("project_id") or "").strip()
    if explicit:
        return explicit
    key = str(node.get("key") or node.get("scope") or "")
    for part in key.split("/"):
        if part.startswith("p:"):
            return part[2:]
    return ""


_TREE_CHILDREN = {
    "geometries": ("studies",),
    "studies": ("meshes", "runs", "bcs"),
    "meshes": ("refinements",),
    "runs": ("result_controls",),
}


def _filter_tree_nodes(nodes: Any, project_id: str, key: str) -> list[dict[str, Any]]:
    """Drop a node whose scope names another project, or names no project."""
    kept: list[dict[str, Any]] = []
    if not isinstance(nodes, list):
        return kept
    for node in nodes:
        if not isinstance(node, dict) or _node_project(node) != project_id:
            continue
        for child_key in _TREE_CHILDREN.get(key, ()):
            node[child_key] = _filter_tree_nodes(node.get(child_key), project_id, child_key)
        kept.append(node)
    return kept


@rpc("sim.get")
def sim_get(id: str = "", project_id: str = "") -> Any:
    from cfddesk.project.paths import drop_missing_studies, walk_studies

    pid = _bound_project(id, project_id)
    index = read_sibling(pid, "simulations.json")
    listed = drop_missing_studies(index, walk_studies(project_dir(pid)))
    return listed or read_sibling(pid, "simulation.json")


@rpc("sim.set")
def sim_set(id: str = "", project_id: str = "", body: dict | None = None, **extra: Any) -> Any:
    pid = _bound_project(id, project_id)
    root = _require_dir(pid)
    doc = body if isinstance(body, dict) else extra
    return ww.write_simulation(root, doc, sim_id=str(doc.get("id") or extra.get("sim_id") or ""))


@rpc("sim.catalog.get")
def sim_catalog_get(id: str = "", project_id: str = "") -> Any:
    return sim_get(id=id, project_id=project_id)


@rpc("sim.catalog.set")
def sim_catalog_set(id: str = "", project_id: str = "", body: dict | None = None, **extra: Any) -> Any:
    pid = _bound_project(id, project_id)
    root = _require_dir(pid)
    doc = body if isinstance(body, dict) else extra
    return ww.save_sim_catalog(root, doc, sim_id=str(extra.get("sim_id") or ""))


@rpc("materials.get")
def materials_get(
    id: str = "",
    project_id: str = "",
    sim_id: str = "",
    simulation_id: str = "",
) -> Any:
    pid = _bound_project(id, project_id)
    return read_sibling(pid, "materials.json", _bound_study(sim_id, simulation_id))


@rpc("materials.set")
def materials_set(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.set_materials(root, doc, sim_id=_study_for_write(doc, sim_id, extra))


@rpc("bcs.get")
def bcs_get(
    id: str = "",
    project_id: str = "",
    sim_id: str = "",
    simulation_id: str = "",
) -> Any:
    pid = _bound_project(id, project_id)
    return read_sibling(pid, "boundary_conditions.json", _bound_study(sim_id, simulation_id))


@rpc("bcs.set")
def bcs_set(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.set_bcs(root, doc, sim_id=_study_for_write(doc, sim_id, extra))


@rpc("bc.menu")
def bc_menu() -> dict[str, Any]:
    from cfddesk.case.bc_menu import menu_types

    types: list[dict[str, Any]] = []
    for mt in menu_types():
        variants = []
        for var in mt.variants:
            variants.append(
                {
                    "key": var.key,
                    "label": var.label,
                    "registry_key": var.registry_key,
                    "subvariants": [
                        {"key": sub[0], "label": sub[1], "registry_key": sub[2]} for sub in var.subvariants
                    ],
                }
            )
        types.append({"key": mt.key, "label": mt.label, "variants": variants})
    return {"ok": True, "menu": types}


@rpc("mesh.get")
def mesh_get(
    id: str = "",
    project_id: str = "",
    sim_id: str = "",
    simulation_id: str = "",
) -> Any:
    pid = _bound_project(id, project_id)
    return read_sibling(pid, "mesh.json", _bound_study(sim_id, simulation_id))


@rpc("mesh.set")
def mesh_set(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.set_mesh_settings(root, doc, sim_id=_study_for_write(doc, sim_id, extra))


@rpc("mesh.delete")
def mesh_delete(
    id: str = "",
    project_id: str = "",
    sim_id: str = "",
    simulation_id: str = "",
    mesh_id: str = "",
) -> dict[str, Any]:
    import shutil

    from cfddesk.project.paths import find_mesh

    pid = _bound_project(id, project_id)
    sid = _bound_study(sim_id, simulation_id)
    mid = str(mesh_id or "").strip()
    if not mid:
        raise RpcError(-32602, "mesh_id required")
    root = _require_dir(pid)
    found = find_mesh(root, mid, sid)
    if not found or not found.get("dir"):
        raise RpcError(-32004, "mesh not found", {"mesh_id": mid, "simulation_id": sid})
    shutil.rmtree(found["dir"], ignore_errors=True)
    return {"ok": True, "deleted": mid, "simulation_id": sid}


@rpc("refinements.get")
def refinements_get(
    id: str = "",
    project_id: str = "",
    sim_id: str = "",
    simulation_id: str = "",
) -> Any:
    pid = _bound_project(id, project_id)
    return read_sibling(pid, "mesh_refinements.json", _bound_study(sim_id, simulation_id))


@rpc("refinements.set")
def refinements_set(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.set_refinements(root, doc, sim_id=_study_for_write(doc, sim_id, extra))


@rpc("result_controls.get")
def result_controls_get(
    id: str = "",
    project_id: str = "",
    sim_id: str = "",
    simulation_id: str = "",
) -> Any:
    pid = _bound_project(id, project_id)
    sid = _bound_study(sim_id, simulation_id)
    return read_sibling(pid, "result_controls.json", sid) or read_sibling(pid, "area_average.json", sid)


@rpc("result_controls.set")
def result_controls_set(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.set_result_controls(root, doc, sim_id=_study_for_write(doc, sim_id, extra))


@rpc("sim_control.get")
def sim_control_get(
    id: str = "",
    project_id: str = "",
    sim_id: str = "",
    simulation_id: str = "",
) -> Any:
    pid = _bound_project(id, project_id)
    return read_sibling(pid, "simulation_control.json", _bound_study(sim_id, simulation_id))


@rpc("sim_control.set")
def sim_control_set(id: str = "", project_id: str = "", project_dir: str = "", body: dict | None = None, sim_id: str = "", **extra: Any) -> Any:
    root = _root(id or project_id, project_dir)
    doc = body if isinstance(body, dict) else extra
    return ww.set_sim_control(root, doc, sim_id=_study_for_write(doc, sim_id, extra))


@rpc("runs.get")
def runs_get(
    id: str = "",
    project_id: str = "",
    sim_id: str = "",
    simulation_id: str = "",
) -> Any:
    pid = _bound_project(id, project_id)
    return read_sibling(pid, "runs/catalog.json", _bound_study(sim_id, simulation_id))


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
    return ww.save_catalog(root, doc, sim_id=_study_for_write(doc, sim_id, extra))


def _analysis_spec(key: str) -> Any:
    from cfddesk.registry import load_all
    from cfddesk.registry.discovery import get_registry

    load_all()
    reg = get_registry("analysis")
    if key not in set(reg.keys()):
        raise ValueError(f"analysis {key!r} is not installed")
    return reg.get(key)


def _analysis_installed(key: str) -> bool:
    from cfddesk.registry import load_all
    from cfddesk.registry.discovery import get_registry

    load_all()
    return bool(key) and key in set(get_registry("analysis").keys())


def _analysis_missing_issue() -> dict[str, Any]:
    """Why a run whose analysis is not installed cannot start (its plugin is off or did not load)."""
    from cfddesk.registry.discovery import get_hub

    fix = {"go": "plugins"}
    for row in get_hub().required_failures:
        return {"message": f"{row.get('name') or row.get('key')} failed to load, so this run can't start.", "fix": fix}
    return {"message": "This run's analysis is not available: its plugin is off or did not load.", "fix": fix}


def _run_analysis_key(root: Path, simulation_id: str, run_id: str, time_dependency: str = "") -> str:
    """The analysis a run solves with: its study's family, at the run's time dependency."""
    from cfddesk.project.web_adapter import _analysis_and_app, _td, run_time_dependency

    td = _td(time_dependency) if time_dependency else run_time_dependency(root, run_id or None, simulation_id or None)
    key, _app = _analysis_and_app(root, simulation_id or None, td)
    return key


@rpc("analysis.describe")
def analysis_describe(key: str = "") -> dict[str, Any]:
    """One analysis row of registry.describe (with its contract fields)."""
    from cfddesk.registry.discovery import get_registry

    _analysis_spec(key)
    rows = {r["key"]: r for r in get_registry("analysis").describe()}
    return {"ok": True, "analysis": rows[key]}


@rpc("analysis.defaults")
def analysis_defaults(key: str = "", time_dependency: str = "") -> dict[str, Any]:
    """A new study's settings and a new run's settings for this analysis."""
    from cfddesk.registry import contract

    spec = _analysis_spec(key)
    return {
        "ok": True,
        "key": key,
        "sibling": contract.sibling(spec, time_dependency or spec.time_dependency),
        "study": contract.study_defaults(spec, time_dependency or None),
        "run": contract.run_defaults(spec),
    }


@rpc("analysis.validate_ready")
def analysis_validate_ready(
    project_id: str = "",
    project_dir: str = "",
    simulation_id: str = "",
    run_id: str = "",
    mesh_id: str = "",
    time_dependency: str = "",
) -> dict[str, Any]:
    """What blocks this run, as the analysis sees it (``issues`` empty = ready)."""
    from cfddesk.project.readiness import ready_context
    from cfddesk.registry import contract

    root = _root(project_id, project_dir)
    key = _run_analysis_key(root, simulation_id, run_id, time_dependency)
    if not _analysis_installed(key):
        return {"ok": True, "analysis_key": key, "ready": False, "issues": [_analysis_missing_issue()]}
    ctx = ready_context(root, simulation_id=simulation_id or None, run_id=run_id, mesh_id=mesh_id)
    issues = contract.validate_ready(_analysis_spec(key), ctx)
    return {"ok": True, "analysis_key": key, "ready": not issues, "issues": issues}


@rpc("analysis.run_normalize")
def analysis_run_normalize(
    project_id: str = "",
    project_dir: str = "",
    simulation_id: str = "",
    run_id: str = "",
    time_dependency: str = "",
    key: str = "",
    settings: dict | None = None,
    base: dict | None = None,
) -> dict[str, Any]:
    """A run's settings as its analysis stores them: the edits over what is
    stored, cleaned up by its run model (its limits, not the core's)."""
    from cfddesk.registry import contract

    if not key:
        key = _run_analysis_key(_root(project_id, project_dir), simulation_id, run_id, time_dependency)
    spec = _analysis_spec(key)
    edits = settings if isinstance(settings, dict) else {}
    stored = base if isinstance(base, dict) else None
    return {"ok": True, "analysis_key": key, "settings": contract.run_normalize(spec, edits, stored)}


@rpc("analysis.run_preview")
def analysis_run_preview(
    project_id: str = "",
    project_dir: str = "",
    run_id: str = "",
    simulation_id: str = "",
    mesh_id: str = "",
    time_dependency: str = "",
    settings: dict | None = None,
) -> dict[str, Any]:
    """The numbers a run would be written with right now (the Run panel preview).

    The analysis's own run model computes them with the same code prepare_run
    writes the case with, so the preview and controlDict cannot differ.
    """
    from cfddesk.project.run_inputs import gather_run_inputs
    from cfddesk.registry import contract

    root = _root(project_id, project_dir)
    key = _run_analysis_key(root, simulation_id, run_id, time_dependency)
    spec = _analysis_spec(key)
    raw = settings if isinstance(settings, dict) else {}
    inputs = gather_run_inputs(
        root,
        run_id=run_id or "preview",
        mesh_id=mesh_id or None,
        simulation_id=simulation_id or None,
        require_mesh=True,
        transient_override=raw if spec.time_dependency == "transient" else None,
        time_dependency=spec.time_dependency,
    )
    out = contract.run_preview(spec, inputs=inputs, settings=raw)
    return {**out, "analysis_key": key}


@rpc("analysis.run_monitors")
def analysis_run_monitors(
    project_id: str = "",
    project_dir: str = "",
    run_id: str = "",
    simulation_id: str = "",
    case_dir: str = "",
    time_dependency: str = "",
) -> dict[str, Any]:
    """A run's monitor results, read by the analysis the run solves with."""
    from cfddesk.registry import contract

    root = _root(project_id, project_dir)
    case = Path(case_dir).resolve() if case_dir else (root / "runs" / f"run-{run_id}").resolve()
    if not case.is_relative_to(root.resolve()):
        raise RpcError(-32602, "case_dir is outside the project", {"case_dir": case_dir})
    key = _run_analysis_key(root, simulation_id, run_id, time_dependency)
    if not _analysis_installed(key):
        # Only its analysis can read its monitors; say why there are none.
        return {"ok": True, "analysis_key": key, **contract.NO_MONITORS, "unavailable": _analysis_missing_issue()["message"]}
    return {"ok": True, "analysis_key": key, **contract.run_monitors(_analysis_spec(key), case)}


@rpc("analysis.launch_spec")
def analysis_launch_spec(key: str = "") -> dict[str, Any]:
    """How a case of this analysis is run (app, frames kept, processes, stop)."""
    from cfddesk.registry import contract
    from cfddesk.registry.discovery import get_registry

    spec = _analysis_spec(key)
    return {"ok": True, "launch": contract.launch_spec(spec, get_registry("solver")).to_json()}


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
    plugin = hub.registry("filter").owner(spec.key)
    tool_path = _package_tool(hub.plugin_dir(plugin), spec.tool)
    if plugin != "builtin" and not tool_path:
        # Never fall back to a core tool of the same name.
        raise RpcError(-32602, f"plugin filter {spec.key}: tool {spec.tool!r} is not in the plugin folder")
    out = {
        "ok": True,
        "key": spec.key,
        "tool": spec.tool,
        "cache_scope": spec.cache_scope,
        "output": spec.output,
        "params": values,
        "plugin": plugin,
        "args_from_params": list(getattr(spec, "args_from_params", ()) or ()),
        "tool_path": tool_path,
    }
    if plugin != "builtin":
        # A plugin with its own environment runs its filter tools there.
        out.update(_plugin_runtime(hub, plugin, required=False))
    return out


def _package_tool(package: Path | None, tool: str) -> str:
    """Absolute path of a plugin tool inside its package, or '' (missing or escaping)."""
    if package is None:
        return ""
    root = Path(package).resolve()
    candidate = (root / str(tool)).resolve()
    if candidate != root and root not in candidate.parents:
        return ""
    if candidate.is_file():
        return str(candidate)
    return ""


def _job_row(hub: Any, spec: Any) -> dict[str, Any]:
    plugin = hub.registry("job").owner(spec.key)
    runtime = str(getattr(spec, "python", "core") or "core")
    row: dict[str, Any] = {
        "key": spec.key,
        "tool": spec.tool,
        "scope": spec.scope,
        "args_from_params": list(spec.args_from_params),
        "plugin": plugin,
        "tool_path": _package_tool(hub.job_package(spec.key), spec.tool),
        "runtime": runtime,
        # The interpreter and folder it runs in (None: the app's own).
        "python": None,
        "cwd": None,
    }
    if runtime == "plugin" and plugin != "builtin":
        row.update(_plugin_runtime(hub, plugin, required=True))
    return row


def _plugin_runtime(hub: Any, plugin: str, *, required: bool) -> dict[str, Any]:
    """Where a plugin's tool runs: its own environment's interpreter and its folder.

    ``python`` stays None (the app's interpreter) for a plugin without an
    environment, unless ``required``; ``python_error`` says why it cannot run yet.
    """
    from cfddesk.registry.plugin_env import env_status

    manifest = hub.manifests.get(plugin)
    folder = hub.plugin_dir(plugin)
    out: dict[str, Any] = {"python": None, "cwd": str(folder) if folder is not None else None}
    spec_env = manifest.python_env if manifest is not None else None
    if spec_env is None:
        if required:
            out["python_error"] = f"{plugin} declares no [python] environment"
        return out
    state = env_status(web_root(), plugin, spec_env)
    if state["state"] == "ready":
        out["python"] = state["python"]
    else:
        name = manifest.name if manifest is not None else plugin
        out["python_error"] = f"{name} needs setup: install its dependencies in Settings > Plugins"
    return out


@rpc("jobs.describe")
def jobs_describe(kind: str = "") -> dict[str, Any]:
    hub = load_all(web_root=web_root())
    reg = hub.registry("job")
    wanted = str(kind or "").strip()
    if wanted:
        try:
            spec = reg.get(wanted)
        except RegistryError as exc:
            raise RpcError(-32602, f"unknown job kind: {wanted}") from exc
        row = _job_row(hub, spec)
        if row["plugin"] != "builtin" and not row["tool_path"]:
            # A plugin job runs only its own tool, never a core tool of the same name.
            raise RpcError(-32602, f"plugin job {wanted}: tool {spec.tool!r} is not in the plugin folder")
        return {"ok": True, "job": row}
    return {"ok": True, "jobs": [_job_row(hub, spec) for spec in reg.items()]}


_PLUGIN_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")


# ---------------------------------------------------------------------------
# Plugin studies (project-level records a plugin owns; API 1.1)
# ---------------------------------------------------------------------------

# A study changed since the caller read it: HTTP 409.
RPC_CONFLICT = -32009


def _plugin_study_catalog(root: Path, pid: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Every plugin study in the project (enabled plugin or not) and the kinds that can be created."""
    from cfddesk.project.scope import plugin_study_scope
    from cfddesk.registry.plugin_data import PluginData, plugin_data_folders, version_tuple

    hub = load_all(web_root=web_root())
    catalog = {str(r.get("key")): r for r in plugin_catalog(web_root())}
    enabled = {
        key: m
        for key, m in hub.manifests.items()
        if str((catalog.get(key) or {}).get("status") or "enabled") == "enabled"
    }
    studies: list[dict[str, Any]] = []
    for key in plugin_data_folders(root):
        manifest = enabled.get(key)
        kinds = {k.key: k for k in (manifest.study_kinds if manifest is not None else [])}
        for rec in PluginData(root, key).studies():
            kind = kinds.get(str(rec.get("kind") or ""))
            row = catalog.get(key) or {}
            # A plugin that failed to load may be listed only by its folder: the study
            # keeps the name its plugin had, as it does for a plugin that is off.
            listed = "" if str(row.get("status") or "") == "error" else str(row.get("name") or "")
            name = next(
                (n for n in (listed, str(rec.get("plugin_name") or ""), str(row.get("name") or "")) if n and n != key),
                key,
            )
            needs_setup = str(row.get("status") or "") == "needs setup"
            why = (
                f"{name} needs setup: install its dependencies in Settings > Plugins"
                if needs_setup
                else f"Requires the {name} plugin"
            )
            newer = (
                manifest is not None
                and version_tuple(str(rec.get("plugin_version") or "0")) > version_tuple(manifest.version)
            )
            schema = int(rec.get("schema_version") or 1)
            studies.append(
                {
                    "id": rec["id"],
                    "plugin": key,
                    "plugin_name": name,
                    "kind": rec.get("kind"),
                    "kind_title": kind.title if kind else "",
                    "icon": kind.icon if kind else "",
                    "workspace": kind.workspace if kind else "",
                    "title": rec.get("title") or rec["id"],
                    "rev": int(rec.get("rev") or 0),
                    "available": kind is not None,
                    "read_only": bool(newer),
                    # Saved with an older schema of its kind: its plugin's service upgrades it.
                    "schema_version": schema,
                    "kind_schema_version": int(kind.schema_version) if kind else None,
                    "needs_migration": kind is not None and not newer and schema < int(kind.schema_version),
                    "reason": "" if kind is not None else why,
                    "scope_key": plugin_study_scope(pid, key, rec["id"]),
                }
            )
    kinds_out = [
        {
            "plugin": key,
            "plugin_name": m.name,
            "key": k.key,
            "title": k.title,
            "icon": k.icon,
            # The workspace a study of this kind opens in ("" when it has none).
            "workspace": k.workspace,
            # API 1.4: it may link a project geometry (used from 1.5), and its start action.
            "links_geometry": k.links_geometry,
            "start_action": next(
                (start_action_row(m, a) for a in m.start_actions if a.study_kind == k.key),
                None,
            ),
        }
        # Plugin load order (bundled, then user plugins), then manifest order: the
        # order start actions are drawn and capped in (shownStartActions).
        for key, m in enabled.items()
        for k in m.study_kinds
    ]
    return studies, kinds_out


def _plugin_data_for(project_id: str, plugin: str):
    from cfddesk.registry.plugin_data import PluginData, PluginDataError

    try:
        return PluginData(_require_dir(project_id), plugin)
    except PluginDataError as exc:
        raise RpcError(-32602, str(exc)) from exc


def _study_call(fn, *args: Any, **kwargs: Any) -> Any:
    from cfddesk.registry.plugin_data import PluginDataError, StaleRevisionError, StudyNotFoundError

    try:
        return fn(*args, **kwargs)
    except StaleRevisionError as exc:
        raise RpcError(RPC_CONFLICT, str(exc), {"rev": exc.current}) from exc
    except StudyNotFoundError as exc:
        raise RpcError(-32004, "study not found") from exc
    except PluginDataError as exc:
        raise RpcError(-32602, str(exc)) from exc


def _study_row(project_id: str, plugin: str, study_id: str) -> dict[str, Any]:
    rows, _kinds = _plugin_study_catalog(_require_dir(project_id), project_id)
    hit = next((r for r in rows if r["plugin"] == plugin and r["id"] == study_id), None)
    if hit is None:
        raise RpcError(-32004, "study not found")
    return hit


@rpc("plugin_studies.list")
def plugin_studies_list(project_id: str = "") -> dict[str, Any]:
    """The project's plugin studies (greyed when their plugin is off or missing) and the kinds to create."""
    pid = str(project_id or "").strip()
    studies, kinds = _plugin_study_catalog(_require_dir(pid), pid)
    return {"ok": True, "project_id": pid, "studies": studies, "kinds": kinds}


@rpc("plugin_studies.create")
def plugin_studies_create(project_id: str = "", plugin: str = "", kind: str = "", title: str = "") -> dict[str, Any]:
    pid = str(project_id or "").strip()
    data = _plugin_data_for(pid, plugin)
    _rows, kinds = _plugin_study_catalog(_require_dir(pid), pid)
    decl = next((k for k in kinds if k["plugin"] == data.plugin and k["key"] == kind), None)
    if decl is None:
        raise RpcError(-32602, f"{plugin} has no study kind {kind!r} (is the plugin on?)")
    manifest = load_all(web_root=web_root()).manifests[data.plugin]
    schema = next(k.schema_version for k in manifest.study_kinds if k.key == kind)
    rec = _study_call(
        data.create_study,
        kind,
        title or decl["title"],
        plugin_name=manifest.name,
        plugin_version=manifest.version,
        schema_version=schema,
    )
    return {"ok": True, "study": _study_row(pid, data.plugin, rec["id"])}


@rpc("plugin_studies.rename")
def plugin_studies_rename(
    project_id: str = "", plugin: str = "", study_id: str = "", title: str = "", rev: int | None = None
) -> dict[str, Any]:
    pid = str(project_id or "").strip()
    data = _plugin_data_for(pid, plugin)
    row = _study_row(pid, data.plugin, study_id)
    if not row["available"]:
        raise RpcError(-32602, row["reason"])
    if row["read_only"]:
        raise RpcError(-32602, "This study was saved by a newer version of the plugin; it opens read-only.")
    _study_call(data.rename_study, study_id, title, rev)
    return {"ok": True, "study": _study_row(pid, data.plugin, study_id)}


@rpc("plugin_studies.delete")
def plugin_studies_delete(project_id: str = "", plugin: str = "", study_id: str = "") -> dict[str, Any]:
    """Remove a study (also when its plugin is off or missing: the user confirmed it)."""
    pid = str(project_id or "").strip()
    data = _plugin_data_for(pid, plugin)
    _study_call(data.delete_study, study_id)
    return {"ok": True, "deleted": study_id}


@rpc("plugin_studies.get")
def plugin_studies_get(project_id: str = "", plugin: str = "", study_id: str = "") -> dict[str, Any]:
    """One study's whole record (what the plugin's migrate_study gets)."""
    pid = str(project_id or "").strip()
    data = _plugin_data_for(pid, plugin)
    return {"ok": True, "study": _study_call(data.study, study_id)}


# What a study update may not change: the host keeps these.
_STUDY_FIXED = {"id", "kind", "plugin", "plugin_name", "plugin_version", "schema_version", "created_at", "updated_at", "rev"}


@rpc("plugin_studies.update")
def plugin_studies_update(
    project_id: str = "", plugin: str = "", study_id: str = "", rev: int | None = None, patch: dict | None = None
) -> dict[str, Any]:
    """Change a study's own fields (its workspace saves it), refused for a stale rev."""
    pid = str(project_id or "").strip()
    data = _plugin_data_for(pid, plugin)
    row = _study_row(pid, data.plugin, study_id)
    if not row["available"]:
        raise RpcError(-32602, row["reason"])
    if row["read_only"]:
        raise RpcError(-32602, "This study was saved by a newer version of the plugin; it opens read-only.")
    if not isinstance(patch, dict):
        raise RpcError(-32602, "patch must be an object")
    rec = _study_call(data.update_study, study_id, {k: v for k, v in patch.items() if k not in _STUDY_FIXED}, rev)
    return {"ok": True, "study": rec}


_STUDY_RECORD_WRITE = "a study's record changes only through the study calls"


def _is_study_record(parts: list[str] | tuple[str, ...]) -> bool:
    """studies/<sid>/study.json in any spelling Windows opens as that file."""
    from cfddesk.registry.plugin_data import is_study_record

    return is_study_record(parts)


def _plugin_data_rel(rel: str, *, write: bool) -> str:
    """A path in the plugin's data folder as a workspace may name it (the rules
    are magnusim_sdk.data.data_rel). A write never reaches a study's record,
    which changes only through the study calls (they check its rev)."""
    from cfddesk.registry.plugin_data import PluginDataError, data_rel

    try:
        return data_rel(rel, write=write)
    except PluginDataError as exc:
        raise RpcError(-32602, str(exc)) from exc


_PLUGIN_DATA_MAX = 8 * 1024 * 1024


@rpc("plugin_data.read")
def plugin_data_read(project_id: str = "", plugin: str = "", rel: str = "") -> dict[str, Any]:
    """A JSON file from the plugin's own folder in the project (null when there is none)."""
    data = _plugin_data_for(str(project_id or "").strip(), plugin)
    path = _plugin_data_rel(rel, write=False)
    return {"ok": True, "doc": _study_call(data.read_json, path)}


@rpc("plugin_data.write")
def plugin_data_write(project_id: str = "", plugin: str = "", rel: str = "", doc: Any = None) -> dict[str, Any]:
    """Save a JSON file in the plugin's own folder in the project (8 MB at most)."""
    from cfddesk.registry.manifest import FilesSpec

    data = _plugin_data_for(str(project_id or "").strip(), plugin)
    path = _plugin_data_rel(rel, write=True)
    # Checked again where it lands (the resolved path has Windows' long, real names);
    # a file in a study's folder needs the study.
    target = _study_call(data.file_path, path, write=True)
    if _is_study_record(target.relative_to(data.root.resolve()).parts):
        raise RpcError(-32602, _STUDY_RECORD_WRITE)
    if len(json.dumps(doc)) > _PLUGIN_DATA_MAX:
        raise RpcError(-32602, "that file is larger than 8 MB")
    # One folder, two views: the plugin's [files] quota holds for ws.data as for ws.files.
    manifest = load_all(web_root=web_root()).manifests.get(data.plugin)
    spec = manifest.files if manifest is not None else FilesSpec()
    size = len(json.dumps(doc, indent=2, ensure_ascii=False).encode("utf-8", "surrogatepass")) + 1
    _study_call(data.check_room, target, size, spec.max_total_bytes)
    _study_call(data.write_json, path, doc)
    return {"ok": True}


@rpc("plugin_studies.migrated")
def plugin_studies_migrated(
    project_id: str = "", plugin: str = "", study_id: str = "", rev: int | None = None, study: dict | None = None
) -> dict[str, Any]:
    """Store a study its plugin's migrate_study upgraded: the kind's current
    schema_version and the plugin's version, over the record it returned."""
    pid = str(project_id or "").strip()
    data = _plugin_data_for(pid, plugin)
    if not isinstance(study, dict):
        raise RpcError(-32602, "migrate_study returned no study record")
    manifest = load_all(web_root=web_root()).manifests.get(data.plugin)
    if manifest is None:
        raise RpcError(-32602, f"{plugin} is not loaded")
    current = _study_call(data.study, study_id)
    kind = next((k for k in manifest.study_kinds if k.key == current.get("kind")), None)
    if kind is None:
        raise RpcError(-32602, f"{plugin} has no study kind {current.get('kind')!r}")
    if int(current.get("schema_version") or 1) < int(kind.schema_version):
        patch = {k: v for k, v in study.items() if k not in {"id", "kind", "plugin", "created_at", "rev", "updated_at"}}
        patch["schema_version"] = int(kind.schema_version)
        patch["plugin_version"] = manifest.version
        _study_call(data.update_study, study_id, patch, rev)
    return {"ok": True, "study": _study_row(pid, data.plugin, study_id)}


@rpc("plugin.dispatch")
def plugin_dispatch(
    key: str = "",
    method: str = "",
    params: dict | None = None,
    scope: dict | None = None,
) -> dict[str, Any]:
    plugin_key = str(key or "").strip()
    method_name = str(method or "").strip().lstrip("/")
    if not _PLUGIN_KEY.match(plugin_key) or plugin_key.endswith(".") or plugin_key.endswith(" "):
        raise RpcError(-32602, "invalid plugin key")
    parts = method_name.split("/")
    if not method_name or ".." in parts or "\\" in method_name:
        raise RpcError(-32602, "invalid plugin method")
    scope_in = dict(scope or {})
    params_in = dict(params or {})
    scope_pid = str(scope_in.get("project_id") or scope_in.get("projectId") or "").strip()
    param_pid = str(params_in.get("project_id") or params_in.get("projectId") or "").strip()
    if scope_pid and param_pid and scope_pid != param_pid:
        raise RpcError(-32602, "project_id does not match this request")
    if scope_pid:
        params_in["project_id"] = scope_pid
        scope_in["project_id"] = scope_pid
    pid = scope_pid or param_pid
    if pid and (project_dir(pid) / "project.json").is_file():
        # The plugin's own folder in this project, and nothing else.
        from cfddesk.registry.plugin_data import PluginData

        scope_in["data"] = PluginData(project_dir(pid), plugin_key)
    hub = load_all(web_root=web_root())
    try:
        result = hub.call_method(plugin_key, method_name, params_in, scope_in)
    except RegistryError as exc:
        raise RpcError(-32602, str(exc)) from exc
    if isinstance(result, dict):
        return result
    return {"ok": True, "result": result}


# ---------------------------------------------------------------------------
# CAD
# ---------------------------------------------------------------------------


@rpc("cad.load")
def cad_load(step_path: str) -> dict[str, Any]:
    from cfddesk.cad.preview import count_sub, shape_bounds
    from cfddesk.worker.cad_cache import load_shape

    path = Path(step_path)
    if not _geometry_exists(path):
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


def _geometry_exists(path: Path) -> bool:
    """The STEP or its binary sidecar (mesh imports write the STEP later)."""
    from cfddesk.cad.io import geometry_file_exists

    return geometry_file_exists(path)


@rpc("cad.normalize")
def cad_normalize(src: str, dest: str, unit: str = "MM") -> dict[str, Any]:
    """STL/STEP import on the warm worker so the UI does not pay a new Python startup."""
    from cfddesk.cad.io import load_cad, write_geometry

    path = Path(src)
    if not path.is_file():
        raise RpcError(-32004, "geometry file not found", {"src": src})
    loaded = load_cad(path, length_unit=unit)
    out = Path(dest)
    # Mesh files (STL/OBJ/PLY): the binary sidecar now, the slow STEP in the background.
    defer = write_geometry(loaded, out)
    return {"ok": True, "step_path": str(out), "step_deferred": defer, **loaded.summary()}


@rpc("cad.preview")
def cad_preview(step_path: str, edges: str, faces: str, meta: str | None = None) -> dict[str, Any]:
    from cfddesk.cad.preview import export_preview
    from cfddesk.worker.cad_cache import load_shape

    path = Path(step_path)
    if not _geometry_exists(path):
        raise RpcError(-32004, "STEP not found", {"step_path": step_path})
    from cfddesk.cad.io import read_triangle_sidecar

    # Mesh imports with a current triangle sidecar need no OCC shape for the preview.
    shape = None if read_triangle_sidecar(path) is not None else load_shape(path)
    result = export_preview(path, Path(edges), Path(faces), Path(meta) if meta else None, shape=shape)
    return {"ok": True, **result}


@rpc("cad.faces")
def cad_faces(step_path: str, meta: str | None = None) -> dict[str, Any]:
    from cfddesk.cad.preview import write_faces_into_meta
    from cfddesk.worker.cad_cache import load_shape

    path = Path(step_path)
    if not _geometry_exists(path):
        raise RpcError(-32004, "STEP not found")
    load_shape(path)
    meta_path = Path(meta) if meta else path.with_name("cad_preview.json")
    out = write_faces_into_meta(path, meta_path)
    return {"ok": True, "n_faces": len(out.get("faces") or []), "meta": out}


@rpc("cad.stl")
def cad_stl(step_path: str) -> dict[str, Any]:
    path = Path(step_path)
    if not _geometry_exists(path):
        raise RpcError(-32004, "STEP not found")
    from cfddesk.worker.cad_cache import load_shape

    load_shape(path)
    return {"ok": True, "step_path": str(path), "note": "STL is generated by convert_step_to_stl job/CLI"}


@rpc("cad.thumb")
def cad_thumb(step_path: str) -> dict[str, Any]:
    path = Path(step_path)
    if not _geometry_exists(path):
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


@rpc("plugins.list")
def plugins_list() -> dict[str, Any]:
    root = web_root()
    load_all(web_root=root)
    return {"ok": True, "plugins": plugin_catalog(root)}


def _set_plugin_enabled(key: str, enabled: bool) -> dict[str, Any]:
    """Turn a plugin on or off: the worker is the one writer of both lists.

    ``plugins.disabled``: turned off. ``plugins.enabled``: turned on, kept for
    bundled plugins that are not required, so an optional one that ships off
    (``default_enabled = false``) stays on, and the choice survives a later version
    changing its default.
    """
    from cfddesk.registry.discovery import REQUIRED_BUNDLED

    key = str(key)
    hub = load_all(web_root=web_root())
    manifest = hub.manifests.get(key)
    off_row = next((r for r in hub.off_plugins if str(r.get("key")) == key), None)
    required = key in REQUIRED_BUNDLED or bool(getattr(manifest, "required", False))
    if not enabled and required:
        name = REQUIRED_BUNDLED.get(key) or getattr(manifest, "name", key)
        raise RpcError(-32602, f"{name} is required and cannot be turned off")
    tier = str(getattr(manifest, "tier", "") or (off_row or {}).get("tier") or "")
    optional_bundled = tier == "bundled" and not required
    doc = _local_doc()
    plugins = doc.get("plugins")
    if not isinstance(plugins, dict):
        plugins = {}
    disabled = [str(x) for x in (plugins.get("disabled") or [])]
    # A file that held only the flat "plugins.disabled" list: fold it in, or the
    # nested object written below would hide it from discovery.
    flat = doc.pop("plugins.disabled", None)
    if isinstance(flat, list):
        disabled += [str(x) for x in flat if str(x) not in disabled]
    on = [str(x) for x in (plugins.get("enabled") or [])]
    if enabled:
        disabled = [d for d in disabled if d != key]
        if optional_bundled and key not in on:
            on.append(key)
    else:
        if key not in disabled:
            disabled.append(key)
        on = [k for k in on if k != key]
    plugins["disabled"] = disabled
    if on or "enabled" in plugins:
        plugins["enabled"] = on
    doc["plugins"] = plugins
    _write_local(doc)
    _drop_from_legacy(key, "disabled" if enabled else "enabled")
    registry_reload()
    return plugins_list()


def _drop_from_legacy(key: str, field: str) -> None:
    """Discovery also reads the legacy web-root .cfddesk-local.json (a union): a key
    left in its ``field`` list ("disabled" or "enabled") would keep undoing the
    choice just made, since Enable and Disable edit only the current file. A local
    JSON named by MAGNUSIM_LOCAL_JSON is read alone, so the legacy file stays as it is."""
    from cfddesk.wsl.config import local_json_named

    legacy = web_root() / ".cfddesk-local.json"
    if local_json_named():
        return
    try:
        if not legacy.is_file() or legacy.resolve() == local_json_path().resolve():
            return
        data = json.loads(legacy.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(data, dict):
        return
    changed = False
    plugins = data.get("plugins")
    if isinstance(plugins, dict) and isinstance(plugins.get(field), list):
        kept = [str(x) for x in plugins[field] if str(x) != key]
        if len(kept) != len(plugins[field]):
            plugins[field] = kept
            changed = True
    flat = data.get(f"plugins.{field}")
    if isinstance(flat, list):
        kept = [str(x) for x in flat if str(x) != key]
        if len(kept) != len(flat):
            data[f"plugins.{field}"] = kept
            changed = True
    if changed:
        ww.atomic_write(legacy, data)


@rpc("plugins.env")
def plugins_env(key: str = "") -> dict[str, Any]:
    """A loaded plugin's own environment: its state and, when ready, its
    interpreter, service module and folder (for the host; not for pages)."""
    from cfddesk.registry.plugin_env import env_status

    hub = load_all(web_root=web_root())
    manifest = hub.manifests.get(str(key))
    if manifest is None:
        raise RpcError(-32004, f"plugin {key!r} is not loaded (off, missing or failed)")
    spec = manifest.python_env
    if spec is None:
        return {"ok": True, "key": manifest.key, "name": manifest.name, "env": None}
    folder = hub.plugin_dir(manifest.key)
    state = env_status(web_root(), manifest.key, spec)
    return {
        "ok": True,
        "key": manifest.key,
        "name": manifest.name,
        "env": {**state, "service": spec.service, "plugin_dir": str(folder) if folder is not None else None},
    }


@rpc("plugins.env_remove")
def plugins_env_remove(key: str = "") -> dict[str, Any]:
    """Delete a plugin's environments (its studies and data stay)."""
    from cfddesk.registry.plugin_env import remove_envs

    try:
        removed = remove_envs(web_root(), str(key))
    except ValueError as exc:
        raise RpcError(-32602, str(exc)) from exc
    return {"ok": True, "removed": removed}


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


_FIELD_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


def _field_name(field: str | None) -> str:
    """A result field to colour by: a scalar's name, or ``mag<X>`` for vector X (default magU)."""
    name = str(field or "magU").strip()
    if not _FIELD_NAME.match(name):
        raise RpcError(-32602, f"invalid field name {name!r}")
    return name


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
    name = _field_name(field)
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
    name = _field_name(field)
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
    name = _field_name(field)
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


@rpc("filter.inspect")
def filter_inspect(
    case_dir: str = "",
    time: str = "",
    out_dir: str = "",
    x: Any = None,
    y: Any = None,
    z: Any = None,
    **_extra: Any,
) -> dict[str, Any]:
    """Probe magU/p at a point on the cached volume (writes inspect.meta.json)."""
    case = str(case_dir or "").strip()
    dest = str(out_dir or "").strip()
    if not case:
        raise RpcError(-32602, "case_dir required")
    if not dest:
        raise RpcError(-32602, "out_dir required")
    try:
        px, py, pz = float(x), float(y), float(z)
    except (TypeError, ValueError) as exc:
        raise RpcError(-32602, "x, y, z required") from exc
    from export_inspect_point import export_inspect

    from cfddesk.worker.volume_cache import get_prepared

    t = str(time or "0")
    try:
        entry = get_prepared(case, t)
        result = export_inspect(
            Path(case),
            t,
            Path(dest),
            px,
            py,
            pz,
            mesh=entry.get("slice") or entry.get("grid") or entry.get("mesh"),
            source=str(entry.get("source") or "worker-cache"),
        )
    except RpcError:
        raise
    except Exception as exc:
        raise RpcError(-32004, str(exc), {"case_dir": case, "time": t}) from exc
    return {
        "ok": True,
        "case_dir": case,
        "time": t,
        "out_dir": dest,
        "hit": result["hit"],
        "magU": result["magU"],
        "p": result["p"],
        "volume_cached": True,
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
