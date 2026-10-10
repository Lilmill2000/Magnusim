"""Linked geometries (host API 1.5): the link's own files and its main-lane calls.

A geometry made by a plugin's ``linkGeometry`` keeps, under ``<geometry>/link/``:

- ``state.json``: the one authoritative copy of the link (rev, the design's
  ``source_version``, the content hashes, bodies, name, ``job_id``). Only main-lane
  calls write it: :func:`apply` (the commit point of an update), :func:`record_source`
  (a link that changed nothing) and the create, whose staged folder carries it;
- ``last-update.json``: the last update that moved the rev (the report reads it);
- ``commit.json``: the journal, from an update's swap until its apply ends. A
  geometry with a journal no live job owns is *fenced* (proposal 5.17);
- ``removed.json``: written by a remove before the folder goes, so nothing brings it back.

The geometry's ``id.json`` carries ``source: {type, plugin, study_id, workspace,
linked_at}`` once, from the create. A link is found by ``(plugin, study_id)``.

Every function here takes the project folder; the RPCs are in
``cfddesk.worker.link_methods``. Three test switches, inert when unset, are read once
when this module loads: ``MAGNUSIM_TEST_LINK_FAIL_APPLY=1`` makes every apply fail,
``MAGNUSIM_TEST_APPLY_PAUSE=<file>`` holds an apply while that file exists, and
``MAGNUSIM_TEST_LINK_HOOKS=1`` lets a create's commit stop after its commit point.

Revision 7 adds two markers: ``pending.json`` (a new geometry, hidden until its
commit, :func:`link_commit`) and ``unlinked.json`` (an earlier version the link moved
away from after "Save as new"; a plain geometry to the user).

API 1.7 adds the *adoption*: a study that edits a plain project geometry
(``edits_geometry``, ``cfddesk.project.geometry_actions``) takes it over with its first
link. :func:`plan` (``adopt``) starts from rev 0 of the plain geometry; :func:`apply`
writes ``link/original/original.json``, then ``id.json``'s ``source`` (with
``adopted: true``), then ``state.json`` (with ``adopted``), the commit point as ever.
The link job keeps the geometry's source files in ``link/original/``.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from cfddesk.project.paths import find_geometry, walk_geometries, walk_meshes, walk_studies
from cfddesk.project.web_writes import atomic_write

LINK = "link"
STATE = "state.json"
JOURNAL = "commit.json"
LAST_UPDATE = "last-update.json"
REMOVED = "removed.json"
PENDING = "pending.json"
UNLINKED = "unlinked.json"
STAGING_ROOT = ".magnusim-staging"

_FAIL_APPLY = os.environ.get("MAGNUSIM_TEST_LINK_FAIL_APPLY", "").strip() == "1"
_APPLY_PAUSE = os.environ.get("MAGNUSIM_TEST_APPLY_PAUSE", "").strip()
# A create's commit may stop right after its commit point (gate:l2-choice), only when asked.
_STOP_AFTER_COMMIT_POINT = os.environ.get("MAGNUSIM_TEST_LINK_HOOKS", "").strip() == "1"


class LinkError(Exception):
    """A refusal a caller can act on: ``code`` is a 5.3 code or geometry_updating."""

    def __init__(self, code: str, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def test_hooks_active() -> dict[str, bool]:
    """Which test switches this process read (all False in production)."""
    return {"fail_apply": _FAIL_APPLY, "apply_pause": bool(_APPLY_PAUSE), "link_hooks": _STOP_AFTER_COMMIT_POINT}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def link_dir(geom_dir: Path | str) -> Path:
    return Path(geom_dir) / LINK


def read_state(geom_dir: Path | str) -> dict[str, Any] | None:
    doc = _read(link_dir(geom_dir) / STATE)
    return doc if isinstance(doc, dict) else None


def read_journal(geom_dir: Path | str) -> dict[str, Any] | None:
    doc = _read(link_dir(geom_dir) / JOURNAL)
    return doc if isinstance(doc, dict) else None


def has_journal(geom_dir: Path | str) -> bool:
    return (link_dir(geom_dir) / JOURNAL).is_file()


def _marked(geom_dir: Path | str, name: str) -> bool:
    return (link_dir(geom_dir) / name).is_file()


def _shape_exists(geom_dir: Path) -> bool:
    return (geom_dir / "source.bbrep").is_file() or (geom_dir / "source.step").is_file()


def source_of(geom: dict[str, Any]) -> dict[str, Any] | None:
    src = geom.get("source")
    if isinstance(src, dict) and src.get("type") == "plugin_study" and src.get("plugin") and src.get("study_id"):
        return src
    return None


def linked_geometries(project_dir: Path | str) -> list[dict[str, Any]]:
    """Folders a link made (linked or not), with their state: rev >= 1 and a shape."""
    out = []
    for geom in walk_geometries(Path(project_dir)):
        src = source_of(geom)
        if not src:
            continue
        gdir = Path(geom["dir"])
        state = read_state(gdir)
        if not state or int(state.get("rev") or 0) < 1 or not _shape_exists(gdir):
            continue
        if _marked(gdir, REMOVED) or _marked(gdir, PENDING):
            continue
        out.append({**geom, "source": src, "state": state, "unlinked": _marked(gdir, UNLINKED)})
    return out


def find_linked(project_dir: Path | str, plugin: str, study_id: str) -> dict[str, Any] | None:
    """The geometry linked to ``(plugin, study_id)``: newest ``source.linked_at`` wins."""
    hits = [
        g
        for g in linked_geometries(project_dir)
        if not g["unlinked"] and g["source"].get("plugin") == plugin and g["source"].get("study_id") == study_id
    ]
    if not hits:
        return None
    hits.sort(key=lambda g: str(g["source"].get("linked_at") or ""), reverse=True)
    return hits[0]


def is_desktop_format(project_dir: Path | str) -> bool:
    """A project.json in the desktop app's typed format (its set_* writers rebuild study files)."""
    from cfddesk.project.web_mirrors.ops import is_python_project_doc

    return is_python_project_doc(_read(Path(project_dir) / "project.json"))


def _geometry_dir(project_dir: Path | str, geometry_id: str) -> Path:
    geom = find_geometry(Path(project_dir), geometry_id)
    if not geom:
        raise LinkError("gone", "The geometry was removed.")
    gdir = Path(geom["dir"])
    if _marked(gdir, REMOVED):
        raise LinkError("gone", "The geometry was removed.")
    return gdir


