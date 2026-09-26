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
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from cfddesk.cad.step import LoadedSolid
from cfddesk.mesh.msh22 import HEX, PRISM, PYR, QUAD, TET, TRI
from cfddesk.project.model import Project

# HXT volume fill has no native abort. A 25.4 mm inflate hung here for hours.
VOLUME_FILL_TIMEOUT_S = 480
VOLUME_FILL_EXIT = 75


def generate_volume_or_timeout(gmsh, *, timeout_s: float = VOLUME_FILL_TIMEOUT_S) -> None:
    """Run ``mesh.generate(3)``; exit the process if HXT never returns."""
    done = threading.Event()

    def _watch() -> None:
        if not done.wait(timeout_s):
            sys.stderr.write(
                f"volume fill exceeded {timeout_s:.0f}s — reduce inflate thickness or fineness\n"
            )
            os._exit(VOLUME_FILL_EXIT)

    threading.Thread(target=_watch, daemon=True, name="gmsh-volume-watch").start()
    try:
        gmsh.model.mesh.generate(3)
    finally:
        done.set()

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
# Assembly check: cells vs the volume their own boundary triangles enclose.
# A conforming mesh agrees to round-off; an overlapping or missing hex core /
# shell region is off by whole cells (several percent).
_ASSEMBLY_TOL_REL = 1.0e-3
# Mesh vs CAD volume is chord error, not assembly: only noted in the log. At
# coarse fineness the 0.5·h floor caps curvature refinement, so a 20 mm radius
# at h = 4 mm loses ~0.6%.
_CAD_VOLUME_NOTE_REL = 5.0e-3


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
    ) -> StandardSizing:
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
    honor_absolute: bool = False


@dataclass
class StandardMeshResult:
    msh_path: Path
    n_nodes: int
    n_tris: int
    n_tets: int
    n_hex: int
    n_pyr: int
    n_prism: int = 0
    hex_core_applied: bool = False
    hex_core_note: str = ""
    patch_names: list[str] = field(default_factory=list)
    wall_patches: list[str] = field(default_factory=list)
    volume_error_rel: float | None = None
    assembly_error_rel: float | None = None
    wall_s: float = 0.0
    gmsh_layer_patches: list[str] = field(default_factory=list)
    log: list[str] = field(default_factory=list)

    @property
    def n_cells(self) -> int:
        return self.n_tets + self.n_hex + self.n_pyr + self.n_prism


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
    quad = np.asarray(q, dtype=np.int64)
    a = np.asarray(apex, dtype=np.int64)
    nrm = np.cross(quad[1] - quad[0], quad[2] - quad[0])
    if np.dot(nrm, a - quad[0]) < 0:
        quad = quad[::-1].copy()
    return quad, a


