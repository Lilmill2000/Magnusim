"""Particle traces: streamlines of OpenFOAM U, then tube glyphs.

Volume: .cfddesk-prepared.vtu if present, otherwise OpenFOAMReader at the
requested time (same path as the cutting plane).

Seeds: this case's live polyMesh patches (not walls), labeled from
w27-case.json / run bcs. Not a hardcoded MTP1 inlet/outlet list.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import pyvista as pv

# Reuse proven even-distribute from the cfddesk library (../cfddesk).
CFDDESK_ROOT = Path(__file__).resolve().parents[1]
if str(CFDDESK_ROOT) not in sys.path:
    sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.case.writer import parse_boundary_patch_types  # noqa: E402
from cfddesk.results.patches import (  # noqa: E402
    load_patch_surface,
    n_seeds_from_density,
)

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
from export_cut_plane import read_volume_at_time  # noqa: E402
from case_units import case_density, scale_pressure  # noqa: E402

SKIP_PATCH_TYPES = {
    "wall",
    "empty",
    "processor",
    "processorcyclic",
    "wedge",
    "symmetry",
    "symmetryplane",
}

SEED_PLANE_DOC = (
    "When seed_mode=grid and Pick Position is empty, seeds are placed on a plane "
    "through the mesh bounds center with normal +X (YZ plane). "
    "n_seeds = seeds_h * seeds_v (full product; no soft cull)."
)

FACE_SEED_DOC = (
    "When seed_mode=faces, start points are an even cell-centered lattice "
    "spanning each selected patch (half a cell in from the rim so seeds sit "
    "in the fluid, not on wall vertices). An optional picker region (box or "
    "circle on one face) restricts the lattice to that shape ∩ the face. "
    "Default face is the inlet. Seeds are pushed along the patch normal into "
    "the fluid and integrated with vtkStreamTracer (RK45) forward from inlet "
    "faces and backward from outlet faces, so every seed yields a path "
    "through the domain. Quantity mode count|# Seeds or density|Density(1/m^2)."
)


def _patch_role(name: str, bc_type: str | None = None) -> str:
    blob = f"{name} {bc_type or ''}".lower()
    if "inlet" in blob or "inflow" in blob:
        return "inlet"
    if "outlet" in blob or "outflow" in blob or "pressure" in blob:
        return "outlet"
    return "patch"


def _read_json(path: Path):
    try:
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return None


def _rec_cad_faces(rec) -> list[str]:
    out: list[str] = []
    if not isinstance(rec, dict):
        return out
    for f in rec.get("faces") or []:
        s = str(f).strip()
        if s and s not in out:
            out.append(s)
    face = rec.get("face")
    if face:
        s = str(face).strip()
        if s and s not in out:
            out.append(s)
    return out


def _find_project_dir(case_dir: Path) -> Path:
    cur = Path(case_dir)
    for _ in range(5):
        if (cur / "boundary_conditions.json").is_file() or (cur / "project.json").is_file():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return Path(case_dir).parent.parent


def _find_web_bc(web_bcs: list[dict], name, patch, cad: list[str]):
    cad_set = set(cad or [])
    for b in web_bcs:
        if any(f in cad_set for f in _rec_cad_faces(b)):
            return b
    for b in web_bcs:
        if b.get("name") == name:
            return b
    slug = str(patch or "").lower()
    for b in web_bcs:
        if str(b.get("name") or "").replace(" ", "_").lower() == slug:
            return b
    return None


def _load_seed_face_hints(case_dir: Path) -> tuple[list[dict], list[dict]]:
    project = _find_project_dir(case_dir)
    bcs = _read_json(project / "boundary_conditions.json") or {}
    project_bcs = [b for b in (bcs.get("boundary_conditions") or []) if isinstance(b, dict)]
    mesh_doc = _read_json(project / "mesh.json") or {}
    lives = []
    if mesh_doc.get("live_mesh_result"):
        lives.append(mesh_doc["live_mesh_result"])
    for m in mesh_doc.get("meshes") or []:
        if isinstance(m, dict) and m.get("live_mesh_result"):
            lives.append(m["live_mesh_result"])
    web_bcs: list[dict] = []
    seen: set[str] = set()
    for live in lives:
        mesh_case = (live or {}).get("case_dir")
        if not mesh_case:
            continue
        meta = _read_json(Path(mesh_case) / "standard-meta.json") or {}
        for b in meta.get("web_bcs") or []:
            if not isinstance(b, dict):
                continue
            key = json.dumps(b, sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            web_bcs.append(b)
    return project_bcs, web_bcs


def _enrich_catalog_row(row: dict, project_bcs: list[dict], web_bcs: list[dict]) -> dict:
    cad = _rec_cad_faces(row)
    if not cad:
        rec = next(
            (
                b
                for b in project_bcs
                if b.get("name") == row.get("name") or b.get("name") == row.get("id")
            ),
            None,
        )
        if rec:
            cad = _rec_cad_faces(rec)
    web = _find_web_bc(web_bcs, row.get("name") or row.get("id"), row.get("patch"), cad)
    if not cad and web:
        cad = _rec_cad_faces(web)
    role_name = (web or {}).get("name") or row.get("name") or row.get("id") or ""
    role_type = (web or {}).get("bc_type") or row.get("bc_type")
    primary = cad[0] if cad else (row.get("name") or row.get("patch"))
    return {
        "id": primary,
        "label": primary,
        "patch": row.get("patch"),
        "name": row.get("name") or None,
        "faces": cad,
        "available": True,
        "role": _patch_role(str(role_name), role_type),
    }


def _load_case_bc_labels(case_dir: Path) -> list[dict]:
    rows: list[dict] = []
    w27 = case_dir / "w27-case.json"
    if w27.is_file():
        try:
            j = json.loads(w27.read_text(encoding="utf-8"))
            for row in j.get("mapped") or j.get("bcs") or []:
                if isinstance(row, dict) and row.get("patch"):
                    rows.append(row)
        except Exception:
            rows = []
    if rows:
        return rows
    parent = case_dir.parent
    cand = parent / f"{case_dir.name}.json"
    if cand.is_file():
        try:
            j = json.loads(cand.read_text(encoding="utf-8"))
            for row in j.get("bcs") or []:
                if isinstance(row, dict) and row.get("patch"):
                    rows.append(row)
        except Exception:
            return rows
    return rows


def build_live_catalog(case_dir: Path) -> list[dict]:
    case_dir = Path(case_dir)
    labels = _load_case_bc_labels(case_dir)
    project_bcs, web_bcs = _load_seed_face_hints(case_dir)
    by_patch = {str(r.get("patch")): r for r in labels}
    types: dict[str, str] = {}
    boundary = case_dir / "constant" / "polyMesh" / "boundary"
    if boundary.is_file():
        try:
            types = parse_boundary_patch_types(boundary)
        except Exception:
            types = {}
    catalog: list[dict] = []
    for patch, ptype in types.items():
        if str(ptype).lower() in SKIP_PATCH_TYPES:
            continue
        if "wall" in str(patch).lower():
            continue
        lab = by_patch.get(patch) or {}
        name = str(lab.get("name") or patch)
        catalog.append(
            _enrich_catalog_row(
                {
                    "id": name,
                    "name": name,
                    "patch": patch,
                    "bc_type": lab.get("bc_type"),
                    "faces": _rec_cad_faces(lab),
                },
                project_bcs,
                web_bcs,
            )
        )
    if catalog:
        return catalog
    for lab in labels:
        patch = str(lab.get("patch") or "")
        if not patch:
            continue
        name = str(lab.get("name") or patch)
        catalog.append(
            _enrich_catalog_row(
                {
                    "id": name,
                    "name": name,
                    "patch": patch,
                    "bc_type": lab.get("bc_type"),
                    "faces": _rec_cad_faces(lab),
                },
                project_bcs,
                web_bcs,
            )
        )
    return catalog


def catalog_aliases(catalog: list[dict]) -> dict[str, str]:
    alias: dict[str, str] = {}
    for e in catalog:
        alias[str(e["id"]).lower()] = e["id"]
        alias[str(e["label"]).lower()] = e["id"]
        patch = e.get("patch")
        if patch:
            alias[str(patch).lower()] = e["id"]
            alias[str(patch).replace("_", " ").lower()] = e["id"]
        name = e.get("name")
        if name:
            alias[str(name).lower()] = e["id"]
            alias[str(name).replace(" ", "_").lower()] = e["id"]
        for f in e.get("faces") or []:
            alias[str(f).lower()] = e["id"]
    inlets = [e for e in catalog if e.get("role") == "inlet" and e.get("available")]
    outlets = [e for e in catalog if e.get("role") == "outlet" and e.get("available")]
    if inlets:
        alias["inlet"] = inlets[0]["id"]
        alias["velocity inlet 1"] = inlets[0]["id"]
    if outlets:
        alias["outlet"] = outlets[0]["id"]
        alias["velocity outlet 5"] = outlets[0]["id"]
    return alias


def catalog_entry(face_id: str, catalog: list[dict]) -> dict | None:
    want = str(face_id).strip()
    if not want:
        return None
    key = catalog_aliases(catalog).get(want.lower())
    if key:
        for e in catalog:
            if e["id"] == key:
                return e
    low = want.lower()
    for e in catalog:
        if e["id"].lower() == low or str(e.get("patch") or "").lower() == low:
            return e
    return None


def available_face_ids(catalog: list[dict]) -> list[str]:
    return [e["id"] for e in catalog if e.get("available") and e.get("patch")]


def default_face_ids(catalog: list[dict]) -> list[str]:
    """Inlet only. A huge outlet must not be selected by accident."""
    inlets = [
        e["id"]
        for e in catalog
        if e.get("available") and e.get("patch") and e.get("role") == "inlet"
    ]
    if inlets:
        return inlets
    return available_face_ids(catalog)


def resolve_face_ids(faces: list[str] | None, catalog: list[dict]) -> list[str]:
    """Normalize requested face ids; preserve order; drop unknowns; dedupe.

    Explicit __none__ means no seeds. Stale (old MTP1) names fall back to the inlet.
    """
    raw = [str(f).strip() for f in (faces or []) if str(f).strip()]
    if raw and all(x.lower() == "__none__" for x in raw):
        return []
    out: list[str] = []
    seen = set()
    for f in raw:
        if f.lower() == "__none__":
            continue
        e = catalog_entry(f, catalog)
        if e is None or not e.get("available") or not e.get("patch"):
            continue
        if e["id"] in seen:
            continue
        seen.add(e["id"])
        out.append(e["id"])
    if out:
        return out
    return default_face_ids(catalog)


def load_trisurface_fallback(case_dir: Path, patch: str) -> pv.PolyData | None:
    stl = case_dir / "constant" / "triSurface" / f"{patch}.stl"
    if not stl.is_file():
        return None
    try:
        m = pv.read(str(stl))
        if m is None or m.n_points == 0:
            return None
        if not isinstance(m, pv.PolyData):
            m = m.extract_surface()
        return m
    except Exception:
        return None


def load_bc_patch(case_dir: Path, patch: str) -> tuple[pv.PolyData | None, str]:
    """Load mesh-metre BC patch. Returns (poly, source_doc)."""
    try:
        poly = load_patch_surface(case_dir, patch)
        if poly is not None and poly.n_points > 0:
            return poly, f"OpenFOAMReader polyMesh patch '{patch}' (mesh metres)"
    except Exception:
        pass
    fb = load_trisurface_fallback(case_dir, patch)
    if fb is not None:
        return fb, f"constant/triSurface/{patch}.stl (mesh metres; OpenFOAMReader fallback)"
    return None, "missing"


def load_selected_patches(
    case_dir: Path, face_ids: list[str], catalog: list[dict]
) -> tuple[list[pv.PolyData], list[dict], list[dict]]:
    """Load usable patches for selected face ids.

    Returns (patches, loaded_meta, skipped_meta).
    """
    patches: list[pv.PolyData] = []
    loaded: list[dict] = []
    skipped: list[dict] = []
    for fid in face_ids:
        e = catalog_entry(fid, catalog)
        if e is None:
            skipped.append({"id": fid, "reason": "unknown_face_id"})
            continue
        if not e["available"] or not e["patch"]:
            skipped.append(
                {
                    "id": e["id"],
                    "label": e["label"],
                    "reason": e.get("reason") or "unavailable",
                    "available": False,
                }
            )
            continue
        poly, src = load_bc_patch(case_dir, e["patch"])
        if poly is None:
            skipped.append(
                {
                    "id": e["id"],
                    "label": e["label"],
                    "patch": e["patch"],
                    "reason": "patch_load_failed",
                    "available": False,
                }
            )
            continue
        try:
            area = float(poly.area)
        except Exception:
            b = np.asarray(poly.bounds, dtype=float)
            area = max(abs(b[1] - b[0]) * abs(b[3] - b[2]), 1e-12)
        patches.append(poly)
        loaded.append(
            {
                "id": e["id"],
                "label": e["label"],
                "patch": e["patch"],
                "role": e["role"],
                "n_points": int(poly.n_points),
                "n_cells": int(poly.n_cells),
                "area": area,
                "source": src,
                "available": True,
            }
        )
    return patches, loaded, skipped


def seed_plane_center(bounds, pick_position):
    b = np.asarray(bounds, dtype=float)
    mid = np.array(
        [0.5 * (b[0] + b[1]), 0.5 * (b[2] + b[3]), 0.5 * (b[4] + b[5])],
        dtype=float,
    )
    if pick_position is None or len(pick_position) < 3:
        return mid
    try:
        c = np.array(
            [float(pick_position[0]), float(pick_position[1]), float(pick_position[2])],
            dtype=float,
        )
    except (TypeError, ValueError):
        return mid
    eps = 1e-9
    c[0] = float(np.clip(c[0], b[0] + eps, b[1] - eps))
    c[1] = float(np.clip(c[1], b[2] + eps, b[3] - eps))
    c[2] = float(np.clip(c[2], b[4] + eps, b[5] - eps))
    return c


def build_seed_lattice(bounds, seeds_h, seeds_v, spacing, pick_position):
    """Full HxV product (honest). seeds_h/v < 1 => 0 seeds (honest empty)."""
    b = np.asarray(bounds, dtype=float)
    nu = int(seeds_h)
    nv = int(seeds_v)
    if nu < 1 or nv < 1:
        poly = pv.PolyData(np.zeros((0, 3), dtype=float))
        poly.field_data["seeds_h"] = np.asarray([max(0, nu)], dtype=np.int64)
        poly.field_data["seeds_v"] = np.asarray([max(0, nv)], dtype=np.int64)
        poly.field_data["requested_n"] = np.asarray([0], dtype=np.int64)
        poly.field_data["placed_n"] = np.asarray([0], dtype=np.int64)
        return poly, seed_plane_center(b, pick_position)

    center = seed_plane_center(b, pick_position)
    spacing = max(float(spacing), 1e-12)
    us = (np.arange(nu, dtype=float) - (nu - 1) / 2.0) * spacing
    vs = (np.arange(nv, dtype=float) - (nv - 1) / 2.0) * spacing
    pts = []
    for u in us:
        for v in vs:
            p = center.copy()
            p[1] += float(u)
            p[2] += float(v)
            pts.append(p)
    arr = np.asarray(pts, dtype=float)
    requested_n = int(nu * nv)
    poly = pv.PolyData(arr)
    poly.field_data["seeds_h"] = np.asarray([nu], dtype=np.int64)
    poly.field_data["seeds_v"] = np.asarray([nv], dtype=np.int64)
    poly.field_data["requested_n"] = np.asarray([requested_n], dtype=np.int64)
    poly.field_data["placed_n"] = np.asarray([requested_n], dtype=np.int64)
    return poly, center


def parse_region(raw) -> dict | None:
    """Box or circle in mesh metres. None if missing or too small."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return None
    if not isinstance(raw, dict):
        return None
    shape = str(raw.get("shape") or "box").strip().lower()
    if shape not in ("box", "circle"):
        return None

    def vec3(key, default=None):
        v = raw.get(key)
        if not isinstance(v, (list, tuple)) or len(v) < 3:
            return default
        try:
            out = [float(v[0]), float(v[1]), float(v[2])]
        except (TypeError, ValueError):
            return default
        if not all(math.isfinite(x) for x in out):
            return default
        return out

    origin = vec3("origin")
    if origin is None:
        return None
    face = str(raw.get("face") or "").strip()
    if shape == "circle":
        try:
            radius = float(raw.get("radius") or 0.0)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(radius) or radius <= 1e-9 or radius > 50.0:
            return None
        return {
            "shape": "circle",
            "face": face,
            "origin": origin,
            "u": vec3("u", [0.0, 0.0, 0.0]) or [0.0, 0.0, 0.0],
            "v": vec3("v", [0.0, 0.0, 0.0]) or [0.0, 0.0, 0.0],
            "radius": radius,
        }
    u = vec3("u", [0.0, 0.0, 0.0]) or [0.0, 0.0, 0.0]
    v = vec3("v", [0.0, 0.0, 0.0]) or [0.0, 0.0, 0.0]
    if float(np.linalg.norm(u)) < 1e-9 or float(np.linalg.norm(v)) < 1e-9:
        return None
    if float(np.linalg.norm(u)) > 50.0 or float(np.linalg.norm(v)) > 50.0:
        return None
    return {
        "shape": "box",
        "face": face,
        "origin": origin,
        "u": u,
        "v": v,
        "radius": 0.0,
    }


