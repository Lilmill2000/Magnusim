"""Host-side Hex-dominant (snappyHexMesh) prep for w21 (Phase 1 Step 6).

Moves Body1 STL scaling + dict writes out of the former JS GENERATE_SH_TEMPLATE
Python-inside-bash heredocs. Bash template only runs OpenFOAM tools.
"""

from __future__ import annotations

import math
import re
import struct
from pathlib import Path
from typing import Any

from cfddesk.mesh.snappy_policy import (
    SNAPPY_GEOMETRY_REV,
    feature_refinement_level,
    snap_controls_for_fineness,
)
from cfddesk.project.mesh_sizing import (
    cells_across,
    clamp_fineness,
    physics_refinement_for_fineness,
)

_PAD = 1.33


def walls_level_for_settings(fineness: int, *, physics_based: bool = True) -> int:
    f = clamp_fineness(fineness)
    if not physics_based or f <= 3:
        return 1
    return int(physics_refinement_for_fineness(f).walls)


def base_cell_size(fineness: int, bounds_m: dict[str, float] | None, *, two_d_axis: int | None = None) -> float | None:
    """Background (level 0) cell size in metres, or None without bounds.

    One cell across (2D, ``two_d_axis`` the depth's axis): the part's section diagonal, its
    box without the depth, over the fineness's cells across (``two_d.inplane_base``)."""
    if not bounds_m or not all(k in bounds_m for k in ("xmin", "xmax", "ymin", "ymax", "zmin", "zmax")):
        return None
    if two_d_axis is not None:
        from cfddesk.mesh.two_d import inplane_base

        return inplane_base(cells_across(clamp_fineness(fineness)), bounds_m, int(two_d_axis))
    dx = abs(float(bounds_m["xmax"]) - float(bounds_m["xmin"]))
    dy = abs(float(bounds_m["ymax"]) - float(bounds_m["ymin"]))
    dz = abs(float(bounds_m["zmax"]) - float(bounds_m["zmin"]))
    diag = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
    return max(1e-5, min(1.0, diag / cells_across(clamp_fineness(fineness))))


# A Surface custom sizing refines this many cells of its size out from its faces, unless its
# Refine out to reaches further (``refine_distance_m``).
DEFAULT_BAND_CELLS = 3


def refine_distance_m(size_m: float, reach_m: float | None = None) -> float:
    """How far from a Surface custom sizing's faces its cells are refined to its level (the
    distance of its refinement region): its Refine out to (validation gap G4), but never less
    than the default band of ``DEFAULT_BAND_CELLS`` cells of its size."""
    band = DEFAULT_BAND_CELLS * float(size_m)
    return max(float(reach_m), band) if reach_m and reach_m > 0 else band


def refinement_level_for_size(base_m: float, size_m: float, *, max_level: int = 8) -> int:
    """Smallest snappy level whose cells (base / 2**level) are no larger than ``size_m``."""
    if not (base_m > 0 and size_m > 0):
        return 0
    return max(0, min(int(max_level), math.ceil(math.log2(base_m / size_m) - 1e-9)))


# A background cell is at most this many times as long as the longer of its other two sides
# (F2): the rule is for needles, cells long against both their other sides. snappyHexMesh splits
# a cell into eight of its own shape, so the cells at the walls keep the background's aspect.
# The block keeps at least 8, 8 and 12 cells across, while its cell along the part comes from
# the part's diagonal: on a long thin part the cells were needles (a 55 D pipe at fineness 6:
# 6.5 times as long as their side across y, 9.7 times their side across z) and snapped into
# cells of negative volume; a 30 D pipe at 3.6 (5.4 across z) passed. A flat part's cells (a
# plate's, wide along two axes and thin along the third) are long against their thin side only:
# they are left as they were, and such a mesh passes checkMesh (a 100 x 100 x 2 mm plate at
# fineness 4: only skewed faces, which the rule accepts).
MAX_BACKGROUND_ASPECT = 3.0
# snappyHexMesh's limit on the whole mesh (castellatedMeshControls maxGlobalCells, as
# write_hexdominant_dicts writes it): it stops refining once the mesh has that many cells.
MAX_GLOBAL_CELLS = 4_000_000


def background_counts(
    extents_m: list[float] | tuple[float, ...],
    pad: float,
    base_m: float,
    minimums: tuple[int, int, int],
    *,
    one_cell_axis: int | None = None,
    aspect_cap: bool = True,
) -> list[int]:
    """The background block's cells along x, y and z: each axis's extent times ``pad`` over the
    base cell, at least its minimum; one cell along ``one_cell_axis`` (One cell across, 2D).

    With ``aspect_cap`` (F2), an axis whose cells come out more than ``MAX_BACKGROUND_ASPECT``
    times as long as the longest cell side of the other axes (a needle: long against both)
    gets more cells, the fewest that bring them within it. Only the longest axis can be such
    an axis; a flat part's wide axes never are. The one-cell axis and an axis of no extent are
    left out of the rule (in 2D the section's long axis is held to its short one). A block
    already within it is the block it was before (the same counts)."""
    counts = [
        1 if k == one_cell_axis else max(int(minimums[k]), round((float(extents_m[k]) * pad) / base_m))
        for k in range(3)
    ]
    sized = [k for k in range(3) if k != one_cell_axis and float(extents_m[k]) > 0.0]
    if not aspect_cap or len(sized) < 2:
        return counts
    side = {k: float(extents_m[k]) * pad / counts[k] for k in sized}
    for k in sized:
        longest = MAX_BACKGROUND_ASPECT * max(side[j] for j in sized if j != k)
        span = float(extents_m[k]) * pad
        if side[k] > longest * (1.0 + 1e-9):
            counts[k] = math.ceil(span / longest - 1e-9)
    return counts


