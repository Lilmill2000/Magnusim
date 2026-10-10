"""Editing a project geometry in a plugin's workspace (host API 1.7).

A plugin declares ``[[geometry_actions]]`` on a study kind that links geometry. The
user picks the action ("Edit in CAD") on a geometry; the host opens a study of that
kind for it (:func:`open_action`): the study that links the geometry already, else the
newest study of that kind that edits it and links nothing, else a new one. A new study
gets the host-owned field ``edits_geometry {id, name, at}``; a page can never change it.

The page reads the geometry (:func:`edit_target`, :func:`source_info`,
:func:`faces_table`) and, on its first link with a real change, takes it over in place
(the *adoption*): the link job updates that geometry instead of creating one, moves its
source files to ``<geometry>/link/original/`` and gives it the link files a link makes.
:func:`adopt_state` is the state the link job starts from, :func:`adopt_names` checks
the page's ``originalNames`` file against the geometry's face table and writes the named
table the face map starts from (``<staging>/old_named.json``).

Every function here takes the project folder; the RPCs are in
``cfddesk.worker.link_methods``.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cfddesk.project import link
from cfddesk.project.paths import walk_geometries
from cfddesk.project.web_writes import atomic_write

ORIGINAL = "original"
ORIGINAL_JSON = "original.json"
# The STEP's hash, kept beside it (not in link/: a plain geometry gets no link folder from a read).
SHA_CACHE = ".source-sha256.json"
# More than this share of originalNames rows that do not match their host face refuses the file.
UNVERIFIED_MAX = 0.2
OLD_NAMED = "old_named.json"
# What the swap of an adoption keeps in link/original/ (the rest moves aside as in any update).
SOURCE_FILES = ("source.step", "source.bbrep")
ORIGINAL_RE = re.compile(r"^original\.[A-Za-z0-9]{1,8}$")
NAMES_FORMAT = "magnusim.face-names"
NAME_MAX = 200
LABEL_MAX = 200
# A deferred STEP (an IGES or BREP import whose STEP is still being written): ask again after this.
RETRY_AFTER_S = 3
_FORMAT_OF_EXT = {
    ".step": "step",
    ".stp": "step",
    ".iges": "iges",
    ".igs": "iges",
    ".brep": "brep",
    ".brp": "brep",
    ".stl": "mesh",
    ".obj": "mesh",
    ".ply": "mesh",
}
_FORMAT_WORDS = {"step": "STEP", "iges": "IGES", "brep": "BREP"}


class ActionError(Exception):
    """A refusal: ``code`` (not_editable, plugin_off, gone, not_allowed, no_source, not_ready)."""

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.extra = extra

    def answer(self) -> dict[str, Any]:
        return {"ok": False, "code": self.code, "error": self.message, **self.extra}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read(path: Path) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


# ---- what a geometry is ----------------------------------------------------------------


def project_rows(root: Path) -> dict[str, dict[str, Any]]:
    """project.json's geometry records by id."""
    proj = _read(Path(root) / "project.json")
    rows = proj.get("geometries") if isinstance(proj, dict) else None
    return {str(r.get("id")): r for r in rows or [] if isinstance(r, dict) and r.get("id")}


def find(root: Path, geometry_id: str) -> dict[str, Any] | None:
    """A geometry folder by id (None when gone, removed or not committed yet)."""
    want = str(geometry_id or "").strip()
    if not want:
        return None
    for g in walk_geometries(Path(root)):
        if str(g.get("id")) != want:
            continue
        gdir = Path(g["dir"])
        if (gdir / link.LINK / link.REMOVED).is_file() or (gdir / link.LINK / link.PENDING).is_file():
            return None
        return g
    return None


def linked_state(geom: dict[str, Any]) -> dict[str, Any] | None:
    """The link state of a geometry a link made (rev >= 1), else None (a plain import)."""
    if not link.source_of(geom):
        return None
    state = link.read_state(geom["dir"])
    return state if state and int(state.get("rev") or 0) >= 1 else None


def display_name(geom: dict[str, Any], row: dict[str, Any] | None = None) -> str:
    state = linked_state(geom) or {}
    return str(state.get("name") or (row or {}).get("name") or geom.get("name") or geom.get("original_filename") or "The geometry")


def original_filename(geom: dict[str, Any], row: dict[str, Any] | None = None) -> str | None:
    for raw in (geom.get("original_filename"), (row or {}).get("original_filename")):
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


def geometry_format(geom: dict[str, Any], row: dict[str, Any] | None = None) -> str | None:
    """'step', 'iges', 'brep' or 'mesh' (None when unknown). A geometry a link made is 'brep'."""
    if linked_state(geom):
        return "brep"
    kind = str((row or {}).get("source_kind") or "").strip().lower()
    if kind in ("step", "iges", "brep", "mesh"):
        return kind
    if kind == "plugin":
        return "brep"
    name = original_filename(geom, row) or ""
    hit = _FORMAT_OF_EXT.get(Path(name).suffix.lower()) if name else None
    if hit:
        return hit
    if (Path(geom["dir"]) / "source.step").is_file():
        return "step"
    return None


