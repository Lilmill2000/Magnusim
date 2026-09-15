"""SimScale-style *Standard* mesher: uniform CAD-fitted surface, tet shell,
Cartesian hex core joined by pyramids, prism layers added by snappyHexMesh.

This is the surface-first body-fitted backend. It is independent of the frozen
cfMesh ``cartesianMesh`` path (``cfmesh_standard.py`` + HEXCORE-PROCESS-BACKUP).

Pipeline (host side, this module)
    1. gmsh OCC import of the STEP (scaled to metres) → uniform triangulated
       surface at ``h_s`` with curvature refinement (min 0.5·h_s).
    2. Hex element core ON: Cartesian lattice at ``h_c`` clipped to the fluid
       interior with a clearance band, made manifold, capped with pyramids
       (apex half a lattice step outside every boundary quad). The unshared
       pyramid faces form a closed inner surface; gmsh fills the shell between
       CAD surface and inner surface with tets (HXT).
       Hex element core OFF: gmsh fills the whole volume with tets, growing
       from ``h_s`` at the surface with the global gradation rate.
    3. MSH 2.2 written with physical surface groups per boundary patch.

WSL side (``cfddesk.wsl.mesh_run.run_standard_pipeline``): gmshToFoam → patch
types → snappyHexMesh (layers only, absolute thickness 0.4·h_s) → checkMesh.

Sizing calibration (SimScale Standard, Automatic sizing, fineness 5):
    h_s ≈ 0.007 × bounding-box diagonal; h(F) = h_5 · 2^((5−F)/3).
    Elbow  (diag 32 mm)  F=5 → 217.5k cells (SimScale 217.5k).
    Cyclone (diag 0.92 m) F=5 → ≈ 695k cells target.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from cfddesk.cad.step import LoadedSolid
from cfddesk.mesh.msh22 import HEX, PYR, TET, TRI
from cfddesk.project.model import Project

# ---------------------------------------------------------------- sizing ----

# SimScale Automatic sizing, fineness 5: surface edge length as a (slightly
# sub-linear) power law of the bounding-box diagonal, calibrated on the two
# reference meshes (elbow 32 mm diag → 217.5k cells, cyclone 0.92 m → 695k).
_SIZING_REF_DIAG_M = 0.032
_SIZING_REF_H_M = 0.240e-3
_SIZING_DIAG_EXPONENT = 0.96
# Curvature refinement: nodes per 2π (SimScale "Automatic" curvature).
_CURVATURE_NODES_PER_2PI = 24
# Surface size floor relative to h_s — keeps the surface *uniform* (no dark
# bands at fillets / corners), a hard requirement from the reference meshes.
_MIN_SIZE_FRACTION = 0.5
# Physics-based meshing: inlet / outlet surfaces one gradation notch finer.
_PHYSICS_IO_FACTOR = 0.7
# Hex core clearance from the CAD surface in units of h_s (plus 0.5·h_c).
_CORE_CLEARANCE_HS = 1.5
# Automatic boundary layers = SimScale inflate defaults.
BL_N_LAYERS = 3
BL_RELATIVE_THICKNESS = 0.4
BL_EXPANSION = 1.5
BL_MIN_THICKNESS_FRACTION = 0.2
# Small feature suppression default relative to the bbox diagonal.
_SFS_PER_DIAG = 1.0e-4
# Global gradation (hex core OFF): tets grow linearly to this multiple of h_s.
_GRADATION_MAX_SIZE_HS = 6.0


def standard_surface_size_m(diag_m: float, fineness: int) -> float:
    """Uniform surface edge length for SimScale-style Automatic sizing."""
    f = max(1, min(10, int(fineness)))
    h5 = _SIZING_REF_H_M * (float(diag_m) / _SIZING_REF_DIAG_M) ** _SIZING_DIAG_EXPONENT
    return h5 * 2.0 ** ((5 - f) / 3.0)


def default_small_feature_suppression_m(diag_m: float) -> float:
    return float(diag_m) * _SFS_PER_DIAG


@dataclass(frozen=True)
class StandardSizing:
    fineness: int
    bbox_m: tuple[float, float, float]
    diag_m: float
    h_surface_m: float
    h_core_m: float
    small_feature_m: float
    gap_refinement_factor: float
    gradation: float
    n_layers: int = BL_N_LAYERS
    layer_thickness_m: float = 0.0
    layer_min_thickness_m: float = 0.0
    layer_expansion: float = BL_EXPANSION

    @staticmethod
    def automatic(
        bbox_m: tuple[float, float, float],
        *,
        fineness: int,
        small_feature_m: float | None = None,
        gap_refinement_factor: float = 0.05,
        gradation: float = 1.22,
    ) -> "StandardSizing":
        dx, dy, dz = (float(v) for v in bbox_m)
        diag = math.sqrt(dx * dx + dy * dy + dz * dz)
        if diag <= 0:
            raise ValueError("degenerate bounding box")
        h = standard_surface_size_m(diag, fineness)
        sfs = (
            default_small_feature_suppression_m(diag)
            if small_feature_m is None
            else max(0.0, float(small_feature_m))
        )
        thick = BL_RELATIVE_THICKNESS * h
        return StandardSizing(
            fineness=int(fineness),
            bbox_m=(dx, dy, dz),
            diag_m=diag,
            h_surface_m=h,
            h_core_m=h,
            small_feature_m=sfs,
            gap_refinement_factor=float(gap_refinement_factor),
            gradation=max(1.0, min(3.0, float(gradation))),
            layer_thickness_m=thick,
            layer_min_thickness_m=BL_MIN_THICKNESS_FRACTION * thick,
        )


@dataclass(frozen=True)
class LayerPatchSpec:
    """Per-patch snappy addLayers request (Automatic BL or Inflate).

    ``specify`` chooses which of firstLayerThickness / thickness / expansionRatio
    are written. OpenFOAM rejects first + thickness + expansion together.
    """

    name: str
    n_layers: int
    thickness_m: float | None = None
    first_layer_m: float | None = None
    expansion: float | None = None
    min_thickness_m: float | None = None
    specify: str = "total"  # first | total | first_and_total


@dataclass
class StandardMeshResult:
    msh_path: Path
    n_nodes: int
    n_tris: int
    n_tets: int
    n_hex: int
    n_pyr: int
    hex_core_applied: bool
    hex_core_note: str
    patch_names: list[str]
    wall_patches: list[str]
    volume_error_rel: float | None
    wall_s: float
    log: list[str] = field(default_factory=list)

    @property
    def n_cells(self) -> int:
        return self.n_tets + self.n_hex + self.n_pyr


# ------------------------------------------------------------ hex core -------


def _manifold_lut() -> np.ndarray:
    """256-entry table: is the 2×2×2 in/out block around a lattice vertex a
    manifold configuration (in-set and out-set each 6-connected)?"""
    from scipy import ndimage

    lut = np.zeros(256, dtype=bool)
    for cfg in range(256):
        bits = np.array([(cfg >> b) & 1 for b in range(8)], dtype=bool)
        blk = bits.reshape(2, 2, 2)  # blk[di, dj, dk] ↔ bit di*4 + dj*2 + dk
        n_in = int(blk.sum())
        if n_in == 0 or n_in == 8:
            lut[cfg] = True
            continue
        lut[cfg] = ndimage.label(blk)[1] == 1 and ndimage.label(~blk)[1] == 1
    return lut


_MANIFOLD_LUT: np.ndarray | None = None


def _vertex_configs(core_p: np.ndarray) -> np.ndarray:
    """Pack the 8 cells around every interior lattice vertex of the padded
    core array into an 8-bit configuration index."""
    cfg = np.zeros(tuple(n - 1 for n in core_p.shape), dtype=np.uint8)
    for di in (0, 1):
        for dj in (0, 1):
            for dk in (0, 1):
                b = di * 4 + dj * 2 + dk
                sl = core_p[
                    di : core_p.shape[0] - 1 + di,
                    dj : core_p.shape[1] - 1 + dj,
                    dk : core_p.shape[2] - 1 + dk,
                ]
                cfg |= (sl.astype(np.uint8) << b)
    return cfg


def _repair_core(core: np.ndarray, log) -> tuple[np.ndarray, int]:
    """Make the in-set a closed 2-manifold cell complex:

    * remove 1-cell slots (out-cell with in-neighbours on opposite sides —
      two pyramids would share an apex and pinch the inner surface),
    * remove all in-cells around any non-manifold lattice vertex,
    * drop tiny disconnected islands.
    Iterates until stable. Returns (core, cells_removed)."""
    global _MANIFOLD_LUT
    from scipy import ndimage

    if _MANIFOLD_LUT is None:
        _MANIFOLD_LUT = _manifold_lut()
    n0 = int(core.sum())
    core = core.copy()
    for it in range(1, 200):
        changed = False
        p = np.pad(core, 1, constant_values=False)
        # 1-cell slots along each axis
        for axis in range(3):
            minus = np.roll(p, 1, axis=axis)
            plus = np.roll(p, -1, axis=axis)
            slot = (~p) & minus & plus
            if slot.any():
                # remove the in-cell on the + side of every slot
                kill = np.roll(slot, 1, axis=axis)
                p &= ~kill
                changed = True
        # non-manifold vertices
        cfg = _vertex_configs(p)
        bad = ~_MANIFOLD_LUT[cfg]
        if bad.any():
            kill = np.zeros_like(p)
            for di in (0, 1):
                for dj in (0, 1):
                    for dk in (0, 1):
                        kill[
                            di : p.shape[0] - 1 + di,
                            dj : p.shape[1] - 1 + dj,
                            dk : p.shape[2] - 1 + dk,
                        ] |= bad
            p &= ~kill
            changed = True
        # tiny islands (< 3×3×3 cells) are not worth a pyramid cap
        lab, nc = ndimage.label(p)
        if nc > 1:
            sizes = ndimage.sum(p, lab, index=np.arange(1, nc + 1))
            small = [i + 1 for i, s in enumerate(sizes) if s < 27]
            if small:
                p &= ~np.isin(lab, small)
                changed = True
        core = p[1:-1, 1:-1, 1:-1]
        if not changed:
            log(f"hexcore: manifold repair converged after {it} pass(es)")
            break
    return core, n0 - int(core.sum())


# Pyramid base corner offsets (in half-lattice units, relative to the cell
# origin) per (axis, sign). Ordered so the right-hand normal points toward
# the apex, which is gmsh's pyramid convention (base 0-3, apex 4).
def _quad_offsets(axis: int, sign: int) -> tuple[np.ndarray, np.ndarray]:
    off = 2 if sign > 0 else 0
    if axis == 0:
        q = [(off, 0, 0), (off, 2, 0), (off, 2, 2), (off, 0, 2)]
        apex = (off + sign, 1, 1)
    elif axis == 1:
        q = [(0, off, 0), (2, off, 0), (2, off, 2), (0, off, 2)]
        apex = (1, off + sign, 1)
    else:
        q = [(0, 0, off), (2, 0, off), (2, 2, off), (0, 2, off)]
        apex = (1, 1, off + sign)
    q = np.asarray(q, dtype=np.int64)
    a = np.asarray(apex, dtype=np.int64)
    nrm = np.cross(q[1] - q[0], q[2] - q[0])
    if np.dot(nrm, a - q[0]) < 0:
        q = q[::-1].copy()
    return q, a


@dataclass
class _HexCore:
    origin: np.ndarray
    hc: float
    keys: np.ndarray  # (N_nodes, 3) half-lattice integer coordinates
    hexes: np.ndarray  # (N_hex, 8) node rows
    pyrs: np.ndarray  # (N_pyr, 5) node rows
    inner_tris: np.ndarray  # (N_tri, 3) node rows — closed inner surface
    n_removed: int

    def xyz(self) -> np.ndarray:
        return self.origin[None, :] + self.keys.astype(float) * (self.hc / 2.0)


def _build_hex_core(
    surf_nodes: np.ndarray,
    surf_tris: np.ndarray,
    *,
    h_s: float,
    h_c: float,
    log,
) -> _HexCore | None:
    """Cartesian core inside the closed triangulated surface, capped with pyramids."""
    import pyvista as pv
    from scipy.spatial import cKDTree

    t0 = time.monotonic()
    P = surf_nodes[surf_tris]  # (T,3,3)
    cent = P.mean(axis=1)
    r_max = float(np.sqrt(((P - cent[:, None, :]) ** 2).sum(axis=2)).max())

    bmin = surf_nodes.min(axis=0)
    bmax = surf_nodes.max(axis=0)
    ext = bmax - bmin
    n = np.ceil(ext / h_c).astype(int) + 1
    if int(np.prod(n)) > 60_000_000:
        log(f"hexcore: lattice too large ({np.prod(n)} vertices) — skipping core")
        return None
    origin = bmin - 0.5 * ((n - 1) * h_c - ext)  # centre the lattice in the bbox
    gx = origin[0] + h_c * np.arange(n[0])
    gy = origin[1] + h_c * np.arange(n[1])
    gz = origin[2] + h_c * np.arange(n[2])
    GX, GY, GZ = np.meshgrid(gx, gy, gz, indexing="ij")
    pts = np.column_stack([GX.ravel(), GY.ravel(), GZ.ravel()])

    # distance lower bound: centroid distance minus max centroid→vertex radius
    tree = cKDTree(cent)
    d_c, _ = tree.query(pts, workers=-1)
    d_lb = d_c - r_max
    clear = _CORE_CLEARANCE_HS * h_s + 0.5 * h_c
    near = d_lb < clear
    # inside test only for vertices that pass the clearance (cheaper)
    cand = np.flatnonzero(~near)
    inside = np.zeros(len(pts), dtype=bool)
    if len(cand):
        faces = np.hstack(
            [np.full((len(surf_tris), 1), 3, dtype=np.int64), surf_tris.astype(np.int64)]
        ).ravel()
        surf_pd = pv.PolyData(surf_nodes.copy(), faces)
        cloud = pv.PolyData(pts[cand])
        try:
            enc = cloud.select_enclosed_points(surf_pd, tolerance=0.0, check_surface=False)
        except TypeError:  # older pyvista
            enc = cloud.select_enclosed_points(surf_pd, tolerance=0.0)
        inside[cand] = np.asarray(enc["SelectedPoints"], dtype=bool)
    good = inside.reshape(tuple(n))
    core = (
        good[:-1, :-1, :-1]
        & good[1:, :-1, :-1]
        & good[:-1, 1:, :-1]
        & good[1:, 1:, :-1]
        & good[:-1, :-1, 1:]
        & good[1:, :-1, 1:]
        & good[:-1, 1:, 1:]
        & good[1:, 1:, 1:]
    )
    n_raw = int(core.sum())
    log(
        f"hexcore: lattice {n[0]-1}×{n[1]-1}×{n[2]-1} h_c={h_c:.4g} m, "
        f"{n_raw} raw core cells ({time.monotonic()-t0:.1f}s)"
    )
    if n_raw == 0:
        return None
    core, n_removed = _repair_core(core, log)
    n_core = int(core.sum())
    if n_core == 0:
        return None

    # --- hexes
    cells = np.argwhere(core).astype(np.int64)  # (N,3)
    base2 = cells * 2
    corner_off = np.array(
        [
            (0, 0, 0), (2, 0, 0), (2, 2, 0), (0, 2, 0),
            (0, 0, 2), (2, 0, 2), (2, 2, 2), (0, 2, 2),
        ],
        dtype=np.int64,
    )
    hex_keys = base2[:, None, :] + corner_off[None, :, :]  # (N,8,3)

    # --- boundary quads → pyramids
    core_p = np.pad(core, 1, constant_values=False)
    pyr_keys_list = []
    for axis in range(3):
        for sign in (-1, 1):
            neigh = np.roll(core_p, -sign, axis=axis)
            bnd = core_p & ~neigh
            idx = np.argwhere(bnd).astype(np.int64) - 1
            if len(idx) == 0:
                continue
            q, a = _quad_offsets(axis, sign)
            b2 = idx * 2
            keys = np.concatenate(
                [b2[:, None, :] + q[None, :, :], (b2 + a[None, :])[:, None, :]], axis=1
            )  # (M,5,3)
            pyr_keys_list.append(keys)
    pyr_keys = np.concatenate(pyr_keys_list, axis=0) if pyr_keys_list else np.zeros((0, 5, 3), np.int64)

    # --- unique nodes
    all_keys = np.concatenate([hex_keys.reshape(-1, 3), pyr_keys.reshape(-1, 3)], axis=0)
    ukeys, inv = np.unique(all_keys, axis=0, return_inverse=True)
    inv = inv.ravel()
    hexes = inv[: hex_keys.shape[0] * 8].reshape(-1, 8)
    pyrs = inv[hex_keys.shape[0] * 8 :].reshape(-1, 5)

    # --- inner surface = pyramid side faces not shared by two pyramids
    b = pyrs[:, :4]
    a = pyrs[:, 4]
    tris = np.stack(
        [
            np.column_stack([b[:, 0], b[:, 1], a]),
            np.column_stack([b[:, 1], b[:, 2], a]),
            np.column_stack([b[:, 2], b[:, 3], a]),
            np.column_stack([b[:, 3], b[:, 0], a]),
        ],
        axis=1,
    ).reshape(-1, 3)
    skey = np.sort(tris, axis=1)
    _, first, counts = np.unique(skey, axis=0, return_index=True, return_counts=True)
    keep_rows = first[counts == 1]
    inner = tris[np.sort(keep_rows)]
    n_shared = int((counts == 2).sum())
    if (counts > 2).any():
        raise RuntimeError("hexcore: inner surface has a triangle shared by >2 pyramids")
    # closed-surface check: every edge used exactly twice
    e = np.concatenate([inner[:, [0, 1]], inner[:, [1, 2]], inner[:, [2, 0]]], axis=0)
    e = np.sort(e, axis=1)
    _, ecount = np.unique(e, axis=0, return_counts=True)
    if not np.all(ecount == 2):
        raise RuntimeError(
            f"hexcore: inner surface not closed ({int((ecount != 2).sum())} bad edges)"
        )
    log(
        f"hexcore: {n_core} hexes, {len(pyrs)} pyramids, {len(inner)} inner tris "
        f"({n_shared} shared faces dropped, {n_removed} cells removed in repair, "
        f"{time.monotonic()-t0:.1f}s)"
    )
    return _HexCore(
        origin=np.asarray(origin, dtype=float),
        hc=float(h_c),
        keys=ukeys,
        hexes=hexes,
        pyrs=pyrs,
        inner_tris=inner,
        n_removed=n_removed,
    )


# ------------------------------------------------------- gap refinement -------


def _gap_sizes(
    nodes: np.ndarray, tris: np.ndarray, *, h: float, gap_factor: float, log
) -> np.ndarray | None:
    """Per-triangle target size from the SimScale gap refinement factor.

    ``gap_factor`` = gap thickness / edge length in the gap. A triangle facing
    an opposite wall at distance ``t`` gets size ``min(h, t / gap_factor)``.
    Returns None when no triangle needs refinement."""
    from scipy.spatial import cKDTree

    g = float(gap_factor)
    if g <= 0:
        return None
    r_max = g * h * 1.05  # gaps thicker than this never refine below h
    P = nodes[tris]
    cent = P.mean(axis=1)
    nrm = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    nlen = np.linalg.norm(nrm, axis=1)
    ok = nlen > 0
    nrm[ok] /= nlen[ok][:, None]
    tree = cKDTree(cent)
    pairs = tree.query_pairs(r_max, output_type="ndarray")
    if len(pairs) == 0:
        return None
    i, j = pairs[:, 0], pairs[:, 1]
    d = cent[j] - cent[i]
    # opposing normals and displacement along the normal
    opp = (nrm[i] * nrm[j]).sum(axis=1) < -0.5
    along = (d * nrm[i]).sum(axis=1)
    lateral = np.linalg.norm(d - along[:, None] * nrm[i], axis=1)
    sel = opp & (np.abs(along) > 1e-12) & (lateral < 0.75 * h)
    if not sel.any():
        return None
    t = np.abs(along[sel])
    size = np.full(len(tris), h, dtype=float)
    want = t / g
    np.minimum.at(size, i[sel], want)
    np.minimum.at(size, j[sel], want)
    size = np.maximum(size, _MIN_SIZE_FRACTION * h * 0.5)
    n_ref = int((size < 0.95 * h).sum())
    if n_ref == 0:
        return None
    log(f"gap refinement: {n_ref} surface triangles refined (factor {g})")
    return size


# ----------------------------------------------------------- msh writer -------


def _write_msh2(
    path: Path,
    nodes: np.ndarray,
    *,
    blocks: list[tuple[int, np.ndarray, np.ndarray | int]],
    physical_names: dict[int, tuple[int, str]],
) -> None:
    """Fast MSH 2.2 writer. ``blocks``: (etype, conn 0-based (N,k), phys tag or per-row tags)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    out: list[str] = ["$MeshFormat\n2.2 0 8\n$EndMeshFormat\n$PhysicalNames\n"]
    out.append(f"{len(physical_names)}\n")
    for tag in sorted(physical_names):
        dim, name = physical_names[tag]
        out.append(f'{dim} {tag} "{name}"\n')
    out.append("$EndPhysicalNames\n$Nodes\n")
    out.append(f"{len(nodes)}\n")
    ids = np.arange(1, len(nodes) + 1)
    node_rows = np.column_stack([ids.astype(float), nodes])
    out.append(
        "\n".join(
            f"{int(r[0])} {r[1]:.16g} {r[2]:.16g} {r[3]:.16g}" for r in node_rows
        )
    )
    out.append("\n$EndNodes\n$Elements\n")
    total = sum(int(len(c)) for _, c, _ in blocks)
    out.append(f"{total}\n")
    eid = 1
    for etype, conn, phys in blocks:
        conn = np.asarray(conn, dtype=np.int64) + 1
        m = len(conn)
        if m == 0:
            continue
        ptag = (
            np.full(m, int(phys), dtype=np.int64)
            if np.isscalar(phys)
            else np.asarray(phys, dtype=np.int64)
        )
        eids = np.arange(eid, eid + m, dtype=np.int64)
        head = np.column_stack([eids, np.full(m, etype), np.full(m, 2), ptag, ptag, conn])
        out.append("\n".join(" ".join(map(str, row)) for row in head.tolist()))
        out.append("\n")
        eid += m
    out.append("$EndElements\n")
    path.write_text("".join(out), encoding="ascii", newline="\n")