def _extents(bounds_m: dict[str, float]) -> list[float]:
    return [abs(float(bounds_m[f"{c}max"]) - float(bounds_m[f"{c}min"])) for c in "xyz"]


def background_of(
    fineness: int,
    bounds_m: dict[str, float] | None,
    *,
    two_d: dict[str, Any] | None = None,
    aspect_cap: bool = True,
) -> list[int] | None:
    """The background block's cell counts the mesher writes for a part (None without bounds):
    ``block_from_fineness``'s, or with ``two_d`` (its ``axis`` and ``base_m``, as
    ``write_hexdominant_dicts`` takes it) the 2D background's (``two_d.background``)."""
    if two_d is not None:
        if not bounds_m:
            return None
        return background_counts(
            _extents(bounds_m), _PAD, float(two_d["base_m"]), (8, 8, 8), one_cell_axis=int(two_d["axis"]), aspect_cap=aspect_cap
        )
    base = base_cell_size(clamp_fineness(fineness), bounds_m)
    if base is None or not bounds_m:
        return None
    return background_counts(_extents(bounds_m), _PAD, base, (8, 8, 12), aspect_cap=aspect_cap)


def _block_cells_at(fineness: int, bounds_m: dict[str, float], two_d: dict[str, Any] | None) -> int | None:
    """The background block's cell count at ``fineness`` (in 2D its section base at that fineness)."""
    if two_d is None:
        counts = background_of(fineness, bounds_m)
    else:
        base = base_cell_size(fineness, bounds_m, two_d_axis=int(two_d["axis"]))
        counts = background_of(fineness, bounds_m, two_d={"axis": int(two_d["axis"]), "base_m": base}) if base else None
    return math.prod(counts) if counts else None


def cell_limit_refusal(fineness: int, bounds_m: dict[str, float] | None, *, two_d: dict[str, Any] | None = None) -> str | None:
    """Before the run: why Hex-dominant can't mesh a part, when its background block alone, its
    cells kept within ``MAX_BACKGROUND_ASPECT`` (F2), would have more cells than snappyHexMesh's
    limit (snappyHexMesh could refine none of them); None when it fits.

    A needle gets there (its block lengthened along it), and its sides across are held at their
    minimum counts, so every lower fineness gives the same block: the words then say no fineness
    helps. A lower fineness that fits is named, if there is one; a part the cap did not lengthen
    (only a part over a hundred metres across) is not called long and thin. The Standard mesher has no
    background block, so the words name it."""
    counts = background_of(fineness, bounds_m, two_d=two_d)
    if counts is None or not bounds_m or math.prod(counts) <= MAX_GLOBAL_CELLS:
        return None
    f = clamp_fineness(fineness)
    fits = next((g for g in range(f - 1, 0, -1) if (n := _block_cells_at(g, bounds_m, two_d)) and n <= MAX_GLOBAL_CELLS), None)
    where = "at any fineness" if fits is None else f"at fineness {f}"
    lower = "" if fits is None else f" Fineness {fits} or lower fits."
    needle = counts != background_of(fineness, bounds_m, two_d=two_d, aspect_cap=False)
    why = (
        f"it is so long and thin that its background block alone, with no cell more than "
        f"{MAX_BACKGROUND_ASPECT:g} times as long as wide, would have"
        if needle
        else "its background block alone would have"
    )
    standard = "Try the Standard mesher: it has no background block" + (", but it meshes in 3D." if two_d is not None else ".")
    return (
        f"Hex-dominant can't mesh this part {where}: {why} {math.prod(counts):,} cells, "
        f"over snappyHexMesh's limit of {MAX_GLOBAL_CELLS:,}.{lower} {standard}"
    )


# A long part's background cells along it can be up to 3 times as long as their side across
# (the cap's limit; a part the cap leaves alone can be just under it), and snappyHexMesh can then
# leave a flat end face square to that axis (a pipe's inlet or outlet) off the part's plane.
# Where a level's cells cross the plane, the castellated face lands up to half a cell from it,
# inside the part or outside. The snap's patch smoothing (snapControls nSmoothPatch) then pulls
# a flat face into the part by 1 - 0.955**n of its cell along the axis (n = 5: 0.21), and a
# point is snapped only from within the snap tolerance times its longest edge on the face, the
# longer side across. A face that landed inside ended past that reach and stayed where it was:
# case 2's 30 D pipe at fineness 6, on the 80-cell block the cap gave it, kept its cap's centre
# 1.26 mm inside the pipe, and the slanted ring round it made its inlet 344 mm² for the disc's
# 314 (2026-11-08, snappyHexMesh v2606). The cap is not needed for it: a 20 x 500 mm pipe at
# fineness 6 with physics-based meshing off (block (67 8 12), which the cap leaves alone, the
# walls' level 1) kept its inlet's centre 1.87 mm inside and its ends 334.7 mm² (+6.5 %), and a
# 20 x 300 mm pipe at fineness 4 (42 8 12) points up to 0.63 mm inside and its ends 0.6 % small
# (2026-11-08, tests/wsl/test_mesh_wsl.py W9).
# So along such an axis (``end_plane_axes``) the block keeps its count, but its two ends move
# and its cells there shrink by under one cell over the part (``aligned_span``): each of the
# part's two planes on that axis sits this fraction of the finest cell that can reach it inside
# a background cell (a cell of every level), so the face lands that little outside the part at
# every level and the smoothing's pull leaves it within reach. Below half a cell, so the cell
# that holds the plane keeps its centre in the part; 0.46 of the finest cell (0.23 of the wall
# cell when the features are a level finer than the walls, as at every fineness with
# physics-based meshing) put case 2's and the 55 D pipe's caps on their planes, 314.00 mm² each
# (tests/wsl/test_mesh_wsl.py W8, W6).
ALIGN_GAP = 0.46
# An axis is aligned when a flat face square to it, castellated the most it can be inside the
# part (half a cell) and pulled in by the smoothing, could end past this share of the snap's
# reach: when its cells are longer than ALIGN_REACH_SHARE x tolerance / (0.5 + pull) times the
# longer cell side across, 1.06 at fineness 4 and up (nSmoothPatch 5, tolerance 1) and 1.79 at
# fineness 1 to 3 (3, 1.5). Not the whole reach: the 55 D pipe's rim chamfered (-0.55 %) with
# its face's landing at 93 % of it (ce6aa3eb, W6). A block whose cells are about as long as wide
# (an elbow's, a plate's, a short pipe's, a box round a body) keeps its corners: its
# dictionaries are byte for byte what they were.
ALIGN_REACH_SHARE = 0.75
# What of a flat face's offset the patch smoothing keeps per pass (snapControls nSmoothPatch):
# it pulled case 2's caps in by 0.2056 of a cell in 5 (1 - 0.955**5).
PATCH_SMOOTH_KEEP = 0.955
# An axis of fewer cells is not aligned: ``aligned_span`` needs a cell to spare beyond each end
# without making its cells longer. A block's long axis has more (at least 12 at fineness 1), and
# a shorter axis's cells are never long against both other sides.
MIN_ALIGNED_CELLS = 10


