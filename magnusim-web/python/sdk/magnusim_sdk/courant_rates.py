"""The Courant-rate table of a mesh (run health, RH2): how fast each cell's Courant
number grows with the flow speed, along x, y and z.

OpenFOAM's cell Courant number is ``0.5 · Σ|φ_f| / V · Δt`` over the cell's faces. In a
flow of speed U along the unit direction d the flux through a face is ``φ_f = U d·S_f``,
so ``Co = U · Δt · Σ|S_f·d| / (2V)``. The mesh's part, ``Σ|S_f·d| / (2V)`` (1/m), is the
cell's Courant rate along d: a cube of side h has 1/h along each axis. Faces that carry
no flux (wall, empty, symmetry and wedge patches) are left out, as the solver's sum has
them at zero.

:func:`rate_table` reads a ``constant/polyMesh`` (ascii or binary, gzipped or not) with
numpy and keeps, along each axis, the 99.9th percentile, the 99th, the median and the
largest rate, plus the 2,000 cells with the largest rate (``top``: cell, rate x, y, z).
:func:`rate_along` gives the 99.9th-percentile rate along any direction from it, and
``courant-rates.json`` beside the mesh keeps it (:func:`write_rates`, :func:`read_rates`,
stamped with the mesh files' sizes and times).

It feeds only the shown estimate and the pre-run checks. The time step a case is written
with keeps its own estimate (spec RH2 4.1), so a case's dictionaries never depend on it.

numpy is imported when a table is computed, never when this module is imported.
"""

from __future__ import annotations

import gzip
import json
import math
import re
from pathlib import Path
from typing import Any

RATES_FILE = "courant-rates.json"
RATES_VERSION = 1
# The cells kept in the table: enough for the 99.9th percentile of a 2 million cell mesh.
TOP_CELLS = 2000
# Above this many cells no table is made at mesh end (memory and time); the estimate then
# says it has no rate.
MAX_CELLS = 4_000_000
# Patch types whose faces carry no flux.
NO_FLUX_TYPES = frozenset({"wall", "empty", "symmetry", "symmetryPlane", "wedge"})
AXES = ("x", "y", "z")
_FACES_PER_CHUNK = 1 << 18
# Bytes of an ascii list parsed at a time (its tokens as Python objects: about 6x the bytes).
_ASCII_PIECE = 1 << 23


class MeshReadError(ValueError):
    """A polyMesh file this module cannot read."""


# ---------------------------------------------------------------------------
# Reading the polyMesh
# ---------------------------------------------------------------------------


def _file(poly: Path, name: str) -> Path:
    for p in (poly / name, poly / f"{name}.gz"):
        if p.is_file():
            return p
    raise MeshReadError(f"constant/polyMesh/{name} is missing")


def _bytes(poly: Path, name: str) -> bytes:
    p = _file(poly, name)
    raw = p.read_bytes()
    return gzip.decompress(raw) if p.suffix == ".gz" else raw


def _header(raw: bytes) -> tuple[dict[str, str], int]:
    """The FoamFile header's entries and the position just after its closing brace."""
    start = raw.find(b"FoamFile")
    if start < 0:
        raise MeshReadError("not an OpenFOAM file (no FoamFile header)")
    pos = raw.find(b"{", start)
    depth, end = 1, pos + 1
    while depth:
        o, c = raw.find(b"{", end), raw.find(b"}", end)
        if c < 0 or pos < 0:
            raise MeshReadError("a broken FoamFile header")
        if 0 <= o < c:
            depth, end = depth + 1, o + 1
        else:
            depth, end = depth - 1, c + 1
    text = raw[pos + 1 : end - 1].decode("latin-1")
    head: dict[str, str] = {}
    for m in re.finditer(r'(\w+)\s+("[^"]*"|[^;{}"]+);', text):
        head[m.group(1)] = m.group(2).strip().strip('"')
    return head, end


def _widths(head: dict[str, str]) -> tuple[bool, int, int]:
    binary = head.get("format", "ascii").strip().lower() == "binary"
    arch = head.get("arch", "")
    return binary, (8 if "label=64" in arch else 4), (4 if "scalar=32" in arch else 8)


