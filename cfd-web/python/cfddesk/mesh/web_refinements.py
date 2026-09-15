"""cfd-web mesh refinements → mesher inputs (Standard + cfMesh).

Surface custom sizing: face_id → target edge length (m).
Inflate boundary layer: assigned wall faces become their own patch so
snappy / cfMesh can add prisms only there.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cfddesk.case.bc_menu import registry_key_for_bc
from cfddesk.case.bc_registry import get_type
from cfddesk.mesh.standard_hexcore import (
    BL_MIN_THICKNESS_FRACTION,
    LayerPatchSpec,
    standard_surface_size_m,
)
from cfddesk.project.model import Project


def size_to_metres(value: Any, unit: str) -> float:
    v = float(value)
    u = str(unit or "mm").strip().lower().replace(".", "")
    if u in ("m", "metre", "meter"):
        return v
    if u in ("cm", "centimetre", "centimeter"):
        return v * 0.01
    if u in ("in", "inch"):
        return v * 0.0254
    return v * 0.001


def web_face_to_cfddesk(label: str) -> int:
    """cfd-web ``face 10@Body1`` is OCCT 1-based; cfddesk face_id is 0-based."""
    m = re.search(r"face\s+(\d+)", str(label), flags=re.I)
    if not m:
        raise ValueError(f"unrecognized face label: {label!r}")
    web_id = int(m.group(1))
    if web_id < 1:
        raise ValueError(f"face label must be 1-based, got {label!r}")
    return web_id - 1


def parse_float(v: Any, default: float) -> float:
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def expansion_from_first_total(first: float, total: float, n: int) -> float:
    """Solve total = first * (r^n - 1) / (r - 1) for growth rate r ≥ 1."""
    if first <= 0 or total <= 0 or n < 1:
        return 1.5
    if n == 1:
        return 1.0
    target = total / first
    if target <= n:
        return 1.0
    lo, hi = 1.0, 10.0
    for _ in range(48):
        mid = 0.5 * (lo + hi)
        val = n if abs(mid - 1.0) < 1e-12 else (mid**n - 1.0) / (mid - 1.0)
        if val < target:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def geometric_series_total(first: float, expansion: float, n: int) -> float:
    """Sum of n layers starting at ``first`` with ratio ``expansion``."""
    n = max(1, int(n))
    if first <= 0:
        return 0.0
    if abs(float(expansion) - 1.0) < 1e-12:
        return float(first) * n
    return float(first) * (float(expansion) ** n - 1.0) / (float(expansion) - 1.0)


# Snappy's displacementMedialAxis shoves the volume (and the wall) off the CAD
# when the requested prism stack is thicker than the first volume cell. Cap
# relative to the local surface size (surface custom on those faces, else h_s).
INFLATE_MAX_TOTAL_VS_LOCAL = 2.0
INFLATE_MAX_FIRST_VS_LOCAL = 0.5


def local_h_for_faces(
    face_ids: list[int],
    h_surface_m: float,
    extra_face_sizes: dict[int, float] | None = None,
) -> float:
    extra = extra_face_sizes or {}
    vals = [float(extra[f]) for f in face_ids if f in extra and float(extra[f]) > 0]
    h = min(vals) if vals else float(h_surface_m)
    if not math.isfinite(h) or h <= 0:
        return 1e-3
    return h


def fit_inflate_to_local(
    n: int,
    expansion: float,
    thickness_m: float,
    first_layer_m: float | None,
    local_h: float,
    gradation: str,
) -> tuple[int, float, float, float | None, bool]:
    """Keep the requested stack inside ~2× the local first volume cell.

    Prefer dropping expansion toward 1.0, then layer count, then first layer.
    Returns ``(n, expansion, thickness_m, first_layer_m, capped)``.
    """
    if not math.isfinite(local_h) or local_h <= 0:
        return n, expansion, thickness_m, first_layer_m, False
    max_total = INFLATE_MAX_TOTAL_VS_LOCAL * local_h
    max_first = INFLATE_MAX_FIRST_VS_LOCAL * local_h
    n = max(1, int(n))
    exp = max(1.0, float(expansion))
    thick = float(thickness_m)
    first = first_layer_m
    capped = False
    first_and_total = gradation in ("first_and_total", "first_and_total_thickness")

    if first is not None and first > max_first + 1e-15:
        first = max_first
        capped = True
        if gradation == "first_layer":
            thick = geometric_series_total(first, exp, n)
        elif first_and_total and thick < first:
            thick = first

    if thick > max_total + 1e-15:
        capped = True
        if first is not None and first > 0:
            if first * n <= max_total + 1e-15:
                exp = expansion_from_first_total(first, max_total, n)
                thick = geometric_series_total(first, exp, n)
                if thick > max_total:
                    thick = max_total
            else:
                n = max(1, int(math.floor(max_total / first + 1e-12)))
                exp = 1.0
                if first * n > max_total + 1e-15:
                    first = max_total / n
                thick = first * n
        else:
            thick = max_total
    return n, exp, thick, first, capped


def _read_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _mesh_scoped(rec: dict, mesh_id: str) -> bool:
    want = str(mesh_id or "").strip()
    rid = str(rec.get("mesh_id") or "").strip()
    return not (want and rid and rid != want)


def _rec_labels(rec: dict) -> list[str]:
    labels = list(rec.get("faces") or [])
    if rec.get("face") and rec["face"] not in labels:
        labels.append(rec["face"])
    return [str(x) for x in labels if x]


def _labels_to_fids(labels: list[str], n_faces: int) -> tuple[list[int], list[str]]:
    fids: list[int] = []
    kept: list[str] = []
    for lab in labels:
        try:
            fid = web_face_to_cfddesk(lab)
        except ValueError:
            continue
        if fid < 0 or fid >= n_faces:
            continue
        fids.append(fid)
        kept.append(lab)
    return fids, kept


def is_surface_custom(rec: dict) -> bool:
    raw = str(rec.get("type") or rec.get("kind") or "").strip().lower()
    return raw in ("surface custom sizing", "surface_custom_sizing", "surface")


def is_inflate(rec: dict) -> bool:
    raw = str(rec.get("type") or rec.get("kind") or "").strip().lower()
    return raw in ("inflate boundary layer", "inflate_boundary_layer", "inflate")


def load_surface_custom_sizes(
    project_dir: Path, mesh_id: str, n_faces: int, diag_m: float
) -> tuple[dict[int, float], dict[int, float], list[dict]]:
    """W26 surface custom sizing → (target_m, min_m, notes) keyed by cfddesk face_id."""
    doc = _read_json(Path(project_dir) / "mesh_refinements.json")
    extra: dict[int, float] = {}
    mins: dict[int, float] = {}
    notes: list[dict] = []
    for rec in doc.get("refinements") or []:
        if not is_surface_custom(rec) or not _mesh_scoped(rec, mesh_id):
            continue
        labels = _rec_labels(rec)
        if not labels:
            continue
        if str(rec.get("sizing") or "Custom") == "Automatic":
            size_m = standard_surface_size_m(diag_m, int(rec.get("fineness") or 7))
        else:
            size_m = size_to_metres(
                rec.get("default_size") if rec.get("default_size") is not None else 2,
                rec.get("default_size_unit") or "mm",
            )
        min_m = size_to_metres(
            rec.get("min_size") if rec.get("min_size") is not None else 0,
            rec.get("min_size_unit") or rec.get("default_size_unit") or "mm",
        )
        if not math.isfinite(size_m) or size_m <= 0:
            continue
        if math.isfinite(min_m) and min_m > 0:
            size_m = max(size_m, min_m)
        else:
            min_m = 0.0
        fids, kept = _labels_to_fids(labels, n_faces)
        for fid in fids:
            prev = extra.get(fid)
            extra[fid] = size_m if prev is None else min(prev, size_m)
            if min_m > 0:
                prev_min = mins.get(fid)
                mins[fid] = min_m if prev_min is None else max(prev_min, min_m)
        if fids:
            notes.append(
                {
                    "name": rec.get("name"),
                    "size_m": size_m,
                    "min_size_m": min_m if min_m > 0 else None,
                    "face_ids": fids,
                    "faces": kept,
                }
            )
    return extra, mins, notes


@dataclass
class InflateRef:
    name: str
    face_ids: list[int]
    faces: list[str]
    n_layers: int
    expansion: float
    thickness_m: float
    first_layer_m: float | None
    min_thickness_m: float
    relative_thickness: float | None
    gradation: str
    patch_name: str | None = None
    skipped: str | None = None
    local_h_m: float = 0.0
    capped: bool = False


def inflate_from_record(
    rec: dict,
    h_surface_m: float,
    n_faces: int,
    extra_face_sizes: dict[int, float] | None = None,
) -> InflateRef | None:
    labels = _rec_labels(rec)
    fids, kept = _labels_to_fids(labels, n_faces)
    if not fids:
        return None
    local_h = local_h_for_faces(fids, h_surface_m, extra_face_sizes)
    n = max(1, int(parse_float(rec.get("n_layers"), 3)))
    grad = str(rec.get("gradation") or "growth_rate").strip().lower()
    # first_layer UI hides growth rate; the persisted default 1.5 must not
    # invent a geometric stack the user never typed.
    if grad == "first_layer":
        exp = 1.0
    else:
        exp = parse_float(rec.get("growth_rate"), 1.5)
        if exp < 1.0:
            exp = 1.0
    rel = parse_float(rec.get("overall_relative_thickness"), 0.4)
    if rel < 0.25:
        rel = 0.25
    first_m: float | None = None
    thick_m: float
    if grad == "first_layer":
        first_m = size_to_metres(
            rec.get("first_layer_thickness") if rec.get("first_layer_thickness") is not None else 0.1,
            rec.get("first_layer_unit") or "mm",
        )
        if not math.isfinite(first_m) or first_m <= 0:
            return None
        thick_m = geometric_series_total(first_m, exp, n)
    elif grad in ("first_and_total", "first_and_total_thickness"):
        first_m = size_to_metres(
            rec.get("first_layer_thickness") if rec.get("first_layer_thickness") is not None else 0.1,
            rec.get("first_layer_unit") or "mm",
        )
        thick_m = size_to_metres(
            rec.get("total_thickness") if rec.get("total_thickness") is not None else 1,
            rec.get("total_thickness_unit") or rec.get("first_layer_unit") or "mm",
        )
        if not math.isfinite(first_m) or first_m <= 0 or not math.isfinite(thick_m) or thick_m <= 0:
            return None
        if thick_m < first_m:
            thick_m = first_m
        exp = expansion_from_first_total(first_m, thick_m, n)
    else:
        thick_m = rel * local_h
        first_m = None
    n, exp, thick_m, first_m, capped = fit_inflate_to_local(
        n, exp, thick_m, first_m, local_h, grad
    )
    min_t = BL_MIN_THICKNESS_FRACTION * thick_m
    return InflateRef(
        name=str(rec.get("name") or "Inflate boundary layer"),
        face_ids=fids,
        faces=kept,
        n_layers=n,
        expansion=exp,
        thickness_m=thick_m,
        first_layer_m=first_m,
        min_thickness_m=min_t,
        relative_thickness=rel if grad == "growth_rate" else None,
        gradation=grad,
        local_h_m=local_h,
        capped=capped,
    )


def load_inflate_refs(
    project_dir: Path,
    mesh_id: str,
    n_faces: int,
    h_surface_m: float,
    extra_face_sizes: dict[int, float] | None = None,
) -> list[InflateRef]:
    doc = _read_json(Path(project_dir) / "mesh_refinements.json")
    out: list[InflateRef] = []
    for rec in doc.get("refinements") or []:
        if not is_inflate(rec) or not _mesh_scoped(rec, mesh_id):
            continue
        spec = inflate_from_record(rec, h_surface_m, n_faces, extra_face_sizes)
        if spec is not None:
            out.append(spec)
    return out


def _bc_is_wall(bc: Any) -> bool:
    try:
        return str(get_type(registry_key_for_bc(bc)).semantic).lower() == "wall"
    except Exception:
        return False


def assigned_face_ids(project: Project) -> set[int]:
    out: set[int] = set()
    for bc in project.boundary_conditions:
        out.update(int(f) for f in (bc.face_ids or []))
    return out


def bind_exclusive_wall_patch(
    project: Project,
    name: str,
    face_ids: list[int],
    n_faces: int,
    *,
    blocked: set[int] | None = None,
) -> tuple[Project, str | None]:
    """Ensure ``face_ids`` live on one wall patch; reuse an exact match."""
    blocked = blocked or set()
    fids = sorted({int(f) for f in face_ids if 0 <= int(f) < n_faces and int(f) not in blocked})
    if not fids:
        return project, None
    for bc in project.boundary_conditions:
        if _bc_is_wall(bc) and set(bc.face_ids or []) == set(fids):
            return project, str(bc.patch_name)
    project, bc = project.add_bc(name=name, bc_type="wall_noslip", face_ids=fids)
    return project, str(bc.patch_name)


def leftover_faces(project: Project, n_faces: int) -> list[int]:
    have = assigned_face_ids(project)
    return [f for f in range(n_faces) if f not in have]


def bind_inflate_patches(
    project: Project, specs: list[InflateRef], n_faces: int
) -> tuple[Project, list[InflateRef]]:
    """Give each inflate face group its own wall patch (or reuse an exact match).

    Inlet / outlet / pressure faces are skipped — layers only belong on walls.
    When two inflates share a face, the one with more layers wins.
    """
    if not specs:
        return project, []

    blocked: set[int] = set()
    for bc in project.boundary_conditions:
        if not _bc_is_wall(bc):
            blocked.update(int(f) for f in (bc.face_ids or []))

    owner: dict[int, InflateRef] = {}
    for spec in specs:
        wall_fids = [f for f in spec.face_ids if f not in blocked and 0 <= f < n_faces]
        if not wall_fids:
            spec.skipped = "no wall faces (inlet/outlet/pressure)"
            continue
        spec.face_ids = wall_fids
        for fid in wall_fids:
            prev = owner.get(fid)
            if prev is None or spec.n_layers > prev.n_layers:
                owner[fid] = spec

    groups: dict[int, list[int]] = {}
    spec_by_id = {id(s): s for s in specs}
    for fid, spec in owner.items():
        groups.setdefault(id(spec), []).append(fid)

    bound: list[InflateRef] = []
    for sid, fids in groups.items():
        spec = spec_by_id[sid]
        fids = sorted(set(fids))
        spec.face_ids = fids
        project, patch = bind_exclusive_wall_patch(project, spec.name, fids, n_faces)
        spec.patch_name = patch
        bound.append(spec)
    return project, bound


def bind_surface_custom_patches(
    project: Project, notes: list[dict], n_faces: int
) -> tuple[Project, list[dict]]:
    """Split leftover surface-custom faces onto named wall patches (cfMesh).

    Faces already on an Inflate / Wall BC stay there — we do not steal them
    off a layer patch. localRef then targets every owning patch.
    """
    blocked: set[int] = set()
    owner: dict[int, str] = {}
    for bc in project.boundary_conditions:
        for fid in bc.face_ids or []:
            owner[int(fid)] = str(bc.patch_name)
        if not _bc_is_wall(bc):
            blocked.update(int(f) for f in (bc.face_ids or []))
    out: list[dict] = []
    for note in notes:
        fids = [
            int(f)
            for f in (note.get("face_ids") or [])
            if 0 <= int(f) < n_faces and int(f) not in blocked
        ]
        free = [f for f in fids if f not in owner]
        patches: list[str] = []
        if free:
            project, patch = bind_exclusive_wall_patch(
                project,
                str(note.get("name") or "Surface custom"),
                free,
                n_faces,
            )
            if patch:
                patches.append(patch)
                for f in free:
                    owner[f] = patch
        patches.extend(sorted({owner[f] for f in fids if f in owner}))
        # unique, stable
        seen: set[str] = set()
        uniq: list[str] = []
        for p in patches:
            if p not in seen:
                seen.add(p)
                uniq.append(p)
        rec = dict(note)
        rec["patch"] = uniq[0] if len(uniq) == 1 else None
        rec["patches"] = uniq
        out.append(rec)
    return project, out


def layer_specs_for_generate(
    *,
    wall_patches: list[str],
    inflate: list[InflateRef],
    add_layers: bool,
    default_n: int,
    default_thickness_m: float,
    default_expansion: float,
    default_min_m: float,
) -> list[LayerPatchSpec]:
    """Automatic BL on leftover walls + inflate recipe on inflate patches."""
    inflate_names = {s.patch_name for s in inflate if s.patch_name}
    out: list[LayerPatchSpec] = []
    if add_layers:
        for name in wall_patches:
            if name in inflate_names:
                continue
            out.append(
                LayerPatchSpec(
                    name=name,
                    n_layers=int(default_n),
                    thickness_m=float(default_thickness_m),
                    expansion=float(default_expansion),
                    min_thickness_m=float(default_min_m),
                )
            )
    for spec in inflate:
        if not spec.patch_name or spec.patch_name not in wall_patches:
            continue
        grad = str(getattr(spec, "gradation", "") or "growth_rate").strip().lower()
        if grad == "first_layer":
            specify = "first"
        elif grad in ("first_and_total", "first_and_total_thickness"):
            specify = "first_and_total"
        else:
            specify = "total"
        out.append(
            LayerPatchSpec(
                name=spec.patch_name,
                n_layers=spec.n_layers,
                thickness_m=spec.thickness_m,
                first_layer_m=spec.first_layer_m,
                expansion=spec.expansion,
                min_thickness_m=spec.min_thickness_m,
                specify=specify,
            )
        )
    return out


def inflate_notes(specs: list[InflateRef]) -> list[dict]:
    return [
        {
            "name": s.name,
            "patch": s.patch_name,
            "n_layers": s.n_layers,
            "thickness_m": s.thickness_m,
            "first_layer_m": s.first_layer_m,
            "expansion": s.expansion,
            "gradation": s.gradation,
            "local_h_m": s.local_h_m,
            "capped": s.capped,
            "face_ids": s.face_ids,
            "faces": s.faces,
            "skipped": s.skipped,
        }
        for s in specs
    ]