def lengthened_axes(fineness: int, bounds_m: dict[str, float] | None) -> list[int]:
    """The axes (0, 1, 2 for x, y, z) whose background cells the aspect cap made more of: a
    needle's long axis, or none (a block the cap leaves alone; a 2D block is not asked)."""
    capped = background_of(fineness, bounds_m)
    plain = background_of(fineness, bounds_m, aspect_cap=False)
    if capped is None or plain is None:
        return []
    return [k for k in range(3) if capped[k] != plain[k]]


def end_plane_axes(fineness: int, bounds_m: dict[str, float] | None) -> list[int]:
    """The axes (0, 1, 2 for x, y, z) whose block ends ``write_hexdominant_dicts`` moves to just
    outside the part's two planes there (``aligned_span``): each whose background cells are
    longer than ``ALIGN_REACH_SHARE``'s limit times the longer cell side across, and the axis
    the aspect cap lengthened (``lengthened_axes``), if it has ``MIN_ALIGNED_CELLS``. At most
    one: only a block's longest cells can be long against both other sides. A 3D block's (a 2D
    block is not asked); none without bounds."""
    f = clamp_fineness(fineness)
    counts = background_of(f, bounds_m)
    if counts is None or not bounds_m:
        return []
    ext = _extents(bounds_m)
    sized = [k for k in range(3) if ext[k] > 0.0]
    if len(sized) < 2:
        return []
    side = {k: ext[k] * _PAD / counts[k] for k in sized}
    snap = snap_controls_for_fineness(f, has_features=True)
    pull = 1.0 - PATCH_SMOOTH_KEEP ** int(snap.n_smooth_patch)
    limit = ALIGN_REACH_SHARE * float(snap.tolerance) / (0.5 + pull)
    capped = set(lengthened_axes(f, bounds_m))
    return [
        k
        for k in sized
        if counts[k] >= MIN_ALIGNED_CELLS and (k in capped or side[k] > limit * max(side[j] for j in sized if j != k))
    ]