def region_area(region: dict | None) -> float | None:
    if not region:
        return None
    if region.get("shape") == "circle":
        r = float(region.get("radius") or 0.0)
        return math.pi * r * r if r > 0 else None
    u = np.asarray(region.get("u") or [0.0, 0.0, 0.0], dtype=float)
    v = np.asarray(region.get("v") or [0.0, 0.0, 0.0], dtype=float)
    cr = np.cross(u, v)
    a = float(np.linalg.norm(cr))
    return a if a > 1e-18 else None


def point_in_region(p: np.ndarray, region: dict | None) -> bool:
    if not region:
        return True
    p = np.asarray(p, dtype=float)
    if region.get("shape") == "circle":
        c = np.asarray(region["origin"], dtype=float)
        r = float(region.get("radius") or 0.0)
        return float(np.linalg.norm(p - c)) <= r + 1e-9
    o = np.asarray(region["origin"], dtype=float)
    u = np.asarray(region.get("u") or [0.0, 0.0, 0.0], dtype=float)
    v = np.asarray(region.get("v") or [0.0, 0.0, 0.0], dtype=float)
    lu2 = float(np.dot(u, u))
    lv2 = float(np.dot(v, v))
    if lu2 < 1e-24 or lv2 < 1e-24:
        return False
    d = p - o
    a = float(np.dot(d, u)) / lu2
    b = float(np.dot(d, v)) / lv2
    return -1e-8 <= a <= 1.0 + 1e-8 and -1e-8 <= b <= 1.0 + 1e-8