# ------------------------------------------------------------- main -----------


def build_standard_msh(
    step_path: Path,
    solid: LoadedSolid,
    project: Project,
    out_msh: Path,
    *,
    scale_to_metres: float,
    sizing: StandardSizing,
    hex_core: bool = True,
    physics_based: bool = True,
    extra_face_sizes: dict[int, float] | None = None,
    extra_face_mins: dict[int, float] | None = None,
    n_threads: int = 16,
    log=None,
) -> StandardMeshResult:
    """Generate the Standard mesh (MSH 2.2) for ``solid`` / ``project``."""
    import gmsh

    from cfddesk.mesh.gmsh_standard import (
        _inlet_outlet_surface_tags,
        _match_occ_surfaces,
        emitted_patch_types,
    )

    lines: list[str] = []

    def _log(msg: str) -> None:
        lines.append(msg)
        if log is not None:
            log(msg)

    t0 = time.monotonic()
    h = float(sizing.h_surface_m)
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("General.NumThreads", int(n_threads))
        gmsh.option.setNumber("Mesh.MaxNumThreads2D", int(n_threads))
        gmsh.option.setNumber("Mesh.MaxNumThreads3D", int(n_threads))
        gmsh.option.setNumber("Geometry.OCCScaling", float(scale_to_metres))

        def _import(heal_tol: float):
            gmsh.model.add("standard")
            gmsh.model.occ.importShapes(str(step_path))
            gmsh.model.occ.synchronize()
            if heal_tol > 0:
                # Small feature suppression: heal tiny edges / sliver faces
                # below the suppression length so they do not force refinement.
                gmsh.model.occ.healShapes(
                    gmsh.model.getEntities(3), tolerance=heal_tol,
                    fixDegenerated=True, fixSmallEdges=True, fixSmallFaces=True,
                    sewFaces=False, makeSolids=False,
                )
                gmsh.model.occ.synchronize()
                # healShapes can leave the pre-heal faces behind as orphan
                # surfaces; they would be meshed twice (coplanar duplicates).
                bounding: set[int] = set()
                for _d, v in gmsh.model.getEntities(3):
                    _up, down = gmsh.model.getAdjacencies(3, v)
                    bounding.update(int(t) for t in down)
                orphans = [(2, t) for _d, t in gmsh.model.getEntities(2) if int(t) not in bounding]
                if orphans:
                    gmsh.model.occ.remove(orphans, recursive=True)
                    gmsh.model.occ.synchronize()
                    _log(f"removed {len(orphans)} orphan surface(s) left by healing")
            return _match_occ_surfaces(
                gmsh, solid, project, scale=float(scale_to_metres), lc=h
            )

        sfs = float(sizing.small_feature_m)
        try:
            face_to_tag, patch_tags, vols, _tol = _import(sfs)
            if sfs > 0:
                _log(f"small feature suppression: features below {sfs:.3g} m suppressed")
        except Exception as exc:
            if sfs <= 0:
                raise
            _log(f"small feature suppression skipped ({str(exc)[:160]})")
            gmsh.model.remove()
            face_to_tag, patch_tags, vols, _tol = _import(0.0)
        try:
            cad_vol = float(sum(gmsh.model.occ.getMass(3, t) for _, t in vols))
        except Exception:
            cad_vol = None
        patch_types = emitted_patch_types(project)
        # only the surfaces bounding the fluid volume(s) are meshed
        surfs = sorted(
            {int(t) for _d, v in vols for t in gmsh.model.getAdjacencies(3, v)[1]}
        )
        for name in list(patch_tags):
            patch_tags[name] = [t for t in patch_tags[name] if int(t) in set(surfs)]
        assigned = {t for tags in patch_tags.values() for t in tags}
        stray = [t for t in surfs if t not in assigned]
        if stray:
            # Leftover surfaces belong with the default `walls`, not with an
            # explicit Wall BC patch (which may be slip).
            wall_name = "walls" if "walls" in patch_types else next(
                (n for n, ty in patch_types.items() if ty == "wall"), "walls"
            )
            patch_tags.setdefault(wall_name, []).extend(stray)
            patch_types.setdefault(wall_name, "wall")
            _log(f"{len(stray)} unassigned CAD surface(s) added to {wall_name}")
        patch_names = sorted(patch_tags)
        phys_of_patch = {name: i + 1 for i, name in enumerate(patch_names)}
        tag_to_phys: dict[int, int] = {}
        for name in patch_names:
            gmsh.model.addPhysicalGroup(2, patch_tags[name], phys_of_patch[name], name)
            for t in patch_tags[name]:
                tag_to_phys[int(t)] = phys_of_patch[name]
        wall_patches = [n for n in patch_names if patch_types.get(n) == "wall"]

        # --- sizing
        extra_face_sizes = extra_face_sizes or {}
        extra_face_mins = extra_face_mins or {}
        extra_vals = [float(v) for v in extra_face_sizes.values() if float(v) > 0]
        extra_min_vals = [float(v) for v in extra_face_mins.values() if float(v) > 0]
        h_min = max(_MIN_SIZE_FRACTION * h, sfs)
        if extra_vals:
            h_min = min(h_min, min(extra_vals))
        if extra_min_vals:
            h_min = max(h_min, min(extra_min_vals))
        h_max = max([h] + extra_vals) if extra_vals else h
        gmsh.option.setNumber("Mesh.MeshSizeMin", max(h_min, 1e-6))
        gmsh.option.setNumber("Mesh.MeshSizeMax", h_max)
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", _CURVATURE_NODES_PER_2PI)
        gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
        gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
        gmsh.option.setNumber("Mesh.Algorithm", 6)  # Frontal-Delaunay (uniform tris)
        gmsh.option.setNumber("Mesh.Algorithm3D", 10)  # HXT
        gmsh.option.setNumber("Mesh.Optimize", 1)
        gmsh.option.setNumber("Mesh.Smoothing", 3)

        fields: list[int] = []
        inlet_tags, outlet_tags = _inlet_outlet_surface_tags(project, face_to_tag)
        if physics_based and (inlet_tags or outlet_tags):
            f = gmsh.model.mesh.field.add("Constant")
            gmsh.model.mesh.field.setNumbers(f, "SurfacesList", inlet_tags + outlet_tags)
            gmsh.model.mesh.field.setNumber(f, "VIn", max(h_min, _PHYSICS_IO_FACTOR * h))
            gmsh.model.mesh.field.setNumber(f, "VOut", 1e22)
            fields.append(f)
            _log(
                f"physics-based: {len(inlet_tags)} inlet + {len(outlet_tags)} outlet "
                f"surface(s) at {_PHYSICS_IO_FACTOR:.2f}·h"
            )
        if extra_face_sizes:
            groups: dict[float, list[int]] = {}
            skipped = 0
            for fid, sz in extra_face_sizes.items():
                tag = face_to_tag.get(int(fid))
                if tag is None:
                    skipped += 1
                    continue
                groups.setdefault(round(float(sz), 9), []).append(int(tag))
            for sz, tags in groups.items():
                f = gmsh.model.mesh.field.add("Constant")
                gmsh.model.mesh.field.setNumbers(f, "SurfacesList", tags)
                gmsh.model.mesh.field.setNumber(f, "VIn", max(float(sz), 1e-6))
                gmsh.model.mesh.field.setNumber(f, "VOut", 1e22)
                fields.append(f)
                _log(f"surface custom sizing: {len(tags)} face(s) at {sz:.4g} m")
            if skipped:
                _log(f"surface custom sizing: {skipped} face(s) not matched on the CAD")
        use_core = bool(hex_core)
        if not use_core and sizing.gradation > 1.0:
            # linear growth h → h_max with adjacent-cell ratio ≈ gradation
            h_max = _GRADATION_MAX_SIZE_HS * h
            dist = gmsh.model.mesh.field.add("Distance")
            gmsh.model.mesh.field.setNumbers(dist, "SurfacesList", surfs)
            gmsh.model.mesh.field.setNumber(dist, "Sampling", 60)
            thr = gmsh.model.mesh.field.add("Threshold")
            gmsh.model.mesh.field.setNumber(thr, "InField", dist)
            gmsh.model.mesh.field.setNumber(thr, "SizeMin", h)
            gmsh.model.mesh.field.setNumber(thr, "SizeMax", h_max)
            gmsh.model.mesh.field.setNumber(thr, "DistMin", 0.0)
            gmsh.model.mesh.field.setNumber(thr, "DistMax", (h_max - h) / (sizing.gradation - 1.0))
            fields.append(thr)
            gmsh.option.setNumber("Mesh.MeshSizeMax", h_max)
        if fields:
            fmin = gmsh.model.mesh.field.add("Min")
            gmsh.model.mesh.field.setNumbers(fmin, "FieldsList", fields)
            gmsh.model.mesh.field.setAsBackgroundMesh(fmin)

        # --- surface mesh
        gmsh.model.mesh.generate(2)
        nodes, tris, tri_phys = _collect_surface(gmsh, surfs, tag_to_phys)
        _log(f"surface: {len(tris)} triangles, {len(nodes)} nodes at h={h:.4g} m ({time.monotonic()-t0:.1f}s)")

        # --- gap refinement (SimScale gap refinement factor)
        gap = _gap_sizes(nodes, tris, h=h, gap_factor=sizing.gap_refinement_factor, log=_log)
        if gap is not None:
            view = gmsh.view.add("gap_size")
            P = nodes[tris]
            data = np.column_stack(
                [P[:, :, 0], P[:, :, 1], P[:, :, 2], np.repeat(gap[:, None], 3, axis=1)]
            ).ravel()
            gmsh.view.addListData(view, "ST", len(tris), data.tolist())
            pv_field = gmsh.model.mesh.field.add("PostView")
            gmsh.model.mesh.field.setNumber(pv_field, "ViewTag", view)
            fields.append(pv_field)
            fmin = gmsh.model.mesh.field.add("Min")
            gmsh.model.mesh.field.setNumbers(fmin, "FieldsList", fields)
            gmsh.model.mesh.field.setAsBackgroundMesh(fmin)
            gmsh.option.setNumber("Mesh.MeshSizeMin", max(sfs, 0.25 * h_min))
            gmsh.model.mesh.clear()
            gmsh.model.mesh.generate(2)
            nodes, tris, tri_phys = _collect_surface(gmsh, surfs, tag_to_phys)
            _log(f"surface (gap-refined): {len(tris)} triangles, {len(nodes)} nodes")

        # --- volume
        core: _HexCore | None = None
        core_note = "hex element core off"
        if use_core:
            if len(vols) != 1:
                core_note = f"hex element core skipped: {len(vols)} volumes (single solid only)"
                _log(core_note)
            else:
                core = _build_hex_core(nodes, tris, h_s=h, h_c=float(sizing.h_core_m), log=_log)
                core_note = "hex element core on" if core is not None else "hex element core skipped: no room for core cells"
                if core is None:
                    _log(core_note)

        tets: np.ndarray
        if core is not None:
            core_xyz = core.xyz()
            inner_nodes = np.unique(core.inner_tris.ravel())
            base_tag = int(gmsh.model.mesh.getMaxNodeTag()) + 1
            row2tag = np.zeros(len(core.keys), dtype=np.int64)
            row2tag[inner_nodes] = base_tag + np.arange(len(inner_nodes), dtype=np.int64)
            ds = gmsh.model.addDiscreteEntity(2)
            gmsh.model.mesh.addNodes(
                2, ds, row2tag[inner_nodes].tolist(),
                core_xyz[inner_nodes].ravel().tolist(),
            )
            e0 = int(gmsh.model.mesh.getMaxElementTag()) + 1
            flat = row2tag[core.inner_tris].ravel()
            gmsh.model.mesh.addElementsByType(
                ds, TRI, list(range(e0, e0 + len(core.inner_tris))), flat.tolist()
            )
            gmsh.model.occ.remove(list(vols))
            gmsh.model.occ.synchronize()
            outer_loop = gmsh.model.geo.addSurfaceLoop(surfs)
            inner_loop = gmsh.model.geo.addSurfaceLoop([ds])
            vol = gmsh.model.geo.addVolume([outer_loop, inner_loop])
            gmsh.model.geo.synchronize()
            gmsh.model.addPhysicalGroup(3, [vol], 100, "fluid")
            t3 = time.monotonic()
            _log("tets: filling the shell between the surface and the hex core")
            gmsh.model.mesh.generate(3)
            tet_tags = _collect_tets(gmsh, vol)
            _log(f"tet shell: {len(tet_tags)} tets ({time.monotonic()-t3:.1f}s)")
            g_tags, g_xyz, _ = gmsh.model.mesh.getNodes()
            g_tags = np.asarray(g_tags, dtype=np.int64)
            g_xyz = np.asarray(g_xyz, dtype=float).reshape(-1, 3)
            # gmsh renumbers nodes during the 3D pass — recover inner-surface
            # tags by exact half-lattice key.
            ds_tags, ds_xyz, _ = gmsh.model.mesh.getNodes(2, ds, includeBoundary=True)
            ds_tags = np.asarray(ds_tags, dtype=np.int64)
            ds_keys = np.rint(
                (np.asarray(ds_xyz).reshape(-1, 3) - core.origin) / (core.hc / 2.0)
            ).astype(np.int64)
            key2gtag = {tuple(k): int(t) for k, t in zip(ds_keys.tolist(), ds_tags.tolist())}
            gmax = int(g_tags.max())
            row_tag = np.zeros(len(core.keys), dtype=np.int64)
            extra_rows = []
            nxt = gmax + 1
            for r, k in enumerate(map(tuple, core.keys.tolist())):
                g = key2gtag.get(k)
                if g is None:
                    row_tag[r] = nxt
                    nxt += 1
                    extra_rows.append(r)
                else:
                    row_tag[r] = g
            missing_inner = sum(1 for r in inner_nodes if int(row_tag[r]) > gmax)
            if missing_inner:
                raise RuntimeError(f"hexcore: {missing_inner} inner nodes lost in gmsh")
            all_tags = np.concatenate([g_tags, gmax + 1 + np.arange(len(extra_rows))])
            all_xyz = np.vstack([g_xyz, core_xyz[extra_rows]]) if extra_rows else g_xyz
            order = np.argsort(all_tags)
            all_tags = all_tags[order]
            all_xyz = all_xyz[order]
            remap = np.full(int(all_tags.max()) + 1, -1, dtype=np.int64)
            remap[all_tags] = np.arange(len(all_tags))
            tets = remap[tet_tags]
            hexes = remap[row_tag[core.hexes]]
            pyrs = remap[row_tag[core.pyrs]]
            # surface tris were collected before the 3D pass by node *tag*; the
            # 2D nodes keep their tags through generate(3) only if we re-read
            # them, so re-collect from gmsh now.
            _, tris_tags, tri_phys = _collect_surface(gmsh, surfs, tag_to_phys, as_tags=True)
            tris = remap[tris_tags]
            final_nodes = all_xyz
        else:
            if len(vols) >= 1:
                gmsh.model.addPhysicalGroup(3, [t for _, t in vols], 100, "fluid")
            t3 = time.monotonic()
            _log("tets: filling the volume")
            gmsh.model.mesh.generate(3)
            tet_tags = np.concatenate([_collect_tets(gmsh, t) for _, t in vols])
            _log(f"tet volume: {len(tet_tags)} tets ({time.monotonic()-t3:.1f}s)")
            g_tags, g_xyz, _ = gmsh.model.mesh.getNodes()
            g_tags = np.asarray(g_tags, dtype=np.int64)
            g_xyz = np.asarray(g_xyz, dtype=float).reshape(-1, 3)
            order = np.argsort(g_tags)
            g_tags = g_tags[order]
            g_xyz = g_xyz[order]
            remap = np.full(int(g_tags.max()) + 1, -1, dtype=np.int64)
            remap[g_tags] = np.arange(len(g_tags))
            tets = remap[tet_tags]
            _, tris_tags, tri_phys = _collect_surface(gmsh, surfs, tag_to_phys, as_tags=True)
            tris = remap[tris_tags]
            hexes = np.zeros((0, 8), dtype=np.int64)
            pyrs = np.zeros((0, 5), dtype=np.int64)
            final_nodes = g_xyz

        if (tets < 0).any() or (tris < 0).any() or (hexes < 0).any() or (pyrs < 0).any():
            raise RuntimeError("node remap failed (unknown node tag)")

        # --- volume conservation check (catches overlap / missing regions)
        vol_err = None
        mesh_vol = _total_volume(final_nodes, tets, hexes, pyrs)
        if cad_vol and cad_vol > 0:
            vol_err = abs(mesh_vol - cad_vol) / cad_vol
            _log(f"volume check: mesh {mesh_vol:.6g} m³ vs CAD {cad_vol:.6g} m³ (rel err {vol_err:.2e})")
            if vol_err > 5e-3:
                raise RuntimeError(
                    f"volume mismatch {vol_err:.3e} — hex core / shell assembly is inconsistent"
                )
    finally:
        gmsh.finalize()

    physical_names = {phys_of_patch[n]: (2, n) for n in patch_names}
    physical_names[100] = (3, "fluid")
    blocks = [
        (TET, tets, 100),
        (HEX, hexes, 100),
        (PYR, pyrs, 100),
        (TRI, tris, tri_phys),
    ]
    _write_msh2(Path(out_msh), final_nodes, blocks=blocks, physical_names=physical_names)
    wall = time.monotonic() - t0
    _log(
        f"msh written: {len(final_nodes)} nodes, {len(tets)} tets, {len(hexes)} hexes, "
        f"{len(pyrs)} pyramids, {len(tris)} boundary tris ({wall:.1f}s)"
    )
    return StandardMeshResult(
        msh_path=Path(out_msh),
        n_nodes=int(len(final_nodes)),
        n_tris=int(len(tris)),
        n_tets=int(len(tets)),
        n_hex=int(len(hexes)),
        n_pyr=int(len(pyrs)),
        hex_core_applied=core is not None,
        hex_core_note=core_note,
        patch_names=patch_names,
        wall_patches=wall_patches,
        volume_error_rel=vol_err,
        wall_s=wall,
        log=lines,
    )