def _staging(project_dir: Path | str, staging_rel: str) -> Path:
    rel = PurePosixPath(str(staging_rel or "").replace("\\", "/"))
    parts = rel.parts
    if len(parts) != 2 or parts[0] != STAGING_ROOT or not parts[1].startswith("link-") or ".." in parts:
        raise LinkError("bad_request", "not a link staging folder")
    path = Path(project_dir) / parts[0] / parts[1]
    if not path.is_dir():
        raise LinkError("failed", "The update's saved input is gone.")
    return path


# ---- the link call: nothing changed --------------------------------------------------


def record_source(project_dir: Path | str, geometry_id: str, source_version: int, synced_at: str | None = None) -> dict:
    """Record a link that changed nothing: the larger ``source_version`` and ``synced_at``.

    Refused (geometry_updating) while the geometry has a journal: its state then still
    holds the old rev and hashes while its files may be new (proposal 5.4 step 4).
    """
    gdir = _geometry_dir(project_dir, geometry_id)
    if has_journal(gdir):
        raise LinkError("geometry_updating", "The geometry is still updating.")
    state = read_state(gdir)
    if not state:
        raise LinkError("gone", "The geometry is not linked.")
    version = int(source_version)
    state["source_version"] = max(int(state.get("source_version") or 0), version)
    state["synced_at"] = synced_at or _now()
    atomic_write(link_dir(gdir) / STATE, state)
    return {"ok": True, "source_version": state["source_version"], "rev": int(state.get("rev") or 0)}


# ---- record kinds a loaded plugin must provide ------------------------------------------