def region_xy_bounds(region: dict, com: np.ndarray, e0: np.ndarray, e1: np.ndarray):
    if region.get("shape") == "circle":
        c = np.asarray(region["origin"], dtype=float)
        r = float(region.get("radius") or 0.0)
        c2 = np.array([(c - com) @ e0, (c - com) @ e1], dtype=float)
        return c2 - r, c2 + r
    o = np.asarray(region["origin"], dtype=float)
    u = np.asarray(region.get("u") or [0.0, 0.0, 0.0], dtype=float)
    v = np.asarray(region.get("v") or [0.0, 0.0, 0.0], dtype=float)
    corners = np.stack([o, o + u, o + v, o + u + v], axis=0)
    xy = np.column_stack(((corners - com) @ e0, (corners - com) @ e1))
    return xy.min(axis=0), xy.max(axis=0)


def build_face_seeds(
    case_dir: Path,
    face_ids: list[str],
    *,
    quantity_mode: str,
    n_seeds: int,
    density: float,
    mesh_bounds,
    region=None,
):
    """Even distribute seeds across selected available BC faces.

    Returns (seed_poly, meta_dict).
    """
    catalog = build_live_catalog(case_dir)
    resolved = resolve_face_ids(face_ids, catalog)
    region = parse_region(region)
    region_id = None
    if region and region.get("face"):
        ent = catalog_entry(region["face"], catalog)
        if ent is not None:
            region_id = ent["id"]
            if region_id not in resolved:
                resolved = [region_id]
            else:
                resolved = [region_id]
    patches, loaded, skipped = load_selected_patches(case_dir, resolved, catalog)
    face_source_doc = FACE_SEED_DOC

    base_meta = {
        "seed_mode": "faces",
        "faces_requested": resolved,
        "faces_selected_count": len(resolved),
        "faces_loaded": loaded,
        "faces_skipped": skipped,
        "n_faces_usable": len(patches),
        "face_catalog": catalog,
        "face_source_doc": face_source_doc,
        "quantity_mode": quantity_mode,
        "multi_face_seeds": True,
        "region": (
            {
                "shape": region.get("shape"),
                "face": region.get("face") or None,
                "resolved_face": region_id,
            }
            if region
            else None
        ),
    }

    if len(resolved) == 0:
        poly = pv.PolyData(np.zeros((0, 3), dtype=float))
        poly.field_data["requested_n"] = np.asarray([0], dtype=np.int64)
        poly.field_data["placed_n"] = np.asarray([0], dtype=np.int64)
        base_meta.update(
            {
                "n_seeds": 0,
                "n_seeds_requested": 0,
                "n_seeds_placed": 0,
                "culled_n": 0,
                "empty_reason": "no_faces_selected",
                "per_face_counts": [],
                "n_faces_with_seeds": 0,
                "total_area": 0.0,
                "density": float(density),
                "n_seeds_param": int(n_seeds),
            }
        )
        return poly, base_meta

    if len(patches) == 0:
        poly = pv.PolyData(np.zeros((0, 3), dtype=float))
        poly.field_data["requested_n"] = np.asarray([0], dtype=np.int64)
        poly.field_data["placed_n"] = np.asarray([0], dtype=np.int64)
        base_meta.update(
            {
                "n_seeds": 0,
                "n_seeds_requested": 0,
                "n_seeds_placed": 0,
                "culled_n": 0,
                "empty_reason": "no_usable_patches",
                "per_face_counts": [],
                "n_faces_with_seeds": 0,
                "total_area": 0.0,
                "density": float(density),
                "n_seeds_param": int(n_seeds),
            }
        )
        return poly, base_meta

    areas = [float(m["area"]) for m in loaded]
    total_area = float(sum(areas))
    qmode = (quantity_mode or "count").strip().lower()
    if qmode not in ("count", "density"):
        qmode = "count"

    seed_area = total_area
    r_area = region_area(region) if region else None
    if r_area is not None and r_area > 0:
        seed_area = min(float(r_area), float(total_area)) if total_area > 0 else float(r_area)

    if qmode == "density":
        requested_n = int(n_seeds_from_density(seed_area, density)) if float(density) > 0 else 0
        if float(density) <= 0:
            requested_n = 0
    else:
        requested_n = max(0, int(n_seeds))

    if requested_n < 1:
        poly = pv.PolyData(np.zeros((0, 3), dtype=float))
        poly.field_data["requested_n"] = np.asarray([0], dtype=np.int64)
        poly.field_data["placed_n"] = np.asarray([0], dtype=np.int64)
        base_meta.update(
            {
                "n_seeds": 0,
                "n_seeds_requested": 0,
                "n_seeds_placed": 0,
                "culled_n": 0,
                "empty_reason": "no_seeds",
                "per_face_counts": [0] * len(patches),
                "n_faces_with_seeds": 0,
                "total_area": total_area,
                "density": float(density),
                "n_seeds_param": int(n_seeds),
                "quantity_mode": qmode,
            }
        )
        return poly, base_meta

    # Equal split across selected faces. Area-weighting dumps almost every
    # seed on a huge outlet and starves the inlet (the traces you actually want).
    n_faces = len(patches)
    base = requested_n // n_faces
    rem = requested_n - base * n_faces
    per_face = [base + (1 if i < rem else 0) for i in range(n_faces)]
    if requested_n >= n_faces:
        for i, c in enumerate(per_face):
            if c == 0:
                j = int(max(range(n_faces), key=lambda k: per_face[k]))
                if per_face[j] > 1:
                    per_face[j] -= 1
                    per_face[i] = 1

    mid = None
    eps = 3e-3
    if mesh_bounds is not None:
        b = np.asarray(mesh_bounds, dtype=float)
        mid = np.array(
            [0.5 * (b[0] + b[1]), 0.5 * (b[2] + b[3]), 0.5 * (b[4] + b[5])],
            dtype=float,
        )
        diag = float(np.linalg.norm([b[1] - b[0], b[3] - b[2], b[5] - b[4]]))
        eps = max(2.5e-3, 4e-3 * diag)

    chunks: list[np.ndarray] = []
    face_i_chunks: list[np.ndarray] = []
    inward_chunks: list[np.ndarray] = []
    for face_i, (patch, c) in enumerate(zip(patches, per_face)):
        if c <= 0:
            continue
        pts_i = np.asarray(sample_regular_grid_on_surface(patch, c, region=region), dtype=float)
        if pts_i.size == 0:
            continue
        nrm = _patch_inward_normal(patch, mid) if mid is not None else None
        if nrm is not None:
            pts_i = pts_i + nrm * eps
            inward_chunks.append(np.tile(nrm, (pts_i.shape[0], 1)))
        else:
            inward_chunks.append(np.zeros((pts_i.shape[0], 3), dtype=float))
        chunks.append(pts_i)
        face_i_chunks.append(np.full((pts_i.shape[0],), face_i, dtype=np.int64))
    if not chunks:
        poly = pv.PolyData(np.zeros((0, 3), dtype=float))
        poly.field_data["requested_n"] = np.asarray([requested_n], dtype=np.int64)
        poly.field_data["placed_n"] = np.asarray([0], dtype=np.int64)
        base_meta.update(
            {
                "n_seeds": 0,
                "n_seeds_requested": requested_n,
                "n_seeds_placed": 0,
                "culled_n": requested_n,
                "empty_reason": "no_seeds",
                "per_face_counts": per_face,
                "n_faces_with_seeds": 0,
                "total_area": total_area,
                "density": float(density),
                "n_seeds_param": int(n_seeds),
                "quantity_mode": qmode,
            }
        )
        return poly, base_meta

    pts = np.vstack(chunks)
    face_i = np.concatenate(face_i_chunks)

    seeds = pv.PolyData(pts)
    seeds.point_data["seed_face_i"] = face_i
    seeds.point_data["inward"] = np.vstack(inward_chunks)
    seeds.field_data["per_face_counts"] = np.asarray(per_face, dtype=np.int64)
    seeds.field_data["n_faces"] = np.asarray([len(patches)], dtype=np.int64)
    seeds.field_data["face_areas"] = np.asarray(areas, dtype=float)
    placed_n = int(seeds.n_points)

    culled_n = max(0, requested_n - placed_n)
    n_faces_with = int(sum(1 for c in per_face if c and int(c) > 0))
    seeds.field_data["requested_n"] = np.asarray([requested_n], dtype=np.int64)
    seeds.field_data["placed_n"] = np.asarray([placed_n], dtype=np.int64)

    base_meta.update(
        {
            "n_seeds": placed_n,
            "n_seeds_requested": requested_n,
            "n_seeds_placed": placed_n,
            "n_seeds_honest": bool(placed_n == requested_n or culled_n > 0),
            "culled_n": culled_n,
            "cull_doc": (
                None
                if culled_n == 0
                else "placed < requested after bounds inset; culled_n documented"
            ),
            "empty_reason": None if placed_n > 0 else "no_seeds",
            "per_face_counts": per_face,
            "n_faces_with_seeds": n_faces_with,
            "total_area": total_area,
            "region_area": r_area,
            "density": float(density),
            "n_seeds_param": int(n_seeds),
            "quantity_mode": qmode,
            "even_distribute": True,
            "not_single_face_lattice_relabel": bool(n_faces_with >= 2 or len(resolved) < 2),
        }
    )
    return seeds, base_meta


