"""The record rewrite of a linked geometry's update (host API 1.5, proposal 5.12 to 5.14).

An update that moves the geometry's rev rewrites, once, every face- or body-carrying
record of every study on the geometry, and every copy of each record:

| kind | files (every copy) | label fields |
|---|---|---|
| ``bc`` | ``boundary_conditions/BC_*/bc.json``; rows of ``boundary_conditions.json`` | ``faces``, ``face``, ``assigned_faces``, schema fields |
| ``material`` | ``materials/Material_*/material.json``; rows and ``air`` of ``materials.json`` | ``assigned_volumes``, ``assigned_volume``, ``body_ids``, ``volume_ids`` |
| ``result_control`` | ``result_controls/RC_*/result_control.json``; rows and slots of ``result_controls.json``, ``area_average.json`` | ``faces``, schema fields |
| ``refinement`` | every mesh's ``refinements/Ref_*/refinement.json``; rows of its ``refinements.json`` and the study's ``mesh_refinements.json`` | ``faces``, ``face``, ``volume_ids``, integer ``face_ids``, ``start_face_ids``, ``end_face_ids`` |
| ``mesh_doc`` | ``<mesh>/mesh.json`` | its mesher's schema fields under ``settings.mesher_settings`` |
| ``run_doc`` | a draft run's ``run.json`` | particle-trace seed faces of ``views`` and ``current_view`` |
| ``run_result_control`` | a draft run's ``result_controls/RC_*/result_control.json``; rows of its ``run.json`` | ``faces``, schema fields |

:func:`plan` works out every patch and writes ``<staging>/plan.json`` (nothing else);
:func:`apply` writes them, finding each record again by its ids, with
:func:`patch_write`, which never creates a folder or a file. A patch sets only the
label fields, ``lost_faces`` and ``geometry_rev``; every other key keeps its value.

A face the map cannot place goes into the record's ``lost_faces`` with its name,
label, body and fingerprint, and comes back when a later update finds it again.
Two boundary conditions whose faces merge into one keep neither (``claimed_twice``)
unless they already shared it. A record stamped below the update's ``from_rev`` is not
mapped: its labels become ``stale`` entries.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

FACE_RE = re.compile(r"^\s*face\s*(\d+)\s*(?:@\s*Body\s*(\d+))?\s*$", re.I)
BODY_RE = re.compile(r"^\s*Body\s*(\d+)\s*$", re.I)
DRAFT_RUN = {"", "draft", "idle"}
# A finished run is history (D8); every other run can still start (a stopped, failed or
# stale running one too), so its labels feed its next case and are rewritten like a draft's.
FINISHED_RUN = {"done", "finished"}


def run_is_setup(status: Any) -> bool:
    """A run whose labels the rewrite updates: every run but a finished one."""
    return str(status or "") not in FINISHED_RUN
# Aggregate files per kind: (file under the study or mesh folder, where).
_KINDS = ("bc", "material", "result_control", "refinement", "mesh_doc", "run_doc", "run_result_control")


class RewriteError(Exception):
    pass


# ---- labels ---------------------------------------------------------------------------


def face_index(label: Any) -> int | None:
    m = FACE_RE.match(str(label or ""))
    return int(m.group(1)) if m else None


def face_label(index: int, body: int | None) -> str:
    return f"face {int(index)}@Body{int(body or 1)}"


def _get(doc: Any, path: tuple) -> Any:
    cur = doc
    for p in path:
        if isinstance(p, int):
            if not isinstance(cur, list) or p >= len(cur):
                return None
            cur = cur[p]
        else:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(p)
    return cur


def _set(doc: Any, path: tuple, value: Any) -> bool:
    """Set a nested value; False when a parent is missing (nothing is created)."""
    cur = doc
    for p in path[:-1]:
        if isinstance(p, int):
            if not isinstance(cur, list) or p >= len(cur):
                return False
            cur = cur[p]
        else:
            if not isinstance(cur, dict) or not isinstance(cur.get(p), (dict, list)):
                return False
            cur = cur[p]
    last = path[-1]
    if isinstance(last, int):
        if not isinstance(cur, list) or last >= len(cur):
            return False
        cur[last] = value
        return True
    if not isinstance(cur, dict):
        return False
    cur[last] = value
    return True


def path_key(path: tuple) -> str:
    return ".".join(str(p) for p in path)


def key_path(key: str) -> tuple:
    return tuple(int(p) if p.isdigit() else p for p in str(key).split("."))


# ---- the two face tables and the map ---------------------------------------------------


def _read(path: Path) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


@dataclass
class Table:
    faces: dict[int, dict[str, Any]]
    bodies: dict[str, dict[str, Any]]  # body label ("Body2") -> {ref, id, name, label}
    diag: float

    @staticmethod
    def load(meta_path: Path, state_bodies: list | None = None) -> Table:
        meta = _read(meta_path) or {}
        faces = {}
        for f in meta.get("faces") or []:
            if isinstance(f, dict) and isinstance(f.get("id"), int):
                faces[int(f["id"])] = f
        bodies: dict[str, dict[str, Any]] = {}
        for b in meta.get("body_info") or state_bodies or []:
            if isinstance(b, dict) and b.get("ref"):
                bodies[str(b["ref"])] = b
        if not bodies:
            n = int(meta.get("n_solids") or 1)
            bodies = {f"Body{i}": {"ref": f"Body{i}"} for i in range(1, n + 1)}
        b = meta.get("bounds") or {}
        try:
            span = [float(b["xmax"]) - float(b["xmin"]), float(b["ymax"]) - float(b["ymin"]), float(b["zmax"]) - float(b["zmin"])]
        except (KeyError, TypeError, ValueError):
            span = [0.0, 0.0, 0.0]
        return Table(faces, bodies, (span[0] ** 2 + span[1] ** 2 + span[2] ** 2) ** 0.5)

    def body_ref(self, index: int) -> str:
        f = self.faces.get(index) or {}
        return f"Body{int(f.get('body') or 1)}"

    def label_of(self, index: int) -> str:
        f = self.faces.get(index) or {}
        return face_label(index, f.get("body"))

    def body_name(self, ref: str) -> str | None:
        b = self.bodies.get(ref) or {}
        return b.get("name") or None


def same_face(a: dict[str, Any], b: dict[str, Any], diag: float) -> bool:
    """The fingerprint test of scripts/geometry-face-match.js sameFace."""
    try:
        ca, cb = a["centroid"], b["centroid"]
        d = sum((float(x) - float(y)) ** 2 for x, y in zip(ca, cb, strict=False)) ** 0.5
    except (KeyError, TypeError, ValueError):
        return False
    tol = max(1e-4 * diag, 1e-6)
    if not d <= tol:
        return False
    aa, ba = float(a.get("area") or 0), float(b.get("area") or 0)
    if not abs(aa - ba) <= 1e-3 * max(aa, ba, 1e-12):
        return False
    ta, tb = a.get("surface_type") or a.get("type"), b.get("surface_type") or b.get("type")
    if ta and tb and ta != tb:
        return False
    na, nb = a.get("normal"), b.get("normal")
    if isinstance(na, list) and isinstance(nb, list) and len(na) == 3 and len(nb) == 3:
        if not sum(float(x) * float(y) for x, y in zip(na, nb, strict=False)) >= 0.9999:
            return False
    return True


@dataclass
class FaceMap:
    """``<staging>/map.json`` with the two tables it was made from."""

    identity: bool
    faces: dict[int, list[str]]
    groups: dict[int, str]
    body_map: dict[str, str | None]
    old: Table
    new: Table
    report: dict[str, Any]

    @staticmethod
    def load(stage: Path, geom_dir: Path, state: dict[str, Any] | None) -> FaceMap:
        doc = _read(stage / "map.json") or {}
        # An adoption (API 1.7) maps from the original's face table with the page's names on it.
        named = stage / "old_named.json"
        old = Table.load(named if named.is_file() else Path(geom_dir) / "cad_preview.json", (state or {}).get("bodies"))
        new_meta = stage / "new" / "cad_preview.json"
        new = Table.load(new_meta) if new_meta.is_file() else old
        identity = bool(doc.get("identity"))
        faces: dict[int, list[str]] = {}
        for k, v in (doc.get("faces") or {}).items():
            if str(k).isdigit() and isinstance(v, list):
                faces[int(k)] = [str(x) for x in v]
        groups = {int(k): str(v) for k, v in (doc.get("groups") or {}).items() if str(k).isdigit()}
        body_map = {str(k): (str(v) if v else None) for k, v in (doc.get("body_map") or {}).items()}
        if identity and not body_map:
            body_map = {ref: ref for ref in old.bodies}
        return FaceMap(identity, faces, groups, body_map, old, new, doc.get("report") or {})

    def targets(self, index: int) -> list[str] | None:
        if self.identity:
            return [self.new.label_of(index)] if index in self.new.faces or not self.new.faces else None
        return self.faces.get(index)

    def old_info(self, index: int) -> dict[str, Any]:
        f = self.old.faces.get(index) or {}
        ref = self.old.body_ref(index)
        b = self.old.bodies.get(ref) or {}
        out: dict[str, Any] = {
            "name": f.get("name") or None,
            "label": f.get("label") or None,
            "body": b.get("name") or ref,
            "body_id": b.get("id") or None,
        }
        if isinstance(f.get("centroid"), list):
            out["fingerprint"] = {
                "centroid": f.get("centroid"),
                "area": f.get("area"),
                "normal": f.get("normal"),
                "type": f.get("surface_type"),
            }
        return out

    def new_body_for(self, body_id: Any, body_name: Any) -> str | None:
        """The new body a lost entry's body pairs with: by id, then by name."""
        if body_id:
            for ref, b in self.new.bodies.items():
                if b.get("id") and str(b["id"]) == str(body_id):
                    return ref
        if body_name:
            for ref, b in self.new.bodies.items():
                if (b.get("name") or ref) == str(body_name):
                    return ref
            # The old body's own label when it had no name ("Body2").
            if BODY_RE.match(str(body_name)) and str(body_name) in self.new.bodies:
                return str(body_name)
        return None

    def find_return(self, entry: dict[str, Any]) -> list[str]:
        """New face labels a lost face entry finds: by name in its paired body, else by fingerprint."""
        if entry.get("reason") == "stale":
            return []
        ref = self.new_body_for(entry.get("body_id"), entry.get("body"))
        if ref is None:
            return []
        pool = {i: f for i, f in self.new.faces.items() if f"Body{int(f.get('body') or 1)}" == ref}
        name = entry.get("name")
        if name:
            return [face_label(i, f.get("body")) for i, f in sorted(pool.items()) if f.get("name") == name]
        fp = entry.get("fingerprint")
        if isinstance(fp, dict):
            probe = {"centroid": fp.get("centroid"), "area": fp.get("area"), "normal": fp.get("normal"), "surface_type": fp.get("type")}
            hits = [i for i, f in pool.items() if same_face(probe, f, self.new.diag)]
            if len(hits) == 1:
                return [face_label(hits[0], pool[hits[0]].get("body"))]
        return []