@dataclass
class _HexCore:
    origin: np.ndarray
    hc: float
    keys: np.ndarray  # (N_nodes, 3) half-lattice integer coordinates
    hexes: np.ndarray  # (N_hex, 8) node rows
    pyrs: np.ndarray  # (N_pyr, 5) node rows
    inner_tris: np.ndarray  # (N_tri, 3) node rows — closed inner surface
    n_removed: int
    # Connected core piece of each inner triangle. HXT tells regions apart by the
    # surfaces that bound them, so every piece needs its own surface entity.
    inner_comp: np.ndarray | None = None

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

    from scipy import ndimage

    # Separate core pieces (e.g. a cylinder and a cone joined by a neck too thin
    # for core cells). Face-connected labels; the manifold repair keeps pieces
    # from touching at an edge or a vertex.
    comp_of, n_comp = ndimage.label(core)

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
    pyr_comp_list = []
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
            pyr_comp_list.append(comp_of[idx[:, 0], idx[:, 1], idx[:, 2]])
    pyr_keys = np.concatenate(pyr_keys_list, axis=0) if pyr_keys_list else np.zeros((0, 5, 3), np.int64)
    pyr_comp = np.concatenate(pyr_comp_list) if pyr_comp_list else np.zeros(0, np.int64)

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
    keep_rows = np.sort(first[counts == 1])
    inner = tris[keep_rows]
    inner_comp = np.repeat(pyr_comp, 4)[keep_rows]
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
        f"{n_comp} core piece(s), {time.monotonic()-t0:.1f}s)"
    )
    return _HexCore(
        origin=np.asarray(origin, dtype=float),
        hc=float(h_c),
        keys=ukeys,
        hexes=hexes,
        pyrs=pyrs,
        inner_tris=inner,
        n_removed=n_removed,
        inner_comp=np.asarray(inner_comp, dtype=np.int64),
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
            np.full(m, int(np.asarray(phys).item()), dtype=np.int64)
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


def first_layer_from_total_m(total: float, expansion: float, n: int) -> float:
    n = max(1, int(n))
    t = float(total)
    if t <= 0:
        return 0.0
    r = max(1.0, float(expansion or 1.2))
    if abs(r - 1.0) < 1e-12:
        return t / n
    return t * (r - 1.0) / (r**n - 1.0)


def cumulative_layer_heights(thickness_m: float, expansion: float, n: int, sign: float) -> list[float]:
    """Cumulative layer depths. ``sign`` is +1 along the CAD normal, −1 opposite."""
    n = max(1, int(n))
    first = first_layer_from_total_m(thickness_m, expansion, n)
    r = max(1.0, float(expansion or 1.2))
    acc = 0.0
    raw: list[float] = []
    for k in range(n):
        acc += first * (r**k)
        raw.append(acc)
    if raw and raw[-1] > 0:
        raw = [h * float(thickness_m) / raw[-1] for h in raw]
    s = 1.0 if float(sign) >= 0 else -1.0
    return [s * h for h in raw]


def _param_mid_uv(gmsh, tag: int) -> list[float]:
    b = gmsh.model.getParametrizationBounds(2, int(tag))
    if len(b) == 2:
        a = np.asarray(b[0], dtype=float)
        c = np.asarray(b[1], dtype=float)
        return ((a + c) * 0.5).tolist()
    return [0.5 * (float(b[0]) + float(b[1])), 0.5 * (float(b[2]) + float(b[3]))]


def cad_normal_inward_sign(gmsh, tag: int, solid: LoadedSolid, scale_to_metres: float) -> float:
    """+1 if the CAD normal already points into the solid, −1 if it points out."""
    from cfddesk.mesh.octree_hex import SolidIn

    uv = _param_mid_uv(gmsh, tag)
    pt = np.asarray(gmsh.model.getValue(2, int(tag), uv), dtype=float)
    n = np.asarray(gmsh.model.getNormal(int(tag), uv), dtype=float).reshape(-1)[:3]
    ln = float(np.linalg.norm(n))
    if ln < 1e-18:
        return -1.0
    n = n / ln
    inside = SolidIn(solid, float(scale_to_metres))
    probe = 3.0e-4
    plus = bool(inside.inside(pt + n * probe))
    minus = bool(inside.inside(pt - n * probe))
    if plus and not minus:
        return 1.0
    return -1.0


def _surface_curves(gmsh, tag: int) -> set[int]:
    try:
        _up, down = gmsh.model.getAdjacencies(2, int(tag))
        return {int(c) for c in down}
    except Exception:
        return set()


def _remove_volumes(gmsh, tags: list[int], *, occ: bool) -> None:
    dim_tags = [(3, int(t)) for t in tags]
    if not dim_tags:
        return
    if occ:
        gmsh.model.occ.remove(dim_tags, recursive=False)
        gmsh.model.occ.synchronize()
        return
    _remove_entities(gmsh, dim_tags, recursive=False, occ=False)


def _remove_entities(gmsh, dim_tags, *, recursive: bool, occ: bool) -> None:
    """Remove CAD entities from the OCC kernel, or from the model for discrete geometry."""
    dim_tags = [(int(d), int(t)) for d, t in dim_tags]
    if not dim_tags:
        return
    if occ:
        gmsh.model.occ.remove(dim_tags, recursive=recursive)
        gmsh.model.occ.synchronize()
        return
    # Discrete geometry is exported to the built-in kernel: remove it there too, or
    # the next geo.synchronize() brings it back (a second volume HXT cannot mesh).
    try:
        gmsh.model.geo.remove(dim_tags, recursive=recursive)
        gmsh.model.geo.synchronize()
    except Exception:
        pass
    present = {(int(d), int(t)) for d, t in gmsh.model.getEntities()}
    left = [dt for dt in dim_tags if dt in present]
    if left:
        gmsh.model.removeEntities(left, recursive=recursive)


def apply_inward_boundary_layers(
    gmsh, patch_tags: dict[str, list[int]], specs: list, solid, scale, log, *, occ: bool = True
) -> tuple[list[str], list[int], dict[int, int], float]:
    """Grow typed Inflate stacks into the solid. Wall faces stay on the CAD.

    Returns (grown patch names, cap surfaces, {boundary prism side surface:
    CAD face it lies on}, max stack thickness).

    ``geo.extrudeBoundaryLayer`` follows the CAD normal. On a hole that normal
    points into the opening, so positive heights move the wall. Probe the
    solid and extrude the other way. Then cut a tet cavity against the cap so
    tets do not fill the stack.
    """
    honor = [s for s in (specs or []) if getattr(s, "honor_absolute", False)]
    empty: tuple[list[str], list[int], dict[int, int], float] = ([], [], {}, 0.0)
    if not honor:
        return empty
    try:
        gmsh.model.mesh.createGeometry()
    except Exception as exc:
        log(f"createGeometry for layers: {str(exc)[:160]}")
    orig_surfs = [int(t) for _d, t in gmsh.model.getEntities(2)]
    orig_vols = [int(t) for _d, t in gmsh.model.getEntities(3)]
    applied: list[str] = []
    source_tags: list[int] = []
    cap_tags: list[int] = []
    side_tags: list[int] = []
    layer_vols: list[int] = []
    max_thickness = 0.0
    try:
        for spec in honor:
            tags = [int(t) for t in (patch_tags.get(spec.name) or [])]
            if not tags or int(spec.n_layers) < 1 or not spec.thickness_m or spec.thickness_m <= 0:
                continue
            source_curves = set()
            for t in tags:
                source_curves |= _surface_curves(gmsh, t)
            signs = [cad_normal_inward_sign(gmsh, t, solid, scale) for t in tags]
            sign = -1.0 if sum(1 for s in signs if s < 0) >= len(signs) / 2 else 1.0
            heights = cumulative_layer_heights(
                spec.thickness_m, spec.expansion or 1.2, spec.n_layers, sign
            )
            extruded = gmsh.model.geo.extrudeBoundaryLayer(
                [(2, t) for t in tags],
                numElements=[1] * int(spec.n_layers),
                heights=heights,
                recombine=True,
            )
            gmsh.model.geo.synchronize()
            applied.append(spec.name)
            source_tags.extend(tags)
            max_thickness = max(max_thickness, float(spec.thickness_m))
            for dim, tag in extruded:
                tag = int(tag)
                if int(dim) == 3:
                    layer_vols.append(tag)
                    continue
                if int(dim) != 2:
                    continue
                crv = _surface_curves(gmsh, tag)
                if crv & source_curves:
                    side_tags.append(tag)
                else:
                    cap_tags.append(tag)
            log(
                f"boundary layers: {spec.name} {int(spec.n_layers)} layers, "
                f"{float(spec.thickness_m):.4g} m into the solid "
                f"(extrude sign {sign:+.0f})"
            )
        if not applied or not cap_tags:
            if layer_vols:
                _remove_volumes(gmsh, layer_vols, occ=False)
            return empty
        cap_tags = sorted(set(cap_tags))
        side_tags = sorted(set(side_tags))
        source_set = set(source_tags)
        source_curves = set()
        for t in source_set:
            source_curves |= _surface_curves(gmsh, t)
        adjacent = [
            s for s in orig_surfs
            if s not in source_set and (_surface_curves(gmsh, s) & source_curves)
        ]
        cap_curves: set[int] = set()
        for cap in cap_tags:
            cap_curves |= _surface_curves(gmsh, cap)
        # A prism side extruded from the rim of a non-inflated CAD face lies on
        # that face: domain boundary, same patch. One extruded from a curve
        # between two inflated faces (a CAD seam) is inside the stack.
        side_faces: dict[int, int] = {}
        for side in side_tags:
            side_src = _surface_curves(gmsh, side) & source_curves
            face = next(
                (f for f in adjacent if _surface_curves(gmsh, f) & side_src), None
            )
            if face is not None:
                side_faces[int(side)] = int(face)
        n_inner = len(side_tags) - len(side_faces)
        if n_inner:
            log(f"boundary layers: {n_inner} prism side surface(s) inside the stack, not boundary")
        # Extruded geo curves have no OCC eval. Pair each cap rim with the
        # CAD face that already shares a curve with that prism side.
        for side in side_tags:
            side_crv = _surface_curves(gmsh, side)
            rims = side_crv & cap_curves
            if not rims:
                continue
            for face in adjacent:
                if not (_surface_curves(gmsh, face) & side_crv):
                    continue
                for curve in rims:
                    try:
                        gmsh.model.mesh.embed(1, [int(curve)], 2, int(face))
                        log(f"embed cap curve {int(curve)} in face {int(face)}")
                    except Exception:
                        pass
        loop = [s for s in orig_surfs if s not in source_set] + cap_tags
        sl = gmsh.model.geo.addSurfaceLoop(loop)
        gmsh.model.geo.addVolume([sl])
        gmsh.model.geo.synchronize()
        _remove_volumes(gmsh, orig_vols, occ=occ)
    except Exception as exc:
        log(f"inward boundary layers rolled back: {str(exc)[:200]}")
        _remove_volumes(gmsh, layer_vols, occ=False)
        return empty
    return applied, cap_tags, side_faces, max_thickness


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
    layer_specs: list | None = None,
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
    from cfddesk.mesh.gmsh_standard import (
        import_grouped_triangles,
        initialize_gmsh,
        surface_tags_of,
        write_gmsh_brep,
    )

    # A closed mesh import (STL/OBJ/PLY) is meshed from its surfaces of triangles as
    # discrete gmsh geometry; OCC CAD would be one plane per triangle.
    discrete = solid.mesh_triangles is not None
    occ = not discrete
    if discrete:
        gmsh_geometry = None
        _log(f"gmsh geometry: {solid.n_faces} surface(s) of {len(solid.mesh_triangles[1])} triangles from {Path(step_path).name}")
    else:
        # gmsh reads the loaded solid as BREP (unscaled; OCCScaling below applies), not
        # source.step: same surfaces, and seconds instead of minutes for faceted STLs.
        gmsh_geometry = write_gmsh_brep(solid.shape, Path(out_msh).with_name("geometry_mm.brep"))
        _log(f"gmsh geometry {gmsh_geometry.name} from {Path(step_path).name}")
    initialize_gmsh(gmsh)
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("General.NumThreads", int(n_threads))
        gmsh.option.setNumber("Mesh.MaxNumThreads2D", int(n_threads))
        gmsh.option.setNumber("Mesh.MaxNumThreads3D", int(n_threads))
        gmsh.option.setNumber("Geometry.OCCScaling", float(scale_to_metres))

        def _import(heal_tol: float):
            gmsh.model.add("standard")
            gmsh.model.occ.importShapes(str(gmsh_geometry))
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
        if discrete:
            t_imp = time.monotonic()
            face_to_tag, patch_tags, vols, _tol = import_grouped_triangles(
                gmsh, solid, project, scale=float(scale_to_metres), lc=h, log=_log
            )
            n_pieces = len(gmsh.model.getEntities(2))
            _log(f"discrete surfaces: {n_pieces} parametrized piece(s) ({time.monotonic() - t_imp:.1f}s)")
            pts_m = np.asarray(solid.mesh_triangles[0], dtype=float)[np.asarray(solid.mesh_triangles[1])] * float(scale_to_metres)
            cad_vol = abs(float(np.einsum("ij,ij->i", pts_m[:, 0], np.cross(pts_m[:, 1], pts_m[:, 2])).sum()) / 6.0)
        else:
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
        # Discrete surfaces (mesh imports) are sized by h only. gmsh cannot evaluate
        # their curvature: it spends minutes on failed lookups and seeds tiny
        # triangles that make the volume fill 30x slower. A facet-fold size field
        # (PostView, or a size callback) was tried too: minutes per surface mesh.
        # The facets already carry the curvature at the file's own resolution.
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0 if discrete else _CURVATURE_NODES_PER_2PI)
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
                tags = surface_tags_of(face_to_tag, fid)
                if not tags:
                    skipped += 1
                    continue
                groups.setdefault(round(float(sz), 9), []).extend(tags)
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

        # Sliver edges on a faceted STL collapse onto the closed surface.
        # healShapes would remove the same edges but leaves the shell open,
        # so HXT cannot fill it. Do this before gap refinement: those "gaps"
        # are the slivers.
        stitch_tol = min(3.0e-4, 0.05 * h)
        nodes, tris, tri_phys, n_short = _collapse_short_edges(
            nodes, tris, tri_phys, stitch_tol
        )
        if n_short:
            _log(
                f"collapsed {n_short} surface edge(s) shorter than {stitch_tol:.3g} m"
            )

        # --- gap refinement (SimScale gap refinement factor)
        gap = None if n_short else _gap_sizes(
            nodes, tris, h=h, gap_factor=sizing.gap_refinement_factor, log=_log
        )
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
        prisms = np.zeros((0, 6), dtype=np.int64)
        footprint = None
        grown: list[str] = []
        side_tags: list[int] = []
        layer_thickness = 0.0
        if core is None and layer_specs:
            grown, _caps, side_faces, layer_thickness = apply_inward_boundary_layers(
                gmsh, patch_tags, layer_specs, solid, float(scale_to_metres), _log, occ=occ
            )
            vols = gmsh.model.getEntities(3)
            # The stack's end faces take the patch of the CAD face they lie on.
            for s, face in side_faces.items():
                if int(s) not in tag_to_phys and int(face) in tag_to_phys:
                    tag_to_phys[int(s)] = tag_to_phys[int(face)]
                    side_tags.append(int(s))
        if core is not None:
            core_xyz = core.xyz()
            inner_nodes = np.unique(core.inner_tris.ravel())
            ds_outer = None
            phys_of_outer: dict[tuple[int, int, int], int] | None = None
            if n_short:
                # The OCC surface still carries the sliver triangulation, which
                # is what makes the tet shell skew. Mesh the collapsed shell
                # as its own discrete boundary instead.
                _remove_entities(gmsh, list(vols), recursive=True, occ=occ)
                leftover = gmsh.model.getEntities(2)
                if leftover:
                    _remove_entities(gmsh, leftover, recursive=True, occ=occ)
                vols = []
                ds_outer = gmsh.model.addDiscreteEntity(2)
                outer_tags = np.arange(1, len(nodes) + 1, dtype=np.int64)
                gmsh.model.mesh.addNodes(
                    2, ds_outer, outer_tags.tolist(),
                    np.asarray(nodes, dtype=float).ravel().tolist(),
                )
                phys_of_outer = {
                    tuple(sorted(int(outer_tags[i]) for i in tri)): int(p)
                    for tri, p in zip(tris, tri_phys, strict=False)
                }
                gmsh.model.mesh.addElementsByType(
                    ds_outer, TRI,
                    list(range(1, len(tris) + 1)),
                    outer_tags[np.asarray(tris, dtype=np.int64)].ravel().tolist(),
                )
            base_tag = int(gmsh.model.mesh.getMaxNodeTag()) + 1
            row2tag = np.zeros(len(core.keys), dtype=np.int64)
            row2tag[inner_nodes] = base_tag + np.arange(len(inner_nodes), dtype=np.int64)
            # One discrete surface (and inner surface loop) per core piece: HXT
            # identifies regions by their bounding surfaces, and two pieces on
            # one surface read as duplicate volumes ("HXT 3D mesh failed").
            comps = core.inner_comp
            if comps is None or len(comps) != len(core.inner_tris):
                comps = np.zeros(len(core.inner_tris), dtype=np.int64)
            pieces = [core.inner_tris[comps == c] for c in np.unique(comps)]
            seen: set[int] = set()
            for piece in pieces:
                rows = set(np.unique(piece).tolist())
                if seen & rows:  # pieces sharing a node cannot be split
                    pieces = [core.inner_tris]
                    break
                seen |= rows
            ds_list: list[int] = []
            e0 = int(gmsh.model.mesh.getMaxElementTag()) + 1
            for piece in pieces:
                piece_nodes = np.unique(piece.ravel())
                ds_piece = gmsh.model.addDiscreteEntity(2)
                gmsh.model.mesh.addNodes(
                    2, ds_piece, row2tag[piece_nodes].tolist(),
                    core_xyz[piece_nodes].ravel().tolist(),
                )
                gmsh.model.mesh.addElementsByType(
                    ds_piece, TRI, list(range(e0, e0 + len(piece))), row2tag[piece].ravel().tolist()
                )
                e0 += len(piece)
                ds_list.append(ds_piece)
            if len(ds_list) > 1:
                _log(f"hexcore: {len(ds_list)} core pieces, one inner surface each")
            if vols:
                _remove_entities(gmsh, list(vols), recursive=False, occ=occ)
            outer_loop = gmsh.model.geo.addSurfaceLoop(
                [ds_outer] if ds_outer is not None else surfs
            )
            inner_loops = [gmsh.model.geo.addSurfaceLoop([d]) for d in ds_list]
            vol = gmsh.model.geo.addVolume([outer_loop, *inner_loops])
            gmsh.model.geo.synchronize()
            gmsh.model.addPhysicalGroup(3, [vol], 100, "fluid")
            t3 = time.monotonic()
            _log(f"tets: filling the shell between the surface and the hex core (timeout {VOLUME_FILL_TIMEOUT_S:.0f}s)")
            generate_volume_or_timeout(gmsh)
            tet_tags = _collect_tets(gmsh, vol)
            _log(f"tet shell: {len(tet_tags)} tets ({time.monotonic()-t3:.1f}s)")
            g_tags, g_xyz, _ = gmsh.model.mesh.getNodes()
            g_tags = np.asarray(g_tags, dtype=np.int64)
            g_xyz = np.asarray(g_xyz, dtype=float).reshape(-1, 3)
            # gmsh renumbers nodes during the 3D pass — recover inner-surface
            # tags by exact half-lattice key.
            tag_parts, xyz_parts = [], []
            for d in ds_list:
                t_d, x_d, _ = gmsh.model.mesh.getNodes(2, d, includeBoundary=True)
                tag_parts.append(np.asarray(t_d, dtype=np.int64))
                xyz_parts.append(np.asarray(x_d, dtype=float).reshape(-1, 3))
            ds_tags = np.concatenate(tag_parts) if tag_parts else np.zeros(0, dtype=np.int64)
            ds_xyz = np.vstack(xyz_parts) if xyz_parts else np.zeros((0, 3))
            ds_keys = np.rint((ds_xyz - core.origin) / (core.hc / 2.0)).astype(np.int64)
            key2gtag = {tuple(k): int(t) for k, t in zip(ds_keys.tolist(), ds_tags.tolist(), strict=False)}
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
            if ds_outer is not None and phys_of_outer is not None:
                walls_id = int(phys_of_patch.get("walls", 0))
                tris_tags, tri_phys, n_lost = _discrete_boundary(
                    gmsh, ds_outer, phys_of_outer, walls_id
                )
                if n_lost:
                    _log(f"boundary: {n_lost} triangle(s) reassigned to walls")
            else:
                _, tris_tags, tri_phys = _collect_surface(gmsh, surfs, tag_to_phys, as_tags=True)
            tris = remap[tris_tags]
            final_nodes = all_xyz
        else:
            if len(vols) >= 1:
                gmsh.model.addPhysicalGroup(3, [t for _, t in vols], 100, "fluid")
            t3 = time.monotonic()
            _log(f"tets: filling the volume (timeout {VOLUME_FILL_TIMEOUT_S:.0f}s)")
            generate_volume_or_timeout(gmsh)
            tet_blocks = [_collect_tets(gmsh, t) for _, t in vols]
            tet_tags = (
                np.concatenate(tet_blocks)
                if tet_blocks
                else np.zeros((0, 4), dtype=np.int64)
            )
            pri_blocks = [_collect_by_type(gmsh, t, PRISM, 6) for _, t in vols]
            prism_tags = (
                np.concatenate(pri_blocks)
                if pri_blocks
                else np.zeros((0, 6), dtype=np.int64)
            )
            _log(
                f"tet volume: {len(tet_tags)} tets, {len(prism_tags)} prisms "
                f"({time.monotonic()-t3:.1f}s)"
            )
            g_tags, g_xyz, _ = gmsh.model.mesh.getNodes()
            g_tags = np.asarray(g_tags, dtype=np.int64)
            g_xyz = np.asarray(g_xyz, dtype=float).reshape(-1, 3)
            order = np.argsort(g_tags)
            g_tags = g_tags[order]
            g_xyz = g_xyz[order]
            remap = np.full(int(g_tags.max()) + 1, -1, dtype=np.int64)
            remap[g_tags] = np.arange(len(g_tags))
            tets = remap[tet_tags] if len(tet_tags) else tet_tags
            prisms = remap[prism_tags] if len(prism_tags) else prism_tags
            _, tris_tags, tri_phys = _collect_surface(gmsh, surfs, tag_to_phys, as_tags=True)
            tris = remap[tris_tags]
            if grown and layer_thickness > 0:
                footprint = tris
                tris, tri_phys = _drop_footprint_tris(tris, tri_phys, [tets, prisms])
                _, side_tris, side_phys = _collect_surface(
                    gmsh, side_tags, tag_to_phys, as_tags=True
                )
                if len(side_tris):
                    tris = np.vstack([tris, remap[side_tris]])
                    tri_phys = np.concatenate([tri_phys, side_phys])
            hexes = np.zeros((0, 8), dtype=np.int64)
            pyrs = np.zeros((0, 5), dtype=np.int64)
            final_nodes = g_xyz

        if (
            (tets < 0).any()
            or (tris < 0).any()
            or (hexes < 0).any()
            or (pyrs < 0).any()
            or (prisms < 0).any()
        ):
            raise RuntimeError("node remap failed (unknown node tag)")

        # --- volume conservation check (catches overlap / missing regions)
        asm_err = check_volume_assembly(
            final_nodes, tris, tets, hexes, pyrs, prisms, extra_tris=footprint, log=_log
        )
        vol_err = None
        mesh_vol = _total_volume(final_nodes, tets, hexes, pyrs, prisms)
        if cad_vol and cad_vol > 0:
            vol_err = abs(mesh_vol - cad_vol) / cad_vol
            _log(f"volume check: mesh {mesh_vol:.6g} m³ vs CAD {cad_vol:.6g} m³ (rel err {vol_err:.2e})")
            if vol_err > _CAD_VOLUME_NOTE_REL:
                _log(
                    f"note: mesh volume is {vol_err:.2%} off the CAD — the surface at "
                    f"h={h:.4g} m cuts across curved faces; a higher fineness follows them closer"
                )
    finally:
        gmsh.finalize()

    physical_names = {phys_of_patch[n]: (2, n) for n in patch_names}
    physical_names[100] = (3, "fluid")
    blocks = [
        (TET, tets, 100),
        (HEX, hexes, 100),
        (PRISM, prisms, 100),
        (PYR, pyrs, 100),
        (TRI, tris, tri_phys),
    ]
    _write_msh2(Path(out_msh), final_nodes, blocks=blocks, physical_names=physical_names)
    wall = time.monotonic() - t0
    _log(
        f"msh written: {len(final_nodes)} nodes, {len(tets)} tets, {len(hexes)} hexes, "
        f"{len(prisms)} prisms, {len(pyrs)} pyramids, {len(tris)} boundary tris ({wall:.1f}s)"
    )
    return StandardMeshResult(
        msh_path=Path(out_msh),
        n_nodes=int(len(final_nodes)),
        n_tris=int(len(tris)),
        n_tets=int(len(tets)),
        n_hex=int(len(hexes)),
        n_pyr=int(len(pyrs)),
        n_prism=int(len(prisms)),
        hex_core_applied=core is not None,
        hex_core_note=core_note,
        patch_names=patch_names,
        wall_patches=wall_patches,
        volume_error_rel=vol_err,
        assembly_error_rel=asm_err,
        wall_s=wall,
        gmsh_layer_patches=list(grown),
        log=lines,
    )