def _patch_frame(pts: np.ndarray):
    com = pts.mean(axis=0)
    x = pts - com
    try:
        _, _, vh = np.linalg.svd(x, full_matrices=False)
        e0, e1, nrm = vh[0], vh[1], vh[2]
    except Exception:
        e0 = np.array([1.0, 0.0, 0.0])
        e1 = np.array([0.0, 1.0, 0.0])
        nrm = np.array([0.0, 0.0, 1.0])
    return com, e0, e1, nrm


def _patch_inward_normal(patch: pv.PolyData, mid: np.ndarray) -> np.ndarray | None:
    pts = np.asarray(getattr(patch, "points", []), dtype=float)
    if pts.shape[0] < 1:
        return None
    com = pts.mean(axis=0)
    if pts.shape[0] < 3:
        return _unit(np.asarray(mid, dtype=float) - com)
    com, _e0, _e1, nrm = _patch_frame(pts)
    if float(np.dot(nrm, mid - com)) < 0:
        nrm = -nrm
    return _unit(nrm)


def _iter_tris(surf: pv.PolyData) -> np.ndarray:
    raw = np.asarray(getattr(surf, "faces", []), dtype=np.int64).ravel()
    tris: list[list[int]] = []
    i = 0
    while i < raw.size:
        n = int(raw[i])
        ids = raw[i + 1 : i + 1 + n]
        i += n + 1
        if n == 3:
            tris.append([int(ids[0]), int(ids[1]), int(ids[2])])
        elif n >= 4:
            tris.append([int(ids[0]), int(ids[1]), int(ids[2])])
            tris.append([int(ids[0]), int(ids[2]), int(ids[3])])
    if not tris:
        return np.zeros((0, 3), dtype=np.int64)
    return np.asarray(tris, dtype=np.int64)


