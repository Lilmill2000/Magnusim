"""Extract polyMesh boundary patches in mesh coordinates (metres)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pyvista as pv

from cfddesk.results.loader import find_foam_marker


def load_patch_surface(case_dir: Path | str, patch_name: str = "inlet") -> pv.PolyData:
    """Load a named boundary patch from the OpenFOAM reader (already metres).

    Do **not** seed streamlines from STEP face geometry — CAD is often mm while
    the mesh is metres (~1000× off → empty traces with no error).
    """
    case_dir = Path(case_dir)
    foam = find_foam_marker(case_dir)
    reader = pv.OpenFOAMReader(str(foam))
    try:
        reader.enable_all_patch_arrays()
    except Exception:
        pass
    try:
        reader.skip_zero_time = False
    except Exception:
        pass
    if reader.number_time_points > 0:
        reader.set_active_time_point(reader.number_time_points - 1)
    mb = reader.read()
    patch = _find_named_block(mb, patch_name)
    if patch is None or getattr(patch, "n_cells", 0) == 0:
        raise FileNotFoundError(
            f"polyMesh patch '{patch_name}' not found under {case_dir} "
            f"(available patches are mesh-metre surfaces from constant/polyMesh/boundary)"
        )
    if not isinstance(patch, pv.PolyData):
        patch = patch.extract_surface()
    return patch


def _find_named_block(block: pv.DataSet, name: str) -> pv.DataSet | None:
    target = name.lower()
    if isinstance(block, pv.MultiBlock):
        for key in block.keys():
            if key is not None and str(key).lower() == target:
                return block[key]
        for key in block.keys():
            child = block[key]
            if child is None:
                continue
            found = _find_named_block(child, name)
            if found is not None:
                return found
    return None


def sample_patch_seeds(
    patch: pv.PolyData,
    n_seeds: int,
    *,
    mesh_bounds: tuple[float, ...] | None = None,
) -> pv.PolyData:
    """Uniform-ish seed points on a patch surface, optionally bounds-checked."""
    n_seeds = max(1, int(n_seeds))
    pts = np.asarray(patch.points, dtype=float)
    if pts.shape[0] == 0:
        raise RuntimeError("Patch has no points for seeding")
    if pts.shape[0] <= n_seeds:
        chosen = pts
    else:
        idx = np.linspace(0, pts.shape[0] - 1, n_seeds, dtype=int)
        chosen = pts[idx]
    if mesh_bounds is not None:
        b = mesh_bounds
        inside = (
            (chosen[:, 0] >= b[0])
            & (chosen[:, 0] <= b[1])
            & (chosen[:, 1] >= b[2])
            & (chosen[:, 1] <= b[3])
            & (chosen[:, 2] >= b[4])
            & (chosen[:, 2] <= b[5])
        )
        if not np.any(inside):
            raise RuntimeError(
                "Seed points lie outside the mesh bounds — refusing to trace. "
                "Seeds must be in mesh metres (polyMesh patch), not CAD millimetres."
            )
        chosen = chosen[inside]
    return pv.PolyData(chosen)


def sample_patch_seed_grid(
    patch: pv.PolyData,
    seeds_u: int,
    seeds_v: int,
    *,
    mesh_bounds: tuple[float, ...] | None = None,
) -> pv.PolyData:
    """2D seed grid across a patch (u×v), snapped onto surface points."""
    nu = max(1, int(seeds_u))
    nv = max(1, int(seeds_v))
    pts = np.asarray(patch.points, dtype=float)
    if pts.shape[0] == 0:
        raise RuntimeError("Patch has no points for seeding")
    lo = pts.min(axis=0)
    hi = pts.max(axis=0)
    span = hi - lo
    axes = np.argsort(span)[::-1]
    a0, a1 = int(axes[0]), int(axes[1])
    a2 = int(axes[2]) if len(axes) > 2 else a0
    us = np.linspace(0.05, 0.95, nu)
    vs = np.linspace(0.05, 0.95, nv)
    chosen = []
    for u in us:
        for v in vs:
            p = lo.copy()
            p[a0] = lo[a0] + u * span[a0]
            p[a1] = lo[a1] + v * span[a1]
            p[a2] = 0.5 * (lo[a2] + hi[a2])
            chosen.append(p)
    chosen_arr = np.asarray(chosen, dtype=float)
    snapped = []
    for c in chosen_arr:
        d = np.linalg.norm(pts - c, axis=1)
        snapped.append(pts[int(np.argmin(d))])
    chosen_arr = np.asarray(snapped, dtype=float)
    if mesh_bounds is not None:
        b = mesh_bounds
        inside = (
            (chosen_arr[:, 0] >= b[0])
            & (chosen_arr[:, 0] <= b[1])
            & (chosen_arr[:, 1] >= b[2])
            & (chosen_arr[:, 1] <= b[3])
            & (chosen_arr[:, 2] >= b[4])
            & (chosen_arr[:, 2] <= b[5])
        )
        if not np.any(inside):
            raise RuntimeError(
                "Seed grid lies outside mesh bounds — use polyMesh patch metres."
            )
        chosen_arr = chosen_arr[inside]
    return pv.PolyData(chosen_arr)



def sample_even_on_surface(patch: pv.PolyData, n_seeds: int) -> np.ndarray:
    """Deterministic area-weighted seeds on a (possibly curved) patch surface.

    Uses triangle areas so flat and curved polyMesh patches both distribute evenly.
    """
    n_seeds = max(1, int(n_seeds))
    surf = patch
    try:
        if not isinstance(surf, pv.PolyData):
            surf = surf.extract_surface()
        surf = surf.triangulate()
    except Exception:
        pts = np.asarray(patch.points, dtype=float)
        if pts.shape[0] == 0:
            raise RuntimeError("Patch has no points for seeding")
        if pts.shape[0] <= n_seeds:
            return pts.copy()
        idx = np.linspace(0, pts.shape[0] - 1, n_seeds, dtype=int)
        return pts[idx]

    faces = np.asarray(surf.faces, dtype=np.int64)
    pts = np.asarray(surf.points, dtype=float)
    if pts.shape[0] == 0 or faces.size == 0:
        raise RuntimeError("Patch has no triangles for seeding")

    tris: list[np.ndarray] = []
    areas: list[float] = []
    i = 0
    while i < len(faces):
        n = int(faces[i])
        ids = faces[i + 1 : i + 1 + n]
        i += 1 + n
        if n < 3:
            continue
        # Fan triangulate n-gons.
        for k in range(1, n - 1):
            tri = np.array([ids[0], ids[k], ids[k + 1]], dtype=np.int64)
            p0, p1, p2 = pts[tri[0]], pts[tri[1]], pts[tri[2]]
            a = 0.5 * float(np.linalg.norm(np.cross(p1 - p0, p2 - p0)))
            if a <= 0.0:
                continue
            tris.append(tri)
            areas.append(a)
    if not tris:
        # Fallback: unique points linspace.
        if pts.shape[0] <= n_seeds:
            return pts.copy()
        idx = np.linspace(0, pts.shape[0] - 1, n_seeds, dtype=int)
        return pts[idx]

    area_arr = np.asarray(areas, dtype=float)
    cum = np.cumsum(area_arr)
    total = float(cum[-1])
    if total <= 0.0:
        idx = np.linspace(0, len(tris) - 1, n_seeds, dtype=int)
        return np.asarray([(pts[tris[j][0]] + pts[tris[j][1]] + pts[tris[j][2]]) / 3.0 for j in idx], dtype=float)

    # Even targets in cumulative-area space (deterministic, inclusive endpoints inset).
    if n_seeds == 1:
        targets = np.array([0.5 * total], dtype=float)
    else:
        targets = (np.arange(n_seeds, dtype=float) + 0.5) / n_seeds * total

    out = np.zeros((n_seeds, 3), dtype=float)
    for i_t, t in enumerate(targets):
        j = int(np.searchsorted(cum, t, side="left"))
        j = min(max(j, 0), len(tris) - 1)
        tri = tris[j]
        # Stable barycentric interior point (not centroid-only — spreads within tri).
        # Use hashed offset from seed index for slight within-tri spread while deterministic.
        u = ((i_t * 0.6180339887) % 1.0) * 0.6 + 0.2
        v = ((i_t * 0.3819660113) % 1.0) * 0.6 + 0.2
        if u + v > 1.0:
            u, v = 1.0 - u, 1.0 - v
        w = 1.0 - u - v
        out[i_t] = w * pts[tri[0]] + u * pts[tri[1]] + v * pts[tri[2]]
    return out


def allocate_counts_by_area(areas: list[float], n_total: int) -> list[int]:
    """Largest-remainder allocation of n_total across positive areas."""
    n_total = max(0, int(n_total))
    n = len(areas)
    if n == 0 or n_total == 0:
        return [0] * n
    a = np.asarray(areas, dtype=float)
    a = np.maximum(a, 0.0)
    s = float(a.sum())
    if s <= 0.0:
        base = n_total // n
        counts = [base] * n
        for i in range(n_total - base * n):
            counts[i] += 1
        return counts
    exact = a / s * n_total
    counts = np.floor(exact).astype(int)
    rem = int(n_total - int(counts.sum()))
    frac = exact - counts
    order = np.argsort(-frac)
    for k in range(rem):
        counts[int(order[k % n])] += 1
    return [int(c) for c in counts]


def n_seeds_from_density(total_area: float, density: float) -> int:
    """Raw seed count from density (1/m^2) * area (m^2)."""
    dens = max(float(density), 0.0)
    area = max(float(total_area), 0.0)
    return max(1, int(round(dens * area))) if dens > 0.0 and area > 0.0 else max(1, int(round(dens))) if dens > 0 else 1


def even_distribute_across_patches(
    patches: list[pv.PolyData],
    n_seeds: int,
    *,
    mesh_bounds: tuple[float, ...] | None = None,
) -> pv.PolyData:
    """Spread n_seeds evenly across one or more patch surfaces (area-weighted)."""
    n_seeds = max(1, int(n_seeds))
    usable: list[pv.PolyData] = []
    areas: list[float] = []
    for p in patches:
        if p is None or getattr(p, "n_points", 0) == 0:
            continue
        try:
            a = float(p.area)
        except Exception:
            a = 0.0
        if a <= 0.0:
            # Degenerate: approximate by bbox face.
            b = np.asarray(p.bounds, dtype=float)
            a = max(abs(b[1] - b[0]) * abs(b[3] - b[2]), 1e-12)
        usable.append(p)
        areas.append(a)
    if not usable:
        raise RuntimeError("No usable patches for multi-face seed distribute")
    counts = allocate_counts_by_area(areas, n_seeds)
    # Ensure at least one seed on each selected face when n_seeds >= n_faces.
    if n_seeds >= len(usable):
        for i, c in enumerate(counts):
            if c == 0:
                # Steal from the largest bucket.
                j = int(np.argmax(counts))
                if counts[j] > 1:
                    counts[j] -= 1
                    counts[i] = 1
    chunks: list[np.ndarray] = []
    face_i_chunks: list[np.ndarray] = []
    for face_i, (patch, c) in enumerate(zip(usable, counts)):
        if c <= 0:
            continue
        pts_i = sample_even_on_surface(patch, c)
        chunks.append(pts_i)
        face_i_chunks.append(np.full((pts_i.shape[0],), face_i, dtype=np.int64))
    if not chunks:
        pts_i = sample_even_on_surface(usable[0], 1)
        chunks.append(pts_i)
        face_i_chunks.append(np.zeros((pts_i.shape[0],), dtype=np.int64))
        counts = [1] + [0] * (len(usable) - 1)
    chosen = np.vstack(chunks)
    face_i_arr = np.concatenate(face_i_chunks)
    if mesh_bounds is not None:
        b = mesh_bounds
        inset = 1e-9
        inside = (
            (chosen[:, 0] >= b[0] + inset)
            & (chosen[:, 0] <= b[1] - inset)
            & (chosen[:, 1] >= b[2] + inset)
            & (chosen[:, 1] <= b[3] - inset)
            & (chosen[:, 2] >= b[4] + inset)
            & (chosen[:, 2] <= b[5] - inset)
        )
        if np.any(inside):
            chosen = chosen[inside]
            face_i_arr = face_i_arr[inside]
        # else keep — soft; stream tracer may still catch near-boundary seeds
    poly = pv.PolyData(chosen)
    poly.point_data["seed_face_i"] = face_i_arr
    poly.field_data["per_face_counts"] = np.asarray(counts, dtype=np.int64)
    poly.field_data["n_faces"] = np.asarray([len(usable)], dtype=np.int64)
    poly.field_data["face_areas"] = np.asarray(areas, dtype=float)
    return poly


def assert_points_in_bounds(
    points: np.ndarray,
    mesh_bounds: tuple[float, ...],
    *,
    scale_to_metres: float | None = None,
) -> np.ndarray:
    """If CAD coordinates are ever used, scale then assert inside mesh bounds."""
    pts = np.asarray(points, dtype=float)
    if scale_to_metres is not None:
        pts = pts * float(scale_to_metres)
    b = mesh_bounds
    inside = (
        (pts[:, 0] >= b[0])
        & (pts[:, 0] <= b[1])
        & (pts[:, 1] >= b[2])
        & (pts[:, 1] <= b[3])
        & (pts[:, 2] >= b[4])
        & (pts[:, 2] <= b[5])
    )
    if not np.all(inside):
        raise RuntimeError(
            "Seed points outside mesh bounds after scale_to_metres — "
            "check units (CAD mm vs mesh m)."
        )
    return pts

def list_inlet_outlet_patch_names(case_dir: Path | str) -> list[str]:
    """polyMesh boundary names that look like inlet/outlet (not walls)."""
    from cfddesk.case.writer import parse_boundary_patch_types

    boundary = Path(case_dir) / "constant" / "polyMesh" / "boundary"
    if not boundary.is_file():
        return ["inlet", "outlet"]
    try:
        names = list(parse_boundary_patch_types(boundary).keys())
    except Exception:
        return ["inlet", "outlet"]
    out: list[str] = []
    for n in names:
        key = str(n).lower()
        if "wall" in key or key in ("defaultfaces", "default_faces"):
            continue
        if (
            "inlet" in key
            or "outlet" in key
            or "inflow" in key
            or "outflow" in key
        ):
            out.append(str(n))
    return out or [n for n in names if "wall" not in str(n).lower()]


def load_named_patch_surfaces(
    case_dir: Path | str,
    patch_names: list[str],
) -> dict[str, pv.PolyData]:
    """Load selected polyMesh patches (mesh metres) keyed by name."""
    out: dict[str, pv.PolyData] = {}
    for name in patch_names:
        key = str(name).strip()
        if not key or key in out:
            continue
        try:
            out[key] = load_patch_surface(case_dir, key)
        except Exception:
            continue
    return out