def _collapse_short_edges(nodes, tris, tri_phys, tol: float):
    """Merge endpoints of edges shorter than ``tol``. Returns collapsed count.

    Only existing mesh edges are collapsed, so a watertight surface stays
    watertight. Degenerate triangles and coincident pairs are dropped.
    """
    nodes = np.asarray(nodes, dtype=float)
    tris = np.asarray(tris, dtype=np.int64)
    tri_phys = np.asarray(tri_phys, dtype=np.int64)
    n = int(len(nodes))
    if n == 0 or len(tris) == 0 or tol <= 0:
        return nodes, tris, tri_phys, 0
    parent = np.arange(n, dtype=np.int64)

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = int(parent[a])
        return a

    n_collapsed = 0
    for a, b, c in tris:
        for u, v in ((int(a), int(b)), (int(b), int(c)), (int(c), int(a))):
            if float(np.linalg.norm(nodes[u] - nodes[v])) > tol:
                continue
            ru, rv = find(u), find(v)
            if ru != rv:
                parent[rv] = ru
                n_collapsed += 1
    if n_collapsed == 0:
        return nodes, tris, tri_phys, 0
    root = np.fromiter((find(i) for i in range(n)), dtype=np.int64, count=n)
    merged: list[tuple[list[int], int]] = []
    count: dict[tuple[int, int, int], int] = {}
    for tri, phys in zip(tris, tri_phys, strict=False):
        r = [int(root[int(i)]) for i in tri]
        if len(set(r)) < 3:
            continue
        key = tuple(sorted(r))
        count[key] = count.get(key, 0) + 1
        merged.append((r, int(phys)))
    # Two triangles on the same three nodes are a sheet folded onto itself: it
    # encloses nothing, so both go. Keeping one left a fin inside the fluid that
    # no cell uses ("boundary triangle on no cell" on fine meshes).
    kept_tris: list[list[int]] = []
    kept_phys: list[int] = []
    seen: set[tuple[int, int, int]] = set()
    for r, phys in merged:
        key = tuple(sorted(r))
        if count[key] % 2 == 0 or key in seen:
            continue
        seen.add(key)
        kept_tris.append(r)
        kept_phys.append(phys)
    used = sorted({i for t in kept_tris for i in t})
    remap = {old: i for i, old in enumerate(used)}
    new_nodes = nodes[np.asarray(used, dtype=np.int64)]
    new_tris = np.asarray([[remap[i] for i in t] for t in kept_tris], dtype=np.int64)
    new_phys = np.asarray(kept_phys, dtype=np.int64)
    return new_nodes, new_tris, new_phys, n_collapsed