_SKIP = re.compile(rb"(?:\s+|//[^\n]*\n?|/\*.*?\*/)*", re.S)
_COUNT = re.compile(rb"(\d+)")


def _list_at(raw: bytes, pos: int) -> tuple[int, int]:
    """(count, position of the list's '(') of the list whose count starts at or after pos;
    position -1 for a list written as its count alone."""
    m = _SKIP.match(raw, pos)
    pos = m.end() if m else pos
    c = _COUNT.match(raw, pos)
    if not c:
        raise MeshReadError("a list has no count")
    count = int(c.group(1))
    m = _SKIP.match(raw, c.end())
    pos = m.end() if m else c.end()
    if raw[pos : pos + 1] != b"(":
        if count == 0:
            return 0, -1
        raise MeshReadError("a list does not open with '('")
    return count, pos


def _ascii_numbers(body: bytes, dtype: Any) -> Any:
    """The numbers in an ascii list body (white space between them), a piece at a time
    (numpy's own text parser takes about 20 times as long on a faces list)."""
    import numpy as np

    out = []
    pos, n = 0, len(body)
    while pos < n:
        end = min(n, pos + _ASCII_PIECE)
        if end < n:
            cut = max(body.rfind(b" ", pos, end), body.rfind(b"\n", pos, end))
            end = cut + 1 if cut > pos else end
        out.append(np.array(body[pos:end].split(), dtype=dtype))
        pos = end
    return np.concatenate(out) if out else np.zeros(0, dtype=dtype)


def _binary_list(raw: bytes, open_pos: int, count: int, dtype: Any, width: int) -> tuple[Any, int]:
    import numpy as np

    start = open_pos + 1
    n = count * width
    arr = np.frombuffer(raw, dtype=dtype, count=n, offset=start).copy()
    end = start + n * np.dtype(dtype).itemsize
    if raw[end : end + 1] != b")":
        raise MeshReadError("a binary list does not end where its count says")
    return arr, end + 1


def _labels(poly: Path, name: str) -> tuple[Any, dict[str, str]]:
    import numpy as np

    raw = _bytes(poly, name)
    head, pos = _header(raw)
    binary, lb, _sb = _widths(head)
    count, open_pos = _list_at(raw, pos)
    if open_pos < 0 or count == 0:
        return np.zeros(0, dtype=np.int64), head
    if binary:
        arr, _end = _binary_list(raw, open_pos, count, np.dtype("<i4" if lb == 4 else "<i8"), 1)
        return arr.astype(np.int64), head
    close = raw.find(b")", open_pos)
    arr = _ascii_numbers(raw[open_pos + 1 : close], np.int64)
    if arr.size != count:
        raise MeshReadError(f"{name} holds {arr.size} labels, its count says {count}")
    return arr, head


def _points(poly: Path) -> Any:
    import numpy as np

    raw = _bytes(poly, "points")
    head, pos = _header(raw)
    binary, _lb, sb = _widths(head)
    count, open_pos = _list_at(raw, pos)
    if open_pos < 0 or count == 0:
        return np.zeros((0, 3))
    if binary:
        arr, _end = _binary_list(raw, open_pos, count, np.dtype("<f4" if sb == 4 else "<f8"), 3)
        return arr.astype(np.float64).reshape(count, 3)
    close = raw.rfind(b")")
    body = raw[open_pos + 1 : close].translate(bytes.maketrans(b"()", b"  "))
    arr = _ascii_numbers(body, np.float64)
    if arr.size != count * 3:
        raise MeshReadError(f"points holds {arr.size} numbers, its count says {count} points")
    return arr.reshape(count, 3)