def original_dir(gdir: Path | str) -> Path:
    return Path(gdir) / link.LINK / ORIGINAL


def read_original(gdir: Path | str) -> dict[str, Any] | None:
    """``link/original/original.json`` of an adopted geometry, or None."""
    doc = _read(original_dir(gdir) / ORIGINAL_JSON)
    return doc if isinstance(doc, dict) else None


def _plain_source(gdir: Path) -> tuple[str, Path | None]:
    """Where a plain import's STEP is: ('ok', path) or ('missing', None).

    A STEP, IGES or BREP import writes its STEP before the import answers (only a mesh
    import defers it, and no action edits a mesh), so no STEP is a missing file, never one
    still being written.
    """
    step = gdir / "source.step"
    if step.is_file() and step.stat().st_size >= 32:
        return "ok", step
    return "missing", None


# ---- hashes --------------------------------------------------------------------------------


def file_sha256(path: Path, gdir: Path | None = None) -> str:
    """A file's SHA-256 (hex), cached in ``<geometry>/.source-sha256.json`` by name, size and mtime."""
    st = path.stat()
    key = {"name": path.name, "size": st.st_size, "mtime_ns": st.st_mtime_ns}
    cache_path = (Path(gdir) / SHA_CACHE) if gdir is not None else None
    cache = _read(cache_path) if cache_path else None
    rows: list[Any] = cache["files"] if isinstance(cache, dict) and isinstance(cache.get("files"), list) else []
    for row in rows:
        if isinstance(row, dict) and all(row.get(k) == v for k, v in key.items()) and isinstance(row.get("sha256"), str):
            return str(row["sha256"])
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    sha = h.hexdigest()
    if cache_path is not None:
        keep = [r for r in rows if isinstance(r, dict) and r.get("name") != path.name][-4:]
        try:
            atomic_write(cache_path, {"files": [*keep, {**key, "sha256": sha}]})
        except OSError:
            pass
    return sha


# ---- whether an action may edit a geometry ---------------------------------------------------