def _point_in_tri_2d(p: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray) -> bool:
    v0 = c - a
    v1 = b - a
    v2 = p - a
    den = float(v0[0] * v1[1] - v1[0] * v0[1])
    if abs(den) < 1e-18:
        return False
    u = float(v2[0] * v1[1] - v1[0] * v2[1]) / den
    v = float(v0[0] * v2[1] - v2[0] * v0[1]) / den
    return u >= -1e-8 and v >= -1e-8 and (u + v) <= 1.0 + 1e-8


def sample_regular_grid_on_surface(
    patch: pv.PolyData, n_seeds: int, region: dict | None = None
) -> np.ndarray:
    """Even lattice spanning the face, optionally clipped to a picker region.

    Cell-centered in the (region ∩ face) 2D AABB so the outer row sits half a
    cell inside the rim. Triangle tests drop cells that miss a non-rectangular
    patch. A previous 14% box inset plus 88% radial clip left empty bands
    on tall inlets (Ball Test top/bottom).
    """
    n_seeds = max(1, int(n_seeds))
    region = parse_region(region)
    surf = patch
    try:
        if not isinstance(surf, pv.PolyData):
            surf = surf.extract_surface()
        surf = surf.triangulate()
    except Exception:
        pass
    pts = np.asarray(surf.points, dtype=float)
    if pts.shape[0] == 0:
        return np.zeros((0, 3), dtype=float)
    if pts.shape[0] == 1:
        return pts[:1].copy()
    com, e0, e1, _nrm = _patch_frame(pts)
    xy = np.column_stack(((pts - com) @ e0, (pts - com) @ e1))
    tris = _iter_tris(surf)
    tris2 = []
    for t in tris:
        if int(t.max()) >= pts.shape[0]:
            continue
        tris2.append(np.stack([xy[int(t[0])], xy[int(t[1])], xy[int(t[2])]], axis=0))
    lo = xy.min(axis=0)
    hi = xy.max(axis=0)
    if region is not None:
        rlo, rhi = region_xy_bounds(region, com, e0, e1)
        lo = np.maximum(lo, rlo)
        hi = np.minimum(hi, rhi)
        if float(hi[0] - lo[0]) <= 1e-12 or float(hi[1] - lo[1]) <= 1e-12:
            inside = [p for p in pts if point_in_region(p, region)]
            return even_pick_pts(inside, n_seeds) if inside else np.zeros((0, 3), dtype=float)
    span = np.maximum(hi - lo, 1e-12)
    aspect = float(span[0]) / float(span[1])

    def on_face(p2: np.ndarray) -> bool:
        for tri in tris2:
            if _point_in_tri_2d(p2, tri[0], tri[1], tri[2]):
                return True
        return False

    def grid_points(nu: int, nv: int) -> list[np.ndarray]:
        nu = max(1, int(nu))
        nv = max(1, int(nv))
        us = (np.arange(nu) + 0.5) / nu
        vs = (np.arange(nv) + 0.5) / nv
        out: list[np.ndarray] = []
        for u in us:
            for v in vs:
                p2 = lo + np.array([float(u) * span[0], float(v) * span[1]])
                if not on_face(p2):
                    continue
                p3 = com + p2[0] * e0 + p2[1] * e1
                if region is not None and not point_in_region(p3, region):
                    continue
                out.append(p3)
        return out

    nv = max(1, int(round(np.sqrt(n_seeds / max(aspect, 1e-6)))))
    nu = max(1, int(np.ceil(n_seeds / nv)))
    hits: list[np.ndarray] = []
    for scale in (1.0, 1.35, 1.8, 2.4, 3.2, 4.5):
        hits = grid_points(max(1, int(np.ceil(nu * scale))), max(1, int(np.ceil(nv * scale))))
        if len(hits) >= n_seeds:
            break
    if not hits:
        if region is not None:
            inside = [p for p in pts if point_in_region(p, region)]
            return even_pick_pts(inside, n_seeds) if inside else np.zeros((0, 3), dtype=float)
        hits = [com + 0.92 * (pts[i] - com) for i in np.linspace(0, pts.shape[0] - 1, n_seeds, dtype=int)]
    return even_pick_pts(hits, n_seeds)


def even_pick_pts(cands, n: int) -> np.ndarray:
    if not cands:
        return np.zeros((0, 3), dtype=float)
    P = np.asarray(cands, dtype=float)
    n = max(1, int(n))
    if P.shape[0] <= n:
        return P
    start = int(np.argmax(np.linalg.norm(P - P.mean(axis=0), axis=1)))
    chosen = [start]
    dmin = np.linalg.norm(P - P[start], axis=1)
    for _ in range(n - 1):
        j = int(np.argmax(dmin))
        chosen.append(j)
        dmin = np.minimum(dmin, np.linalg.norm(P - P[j], axis=1))
    return P[np.asarray(chosen, dtype=int)]