# ---- records -----------------------------------------------------------------------------


@dataclass
class Copy:
    copy: str  # "record" or the aggregate file's name
    path: Path


@dataclass
class Record:
    kind: str
    study_id: str
    study_title: str
    id: str | None
    name: str
    registry_key: str | None
    doc: dict[str, Any]
    copies: list[Copy]
    mesh_id: str | None = None
    run_id: str | None = None
    adopt: bool = False  # a legacy row with no folder of its own
    fields: list[tuple[tuple, str]] = field(default_factory=list)  # (path, "face" | "body")

    @property
    def key(self) -> str:
        return f"{self.kind}|{self.study_id}|{self.mesh_id or ''}|{self.run_id or ''}|{self.id or ''}"


def _folder_rows(parent: Path, json_name: str) -> list[tuple[Path, dict[str, Any]]]:
    out: list[tuple[Path, dict[str, Any]]] = []
    if not parent.is_dir():
        return out
    for folder in sorted(p for p in parent.iterdir() if p.is_dir() and not p.name.startswith(".")):
        rec = _read(folder / json_name)
        if isinstance(rec, dict) and rec.get("id") is not None:
            out.append((folder / json_name, rec))
    return out


def _legacy_id(index: int) -> str:
    return f"bc-legacy-{index + 1}"