def _json_rows(path: Path, key: str) -> list[dict[str, Any]]:
    doc = _read(path)
    rows = doc.get(key) if isinstance(doc, dict) else None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def _folder_records(parent: Path, json_name: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not parent.is_dir():
        return out
    for folder in sorted(p for p in parent.iterdir() if p.is_dir() and not p.name.startswith(".")):
        rec = _read(folder / json_name)
        if isinstance(rec, dict) and rec.get("id") is not None:
            out.append(rec)
    return out


def _merged(folder_rows: list[dict[str, Any]], legacy: list[dict[str, Any]]) -> list[dict[str, Any]]:
    have = {str(r.get("id")) for r in folder_rows}
    return folder_rows + [r for r in legacy if str(r.get("id")) not in have]


def _bc_key(rec: dict[str, Any]) -> str:
    """The BC kind a record is: its ``registry_key``, else the variant its family resolves to.

    The BC panel saves a record of a family (``bc_type`` = the family's record_type, its
    fields at the top level, no registry_key). A ``bc_type`` that names no loaded family
    is reported as itself, so a family whose plugin is off or not installed is an unknown
    kind (plugin_needed), never read as a core wall. A record with no ``bc_type`` at all
    reads as a no-slip wall, as the case writer reads it.
    """
    key = rec.get("registry_key") or (rec.get("settings") or {}).get("registry_key")
    if key:
        return str(key)
    from cfddesk.project.web_adapter import bc_family_for, web_bc_to_registry

    raw = str(rec.get("bc_type") or rec.get("type") or "").strip()
    if not raw:
        return "wall_noslip"
    fam = bc_family_for(raw) or bc_family_for(raw.replace("_", " "))
    if fam is None:
        return raw
    try:
        return web_bc_to_registry({**rec, "bc_type": fam.record_type})[0]
    except Exception:
        variants = tuple(getattr(fam, "variants", ()) or ())
        return str(variants[0]) if variants else raw


def _alias_text(raw: Any) -> str:
    return "".join(str(raw or "").split()).lower()


def monitor_key(kind: Any, web_root: Path | None = None) -> str:
    """The monitor registry key a result control's ``kind`` names.

    Core monitors save their label (``kind: 'Area average'``); a monitor's ``aliases``
    list the names it is stored under. The loaded registry decides first; with its plugin
    off, the committed registry dump (``web_root``) still names the key, so the owner is
    known. A kind no monitor lists is its own key (an unknown kind).
    """
    raw = str(kind or "").strip()
    if not raw:
        return ""
    want = _alias_text(raw)
    try:
        from cfddesk.registry.discovery import get_hub

        specs = list(get_hub().registry("monitor").items())
    except Exception:
        specs = []
    for spec in specs:
        if str(getattr(spec, "key", "")) == raw:
            return raw
    for spec in specs:
        names = (getattr(spec, "key", ""), getattr(spec, "label", ""), *(getattr(spec, "aliases", ()) or ()))
        if any(_alias_text(n) == want for n in names if n):
            return str(spec.key)
    if web_root is not None:
        doc = _generated_registry(web_root)
        for row in (doc.get("monitor") or []) if isinstance(doc, dict) else []:
            if not isinstance(row, dict) or not row.get("key"):
                continue
            names = (row.get("key"), row.get("label"), *(row.get("aliases") or []))
            if any(_alias_text(n) == want for n in names if n):
                return str(row["key"])
    return raw


def _mesher_key(rec: dict[str, Any]) -> str:
    raw = rec.get("settings")
    settings: dict[str, Any] = raw if isinstance(raw, dict) else {}
    raw_adv = settings.get("advanced")
    advanced: dict[str, Any] = raw_adv if isinstance(raw_adv, dict) else {}
    return str(rec.get("mesher") or settings.get("mesher") or advanced.get("mesh_engine") or "")


def study_records(project_dir: Path | str, study: dict[str, Any], web_root: Path | None = None) -> list[tuple[str, str, dict[str, Any]]]:
    """``(kind, registry key, record)`` for each BC, result control and mesh doc of a study.

    Result controls are the study's and those of each run the rewrite updates (every run
    but a finished one: it can still start, and its monitors are written into its case).
    """
    from cfddesk.project.link_rewrite import run_is_setup
    from cfddesk.project.paths import walk_runs

    root = Path(project_dir)
    sdir = Path(study["dir"])
    sid = str(study.get("id") or "")
    out: list[tuple[str, str, dict[str, Any]]] = []
    bcs = _merged(_folder_records(sdir / "boundary_conditions", "bc.json"), _json_rows(sdir / "boundary_conditions.json", "boundary_conditions"))
    for rec in bcs:
        out.append(("bc", _bc_key(rec), rec))
    rcs = _merged(_folder_records(sdir / "result_controls", "result_control.json"), _json_rows(sdir / "result_controls.json", "result_controls"))
    for rec in rcs:
        if rec.get("kind"):
            out.append(("result_control", monitor_key(rec["kind"], web_root), rec))
    for mesh in walk_meshes(root, sid):
        key = _mesher_key(mesh)
        if key:
            out.append(("mesh_doc", key, mesh))
    for run in walk_runs(root, sid):
        if not run_is_setup(run.get("status")):
            continue
        rows = _merged(_folder_records(Path(run["dir"]) / "result_controls", "result_control.json"), [r for r in run.get("result_controls") or [] if isinstance(r, dict)])
        for rec in rows:
            if rec.get("kind"):
                out.append(("run_result_control", monitor_key(rec["kind"], web_root), rec))
    return out


_REGISTRY_OF = {"bc": "bc", "result_control": "monitor", "run_result_control": "monitor", "mesh_doc": "mesher"}


def _generated_registry(web_root: Path | None) -> Any:
    """The generated registry of the bundled plugins (keys to their plugin with the plugin off).

    It is the committed ``scripts/generated/registry.json``. A bundled folder that
    ``MAGNUSIM_BUNDLED_DIR`` puts in place of the app's (tests) carries its own as
    ``registry.json``.
    """
    override = (os.environ.get("MAGNUSIM_BUNDLED_DIR") or "").strip()
    if override and (Path(override) / "registry.json").is_file():
        return _read(Path(override) / "registry.json")
    if web_root is None:
        return None
    return _read(Path(web_root) / "scripts" / "generated" / "registry.json")


def _generated_owners(web_root: Path | None) -> tuple[dict[tuple[str, str], str], dict[str, str]]:
    """Owner plugin of each registered key in the generated registry, and plugin names."""
    owners: dict[tuple[str, str], str] = {}
    names: dict[str, str] = {}
    doc = _generated_registry(web_root)
    if not isinstance(doc, dict):
        return owners, names
    for reg in set(_REGISTRY_OF.values()):
        for row in doc.get(reg) or []:
            if isinstance(row, dict) and row.get("key") and row.get("plugin"):
                owners[(reg, str(row["key"]))] = str(row["plugin"])
    # A BC family's record_type (and its aliases) is the kind of a record of that family
    # while its plugin is off (_bc_key): its owner is the family's plugin.
    for row in doc.get("bc_family") or []:
        if isinstance(row, dict) and row.get("plugin"):
            for name in (row.get("record_type"), *(row.get("aliases") or [])):
                if name:
                    owners.setdefault(("bc", str(name)), str(row["plugin"]))
    for row in doc.get("plugins") or []:
        if isinstance(row, dict) and row.get("key"):
            names[str(row["key"])] = str(row.get("name") or row["key"])
    return owners, names


def check_kinds(
    project_dir: Path | str,
    geometry_id: str,
    known: dict[str, set[str]],
    catalog: list[dict[str, Any]] | None = None,
    web_root: Path | None = None,
    studies: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Record kinds of the geometry's studies that no loaded plugin provides (5.13).

    ``known`` maps a registry name (bc, monitor, mesher) to its loaded keys. Each entry:
    ``{key, kind, owner, owner_name, bundled_off, records: [{study_id, study, id, name}]}``.
    ``bundled_off`` is True only when the committed registry names a bundled owner and the
    catalog lists it as off: then turning it on is the fix.
    """
    owners, names = _generated_owners(web_root)
    rows = {str(r.get("key")): r for r in (catalog or []) if isinstance(r, dict)}
    unknown: dict[tuple[str, str], dict[str, Any]] = {}
    for study in walk_studies(Path(project_dir), geometry_id):
        if studies is not None and str(study.get("id") or "") not in studies:
            continue
        title = str(study.get("name") or study.get("id") or "Study")
        for kind, key, rec in study_records(project_dir, study, web_root):
            reg = _REGISTRY_OF[kind]
            if key in known.get(reg, set()):
                continue
            entry = unknown.get((kind, key))
            if entry is None:
                owner = owners.get((reg, key))
                row = rows.get(owner or "") or {}
                entry = {
                    "key": key,
                    "kind": kind,
                    "owner": owner,
                    "owner_name": str(row.get("name") or names.get(owner or "") or owner or ""),
                    "bundled_off": bool(owner)
                    and str(row.get("source") or row.get("tier") or "") == "bundled"
                    and str(row.get("status") or "") == "disabled",
                    "records": [],
                }
                unknown[(kind, key)] = entry
            entry["records"].append(
                {"study_id": str(study.get("id") or ""), "study": title, "id": rec.get("id"), "name": str(rec.get("name") or rec.get("id") or "")}
            )
    return list(unknown.values())


# ---- the commit: plan, then apply -------------------------------------------------------


def plan(
    project_dir: Path | str,
    geometry_id: str,
    staging_rel: str,
    from_rev: int,
    same_shape: bool,
    studies: list[str] | None = None,
    rev: int | None = None,
    known: dict[str, set[str]] | None = None,
    catalog: list[dict[str, Any]] | None = None,
    web_root: Path | None = None,
    schema_fields: dict[str, dict[str, list[tuple[str, str]]]] | None = None,
    map_from: str | None = None,
    adopt: bool = False,
) -> dict[str, Any]:
    """Work out the update and write ``<staging>/plan.json``; nothing else is written.

    The change is ``shape`` (the shape changed); with the same shape it is ``faces``
    when a lost face comes back by name (the rev goes up), else ``names`` (the rev is
    kept and no record changes). Every face- or body-carrying record of the
    geometry's studies, and every copy of it, gets one patch per copy
    (``cfddesk.project.link_rewrite``). Refuses ``plugin_needed`` when a record kind
    is unknown. With ``studies`` (a save-as-new copy) only those studies are planned,
    stamped ``rev``, into ``plan-copy.json``; ``map_from`` names the geometry their
    labels were drawn on (the old one), whose face table the map starts from. The name
    follows the job's (the study title) with the geometry's " v<version>" suffix.

    ``adopt`` (API 1.7): the first link of a study that edits this plain geometry. It
    starts from rev 0 (the import as it is), keeps the geometry's name, and the map starts
    from ``<staging>/old_named.json`` (the face table with the page's original names).
    """
    from cfddesk.project import geometry_actions as ga
    from cfddesk.project.link_rewrite import build_plan

    gdir = _geometry_dir(project_dir, geometry_id)
    stage = _staging(project_dir, staging_rel)
    state = read_state(gdir)
    if adopt:
        if state:
            raise LinkError("stale", "The geometry was taken over by another study meanwhile.")
        geom = find_geometry(Path(project_dir), geometry_id) or {}
        row = ga.project_rows(Path(project_dir)).get(str(geometry_id))
        state = ga.adopt_state({**geom, "dir": gdir}, row)
        if not (stage / ga.OLD_NAMED).is_file():
            raise LinkError("failed", "The update has no face table of the original.")
    if not state:
        raise LinkError("gone", "The geometry is not linked.")
    # A save-as-new copy maps from the old geometry's live face table (its records are
    # still drawn on it), onto the new one's staged table.
    map_dir, map_state = gdir, state
    if map_from and str(map_from) != str(geometry_id):
        map_dir = _geometry_dir(project_dir, str(map_from))
        map_state = read_state(map_dir) or {}
    if studies is None and int(state.get("rev") or 0) != int(from_rev):
        raise LinkError("stale", "The geometry changed since this update was planned.")
    # An overwrite needs the geometry still linked: after "Save as new" the old one is kept
    # as it was (proposal 5.0), whatever update was queued for it before.
    if studies is None and not adopt and _marked(gdir, UNLINKED):
        raise LinkError("unlinked", "The geometry is no longer linked to its study.")
    if known is not None:
        missing = check_kinds(project_dir, geometry_id, known, catalog, web_root, studies)
        if missing:
            raise LinkError("plugin_needed", "Some records come from a plugin that is not loaded.", missing)
    job = _read(stage / "job.json") or {}
    preview = _read(stage / "preview.json") or {}
    if not preview.get("ok"):
        raise LinkError("failed", "The update has no preview.")
    built = build_plan(
        Path(project_dir), geometry_id, map_dir, stage, map_state, int(from_rev), bool(same_shape), schema_fields or {}, studies, rev
    )
    change = built["change"]
    new_rev = int(built["rev"])
    base = str(job.get("name") or "").strip()
    # An adopted geometry keeps its own name, at its adoption and at every later update.
    keeps = adopt or isinstance(state.get("adopted"), dict)
    name = str(state.get("name") or "") if keeps else versioned_name(base, state.get("version")) if base else str(state.get("name") or "")
    new_state = {
        **{k: v for k, v in state.items() if k not in ("adopt", "source_ready")},
        "rev": new_rev,
        "source_version": max(int(state.get("source_version") or 0), int(job.get("source_version") or 0)),
        "name": name,
        "shape_sha256": job.get("shape_sha256"),
        "names_file_sha256": job.get("names_file_sha256"),
        "names_sha256": preview.get("names_sha256"),
        "n_solids": preview.get("n_solids"),
        "n_faces": preview.get("n_faces"),
        "bounds": preview.get("bounds"),
        "bodies": preview.get("bodies") or [],
        "synced_at": _now(),
        "job_id": str(job.get("job") or ""),
    }
    adopt_doc = None
    if adopt:
        geom = find_geometry(Path(project_dir), geometry_id) or {}
        row = ga.project_rows(Path(project_dir)).get(str(geometry_id))
        at = _now()
        new_state["adopted"] = {
            "at": at,
            "from": {
                "format": ga.geometry_format({**geom, "dir": gdir}, row),
                "file_name": ga.original_filename(geom, row),
                "sha256": state.get("shape_sha256") or None,
                "faces": state.get("n_faces"),
                "bodies": state.get("n_solids"),
            },
        }
        adopt_doc = {
            "plugin": str(job.get("plugin") or ""),
            "study_id": str(job.get("study_id") or ""),
            "workspace": str(job.get("workspace") or ""),
            "linked_at": at,
        }
    report = {"change": change, **built["report"]}
    fmap = _read(stage / "map.json") or {}
    doc = {
        "job": str(job.get("job") or ""),
        "from_rev": int(from_rev),
        "rev": new_rev,
        "change": change,
        "source_version": new_state["source_version"],
        "patches": built["patches"],
        "report": report,
        "state": new_state,
        "map": {"faces": fmap.get("faces") or {}, "body_map": fmap.get("body_map") or {}, "identity": bool(fmap.get("identity"))},
        "adopt": adopt_doc,
    }
    atomic_write(stage / ("plan-copy.json" if studies is not None else "plan.json"), doc)
    return {
        "ok": True,
        "change": change,
        "rev": new_rev,
        "from_rev": int(from_rev),
        "report": report,
        "patches": len(built["patches"]),
    }


def _pause_if_asked() -> None:
    if not _APPLY_PAUSE:
        return
    while Path(_APPLY_PAUSE).exists():
        time.sleep(0.05)


def apply(project_dir: Path | str, geometry_id: str, staging_rel: str, plan_file: str = "plan.json") -> dict[str, Any]:
    """Apply ``<staging>/plan.json``, then write ``last-update.json`` and ``state.json``.

    Writing ``state.json`` (with the plan's job id) is the commit point. Applying the
    same plan twice gives the same files (a recovery replays it).
    """
    if _FAIL_APPLY:
        raise LinkError("failed", "test switch: every apply fails in this process")
    if plan_file not in ("plan.json", "plan-copy.json"):
        raise LinkError("bad_request", "unknown plan file")
    gdir = _geometry_dir(project_dir, geometry_id)
    stage = _staging(project_dir, staging_rel)
    doc = _read(stage / plan_file)
    if not isinstance(doc, dict):
        raise LinkError("failed", "The update's plan is gone.")
    patched, skipped = _apply_patches(Path(project_dir), [p for p in doc.get("patches") or [] if isinstance(p, dict)])
    if plan_file == "plan-copy.json":
        return {"ok": True, "patched": patched, "skipped": skipped}
    ldir = link_dir(gdir)
    if not ldir.is_dir():
        raise LinkError("gone", "The geometry was removed.")
    adopt = doc.get("adopt")
    if isinstance(adopt, dict):
        _apply_adoption(gdir, doc, adopt)
    if doc.get("change") != "names":
        fmap = doc.get("map") or {}
        atomic_write(
            ldir / LAST_UPDATE,
            {
                "rev": doc.get("rev"),
                "from_rev": doc.get("from_rev"),
                "map": fmap.get("faces") or {},
                "body_map": fmap.get("body_map") or {},
                "report": doc.get("report") or {},
            },
        )
    atomic_write(ldir / STATE, doc["state"])
    return {"ok": True, "rev": doc.get("rev"), "change": doc.get("change"), "patched": patched, "skipped": skipped}


def _apply_adoption(gdir: Path, doc: dict[str, Any], adopt: dict[str, Any]) -> None:
    """An adoption's own files before the commit point: what the original was, then the link
    in ``id.json`` (``state.json``, written last by :func:`apply`, makes it a linked geometry).
    Writing them twice gives the same files (a recovery replays the apply)."""
    from cfddesk.project import geometry_actions as ga

    state = doc.get("state") or {}
    adopted: dict[str, Any] = state["adopted"] if isinstance(state.get("adopted"), dict) else {}
    frm = adopted.get("from") or {}
    if (ga.original_dir(gdir) / "source.step").is_file() and ga.read_original(gdir) is None:
        ga.write_original(gdir, adopted, frm.get("faces"), frm.get("bodies"))
    ident = _read(gdir / "id.json")
    ident = ident if isinstance(ident, dict) else {}
    ident["source"] = {
        "type": "plugin_study",
        "plugin": str(adopt.get("plugin") or ""),
        "study_id": str(adopt.get("study_id") or ""),
        "workspace": str(adopt.get("workspace") or ""),
        "linked_at": str(adopt.get("linked_at") or _now()),
        "adopted": True,
    }
    atomic_write(gdir / "id.json", ident)


def _apply_patches(root: Path, patches: list[dict[str, Any]]) -> tuple[int, int]:
    """Write each patch where its ids lead now. A record gone since the plan is skipped.

    Every patch is resolved first (each lookup made once), then each file is read once,
    given all its patches, and written once. A write that fails is resolved again and
    retried, up to three times; one that still fails (its record can still be found)
    raises, so the commit point is never written while a record is on old labels.
    """
    from cfddesk.project.link_rewrite import Finder, patch_write, resolve

    pending = list(range(len(patches)))
    wrote_any: dict[int, bool] = {}
    for attempt in range(4):
        finder = Finder(root)
        by_file: dict[Path, list[tuple[int, Any]]] = {}
        for i in pending:
            targets = resolve(root, patches[i], finder)
            if not targets:
                wrote_any.setdefault(i, False)
            for path, change in targets:
                by_file.setdefault(path, []).append((i, change))
        _pause_if_asked()
        failed: set[int] = set()
        last: OSError | None = None
        for path, changes in by_file.items():

            def change_all(doc: dict[str, Any], cs: list[tuple[int, Any]] = changes) -> bool:
                return any([c(doc) for _i, c in cs])

            try:
                hit = patch_write(path, change_all)
            except OSError as exc:
                last = exc
                failed.update(i for i, _c in changes)
                continue
            for i, _c in changes:
                wrote_any[i] = wrote_any.get(i, False) or hit
        if not failed:
            break
        if attempt == 3:
            assert last is not None
            raise LinkError("failed", f"A record could not be written ({type(last).__name__}).") from last
        pending = sorted(failed)
        time.sleep(0.1 * (attempt + 1))
    patched = sum(1 for v in wrote_any.values() if v)
    return patched, len(patches) - patched


# ---- project.json --------------------------------------------------------------------


def _body_refs(state: dict[str, Any], n_solids: Any = None) -> list[str]:
    """A linked geometry's body refs ("Body1", ...): the state's, else one per solid."""
    refs = [str(b.get("ref")) for b in (state.get("bodies") or []) if isinstance(b, dict) and b.get("ref")]
    try:
        n = max(1, int(n_solids if n_solids is not None else state.get("n_solids") or 1))
    except (TypeError, ValueError):
        n = 1
    return refs or [f"Body{i}" for i in range(1, n + 1)]


def geometry_record(project_id: str, geom: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """The project.json record of a linked geometry (its part row), from its own files."""
    gdir = Path(geom["dir"])
    src = source_of(geom) or {}
    adopted = state.get("adopted") if isinstance(state.get("adopted"), dict) else None
    frm = (adopted or {}).get("from") or {}
    return {
        "id": str(geom["id"]),
        "name": str(state.get("name") or geom.get("name") or ""),
        # An adopted geometry keeps the name of the file it was imported from (API 1.7).
        "original_filename": (frm.get("file_name") or geom.get("original_filename")) if adopted else None,
        "original_path": None,
        "source_kind": "plugin",
        "length_unit": None,
        "representation": "step",
        "tessellated": False,
        "watertight": True,
        "step_path": str(gdir / "source.step"),
        "n_solids": int(state.get("n_solids") or 1),
        "n_faces": state.get("n_faces"),
        "body_offset": 0,
        "imported_at": src.get("linked_at") or state.get("synced_at"),
        "note": "Edited in a plugin study." if adopted else "Linked from a plugin study.",
        "source": src or None,
    }


def _shown_record(project_id: str, row: dict[str, Any], state: dict[str, Any] | None) -> dict[str, Any]:
    """The active ``geometry`` record the page draws, for a linked part (no regeneration)."""
    gid = str(row["id"])
    q = f"project_id={project_id}&geometry_id={gid}"
    bodies = _body_refs(state or {}, row.get("n_solids"))
    return {
        **row,
        "bodies": bodies,
        "volume": bodies[0],
        "step_source": "link",
        "faces_url": f"/api/geometry/cad?{q}&part=faces",
        "edges_url": f"/api/geometry/cad?{q}&part=edges",
        "stl_path": None,
        "stl_url": None,
        "fingerprint": {
            "empty": False,
            "n_faces": row.get("n_faces"),
            "n_solids": row.get("n_solids"),
            "bounds": (state or {}).get("bounds"),
            "representation": "step",
            "watertight": True,
        },
        "modifiers": [],
    }


def _put_record(proj: dict[str, Any], record: dict[str, Any], state: dict[str, Any] | None, project_id: str) -> bool:
    """Add or refresh the record in proj (in memory). True when it was added.

    In a project that shows no geometry at all (no ``geometry``, no active id), the
    linked geometry becomes the shown one, as a first import does there. A project
    that shows a geometry keeps it: the link never changes what the user looks at.
    """
    gid = str(record["id"])
    # The tree's body rows, as an import's part row carries them (one per solid).
    record = {**record, "assembly_bodies": _body_refs(state or {}, record.get("n_solids"))}
    raw = proj.get("geometries")
    rows: list[Any] = raw if isinstance(raw, list) else []
    out: list[Any] = []
    found = False
    for row in rows:
        if isinstance(row, dict) and str(row.get("id")) == gid:
            out.append({**row, **record})
            found = True
        else:
            out.append(row)
    if not found:
        out.append(dict(record))
    proj["geometries"] = out
    shown = proj.get("geometry") if isinstance(proj.get("geometry"), dict) else None
    if shown is None and not proj.get("active_geometry_id"):
        merged = next(r for r in out if isinstance(r, dict) and str(r.get("id")) == gid)
        proj["geometry"] = _shown_record(project_id, merged, state)
        proj["active_geometry_id"] = gid
    elif shown is not None and str(shown.get("id")) == gid and record.get("name"):
        shown["name"] = record["name"]
    return not found


def upsert_geometry(project_dir: Path | str, record: dict[str, Any]) -> dict[str, Any]:
    """Add or refresh one geometry record in ``project.json``.

    A geometry whose folder is gone, or marked removed or pending, is never added back.
    The active geometry changes only in a project that shows none (see _put_record).
    """
    root = Path(project_dir)
    gid = str((record or {}).get("id") or "").strip()
    if not gid:
        raise LinkError("bad_request", "record.id required")
    geom = find_geometry(root, gid)
    if not geom or _marked(geom["dir"], REMOVED) or _marked(geom["dir"], PENDING):
        return {"ok": True, "skipped": "gone"}
    path = root / "project.json"
    proj = _read(path)
    if not isinstance(proj, dict):
        raise LinkError("project_not_found", "project.json is missing")
    added = _put_record(proj, dict(record), read_state(geom["dir"]), root.name)
    atomic_write(path, proj)
    return {"ok": True, "added": added}


def repair_project(project_dir: Path | str) -> list[str]:
    """Repair on read (5.10): add back every linked geometry project.json lost.

    Runs on the main lane before a hydrate. Returns the ids it added.
    """
    root = Path(project_dir)
    mark_older_unlinked(root)
    folders = linked_geometries(root)
    if not folders:
        return []
    path = root / "project.json"
    proj = _read(path)
    if not isinstance(proj, dict) or is_desktop_format(root):
        return []
    have = {str(r.get("id")) for r in (proj.get("geometries") or []) if isinstance(r, dict)}
    added = []
    for geom in folders:
        if str(geom["id"]) in have:
            continue
        _put_record(proj, geometry_record(root.name, geom, geom["state"]), geom["state"], root.name)
        added.append(str(geom["id"]))
    if added:
        atomic_write(path, proj)
    return added


# ---- the host's question and "Save as new" (proposal 5.0) ------------------------------------


def versioned_name(base: str, version: Any) -> str:
    """A linked geometry's name: the study title (or the call's name), with " v<k>" from version 2."""
    try:
        k = int(version or 1)
    except (TypeError, ValueError):
        k = 1
    return f"{base} v{k}" if k >= 2 else base


def _geometry_names(root: Path) -> set[str]:
    """Every geometry name the project shows (folders, link states, project.json), folded."""
    names: set[str] = set()
    for geom in walk_geometries(root):
        gdir = Path(geom["dir"])
        if _marked(gdir, REMOVED) or _marked(gdir, PENDING):
            continue
        for n in (geom.get("name"), (read_state(gdir) or {}).get("name")):
            if n:
                names.add(str(n).casefold())
    proj = _read(root / "project.json")
    for row in (proj.get("geometries") or []) if isinstance(proj, dict) else []:
        if isinstance(row, dict) and row.get("name"):
            names.add(str(row["name"]).casefold())
    return names


def next_version(project_dir: Path | str, plugin: str, study_id: str, base: str, at_least: int = 1) -> dict[str, Any]:
    """The version and name of the next geometry a study's link makes.

    1 + the highest ``version`` among the folders this ``(plugin, study_id)`` made, linked
    or kept unlinked (a removed or pending one does not count); the bare base when none is
    left. From 2 the name is "<base> v<k>", and k goes up while another geometry of the
    project has that name. ``at_least`` 2 (the "Save as new" of an adoption, API 1.7)
    starts at v2: the geometry it was made from keeps the bare name.
    """
    root = Path(project_dir)
    versions: list[int] = []
    for geom in walk_geometries(root):
        src = source_of(geom)
        if not src or src.get("plugin") != plugin or src.get("study_id") != study_id:
            continue
        gdir = Path(geom["dir"])
        if _marked(gdir, REMOVED) or _marked(gdir, PENDING):
            continue
        try:
            versions.append(int((read_state(gdir) or {}).get("version") or 1))
        except (TypeError, ValueError):
            versions.append(1)
    k = max(max(versions) + 1 if versions else 1, int(at_least or 1))
    if k == 1:
        return {"version": 1, "name": base}
    taken = _geometry_names(root)
    while versioned_name(base, k).casefold() in taken:
        k += 1
    return {"version": k, "name": versioned_name(base, k)}


def _setup_kinds(root: Path, study: dict[str, Any]) -> list[str]:
    """What saved setup a simulation study has: records, a generated mesh, a run that is not a draft.

    A study made and left with its defaults (empty lists) has none.
    """
    from cfddesk.project.link_rewrite import DRAFT_RUN, _aggregate_rows

    sdir = Path(study["dir"])
    sid = str(study.get("id") or "")
    out: list[str] = []
    if _merged(_folder_records(sdir / "boundary_conditions", "bc.json"), _json_rows(sdir / "boundary_conditions.json", "boundary_conditions")):
        out.append("bc")
    if _merged(_folder_records(sdir / "materials", "material.json"), _json_rows(sdir / "materials.json", "materials")):
        out.append("material")
    rcs = _merged(_folder_records(sdir / "result_controls", "result_control.json"), _json_rows(sdir / "result_controls.json", "result_controls"))
    rc_doc = _read(sdir / "result_controls.json")
    if rcs or (isinstance(rc_doc, dict) and rc_doc.get("area_average_1")) or _aggregate_rows(sdir / "area_average.json", "result_control"):
        out.append("result_control")
    meshes = walk_meshes(root, sid)
    refs = bool(_json_rows(sdir / "mesh_refinements.json", "refinements"))
    for mesh in meshes:
        mdir = Path(mesh["dir"])
        if _folder_records(mdir / "refinements", "refinement.json") or _json_rows(mdir / "refinements.json", "refinements"):
            refs = True
    if refs:
        out.append("refinement")
    if any(m.get("generated") for m in meshes):
        out.append("mesh")
    from cfddesk.project.paths import walk_runs

    if any(str(r.get("status") or "") not in DRAFT_RUN for r in walk_runs(root, sid)):
        out.append("run")
    return out


def usage(
    project_dir: Path | str,
    geometry_id: str,
    known: dict[str, set[str]],
    catalog: list[dict[str, Any]] | None = None,
    web_root: Path | None = None,
) -> dict[str, Any]:
    """Whether a shape change must ask (5.0): the simulation studies on the geometry with saved setup.

    Each study: ``{id, title, setup, unknown}`` (``unknown``: its record kinds no loaded
    plugin provides, so its setup cannot be copied). ``unknown`` over every study blocks
    an overwrite (``plugin_needed``). ``last`` is the study the geometry showed last: the
    project's active study when it is one of them, else the first.
    """
    root = Path(project_dir)
    gdir = _geometry_dir(root, geometry_id)
    studies = []
    for study in walk_studies(root, geometry_id):
        kinds = _setup_kinds(root, study)
        if not kinds:
            continue
        sid = str(study.get("id") or "")
        studies.append(
            {
                "id": sid,
                "title": str(study.get("name") or sid or "Study"),
                "setup": kinds,
                "unknown": check_kinds(root, geometry_id, known, catalog, web_root, [sid]),
            }
        )
    catalog_doc = _read(root / "simulations.json")
    active = str((catalog_doc or {}).get("active_id") or "") if isinstance(catalog_doc, dict) else ""
    ids = [s["id"] for s in studies]
    return {
        "ok": True,
        "studies": studies,
        "unknown": check_kinds(root, geometry_id, known, catalog, web_root) if studies else [],
        "last": active if active in ids else (ids[0] if ids else None),
        "journal": has_journal(gdir),
    }


def link_commit(
    project_dir: Path | str,
    geometry_id: str,
    old_id: str | None,
    job_id: str,
    stop_after_commit_point: bool = False,
) -> dict[str, Any]:
    """A new linked geometry's commit (a first link or "Save as new"), on the main lane.

    Removes the folder's ``link/pending.json`` (the commit point: from here the lookup,
    the tree and the repair see it), then marks the old geometry ``link/unlinked.json``
    (the link moved), then refreshes ``project.json``. Safe to repeat. With
    MAGNUSIM_TEST_LINK_HOOKS=1 in this process, ``stop_after_commit_point`` stops right
    after the commit point (a crash there, for the tests); inert otherwise.
    """
    root = Path(project_dir)
    geom = find_geometry(root, geometry_id)
    if not geom or _marked(geom["dir"], REMOVED):
        raise LinkError("gone", "The new geometry's folder is gone.")
    gdir = Path(geom["dir"])
    pending = _read(link_dir(gdir) / PENDING)
    if isinstance(pending, dict) and pending.get("job_id") and str(pending["job_id"]) != str(job_id):
        raise LinkError("failed", "Another job is making this geometry.")
    state = read_state(gdir)
    if not state:
        raise LinkError("failed", "The new geometry has no link state.")
    try:
        (link_dir(gdir) / PENDING).unlink()
    except FileNotFoundError:
        pass
    if stop_after_commit_point and _STOP_AFTER_COMMIT_POINT:
        raise LinkError("failed", "test hook: stopped after the commit point")
    if old_id and str(old_id) != str(geometry_id):
        old = find_geometry(root, str(old_id))
        # Only a geometry a link made: a plain one (the original of an adoption's "Save as
        # new", API 1.7) stays plain, whatever its link/ folder holds.
        if old and not _marked(old["dir"], REMOVED) and not _marked(old["dir"], UNLINKED) and (link_dir(old["dir"]) / STATE).is_file():
            atomic_write(link_dir(old["dir"]) / UNLINKED, {"moved_to": str(geometry_id), "job_id": str(job_id), "at": _now()})
    upsert_geometry(root, geometry_record(root.name, geom, state))
    return {"ok": True, "geometry_id": str(geometry_id), "name": str(state.get("name") or "")}


def mark_older_unlinked(project_dir: Path | str) -> list[str]:
    """The repair (5.10): two folders link one study (a crash inside link_commit): the one
    with the newest ``source.linked_at`` stays linked; the others get ``link/unlinked.json``.
    Returns the ids it marked.
    """
    root = Path(project_dir)
    by_study: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for g in linked_geometries(root):
        if g["unlinked"]:
            continue
        by_study.setdefault((str(g["source"].get("plugin")), str(g["source"].get("study_id"))), []).append(g)
    marked: list[str] = []
    for group in by_study.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda g: str(g["source"].get("linked_at") or ""), reverse=True)
        newest = group[0]
        for g in group[1:]:
            atomic_write(
                link_dir(g["dir"]) / UNLINKED,
                {"moved_to": str(newest["id"]), "job_id": str((newest["state"] or {}).get("job_id") or ""), "at": _now(), "repair": True},
            )
            marked.append(str(g["id"]))
    return marked


# ---- saves of face-carrying records: the stamp check (proposal 5.16) -------------------


def study_link_state(project_dir: Path | str, sim_id: str | None) -> tuple[Path, dict[str, Any], str] | None:
    """The link state of a study's geometry: (geometry folder, state, name), or None.

    A geometry a link made keeps ``link/state.json`` (linked, or an earlier version kept
    unlinked); its studies' face-carrying records carry ``geometry_rev`` stamps.
    """
    from cfddesk.project.paths import find_study

    study = find_study(Path(project_dir), sim_id) if sim_id else None
    if not study:
        return None
    gdir = Path(study["geometry_dir"])
    state = read_state(gdir)
    if not state or int(state.get("rev") or 0) < 1:
        return None
    return gdir, state, str(state.get("name") or study.get("geometry_id") or "the geometry")


def updating_message(name: str) -> str:
    return f"Updating {name}. Try again in a moment."


def changed_message(name: str) -> str:
    return f"{name} was updated. This change was not saved."


def check_save(
    project_dir: Path | str,
    sim_id: str | None,
    records: list[Any],
    geometry_rev: Any = None,
) -> int | None:
    """The rev a save of face-carrying records may be stamped with, or a refusal.

    None for a study whose geometry no link made (no check). While the geometry has a
    commit journal (fenced) the save is refused ``geometry_updating``. Otherwise the
    stamp the save carries must be the geometry's rev, else ``geometry_changed``: the
    ``geometry_rev`` a checked caller (the app server) passes, else each record's own.
    """
    found = study_link_state(project_dir, sim_id)
    if found is None:
        return None
    gdir, state, name = found
    if has_journal(gdir):
        raise LinkError("geometry_updating", updating_message(name))
    rev = int(state.get("rev") or 0)
    if geometry_rev is not None and geometry_rev != "":
        try:
            ok = int(geometry_rev) == rev
        except (TypeError, ValueError):
            ok = False
        if not ok:
            raise LinkError("geometry_changed", changed_message(name))
        return rev
    for rec in records:
        if not isinstance(rec, dict):
            continue
        stamp = rec.get("geometry_rev")
        if isinstance(stamp, bool) or not isinstance(stamp, int) or stamp != rev:
            raise LinkError("geometry_changed", changed_message(name))
    return rev


# ---- Forget (proposal 5.14) -----------------------------------------------------------------


def forget_lost(
    project_dir: Path | str,
    geometry_id: str,
    geometry_rev: Any,
    study_id: str | None = None,
    kind: str | None = None,
    item_id: str | None = None,
    mesh_id: str | None = None,
    run_id: str | None = None,
    entry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Remove lost-face entries from a record and every copy of it (all of them without ``entry``).

    No ``item_id`` (and no ``kind``): every record of the study, or of the geometry when
    no study is named either. Refused ``geometry_updating`` while fenced, and
    ``geometry_changed`` when ``geometry_rev`` is not the geometry's rev (a stale tab's
    "Forget all" never removes entries it did not see).
    """
    from cfddesk.project.link_rewrite import study_record_list

    root = Path(project_dir)
    gdir = _geometry_dir(root, geometry_id)
    state = read_state(gdir)
    if not state:
        raise LinkError("gone", "The geometry is not linked.")
    name = str(state.get("name") or geometry_id)
    if has_journal(gdir):
        raise LinkError("geometry_updating", updating_message(name))
    try:
        same = int(geometry_rev) == int(state.get("rev") or 0)
    except (TypeError, ValueError):
        same = False
    if not same:
        raise LinkError("geometry_changed", changed_message(name))
    removed = 0
    patches: list[dict[str, Any]] = []
    for rec in study_record_list(root, geometry_id, [study_id] if study_id else None):
        if kind and rec.kind != kind:
            continue
        if item_id and str(rec.id or "") != str(item_id):
            continue
        if mesh_id and str(rec.mesh_id or "") != str(mesh_id):
            continue
        if run_id and str(rec.run_id or "") != str(run_id):
            continue
        lost = [e for e in rec.doc.get("lost_faces") or [] if isinstance(e, dict)]
        if not lost:
            continue
        if entry:
            keep = [e for e in lost if not (e.get("field") == entry.get("field") and e.get("old") == entry.get("old"))]
        else:
            keep = []
        if len(keep) == len(lost):
            continue
        removed += len(lost) - len(keep)
        for c in rec.copies:
            patches.append(
                {
                    "study": rec.study_id,
                    "mesh": rec.mesh_id,
                    "run": rec.run_id,
                    "kind": rec.kind,
                    "id": rec.id,
                    "copy": c.copy,
                    "row_id": rec.id if c.copy != "record" else None,
                    "adopt": rec.adopt,
                    "set": {"lost_faces": keep},
                }
            )
    _apply_patches(root, patches)
    return {"ok": True, "removed": removed}


def lost_counts(project_dir: Path | str, geometry_id: str) -> dict[str, int]:
    """Open lost entries per record key (``kind|study|mesh|run|id``) of a geometry's studies."""
    from cfddesk.project.link_rewrite import study_record_list

    out: dict[str, int] = {}
    for rec in study_record_list(Path(project_dir), geometry_id):
        n = len([e for e in rec.doc.get("lost_faces") or [] if isinstance(e, dict)])
        if n:
            out[rec.key] = n
    return out


def lost_list(project_dir: Path | str, geometry_id: str) -> dict[str, Any]:
    """A geometry's link for its panel: its source, its last update and every lost entry."""
    from cfddesk.project.link_rewrite import study_record_list

    root = Path(project_dir)
    gdir = _geometry_dir(root, geometry_id)
    state = read_state(gdir)
    if not state:
        return {"ok": True, "linked": False, "entries": []}
    geom = next((g for g in walk_geometries(root) if str(g.get("id")) == str(geometry_id)), None) or {}
    src = source_of(geom) or {}
    title = ""
    gone = False
    if src:
        rec = _read(root / "plugins" / str(src.get("plugin")) / "studies" / str(src.get("study_id")) / "study.json")
        title = str((rec or {}).get("title") or "") if isinstance(rec, dict) else ""
        # The study was deleted: a plain geometry (proposal 5.18, 5.19).
        gone = not isinstance(rec, dict)
    last = _read(link_dir(gdir) / LAST_UPDATE)
    entries = []
    for rec in study_record_list(root, geometry_id):
        for e in rec.doc.get("lost_faces") or []:
            if not isinstance(e, dict):
                continue
            entries.append(
                {
                    "studyId": rec.study_id,
                    "studyTitle": rec.study_title,
                    "kind": rec.kind,
                    "id": rec.id,
                    "meshId": rec.mesh_id,
                    "runId": rec.run_id,
                    "item": rec.name,
                    "field": e.get("field"),
                    "old": e.get("old"),
                    "name": e.get("name"),
                    "label": e.get("label"),
                    "reason": e.get("reason"),
                }
            )
    report = (last or {}).get("report") if isinstance(last, dict) else None
    return {
        "ok": True,
        "linked": True,
        "rev": int(state.get("rev") or 0),
        "name": str(state.get("name") or ""),
        "unlinked": _marked(gdir, UNLINKED) or gone,
        "source": {"plugin": src.get("plugin"), "study_id": src.get("study_id"), "study_title": title} if src else None,
        "last_update": {
            "rev": (last or {}).get("rev"),
            "from_rev": (last or {}).get("from_rev"),
            "change": (report or {}).get("change"),
            "lost": len((report or {}).get("lost") or []),
            "returned": len((report or {}).get("returned") or []),
        }
        if isinstance(last, dict)
        else None,
        "entries": entries,
    }