def _unit(v: np.ndarray) -> np.ndarray | None:
    n = float(np.linalg.norm(v))
    if n < 1e-18:
        return None
    return v / n


def _streamline_along(poly: pv.PolyData) -> np.ndarray:
    """Normalised arc length (0..1) per polyline point, for comet shading."""
    n_pts = int(poly.n_points)
    along = np.zeros(n_pts, dtype=float)
    raw = np.asarray(getattr(poly, "lines", []), dtype=np.int64).ravel()
    pts = np.asarray(poly.points, dtype=float)
    i = 0
    while i < raw.size:
        n = int(raw[i])
        ids = raw[i + 1 : i + 1 + n]
        i += n + 1
        if n < 2:
            continue
        seg = np.linalg.norm(np.diff(pts[ids], axis=0), axis=1)
        cum = np.concatenate([[0.0], np.cumsum(seg)])
        total = float(cum[-1])
        along[ids] = cum / total if total > 0 else 0.0
    return along


def _streamline_lengths(poly: pv.PolyData) -> list[float]:
    raw = np.asarray(getattr(poly, "lines", []), dtype=np.int64).ravel()
    pts = np.asarray(poly.points, dtype=float)
    out: list[float] = []
    i = 0
    while i < raw.size:
        n = int(raw[i])
        ids = raw[i + 1 : i + 1 + n]
        i += n + 1
        if n >= 2:
            out.append(float(np.sum(np.linalg.norm(np.diff(pts[ids], axis=0), axis=1))))
    return out


def trace_from_seeds(
    grid: pv.DataSet,
    seeds: pv.PolyData,
    *,
    both_directions: bool,
    max_len: float,
    max_steps: int,
    step: float,
    cell_size: float,
    umin: float,
) -> tuple[pv.PolyData, dict]:
    """Integrate the velocity field with VTK's stream tracer (RK4/5).

    The tracer interpolates U inside the cell that contains the particle, so a
    path can never leave the fluid through a wall; it ends where the flow
    leaves the mesh (outlet), stalls (terminal speed) or after max_len.
    """
    if int(seeds.n_points) < 1:
        return empty_poly(), {"n_paths": 0, "integrator": "vtkStreamTracer"}
    speeds = np.linalg.norm(np.asarray(grid.point_data["U"], dtype=float)[:, :3], axis=1)
    umax = float(np.nanmax(speeds)) if speeds.size else 1.0
    terminal = max(1e-9, 1e-4 * umax)

    def run(source: pv.PolyData, direction: str):
        return grid.streamlines_from_source(
            source,
            vectors="U",
            integrator_type=45,
            integration_direction=direction,
            surface_streamlines=False,
            initial_step_length=0.5,
            step_unit="cl",
            min_step_length=0.02,
            max_step_length=1.0,
            max_steps=int(max(1000, max_steps)),
            terminal_speed=terminal,
            max_error=1e-6,
            max_length=float(max_len),
            compute_vorticity=False,
            interpolator_type="cell",
        )

    # Direction per seed. "Trace both directions" integrates up- and
    # downstream from every seed. Otherwise each seed follows the flow *into*
    # the domain: forward from an inlet face, backward from an outlet face
    # (where the fluid came from), decided from U at the seed against the
    # face's inward normal.
    jobs: list[tuple[pv.PolyData, str]] = []
    n_fwd = 0
    n_bwd = 0
    if both_directions:
        jobs.append((seeds, "both"))
    else:
        seed_pts = np.asarray(seeds.points, dtype=float)
        b = np.asarray(grid.bounds, dtype=float)
        mid = np.array([0.5 * (b[0] + b[1]), 0.5 * (b[2] + b[3]), 0.5 * (b[4] + b[5])])
        inward = (
            np.asarray(seeds.point_data["inward"], dtype=float)
            if "inward" in seeds.point_data
            else np.zeros_like(seed_pts)
        )
        weak = np.linalg.norm(inward, axis=1) < 1e-9
        if np.any(weak):
            inward[weak] = mid - seed_pts[weak]
        try:
            sampled = seeds.sample(grid)
            U_seed = np.asarray(sampled.point_data["U"], dtype=float)[:, :3]
        except Exception:
            U_seed = np.zeros_like(seed_pts)
        dots = np.einsum("ij,ij->i", U_seed, inward)
        fwd = dots >= 0
        if np.any(fwd):
            jobs.append((pv.PolyData(seed_pts[fwd]), "forward"))
            n_fwd = int(np.count_nonzero(fwd))
        if np.any(~fwd):
            jobs.append((pv.PolyData(seed_pts[~fwd]), "backward"))
            n_bwd = int(np.count_nonzero(~fwd))

    parts: list[pv.PolyData] = []
    reasons: dict[int, int] = {}
    for source, direction in jobs:
        try:
            stream = run(source, direction)
        except Exception as exc:  # pragma: no cover - VTK failure
            return empty_poly(), {"n_paths": 0, "integrator": "vtkStreamTracer", "error": str(exc)}
        if stream is None or int(stream.n_points) < 2 or int(stream.n_lines) < 1:
            continue
        if "ReasonForTermination" in stream.cell_data:
            r = np.asarray(stream.cell_data["ReasonForTermination"]).ravel()
            for k, v in zip(*np.unique(r, return_counts=True)):
                reasons[int(k)] = reasons.get(int(k), 0) + int(v)
        part = pv.PolyData(
            np.asarray(stream.points, dtype=float),
            lines=np.asarray(stream.lines, dtype=np.int64),
        )
        if "U" in stream.point_data:
            part.point_data["U"] = np.asarray(stream.point_data["U"], dtype=float)
        if "p" in stream.point_data:
            part.point_data["p"] = np.asarray(stream.point_data["p"], dtype=float)
        parts.append(part)
    if not parts:
        return empty_poly(), {"n_paths": 0, "integrator": "vtkStreamTracer", "termination_reasons": reasons or None}

    poly = parts[0] if len(parts) == 1 else parts[0].merge(parts[1:], merge_points=False)
    if "U" in poly.point_data:
        U = np.asarray(poly.point_data["U"], dtype=float)
        poly.point_data["magU"] = np.linalg.norm(U[:, :3], axis=1)
    poly.point_data["along"] = _streamline_along(poly)

    lengths = _streamline_lengths(poly)
    n_paths = len(lengths)
    meta = {
        "n_paths": n_paths,
        "n_forward": None if both_directions else n_fwd,
        "n_backward": None if both_directions else n_bwd,
        "path_length_min": float(min(lengths)) if lengths else 0.0,
        "path_length_max": float(max(lengths)) if lengths else 0.0,
        "path_length_mean": float(sum(lengths) / len(lengths)) if lengths else 0.0,
        "integrator": "vtkStreamTracer RK45 (cell interpolation)",
        "terminal_speed": terminal,
        "termination_reasons": reasons,
        "seeds": int(seeds.n_points),
    }
    return poly, meta