def _collect_surface(gmsh, surfs, tag_to_phys, *, as_tags: bool = False):
    """Return (nodes_xyz or None, tris (rows or tags), tri_phys)."""
    tri_blocks = []
    phys_blocks = []
    for s in surfs:
        etypes, _etags, conn = gmsh.model.mesh.getElements(2, s)
        for et, c in zip(etypes, conn):
            if int(et) == TRI:
                arr = np.asarray(c, dtype=np.int64).reshape(-1, 3)
                tri_blocks.append(arr)
                phys_blocks.append(np.full(len(arr), tag_to_phys[int(s)], dtype=np.int64))
    tris_tags = np.vstack(tri_blocks) if tri_blocks else np.zeros((0, 3), np.int64)
    tri_phys = np.concatenate(phys_blocks) if phys_blocks else np.zeros(0, np.int64)
    if as_tags:
        return None, tris_tags, tri_phys
    tags, xyz, _ = gmsh.model.mesh.getNodes()
    tags = np.asarray(tags, dtype=np.int64)
    xyz = np.asarray(xyz, dtype=float).reshape(-1, 3)
    remap = np.zeros(int(tags.max()) + 1, dtype=np.int64)
    remap[tags] = np.arange(len(tags))
    used = np.unique(tris_tags.ravel())
    sub = np.full(int(tags.max()) + 1, -1, dtype=np.int64)
    sub[used] = np.arange(len(used))
    nodes = xyz[remap[used]]
    return nodes, sub[tris_tags], tri_phys