def _aggregate_rows(path: Path, kind: str) -> list[dict[str, Any]]:
    """Rows (with their ids) of every top-level list in an aggregate file."""
    doc = _read(path)
    if not isinstance(doc, dict):
        return []
    out = []
    for key, val in doc.items():
        if isinstance(val, list):
            for i, row in enumerate(val):
                if not isinstance(row, dict):
                    continue
                if row.get("id") is None:
                    if kind == "bc" and key in ("boundary_conditions", "bcs", "bcs_all"):
                        out.append({**row, "id": _legacy_id(i)})
                    continue
                out.append(row)
        elif isinstance(val, dict) and val.get("id") is not None:
            out.append(val)
    return out


def _add(records: dict[str, Record], rec: Record) -> None:
    have = records.get(rec.key)
    if have is None:
        records[rec.key] = rec
    elif all(c.path != rec.copies[0].path or c.copy != rec.copies[0].copy for c in have.copies):
        have.copies.extend(rec.copies)


def _collect(
    records: dict[str, Record],
    kind: str,
    study: dict[str, Any],
    folder_parent: Path,
    json_name: str,
    aggregates: list[Path],
    key_of: Callable[[dict[str, Any]], str | None],
    *,
    mesh_id: str | None = None,
    run_id: str | None = None,
) -> None:
    sid = str(study.get("id") or "")
    title = str(study.get("name") or sid)
    for path, doc in _folder_rows(folder_parent, json_name):
        _add(records, Record(kind, sid, title, str(doc["id"]), str(doc.get("name") or doc["id"]), key_of(doc), doc, [Copy("record", path)], mesh_id, run_id))
    for agg in aggregates:
        if not agg.is_file():
            continue
        for row in _aggregate_rows(agg, kind):
            rid = str(row["id"])
            if kind == "refinement" and mesh_id and str(row.get("mesh_id") or mesh_id) != mesh_id:
                continue
            if kind in ("bc", "material", "result_control") and row.get("simulation_id") and str(row["simulation_id"]) != sid:
                continue
            item = Record(kind, sid, title, rid, str(row.get("name") or rid), key_of(row), row, [Copy(agg.name, agg)], mesh_id, run_id)
            if item.key not in records:
                item.adopt = kind == "bc"
                records[item.key] = item
            else:
                _add(records, item)


def study_record_list(project_dir: Path, geometry_id: str, studies: list[str] | None = None) -> list[Record]:
    """Every face- or body-carrying record of the geometry's studies, with every copy."""
    from cfddesk.project.link import _bc_key, _mesher_key, monitor_key
    from cfddesk.project.paths import walk_meshes, walk_runs, walk_studies

    def rc_key(r: dict[str, Any]) -> str | None:
        kind = r.get("kind")
        return (monitor_key(kind) or None) if kind else None

    root = Path(project_dir)
    records: dict[str, Record] = {}
    for study in walk_studies(root, geometry_id):
        sid = str(study.get("id") or "")
        if studies is not None and sid not in studies:
            continue
        sdir = Path(study["dir"])
        _collect(records, "bc", study, sdir / "boundary_conditions", "bc.json", [sdir / "boundary_conditions.json"], _bc_key)
        _collect(records, "material", study, sdir / "materials", "material.json", [sdir / "materials.json"], lambda r: None)
        _collect(
            records,
            "result_control",
            study,
            sdir / "result_controls",
            "result_control.json",
            [sdir / "result_controls.json", sdir / "area_average.json"],
            rc_key,
        )
        for mesh in walk_meshes(root, sid):
            mid = str(mesh.get("id") or "")
            mdir = Path(mesh["dir"])
            _collect(
                records,
                "refinement",
                study,
                mdir / "refinements",
                "refinement.json",
                [mdir / "refinements.json", sdir / "mesh_refinements.json"],
                lambda r: None,
                mesh_id=mid,
            )
            doc = _read(mdir / "mesh.json")
            if isinstance(doc, dict):
                rec = Record("mesh_doc", sid, str(study.get("name") or sid), None, str(doc.get("name") or mesh.get("name") or mid), _mesher_key(doc) or None, doc, [Copy("record", mdir / "mesh.json")], mid)
                records[rec.key] = rec
        for run in walk_runs(root, sid):
            rid = str(run.get("id") or "")
            rdir = Path(run["dir"])
            doc = _read(rdir / "run.json")
            if not isinstance(doc, dict) or not run_is_setup(doc.get("status")):
                continue
            rec = Record("run_doc", sid, str(study.get("name") or sid), None, str(doc.get("name") or rid), None, doc, [Copy("record", rdir / "run.json")], run_id=rid)
            records[rec.key] = rec
            _collect(
                records,
                "run_result_control",
                study,
                rdir / "result_controls",
                "result_control.json",
                [rdir / "run.json"],
                rc_key,
                run_id=rid,
            )
    return list(records.values())


# ---- which fields hold labels -------------------------------------------------------------

_SETTINGS_BAGS = {"bc": ((), ("settings",), ("values",)), "result_control": ((), ("settings",), ("values",)), "run_result_control": ((), ("settings",), ("values",)), "mesh_doc": (("settings", "mesher_settings"),)}
_REGISTRY_OF = {"bc": "bc", "result_control": "monitor", "run_result_control": "monitor", "mesh_doc": "mesher"}