def _faces(poly: Path) -> tuple[Any, Any]:
    """(offsets, labels): face f's points are labels[offsets[f]:offsets[f + 1]]."""
    import numpy as np

    raw = _bytes(poly, "faces")
    head, pos = _header(raw)
    binary, lb, _sb = _widths(head)
    cls = head.get("class", "faceList")
    if cls == "faceCompactList":
        dtype = np.dtype("<i4" if lb == 4 else "<i8")
        n_off, open_pos = _list_at(raw, pos)
        if binary:
            offsets, end = _binary_list(raw, open_pos, n_off, dtype, 1)
            n_lab, open2 = _list_at(raw, end)
            labels, _end = _binary_list(raw, open2, n_lab, dtype, 1)
        else:
            close = raw.find(b")", open_pos)
            offsets = _ascii_numbers(raw[open_pos + 1 : close], np.int64)
            n_lab, open2 = _list_at(raw, close + 1)
            close2 = raw.find(b")", open2)
            labels = _ascii_numbers(raw[open2 + 1 : close2], np.int64)
        return offsets.astype(np.int64), labels.astype(np.int64)
    if binary:
        raise MeshReadError("a binary faceList is not supported")
    count, open_pos = _list_at(raw, pos)
    close = raw.rfind(b")")
    # "4(a b c d)": each '(' follows its face's point count; written as -1 it marks that count.
    body = raw[open_pos + 1 : close].replace(b"(", b" -1 ").replace(b")", b" ")
    tokens = _ascii_numbers(body, np.int64)
    marks = np.flatnonzero(tokens == -1)
    if marks.size != count:
        raise MeshReadError(f"faces holds {marks.size} faces, its count says {count}")
    sizes = tokens[marks - 1]
    keep = np.ones(tokens.size, dtype=bool)
    keep[marks] = False
    keep[marks - 1] = False
    labels = tokens[keep]
    offsets = np.zeros(count + 1, dtype=np.int64)
    np.cumsum(sizes, out=offsets[1:])
    if offsets[-1] != labels.size:
        raise MeshReadError("faces does not hold the points its counts say")
    return offsets, labels


def _patches(poly: Path) -> list[tuple[str, str, int, int]]:
    """(name, type, startFace, nFaces) of each patch in ``boundary``."""
    text = _bytes(poly, "boundary").decode("latin-1")
    _head, pos = _header(text.encode("latin-1"))
    body = re.sub(r"//[^\n]*|/\*.*?\*/", "", text[pos:], flags=re.S)
    out: list[tuple[str, str, int, int]] = []
    for m in re.finditer(r"([A-Za-z_][\w.:<>-]*|\"[^\"]+\")\s*\{([^{}]*)\}", body):
        entries = dict(re.findall(r"(\w+)\s+([^;]+);", m.group(2)))
        if "nFaces" not in entries or "startFace" not in entries:
            continue
        out.append((m.group(1).strip('"'), entries.get("type", "patch").strip(), int(entries["startFace"]), int(entries["nFaces"])))
    return out


def mesh_stamp(poly_dir: Path | str) -> list[Any]:
    """The mesh files' identity: each file's name, size and modification time (ns, as text:
    the server compares it too, and JSON numbers lose its last digits there)."""
    poly = Path(poly_dir)
    out: list[Any] = []
    for name in ("points", "faces", "owner", "neighbour", "boundary"):
        for p in (poly / name, poly / f"{name}.gz"):
            if p.is_file():
                st = p.stat()
                out.append([p.name, st.st_size, str(st.st_mtime_ns)])
    return out


def mesh_cell_count(poly_dir: Path | str) -> int | None:
    """The cell count in ``owner``'s header note (``nCells:``), without reading its list."""
    try:
        p = _file(Path(poly_dir), "owner")
        with (gzip.open(p, "rb") if p.suffix == ".gz" else p.open("rb")) as fh:
            head = fh.read(4096)
    except (OSError, MeshReadError):
        return None
    m = re.search(rb"nCells:\s*(\d+)", head)
    return int(m.group(1)) if m else None


# ---------------------------------------------------------------------------
# The rates
# ---------------------------------------------------------------------------


def _face_vectors(points: Any, offsets: Any, labels: Any, lo: int, hi: int) -> tuple[Any, Any]:
    """Area vectors and mean-point centres of faces lo..hi (a fan of triangles from each
    face's first point: the vector area of a closed loop, whatever point it is taken from)."""
    import numpy as np

    off = offsets[lo : hi + 1]
    n = np.diff(off)
    if n.size and int(n.min()) < 3:
        raise MeshReadError("a face has fewer than 3 points")
    nt = n - 2
    first = np.repeat(off[:-1], nt)
    start = np.cumsum(nt) - nt
    k = np.arange(int(nt.sum()), dtype=np.int64) - np.repeat(start, nt) + 1
    p0 = points[labels[first]]
    cross = np.cross(points[labels[first + k]] - p0, points[labels[first + k + 1]] - p0)
    area = 0.5 * np.add.reduceat(cross, start, axis=0)
    centre = np.add.reduceat(points[labels[off[0] : off[-1]]], off[:-1] - off[0], axis=0) / n[:, None]
    return area, centre


