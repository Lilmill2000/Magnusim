"""Helpers over a study's records: boundary conditions, materials, result controls.

The records are the app's own JSON (a BC has ``name``, ``bc_type``, ``faces``,
...). Mesh patches are named from BC names the same way the mesher names them.
Standard library only.
"""

from __future__ import annotations

import re
from typing import Any


def sanitize_patch_name(label: str) -> str:
    """Non-alphanumerics to ``_``, collapsed and trimmed, lowercase; a leading digit gets ``p_``."""
    s = re.sub(r"[^A-Za-z0-9_]+", "_", str(label or ""))
    s = re.sub(r"_+", "_", s).strip("_").lower()
    if not s:
        return "patch"
    if s[0].isdigit():
        s = "p_" + s
    return s


def list_bc_records(bcs: dict | None) -> list[dict]:
    if not bcs:
        return []
    arr = bcs.get("boundary_conditions")
    if not isinstance(arr, list):
        return []
    return [b for b in arr if b]


def bc_faces(bc: dict | None) -> list[str]:
    if not bc:
        return []
    faces = list(bc.get("faces") or [])
    if bc.get("face") and bc["face"] not in faces:
        faces.append(bc["face"])
    return [f for f in faces if f]


def is_velocity_inlet(bc: dict | None) -> bool:
    return bool(re.search(r"velocity\s*inlet", str((bc or {}).get("bc_type") or ""), re.I))


def is_velocity_outlet(bc: dict | None) -> bool:
    return bool(re.search(r"velocity\s*outlet", str((bc or {}).get("bc_type") or ""), re.I))


def is_pressure_bc(bc: dict | None) -> bool:
    return bool(re.match(r"pressure", str((bc or {}).get("bc_type") or ""), re.I))


def is_wall_bc(bc: dict | None) -> bool:
    return str((bc or {}).get("bc_type") or "").strip().lower() == "wall"


def wall_treatment(rec: dict | None) -> str:
    """'Slip' or 'No-slip' for a wall BC record or a defaults object."""
    t = re.sub(r"[\s_-]+", "", str((rec or {}).get("wall_type") or "")).lower()
    return "Slip" if t == "slip" else "No-slip"


def matches_study(rec: dict | None, sim_id: str | None, legacy_id: str | None = None) -> bool:
    if not rec:
        return False
    sid = rec.get("simulation_id") or rec.get("study_id")
    if sid is None or sid == "":
        return True
    if sim_id is not None and str(sid) == str(sim_id):
        return True
    if legacy_id is not None and str(sid) == str(legacy_id):
        return True
    return False


def material_assigned(m: dict) -> bool:
    vols = m.get("assigned_volumes")
    return (isinstance(vols, list) and len(vols) > 0) or bool(m.get("assigned_volume"))


def study_fluid(materials: list) -> dict | None:
    """The study's one fluid: the material assigned to a volume, else one named Air, else the first."""
    rows = [m for m in materials if isinstance(m, dict)]
    return (
        next((m for m in rows if material_assigned(m)), None)
        or next((m for m in rows if re.search(r"air", str(m.get("name") or ""), re.I)), None)
        or (rows[0] if rows else None)
    )


def unique_numbered_patch(want: str, patch_names: set[str]) -> str | None:
    """``pressure_1`` matches ``pressure_1`` or a unique ``pressure_1_3`` from name collisions."""
    if want in patch_names:
        return want
    if not want:
        return None
    pat = re.compile(r"^" + re.escape(want) + r"(?:_\d+)?$")
    hits = [p for p in patch_names if pat.match(p)]
    if len(hits) == 1:
        return hits[0]
    return None


def map_bc_to_patch(bc: dict, patch_names: set[str], web_bcs: list[dict] | None = None) -> str:
    """The mesh patch a BC landed on: its own name, a face name, or a BC baked into the mesh."""
    want = sanitize_patch_name(str(bc.get("name") or ""))
    hit = unique_numbered_patch(want, patch_names)
    if hit:
        return hit
    for f in bc_faces(bc):
        hit = unique_numbered_patch(sanitize_patch_name(f), patch_names)
        if hit:
            return hit
    face_set = set(bc_faces(bc))
    for baked in web_bcs or []:
        if face_set & set(bc_faces(baked)):
            hit = unique_numbered_patch(sanitize_patch_name(str(baked.get("name") or "")), patch_names)
            if hit:
                return hit
    return want


def list_aa_faces(aa: dict | None) -> list[str]:
    """Faces named by the study's area-average result controls."""
    if not aa:
        return []
    recs: list[dict] = []
    if aa.get("area_average_1"):
        recs.append(aa["area_average_1"])
    if isinstance(aa.get("result_controls"), list):
        for rec in aa["result_controls"]:
            if not rec:
                continue
            kind = str(rec.get("kind") or "")
            name = str(rec.get("name") or "")
            if re.search(r"area average", kind, re.I) or re.search(r"area average", name, re.I):
                recs.append(rec)
    faces: list[str] = []
    for rec in recs:
        for f in rec.get("faces") or []:
            if f and f not in faces:
                faces.append(f)
    return faces


def run_custom_monitors(result_controls: list | None) -> list[dict[str, Any]]:
    """Area-average monitors a run carries (name + assigned faces), in order."""
    out: list[dict[str, Any]] = []
    for rec in result_controls or []:
        if not isinstance(rec, dict):
            continue
        label = " ".join(str(rec.get(k) or "") for k in ("kind", "type", "name", "category"))
        if not re.search(r"area average|surface data", label, re.I):
            continue
        faces = [str(f) for f in (rec.get("faces") or []) if f]
        if faces:
            out.append({"id": rec.get("id"), "name": str(rec.get("name") or "Monitor"), "faces": faces})
    return out