def label_fields(rec: Record, schema_fields: dict[str, dict[str, list[tuple[str, str]]]]) -> list[tuple[tuple, str]]:
    """``(path, 'face' | 'body')`` of every label field this record holds now."""
    doc = rec.doc
    out: list[tuple[tuple, str]] = []

    def have(path: tuple, what: str) -> None:
        if isinstance(_get(doc, path), (list, str)):
            out.append((path, what))

    if rec.kind == "bc":
        for k in ("faces", "assigned_faces", "face"):
            have((k,), "face")
    elif rec.kind == "material":
        for k in ("assigned_volumes", "body_ids", "volume_ids", "assigned_volume"):
            have((k,), "body")
    elif rec.kind in ("result_control", "run_result_control"):
        have(("faces",), "face")
    elif rec.kind == "refinement":
        for k in ("faces", "face"):
            have((k,), "face")
        have(("volume_ids",), "body")
    elif rec.kind == "run_doc":
        views = doc.get("views")
        bases: list[tuple] = [(("views", i)) for i in range(len(views))] if isinstance(views, list) else []
        if isinstance(doc.get("current_view"), dict):
            bases.append(("current_view",))
        for base in bases:
            have((*base, "pt", "faces"), "face")
            have((*base, "pt", "region", "face"), "face")
    reg = _REGISTRY_OF.get(rec.kind)
    if reg and rec.registry_key:
        for fkey, holds in (schema_fields.get(reg) or {}).get(rec.registry_key, []):
            for bag in _SETTINGS_BAGS.get(rec.kind, ((),)):
                path = (*bag, fkey)
                if path not in [p for p, _ in out]:
                    have(path, "body" if holds == "body" else "face")
    return out


# ---- the plan --------------------------------------------------------------------------------


@dataclass
class Ctx:
    fmap: FaceMap
    from_rev: int
    new_rev: int
    same_shape: bool
    group_holders: dict[str, dict[str, set[int]]]
    lost_rev: int


def _entry(ctx: Ctx, path: tuple, old: str, reason: str, *, body_label: bool = False, targets: list[str] | None = None) -> dict[str, Any]:
    e: dict[str, Any] = {"field": path_key(path), "old": old, "reason": reason, "lost_at_rev": ctx.lost_rev}
    if reason == "stale":
        e["name"] = None
        return e
    if body_label:
        b = ctx.fmap.old.bodies.get(old) or {}
        e.update({"name": b.get("name") or None, "label": b.get("label") or None, "body": b.get("name") or old, "body_id": b.get("id") or None})
    else:
        idx = face_index(old)
        e.update(ctx.fmap.old_info(idx) if idx is not None else {"name": None, "label": None})
    if targets:
        e["targets"] = list(targets)
    return e


def _map_face_list(ctx: Ctx, rec: Record, path: tuple, values: list[Any]) -> tuple[list[str], list[dict[str, Any]], dict[str, set[str]]]:
    """New labels of a face list, its lost entries, and new label -> the old labels behind it."""
    out: list[str] = []
    lost: list[dict[str, Any]] = []
    origin: dict[str, set[str]] = {}
    for v in values:
        label = str(v)
        idx = face_index(label)
        if idx is None:
            if label not in out:
                out.append(label)
            continue
        targets = ctx.fmap.targets(idx)
        group = ctx.fmap.groups.get(idx)
        if targets and group:
            holders = ctx.group_holders.get(group) or {}
            members = {i for i, g in ctx.fmap.groups.items() if g == group}
            if not (len(holders) == 1 and rec.key in holders and holders[rec.key] >= members):
                targets = None
        if not targets:
            lost.append(_entry(ctx, path, label, "gone"))
            continue
        for t in targets:
            origin.setdefault(t, set()).add(label)
            if t not in out:
                out.append(t)
    return out, lost, origin


def _nearest(ctx: Ctx, old_label: str, candidates: list[str]) -> str | None:
    if not candidates:
        return None
    idx = face_index(old_label)
    of = ctx.fmap.old.faces.get(idx or -1) or {}
    oc = of.get("centroid")
    if not isinstance(oc, list):
        return sorted(candidates, key=lambda c: face_index(c) or 0)[0]

    def dist(c: str) -> tuple[float, int]:
        nf = ctx.fmap.new.faces.get(face_index(c) or -1) or {}
        nc = nf.get("centroid")
        if not isinstance(nc, list):
            return (float("inf"), face_index(c) or 0)
        return (sum((float(a) - float(b)) ** 2 for a, b in zip(oc, nc, strict=False)), face_index(c) or 0)

    return min(candidates, key=dist)


def _map_body(ctx: Ctx, label: Any) -> str | None:
    s = str(label or "")
    if not BODY_RE.match(s):
        return s
    return ctx.fmap.body_map.get(s) if s in ctx.fmap.body_map else (s if ctx.fmap.identity else None)


@dataclass
class Planned:
    rec: Record
    values: dict[tuple, Any]
    lost: list[dict[str, Any]]
    origin: dict[tuple, dict[str, set[str]]]
    split: list[str] = field(default_factory=list)
    stale: bool = False
    # Entries this update made (lost now); the others came from earlier updates.
    fresh: list[dict[str, Any]] = field(default_factory=list)

    def lose(self, entry: dict[str, Any]) -> None:
        self.lost.append(entry)
        self.fresh.append(entry)