def _studies_by_key(studies: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    return {(str(s.get("plugin") or ""), str(s.get("id") or "")): s for s in studies}


def geometry_block(geom: dict[str, Any], row: dict[str, Any] | None, fmt: str | None) -> str:
    """Why no action can edit this geometry now ('' when one may): it is updating, or its file is missing."""
    gdir = Path(geom["dir"])
    name = display_name(geom, row)
    if link.has_journal(gdir):
        return f"{name} is updating."
    if linked_state(geom) is None and fmt != "mesh":
        state, _path = _plain_source(gdir)
        if state == "missing":
            return f"The source file of {name} is missing."
    return ""


def action_reason(
    geom: dict[str, Any],
    row: dict[str, Any] | None,
    fmt: str | None,
    action: dict[str, Any],
    studies: list[dict[str, Any]],
) -> str:
    """Why ``action`` (a geometry action row with ``plugin``) cannot edit this geometry ('' when it can)."""
    name = display_name(geom, row)
    gdir = Path(geom["dir"])
    if link.has_journal(gdir):
        return f"{name} is updating."
    plugin = str(action.get("plugin") or "")
    kind = str(action.get("study_kind") or "")
    label = str(action.get("label") or "This action")
    state = linked_state(geom)
    if state is not None:
        src = link.source_of(geom) or {}
        study = _studies_by_key(studies).get((str(src.get("plugin") or ""), str(src.get("study_id") or "")))
        unlinked = (gdir / link.LINK / link.UNLINKED).is_file()
        if study is None:
            orig = read_original(gdir) if isinstance(state.get("adopted"), dict) else None
            if orig is not None and (original_dir(gdir) / "source.step").is_file():
                file = str(orig.get("file_name") or "its original file")
                return (
                    f"{name} came from a study that was deleted. To edit it again, add its original ({file}) "
                    "as a new geometry: Geometry panel, Add the original as a new geometry."
                )
            return f"{name} came from a study that was deleted, and has no STEP file to open."
        title = str(study.get("title") or "its study")
        if unlinked:
            return f"{name} is an earlier version from {title}. Open {title} to edit the design."
        if str(study.get("plugin")) == plugin and str(study.get("kind")) == kind:
            return ""
        return f"{name} comes from {title} ({study.get('plugin_name') or src.get('plugin')}). Edit it there."
    formats = [str(f) for f in action.get("formats") or [] if f]
    if fmt == "mesh" or (fmt and fmt not in formats) or not fmt:
        kinds = [_FORMAT_WORDS.get(f, f.upper()) for f in formats] or ["STEP"]
        listed = kinds[0] if len(kinds) == 1 else f"{', '.join(kinds[:-1])} or {kinds[-1]}"
        if fmt == "mesh":
            ext = (Path(original_filename(geom, row) or "x.stl").suffix.lstrip(".") or "stl").upper()
            return f"{name} is a mesh ({ext}); {label} needs a {listed} part."
        what = f"a {_FORMAT_WORDS[fmt]}" if fmt in _FORMAT_WORDS else "not a CAD"
        return f"{name} is {what} part; {label} needs a {listed} part."
    block = geometry_block(geom, row, fmt)
    return block


def annotate_tree(root: Path, tree: dict[str, Any], studies: list[dict[str, Any]], kinds: list[dict[str, Any]]) -> None:
    """Each geometry node gains ``format``, ``edit_block`` and ``edit_actions`` (API 1.7).

    ``edit_actions`` lists every geometry action of a plugin that is on, with ``enabled``
    and the ``reason`` it is not (the menu shows it under the item).
    """
    actions = []
    for k in kinds:
        a = k.get("geometry_action")
        if isinstance(a, dict):
            actions.append({**a, "plugin": k.get("plugin"), "plugin_name": k.get("plugin_name")})
    folders = {str(g.get("id")): g for g in walk_geometries(Path(root))}
    rows = project_rows(root)
    # Studies that link a geometry now (they edit that one, not the one they were opened on).
    linking = set()
    for node in tree.get("geometries") or []:
        src = node.get("source") if isinstance(node, dict) else None
        if isinstance(src, dict) and not node.get("unlinked"):
            linking.add((str(src.get("plugin") or ""), str(src.get("study_id") or "")))
    for node in tree.get("geometries") or []:
        if not isinstance(node, dict):
            continue
        geom = folders.get(str(node.get("id") or ""))
        if geom is None:
            continue
        row = rows.get(str(node.get("id")))
        fmt = geometry_format(geom, row)
        node["format"] = fmt
        node["edit_block"] = geometry_block(geom, row, fmt)
        state = linked_state(geom)
        if state is not None and isinstance(state.get("adopted"), dict):
            orig = read_original(geom["dir"]) or {}
            node["original"] = {
                "file_name": orig.get("file_name") or (state["adopted"].get("from") or {}).get("file_name"),
                "format": orig.get("format") or (state["adopted"].get("from") or {}).get("format"),
                "present": (original_dir(geom["dir"]) / "source.step").is_file(),
            }
        out = []
        for a in actions:
            reason = action_reason(geom, row, fmt, a, studies)
            out.append(
                {
                    "plugin": a.get("plugin"),
                    "plugin_name": a.get("plugin_name"),
                    "study_kind": a.get("study_kind"),
                    "label": a.get("label"),
                    "hint": a.get("hint") or "",
                    "icon": a.get("icon") or "",
                    "places": list(a.get("places") or []),
                    "workspace": a.get("workspace") or "",
                    "workspace_title": a.get("workspace_title") or "",
                    "enabled": not reason,
                    "reason": reason,
                }
            )
        node["edit_actions"] = out
        # A study a geometry action opened on this plain geometry that has not sent an edit
        # back yet: the geometry's row says "Being edited in <study>", and STUDIES leaves it
        # out (it is not a design of its own, and nothing in the project changed yet).
        editing = []
        if state is None:
            for s in studies:
                key = (str(s.get("plugin") or ""), str(s.get("id") or ""))
                if str(s.get("edits_geometry") or "") == str(node.get("id")) and key not in linking:
                    s["editing"] = str(node.get("id"))
                    editing.append(
                        {
                            "plugin": key[0],
                            "id": key[1],
                            "title": s.get("title") or key[1],
                            "workspace": s.get("workspace") or "",
                            "scope_key": s.get("scope_key") or "",
                            "available": bool(s.get("available")),
                        }
                    )
        node["edited_in"] = editing


# ---- the target of a study ---------------------------------------------------------------


def _edits_id(rec: dict[str, Any] | None) -> str:
    ed = (rec or {}).get("edits_geometry")
    return str(ed.get("id") or "") if isinstance(ed, dict) else ""


def study_record(root: Path, plugin: str, study_id: str) -> dict[str, Any] | None:
    rec = _read(Path(root) / "plugins" / str(plugin) / "studies" / str(study_id) / "study.json")
    return rec if isinstance(rec, dict) and str(rec.get("id") or "") == str(study_id) else None


def _preview(gdir: Path) -> dict[str, Any]:
    meta = _read(gdir / "cad_preview.json")
    return meta if isinstance(meta, dict) else {}


def _preview_faces(meta: dict[str, Any]) -> list[dict[str, Any]]:
    """The face rows of a cad_preview.json (an empty list when it has none: not read yet)."""
    rows = meta.get("faces") if isinstance(meta.get("faces"), list) else []
    return [f for f in rows or [] if isinstance(f, dict) and isinstance(f.get("id"), int)]


def faces_not_read(name: str) -> str:
    """Why there is no face table yet (a geometry's preview is built when it is shown)."""
    return f"Magnusim has not read the faces of {name} yet. Show {name} in the viewport, then try again."


def _diag(meta: dict[str, Any], faces: list[dict[str, Any]]) -> float:
    b = meta.get("bounds") or {}
    try:
        span = [float(b["xmax"]) - float(b["xmin"]), float(b["ymax"]) - float(b["ymin"]), float(b["zmax"]) - float(b["zmin"])]
    except (KeyError, TypeError, ValueError):
        pts = [f["centroid"] for f in faces if isinstance(f.get("centroid"), list) and len(f["centroid"]) == 3]
        span = [max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3)] if pts else [0.0, 0.0, 0.0]
    return float(sum(x * x for x in span) ** 0.5)