def aligned_span(lo_m: float, hi_m: float, count: int, finest_level: int, pad: float = _PAD) -> tuple[float, float, float]:
    """An aligned axis's (``end_plane_axes``) block ends and its gap (metres) for the part's span ``lo_m`` ..
    ``hi_m``: ``count`` cells as before, a whole number of them over the part and a gap of
    ``ALIGN_GAP`` cells of ``finest_level`` at each end, the rest split either side (one more
    on the high side when they do not halve). Its cells are never longer than the padded
    span's (``pad``) were, so the cap's 3 to 1 still holds, and at most one cell over the part
    shorter."""
    length = float(hi_m) - float(lo_m)
    n = int(count)
    cell = length * float(pad) / n
    gaps = 2.0 * ALIGN_GAP / 2 ** int(finest_level)
    inner = max(1, min(n - 2, math.ceil(length / cell + gaps - 1e-9)))
    h = length / (inner - gaps)
    gap = ALIGN_GAP * h / 2 ** int(finest_level)
    start = float(lo_m) - gap - ((n - inner) // 2) * h
    return start, start + n * h, gap


def block_from_fineness(fineness: int, bounds_m: dict[str, float] | None) -> str:
    f = clamp_fineness(fineness)
    counts = background_of(f, bounds_m)
    if counts is not None:
        return f"({counts[0]} {counts[1]} {counts[2]})"
    if f <= 3:
        return "(10 10 20)"
    if f <= 6:
        return "(18 18 48)"
    if f <= 8:
        return "(24 24 64)"
    return "(32 32 80)"


def fineness_params(
    fineness: int,
    *,
    physics_based: bool = True,
    bounds_m: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Python replacement for w21 finenessParams (uses snappy_policy)."""
    f = clamp_fineness(fineness)
    walls_level = walls_level_for_settings(f, physics_based=physics_based)
    feature_level = feature_refinement_level(walls_level, fineness=f)
    snap = snap_controls_for_fineness(f, has_features=True)
    block = block_from_fineness(f, bounds_m)
    return {
        "block": block,
        "feature_level": int(feature_level),
        "walls_level": int(walls_level),
        "snap": snap.to_dict(),
        "snappy_geometry_rev": int(SNAPPY_GEOMETRY_REV),
        "fineness": f,
    }


def scale_body1_stl(body1_src: Path, body1_dst: Path, *, scale: float = 0.001) -> dict[str, Any]:
    """Scale Body1 STL mm->m into case triSurface; return bounds_m + bytes."""
    body1_src = Path(body1_src)
    body1_dst = Path(body1_dst)
    body1_dst.parent.mkdir(parents=True, exist_ok=True)
    raw = body1_src.read_bytes()
    is_bin = len(raw) >= 84 and not raw[:5].lower().startswith(b"solid")

    def scale_bounds_from_binary(buf: bytes):
        ntri = struct.unpack_from("<I", buf, 80)[0]
        xmin = ymin = zmin = float("inf")
        xmax = ymax = zmax = float("-inf")
        off = 84
        hdr = b"W23 Body1 from project source.step (mm->m)"[:80].ljust(80, b"\0")
        out = bytearray(hdr)
        out += struct.pack("<I", ntri)
        for _ in range(ntri):
            chunk = buf[off : off + 50]
            if len(chunk) < 50:
                break
            vals = list(struct.unpack("<12fH", chunk))
            for j in range(12):
                vals[j] = vals[j] * scale
            out += struct.pack("<12fH", *vals)
            xs = vals[3], vals[6], vals[9]
            ys = vals[4], vals[7], vals[10]
            zs = vals[5], vals[8], vals[11]
            xmin = min(xmin, *xs)
            xmax = max(xmax, *xs)
            ymin = min(ymin, *ys)
            ymax = max(ymax, *ys)
            zmin = min(zmin, *zs)
            zmax = max(zmax, *zs)
            off += 50
        return bytes(out), {
            "xmin": xmin,
            "xmax": xmax,
            "ymin": ymin,
            "ymax": ymax,
            "zmin": zmin,
            "zmax": zmax,
            "ntri": ntri,
            "scale": scale,
        }

    if is_bin:
        scaled, bounds = scale_bounds_from_binary(raw)
    else:
        text = raw.decode("utf-8", errors="ignore")
        out_lines = ["solid Body1_W23"]
        xmin = ymin = zmin = float("inf")
        xmax = ymax = zmax = float("-inf")
        for line in text.splitlines():
            s = line.strip()
            if s.startswith("vertex"):
                parts = s.split()
                x, y, z = float(parts[1]) * scale, float(parts[2]) * scale, float(parts[3]) * scale
                out_lines.append(f"  vertex {x} {y} {z}")
                xmin = min(xmin, x)
                xmax = max(xmax, x)
                ymin = min(ymin, y)
                ymax = max(ymax, y)
                zmin = min(zmin, z)
                zmax = max(zmax, z)
            elif s.startswith("facet normal"):
                parts = s.split()
                nx, ny, nz = float(parts[2]), float(parts[3]), float(parts[4])
                n = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
                out_lines.append(f"facet normal {nx / n} {ny / n} {nz / n}")
            elif s.startswith("outer") or s.startswith("endloop") or s.startswith("endfacet"):
                out_lines.append(s)
        out_lines.append("endsolid Body1_W23")
        scaled = ("\n".join(out_lines) + "\n").encode("ascii")
        bounds = {
            "xmin": xmin,
            "xmax": xmax,
            "ymin": ymin,
            "ymax": ymax,
            "zmin": zmin,
            "zmax": zmax,
            "ntri": None,
            "scale": scale,
        }

    body1_dst.write_bytes(scaled)
    return {"bounds_m": bounds, "body1_bytes": len(scaled), "path": str(body1_dst)}


def write_patch_stls(
    tri_dir: Path,
    points_m,
    tris,
    face_ids,
    face_to_patch: dict[int, str],
    patch_types: dict[str, str],
    *,
    inside=(),
) -> list[dict[str, str]]:
    """One binary STL per boundary patch (metres) in ``tri_dir``; returns the patch list.

    snappyHexMesh names the patch of a single-region surface after the surface,
    so each BC patch comes out under the name the solver writes it with. CAD
    faces with no patch go to ``walls``. Faces ``inside`` the part (two bodies
    share them, ``cad.shared_faces``) are left out: a surface there would cut
    the part in two, and snappy would keep only the side ``locationInMesh`` is on.
    """
    import numpy as np

    tri_dir = Path(tri_dir)
    tri_dir.mkdir(parents=True, exist_ok=True)
    tri = np.asarray(tris, dtype=np.int64)
    fid = np.asarray(face_ids, dtype=np.int64)
    if len(inside):
        keep = ~np.isin(fid, np.asarray(sorted(int(f) for f in inside), dtype=np.int64))
        tri, fid = tri[keep], fid[keep]
    names = np.array([face_to_patch.get(int(f), "walls") for f in fid])
    out: list[dict[str, str]] = []
    for name in sorted(set(names.tolist())):
        fname = f"patch_{name}.stl"
        write_binary_stl(tri_dir / fname, points_m, tri[names == name], f"Magnusim patch {name}")
        ptype = patch_types.get(name, "wall")
        out.append({"name": name, "type": "wall" if ptype == "wall" else "patch", "file": fname})
    return out


def write_binary_stl(path: Path, points_m, tris, header: str) -> None:
    import numpy as np

    pts = np.asarray(points_m, dtype=np.float64)
    sel = np.asarray(tris, dtype=np.int64).reshape(-1, 3)
    c = pts[sel]
    n = np.cross(c[:, 1] - c[:, 0], c[:, 2] - c[:, 0])
    n /= np.maximum(np.linalg.norm(n, axis=1), 1e-300)[:, None]
    rec = np.zeros(len(sel), dtype=np.dtype([("n", "<3f4"), ("v", "<9f4"), ("a", "<u2")]))
    rec["n"] = n
    rec["v"] = c.reshape(-1, 9)
    with Path(path).open("wb") as fh:
        fh.write(header.encode("ascii", "replace")[:80].ljust(80, b"\0"))
        fh.write(struct.pack("<I", len(sel)))
        fh.write(rec.tobytes())


def write_interface_stls(tri_dir: Path, points_m, tris, face_ids, regions, shared: dict[int, int], bodies: dict[int, int]) -> list[dict[str, str]]:
    """Host API 1.8: one binary STL per pair of regions that share faces, of ONE visit of
    each shared face (the lower region's), as ``interface_<a>_<b>.stl``.

    In the mesh it is a surface between two cellZones (``locationsInMesh``): snappy
    keeps the cells on both sides and makes its faces the ``<a>_to_<b>`` faceZone,
    never a patch.
    """
    import numpy as np

    tri_dir = Path(tri_dir)
    tri = np.asarray(tris, dtype=np.int64)
    fid = np.asarray(face_ids, dtype=np.int64)
    pairs: dict[tuple[int, int], list[int]] = {}
    for f in sorted(int(x) for x in regions.interfaces):
        a = regions.region_of_body(bodies.get(f, 1) - 1)
        b = regions.region_of_body(bodies.get(int(shared.get(f, f)), 1) - 1)
        if a < b:
            pairs.setdefault((a, b), []).append(f)
    out: list[dict[str, str]] = []
    for (a, b), fids in sorted(pairs.items()):
        name = f"interface_{regions.names[a]}_{regions.names[b]}"
        fname = f"{name}.stl"
        write_binary_stl(tri_dir / fname, points_m, tri[np.isin(fid, np.asarray(fids, dtype=np.int64))], f"Magnusim {name}")
        out.append({"name": name, "file": fname})
    return out


def write_refine_stls(
    tri_dir: Path, points_m, tris, face_ids, groups: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """One refinement-only STL per Surface custom sizing group.

    ``groups`` rows carry ``face_ids``, ``level`` and ``distance_m`` (and ``reach_m``, the Refine
    out to asked, when there is one); the returned rows add ``name`` / ``file`` for
    ``write_hexdominant_dicts``.
    These surfaces only drive ``refinementRegions``; they make no patch.
    """
    import numpy as np

    tri = np.asarray(tris, dtype=np.int64)
    fid = np.asarray(face_ids, dtype=np.int64)
    out: list[dict[str, Any]] = []
    for i, g in enumerate(groups, start=1):
        want = np.isin(fid, np.asarray(sorted({int(f) for f in g.get("face_ids") or []}), dtype=np.int64))
        if not want.any():
            continue
        name = f"refine_{i}"
        fname = f"{name}.stl"
        write_binary_stl(Path(tri_dir) / fname, points_m, tri[want], f"Magnusim refinement {i}")
        out.append({**g, "name": name, "file": fname})
    return out


def _layers_entry(spec: Any) -> str:
    """One ``layers`` entry. Specs with a typed thickness use absolute sizes on that patch."""
    import dataclasses

    from cfddesk.mesh.standard_hexcore import _layer_patch_block

    sizes = [getattr(spec, k, None) for k in ("thickness_m", "first_layer_m")]
    absolute = any(v is not None and float(v) > 0 for v in sizes)
    if (
        absolute
        and not (spec.min_thickness_m and spec.min_thickness_m > 0)
        and dataclasses.is_dataclass(spec)
        and not isinstance(spec, type)
    ):
        # The explicit thicknessModel needs a minThickness; keep a tenth of the stack.
        spec = dataclasses.replace(spec, min_thickness_m=0.1 * max(float(v or 0) for v in sizes))
    lines = _layer_patch_block(spec).split("\n")
    if absolute:
        lines.insert(3, "            relativeSizes false;")
    return "\n".join(lines)


def _padded_box(bounds: dict[str, float]):
    cx = 0.5 * (bounds["xmin"] + bounds["xmax"])
    cy = 0.5 * (bounds["ymin"] + bounds["ymax"])
    cz = 0.5 * (bounds["zmin"] + bounds["zmax"])
    hx = 0.5 * (bounds["xmax"] - bounds["xmin"]) * _PAD
    hy = 0.5 * (bounds["ymax"] - bounds["ymin"]) * _PAD
    hz = 0.5 * (bounds["zmax"] - bounds["zmin"]) * _PAD
    verts = [
        (cx - hx, cy - hy, cz - hz),
        (cx + hx, cy - hy, cz - hz),
        (cx + hx, cy + hy, cz - hz),
        (cx - hx, cy + hy, cz - hz),
        (cx - hx, cy - hy, cz + hz),
        (cx + hx, cy - hy, cz + hz),
        (cx + hx, cy + hy, cz + hz),
        (cx - hx, cy + hy, cz + hz),
    ]
    loc = (cx, cy, cz - 0.15 * hz)
    return verts, loc


def _foam_header(object_name: str) -> str:
    return (
        "FoamFile\n{\n    version     2.0;\n    format      ascii;\n"
        f"    class       dictionary;\n    object      {object_name};\n}}\n"
    )


def write_hexdominant_dicts(
    case_dir: Path,
    *,
    block: str,
    feature_level: int,
    walls_level: int,
    add_layers: bool,
    snap: dict[str, Any],
    bounds_m: dict[str, float],
    patches: list[dict[str, str]] | None = None,
    location_m: tuple[float, float, float] | None = None,
    layer_specs: list[Any] | None = None,
    refine_regions: list[dict[str, Any]] | None = None,
    locations: list[tuple[tuple[float, float, float], str]] | None = None,
    interfaces: list[dict[str, str]] | None = None,
    two_d: dict[str, Any] | None = None,
    aligned_axes: list[int] | tuple[int, ...] = (),
) -> dict[str, Any]:
    """Write blockMeshDict / snappyHexMeshDict / surfaceFeatureExtractDict on host.

    ``aligned_axes`` (``end_plane_axes``, 3D only): along each, the block's ends move so the
    part's two planes there sit just inside a background cell (``aligned_span``, its finest
    level the finest the dictionaries refine to); the block keeps its counts.

    ``locations`` (host API 1.8, a mesh of several regions): one ``(point, region)``
    per body; written as ``locationsInMesh`` in place of ``locationInMesh``, so each
    region becomes its own cellZone. ``interfaces`` (``write_interface_stls``) are the
    surfaces between regions: refined like walls, no patch.

    With ``patches`` (``write_patch_stls``) each boundary patch is its own
    surface, so the mesh carries the BC patches; without, ``Body1.stl`` is one
    wall. ``location_m`` is a point inside the fluid (``cad.location``); the
    default is near the box centre, which can fall outside a hollow part.

    ``layer_specs`` (``LayerPatchSpec``) replaces the uniform two-layer
    request with per-patch layers (Inflate boundary layer + Automatic BL);
    ``refine_regions`` (``write_refine_stls``) refines cells near Surface
    custom sizing faces to the level that meets the requested size.

    ``two_d`` (one cell across, ``cfddesk.mesh.two_d``: ``axis``, ``lo_m``, ``hi_m``,
    ``base_m``, ``front_patch``, ``back_patch``): the background is the part's depth, one cell
    deep, its ends the patches ``two_d.FRONT`` / ``BACK`` (``two_d.background``, in place of
    ``block``; ``patches`` are then the side faces only, stretched past both ends), the point
    inside the mesh sits off every refinement level's cell faces along the depth, and
    ``extrudeMeshDict`` and ``createPatchDict`` make the 2D mesh from the 3D slab
    (snappy_hexdominant.sh).
    """
    case_dir = Path(case_dir)
    system = case_dir / "system"
    system.mkdir(parents=True, exist_ok=True)
    (case_dir / "constant" / "triSurface").mkdir(parents=True, exist_ok=True)

    verts, loc = _padded_box(bounds_m)
    aligned: dict[str, dict[str, float]] = {}
    if aligned_axes and two_d is None:
        counts = [int(v) for v in block.strip().strip("()").split()]
        finest = max([int(walls_level), int(feature_level), *(int(r["level"]) for r in refine_regions or [])])
        moved_verts = [list(v) for v in verts]
        for k in sorted({int(a) for a in aligned_axes}):
            c = "xyz"[k]
            a, b, gap = aligned_span(float(bounds_m[f"{c}min"]), float(bounds_m[f"{c}max"]), counts[k], finest)
            mid = 0.5 * (float(bounds_m[f"{c}min"]) + float(bounds_m[f"{c}max"]))
            for v in moved_verts:
                v[k] = a if v[k] < mid else b
            aligned[c] = {"from_m": a, "to_m": b, "gap_m": gap, "finest_level": finest}
        verts = [(v[0], v[1], v[2]) for v in moved_verts]
    if location_m is not None:
        loc = tuple(float(v) for v in location_m)
    block_boundary = ""
    feature_line = f"            level {int(feature_level)};"
    if two_d is not None:
        from cfddesk.mesh import two_d as _2d

        axis = int(two_d["axis"])
        lo, hi = float(two_d["lo_m"]), float(two_d["hi_m"])
        verts, block, block_boundary = _2d.background(bounds_m, float(two_d["base_m"]), axis, lo, hi, _PAD)
        moved = list(loc)
        moved[axis] = lo + _2d.LOCATION_DEPTH * (hi - lo)
        loc = (moved[0], moved[1], moved[2])
        # The feature edges run past both ends of the block, so snappy's edge tracking (seeded
        # at their end points) never starts: the cells within two feature-level cells of them
        # are refined to that level instead (distance mode).
        reach = 2.0 * float(two_d["base_m"]) / 2 ** int(feature_level)
        feature_line = f"            levels (({reach:.6g} {int(feature_level)}));"
        (system / "extrudeMeshDict").write_text(_2d.extrude_mesh_dict(hi - lo), encoding="utf-8")
        (system / "createPatchDict").write_text(
            _2d.create_patch_dict(str(two_d["front_patch"]), str(two_d["back_patch"])), encoding="utf-8"
        )
    vert_lines = "\n".join(f"    ({v[0]:.8f} {v[1]:.8f} {v[2]:.8f})" for v in verts)
    bm = (
        _foam_header("blockMeshDict")
        + "convertToMeters 1;\n\n"
        + f"vertices\n(\n{vert_lines}\n);\n\n"
        + "blocks\n(\n"
        + f"    hex (0 1 2 3 4 5 6 7) {block} simpleGrading (1 1 1)\n"
        + f");\n\nedges\n(\n);\n\nboundary\n(\n{block_boundary});\n\nmergePatchPairs\n(\n);\n"
    )
    (system / "blockMeshDict").write_text(bm, encoding="utf-8")

    snap_nsmooth = int(snap.get("n_smooth_patch", 3))
    snap_tol = float(snap.get("tolerance", 2.0))
    snap_nsolve = int(snap.get("n_solve_iter", 100))
    snap_nrelax = int(snap.get("n_relax_iter", 5))
    snap_nfeat = int(snap.get("n_feature_snap_iter", 10))
    surfaces = [(p["name"], p["file"], p["type"]) for p in patches] if patches else [("Body1", "Body1.stl", "wall")]
    if layer_specs is not None:
        specs = [s for s in layer_specs if int(getattr(s, "n_layers", 0) or 0) > 0 and bool(getattr(s, "name", ""))]
        layer_block = "".join(_layers_entry(s) + "\n" for s in specs)
        honor = any(bool(getattr(s, "honor_absolute", False)) for s in specs)
    else:
        specs = []
        layer_block = (
            "".join(
                f"        {name}\n        {{\n            nSurfaceLayers 2;\n        }}\n"
                for name, _f, ptype in surfaces
                if ptype == "wall"
            )
            if add_layers
            else ""
        )
        honor = False
    layers_on = bool(layer_block)
    regions = list(refine_regions or [])
    geometry_lines = []
    refine_lines = []
    for name, fname, ptype in surfaces:
        geometry_lines += [f"    {fname}", "    {", "        type triSurfaceMesh;", f"        name {name};", "    }"]
        refine_lines += [
            f"        {name}",
            "        {",
            f"            level ({int(walls_level)} {int(walls_level)});",
            f"            patchInfo {{ type {ptype}; }}",
            "        }",
        ]
    for itf in interfaces or []:
        geometry_lines += [f"    {itf['file']}", "    {", "        type triSurfaceMesh;", f"        name {itf['name']};", "    }"]
        refine_lines += [
            f"        {itf['name']}",
            "        {",
            f"            level ({int(walls_level)} {int(walls_level)});",
            "        }",
        ]
    region_lines = []
    for r in regions:
        geometry_lines += [f"    {r['file']}", "    {", "        type triSurfaceMesh;", f"        name {r['name']};", "    }"]
        region_lines += [
            f"        {r['name']}",
            "        {",
            "            mode distance;",
            f"            levels (({float(r['distance_m']):.6g} {int(r['level'])}));",
            "        }",
        ]
    region_txt = ["    refinementRegions", "    {", *region_lines, "    }"] if region_lines else ["    refinementRegions {}"]
    snap_txt = "\n".join(
        [
            _foam_header("snappyHexMeshDict").rstrip("\n"),
            "// Hex-dominant Body1 + snappy_policy (host-written)",
            "castellatedMesh true;",
            "snap            true;",
            f"addLayers       {'true' if layers_on else 'false'};",
            "",
            "geometry",
            "{",
            *geometry_lines,
            "}",
            "",
            "castellatedMeshControls",
            "{",
            "    maxLocalCells 2000000;",
            f"    maxGlobalCells {MAX_GLOBAL_CELLS};",
            "    minRefinementCells 0;",
            "    maxLoadUnbalance 0.10;",
            "    nCellsBetweenLevels 2;",
            # One cell across: a background cell is the part's whole depth, its points all on
            # the block's two ends; snappy would take each for a cell snapping squashes and
            # baffle it off (every such cell a region of its own). Its ends are flat already.
            *(["    handleSnapProblems false;"] if two_d is not None else []),
            "",
            "    features",
            "    (",
            "        {",
            '            file "cadFeatures.eMesh";',
            feature_line,
            "        }",
            "    );",
            "",
            "    refinementSurfaces",
            "    {",
            *refine_lines,
            "    }",
            "",
            "    resolveFeatureAngle 20;",
            *region_txt,
            *(
                [
                    "    locationsInMesh",
                    "    (",
                    *(f"        (({p[0]:.8f} {p[1]:.8f} {p[2]:.8f}) {name})" for p, name in locations),
                    "    );",
                    "    allowFreeStandingZoneFaces false;",
                ]
                if locations
                else [
                    f"    locationInMesh ({loc[0]:.8f} {loc[1]:.8f} {loc[2]:.8f});",
                    "    allowFreeStandingZoneFaces true;",
                ]
            ),
            "}",
            "",
            "snapControls",
            "{",
            f"    nSmoothPatch {snap_nsmooth};",
            f"    tolerance {snap_tol};",
            f"    nSolveIter {snap_nsolve};",
            f"    nRelaxIter {snap_nrelax};",
            f"    nFeatureSnapIter {snap_nfeat};",
            "    implicitFeatureSnap false;",
            "    explicitFeatureSnap true;",
            "    multiRegionFeatureSnap false;",
            "}",
            "",
            "addLayersControls",
            "{",
            "    relativeSizes true;",
            "    layers",
            "    {",
            layer_block.rstrip("\n"),
            "    }",
            f"    expansionRatio {1.1 if layers_on else 1.0};",
            "    finalLayerThickness 0.3;",
            f"    minThickness {0.2 if layers_on else 0.1};",
            "    nGrow 0;",
            f"    featureAngle {130 if layers_on else 60};",
            "    slipFeatureAngle 30;",
            f"    nRelaxIter {5 if layers_on else 3};",
            f"    nSmoothSurfaceNormals {3 if layers_on else 1};",
            f"    nSmoothNormals {10 if layers_on else 3};",
            "    nSmoothThickness 10;",
            # A typed Inflate thickness has to get past the default limits,
            # which stop extrusion around one local cell.
            f"    maxFaceThicknessRatio {10.0 if honor else 0.5};",
            f"    maxThicknessToMedialRatio {3.0 if honor else 0.3};",
            "    minMedialAxisAngle 90;",
            "    nBufferCellsNoExtrude 0;",
            f"    nLayerIter {100 if honor else 50};",
            "}",
            "",
            "meshQualityControls",
            "{",
            "    maxNonOrtho 65;",
            "    maxBoundarySkewness 20;",
            "    maxInternalSkewness 4;",
            "    maxConcave 80;",
            "    minVol 1e-13;",
            "    minTetQuality 1e-30;",
            "    minArea -1;",
            "    minTwist 0.02;",
            "    minDeterminant 0.001;",
            "    minFaceWeight 0.05;",
            "    minVolRatio 0.01;",
            "    minTriangleTwist -1;",
            "    nSmoothScale 4;",
            "    errorReduction 0.75;",
            "    relaxed",
            "    {",
            "        maxNonOrtho 75;",
            "    }",
            "}",
            "",
            "debug 0;",
            "mergeTolerance 1e-6;",
            "",
        ]
    )
    (system / "snappyHexMeshDict").write_text(snap_txt, encoding="utf-8")

    sfe = (
        _foam_header("surfaceFeatureExtractDict")
        + "Body1.stl\n{\n    extractionMethod    extractFromSurface;\n"
        + "    includedAngle       150;\n    writeObj            yes;\n}\n"
    )
    (system / "surfaceFeatureExtractDict").write_text(sfe, encoding="utf-8")

    # Minimal controlDict so OF tools start.
    ctrl = (
        _foam_header("controlDict")
        + "application     snappyHexMesh;\nstartFrom       startTime;\n"
        + "startTime       0;\nstopAt          endTime;\nendTime         0;\n"
        + "deltaT          1;\nwriteControl    timeStep;\nwriteInterval   1;\n"
    )
    (system / "controlDict").write_text(ctrl, encoding="utf-8")
    (system / "fvSchemes").write_text(
        _foam_header("fvSchemes")
        + "ddtSchemes { default Euler; }\n"
        + "gradSchemes { default Gauss linear; }\n"
        + "divSchemes { default none; }\n"
        + "laplacianSchemes { default Gauss linear corrected; }\n"
        + "interpolationSchemes { default linear; }\n"
        + "snGradSchemes { default corrected; }\n",
        encoding="utf-8",
    )
    (system / "fvSolution").write_text(
        _foam_header("fvSolution") + "solvers {}\n",
        encoding="utf-8",
    )

    return {
        "locationInMesh": list(loc),
        "block": block,
        "feature_level": int(feature_level),
        "walls_level": int(walls_level),
        "add_layers": bool(add_layers),
        "layers": [
            {"patch": getattr(s, "name", ""), "n_layers": int(getattr(s, "n_layers", 0) or 0)} for s in specs
        ],
        "refinement_regions": [
            {
                "name": r["name"],
                "level": int(r["level"]),
                "distance_m": float(r["distance_m"]),
                **({"reach_m": float(r["reach_m"])} if r.get("reach_m") else {}),
            }
            for r in regions
        ],
        "snap": {
            "n_smooth_patch": snap_nsmooth,
            "tolerance": snap_tol,
            "n_solve_iter": snap_nsolve,
            "n_relax_iter": snap_nrelax,
            "n_feature_snap_iter": snap_nfeat,
        },
        "snappy_geometry_rev": int(SNAPPY_GEOMETRY_REV),
        **({"block_aligned": aligned} if aligned else {}),
        "patches": [{"name": n, "type": t} for n, _f, t in surfaces],
        **({"two_d": {k: v for k, v in two_d.items() if k not in ("labels",)}} if two_d is not None else {}),
        **(
            {
                "locationsInMesh": [{"point": list(p), "region": name} for p, name in locations],
                "interfaces": [i["name"] for i in interfaces or []],
            }
            if locations
            else {}
        ),
    }


def _foam_head(path: Path, size: int = 8192) -> bytes:
    try:
        with open(path, "rb") as fh:
            return fh.read(size)
    except OSError:
        return b""


def _foam_list_start(head: bytes) -> tuple[int, int] | None:
    """(declared length, offset past the opening "(") of a FoamFile list."""
    close = head.find(b"}")
    if close < 0:
        return None
    m = re.compile(rb"(\d+)\s*\(").search(head, close)
    return (int(m.group(1)), m.end()) if m else None


def read_polymesh_counts(case_dir: Path) -> dict[str, Any]:
    """Read n_points/n_cells/n_faces from constant/polyMesh (host).

    OpenFOAM's owner header note carries all three; without it the owner list is
    read in its own format (a text parse of a binary list gave nonsense counts).
    """
    pm = Path(case_dir) / "constant" / "polyMesh"
    owner = pm / "owner"
    head = _foam_head(owner) if owner.is_file() else b""
    note = re.search(rb"nPoints:\s*(\d+)\s+nCells:\s*(\d+)\s+nFaces:\s*(\d+)", head)
    n_points = n_cells = n_faces = None
    source = "polyMesh/points+owner"
    if note:
        n_points, n_cells, n_faces = (int(g) for g in note.groups())
        source = "polyMesh/owner note"
    else:
        pts = _foam_list_start(_foam_head(pm / "points")) if (pm / "points").is_file() else None
        n_points = pts[0] if pts else None
        lst = _foam_list_start(head) if head else None
        if lst:
            n_faces, at = lst
            data = owner.read_bytes()
            vals: list[int] | memoryview
            if re.search(rb"format\s+binary", head):
                width = 8 if re.search(rb"label\s*=\s*64", head) else 4
                raw = memoryview(data)[at : at + n_faces * width]
                usable = len(raw) - len(raw) % width
                vals = raw[:usable].cast("q" if width == 8 else "i")  # little-endian host
            else:
                body = data[at:]
                stop = body.find(b")")
                vals = [int(t) for t in (body[:stop] if stop >= 0 else body).split()]
            n_cells = max(vals) + 1 if len(vals) else None
    return {
        "n_points": n_points,
        "n_cells": n_cells,
        "n_faces": n_faces,
        "source": source,
        "polyMesh": str(pm.resolve()) if pm.is_dir() else str(pm),
    }


def read_feature_marks(log_path: Path, *, distance: bool = False) -> dict[str, Any]:
    """The cells snappyHexMesh marked for its feature edges; with ``distance`` (one cell across,
    whose features refine by distance) those marked by distance to them too."""
    text = Path(log_path).read_text(errors="ignore") if Path(log_path).is_file() else ""
    pattern = r"Marked for refinement due to (?:distance to )?explicit features\s*:\s*(\d+)" if distance else r"Marked for refinement due to explicit features\s*:\s*(\d+)"
    marks = [int(x) for x in re.findall(pattern, text)]
    total = sum(marks) if marks else 0
    return {"marks": marks, "total": total}
