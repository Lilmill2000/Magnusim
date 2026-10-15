"""A box mesh of nx x ny x nz hexahedra written as OpenFOAM's constant/polyMesh (ascii or
binary, 32- or 64-bit labels, 32- or 64-bit scalars), with cellZones: the mesh reader's
test meshes (heat_transfer.polymesh), at any size.

Faces are written as OpenFOAM writes a polyhedral mesh (a faceList, each face its own
count of points), owner < neighbour, normals from owner to neighbour and out of the
box; patches ``xmin xmax ymin ymax zmin zmax`` (walls).
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

PATCHES = ("xmin", "xmax", "ymin", "ymax", "zmin", "zmax")


def _header(cls: str, obj: str, *, binary: bool, label: int, scalar: int, note: str = "") -> bytes:
    fmt = "binary" if binary else "ascii"
    arch = f'    arch        "LSB;label={label};scalar={scalar}";\n'
    note_line = f'    note        "{note}";\n' if note else ""
    return (
        "/*--------------------------------*- C++ -*----------------------------------*\\\n"
        "  test mesh\n"
        "\\*---------------------------------------------------------------------------*/\n"
        "FoamFile\n{\n"
        "    version     2.0;\n"
        f"    format      {fmt};\n"
        f"{arch}"
        f"    class       {cls};\n"
        f"{note_line}"
        '    location    "constant/polyMesh";\n'
        f"    object      {obj};\n"
        "}\n\n"
    ).encode("ascii")


def _ints_ascii(a: Any) -> bytes:
    return ("\n".join(map(str, np.asarray(a).tolist())) + "\n").encode("ascii") if len(a) else b""


def _list_bytes(a: Any, *, binary: bool, dtype: Any, width: int = 1) -> bytes:
    a = np.asarray(a)
    n = a.shape[0] if a.ndim else 0
    if binary:
        return f"{n}\n(".encode("ascii") + np.ascontiguousarray(a, dtype=np.dtype(dtype).newbyteorder("<")).tobytes() + b")\n"
    if width == 1:
        return f"{n}\n(\n".encode("ascii") + _ints_ascii(a) + b")\n"
    rows = "".join("(" + " ".join(repr(float(v)) for v in r) + ")\n" for r in a.tolist())
    return f"{n}\n(\n".encode("ascii") + rows.encode("ascii") + b")\n"


def box_mesh(
    poly: Path,
    nx: int,
    ny: int,
    nz: int,
    *,
    size: tuple[float, float, float] = (1.0, 1.0, 1.0),
    zones: dict[str, Callable[[Any, Any, Any], Any]] | None = None,
    binary: bool = False,
    label: int = 32,
    scalar: int = 64,
) -> dict[str, Any]:
    """Write the mesh into ``poly``; ``zones`` {name: mask(i, j, k) of cell indices}, each
    cell in the first zone whose mask holds it (or none). Returns the counts."""
    poly.mkdir(parents=True, exist_ok=True)
    ldt = np.int32 if label == 32 else np.int64
    sdt = np.float32 if scalar == 32 else np.float64

    def pid(i: Any, j: Any, k: Any) -> Any:
        return i + (nx + 1) * (j + (ny + 1) * k)

    def cid(i: Any, j: Any, k: Any) -> Any:
        return i + nx * (j + ny * k)

    faces: list[Any] = []
    owner: list[Any] = []
    neigh: list[Any] = []

    def x_faces(i: Any, j: Any, k: Any) -> Any:
        return np.stack([pid(i, j, k), pid(i, j + 1, k), pid(i, j + 1, k + 1), pid(i, j, k + 1)], axis=-1)

    def y_faces(i: Any, j: Any, k: Any) -> Any:
        return np.stack([pid(i, j, k), pid(i, j, k + 1), pid(i + 1, j, k + 1), pid(i + 1, j, k)], axis=-1)

    def z_faces(i: Any, j: Any, k: Any) -> Any:
        return np.stack([pid(i, j, k), pid(i + 1, j, k), pid(i + 1, j + 1, k), pid(i, j + 1, k)], axis=-1)

    # Internal faces.
    i, j, k = (a.ravel() for a in np.meshgrid(np.arange(1, nx), np.arange(ny), np.arange(nz), indexing="ij"))
    faces.append(x_faces(i, j, k)); owner.append(cid(i - 1, j, k)); neigh.append(cid(i, j, k))  # noqa: E702
    i, j, k = (a.ravel() for a in np.meshgrid(np.arange(nx), np.arange(1, ny), np.arange(nz), indexing="ij"))
    faces.append(y_faces(i, j, k)); owner.append(cid(i, j - 1, k)); neigh.append(cid(i, j, k))  # noqa: E702
    i, j, k = (a.ravel() for a in np.meshgrid(np.arange(nx), np.arange(ny), np.arange(1, nz), indexing="ij"))
    faces.append(z_faces(i, j, k)); owner.append(cid(i, j, k - 1)); neigh.append(cid(i, j, k))  # noqa: E702
    n_internal = sum(len(o) for o in owner)
    patches: list[tuple[str, int, int]] = []
    start = n_internal

    def side(name: str, f: Any, o: Any, flip: bool) -> None:
        nonlocal start
        faces.append(f[:, ::-1] if flip else f)
        owner.append(o)
        patches.append((name, start, len(o)))
        start += len(o)

    j, k = (a.ravel() for a in np.meshgrid(np.arange(ny), np.arange(nz), indexing="ij"))
    side("xmin", x_faces(0, j, k), cid(0, j, k), True)
    side("xmax", x_faces(nx, j, k), cid(nx - 1, j, k), False)
    i, k = (a.ravel() for a in np.meshgrid(np.arange(nx), np.arange(nz), indexing="ij"))
    side("ymin", y_faces(i, 0, k), cid(i, 0, k), True)
    side("ymax", y_faces(i, ny, k), cid(i, ny - 1, k), False)
    i, j = (a.ravel() for a in np.meshgrid(np.arange(nx), np.arange(ny), indexing="ij"))
    side("zmin", z_faces(i, j, 0), cid(i, j, 0), True)
    side("zmax", z_faces(i, j, nz), cid(i, j, nz - 1), False)
    quads = np.concatenate(faces)
    own = np.concatenate(owner)
    nei = np.concatenate(neigh)
    faces.clear()
    owner.clear()
    neigh.clear()
    n_cells = nx * ny * nz
    n_points = (nx + 1) * (ny + 1) * (nz + 1)
    note = f"nPoints:{n_points}  nCells:{n_cells}  nFaces:{len(own)}  nInternalFaces:{n_internal}"
    kw = {"binary": binary, "label": label, "scalar": scalar}

    (poly / "owner").write_bytes(_header("labelList", "owner", note=note, **kw) + _list_bytes(own, binary=binary, dtype=ldt))
    (poly / "neighbour").write_bytes(_header("labelList", "neighbour", note=note, **kw) + _list_bytes(nei, binary=binary, dtype=ldt))
    del own, nei
    pi, pj, pk = (a.ravel() for a in np.meshgrid(np.arange(nx + 1), np.arange(ny + 1), np.arange(nz + 1), indexing="ij"))
    order = np.argsort(pid(pi, pj, pk))
    xyz = np.stack([pi * size[0] / nx, pj * size[1] / ny, pk * size[2] / nz], axis=-1)[order]
    del pi, pj, pk, order
    if binary:
        pts = _list_bytes(xyz, binary=True, dtype=sdt, width=3)
    else:
        rows = "\n".join(f"({x!r} {y!r} {z!r})" for x, y, z in xyz.tolist())
        pts = f"{n_points}\n(\n".encode("ascii") + rows.encode("ascii") + b"\n)\n"
    (poly / "points").write_bytes(_header("vectorField", "points", **kw) + pts)
    del xyz, pts
    if binary:
        offsets = np.arange(0, 4 * len(quads) + 1, 4)
        body = _list_bytes(offsets, binary=True, dtype=ldt) + b"\n" + _list_bytes(quads.ravel(), binary=True, dtype=ldt)
        (poly / "faces").write_bytes(_header("faceCompactList", "faces", **kw) + body)
    else:
        rows = "\n".join(f"4({a} {b} {c} {d})" for a, b, c, d in quads.tolist())
        (poly / "faces").write_bytes(
            _header("faceList", "faces", **kw) + f"{len(quads)}\n(\n".encode("ascii") + rows.encode("ascii") + b"\n)\n"
        )
    del quads
    bnd = [f"{len(patches)}\n(\n"]
    for name, s, n in patches:
        bnd.append(f"    {name}\n    {{\n        type            wall;\n        inGroups        List<word> 1(wall);\n"
                   f"        nFaces          {n};\n        startFace       {s};\n    }}\n")
    bnd.append(")\n")
    (poly / "boundary").write_bytes(_header("polyBoundaryMesh", "boundary", binary=False, label=label, scalar=scalar)
                                    + "".join(bnd).encode("ascii"))
    zone_of = np.full(n_cells, -1, dtype=np.int64)
    if zones:
        ci, cj, ck = (a.ravel() for a in np.meshgrid(np.arange(nx), np.arange(ny), np.arange(nz), indexing="ij"))
        ids = cid(ci, cj, ck)
        for z, mask_of in enumerate(zones.values()):
            hit = np.asarray(mask_of(ci, cj, ck), dtype=bool) & (zone_of[ids] < 0)
            zone_of[ids[hit]] = z
        parts = [f"{len(zones)}\n(\n".encode("ascii")]
        for z, name in enumerate(zones):
            cells = np.flatnonzero(zone_of == z)
            parts.append(f"{name}\n{{\n    type cellZone;\ncellLabels      List<label> ".encode("ascii"))
            parts.append(_list_bytes(cells, binary=binary, dtype=ldt))
            parts.append(b";\n}\n")
        parts.append(b")\n")
        (poly / "cellZones").write_bytes(_header("regIOobject", "cellZones", **kw) + b"".join(parts))
    return {"n_cells": n_cells, "n_faces": int(start), "n_internal": n_internal, "zone_of": zone_of,
            "patches": patches, "n_points": n_points}