def _plan_record(ctx: Ctx, rec: Record) -> Planned:
    doc = rec.doc
    lost_old = [dict(e) for e in (doc.get("lost_faces") or []) if isinstance(e, dict)]
    p = Planned(rec, {}, lost_old, {})
    stamp = doc.get("geometry_rev")
    stale = isinstance(stamp, int) and not isinstance(stamp, bool) and stamp < ctx.from_rev
    if not stale and not ctx.same_shape:
        # An earlier entry's targets (claimed twice) are labels of the rev it was made at:
        # they follow the map like the record's own fields; one that cannot be placed goes.
        for e in lost_old:
            if isinstance(e.get("targets"), list):
                moved: list[str] = []
                for t in e["targets"]:
                    idx = face_index(t)
                    for nt in (ctx.fmap.targets(idx) or []) if idx is not None else []:
                        if nt not in moved:
                            moved.append(nt)
                e["targets"] = moved
    if stale:
        p.stale = True
        for path, _what in rec.fields:
            val = _get(doc, path)
            vals = val if isinstance(val, list) else ([val] if val else [])
            for v in vals:
                p.lose(_entry(ctx, path, str(v), "stale"))
            p.values[path] = [] if isinstance(val, list) else None
        return p
    if ctx.same_shape:
        for path, _what in rec.fields:
            val = _get(doc, path)
            p.values[path] = val
            if isinstance(val, list):
                p.origin[path] = {str(v): {str(v)} for v in val}
        return p
    singles: list[tuple[tuple, str]] = []
    for path, what in rec.fields:
        val = _get(doc, path)
        if what == "body":
            if isinstance(val, list):
                kept = []
                for v in val:
                    to = _map_body(ctx, v)
                    if to is None:
                        p.lose(_entry(ctx, path, str(v), "gone", body_label=True))
                    elif to not in kept:
                        kept.append(to)
                p.values[path] = kept
            else:
                singles.append((path, what))
            continue
        if isinstance(val, list):
            new, lost, origin = _map_face_list(ctx, rec, path, val)
            p.values[path] = new
            for e in lost:
                p.lose(e)
            p.origin[path] = origin
            for v in val:
                idx = face_index(v)
                t = ctx.fmap.targets(idx) if idx is not None else None
                if t and len(t) > 1:
                    p.split.append(path_key(path))
                    break
        else:
            singles.append((path, what))
    for path, what in singles:
        val = _get(doc, path)
        mirror = _mirror_of(rec.kind, path)
        if mirror is not None and mirror in p.values:
            lst = p.values[mirror]
            p.values[path] = lst[0] if lst else None
            continue
        if not val:
            p.values[path] = val
            continue
        if what == "body":
            to = _map_body(ctx, val)
            if to is None:
                p.lose(_entry(ctx, path, str(val), "gone", body_label=True))
            p.values[path] = to
            continue
        new, lost, origin = _map_face_list(ctx, rec, path, [val])
        for e in lost:
            p.lose(e)
        choice = _nearest(ctx, str(val), new)
        if len(new) > 1:
            p.split.append(path_key(path))
        p.values[path] = choice
        p.origin[path] = {choice: {str(val)}} if choice else {}
    return p


def _mirror_of(kind: str, path: tuple) -> tuple | None:
    if kind in ("bc", "refinement") and path == ("face",):
        return ("faces",)
    if kind == "material" and path == ("assigned_volume",):
        return ("assigned_volumes",)
    return None


def _bc_claims(planned: list[Planned], report: dict[str, Any], ctx: Ctx) -> None:
    """Faces that merged from faces held by different BCs of one study: nobody keeps them."""
    by_study: dict[str, list[Planned]] = {}
    for p in planned:
        if p.rec.kind == "bc" and not p.stale:
            by_study.setdefault(p.rec.study_id, []).append(p)
    for sid, bcs in by_study.items():
        claims: dict[str, list[Planned]] = {}
        for p in bcs:
            held: set[str] = set()
            for vals in p.values.values():
                if isinstance(vals, list):
                    held.update(str(v) for v in vals)
            for f in held:
                claims.setdefault(f, []).append(p)
        for f, owners in claims.items():
            if len(owners) < 2:
                continue
            olds = [set().union(*[o.get(f, set()) for o in p.origin.values()]) for p in owners]
            shared = set.intersection(*olds) if olds else set()
            if shared:
                continue
            for p in owners:
                for path, vals in list(p.values.items()):
                    if isinstance(vals, list) and f in vals:
                        p.values[path] = [v for v in vals if v != f]
                        for old in sorted(p.origin.get(path, {}).get(f, set())):
                            p.lose(_entry(ctx, path, old, "claimed_twice", targets=[f]))
                mirror = ("face",)
                if mirror in p.values:
                    lst = p.values.get(("faces",)) or []
                    p.values[mirror] = lst[0] if lst else None
            nf = ctx.fmap.new.faces.get(face_index(f) or -1) or {}
            report["claimed_twice"].append(
                {
                    "studyId": sid,
                    "studyTitle": owners[0].rec.study_title,
                    "target": f,
                    "name": nf.get("name") or None,
                    "label": nf.get("label") or None,
                    "items": sorted(p.rec.name for p in owners),
                }
            )


def _returns(planned: list[Planned], report: dict[str, Any], ctx: Ctx) -> None:
    """Lost entries that find their face (or body) again go back on their field."""
    bc_holds: dict[str, dict[str, set[str]]] = {}
    for p in planned:
        if p.rec.kind == "bc":
            for vals in p.values.values():
                if isinstance(vals, list):
                    for v in vals:
                        bc_holds.setdefault(p.rec.study_id, {}).setdefault(str(v), set()).add(p.rec.key)
    # BC entries per study and new face: decided together.
    bc_finds: dict[tuple[str, str], list[tuple[Planned, dict[str, Any]]]] = {}
    # The faces each entry found in this update (its targets, if it stays claimed twice).
    finds_of: dict[int, set[str]] = {}
    for p in planned:
        if p.stale:
            continue
        kept: list[dict[str, Any]] = []
        for e in p.lost:
            if any(e is x for x in p.fresh):
                kept.append(e)  # lost by this very update
                continue
            path = key_path(str(e.get("field") or ""))
            is_body = p.rec.kind == "material" or any(path == fp and w == "body" for fp, w in p.rec.fields)
            if is_body:
                ref = ctx.fmap.new_body_for(e.get("body_id"), e.get("body") or e.get("old"))
                if ref and _put_back(p, path, ref):
                    report["returned"].append(_lost_face(p, e))
                    continue
                kept.append(e)
                continue
            found = ctx.fmap.find_return(e)
            if not found:
                kept.append(e)
                continue
            if p.rec.kind == "bc":
                for f in found:
                    bc_finds.setdefault((p.rec.study_id, f), []).append((p, e))
                    finds_of.setdefault(id(e), set()).add(f)
                kept.append(e)  # decided below
                continue
            if _put_back(p, path, *found):
                report["returned"].append(_lost_face(p, e))
            else:
                kept.append(e)
        p.lost = kept
    for (sid, f), finds in bc_finds.items():
        finders = {p.rec.key for p, _e in finds}
        holders = bc_holds.get(sid, {}).get(f, set())
        if holders - finders:
            for _p, e in finds:
                e["reason"] = "held_elsewhere"
            continue
        one_loss = len({(e.get("old"), e.get("lost_at_rev")) for _p, e in finds}) == 1
        if len(finders) > 1 and not one_loss:
            for _p, e in finds:
                e["reason"] = "claimed_twice"
                # Labels of this rev only: what the entry found now, never an older rev's.
                e["targets"] = sorted(finds_of.get(id(e)) or {f})
            continue
        for p, e in finds:
            path = key_path(str(e.get("field") or ""))
            if _put_back(p, path, f) and e in p.lost:
                p.lost.remove(e)
                report["returned"].append(_lost_face(p, e))


