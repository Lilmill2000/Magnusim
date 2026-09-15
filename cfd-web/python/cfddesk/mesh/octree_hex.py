"""Cartesian hex core: flood from locationInMesh, peel back from the CAD surface.

v1 uses a *uniform* Cartesian lattice (the cfMesh bulk / boundary cell). A
2:1 octree would need hanging-node transition elements; those are future work.
The name stays because the flood/peel classification is the same algorithm
with one refinement level.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.gp import gp_Pnt
from OCP.TopAbs import TopAbs_IN
from scipy.spatial import cKDTree

from cfddesk.cad.step import LoadedSolid
from cfddesk.cad.units import shape_bbox


@dataclass(frozen=True)
class HexCore:
    """Axis-aligned cubes that remain after flood + peel."""

    origins: np.ndarray
    sizes: np.ndarray
    nodes: np.ndarray
    hexes: np.ndarray  # (n, 8) 0-based, gmsh/VTK hex order
    n_tested: int
    n_kept: int
    cell_m: float


def hex_nodes(origin: np.ndarray, size: float) -> np.ndarray:
    x0, y0, z0 = (float(origin[0]), float(origin[1]), float(origin[2]))
    s = float(size)
    return np.asarray(
        [
            [x0, y0, z0],
            [x0 + s, y0, z0],
            [x0 + s, y0 + s, z0],
            [x0, y0 + s, z0],
            [x0, y0, z0 + s],
            [x0 + s, y0, z0 + s],
            [x0 + s, y0 + s, z0 + s],
            [x0, y0 + s, z0 + s],
        ],
        dtype=float,
    )


class SolidIn:
    """Cached BRepClass3d queries. ``p`` is metres; classifier is native."""

    def __init__(self, solid: LoadedSolid, scale_to_metres: float) -> None:
        self._scale = float(scale_to_metres)
        if self._scale <= 0:
            raise ValueError(f"invalid scale_to_metres={self._scale}")
        self._clf = BRepClass3d_SolidClassifier(solid.shape)
        self._cache: dict[tuple[int, int, int], bool] = {}

    def inside(self, p: np.ndarray) -> bool:
        key = (
            int(round(float(p[0]) * 1e7)),
            int(round(float(p[1]) * 1e7)),
            int(round(float(p[2]) * 1e7)),
        )
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        self._clf.Perform(
            gp_Pnt(
                float(p[0]) / self._scale,
                float(p[1]) / self._scale,
                float(p[2]) / self._scale,
            ),
            1e-7,
        )
        ok = self._clf.State() == TopAbs_IN
        self._cache[key] = ok
        return ok


# VTK / gmsh hex faces, outward for the standard node order.
HEX_FACES: tuple[tuple[int, int, int, int], ...] = (
    (0, 3, 2, 1),  # z-
    (4, 5, 6, 7),  # z+
    (0, 1, 5, 4),  # y-
    (3, 7, 6, 2),  # y+
    (0, 4, 7, 3),  # x-
    (1, 2, 6, 5),  # x+
)


def build_hex_core(
    solid: LoadedSolid,
    *,
    scale_to_metres: float,
    location_m: tuple[float, float, float],
    max_cell_m: float,
    peel_m: float,
    surface_points_m: np.ndarray,
    min_cell_m: float | None = None,
    min_corner_frac: float = 0.25,
) -> HexCore:
    """Keep uniform cubes that sit fully inside and at least ``peel_m`` off CAD.

    ``max_cell_m`` is the lattice pitch (caller should pass the hex-bulk /
    boundary cell, not the octree root cap). ``min_cell_m`` is accepted for
    API compatibility and ignored in v1.

    ``min_corner_frac`` is the required corner clearance as a fraction of
    ``min(cell, peel)``. Raise it when the classify surface is a prism cap
    so hex faces cannot stab through the PLC.
    """
    del min_cell_m
    cell = max(float(max_cell_m), 1e-6)
    peel = max(float(peel_m), 1e-6)
    corner_need = max(float(min_corner_frac) * min(cell, peel), 1e-6)
    scale = float(scale_to_metres)
    surf = np.asarray(surface_points_m, dtype=float)
    if surf.ndim != 2 or surf.shape[1] != 3 or len(surf) == 0:
        raise RuntimeError("hex core: empty CAD surface")
    tree = cKDTree(surf)
    inside = SolidIn(solid, scale)

    bb = shape_bbox(solid.shape, unit="native")
    xmin = bb.xmin * scale
    ymin = bb.ymin * scale
    zmin = bb.zmin * scale
    xmax = bb.xmax * scale
    ymax = bb.ymax * scale
    zmax = bb.zmax * scale
    # One-cell pad so the lattice covers the solid; peel drops the rim.
    xmin -= cell
    ymin -= cell
    zmin -= cell

    nx = int(np.ceil((xmax - xmin) / cell)) + 1
    ny = int(np.ceil((ymax - ymin) / cell)) + 1
    nz = int(np.ceil((zmax - zmin) / cell)) + 1

    loc = np.asarray(location_m, dtype=float)
    seed = (
        int(np.floor((loc[0] - xmin) / cell)),
        int(np.floor((loc[1] - ymin) / cell)),
        int(np.floor((loc[2] - zmin) / cell)),
    )

    kept: set[tuple[int, int, int]] = set()
    n_tested = 0
    for i in range(nx):
        x = xmin + i * cell
        for j in range(ny):
            y = ymin + j * cell
            for k in range(nz):
                z = zmin + k * cell
                n_tested += 1
                origin = np.asarray([x, y, z], dtype=float)
                corners = hex_nodes(origin, cell)
                if not all(inside.inside(c) for c in corners):
                    continue
                ctr = origin + 0.5 * cell
                d_ctr = float(tree.query(ctr, k=1)[0])
                if d_ctr < peel:
                    continue
                d_c = tree.query(corners, k=1)[0]
                if float(np.min(d_c)) < corner_need:
                    continue
                kept.add((i, j, k))

    if not kept:
        raise RuntimeError("hex core: no cubes survived flood/peel")

    if seed not in kept:
        # Nearest kept cell to locationInMesh.
        best = None
        best_d = float("inf")
        for ijk in kept:
            ctr = np.asarray(
                [
                    xmin + (ijk[0] + 0.5) * cell,
                    ymin + (ijk[1] + 0.5) * cell,
                    zmin + (ijk[2] + 0.5) * cell,
                ]
            )
            d = float(np.linalg.norm(ctr - loc))
            if d < best_d:
                best_d = d
                best = ijk
        seed = best  # type: ignore[assignment]
    if seed is None:
        raise RuntimeError("hex core: no seed cell near locationInMesh")

    neigh = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
    seen: set[tuple[int, int, int]] = {seed}
    q: deque[tuple[int, int, int]] = deque([seed])
    while q:
        i, j, k = q.popleft()
        for di, dj, dk in neigh:
            n = (i + di, j + dj, k + dk)
            if n in kept and n not in seen:
                seen.add(n)
                q.append(n)

    origins = []
    for i, j, k in sorted(seen):
        origins.append(
            np.asarray(
                [xmin + i * cell, ymin + j * cell, zmin + k * cell],
                dtype=float,
            )
        )
    origins_a = np.vstack(origins)
    sizes = np.full(len(origins), cell, dtype=float)

    node_list: list[np.ndarray] = []
    node_map: dict[tuple[int, int, int], int] = {}
    hexes: list[list[int]] = []
    quant = 1e-9

    def nid(p: np.ndarray) -> int:
        key = (
            int(round(float(p[0]) / quant)),
            int(round(float(p[1]) / quant)),
            int(round(float(p[2]) / quant)),
        )
        idx = node_map.get(key)
        if idx is None:
            idx = len(node_list)
            node_map[key] = idx
            node_list.append(np.asarray(p, dtype=float))
        return idx

    for o, s in zip(origins_a, sizes):
        hexes.append([nid(c) for c in hex_nodes(o, float(s))])

    return HexCore(
        origins=origins_a,
        sizes=sizes,
        nodes=np.vstack(node_list),
        hexes=np.asarray(hexes, dtype=np.int64),
        n_tested=n_tested,
        n_kept=len(hexes),
        cell_m=cell,
    )


def hex_boundary_quads(hexes: np.ndarray) -> np.ndarray:
    """Unique quads used by exactly one hex (VTK outward winding)."""
    count: dict[tuple[int, ...], tuple[int, int, int, int]] = {}
    nuse: dict[tuple[int, ...], int] = {}
    for hx in hexes:
        for f in HEX_FACES:
            nodes = tuple(int(hx[i]) for i in f)
            key = tuple(sorted(nodes))
            nuse[key] = nuse.get(key, 0) + 1
            count[key] = nodes
    return np.asarray([count[k] for k, n in nuse.items() if n == 1], dtype=np.int64)


def hex_volume_m3(core: HexCore) -> float:
    return float(np.sum(np.asarray(core.sizes, dtype=float) ** 3))