def _discrete_boundary(gmsh, entity: int, phys_of: dict, fallback: int):
    """Triangles of a discrete surface, with patch ids keyed by node tags."""
    etypes, _etags, conn = gmsh.model.mesh.getElements(2, entity)
    blocks = []
    phys_blocks = []
    missing = 0
    for et, c in zip(etypes, conn, strict=False):
        if int(et) != TRI:
            continue
        arr = np.asarray(c, dtype=np.int64).reshape(-1, 3)
        blocks.append(arr)
        pp = np.empty(len(arr), dtype=np.int64)
        for i, tri in enumerate(arr):
            key = tuple(sorted((int(tri[0]), int(tri[1]), int(tri[2]))))
            found = phys_of.get(key)
            if found is None:
                missing += 1
                found = fallback
            pp[i] = found
        phys_blocks.append(pp)
    if not blocks:
        raise RuntimeError("discrete outer surface has no triangles after volume meshing")
    return np.vstack(blocks), np.concatenate(phys_blocks), missing


def _collect_surface(gmsh, surfs, tag_to_phys, *, as_tags: bool = False):
    """Return (nodes_xyz or None, tris (rows or tags), tri_phys)."""
    tri_blocks = []
    phys_blocks = []
    for s in surfs:
        if int(s) not in tag_to_phys:
            continue
        etypes, _etags, conn = gmsh.model.mesh.getElements(2, s)
        for et, c in zip(etypes, conn, strict=False):
            if int(et) == TRI:
                arr = np.asarray(c, dtype=np.int64).reshape(-1, 3)
                tri_blocks.append(arr)
                phys_blocks.append(np.full(len(arr), tag_to_phys[int(s)], dtype=np.int64))
            elif int(et) == QUAD:
                arr = np.asarray(c, dtype=np.int64).reshape(-1, 4)
                t0 = arr[:, [0, 1, 2]]
                t1 = arr[:, [0, 2, 3]]
                tri_blocks.append(t0)  # type: ignore[arg-type]
                tri_blocks.append(t1)  # type: ignore[arg-type]
                phys = int(tag_to_phys[int(s)])
                phys_blocks.append(np.full(len(t0), phys, dtype=np.int64))
                phys_blocks.append(np.full(len(t1), phys, dtype=np.int64))
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