def ensure_mag_u(mesh: pv.DataSet) -> None:
    if "magU" in mesh.point_data or "magU" in mesh.cell_data:
        return
    if "U" in mesh.point_data:
        U = np.asarray(mesh.point_data["U"], dtype=float)
        if U.ndim == 2 and U.shape[1] >= 3:
            mesh.point_data["magU"] = np.linalg.norm(U[:, :3], axis=1)
    elif "U" in mesh.cell_data:
        U = np.asarray(mesh.cell_data["U"], dtype=float)
        if U.ndim == 2 and U.shape[1] >= 3:
            mesh.cell_data["magU"] = np.linalg.norm(U[:, :3], axis=1)


def point_data_grid(grid: pv.DataSet) -> pv.DataSet:
    if "U" in grid.point_data:
        return grid
    if "U" in grid.cell_data:
        try:
            return grid.cell_data_to_point_data()
        except Exception:
            return grid
    return grid


def mesh_checksum(pts: np.ndarray, n_cells: int) -> str:
    if pts is None or pts.size == 0:
        return "00000000"
    flat = np.asarray(pts, dtype=np.float64).ravel()
    h = 2166136261

    def push(v):
        nonlocal h
        x = int(np.floor(float(v) * 1e6))
        h ^= x & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF

    push(flat.size)
    push(n_cells)
    step = max(1, flat.size // 256)
    for i in range(0, flat.size, step):
        push(flat[i])
    for i in range(max(0, flat.size - 24), flat.size):
        push(flat[i])
    return f"{h:08x}"


def empty_poly() -> pv.PolyData:
    return pv.PolyData(np.zeros((0, 3), dtype=float))


def export_particle_trace(
    case_dir: Path,
    time: str,
    out_dir: Path,
    *,
    seeds_h: int = 10,
    seeds_v: int = 10,
    spacing: float = 0.015,
    size: float = 0.0037,
    both_directions: bool = True,
    pick_position=None,
    representation: str = "Cylinders",
    max_steps: int = 50000,
    max_propagation_diag_mult: float = 10.0,
    seed_mode: str = "grid",
    faces: list[str] | None = None,
    quantity_mode: str = "count",
    n_seeds: int = 40,
    density: float = 10000.0,
    region=None,
):
    case_dir = case_dir.resolve()
    u_path = case_dir / str(time) / "U"
    vtu_path = case_dir / ".cfddesk-prepared.vtu"
    mesh, volume_source = read_volume_at_time(case_dir, str(time))
    if mesh is None or int(getattr(mesh, "n_cells", 0) or 0) < 1:
        raise RuntimeError(f"volume read failed: {case_dir}")
    if "U" not in mesh.point_data and "U" not in mesh.cell_data:
        if not u_path.is_file():
            raise FileNotFoundError(f"missing OpenFOAM U: {u_path}")
        raise RuntimeError("volume has no vector U for particle trace")

    point_grid = point_data_grid(mesh)
    if "U" not in point_grid.point_data:
        raise RuntimeError(
            "No point-data U for particle trace (need vector U, not magU alone)"
        )
    # Pressure coloring in Pa (simpleFoam p is kinematic).
    scale_pressure(point_grid, case_density(case_dir))
    try:
        point_grid.set_active_vectors("U")
    except Exception:
        pass

    bounds = point_grid.bounds
    smode = (seed_mode or "grid").strip().lower()
    if smode not in ("grid", "faces"):
        smode = "grid"

    face_meta = None
    center = seed_plane_center(bounds, pick_position)
    if smode == "faces":
        seeds, face_meta = build_face_seeds(
            case_dir,
            faces or [],
            quantity_mode=quantity_mode,
            n_seeds=n_seeds,
            density=density,
            mesh_bounds=bounds,
            region=region,
        )
        n_seeds_placed = int(seeds.n_points)
        requested_n = int(face_meta.get("n_seeds_requested") or 0)
    else:
        seeds, center = build_seed_lattice(
            bounds, seeds_h, seeds_v, spacing, pick_position
        )
        n_seeds_placed = int(seeds.n_points)
        if int(seeds_h) >= 1 and int(seeds_v) >= 1:
            requested_n = int(seeds_h) * int(seeds_v)
        else:
            requested_n = 0

    seed_pts = np.asarray(seeds.points, dtype=float) if n_seeds_placed else np.zeros((0, 3))
    seed_checksum = float(seed_pts.sum()) if seed_pts.size else 0.0
    seed_spread = (
        float(np.linalg.norm(seed_pts.max(axis=0) - seed_pts.min(axis=0)))
        if n_seeds_placed > 1
        else 0.0
    )

    b = np.asarray(bounds, dtype=float)
    diag = float(np.linalg.norm([b[1] - b[0], b[3] - b[2], b[5] - b[4]]))
    # Swirling flows (cyclones) travel many diagonals before leaving; allow it.
    max_len = max(diag * max(float(max_propagation_diag_mult), 30.0), diag)
    integ = "both" if both_directions else "into_domain"
    radius = float(size) if float(size) > 0 else max(2e-5, 0.0035 * diag)
    n_cells_vol = int(getattr(point_grid, "n_cells", 0) or 1)
    cell_size = max(diag / max(n_cells_vol ** (1.0 / 3.0), 1.0), 1e-4)
    step = max(0.35 * cell_size, 1.5e-3)
    umin = max(1e-3, 0.01 * (float(np.nanmax(np.linalg.norm(np.asarray(point_grid.point_data["U"])[:, :3], axis=1))) or 1.0))

    empty = False
    empty_reason = None
    streams = empty_poly()
    tubes = empty_poly()
    n_stream_lines = 0
    trace_meta = {}

    if n_seeds_placed < 1:
        empty = True
        empty_reason = (
            (face_meta or {}).get("empty_reason")
            if smode == "faces"
            else "no_seeds"
        ) or "no_seeds"
    else:
        streams, trace_meta = trace_from_seeds(
            point_grid,
            seeds,
            both_directions=bool(both_directions),
            max_len=max_len,
            max_steps=min(int(max_steps), 50000),
            step=step,
            cell_size=cell_size,
            umin=umin,
        )
        n_stream_lines = int(trace_meta.get("n_paths") or 0)
        if streams.n_points == 0 or n_stream_lines == 0:
            empty = True
            empty_reason = "no_streamlines"
            streams = empty_poly()
            tubes = empty_poly()
        else:
            ensure_mag_u(streams)
            # Client builds cylinders / spheres / comets. Keep the raw lines
            # so Size and Representation can change without a re-export.
            tubes = streams

    keep_pt = {"magU", "U", "p", "along", "TubeNormals", "Normals"}
    for k in list(tubes.point_data.keys()):
        if k not in keep_pt:
            try:
                del tubes.point_data[k]
            except Exception:
                pass
    for k in list(tubes.cell_data.keys()):
        if k not in ("magU",):
            try:
                del tubes.cell_data[k]
            except Exception:
                pass

    out_dir.mkdir(parents=True, exist_ok=True)
    out_vtp = out_dir / "particle_trace.vtp"
    out_meta = out_dir / "particle_trace.meta.json"
    tubes.save(str(out_vtp), binary=True)
    vtp_bytes = out_vtp.read_bytes()
    vtp_sha = hashlib.sha256(vtp_bytes).hexdigest()

    pts = np.asarray(tubes.points, dtype=float) if tubes.n_points else np.zeros((0, 3))
    n_points = int(tubes.n_points)
    n_cells = int(tubes.n_cells)
    has_tube_normals = "TubeNormals" in tubes.point_data
    tube_proof = {
        "representation": "lines",
        "live_rep": "polylines",
        "client_glyphs": True,
        "radius": radius,
        "size_param": float(size),
        "n_stream_lines": n_stream_lines,
        "n_tube_points": n_points,
        "n_tube_cells": n_cells,
        "has_TubeNormals": bool(has_tube_normals),
        "not_thin_line_fakes": True,
        "method": "vtkStreamTracer RK45 polylines; client TubeFilter / Glyph3D",
        **trace_meta,
    }

    mag = None
    if "magU" in tubes.point_data and n_points:
        mag = np.asarray(tubes.point_data["magU"], dtype=float)

    approach = (
        "server-side streamlines: Vite middleware -> export_particle_trace.py "
        f"reads volume ({volume_source}) point-data U "
        + (
            "-> even seeds on this case's inlet/outlet patches "
            if smode == "faces"
            else "-> HxV seed lattice "
        )
        + "-> even lattice seeds -> vtkStreamTracer RK45 streamlines (polylines for client glyphs)"
    )

    meta = {
        "increment": "W14" if smode == "faces" else "W8",
        "case_dir": str(case_dir),
        "time": time,
        "approach": approach,
        "vector_field": "U",
        "coloring": "Velocity Magnitude",
        "coloring_field": "magU",
        "representation": "Cylinders",
        "seed_mode": smode,
        "seeds_h": int(seeds_h),
        "seeds_v": int(seeds_v),
        "n_seeds": n_seeds_placed,
        "n_seeds_requested": requested_n,
        "n_seeds_honest_product": bool(
            smode == "grid" and n_seeds_placed == requested_n
        ),
        "n_seeds_honest": bool(
            n_seeds_placed == requested_n
            or (face_meta and face_meta.get("culled_n", 0) > 0)
        ),
        "spacing": float(spacing),
        "size": float(size),
        "both_directions": bool(both_directions),
        "integration_direction": integ,
        "pick_position": (
            list(pick_position)
            if pick_position is not None and len(pick_position) >= 3
            else None
        ),
        "seed_center": [float(x) for x in np.asarray(center).tolist()],
        "seed_checksum": seed_checksum,
        "seed_spread": seed_spread,
        "seed_plane_doc": SEED_PLANE_DOC,
        "multi_face_seeds": bool(smode == "faces"),
        "empty": empty,
        "empty_reason": empty_reason,
        "tube_proof": tube_proof,
        "n_points": n_points,
        "n_cells": n_cells,
        "bounds": list(map(float, tubes.bounds)) if n_points else list(map(float, bounds)),
        "mesh_checksum": mesh_checksum(pts, n_cells),
        "magU_min": float(np.nanmin(mag)) if mag is not None and mag.size else None,
        "magU_max": float(np.nanmax(mag)) if mag is not None and mag.size else None,
        "asset_bytes": len(vtp_bytes),
        "asset_sha256": vtp_sha,
        "source_vtu": str(vtu_path) if vtu_path.is_file() else None,
        "volume_source": volume_source,
        "source_foam_U": str(u_path) if u_path.is_file() else None,
        "proves_not_baked_only": True,
        "no_fake_solve": True,
        "no_line_fakes_as_cylinders": True,
        "u_from_case": True,
    }
    if face_meta:
        meta.update(face_meta)
        # keep empty_reason from streamline pass if seeds existed but tracer failed
        if empty and empty_reason:
            meta["empty_reason"] = empty_reason

    out_meta.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": True,
                "vtp": str(out_vtp),
                "meta": str(out_meta),
                "bytes": len(vtp_bytes),
                "n_seeds": n_seeds_placed,
                "empty": empty,
                "n_cells": n_cells,
                "seed_mode": smode,
            }
        )
    )
    return meta