def _collect_tets(gmsh, vol_tag: int) -> np.ndarray:
    etypes, _etags, conn = gmsh.model.mesh.getElements(3, vol_tag)
    out = []
    for et, c in zip(etypes, conn):
        if int(et) == TET:
            out.append(np.asarray(c, dtype=np.int64).reshape(-1, 4))
        elif len(c):
            raise RuntimeError(f"unexpected 3D element type {int(et)} from gmsh")
    return np.vstack(out) if out else np.zeros((0, 4), np.int64)


def _tet_vol(a, b, c, d) -> np.ndarray:
    return np.einsum("ij,ij->i", np.cross(b - a, c - a), d - a) / 6.0


def _total_volume(P: np.ndarray, tets, hexes, pyrs) -> float:
    v = 0.0
    if len(tets):
        v += float(_tet_vol(P[tets[:, 0]], P[tets[:, 1]], P[tets[:, 2]], P[tets[:, 3]]).sum())
    if len(pyrs):
        a, b, c, d, e = (P[pyrs[:, k]] for k in range(5))
        v += float((_tet_vol(a, b, c, e) + _tet_vol(a, c, d, e)).sum())
    if len(hexes):
        h = [P[hexes[:, k]] for k in range(8)]
        # 5-tet decomposition of a (lattice-aligned) hex
        v += float(
            (
                _tet_vol(h[0], h[1], h[3], h[4])
                + _tet_vol(h[1], h[2], h[3], h[6])
                + _tet_vol(h[1], h[6], h[4], h[5])
                + _tet_vol(h[3], h[4], h[6], h[7])
                + _tet_vol(h[1], h[3], h[4], h[6])
            ).sum()
        )
    return v