def _drop_footprint_tris(
    tris: np.ndarray, tri_phys: np.ndarray, cells: list[np.ndarray]
) -> tuple[np.ndarray, np.ndarray]:
    """Drop CAD tris on no triangular cell face.

    Those are the footprint where a non-inflated face (inlet, outlet) meets the
    inflate stack: they duplicate the prism side quads, which carry that patch
    instead. Tet faces and prism caps are whole cell triangles and stay.
    """
    tris = np.asarray(tris, dtype=np.int64).reshape(-1, 3)
    if not len(tris):
        return tris, tri_phys
    n = int(max([tris.max()] + [int(c.max()) for c in cells if len(c)])) + 1
    on_b = np.zeros(n, dtype=bool)
    on_b[tris.ravel()] = True
    faces = []
    for arr in cells:
        arr = np.asarray(arr, dtype=np.int64)
        if not len(arr):
            continue
        near = arr[on_b[arr].sum(axis=1) >= 3]
        for f in _CELL_FACES[arr.shape[1]]:
            if len(f) == 3:
                rows = near[:, list(f)]
                faces.append(rows[on_b[rows].all(axis=1)])
    face_rows = np.sort(np.vstack(faces), axis=1) if faces else np.zeros((0, 3), np.int64)
    _u, inv = np.unique(
        np.vstack([face_rows, np.sort(tris, axis=1)]), axis=0, return_inverse=True
    )
    inv = np.asarray(inv).ravel()
    keep = np.isin(inv[len(face_rows):], inv[: len(face_rows)])
    return tris[keep], tri_phys[keep]


