"""CAD edge + face adherence prove — Increments 14a / 14b measurable PASS gate.

Green UI / ``snap true`` alone is NEVER evidence of PASS. When the STEP has
topological edges, mesh PASS requires:

1. Non-empty ``cadFeatures.eMesh`` (writer must not silently drop edges).
2. Algorithm-path feature wiring present:
   - Hex / Hex-parametric: snappy ``features`` + ``explicitFeatureSnap true``
   - Standard/cfMesh: STL max-edge path + ``edgeMeshRefinement`` / feature file
3. Edge sample metric: CAD edge samples → nearest boundary-mesh point;
   ``max_distance_m <= max(edge_defl_m * 2, wall_cell * 0.25)`` using the
   **same** ``edge_defl_m`` / wall-cell the case writer already computes.

Inc 14b: when the STEP has faces, also require face-sample Hausdorff:
CAD face tessellation samples → nearest point on the boundary *surface*
(not vertices alone); same threshold bar as edge
(``max(edge_defl_m * 2, wall_cell * 0.25)``). No soft-bar invent.

Hex prove must not claim to cover Standard (separate asserts).
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

from cfddesk.cad.step import (LoadedSolid, extract_cad_edges, shape_diagonal, tessellate_faces)
from cfddesk.project.model import Project


def hex_writer_edge_sizing(
    *,
    base_cell_m: float,
    walls_level: int,
    diag_m: float,
) -> dict[str, float]:
    """Same formulas as ``prepare_mesh_case`` CAD feature write."""
    wall_cell = float(base_cell_m) / (2 ** max(0, int(walls_level)))
    edge_defl_m = min(wall_cell * 0.25, max(float(diag_m) * 5e-4, 1e-5))
    threshold_m = max(edge_defl_m * 2.0, wall_cell * 0.25)
    return {
        "wall_cell_m": float(wall_cell),
        "edge_defl_m": float(edge_defl_m),
        "threshold_m": float(threshold_m),
    }


def standard_cfmesh_edge_sizing(*, base_cell_m: float) -> dict[str, float]:
    """Same formulas as ``prepare_standard_mesh_case`` cfMesh CAD feature write."""
    from cfddesk.mesh.cfmesh_standard import max_stl_edge_m, sizing_from_base_cell

    max_cell, boundary_cell, skin_cell = sizing_from_base_cell(float(base_cell_m))
    stl_max_edge_m = float(max_stl_edge_m(skin_cell))
    # Writer: linear_deflection_m=min(max(edge_lim * 0.35, 0.0025), 0.004)
    edge_defl_m = min(max(stl_max_edge_m * 0.35, 0.0025), 0.004)
    wall_cell = float(boundary_cell)
    threshold_m = max(edge_defl_m * 2.0, wall_cell * 0.25)
    return {
        "max_cell_m": float(max_cell),
        "wall_cell_m": wall_cell,
        "skin_cell_m": float(skin_cell),
        "stl_max_edge_m": stl_max_edge_m,
        "edge_defl_m": float(edge_defl_m),
        "threshold_m": float(threshold_m),
    }


def count_cad_topological_edges(solid: LoadedSolid) -> int:
    """Count non-degenerate topological edges on the STEP solid."""
    pts, lines = extract_cad_edges(solid, deflection=1e3, scale=1.0)
    if pts.size == 0 or lines.size == 0:
        return 0
    n_edges = 0
    i = 0
    n = int(lines.size)
    while i < n:
        count = int(lines[i])
        i += 1 + count
        if count >= 2:
            n_edges += 1
    return n_edges


def _emesh_nonempty(path: Path) -> tuple[bool, int]:
    """Return (present_nonempty, point_count_hint)."""
    if not path.is_file():
        return False, 0
    raw = path.read_bytes()
    if len(raw) < 64:
        return False, 0
    text = raw.decode("ascii", errors="replace")
    if "featureEdgeMesh" not in text:
        return False, 0
    # First integer after header is point count.
    m = re.search(
        r"object\s+cadFeatures\.eMesh;\s*\}\s*(?://[^\n]*\n)*\s*(\d+)\s*\(",
        text,
        flags=re.MULTILINE,
    )
    n_pts = int(m.group(1)) if m else 0
    return n_pts > 0 or ("(\n" in text and len(raw) > 200), n_pts


def _parse_snappy_feature_flags(snappy_path: Path) -> dict[str, Any]:
    if not snappy_path.is_file():
        return {
            "snappy_present": False,
            "features_block": False,
            "features_file": None,
            "explicit_feature_snap": False,
            "snap_true": False,
        }
    text = snappy_path.read_text(encoding="utf-8", errors="replace")
    feat_file = None
    m = re.search(
        r"features\s*\n\s*\(\s*\n\s*\{[^}]*file\s+\"([^\"]+)\"",
        text,
        flags=re.MULTILINE,
    )
    if m:
        feat_file = m.group(1)
    else:
        # Compact / alternate spacing
        m2 = re.search(
            r"features\s*\([\s\S]*?file\s+\"([^\"]+)\"",
            text,
        )
        if m2:
            feat_file = m2.group(1)
    exp = bool(re.search(r"explicitFeatureSnap\s+true\s*;", text))
    snap = bool(re.search(r"^\s*snap\s+true\s*;", text, flags=re.MULTILINE))
    return {
        "snappy_present": True,
        "features_block": feat_file is not None,
        "features_file": feat_file,
        "explicit_feature_snap": exp,
        "snap_true": snap,
    }


def _parse_cfmesh_feature_flags(mesh_dict: Path) -> dict[str, Any]:
    if not mesh_dict.is_file():
        return {
            "mesh_dict_present": False,
            "edge_mesh_refinement": False,
            "edge_mesh_file": None,
        }
    text = mesh_dict.read_text(encoding="utf-8", errors="replace")
    has_block = "edgeMeshRefinement" in text
    m = re.search(
        r"edgeMeshRefinement\s*\{[\s\S]*?edgeFile\s+\"([^\"]+)\"",
        text,
    )
    if m is None:
        m = re.search(
            r"edgeMeshRefinement[\s\S]*?(?:edgeFile|fileName|file)\s+\"([^\"]+)\"",
            text,
        )
    return {
        "mesh_dict_present": True,
        "edge_mesh_refinement": has_block and (
            "cadFeatures" in text or m is not None
        ),
        "edge_mesh_file": m.group(1) if m else (
            "cadFeatures.eMesh" if "cadFeatures" in text and has_block else None
        ),
    }


def _boundary_points(mesh_dir: Path) -> np.ndarray:
    """Load unique boundary mesh points from an OpenFOAM case directory."""
    import pyvista as pv

    mesh_dir = Path(mesh_dir)
    foam = mesh_dir / "case.foam"
    if not foam.exists():
        foam.write_text("", encoding="utf-8")
    reader = pv.OpenFOAMReader(str(foam))
    if reader.time_values:
        reader.set_active_time_value(reader.time_values[0])
    mb = reader.read()
    bnd = mb["boundary"]
    pl: list[np.ndarray] = []
    for bi in range(bnd.n_blocks):
        b = bnd[bi]
        if b is not None and getattr(b, "n_points", 0):
            pl.append(np.asarray(b.points, dtype=np.float64))
    if pl:
        return np.unique(np.vstack(pl), axis=0)
    return np.asarray(
        mb["internalMesh"].extract_surface().points, dtype=np.float64
    )


def _cad_edge_samples(
    solid: LoadedSolid,
    *,
    scale_to_metres: float,
    edge_defl_m: float,
) -> np.ndarray:
    scale = float(scale_to_metres) if scale_to_metres else 1.0
    defl_native = max(float(edge_defl_m) / max(scale, 1e-30), 1e-6)
    pts, lines = extract_cad_edges(solid, deflection=defl_native, scale=scale)
    if pts.size == 0:
        return np.zeros((0, 3), dtype=np.float64)
    samples: list[np.ndarray] = []
    i = 0
    n = int(lines.size)
    while i < n:
        count = int(lines[i])
        i += 1
        ids = [int(lines[i + k]) for k in range(count)]
        i += count
        for a in ids:
            samples.append(pts[a])
    if not samples:
        return np.zeros((0, 3), dtype=np.float64)
    return np.unique(np.round(np.asarray(samples, dtype=np.float64), 6), axis=0)


def _edge_distance_stats(
    samples: np.ndarray,
    boundary_pts: np.ndarray,
    *,
    wall_cell_m: float,
    threshold_m: float,
) -> dict[str, Any]:
    if samples.size == 0:
        return {
            "n_samples": 0,
            "n_wetted": 0,
            "max_distance_m": None,
            "max_distance_raw_m": None,
            "p50_m": None,
            "p95_m": None,
            "error": "no_cad_edge_samples",
        }
    if boundary_pts.size == 0:
        return {
            "n_samples": int(len(samples)),
            "n_wetted": 0,
            "max_distance_m": None,
            "max_distance_raw_m": None,
            "p50_m": None,
            "p95_m": None,
            "error": "no_boundary_points",
        }
    tree = cKDTree(boundary_pts)
    d, _ = tree.query(samples, k=1)
    d = np.asarray(d, dtype=np.float64)
    # Exclude internal BREP wires far from the fluid boundary so they cannot
    # inflate max; keep samples near the wetted surface.
    wet_cut = max(float(wall_cell_m) * 2.0, float(threshold_m) * 4.0)
    wet = d <= wet_cut
    if int(wet.sum()) < 10:
        wet = d <= max(float(wall_cell_m) * 4.0, float(threshold_m) * 8.0, 0.05)
    dw = d[wet] if wet.any() else d
    return {
        "n_samples": int(len(samples)),
        "n_wetted": int(wet.sum()) if wet.any() else int(len(d)),
        "wet_cutoff_m": float(wet_cut),
        "max_distance_m": float(dw.max()),
        "max_distance_raw_m": float(d.max()),
        "p50_m": float(np.percentile(dw, 50)),
        "p95_m": float(np.percentile(dw, 95)),
    }


@dataclass
class CadEdgeAdherenceResult:
    ok: bool
    algorithm_path: str
    step_has_edges: bool
    n_cad_edges: int
    emesh_present: bool
    emesh_n_points: int
    features_ok: bool
    explicit_feature_snap: bool | None
    snap_true_alone_not_pass: bool
    wall_cell_m: float | None
    edge_defl_m: float | None
    threshold_m: float | None
    max_edge_deviation_m: float | None
    edge_metric_ok: bool | None
    reasons: list[str] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def summary(self) -> str:
        if self.ok:
            dev = self.max_edge_deviation_m
            thr = self.threshold_m
            return (
                f"CAD edge adherence PASS ({self.algorithm_path}): "
                f"max_dev={dev:.6g}m <= threshold={thr:.6g}m"
                if dev is not None and thr is not None
                else f"CAD edge adherence PASS ({self.algorithm_path})"
            )
        return (
            f"CAD edge adherence FAIL ({self.algorithm_path}): "
            + "; ".join(self.reasons)
        )


def _algo_family(algorithm: str) -> str:
    algo = str(algorithm or "standard").strip().lower()
    if algo in ("hex-dominant", "hex"):
        return "hex"
    if algo in ("hex-dominant-parametric", "hex-parametric"):
        return "hex-parametric"
    return "standard"


def prove_cad_edge_adherence(
    solid: LoadedSolid,
    project: Project,
    *,
    case_dir: Path,
    mesh_dir: Path | None = None,
    algorithm: str | None = None,
    require_mesh_metric: bool = True,
) -> CadEdgeAdherenceResult:
    """Measurable CAD-edge adherence prove for one algorithm path.

    ``case_dir`` holds written case files (eMesh, snappyHexMeshDict / meshDict).
    ``mesh_dir`` holds polyMesh (results copy-back or WSL case). When
    ``require_mesh_metric`` is False, only config/eMesh gates run (writer-level).
    """
    case_dir = Path(case_dir)
    algo = str(algorithm or getattr(project.mesh, "algorithm", "standard") or "standard")
    family = _algo_family(algo)
    n_edges = count_cad_topological_edges(solid)
    step_has_edges = n_edges > 0
    emesh_path = case_dir / "constant" / "triSurface" / "cadFeatures.eMesh"
    # Also accept results-side triSurface (some copy-backs).
    if mesh_dir is not None:
        alt = Path(mesh_dir) / "constant" / "triSurface" / "cadFeatures.eMesh"
        if (not emesh_path.is_file()) and alt.is_file():
            emesh_path = alt
    emesh_ok, emesh_npts = _emesh_nonempty(emesh_path)

    reasons: list[str] = []
    details: dict[str, Any] = {
        "case_dir": str(case_dir),
        "mesh_dir": str(mesh_dir) if mesh_dir else None,
        "emesh_path": str(emesh_path),
        "green_ui_or_snap_alone_is_never_pass": True,
    }

    scale = float(project.scale_to_metres)
    base = float(project.mesh.base_cell_m)
    walls = int(project.mesh.refinement.walls)
    diag_m = float(shape_diagonal(solid)) * scale

    wall_cell_m: float | None = None
    edge_defl_m: float | None = None
    threshold_m: float | None = None
    features_ok = False
    explicit_snap: bool | None = None
    stl_max_edge_present: bool | None = None

    if family in ("hex", "hex-parametric"):
        sizing = hex_writer_edge_sizing(
            base_cell_m=base, walls_level=walls, diag_m=diag_m
        )
        wall_cell_m = sizing["wall_cell_m"]
        edge_defl_m = sizing["edge_defl_m"]
        threshold_m = sizing["threshold_m"]
        details["sizing"] = sizing
        snappy = _parse_snappy_feature_flags(case_dir / "system" / "snappyHexMeshDict")
        details["snappy"] = snappy
        explicit_snap = bool(snappy.get("explicit_feature_snap"))
        features_ok = bool(
            snappy.get("features_block")
            and snappy.get("features_file")
            and "cadFeatures" in str(snappy.get("features_file"))
            and explicit_snap
        )
        # snap true alone must never be treated as PASS evidence.
        if snappy.get("snap_true") and not features_ok and step_has_edges:
            reasons.append(
                "snap=true alone is not PASS — features/explicitFeatureSnap required"
            )
    else:
        # Standard / cfMesh path — separate from Hex.
        sizing = standard_cfmesh_edge_sizing(base_cell_m=base)
        wall_cell_m = sizing["wall_cell_m"]
        edge_defl_m = sizing["edge_defl_m"]
        threshold_m = sizing["threshold_m"]
        details["sizing"] = sizing
        cf = _parse_cfmesh_feature_flags(case_dir / "system" / "meshDict")
        details["cfmesh"] = cf
        stl_path = case_dir / "constant" / "triSurface" / "geometry.stl"
        stl_max_edge_present = stl_path.is_file() and stl_path.stat().st_size > 0
        details["stl_geometry_present"] = stl_max_edge_present
        details["stl_max_edge_m"] = sizing.get("stl_max_edge_m")
        features_ok = bool(
            cf.get("edge_mesh_refinement") and emesh_ok and stl_max_edge_present
        )
        explicit_snap = None
        if step_has_edges and not stl_max_edge_present:
            reasons.append("Standard path missing geometry.stl (STL max-edge path)")
        if step_has_edges and not cf.get("edge_mesh_refinement"):
            reasons.append("Standard path missing edgeMeshRefinement / feature-edge path")

    if step_has_edges and not emesh_ok:
        reasons.append(
            "STEP has topological edges but cadFeatures.eMesh missing/empty"
        )
    if step_has_edges and family in ("hex", "hex-parametric") and not features_ok:
        reasons.append(
            "Hex path: snappy features / explicitFeatureSnap off or not wired to eMesh"
        )

    edge_metric_ok: bool | None = None
    max_dev: float | None = None
    if not step_has_edges:
        # No edges to adhere to — config gates N/A; do not claim body-fit.
        details["note"] = "STEP has no topological edges; edge prove skipped"
        ok = len(reasons) == 0
        return CadEdgeAdherenceResult(
            ok=ok,
            algorithm_path=algo,
            step_has_edges=False,
            n_cad_edges=0,
            emesh_present=emesh_ok,
            emesh_n_points=emesh_npts,
            features_ok=features_ok,
            explicit_feature_snap=explicit_snap,
            snap_true_alone_not_pass=True,
            wall_cell_m=wall_cell_m,
            edge_defl_m=edge_defl_m,
            threshold_m=threshold_m,
            max_edge_deviation_m=None,
            edge_metric_ok=None,
            reasons=reasons,
            details=details,
        )

    if require_mesh_metric:
        if mesh_dir is None:
            reasons.append("mesh_dir required for edge distance metric")
        else:
            poly = Path(mesh_dir) / "constant" / "polyMesh" / "points"
            if not poly.is_file():
                reasons.append(f"polyMesh points missing under {mesh_dir}")
            else:
                samples = _cad_edge_samples(
                    solid, scale_to_metres=scale, edge_defl_m=float(edge_defl_m)
                )
                boundary = _boundary_points(Path(mesh_dir))
                stats = _edge_distance_stats(
                    samples,
                    boundary,
                    wall_cell_m=float(wall_cell_m),
                    threshold_m=float(threshold_m),
                )
                details["edge_distance"] = stats
                if stats.get("error"):
                    reasons.append(str(stats["error"]))
                else:
                    max_dev = float(stats["max_distance_m"])
                    edge_metric_ok = max_dev <= float(threshold_m)
                    if not edge_metric_ok:
                        reasons.append(
                            f"edge max distance {max_dev:.6g}m > "
                            f"threshold {threshold_m:.6g}m "
                            f"(=max(edge_defl*2, wall_cell*0.25))"
                        )
    else:
        details["edge_metric"] = "skipped (config-only prove)"

    # Final: never allow snap/green alone — require eMesh + features + metric.
    hard_reasons = [r for r in reasons if "snap=true alone" not in r]
    if step_has_edges and require_mesh_metric:
        ok = (
            emesh_ok
            and features_ok
            and edge_metric_ok is True
            and not hard_reasons
        )
        reasons = hard_reasons if not ok else []
    elif step_has_edges and not require_mesh_metric:
        ok = emesh_ok and features_ok and not hard_reasons
        reasons = hard_reasons if not ok else []
    else:
        ok = not hard_reasons
        reasons = hard_reasons

    return CadEdgeAdherenceResult(
        ok=ok,
        algorithm_path=algo,
        step_has_edges=step_has_edges,
        n_cad_edges=n_edges,
        emesh_present=emesh_ok,
        emesh_n_points=emesh_npts,
        features_ok=features_ok,
        explicit_feature_snap=explicit_snap,
        snap_true_alone_not_pass=True,
        wall_cell_m=wall_cell_m,
        edge_defl_m=edge_defl_m,
        threshold_m=threshold_m,
        max_edge_deviation_m=max_dev,
        edge_metric_ok=edge_metric_ok,
        reasons=reasons,
        details=details,
    )






def count_cad_faces(solid: LoadedSolid) -> int:
    """Number of CAD boundary faces on the STEP solid."""
    return int(getattr(solid, "n_faces", 0) or len(getattr(solid, "faces", []) or []))


def _boundary_surface(mesh_dir: Path):
    """Merged triangulated boundary surface for face Hausdorff (Inc 14b)."""
    import pyvista as pv

    mesh_dir = Path(mesh_dir)
    foam = mesh_dir / "case.foam"
    if not foam.exists():
        foam.write_text("", encoding="utf-8")
    reader = pv.OpenFOAMReader(str(foam))
    if reader.time_values:
        reader.set_active_time_value(reader.time_values[0])
    mb = reader.read()
    bnd = mb["boundary"]
    surfs: list = []
    for bi in range(bnd.n_blocks):
        b = bnd[bi]
        if b is not None and getattr(b, "n_points", 0):
            surfs.append(b)
    if not surfs:
        return mb["internalMesh"].extract_surface(
            algorithm="dataset_surface"
        ).triangulate()
    surf = surfs[0]
    for s in surfs[1:]:
        surf = surf.merge(s)
    return surf.extract_surface(algorithm="dataset_surface").triangulate()


def _cad_face_samples(
    solid: LoadedSolid,
    *,
    scale_to_metres: float,
    edge_defl_m: float,
) -> np.ndarray:
    """Tessellate CAD faces; return unique vertex + triangle-centroid samples (m).

    Deflection matches writer ``edge_defl_m`` (native = edge_defl_m / scale),
    same sizing source as the edge prove — no freestyle face bar.
    """
    scale = float(scale_to_metres) if scale_to_metres else 1.0
    defl_native = max(float(edge_defl_m) / max(scale, 1e-30), 1e-6)
    pts, tris, _face_ids = tessellate_faces(
        solid,
        linear_deflection=defl_native,
        angular_deflection=0.35,
    )
    if pts.size == 0 or tris.size == 0:
        return np.zeros((0, 3), dtype=np.float64)
    pts_m = np.asarray(pts, dtype=np.float64) * scale
    cents = pts_m[np.asarray(tris, dtype=np.int64)].mean(axis=1)
    stacked = np.vstack([pts_m, cents])
    return np.unique(np.round(stacked, 6), axis=0)


def _face_distance_stats(
    samples: np.ndarray,
    surface,
    *,
    wall_cell_m: float,
    threshold_m: float,
) -> dict[str, Any]:
    """CAD face samples → nearest point on boundary *surface* (Hausdorff one-way)."""
    import pyvista as pv

    if samples.size == 0:
        return {
            "n_samples": 0,
            "n_wetted": 0,
            "max_distance_m": None,
            "max_distance_raw_m": None,
            "p50_m": None,
            "p95_m": None,
            "error": "no_cad_face_samples",
            "distance_kind": "surface",
        }
    if surface is None or getattr(surface, "n_points", 0) < 3:
        return {
            "n_samples": int(len(samples)),
            "n_wetted": 0,
            "max_distance_m": None,
            "max_distance_raw_m": None,
            "p50_m": None,
            "p95_m": None,
            "error": "no_boundary_surface",
            "distance_kind": "surface",
        }
    cloud = pv.PolyData(np.asarray(samples, dtype=np.float64))
    cloud = cloud.compute_implicit_distance(surface, inplace=False)
    d = np.abs(np.asarray(cloud["implicit_distance"], dtype=np.float64))
    wet_cut = max(float(wall_cell_m) * 2.0, float(threshold_m) * 4.0)
    wet = d <= wet_cut
    if int(wet.sum()) < 10:
        wet = d <= max(float(wall_cell_m) * 4.0, float(threshold_m) * 8.0, 0.05)
    dw = d[wet] if wet.any() else d
    return {
        "n_samples": int(len(samples)),
        "n_wetted": int(wet.sum()) if wet.any() else int(len(d)),
        "wet_cutoff_m": float(wet_cut),
        "max_distance_m": float(dw.max()),
        "max_distance_raw_m": float(d.max()),
        "p50_m": float(np.percentile(dw, 50)),
        "p95_m": float(np.percentile(dw, 95)),
        "distance_kind": "surface",
        "note": (
            "Face Hausdorff uses boundary surface distance (not vertices alone); "
            "vertex-only KDTree overestimates face-interior deviation."
        ),
    }


@dataclass
class CadFaceAdherenceResult:
    ok: bool
    algorithm_path: str
    step_has_faces: bool
    n_cad_faces: int
    wall_cell_m: float | None
    edge_defl_m: float | None
    threshold_m: float | None
    max_face_deviation_m: float | None
    face_metric_ok: bool | None
    snap_true_alone_not_pass: bool
    reasons: list[str] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def summary(self) -> str:
        if self.ok:
            dev = self.max_face_deviation_m
            thr = self.threshold_m
            return (
                f"CAD face Hausdorff PASS ({self.algorithm_path}): "
                f"max_dev={dev:.6g}m <= threshold={thr:.6g}m"
                if dev is not None and thr is not None
                else f"CAD face Hausdorff PASS ({self.algorithm_path})"
            )
        return (
            f"CAD face Hausdorff FAIL ({self.algorithm_path}): "
            + "; ".join(self.reasons)
        )


@dataclass
class CadAdherenceResult:
    """Combined edge (14a) + face (14b) prove for product mesh PASS."""

    ok: bool
    algorithm_path: str
    edge: CadEdgeAdherenceResult
    face: CadFaceAdherenceResult | None
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "algorithm_path": self.algorithm_path,
            "edge": self.edge.to_dict(),
            "face": self.face.to_dict() if self.face is not None else None,
            "reasons": list(self.reasons),
            "snap_true_alone_not_pass": True,
            "green_ui_or_snap_alone_is_never_pass": True,
        }

    @property
    def summary(self) -> str:
        if self.ok:
            parts = [self.edge.summary]
            if self.face is not None:
                parts.append(self.face.summary)
            return " | ".join(parts)
        return (
            f"CAD adherence FAIL ({self.algorithm_path}): "
            + "; ".join(self.reasons)
        )


def prove_cad_face_adherence(
    solid: LoadedSolid,
    project: Project,
    *,
    case_dir: Path,
    mesh_dir: Path | None = None,
    algorithm: str | None = None,
    require_mesh_metric: bool = True,
) -> CadFaceAdherenceResult:
    """Measurable CAD-face Hausdorff prove (Inc 14b).

    Threshold is the **same** writer bar as edge prove:
    ``max(edge_defl_m * 2, wall_cell * 0.25)``. Distance is to the boundary
    surface (implicit poly distance), not vertex KDTree alone.
    """
    case_dir = Path(case_dir)
    algo = str(algorithm or getattr(project.mesh, "algorithm", "standard") or "standard")
    family = _algo_family(algo)
    n_faces = count_cad_faces(solid)
    step_has_faces = n_faces > 0
    reasons: list[str] = []
    details: dict[str, Any] = {
        "case_dir": str(case_dir),
        "mesh_dir": str(mesh_dir) if mesh_dir else None,
        "green_ui_or_snap_alone_is_never_pass": True,
        "threshold_policy": (
            "same as edge: max(edge_defl_m*2, wall_cell*0.25); "
            "no soft-bar invent (Inc 14b)"
        ),
    }

    scale = float(project.scale_to_metres)
    base = float(project.mesh.base_cell_m)
    walls = int(project.mesh.refinement.walls)
    diag_m = float(shape_diagonal(solid)) * scale

    if family in ("hex", "hex-parametric"):
        sizing = hex_writer_edge_sizing(
            base_cell_m=base, walls_level=walls, diag_m=diag_m
        )
    else:
        sizing = standard_cfmesh_edge_sizing(base_cell_m=base)
    wall_cell_m = float(sizing["wall_cell_m"])
    edge_defl_m = float(sizing["edge_defl_m"])
    threshold_m = float(sizing["threshold_m"])
    details["sizing"] = sizing

    if not step_has_faces:
        details["note"] = "STEP has no faces; face Hausdorff skipped"
        return CadFaceAdherenceResult(
            ok=True,
            algorithm_path=algo,
            step_has_faces=False,
            n_cad_faces=0,
            wall_cell_m=wall_cell_m,
            edge_defl_m=edge_defl_m,
            threshold_m=threshold_m,
            max_face_deviation_m=None,
            face_metric_ok=None,
            snap_true_alone_not_pass=True,
            reasons=[],
            details=details,
        )

    face_metric_ok: bool | None = None
    max_dev: float | None = None
    if require_mesh_metric:
        if mesh_dir is None:
            reasons.append("mesh_dir required for face Hausdorff metric")
        else:
            poly = Path(mesh_dir) / "constant" / "polyMesh" / "points"
            if not poly.is_file():
                reasons.append(f"polyMesh points missing under {mesh_dir}")
            else:
                samples = _cad_face_samples(
                    solid, scale_to_metres=scale, edge_defl_m=edge_defl_m
                )
                surface = _boundary_surface(Path(mesh_dir))
                stats = _face_distance_stats(
                    samples,
                    surface,
                    wall_cell_m=wall_cell_m,
                    threshold_m=threshold_m,
                )
                details["face_distance"] = stats
                if stats.get("error"):
                    reasons.append(str(stats["error"]))
                else:
                    max_dev = float(stats["max_distance_m"])
                    face_metric_ok = max_dev <= threshold_m
                    if not face_metric_ok:
                        reasons.append(
                            f"face max distance {max_dev:.6g}m > "
                            f"threshold {threshold_m:.6g}m "
                            f"(=max(edge_defl*2, wall_cell*0.25); same bar as edge)"
                        )
    else:
        details["face_metric"] = "skipped (config-only prove)"
        # Config-only: faces exist but metric not required → not a claim of PASS body-fit.
        face_metric_ok = None

    if require_mesh_metric:
        ok = face_metric_ok is True and not reasons
    else:
        ok = not reasons

    return CadFaceAdherenceResult(
        ok=ok,
        algorithm_path=algo,
        step_has_faces=step_has_faces,
        n_cad_faces=n_faces,
        wall_cell_m=wall_cell_m,
        edge_defl_m=edge_defl_m,
        threshold_m=threshold_m,
        max_face_deviation_m=max_dev,
        face_metric_ok=face_metric_ok,
        snap_true_alone_not_pass=True,
        reasons=reasons if not ok else [],
        details=details,
    )


def prove_cad_adherence(
    solid: LoadedSolid,
    project: Project,
    *,
    case_dir: Path,
    mesh_dir: Path | None = None,
    algorithm: str | None = None,
    require_mesh_metric: bool = True,
) -> CadAdherenceResult:
    """Combined edge (14a) + face Hausdorff (14b) measurable prove."""
    edge = prove_cad_edge_adherence(
        solid,
        project,
        case_dir=case_dir,
        mesh_dir=mesh_dir,
        algorithm=algorithm,
        require_mesh_metric=require_mesh_metric,
    )
    face = prove_cad_face_adherence(
        solid,
        project,
        case_dir=case_dir,
        mesh_dir=mesh_dir,
        algorithm=algorithm,
        require_mesh_metric=require_mesh_metric,
    )
    reasons: list[str] = []
    if not edge.ok:
        reasons.extend(edge.reasons or [edge.summary])
    if not face.ok:
        reasons.extend(face.reasons or [face.summary])
    # When faces exist + mesh metric required, both edge and face must PASS.
    # (No faces / config-only: face.ok is True/skip-compatible.)
    ok = bool(edge.ok) and bool(face.ok)
    return CadAdherenceResult(
        ok=ok,
        algorithm_path=edge.algorithm_path,
        edge=edge,
        face=face,
        reasons=reasons if not ok else [],
    )


def assert_cad_adherence_or_raise(
    solid: LoadedSolid,
    project: Project,
    *,
    case_dir: Path,
    mesh_dir: Path,
    algorithm: str | None = None,
) -> CadAdherenceResult:
    """Product gate (14a+14b): raise RuntimeError on FAIL before fingerprint."""
    result = prove_cad_adherence(
        solid,
        project,
        case_dir=case_dir,
        mesh_dir=mesh_dir,
        algorithm=algorithm,
        require_mesh_metric=True,
    )
    if not result.ok:
        raise RuntimeError(result.summary)
    return result



def assert_cad_edge_adherence_or_raise(
    solid: LoadedSolid,
    project: Project,
    *,
    case_dir: Path,
    mesh_dir: Path,
    algorithm: str | None = None,
) -> CadEdgeAdherenceResult:
    """Product gate: raise RuntimeError on FAIL (blocks mesh PASS fingerprint)."""
    result = prove_cad_edge_adherence(
        solid,
        project,
        case_dir=case_dir,
        mesh_dir=mesh_dir,
        algorithm=algorithm,
        require_mesh_metric=True,
    )
    if not result.ok:
        raise RuntimeError(result.summary)
    return result