def _put_back(p: Planned, path: tuple, *labels: str) -> bool:
    cur = p.values.get(path, _get(p.rec.doc, path))
    if isinstance(cur, list):
        p.values[path] = cur + [x for x in labels if x not in cur]
        mirror = {("faces",): ("face",), ("assigned_volumes",): ("assigned_volume",)}.get(path)
        if mirror and (mirror in p.values or _get(p.rec.doc, mirror) is not None or p.rec.kind in ("bc", "refinement", "material")):
            p.values[mirror] = p.values[path][0] if p.values[path] else None
        return True
    if not cur:
        p.values[path] = labels[0]
        return True
    return False


def _lost_face(p: Planned, e: dict[str, Any]) -> dict[str, Any]:
    """A lost entry as LostFace (the SDK's shape)."""
    return {
        "studyId": p.rec.study_id,
        "studyTitle": p.rec.study_title,
        "kind": p.rec.kind,
        "registryKey": p.rec.registry_key,
        "item": p.rec.name,
        "field": e.get("field"),
        "old": e.get("old"),
        "name": e.get("name"),
        "label": e.get("label"),
        "reason": e.get("reason"),
    }


def _int_ids(rec: Record, values: dict[tuple, Any], ctx: Ctx) -> dict[tuple, Any]:
    """A refinement's integer face ids, recomputed from its new labels as the mesher converts them."""
    out: dict[tuple, Any] = {}
    if rec.kind != "refinement":
        return out
    from cfddesk.mesh.web_refinements import web_face_to_cfddesk

    doc = rec.doc
    if isinstance(doc.get("face_ids"), list):
        labels = values.get(("faces",), doc.get("faces") or [])
        ids = []
        for lab in labels or []:
            try:
                ids.append(web_face_to_cfddesk(lab))
            except ValueError:
                continue
        out[("face_ids",)] = ids
    for key in ("start_face_ids", "end_face_ids"):
        raw = doc.get(key)
        if not isinstance(raw, list):
            continue
        ids = []
        for old_id in raw:
            try:
                idx = int(old_id) + 1
            except (TypeError, ValueError):
                continue
            for t in (ctx.fmap.targets(idx) or []) if not ctx.same_shape else [face_label(idx, None)]:
                n = (face_index(t) or 0) - 1
                if n >= 0 and n not in ids:
                    ids.append(n)
        out[(key,)] = ids
    return out


def build_plan(
    project_dir: Path,
    geometry_id: str,
    geom_dir: Path,
    stage: Path,
    state: dict[str, Any],
    from_rev: int,
    same_shape: bool,
    schema_fields: dict[str, dict[str, list[tuple[str, str]]]],
    studies: list[str] | None = None,
    rev: int | None = None,
) -> dict[str, Any]:
    """The patches and the report of an update (or of a save-as-new copy with ``studies``)."""
    fmap = FaceMap.load(stage, geom_dir, state)
    recs = study_record_list(project_dir, geometry_id, studies)
    for r in recs:
        r.fields = label_fields(r, schema_fields)
    # Ambiguous name groups: which records hold which of their old faces.
    group_holders: dict[str, dict[str, set[int]]] = {}
    for r in recs:
        for path, what in r.fields:
            if what != "face":
                continue
            val = _get(r.doc, path)
            for v in val if isinstance(val, list) else [val]:
                idx = face_index(v)
                g = fmap.groups.get(idx) if idx is not None else None
                if g:
                    group_holders.setdefault(g, {}).setdefault(r.key, set()).add(int(idx or 0))
    provisional_rev = int(rev) if rev is not None else int(from_rev) + 1
    ctx = Ctx(fmap, int(from_rev), provisional_rev, bool(same_shape), group_holders, provisional_rev)
    report: dict[str, Any] = {
        "lost": [],
        "returned": [],
        "split": [],
        "merged": [],
        "moved_far": list((fmap.report or {}).get("moved_far") or []),
        "claimed_twice": [],
        "stale": [],
        "match": (fmap.report or {}).get("match") or {"byName": 0, "byShape": 0, "split": 0, "merged": 0, "movedFar": 0},
    }
    planned = [_plan_record(ctx, r) for r in recs]
    if not same_shape:
        _bc_claims(planned, report, ctx)
    _returns(planned, report, ctx)
    returned_any = bool(report["returned"])
    change = "shape" if not same_shape else ("faces" if returned_any else "names")
    new_rev = int(rev) if rev is not None else (int(from_rev) if change == "names" else int(from_rev) + 1)
    patches: list[dict[str, Any]] = []
    still = 0
    for p in planned:
        for e in p.fresh:
            if e.get("reason") != "stale" and any(e is x for x in p.lost):
                report["lost"].append(_lost_face(p, e))
        still += len(p.lost)
        if p.stale:
            report["stale"].append({"studyId": p.rec.study_id, "studyTitle": p.rec.study_title, "item": p.rec.name, "kind": p.rec.kind})
        for f in p.split:
            report["split"].append({"studyId": p.rec.study_id, "studyTitle": p.rec.study_title, "item": p.rec.name, "field": f})
        if change == "names":
            continue
        if not p.rec.fields and p.rec.kind in ("mesh_doc",):
            continue
        values = {**p.values, **_int_ids(p.rec, p.values, ctx)}
        sets: dict[str, Any] = {path_key(k): v for k, v in values.items()}
        sets["lost_faces"] = p.lost
        sets["geometry_rev"] = new_rev
        for c in p.rec.copies:
            patches.append(
                {
                    "study": p.rec.study_id,
                    "mesh": p.rec.mesh_id,
                    "run": p.rec.run_id,
                    "kind": p.rec.kind,
                    "id": p.rec.id,
                    "copy": c.copy,
                    "row_id": p.rec.id if c.copy != "record" else None,
                    "slot": None,
                    "adopt": p.rec.adopt,
                    "set": sets,
                }
            )
    report["still_lost"] = still
    report["merged"] = list((fmap.report or {}).get("merged") or [])
    report["setup"] = _setup_report(planned, ctx)
    report["out_of_date"] = _out_of_date(project_dir, geometry_id, studies) if change != "names" else {"meshes": [], "runs": 0}
    return {"change": change, "rev": new_rev, "patches": patches, "report": report}