def _collect_by_type(gmsh, vol_tag: int, etype: int, npe: int) -> np.ndarray:
    etypes, _etags, conn = gmsh.model.mesh.getElements(3, vol_tag)
    out = []
    for et, c in zip(etypes, conn, strict=False):
        if int(et) == int(etype) and len(c):
            out.append(np.asarray(c, dtype=np.int64).reshape(-1, npe))
    return np.vstack(out) if out else np.zeros((0, npe), np.int64)


def _collect_tets(gmsh, vol_tag: int) -> np.ndarray:
    return _collect_by_type(gmsh, vol_tag, TET, 4)


def _tet_vol(a, b, c, d) -> np.ndarray:
    return np.einsum("ij,ij->i", np.cross(b - a, c - a), d - a) / 6.0


def _cone6(o, a, b, c) -> np.ndarray:
    """6 × signed volume of the cone from ``o`` over triangle ``a b c``."""
    return np.einsum("ij,ij->i", a - o, np.cross(b - o, c - o))


def _prism_volume(P: np.ndarray, prisms) -> float:
    """Exact volume with bilinear side faces, so neighbours and tets agree."""
    if not len(prisms):
        return 0.0
    p = [P[prisms[:, k]] for k in range(6)]
    o = sum(p) / 6.0
    v6 = _cone6(o, p[0], p[2], p[1]) + _cone6(o, p[3], p[4], p[5])
    for i, j, k, m in ((0, 1, 4, 3), (1, 2, 5, 4), (2, 0, 3, 5)):
        a, b, c, d = p[i], p[j], p[k], p[m]
        # a bilinear patch halves the tet between its two diagonal splits
        v6 = v6 + 0.5 * (
            _cone6(o, a, b, c) + _cone6(o, a, c, d)
            + _cone6(o, a, b, d) + _cone6(o, b, c, d)
        )
    return float(np.abs(v6).sum() / 6.0)