def _vec3(value: Any) -> list[float] | None:
    if isinstance(value, list) and len(value) == 3 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in value):
        return [float(x) for x in value]
    return None


def _counts(gdir: Path, state: dict[str, Any] | None = None) -> tuple[int, int]:
    meta = _preview(gdir)
    faces: list[Any] = meta["faces"] if isinstance(meta.get("faces"), list) else []
    n_faces = len(faces) or int((state or {}).get("n_faces") or meta.get("n_faces") or 0)
    n_solids = int((state or {}).get("n_solids") or meta.get("n_solids") or 1)
    return n_solids, n_faces


def edit_target(root: Path, plugin: str, study_id: str) -> dict[str, Any] | None:
    """The project geometry a study edits (``ws.context.geometry``), or None.

    The geometry it links (``linked``: true), else the one its ``edits_geometry`` names
    while that one is still a plain import nobody else took over.
    """
    root = Path(root)
    hit = link.find_linked(root, plugin, study_id)
    rows = project_rows(root)
    if hit is not None:
        gdir = Path(hit["dir"])
        state = hit["state"]
        n_solids, n_faces = _counts(gdir, state)
        return {
            "geometry": hit,
            "row": {
                "id": str(hit["id"]),
                "name": str(state.get("name") or hit.get("name") or ""),
                "format": "brep",
                "fileName": original_filename(hit, rows.get(str(hit["id"]))),
                "linked": True,
                "rev": int(state.get("rev") or 0),
                "bodies": n_solids,
                "faces": n_faces,
            },
        }
    rec = study_record(root, plugin, study_id)
    gid = _edits_id(rec)
    geom = find(root, gid) if gid else None
    if geom is None or linked_state(geom) is not None:
        return None
    row = rows.get(gid)
    fmt = geometry_format(geom, row)
    if fmt not in ("step", "iges", "brep"):
        return None
    n_solids, n_faces = _counts(Path(geom["dir"]))
    return {
        "geometry": geom,
        "row": {
            "id": gid,
            "name": display_name(geom, row),
            "format": fmt,
            "fileName": original_filename(geom, row),
            "linked": False,
            "rev": 0,
            "bodies": n_solids,
            "faces": n_faces,
        },
    }


def _target_or_refuse(root: Path, plugin: str, study_id: str) -> dict[str, Any]:
    if study_record(root, plugin, study_id) is None:
        raise ActionError("not_allowed", "That study was removed.")
    target = edit_target(root, plugin, study_id)
    if target is None:
        rec = study_record(root, plugin, study_id)
        gid = _edits_id(rec)
        geom = find(root, gid) if gid else None
        if gid and geom is None:
            raise ActionError("gone", "The geometry this study edits was removed.")
        if geom is not None and linked_state(geom) is not None:
            src = link.source_of(geom) or {}
            other = study_record(root, str(src.get("plugin") or ""), str(src.get("study_id") or ""))
            raise ActionError(
                "adopted", f"{display_name(geom)} is already edited in {str((other or {}).get('title') or 'another study')}."
            )
        raise ActionError("not_allowed", "This study edits no project geometry.")
    return target


def source_info(root: Path, plugin: str, study_id: str) -> dict[str, Any]:
    """The STEP file ``ws.project.geometrySource()`` serves: path, name, size, sha256, adopted."""
    root = Path(root)
    target = _target_or_refuse(root, plugin, study_id)
    geom, row = target["geometry"], target["row"]
    gdir = Path(geom["dir"])
    name = row["name"]
    if link.has_journal(gdir):
        raise ActionError("not_ready", f"{name} is updating. Try again in a moment.", retryAfter=RETRY_AFTER_S)
    if row["linked"]:
        state = linked_state(geom) or {}
        path = original_dir(gdir) / "source.step"
        if not isinstance(state.get("adopted"), dict) or not path.is_file():
            raise ActionError("no_source", f"{name} was made by a link: it has no STEP file to open.")
        adopted = True
    else:
        _st, found = _plain_source(gdir)
        if found is None:
            raise ActionError("no_source", f"The source file of {name} is missing.")
        path = found
        adopted = False
    base = Path(row.get("fileName") or "").stem or name
    return {
        "ok": True,
        "geometry_id": row["id"],
        "path": str(path),
        "file_name": f"{base}.step",
        "size": path.stat().st_size,
        "sha256": file_sha256(path, gdir),
        "adopted": adopted,
    }