def _inside_report(planned: list[Planned], ctx: Ctx, out: dict[str, list[dict[str, Any]]]) -> None:
    """Boundary conditions now on a face two bodies share (the new face table's ``shared_with``):
    that face is inside the part, so the boundary condition is not used there (5.14, API 1.7)."""
    for p in planned:
        if p.stale or p.rec.kind != "bc":
            continue
        faces: list[str] = []
        for path, what in p.rec.fields:
            if what != "face" or _mirror_of(p.rec.kind, path) is not None:
                continue
            now = p.values.get(path)
            for v in now if isinstance(now, list) else ([now] if now else []):
                idx = face_index(v)
                nf = ctx.fmap.new.faces.get(idx or -1) or {}
                if isinstance(nf.get("shared_with"), int) and not isinstance(nf.get("shared_with"), bool) and str(v) not in faces:
                    faces.append(str(v))
        if faces:
            out["inside"].append({"studyId": p.rec.study_id, "studyTitle": p.rec.study_title, "kind": p.rec.kind, "item": p.rec.name, "faces": faces, "bodies": 2})


def _setup_report(planned: list[Planned], ctx: Ctx) -> dict[str, list[dict[str, Any]]]:
    """What of a shape change touches the user's setup (the host's report, 5.14).

    Only faces a record refers to count: each face a boundary condition, refinement,
    monitor or view holds that moved far (kept by name), split into several faces, or
    became one face with others, listed with its record. A face no record refers to is
    never reported, however far it moved. Lost and claimed-twice faces are reported by
    their own lists; a face of an ambiguous name group is neither split nor merged.
    """
    out: dict[str, list[dict[str, Any]]] = {"moved_far": [], "split": [], "merged": [], "inside": []}
    if ctx.same_shape:
        return out
    _inside_report(planned, ctx, out)
    rep = ctx.fmap.report or {}
    moved = {face_index(m.get("old")) for m in rep.get("moved_far") or [] if isinstance(m, dict)}
    merged = {str(m.get("target")): int(m.get("faces") or 0) for m in rep.get("merged") or [] if isinstance(m, dict)}
    for p in planned:
        if p.stale:
            continue
        seen: set[tuple[str, str]] = set()
        for path, what in p.rec.fields:
            # A single field mirrored from a list (a BC's `face`) is the same face again.
            if what != "face" or _mirror_of(p.rec.kind, path) is not None:
                continue
            val = _get(p.rec.doc, path)
            now = p.values.get(path)
            held = {str(x) for x in (now if isinstance(now, list) else [now] if now else [])}
            for v in val if isinstance(val, list) else ([val] if val else []):
                idx = face_index(v)
                targets = ctx.fmap.targets(idx) if idx is not None else None
                if idx is None or not targets:
                    continue
                info = ctx.fmap.old_info(idx)
                base = {
                    "studyId": p.rec.study_id,
                    "studyTitle": p.rec.study_title,
                    "kind": p.rec.kind,
                    "item": p.rec.name,
                    "field": path_key(path),
                    "old": str(v),
                    "name": info.get("name"),
                    "label": info.get("label"),
                }
                if idx in moved and ("moved", str(v)) not in seen:
                    seen.add(("moved", str(v)))
                    out["moved_far"].append(dict(base))
                if idx in ctx.fmap.groups:
                    continue
                if len(targets) > 1 and ("split", str(v)) not in seen:
                    seen.add(("split", str(v)))
                    out["split"].append({**base, "faces": len(targets)})
                elif len(targets) == 1 and merged.get(targets[0], 0) > 1 and targets[0] in held and ("merged", targets[0]) not in seen:
                    # Once per record and merged face (a record that held both halves).
                    seen.add(("merged", targets[0]))
                    nf = ctx.fmap.new.faces.get(face_index(targets[0]) or -1) or {}
                    out["merged"].append({**base, "target": targets[0], "targetLabel": nf.get("label") or nf.get("name") or None, "faces": merged[targets[0]]})
    return out


def _out_of_date(project_dir: Path, geometry_id: str, studies: list[str] | None) -> dict[str, Any]:
    """Generated meshes (built from an older rev) and runs that are not drafts."""
    from cfddesk.project.paths import walk_meshes, walk_runs, walk_studies

    meshes = []
    runs = 0
    for study in walk_studies(Path(project_dir), geometry_id):
        sid = str(study.get("id") or "")
        if studies is not None and sid not in studies:
            continue
        for m in walk_meshes(Path(project_dir), sid):
            if m.get("generated"):
                meshes.append({"studyId": sid, "studyTitle": str(study.get("name") or sid), "meshId": str(m.get("id") or ""), "meshName": str(m.get("name") or "Mesh")})
        runs += sum(1 for r in walk_runs(Path(project_dir), sid) if str(r.get("status") or "") not in DRAFT_RUN)
    return {"meshes": meshes, "runs": runs}