def _total_volume(P: np.ndarray, tets, hexes, pyrs, prisms=None) -> float:
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
    if prisms is not None and len(prisms):
        v += _prism_volume(P, prisms)
    return v


def _face_triples(face: tuple[int, ...]) -> list[tuple[int, ...]]:
    if len(face) == 3:
        return [face]
    a, b, c, d = face
    return [(a, b, c), (a, c, d), (a, b, d), (b, c, d)]


_CELL_FACES = {
    4: ((0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)),
    5: ((0, 1, 2, 3), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)),
    6: ((0, 1, 2), (3, 4, 5), (0, 1, 4, 3), (1, 2, 5, 4), (2, 0, 3, 5)),
    8: ((0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)),
}
# (node triple, is a whole triangle face) per cell face, gmsh node order. A
# boundary triangle may be half of a split quad, so any 3 corners of a quad count.
_CELL_FACE_TRIPLES = {
    n: [(t, len(f) == 3) for f in faces for t in _face_triples(f)]
    for n, faces in _CELL_FACES.items()
}


@dataclass(frozen=True)
class BoundaryVolume:
    volume: float
    orphans: int  # boundary triangles on no cell face
    two_sided: int  # boundary triangles with a cell on both sides
    uncovered: int  # extra triangles counted as boundary (gmshToFoam defaultFaces)


def boundary_enclosed_volume(
    P: np.ndarray, tris, cells, *, extra_tris=None
) -> BoundaryVolume:
    """Volume inside the boundary triangles, each turned outward from its cell.

    Orphan and two-sided triangles bound nothing and are left out of the sum.
    ``extra_tris`` are triangles left out of the written boundary (inflate
    footprints). Those on a whole triangle cell face are still boundary faces
    (gmshToFoam puts them in ``defaultFaces``) and count; those on no cell
    face or on a prism side quad duplicate a written face and are skipped.
    """
    P = np.asarray(P, dtype=float)
    tris = np.asarray(tris, dtype=np.int64).reshape(-1, 3)
    extra = np.asarray(
        extra_tris if extra_tris is not None else np.zeros((0, 3)), dtype=np.int64
    ).reshape(-1, 3)
    if not len(tris) and not len(extra):
        return BoundaryVolume(0.0, 0, 0, 0)
    on_b = np.zeros(len(P), dtype=bool)
    on_b[tris.ravel()] = True
    on_b[extra.ravel()] = True
    faces: list[np.ndarray] = []
    centres: list[np.ndarray] = []
    whole: list[np.ndarray] = []
    for arr in cells:
        arr = np.asarray(arr, dtype=np.int64)
        if not arr.size:
            continue
        near = arr[on_b[arr].sum(axis=1) >= 3]
        if not len(near):
            continue
        centre = P[near].mean(axis=1)
        for t, is_tri in _CELL_FACE_TRIPLES[arr.shape[1]]:
            f = near[:, list(t)]
            keep = on_b[f].all(axis=1)
            faces.append(np.sort(f[keep], axis=1))
            centres.append(centre[keep])
            whole.append(np.full(int(keep.sum()), is_tri))
    face_rows = np.vstack(faces) if faces else np.zeros((0, 3), np.int64)
    face_centre = np.vstack(centres) if centres else np.zeros((0, 3))
    face_whole = np.concatenate(whole) if whole else np.zeros(0, dtype=bool)
    nf, nt = len(face_rows), len(tris)
    _u, inv = np.unique(
        np.vstack([face_rows, np.sort(tris, axis=1), np.sort(extra, axis=1)]),
        axis=0,
        return_inverse=True,
    )
    inv = np.asarray(inv).ravel()
    n_ids = int(inv.max()) + 1
    n_cells_on = np.bincount(inv[:nf], minlength=n_ids)
    cell_of = np.full(n_ids, -1, dtype=np.int64)
    cell_of[inv[:nf]] = np.arange(nf)
    tri_ids = inv[nf : nf + nt]
    extra_ids = inv[nf + nt :]
    extra_cell = cell_of[extra_ids]
    take = extra_cell >= 0
    take[take] = face_whole[extra_cell[take]]
    take &= ~np.isin(extra_ids, tri_ids)
    extra_ids, first = np.unique(extra_ids[take], return_index=True)
    extra = extra[np.flatnonzero(take)[first]]
    rows = np.vstack([tris, extra])
    ids = np.concatenate([tri_ids, extra_ids])
    owner = cell_of[ids]
    two_sided = n_cells_on[ids] >= 2
    found = (owner >= 0) & ~two_sided
    a, b, c = (P[rows[found, k]] for k in range(3))
    out = np.einsum(
        "ij,ij->i", np.cross(b - a, c - a), (a + b + c) / 3.0 - face_centre[owner[found]]
    )
    o = P[rows.ravel()].mean(axis=0)
    v6 = np.where(out >= 0.0, 1.0, -1.0) * _cone6(o, a, b, c)
    return BoundaryVolume(
        volume=float(v6.sum() / 6.0),
        orphans=int((owner < 0).sum()),
        two_sided=int(two_sided.sum()),
        uncovered=int(len(extra)),
    )