# ------------------------------------------------- OpenFOAM case files --------

_FOAM_HEADER = """FoamFile
{{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      {name};
}}
"""


def _layer_patch_block(spec: LayerPatchSpec) -> str:
    specify = str(spec.specify or "total").strip().lower()
    if specify not in ("first", "total", "first_and_total"):
        specify = "total"
    write_exp = specify != "first_and_total"
    write_first = specify in ("first", "first_and_total")
    write_thick = specify in ("total", "first_and_total")
    lines = [
        f"        {spec.name}",
        "        {",
        f"            nSurfaceLayers {int(spec.n_layers)};",
    ]
    if write_exp and spec.expansion is not None and spec.expansion > 0:
        lines.append(f"            expansionRatio {float(spec.expansion):.6g};")
    if write_first and spec.first_layer_m is not None and spec.first_layer_m > 0:
        lines.append(f"            firstLayerThickness {float(spec.first_layer_m):.6g};")
    if write_thick and spec.thickness_m is not None and spec.thickness_m > 0:
        lines.append(f"            thickness {float(spec.thickness_m):.6g};")
    if spec.min_thickness_m is not None and spec.min_thickness_m > 0:
        lines.append(f"            minThickness {float(spec.min_thickness_m):.6g};")
    lines.append("        }")
    return "\n".join(lines)