# ---- apply ------------------------------------------------------------------------------------


def patch_write(path: Path, change: Callable[[dict[str, Any]], bool]) -> bool:
    """Read ``path``, apply ``change`` and replace it atomically; never creates a folder or file.

    False when ``change`` says nothing applies (its row is gone). Raises OSError when the
    file is not there or the write fails (a folder that moved or went, a held file): a
    moved folder and a deleted one look the same here, so the caller resolves the
    record's ids again and either finds it elsewhere or skips it.
    """
    from cfddesk.project.web_writes import _is_replace_lock

    if not path.is_file():
        raise FileNotFoundError(path)
    doc = _read(path)
    if not isinstance(doc, dict):
        return False
    if not change(doc):
        return False
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        for attempt in range(8):
            if not path.is_file():
                raise FileNotFoundError(path)
            try:
                os.replace(tmp, path)
                return True
            except OSError as exc:
                if not _is_replace_lock(exc) or attempt == 7:
                    raise
                time.sleep(0.05 * (attempt + 1))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return False


def apply_sets(doc: dict[str, Any], sets: dict[str, Any]) -> bool:
    for key, value in sets.items():
        _set(doc, key_path(key), value)
    return True


def _rows_change(rid: str, kind: str, sets: dict[str, Any]) -> Callable[[dict[str, Any]], bool]:
    def change(doc: dict[str, Any]) -> bool:
        hit = False
        for key, val in doc.items():
            if isinstance(val, list):
                for i, row in enumerate(val):
                    if not isinstance(row, dict):
                        continue
                    row_id = row.get("id")
                    if row_id is None and kind == "bc" and key in ("boundary_conditions", "bcs", "bcs_all"):
                        row_id = _legacy_id(i)
                    if str(row_id) == rid:
                        apply_sets(row, sets)
                        hit = True
            elif isinstance(val, dict) and str(val.get("id")) == rid and key not in ("defaults", "defaults_by_simulation"):
                apply_sets(val, sets)
                hit = True
        return hit

    return change


class Finder:
    """The record lookups of one apply, each made once (a study's folder, its meshes and
    runs, each record folder's ids). Dropped and made again when a write fails."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.studies: dict[str, Any] = {}
        self.meshes: dict[tuple[str, str], Any] = {}
        self.runs: dict[tuple[str, str], Any] = {}
        self.folders: dict[tuple[str, str], dict[str, Path]] = {}

    def study(self, sid: Any) -> Any:
        from cfddesk.project.paths import walk_studies

        if not self.studies:
            self.studies = {str(st.get("id")): st for st in walk_studies(self.root)}
        return self.studies.get(str(sid or ""))

    def mesh(self, mid: Any, sid: str) -> Any:
        from cfddesk.project.paths import walk_meshes

        if not any(k[1] == sid for k in self.meshes):
            for m in walk_meshes(self.root, sid):
                self.meshes[(str(m.get("id")), sid)] = m
            self.meshes.setdefault(("", sid), None)
        return self.meshes.get((str(mid or ""), sid))

    def run(self, rid: Any, sid: str) -> Any:
        from cfddesk.project.paths import walk_runs

        if not any(k[1] == sid for k in self.runs):
            for r in walk_runs(self.root, sid):
                self.runs[(str(r.get("id")), sid)] = r
            self.runs.setdefault(("", sid), None)
        return self.runs.get((str(rid or ""), sid))

    def record_path(self, parent: Path, json_name: str, rid: str) -> Path | None:
        key = (str(parent), json_name)
        if key not in self.folders:
            self.folders[key] = {str(rec.get("id")): path for path, rec in _folder_rows(parent, json_name)}
        return self.folders[key].get(rid)


def resolve(project_dir: Path, patch: dict[str, Any], finder: Finder | None = None) -> list[tuple[Path, Callable[[dict[str, Any]], bool]]]:
    """Where a patch writes now, found again by its ids ([] when the record is gone)."""
    root = Path(project_dir)
    find = finder or Finder(root)
    study = find.study(patch.get("study"))
    if not study:
        return []
    sdir = Path(study["dir"])
    kind = str(patch.get("kind"))
    copy = str(patch.get("copy"))
    rid = str(patch.get("id") or "")
    sets = patch.get("set") or {}
    base = sdir
    folder_parent = None
    json_name = ""
    if kind == "bc":
        folder_parent, json_name = sdir / "boundary_conditions", "bc.json"
    elif kind == "material":
        folder_parent, json_name = sdir / "materials", "material.json"
    elif kind == "result_control":
        folder_parent, json_name = sdir / "result_controls", "result_control.json"
    elif kind in ("refinement", "mesh_doc"):
        mesh = find.mesh(patch.get("mesh"), str(study.get("id")))
        if not mesh:
            return []
        base = Path(mesh["dir"])
        if kind == "mesh_doc":
            return [(base / "mesh.json", lambda d: apply_sets(d, sets))]
        folder_parent, json_name = base / "refinements", "refinement.json"
    elif kind in ("run_doc", "run_result_control"):
        run = find.run(patch.get("run"), str(study.get("id")))
        if not run:
            return []
        base = Path(run["dir"])
        if kind == "run_doc":
            return [(base / "run.json", lambda d: apply_sets(d, sets))]
        folder_parent, json_name = base / "result_controls", "result_control.json"
    else:
        return []
    out: list[tuple[Path, Callable[[dict[str, Any]], bool]]] = []
    folder_hit = find.record_path(folder_parent, json_name, rid)
    if copy == "record":
        if folder_hit:
            out.append((folder_hit, lambda d: apply_sets(d, sets)))
        return out
    agg = (sdir if copy == "mesh_refinements.json" else base) / copy
    if agg.is_file():
        out.append((agg, _rows_change(rid, kind, sets)))
    if patch.get("adopt") and folder_hit:
        # A legacy row adopted into a folder since the plan: its new folder record too.
        out.append((folder_hit, lambda d: apply_sets(d, sets)))
    return out