def cell_rates(poly_dir: Path | str) -> Any:
    """Every cell's Courant rate along x, y and z (an ``(n_cells, 3)`` array, 1/m)."""
    return _rates(Path(poly_dir))[0]


def _rates(poly: Path) -> tuple[Any, list[float], list[float]]:
    """(the cells' rates, the points' lowest and highest corner)."""
    import numpy as np

    points = _points(poly)
    offsets, labels = _faces(poly)
    owner, head = _labels(poly, "owner")
    neighbour, _h = _labels(poly, "neighbour")
    note = re.search(r"nCells:\s*(\d+)", head.get("note", ""))
    n_cells = int(note.group(1)) if note else int(max(owner.max(initial=-1), neighbour.max(initial=-1)) + 1)
    n_faces = owner.size
    if offsets.size != n_faces + 1:
        raise MeshReadError("faces and owner hold different numbers of faces")
    flux = np.ones(n_faces, dtype=bool)
    for _name, kind, start, count in _patches(poly):
        if kind in NO_FLUX_TYPES:
            flux[start : start + count] = False
    ref = 0.5 * (points.min(axis=0) + points.max(axis=0)) if points.size else np.zeros(3)
    vol = np.zeros(n_cells)
    sums = np.zeros((n_cells, 3))
    n_int = neighbour.size
    for lo in range(0, n_faces, _FACES_PER_CHUNK):
        hi = min(n_faces, lo + _FACES_PER_CHUNK)
        area, centre = _face_vectors(points, offsets, labels, lo, hi)
        dv = np.einsum("ij,ij->i", centre - ref, area) / 3.0
        mag = np.abs(area) * flux[lo:hi, None]
        own = owner[lo:hi]
        vol += np.bincount(own, weights=dv, minlength=n_cells)
        for a in range(3):
            sums[:, a] += np.bincount(own, weights=mag[:, a], minlength=n_cells)
        if lo < n_int:
            m = min(hi, n_int) - lo
            nb = neighbour[lo : lo + m]
            vol -= np.bincount(nb, weights=dv[:m], minlength=n_cells)
            for a in range(3):
                sums[:, a] += np.bincount(nb, weights=mag[:m, a], minlength=n_cells)
    good_vol = np.where(vol > 0, vol, np.nan)
    lo_pt = [float(v) for v in points.min(axis=0)] if points.size else [0.0, 0.0, 0.0]
    hi_pt = [float(v) for v in points.max(axis=0)] if points.size else [0.0, 0.0, 0.0]
    return sums / (2.0 * good_vol[:, None]), lo_pt, hi_pt


def rate_table(poly_dir: Path | str, *, top: int = TOP_CELLS) -> dict[str, Any]:
    """The table ``courant-rates.json`` keeps: per axis the 99.9th and 99th percentiles,
    the median and the largest rate (1/m, over the cells with a positive volume), the
    mesh's box (``bbox_m``: its points' lowest and highest corner and the size), and the
    ``top`` cells with the largest rate along any axis (``[cell, x, y, z]``, largest first)."""
    import numpy as np

    rates, lo, hi = _rates(Path(poly_dir))
    good = np.all(np.isfinite(rates), axis=1)
    r = rates[good]
    n = int(r.shape[0])
    if not n:
        raise MeshReadError("no cell has a positive volume")
    stats = {
        "p99_9": [float(v) for v in np.percentile(r, 99.9, axis=0)],
        "p99": [float(v) for v in np.percentile(r, 99.0, axis=0)],
        "median": [float(v) for v in np.median(r, axis=0)],
        "max": [float(v) for v in r.max(axis=0)],
    }
    ids = np.flatnonzero(good)
    order = np.argsort(-r.max(axis=1), kind="stable")[: max(0, int(top))]
    rows = [[int(ids[i]), *(float(f"{v:.6g}") for v in r[i])] for i in order]
    return {
        "v": RATES_VERSION,
        "n_cells": int(rates.shape[0]),
        "n_rated": n,
        "bad_cells": int(rates.shape[0] - n),
        "axes": list(AXES),
        "bbox_m": {"min": lo, "max": hi, "size": [float(f"{b - a:.6g}") for a, b in zip(lo, hi, strict=True)]},
        **{k: [float(f"{x:.6g}") for x in v] for k, v in stats.items()},
        "top": rows,
    }


