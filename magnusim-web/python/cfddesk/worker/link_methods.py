"""Worker RPCs for linked geometries (host API 1.5), all on the main worker lane.

The main lane runs one call at a time, in the order sent, so each of these runs
wholly before, between or after every Python save of study records (proposal 5.16).

- ``geometry.link_check``: what the link call needs to know, in one read: the
  project's format, the study and whether its kind may link, and the geometry linked
  to ``(plugin, study_id)`` with its state and journal;
- ``geometry.check_kinds``: record kinds of the geometry's studies no loaded plugin provides;
- ``geometry.record_source``: a link that changed nothing records its version;
- ``geometry.plan`` / ``geometry.apply``: an update's commit (``cfddesk.project.link``);
- ``geometry.barrier``: an empty call; it answers only after every call sent before it;
- ``geometry.usage``: the simulation studies on a geometry with saved setup (whether a
  shape change asks, proposal 5.0), with what blocks an overwrite or a copy;
- ``geometry.next_version``: the version and name of a study's next linked geometry;
- ``geometry.link_commit``: a new linked geometry's commit (a first link, "Save as new");
- ``geometry.forget_lost``: removes lost-face entries from records (the user's Forget);
- ``geometry.lost_list``: a geometry's link for its panel (source, last update, lost entries);
- ``project.upsert_geometry``: adds or refreshes one geometry record in project.json.

Editing a project geometry (API 1.7, ``cfddesk.project.geometry_actions``):

- ``geometry_actions.open``: the study a geometry action opens (made the first time);
- ``geometry.edit_target`` / ``geometry.source_path`` / ``geometry.faces_table``: the
  geometry a study edits, its STEP file and its face table, for the workspace bridge;
- ``geometry.adopt_names``: checks a first link's ``originalNames`` and writes the named
  face table the adoption's face map starts from;
- ``geometry.original_import``: an adopted geometry's original file, to import it again;
- ``geometry.mark_removed`` / ``geometry.clear_removed``: a removed geometry's studies get
  ``geometry_removed`` (their next link asks first); a link that adds it again clears it.

A refusal is an answer, ``{ok: false, code, error, data?}``, not an RPC error.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from cfddesk.project import geometry_actions as ga
from cfddesk.project import link
from cfddesk.registry import load_all
from cfddesk.worker.paths import project_dir, web_root
from cfddesk.worker.rpc import RpcError, rpc


def _refusal(exc: link.LinkError) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": False, "code": exc.code, "error": exc.message}
    if exc.data is not None:
        out["data"] = exc.data
    return out


def _root(project_id: str = "", project_dir_s: str = "") -> Path:
    if project_dir_s:
        root = Path(project_dir_s)
    else:
        if not str(project_id or "").strip():
            raise RpcError(-32602, "project_id or project_dir required")
        root = project_dir(project_id)
    if not (root / "project.json").is_file():
        raise RpcError(-32004, "project not found", {"project_id": project_id})
    return root


def _known() -> dict[str, set[str]]:
    hub = load_all(web_root=web_root())
    return {reg: set(hub.registry(reg).keys()) for reg in ("bc", "monitor", "mesher")}


def holds_of(field: Any) -> str:
    """What a schema field holds: "faces", "body" or "" (by its widget, or ``holds`` for a plugin widget)."""
    widget = str(getattr(field, "widget", "") or "")
    if widget in ("faces", "patch"):
        return "faces"
    if widget == "body":
        return "body"
    holds = str(getattr(field, "holds", "") or "")
    return holds if holds in ("faces", "body") else ""


def _schema_fields() -> dict[str, dict[str, list[tuple[str, str]]]]:
    """Per registry and key, the schema fields that hold faces or bodies (patched by the rewrite)."""
    hub = load_all(web_root=web_root())
    out: dict[str, dict[str, list[tuple[str, str]]]] = {}
    for reg in ("bc", "monitor", "mesher"):
        rows: dict[str, list[tuple[str, str]]] = {}
        for spec in hub.registry(reg).items():
            fields: list[tuple[str, str]] = []
            for bag in ("settings_schema", "fields_schema", "params_schema", "schema"):
                for f in getattr(spec, bag, None) or ():
                    holds = holds_of(f)
                    if holds and getattr(f, "key", None):
                        fields.append((str(f.key), holds))
            if fields:
                rows[str(spec.key)] = fields
        out[reg] = rows
    # A BC family's fields (the BC panel's editor) sit at the top level of its records,
    # whose kind is the variant the family resolves them to: each variant gets them.
    for fam in hub.registry("bc_family").items():
        fam_fields = [(str(f.key), holds_of(f)) for f in getattr(fam, "fields", None) or () if holds_of(f) and getattr(f, "key", None)]
        if not fam_fields:
            continue
        for variant in getattr(fam, "variants", ()) or ():
            have = out["bc"].setdefault(str(variant), [])
            have.extend(x for x in fam_fields if x not in have)
    return out


def _catalog() -> list[dict[str, Any]]:
    from cfddesk.registry.discovery import plugin_catalog

    try:
        return plugin_catalog(web_root())
    except Exception:
        return []


def _geometry_row(project_root: Path, geom: dict[str, Any] | None) -> dict[str, Any] | None:
    if not geom:
        return None
    gdir = Path(geom["dir"])
    return {
        "id": str(geom.get("id") or ""),
        "name": str((geom.get("state") or {}).get("name") or geom.get("name") or ""),
        "folder": gdir.name,
        "state": geom.get("state"),
        "journal": link.read_journal(gdir),
        "lost_faces": sum(link.lost_counts(project_root, str(geom.get("id") or "")).values()),
    }


@rpc("geometry.link_check")
def geometry_link_check(project_id: str = "", plugin: str = "", study_id: str = "") -> dict[str, Any]:
    try:
        root = _root(project_id)
    except RpcError:
        return {"ok": False, "code": "project_not_found", "error": "No such project"}
    if link.is_desktop_format(root):
        return {
            "ok": False,
            "code": "not_allowed",
            "error": "This project was saved by the desktop app in its older format. Link into a project made in this app.",
        }
    from cfddesk.worker.methods import _plugin_study_catalog

    studies, kinds = _plugin_study_catalog(root, project_id)
    study = next((s for s in studies if s["plugin"] == plugin and s["id"] == study_id), None)
    if study is None:
        return {"ok": False, "code": "study_not_found", "error": "That study was removed"}
    kind = next((k for k in kinds if k["plugin"] == plugin and k["key"] == study.get("kind")), None)
    linked = _geometry_row(root, link.find_linked(root, plugin, study_id))
    adopt_refused = None
    removed = None
    if linked is None:
        # API 1.7: the study edits a plain project geometry (edits_geometry): its first link
        # takes that geometry over (state rev 0), unless another study did meanwhile.
        target = ga.adopt_target(root, plugin, study_id)
        if target is not None and target["other"] is not None:
            name = ga.display_name(target["geometry"], target["row"])
            adopt_refused = {"code": "adopted", "error": f"{name} is already edited in {target['other']['title']}."}
        elif target is not None:
            geom = target["geometry"]
            gdir = Path(geom["dir"])
            linked = {
                "id": str(geom.get("id") or ""),
                "name": ga.display_name(geom, target["row"]),
                "folder": gdir.name,
                "state": ga.adopt_state(geom, target["row"]),
                "journal": link.read_journal(gdir),
                "lost_faces": 0,
                "adopt": True,
            }
        else:
            # The geometry it edited or linked was removed: its link asks before it adds one.
            removed = ga.removed_target(root, plugin, study_id)
    return {
        "ok": True,
        "study": {
            "id": study["id"],
            "title": study["title"],
            "kind": study.get("kind"),
            "workspace": study.get("workspace") or "",
            "available": bool(study.get("available")),
            "read_only": bool(study.get("read_only")),
            "plugin_name": study.get("plugin_name") or plugin,
        },
        "links_geometry": bool(kind and kind.get("links_geometry")),
        "geometry": linked,
        "adopt_refused": adopt_refused,
        "removed": removed,
    }


@rpc("geometry.mark_removed")
def geometry_mark_removed(project_id: str = "", geometry_id: str = "") -> dict[str, Any]:
    root = _root(project_id)
    return ga.mark_removed(root, geometry_id)


@rpc("geometry.clear_removed")
def geometry_clear_removed(project_id: str = "", plugin: str = "", study_id: str = "") -> dict[str, Any]:
    root = _root(project_id)
    return {"ok": True, "cleared": ga.clear_removed(root, plugin, study_id)}


@rpc("geometry.check_kinds")
def geometry_check_kinds(project_id: str = "", project_dir: str = "", geometry_id: str = "") -> dict[str, Any]:
    root = _root(project_id, project_dir)
    return {"ok": True, "unknown": link.check_kinds(root, geometry_id, _known(), _catalog(), web_root())}


@rpc("geometry.record_source")
def geometry_record_source(
    project_id: str = "", project_dir: str = "", geometry_id: str = "", source_version: int = 0, synced_at: str = ""
) -> dict[str, Any]:
    root = _root(project_id, project_dir)
    try:
        return link.record_source(root, geometry_id, int(source_version), synced_at or None)
    except link.LinkError as exc:
        return _refusal(exc)


@rpc("geometry.plan")
def geometry_plan(
    project_id: str = "",
    project_dir: str = "",
    geometry_id: str = "",
    staging_rel: str = "",
    from_rev: int = 0,
    same_shape: bool = False,
    studies: list[str] | None = None,
    rev: int | None = None,
    map_from: str = "",
    adopt: bool = False,
) -> dict[str, Any]:
    root = _root(project_id, project_dir)
    try:
        return link.plan(
            root, geometry_id, staging_rel, int(from_rev), bool(same_shape), studies, rev,
            known=_known(), catalog=_catalog(), web_root=web_root(), schema_fields=_schema_fields(),
            map_from=map_from or None, adopt=bool(adopt),
        )
    except link.LinkError as exc:
        return _refusal(exc)


@rpc("geometry.apply")
def geometry_apply(
    project_id: str = "", project_dir: str = "", geometry_id: str = "", staging_rel: str = "", plan_file: str = "plan.json"
) -> dict[str, Any]:
    root = _root(project_id, project_dir)
    try:
        return link.apply(root, geometry_id, staging_rel, plan_file)
    except link.LinkError as exc:
        return _refusal(exc)


@rpc("geometry.forget_lost")
def geometry_forget_lost(
    project_id: str = "",
    project_dir: str = "",
    geometry_id: str = "",
    geometry_rev: Any = None,
    study_id: str = "",
    kind: str = "",
    id: str = "",
    mesh_id: str = "",
    run_id: str = "",
    entry: dict | None = None,
) -> dict[str, Any]:
    root = _root(project_id, project_dir)
    try:
        return link.forget_lost(
            root, geometry_id, geometry_rev, study_id or None, kind or None, id or None, mesh_id or None, run_id or None, entry
        )
    except link.LinkError as exc:
        return _refusal(exc)


@rpc("geometry.lost_list")
def geometry_lost_list(project_id: str = "", project_dir: str = "", geometry_id: str = "") -> dict[str, Any]:
    root = _root(project_id, project_dir)
    try:
        return link.lost_list(root, geometry_id)
    except link.LinkError as exc:
        return _refusal(exc)


@rpc("geometry.usage")
def geometry_usage(project_id: str = "", project_dir: str = "", geometry_id: str = "") -> dict[str, Any]:
    root = _root(project_id, project_dir)
    try:
        return link.usage(root, geometry_id, _known(), _catalog(), web_root())
    except link.LinkError as exc:
        return _refusal(exc)


@rpc("geometry.next_version")
def geometry_next_version(
    project_id: str = "",
    project_dir: str = "",
    plugin: str = "",
    study_id: str = "",
    base: str = "",
    adopt: bool = False,
    unique: bool = False,
) -> dict[str, Any]:
    root = _root(project_id, project_dir)
    # "Save as new" of an adoption sits beside the geometry it started from: from v2.
    # ``unique``: a removed geometry's study adds its part again; never a name another has.
    return {"ok": True, **link.next_version(root, plugin, study_id, str(base or "Geometry"), 2 if adopt else 1, unique=bool(unique))}


@rpc("geometry.link_commit")
def geometry_link_commit(
    project_id: str = "",
    project_dir: str = "",
    geometry_id: str = "",
    old_id: str = "",
    job_id: str = "",
    stop_after_commit_point: bool = False,
) -> dict[str, Any]:
    root = _root(project_id, project_dir)
    try:
        return link.link_commit(root, geometry_id, old_id or None, job_id, bool(stop_after_commit_point))
    except link.LinkError as exc:
        return _refusal(exc)


# ---- editing a project geometry (API 1.7) ----------------------------------------------


@rpc("geometry_actions.open")
def geometry_actions_open(project_id: str = "", geometry_id: str = "", plugin: str = "", study_kind: str = "") -> dict[str, Any]:
    from cfddesk.worker.methods import _plugin_study_catalog

    root = _root(project_id)
    studies, kinds = _plugin_study_catalog(root, str(project_id))
    manifest = load_all(web_root=web_root()).manifests.get(str(plugin))
    try:
        return ga.open_action(root, str(geometry_id), str(plugin), str(study_kind), studies, kinds, manifest)
    except ga.ActionError as exc:
        return exc.answer()


@rpc("geometry.edit_target")
def geometry_edit_target(project_id: str = "", plugin: str = "", study_id: str = "") -> dict[str, Any]:
    root = _root(project_id)
    target = ga.edit_target(root, str(plugin), str(study_id))
    return {"ok": True, "geometry": target["row"] if target else None}


@rpc("geometry.source_path")
def geometry_source_path(project_id: str = "", plugin: str = "", study_id: str = "") -> dict[str, Any]:
    root = _root(project_id)
    try:
        return ga.source_info(root, str(plugin), str(study_id))
    except ga.ActionError as exc:
        return exc.answer()


@rpc("geometry.faces_table")
def geometry_faces_table(project_id: str = "", plugin: str = "", study_id: str = "") -> dict[str, Any]:
    root = _root(project_id)
    try:
        return ga.faces_table(root, str(plugin), str(study_id), _schema_fields())
    except ga.ActionError as exc:
        return exc.answer()


@rpc("geometry.adopt_names")
def geometry_adopt_names(project_id: str = "", project_dir: str = "", geometry_id: str = "", staging_rel: str = "") -> dict[str, Any]:
    root = _root(project_id, project_dir)
    try:
        return ga.adopt_names(root, str(geometry_id), str(staging_rel))
    except link.LinkError as exc:
        return _refusal(exc)


@rpc("geometry.original_import")
def geometry_original_import(project_id: str = "", geometry_id: str = "") -> dict[str, Any]:
    root = _root(project_id)
    try:
        return ga.original_import(root, str(geometry_id))
    except ga.ActionError as exc:
        return exc.answer()


@rpc("geometry.barrier")
def geometry_barrier() -> dict[str, Any]:
    return {"ok": True}


@rpc("project.upsert_geometry")
def project_upsert_geometry(project_id: str = "", project_dir: str = "", record: dict | None = None) -> dict[str, Any]:
    root = _root(project_id, project_dir)
    try:
        return link.upsert_geometry(root, dict(record or {}))
    except link.LinkError as exc:
        return _refusal(exc)