# ---- the face table ---------------------------------------------------------------------------

# What a record's kind is to the page (GeometryFaces' ``uses``).
_USE_KIND = {
    "bc": "bc",
    "material": "material",
    "refinement": "refinement",
    "mesh_doc": "refinement",
    "result_control": "monitor",
    "run_result_control": "monitor",
}


def faces_table(root: Path, plugin: str, study_id: str, schema_fields: dict[str, Any] | None = None) -> dict[str, Any]:
    """``ws.project.geometryFaces()``: the geometry's faces in the host's order, and their uses."""
    from cfddesk.project.link_rewrite import (
        BODY_RE,
        _get,
        face_index,
        face_label,
        label_fields,
        study_record_list,
    )

    root = Path(root)
    target = _target_or_refuse(root, plugin, study_id)
    geom, row = target["geometry"], target["row"]
    gdir = Path(geom["dir"])
    if link.has_journal(gdir):
        raise ActionError("not_ready", f"{row['name']} is updating. Try again in a moment.", retryAfter=RETRY_AFTER_S)
    meta = _preview(gdir)
    if not _preview_faces(meta):
        raise ActionError("not_ready", faces_not_read(row["name"]), retryAfter=RETRY_AFTER_S)
    if row["linked"]:
        state = linked_state(geom) or {}
        sha = str(state.get("shape_sha256") or "")
        info = state.get("bodies") or []
    else:
        _st, step = _plain_source(gdir)
        if step is None:
            raise ActionError("no_source", f"The source file of {row['name']} is missing.")
        sha = file_sha256(step, gdir)
        info = []
    n_solids = int(meta.get("n_solids") or 1)
    by_ref = {str(b.get("ref")): b for b in (meta.get("body_info") or info) if isinstance(b, dict) and b.get("ref")}
    bodies = []
    for i in range(1, max(1, n_solids) + 1):
        b = by_ref.get(f"Body{i}") or {}
        bodies.append({"index": i, "ref": f"Body{i}", "id": b.get("id") or None, "name": b.get("name") or None})
    faces = []
    by_index: dict[int, dict[str, Any]] = {}
    for f in meta["faces"]:
        if not isinstance(f, dict) or not isinstance(f.get("id"), int):
            continue
        body = int(f.get("body") or 1)
        vec: list[Any] = f["centroid"] if isinstance(f.get("centroid"), list) else [0.0, 0.0, 0.0]
        nrm: list[Any] | None = f["normal"] if isinstance(f.get("normal"), list) and len(f["normal"]) == 3 else None
        shared = f.get("shared_with")
        index = int(f["id"])
        entry: dict[str, Any] = {
            "index": index,
            "body": body,
            "label": face_label(int(f["id"]), body),
            "area": float(f.get("area") or 0.0),
            "centroid": [float(x) for x in vec[:3]],
            "normal": [float(x) for x in nrm] if nrm else None,
            "surfaceType": str(f.get("surface_type")) if f.get("surface_type") else None,
            "sharedWith": int(shared) if isinstance(shared, int) and not isinstance(shared, bool) else None,
            "name": f.get("name") or None,
            "uses": [],
        }
        faces.append(entry)
        by_index[index] = entry
    seen: set[tuple[int, str, str, str]] = set()

    def use(idx: int, rec: Any, kind: str) -> None:
        face = by_index.get(idx)
        key = (idx, rec.study_id, kind, rec.name)
        if face is None or key in seen:
            return
        seen.add(key)
        face["uses"].append({"studyId": rec.study_id, "studyTitle": rec.study_title, "kind": kind, "item": rec.name})

    for rec in study_record_list(root, row["id"]):
        kind = _USE_KIND.get(rec.kind)
        if not kind:
            continue
        for path, what in label_fields(rec, schema_fields or {}):
            val = _get(rec.doc, path)
            for v in val if isinstance(val, list) else [val]:
                if what == "face":
                    idx = face_index(v)
                    if idx is not None:
                        use(idx, rec, kind)
                elif what == "body":
                    m = BODY_RE.match(str(v or ""))
                    if m:
                        for f in faces:
                            if f["body"] == int(m.group(1)):
                                use(int(f["index"]), rec, kind)
    return {
        "ok": True,
        "geometryId": row["id"],
        "rev": row["rev"],
        "lengthUnit": "mm",
        "sourceSha256": sha,
        "bodies": bodies,
        "faces": faces,
    }