def check_volume_assembly(
    P: np.ndarray, tris, tets, hexes, pyrs, prisms=None, *, extra_tris=None, log=None
) -> float:
    """Raise unless the cells fill exactly what their boundary triangles enclose.

    Chord error cancels out (both sides share one boundary), so this holds to
    round-off for a sound mesh however coarse its surface. Overlapping or
    missing hex core / shell regions show up as whole cells of difference.
    A boundary triangle on no cell is a hole and raises too; two-sided ones
    (inflate stack seams) are only logged.
    """
    cells = [c for c in (tets, hexes, pyrs, prisms) if c is not None]
    cell_vol = _total_volume(P, tets, hexes, pyrs, prisms)
    bnd = boundary_enclosed_volume(P, tris, cells, extra_tris=extra_tris)
    ref = max(abs(bnd.volume), abs(cell_vol), 1e-30)
    err = abs(cell_vol - bnd.volume) / ref
    if log is not None:
        log(
            f"volume assembly: cells {cell_vol:.6g} m³ vs boundary {bnd.volume:.6g} m³ "
            f"(rel err {err:.2e})"
        )
    notes = []
    if bnd.uncovered:
        notes.append(f"{bnd.uncovered} boundary face(s) in no patch (defaultFaces)")
    if bnd.orphans:
        notes.append(f"{bnd.orphans} boundary triangle(s) on no cell")
    if bnd.two_sided:
        notes.append(f"{bnd.two_sided} boundary triangle(s) with cells on both sides")
    if log is not None:
        for s in notes:
            log(f"volume assembly: {s}")
    if err > _ASSEMBLY_TOL_REL or bnd.orphans:
        raise RuntimeError(
            f"volume mismatch {err:.3e} between the cells and the volume their boundary "
            f"encloses ({cell_vol:.6g} vs {bnd.volume:.6g} m³"
            + "".join(f"; {s}" for s in notes)
            + ") — hex core / shell assembly is inconsistent"
        )
    return err


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

    def _pos(v: float | None) -> bool:
        return v is not None and v > 0

    # Without an explicit thicknessModel snappyHexMesh only reads the per-patch
    # keys of the *global* model, so a patch asking for first layer + growth
    # under a global total + growth silently keeps the global sizes.
    model = {
        "first": ("firstAndExpansion", _pos(spec.first_layer_m) and _pos(spec.expansion)),
        "total": ("overallAndExpansion", _pos(spec.thickness_m) and _pos(spec.expansion)),
        "first_and_total": ("firstAndOverall", _pos(spec.first_layer_m) and _pos(spec.thickness_m)),
    }[specify]
    if model[1] and _pos(spec.min_thickness_m):
        lines.append(f"            thicknessModel {model[0]};")
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


def _honor_absolute_layer_thickness(specs: list[LayerPatchSpec]) -> bool:
    """True when Inflate asked for a typed total (or first+total) stack."""
    return any(bool(spec.honor_absolute) for spec in specs)


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
    honor = _honor_absolute_layer_thickness(specs)
    if honor:
        thick = max((s.thickness_m or 0.0) for s in specs) or thick
    global_thick = float(thick) if thick else float(sizing.layer_thickness_m)
    global_exp = float(exp) if exp else float(sizing.layer_expansion)
    global_min = float(min_t) if min_t else float(sizing.layer_min_thickness_m)
    # Default 0.5 / 0.3 stop extrusion around one local cell (~5 mm here).
    # A typed Inflate total has to be allowed through.
    face_ratio = 10.0 if honor else 0.5
    medial_ratio = 3.0 if honor else 0.3
    n_layer_iter = 100 if honor else 50
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
    // Do not extrude round corners sharper than this. At 180 layers wrapped the
    // 90-degree rim where a wall meets a port and inverted a tet there (118k-facet
    // STL, hex core); 130 keeps them off that corner and thickness stays at 97%.
    featureAngle 130;
    slipFeatureAngle 30;
    nRelaxIter 5;
    nSmoothSurfaceNormals 1;
    nSmoothNormals 3;
    nSmoothThickness 10;
    maxFaceThicknessRatio {face_ratio:.6g};
    maxThicknessToMedialRatio {medial_ratio:.6g};
    minMedialAxisAngle 90;
    nBufferCellsNoExtrude 0;
    nLayerIter {n_layer_iter};
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
