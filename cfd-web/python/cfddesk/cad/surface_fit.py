"""Distance from mesh / surface vertices to STEP faces (body-fit gate)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from OCP.BRep import BRep_Builder
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.gp import gp_Pnt
from OCP.TopoDS import TopoDS_Compound

from cfddesk.cad.step import LoadedSolid

# Plan contract: every boundary vertex on a CAD face (not the solid volume).
VERTEX_ON_FACE_M = 1.0e-6
VF_R_IN = 0.0254
VF_R_OUT = 0.030175
VF_Z_TOP = 0.3048


@dataclass(frozen=True)
class VertexToBrep:
    n_points: int
    n_sampled: int
    p50_m: float
    p95_m: float
    p99_m: float
    max_m: float
    mean_m: float
    frac_lt_1um: float
    frac_lt_10um: float
    ok: bool
    message: str


@dataclass(frozen=True)
class VfWallProbe:
    n_internal: int
    metal_interior: int
    lid_faces: int
    ok: bool
    message: str


def face_compound(solid: LoadedSolid) -> TopoDS_Compound:
    builder = BRep_Builder()
    compound = TopoDS_Compound()
    builder.MakeCompound(compound)
    for rec in solid.faces:
        builder.Add(compound, rec.face)
    return compound


def nearest_on_faces_m(
    point_m: np.ndarray,
    solid: LoadedSolid,
    *,
    scale_to_metres: float,
) -> tuple[np.ndarray, float]:
    """Project one metres-point onto the CAD face compound."""
    scale = float(scale_to_metres)
    if scale <= 0:
        raise ValueError(f"invalid scale_to_metres={scale}")
    xyz = np.asarray(point_m, dtype=float).reshape(3)
    vtx = BRepBuilderAPI_MakeVertex(
        gp_Pnt(float(xyz[0]) / scale, float(xyz[1]) / scale, float(xyz[2]) / scale)
    ).Vertex()
    dist = BRepExtrema_DistShapeShape(vtx, face_compound(solid))
    dist.Perform()
    if not dist.IsDone() or dist.NbSolution() < 1:
        raise RuntimeError("BRepExtrema failed for vertex projection")
    p = dist.PointOnShape2(1)
    snapped = np.asarray(
        [float(p.X()) * scale, float(p.Y()) * scale, float(p.Z()) * scale],
        dtype=float,
    )
    return snapped, float(dist.Value()) * scale


def distances_to_faces_m(
    points_m: np.ndarray,
    solid: LoadedSolid,
    *,
    scale_to_metres: float,
    n_sample: int | None = 4000,
    rng_seed: int = 0,
) -> np.ndarray:
    """Unsigned distance (metres) from points to the CAD *face* compound."""
    pts = np.asarray(points_m, dtype=float)
    if pts.size == 0:
        return np.asarray([], dtype=float)
    if pts.ndim == 1:
        pts = pts.reshape(1, 3)
    if n_sample is not None and len(pts) > int(n_sample):
        rng = np.random.default_rng(rng_seed)
        pts = pts[rng.choice(len(pts), size=int(n_sample), replace=False)]
    scale = float(scale_to_metres)
    if scale <= 0:
        raise ValueError(f"invalid scale_to_metres={scale}")
    compound = face_compound(solid)
    out: list[float] = []
    for xyz in pts:
        vtx = BRepBuilderAPI_MakeVertex(
            gp_Pnt(float(xyz[0]) / scale, float(xyz[1]) / scale, float(xyz[2]) / scale)
        ).Vertex()
        dist = BRepExtrema_DistShapeShape(vtx, compound)
        dist.Perform()
        if dist.IsDone():
            out.append(float(dist.Value()) * scale)
    return np.asarray(out, dtype=float)


def summarize_vertex_distances(
    dists_m: np.ndarray, *, n_points: int, tol_m: float = VERTEX_ON_FACE_M
) -> VertexToBrep:
    d = np.asarray(dists_m, dtype=float)
    if d.size == 0:
        return VertexToBrep(
            n_points=int(n_points),
            n_sampled=0,
            p50_m=0.0,
            p95_m=0.0,
            p99_m=0.0,
            max_m=0.0,
            mean_m=0.0,
            frac_lt_1um=0.0,
            frac_lt_10um=0.0,
            ok=False,
            message="no points to compare to CAD faces",
        )
    p50 = float(np.percentile(d, 50))
    p95 = float(np.percentile(d, 95))
    p99 = float(np.percentile(d, 99))
    mx = float(d.max())
    mean = float(d.mean())
    f1 = float((d < 1.0e-6).mean())
    f10 = float((d < 1.0e-5).mean())
    ok = bool(f1 >= 0.999 and mx <= 10.0 * tol_m)
    msg = (
        f"n={d.size}/{n_points} p50={p50*1e6:.2f}µm p95={p95*1e6:.2f}µm "
        f"max={mx*1e3:.4f}mm frac<1µm={f1:.4f}"
    )
    if not ok:
        msg = "FAIL body-fit vertex gate: " + msg
    return VertexToBrep(
        n_points=int(n_points),
        n_sampled=int(d.size),
        p50_m=p50,
        p95_m=p95,
        p99_m=p99,
        max_m=mx,
        mean_m=mean,
        frac_lt_1um=f1,
        frac_lt_10um=f10,
        ok=ok,
        message=msg,
    )


def boundary_vertex_to_brep(
    mesh_dir: Path,
    solid: LoadedSolid,
    *,
    scale_to_metres: float,
    n_sample: int = 4000,
) -> VertexToBrep:
    """OpenFOAM boundary points → CAD face distances."""
    import pyvista as pv

    mesh_dir = Path(mesh_dir)
    foam = mesh_dir / "case.foam"
    if not foam.exists():
        foam.write_text("", encoding="utf-8")
    reader = pv.OpenFOAMReader(str(foam))
    reader.skip_zero_time = False
    try:
        reader.enable_all_patches = True
    except Exception:
        pass
    if reader.time_values:
        reader.set_active_time_value(reader.time_values[0])
    mb = reader.read()
    pts: list[np.ndarray] = []
    if "boundary" in mb.keys():
        bnd = mb["boundary"]
        if not isinstance(bnd, pv.MultiBlock):
            raise RuntimeError("OpenFOAM boundary is not a block collection")
        for i in range(bnd.n_blocks):
            b = bnd[i]
            if isinstance(b, pv.DataSet) and b.n_points > 0:
                pts.append(np.asarray(b.points))
    if not pts:
        raise RuntimeError(f"no boundary points in {mesh_dir}")
    all_pts = np.unique(np.round(np.vstack(pts), 9), axis=0)
    cap = int(n_sample)
    sample = None if len(all_pts) <= cap else cap
    dists = distances_to_faces_m(
        all_pts, solid, scale_to_metres=scale_to_metres, n_sample=sample
    )
    return summarize_vertex_distances(dists, n_points=len(all_pts))


def vf_wall_probe(mesh_dir: Path) -> VfWallProbe:
    """Fluid cells in the vortex-finder metal annulus + roof lid faces."""
    import pyvista as pv

    mesh_dir = Path(mesh_dir)
    foam = mesh_dir / "case.foam"
    if not foam.exists():
        foam.write_text("", encoding="utf-8")
    reader = pv.OpenFOAMReader(str(foam))
    reader.skip_zero_time = False
    try:
        reader.enable_all_patches = True
    except Exception:
        pass
    if reader.time_values:
        reader.set_active_time_value(reader.time_values[0])
    internal = reader.read()["internalMesh"]
    if not isinstance(internal, pv.DataSet):
        raise RuntimeError("OpenFOAM internal mesh is missing")
    cc = np.asarray(internal.cell_centers().points)
    r = np.hypot(cc[:, 0], cc[:, 1])
    metal = (
        (cc[:, 2] > 0.260)
        & (cc[:, 2] < 0.300)
        & (r > VF_R_IN)
        & (r < VF_R_OUT)
    )
    try:
        surf = internal.extract_surface(algorithm="dataset_surface")
    except TypeError:
        surf = internal.extract_surface()
    surf = surf.compute_normals(
        cell_normals=True, point_normals=False, auto_orient_normals=False
    )
    scc = np.asarray(surf.cell_centers().points)
    nrm = np.asarray(surf.cell_data["Normals"])
    sr = np.hypot(scc[:, 0], scc[:, 1])
    lid = (
        (np.abs(scc[:, 2] - VF_Z_TOP) < 0.008)
        & (np.abs(nrm[:, 2]) > 0.7)
        & (sr > VF_R_IN + 0.0003)
        & (sr < VF_R_OUT - 0.0003)
    )
    n_metal = int(metal.sum())
    n_lid = int(lid.sum())
    ok = n_metal == 0 and n_lid == 0
    msg = (
        f"n_cells={internal.n_cells} metal_interior={n_metal} lid_faces={n_lid}"
    )
    return VfWallProbe(
        n_internal=int(internal.n_cells),
        metal_interior=n_metal,
        lid_faces=n_lid,
        ok=ok,
        message=msg,
    )