def write_layers_case(
    case_dir: Path,
    *,
    wall_patches: list[str],
    sizing: StandardSizing,
    add_layers: bool,
    layer_specs: list[LayerPatchSpec] | None = None,
) -> None:
    """Write system/{controlDict,fvSchemes,fvSolution,snappyHexMeshDict} for the
    layers-only snappyHexMesh pass. ``snappyHexMeshDict`` is written when
    ``layer_specs`` has entries, or when Automatic BL is on and there is at
    least one wall patch."""
    case_dir = Path(case_dir)
    system = case_dir / "system"
    system.mkdir(parents=True, exist_ok=True)
    (system / "controlDict").write_text(
        _FOAM_HEADER.format(name="controlDict")
        + """
application     snappyHexMesh;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         1;
deltaT          1;
writeControl    timeStep;
writeInterval   1;
purgeWrite      0;
writeFormat     binary;
writePrecision  10;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;
""",
        encoding="ascii",
        newline="\n",
    )
    (system / "fvSchemes").write_text(
        _FOAM_HEADER.format(name="fvSchemes")
        + """
ddtSchemes      { default steadyState; }
gradSchemes     { default Gauss linear; }
divSchemes      { default none; }
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes   { default corrected; }
""",
        encoding="ascii",
        newline="\n",
    )
    (system / "fvSolution").write_text(
        _FOAM_HEADER.format(name="fvSolution") + "\nsolvers {}\n",
        encoding="ascii",
        newline="\n",
    )
    snappy = system / "snappyHexMeshDict"
    if snappy.exists():
        snappy.unlink()
    specs: list[LayerPatchSpec] = []
    if layer_specs:
        specs = [s for s in layer_specs if s.n_layers > 0 and s.name]
    elif add_layers and wall_patches:
        specs = [LayerPatchSpec(name=n, n_layers=sizing.n_layers) for n in wall_patches]
    if not specs:
        return
    layers = "\n".join(_layer_patch_block(s) for s in specs)
    thick = next((s.thickness_m for s in specs if s.thickness_m), None)
    exp = next((s.expansion for s in specs if s.expansion), None)
    min_t = next((s.min_thickness_m for s in specs if s.min_thickness_m), None)
    global_thick = float(thick) if thick else float(sizing.layer_thickness_m)
    global_exp = float(exp) if exp else float(sizing.layer_expansion)
    global_min = float(min_t) if min_t else float(sizing.layer_min_thickness_m)
    snappy.write_text(
        _FOAM_HEADER.format(name="snappyHexMeshDict")
        + f"""
// Layers-only pass on the gmsh Standard mesh (no castellation / snapping).
castellatedMesh false;
snap            false;
addLayers       true;

geometry
{{
}}

castellatedMeshControls
{{
    maxLocalCells 1000000;
    maxGlobalCells 50000000;
    minRefinementCells 0;
    nCellsBetweenLevels 1;
    features ();
    refinementSurfaces {{}}
    resolveFeatureAngle 30;
    refinementRegions {{}}
    locationInMesh (0 0 0);
    allowFreeStandingZoneFaces true;
}}

snapControls
{{
    nSmoothPatch 3;
    tolerance 2.0;
    nSolveIter 30;
    nRelaxIter 5;
}}

addLayersControls
{{
    // Layers: Automatic BL and/or Inflate boundary layer on named wall patches.
    relativeSizes false;
    layers
    {{
{layers}
    }}
    expansionRatio {global_exp:.6g};
    thickness {global_thick:.6g};
    minThickness {global_min:.6g};
    nGrow 0;
    featureAngle 180;
    slipFeatureAngle 30;
    nRelaxIter 5;
    nSmoothSurfaceNormals 1;
    nSmoothNormals 3;
    nSmoothThickness 10;
    maxFaceThicknessRatio 0.5;
    maxThicknessToMedialRatio 0.3;
    minMedialAxisAngle 90;
    nBufferCellsNoExtrude 0;
    nLayerIter 50;
    nRelaxedIter 20;
}}

meshQualityControls
{{
    maxNonOrtho 70;
    maxBoundarySkewness 20;
    maxInternalSkewness 4;
    maxConcave 80;
    minVol 1e-30;
    minTetQuality 1e-30;
    minArea -1;
    minTwist 0.02;
    minDeterminant 0.001;
    minFaceWeight 0.02;
    minVolRatio 0.01;
    minTriangleTwist -1;
    nSmoothScale 4;
    errorReduction 0.75;
    relaxed
    {{
        maxNonOrtho 75;
    }}
}}

mergeTolerance 1e-6;
""",
        encoding="ascii",
        newline="\n",
    )


def write_patch_types_txt(case_dir: Path, patch_types: dict[str, str]) -> Path:
    out = Path(case_dir) / "constant" / "triSurface" / "patch_types.txt"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        "".join(f"{name} {ptype}\n" for name, ptype in sorted(patch_types.items())),
        encoding="ascii",
        newline="\n",
    )
    return out