def _unit(direction: Any) -> tuple[float, float, float] | None:
    try:
        d = [float(v) for v in direction]
    except (TypeError, ValueError):
        return None
    if len(d) != 3 or not all(math.isfinite(v) for v in d):
        return None
    n = math.sqrt(sum(v * v for v in d))
    return (d[0] / n, d[1] / n, d[2] / n) if n > 0 else None


def rate_along(table: dict[str, Any] | None, direction: Any = (1.0, 0.0, 0.0)) -> float | None:
    """The 99.9th-percentile Courant rate (1/m) along ``direction`` (any length).

    Along an axis (within about 1°) it is that axis's percentile over all cells. Along
    another direction each kept cell's rate is taken as Σ|d_i|·rate_i, which is never
    below its true rate (so the estimate errs towards a smaller time step), and the
    percentile is read from the kept cells while they reach it, else from the axes' own.
    None without a table or a direction.
    """
    d = _unit(direction)
    if not table or d is None:
        return None
    p = table.get("p99_9")
    if not isinstance(p, list) or len(p) != 3:
        return None
    a = [abs(v) for v in d]
    i = max(range(3), key=lambda j: a[j])
    if a[i] >= math.cos(math.radians(1.0)):
        return float(p[i])
    n = int(table.get("n_rated") or table.get("n_cells") or 0)
    top = [row for row in table.get("top") or [] if isinstance(row, list) and len(row) == 4]
    pos = 0.001 * (n - 1)  # numpy's linear percentile, counted from the largest
    if n > 0 and math.ceil(pos) < len(top):
        vals = sorted((a[0] * row[1] + a[1] * row[2] + a[2] * row[3] for row in top), reverse=True)
        lo = int(math.floor(pos))
        frac = pos - lo
        return float(vals[lo] + (vals[min(lo + 1, len(vals) - 1)] - vals[lo]) * frac)
    return float(sum(a[j] * float(p[j]) for j in range(3)))


# ---------------------------------------------------------------------------
# courant-rates.json
# ---------------------------------------------------------------------------


def write_rates(case_dir: Path | str, *, max_cells: int = MAX_CELLS) -> dict[str, Any]:
    """Make the table of the mesh in ``case_dir/constant/polyMesh`` and keep it in
    ``case_dir/courant-rates.json``. Returns its summary for mesh-facts.json: the table
    without ``top`` (``{"skipped": why}`` when it was not made)."""
    case = Path(case_dir)
    poly = case / "constant" / "polyMesh"
    out = case / RATES_FILE
    try:
        out.unlink()
    except OSError:
        pass
    cells = mesh_cell_count(poly)
    if cells is not None and cells > max_cells:
        return {"skipped": f"over {max_cells:,} cells"}
    try:
        table = rate_table(poly)
    except (MeshReadError, OSError, ValueError, MemoryError) as exc:
        return {"skipped": f"the mesh could not be read: {str(exc)[:120]}"}
    table["stamp"] = mesh_stamp(poly)
    out.write_text(json.dumps(table, separators=(",", ":")) + "\n", encoding="utf-8")
    return {k: v for k, v in table.items() if k not in ("top", "stamp")}


def read_rates(case_dir: Path | str) -> dict[str, Any] | None:
    """The table kept beside the mesh in ``case_dir``, or None when there is none or the
    mesh changed since it was made."""
    case = Path(case_dir)
    try:
        table = json.loads((case / RATES_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(table, dict) or table.get("v") != RATES_VERSION:
        return None
    if table.get("stamp") != mesh_stamp(case / "constant" / "polyMesh"):
        return None
    return table