# ---- opening the action (the resolver) -------------------------------------------------------


def unique_title(titles: list[str], base: str) -> str:
    """``base``, else "base (2)", "base (3)", ... (compared without case)."""
    taken = {str(t).casefold() for t in titles if t}
    base = (base or "Part").strip()[:100] or "Part"
    if base.casefold() not in taken:
        return base
    k = 2
    while f"{base} ({k})".casefold() in taken:
        k += 1
    return f"{base} ({k})"


def open_action(
    root: Path,
    geometry_id: str,
    plugin: str,
    study_kind: str,
    studies: list[dict[str, Any]],
    kinds: list[dict[str, Any]],
    manifest: Any,
) -> dict[str, Any]:
    """The study a geometry action opens: rule 1 (it links the geometry), rule 2 (it edits
    the geometry and links nothing, the newest), else a new study. On the main lane, so two
    tabs never make two studies. ``studies`` and ``kinds`` are the project's plugin study
    catalog, ``manifest`` the plugin's (the worker gives them)."""
    from cfddesk.registry.plugin_data import PluginData

    root = Path(root)
    decl = next((k for k in kinds if k.get("plugin") == plugin and k.get("key") == study_kind), None)
    action = (decl or {}).get("geometry_action")
    if decl is None or not isinstance(action, dict):
        raise ActionError("plugin_off", "That plugin is not on, or has no such action.")
    geom = find(root, geometry_id)
    if geom is None:
        raise ActionError("gone", "That geometry was removed.")
    row = project_rows(root).get(str(geometry_id))
    fmt = geometry_format(geom, row)
    reason = action_reason(geom, row, fmt, {**action, "plugin": plugin, "plugin_name": decl.get("plugin_name")}, studies)
    if reason:
        raise ActionError("not_editable", reason)
    workspace = str(decl.get("workspace") or "")
    mine = [s for s in studies if s.get("plugin") == plugin and s.get("kind") == study_kind and s.get("available")]
    # 1. The study that links it.
    src = link.source_of(geom) if linked_state(geom) else None
    if src and str(src.get("plugin")) == plugin:
        hit = next((s for s in mine if str(s.get("id")) == str(src.get("study_id"))), None)
        if hit is not None:
            return {"ok": True, "plugin": plugin, "study_id": hit["id"], "workspace": workspace, "created": False, "title": hit.get("title")}
    # 2. The newest study of the kind that edits it and links nothing.
    data = PluginData(root, plugin)
    editing = []
    for s in mine:
        try:
            rec = data.study(str(s["id"]))
        except Exception:
            continue
        if _edits_id(rec) == str(geometry_id) and link.find_linked(root, plugin, str(s["id"])) is None:
            editing.append((str(rec.get("created_at") or ""), s))
    if editing:
        editing.sort(key=lambda x: x[0], reverse=True)
        hit = editing[0][1]
        return {"ok": True, "plugin": plugin, "study_id": hit["id"], "workspace": workspace, "created": False, "title": hit.get("title")}
    # 3. A new study, titled as the geometry (made unique).
    if manifest is None:
        raise ActionError("plugin_off", "That plugin is not on, or has no such action.")
    schema = next(k.schema_version for k in manifest.study_kinds if k.key == study_kind)
    title = unique_title([str(s.get("title") or "") for s in studies], display_name(geom, row))
    rec = data.create_study(study_kind, title, plugin_name=manifest.name, plugin_version=manifest.version, schema_version=schema)
    rec["edits_geometry"] = {"id": str(geometry_id), "name": display_name(geom, row), "at": _now()}
    data.write_json(f"studies/{rec['id']}/study.json", rec)
    return {"ok": True, "plugin": plugin, "study_id": rec["id"], "workspace": workspace, "created": True, "title": title}


# ---- the adoption ------------------------------------------------------------------------------


def adopt_target(root: Path, plugin: str, study_id: str) -> dict[str, Any] | None:
    """What the first link of an editing study does to its geometry (``geometry.link_check``).

    None: nothing to take over (no ``edits_geometry``, or that geometry was removed or is
    not a plain STEP, IGES or BREP import): the link creates a geometry. Otherwise
    ``{geometry, row, other}``: ``other`` names the study that took it over meanwhile
    (the link is refused ``adopted``), else the link adopts it.
    """
    root = Path(root)
    rec = study_record(root, plugin, study_id)
    gid = _edits_id(rec)
    geom = find(root, gid) if gid else None
    if geom is None:
        return None
    row = project_rows(root).get(gid)
    if linked_state(geom) is not None:
        src = link.source_of(geom) or {}
        other = study_record(root, str(src.get("plugin") or ""), str(src.get("study_id") or ""))
        return {"geometry": geom, "row": row, "other": {"title": str((other or {}).get("title") or "another study")}}
    if geometry_format(geom, row) not in ("step", "iges", "brep"):
        return None
    return {"geometry": geom, "row": row, "other": None}