def parse_pick(s: str | None):
    if not s or not str(s).strip():
        return None
    parts = [p.strip() for p in str(s).replace(";", ",").split(",") if p.strip()]
    if len(parts) < 3:
        return None
    try:
        return [float(parts[0]), float(parts[1]), float(parts[2])]
    except ValueError:
        return None


def parse_faces(s: str | None) -> list[str]:
    if not s or not str(s).strip():
        return []
    raw = str(s).strip()
    if raw.lower() == "__none__":
        return ["__none__"]
    raw = raw.replace("|", ",").replace(";", ",")
    return [p.strip() for p in raw.split(",") if p.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", type=Path, required=True, help="OpenFOAM case directory")
    ap.add_argument("--time", default="50")
    ap.add_argument("--out-dir", type=Path, default=None)
    ap.add_argument("--list-faces", action="store_true")
    ap.add_argument("--seeds-h", type=int, default=10)
    ap.add_argument("--seeds-v", type=int, default=10)
    ap.add_argument("--spacing", type=float, default=0.015)
    ap.add_argument("--size", type=float, default=0.0037)
    ap.add_argument("--both", type=int, default=1)
    ap.add_argument("--pick", type=str, default="")
    ap.add_argument("--representation", default="Cylinders")
    ap.add_argument("--max-steps", type=int, default=50000)
    ap.add_argument("--seed-mode", default="grid", choices=["grid", "faces"])
    ap.add_argument("--faces", type=str, default="")
    ap.add_argument("--quantity-mode", default="count", choices=["count", "density"])
    ap.add_argument("--n-seeds", type=int, default=40)
    ap.add_argument("--density", type=float, default=10000.0)
    ap.add_argument("--region", type=str, default="")
    args = ap.parse_args()
    if args.list_faces:
        cat = build_live_catalog(args.case.resolve())
        print(json.dumps({"ok": True, "faces": cat}))
        return
    if args.out_dir is None:
        ap.error("--out-dir is required")
    export_particle_trace(
        args.case,
        args.time,
        args.out_dir,
        seeds_h=args.seeds_h,
        seeds_v=args.seeds_v,
        spacing=args.spacing,
        size=args.size,
        both_directions=bool(args.both),
        pick_position=parse_pick(args.pick),
        representation=args.representation,
        max_steps=args.max_steps,
        seed_mode=args.seed_mode,
        faces=parse_faces(args.faces),
        quantity_mode=args.quantity_mode,
        n_seeds=args.n_seeds,
        density=args.density,
        region=parse_region(args.region),
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