def adopt_state(geom: dict[str, Any], row: dict[str, Any] | None) -> dict[str, Any]:
    """The state an adoption starts from: rev 0 of the plain geometry."""
    gdir = Path(geom["dir"])
    st, step = _plain_source(gdir)
    n_solids, n_faces = _counts(gdir)
    return {
        "rev": 0,
        "version": 1,
        # Below any design's version: the first link is never older than the import.
        "source_version": -1,
        "name": display_name(geom, row),
        "shape_sha256": file_sha256(step, gdir) if step is not None else "",
        "names_file_sha256": None,
        "names_sha256": None,
        "n_solids": n_solids,
        "n_faces": n_faces,
        "bodies": [],
        "adopt": True,
        "source_ready": st == "ok",
    }


def _text(where: str, value: Any, top: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > top:
        raise ValueError(f"{where} must be text of 1 to {top} characters")
    return value


def adopt_names(root: Path, geometry_id: str, staging_rel: str) -> dict[str, Any]:
    """Check the page's ``originalNames`` (``<staging>/in/original_names``) against the
    geometry's live face table, and write ``<staging>/old_named.json``: that table with
    each face's ``name`` and ``label`` and ``body_info``, the table the face map starts
    from. With no file, the table is written without names (faces follow by shape)."""
    root = Path(root)
    geom = find(root, geometry_id)
    if geom is None:
        raise link.LinkError("gone", "The geometry was removed.")
    gdir = Path(geom["dir"])
    stage = link._staging(root, staging_rel)
    row = project_rows(root).get(str(geometry_id))
    name = display_name(geom, row)
    meta = _preview(gdir)
    faces = _preview_faces(meta)
    if not faces:
        # Never a map from an empty table: every boundary condition would be lost.
        raise link.LinkError("not_ready", faces_not_read(name))
    n_solids = int(meta.get("n_solids") or 1)
    names_path = stage / "in" / "original_names"
    out = dict(meta)
    named = 0
    unverified = 0
    if names_path.is_file():
        try:
            doc = json.loads(names_path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            doc = None

        def bad(rule: str) -> link.LinkError:
            return link.LinkError("bad_face_names", f"originalNames does not describe {name}: {rule}")

        if not isinstance(doc, dict):
            raise bad("it is not a JSON object")
        if doc.get("format") != NAMES_FORMAT or doc.get("version") != 1:
            raise bad(f"format must be {NAMES_FORMAT!r} version 1")
        if doc.get("length_unit", "mm") != "mm":
            raise bad("length_unit must be 'mm'")
        st, step = _plain_source(gdir)
        want = file_sha256(step, gdir) if step is not None else ""
        given = str(doc.get("shape_sha256") or "").lower()
        if not given or given != want:
            raise bad("its shape_sha256 is not the sourceSha256 of the geometry's faces")
        rows_b = doc.get("bodies")
        rows_f = doc.get("faces")
        if not isinstance(rows_b, list) or not isinstance(rows_f, list):
            raise bad("bodies and faces must be lists")
        if len(rows_b) != n_solids:
            raise bad(f"{len(rows_b)} bodies listed, the geometry has {n_solids}")
        if len(rows_f) != len(faces):
            raise bad(f"{len(rows_f)} faces listed, the geometry has {len(faces)}")
        from cfddesk.project.link_rewrite import same_face

        live = {int(f["id"]): f for f in faces}
        diag = _diag(meta, faces)
        names: dict[int, tuple[str | None, str | None]] = {}
        try:
            for i, r in enumerate(rows_f):
                if not isinstance(r, dict):
                    raise ValueError(f"faces[{i}] must be an object")
                idx = r.get("index")
                if not isinstance(idx, int) or isinstance(idx, bool) or idx not in live or idx in names:
                    raise ValueError(f"faces[{i}].index is out of range or listed twice")
                body_given = int(r.get("body") or 1) if not isinstance(r.get("body"), bool) else -1
                if body_given != int(live[idx].get("body") or 1):
                    raise ValueError(f"face {idx} is in body {int(live[idx].get('body') or 1)}, not {r.get('body')!r}")
                nm = _text(f"faces[{i}].name", r.get("name"), NAME_MAX)
                lab = _text(f"faces[{i}].label", r.get("label"), LABEL_MAX)
                # The row's fingerprint (centroid, area, normal; mm) must be host face idx's:
                # a row that names another face (a matcher's slip, a reordered table) loses its
                # name, and that face follows by shape only.
                has_fp = any(k in r for k in ("centroid", "area", "normal"))
                centroid = _vec3(r.get("centroid"))
                area = r.get("area")
                normal = r.get("normal")
                if has_fp and (
                    centroid is None
                    or isinstance(area, bool)
                    or not isinstance(area, (int, float))
                    or not (normal is None or _vec3(normal) is not None)
                ):
                    raise ValueError(f"faces[{i}]: centroid must be 3 numbers, area a number and normal 3 numbers or null")
                if nm:
                    probe = {"centroid": centroid, "area": area, "normal": _vec3(normal)}
                    if not has_fp or not same_face(probe, live[idx], diag):
                        unverified += 1
                        nm, lab = None, None
                names[idx] = (nm, lab)
            info = []
            seen_b: set[int] = set()
            for i, b in enumerate(rows_b):
                if not isinstance(b, dict):
                    raise ValueError(f"bodies[{i}] must be an object")
                bi = b.get("index")
                if not isinstance(bi, int) or isinstance(bi, bool) or not 1 <= bi <= n_solids or bi in seen_b:
                    raise ValueError(f"bodies[{i}].index is out of range or listed twice")
                seen_b.add(bi)
                info.append(
                    {
                        "ref": f"Body{bi}",
                        "id": _text(f"bodies[{i}].id", b.get("id"), NAME_MAX),
                        "name": _text(f"bodies[{i}].name", b.get("name"), NAME_MAX),
                        "label": _text(f"bodies[{i}].label", b.get("label"), LABEL_MAX),
                    }
                )
        except ValueError as exc:
            raise bad(str(exc)) from None
        if unverified > UNVERIFIED_MAX * len(rows_f):
            raise link.LinkError("bad_face_names", f"originalNames: {unverified} of {len(rows_f)} faces don't match {name}")
        out_faces = []
        for f in faces:
            nm, lab = names.get(int(f["id"]), (None, None))
            g = {k: v for k, v in f.items() if k not in ("name", "label")}
            if nm:
                g["name"] = nm
                named += 1
            if lab:
                g["label"] = lab
            out_faces.append(g)
        out["faces"] = out_faces
        out["body_info"] = sorted(info, key=lambda b: int(b["ref"][4:]))
    else:
        out["faces"] = [{k: v for k, v in f.items() if k not in ("name", "label")} for f in faces]
        out["body_info"] = [{"ref": f"Body{i}", "id": None, "name": None} for i in range(1, n_solids + 1)]
    atomic_write(stage / OLD_NAMED, out)
    return {"ok": True, "named": named, "unverified": unverified, "faces": len(faces), "bodies": n_solids}


def original_record(geom_dir: Path | str, adopted: dict[str, Any], n_faces: Any, n_solids: Any) -> dict[str, Any]:
    """``link/original/original.json``: what the adopted geometry was imported from."""
    frm = adopted.get("from") or {}
    gdir = Path(geom_dir)
    path = original_dir(gdir) / "source.step"
    return {
        "file_name": frm.get("file_name"),
        "format": frm.get("format"),
        "sha256": frm.get("sha256"),
        "size": path.stat().st_size if path.is_file() else None,
        "faces": n_faces,
        "bodies": n_solids,
        "adopted_at": adopted.get("at"),
    }


def write_original(geom_dir: Path | str, adopted: dict[str, Any], n_faces: Any, n_solids: Any) -> None:
    atomic_write(original_dir(geom_dir) / ORIGINAL_JSON, original_record(geom_dir, adopted, n_faces, n_solids))


def original_files(geom_dir: Path | str) -> list[str]:
    """The files of a plain geometry an adoption keeps (its STEP, its sidecar, the file the user imported)."""
    gdir = Path(geom_dir)
    names = [n for n in SOURCE_FILES if (gdir / n).is_file()]
    try:
        names += sorted(p.name for p in gdir.iterdir() if p.is_file() and ORIGINAL_RE.match(p.name))
    except OSError:
        pass
    return names


def original_import(root: Path, geometry_id: str) -> dict[str, Any]:
    """Where an adopted geometry's original is, to import it again as a new geometry."""
    geom = find(Path(root), geometry_id)
    if geom is None:
        raise ActionError("gone", "That geometry was removed.")
    gdir = Path(geom["dir"])
    orig = read_original(gdir)
    step = original_dir(gdir) / "source.step"
    if orig is None or not step.is_file():
        raise ActionError("no_source", "This geometry keeps no original file.")
    name = str(orig.get("file_name") or "") or f"{display_name(geom)}.step"
    kept = [original_dir(gdir) / n for n in original_files(original_dir(gdir)) if ORIGINAL_RE.match(n)]
    # The file the user imported when it is still there (an IGES keeps its own), else the STEP.
    path = kept[0] if kept and Path(name).suffix.lower() == kept[0].suffix.lower() else step
    ext = path.suffix.lower() if path != step else ".step"
    # Its name says what it is beside the edited geometry ("box (original)").
    return {"ok": True, "path": str(path), "file_name": f"{Path(name).stem} (original){ext}"}
