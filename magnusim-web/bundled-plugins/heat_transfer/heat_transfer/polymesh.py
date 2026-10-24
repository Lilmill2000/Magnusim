"""Read a mesh's ``constant/polyMesh`` (ascii or binary, gzipped or not) for what a
conjugate heat transfer case needs to know before it is split into regions.

A mesh of several regions has one cellZone per region (host API 1.8, HT2). From
the unsplit mesh this module tells:

- which regions each patch has faces in (``patch_zones``): splitMeshRegions gives
  each region the part of a patch on its cells, so a patch on two regions is in
  both, and a region's fields need an entry for each of its patches;
- which regions touch (``zone_interfaces``): every pair that shares faces gets the
  coupled interface patches ``<a>_to_<b>`` and ``<b>_to_<a>``;
- how thin a solid is in cells (``thin_cells``): a cell whose every point lies on
  its region's surface (the outer faces and the interfaces) has nothing of the
  region on any side of it. Counted among the cells at the region's surface, so a
  thick base does not hide thin fins (HT0: a heat sink with fins about one cell
  thick diverged, the same sink two cells thick converged);
- each region's volume (``zone_volumes``), for a heat source given in W/m³;
- which region a point is in (``locate``), for a thermocouple.

:func:`mesh_summary` is what Start and the case writer read: the patches, the
regions they touch, the thin counts (and on request the volumes and the region of
some points), computed once per mesh and kept beside it (``ht-mesh-summary.json``,
keyed by the mesh files' sizes and times), so a later check of the same mesh reads
no mesh file. The arrays are kept small (32-bit labels where the mesh has them,
work in chunks of faces): a 2 million cell mesh is read in a few seconds within
about 1 GB.

A mesh with no cellZones is one region (its zone name is ""). numpy is imported
inside the functions (plugin rule: registering stays light).
"""

from __future__ import annotations

import gzip
import json
import mmap
import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_NUMBER = re.compile(rb"\d+")
_WORD = re.compile(rb"[A-Za-z_][A-Za-z0-9_.:<>-]*")
SUMMARY_FILE = "ht-mesh-summary.json"
SUMMARY_VERSION = 2
CHUNK = 1 << 16  # faces per chunk of the geometric work


class MeshReadError(ValueError):
    """The mesh's files cannot be read (missing, or not an OpenFOAM list)."""


@dataclass(frozen=True)
class Patch:
    name: str
    type: str
    start: int
    n_faces: int


@dataclass
class PolyMesh:
    n_points: int
    n_cells: int
    n_faces: int
    n_internal: int
    owner: Any
    neighbour: Any
    patches: list[Patch]
    zone_names: list[str]
    cell_zone: Any  # zone index of every cell, -1 for a cell in none
    poly_dir: Path
    _faces: tuple[Any, Any] | None = field(default=None, repr=False)
    _points: Any = field(default=None, repr=False)

    def faces(self) -> tuple[Any, Any]:
        """(offsets, labels): face f's points are labels[offsets[f]:offsets[f + 1]]."""
        if self._faces is None:
            self._faces = _read_faces(self.poly_dir)
        return self._faces

    def points(self) -> Any:
        if self._points is None:
            self._points = _read_points(self.poly_dir)
        return self._points

    def drop_geometry(self) -> None:
        """Forget the faces and points (the largest arrays) once they are used."""
        self._faces = None
        self._points = None

    def zone(self, index: int) -> str:
        return self.zone_names[index] if 0 <= index < len(self.zone_names) else ""


# ---------------------------------------------------------------------------
# Low-level reading
# ---------------------------------------------------------------------------


def _path(poly: Path, name: str) -> Path:
    for p in (poly / name, poly / f"{name}.gz"):
        if p.is_file():
            return p
    raise MeshReadError(f"constant/polyMesh/{name} is missing")


@contextmanager
def _opened(poly: Path, name: str) -> Iterator[Any]:
    """The file's bytes: mapped from disk (not read into memory; closed after, so the mesh
    can be replaced), or decompressed when it is gzipped."""
    p = _path(poly, name)
    if p.suffix == ".gz":
        yield gzip.decompress(p.read_bytes())
        return
    with p.open("rb") as fh:
        if p.stat().st_size == 0:
            yield b""
            return
        mm = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            yield mm
        finally:
            mm.close()


def _raw(poly: Path, name: str) -> bytes:
    with _opened(poly, name) as raw:
        return bytes(raw)


def _header(raw: Any) -> tuple[dict[str, str], int]:
    """The FoamFile header's entries and the position just after it."""
    start = raw.find(b"FoamFile")
    if start < 0:
        raise MeshReadError("not an OpenFOAM file (no FoamFile header)")
    pos = raw.find(b"{", start)
    if pos < 0:
        raise MeshReadError("a broken FoamFile header")
    depth, end = 1, pos + 1
    while depth:  # the header may hold a sub-dictionary (meta { ... })
        o, c = raw.find(b"{", end), raw.find(b"}", end)
        if c < 0:
            raise MeshReadError("a broken FoamFile header")
        if 0 <= o < c:
            depth, end = depth + 1, o + 1
        else:
            depth, end = depth - 1, c + 1
    end -= 1
    text = bytes(raw[pos + 1 : end]).decode("latin-1")
    out: dict[str, str] = {}
    # A quoted value may hold ';' (arch "LSB;label=32;scalar=64").
    for m in re.finditer(r'(\w+)\s+("[^"]*"|[^;{}"]+);', text):
        out[m.group(1)] = m.group(2).strip().strip('"')
    return out, end + 1


def _sizes(head: dict[str, str]) -> tuple[bool, int, int]:
    binary = head.get("format", "ascii").strip().lower() == "binary"
    arch = head.get("arch", "")
    label = 8 if "label=64" in arch else 4
    scalar = 4 if "scalar=32" in arch else 8
    return binary, label, scalar


def _at(raw: Any, pos: int, text: bytes) -> bool:
    return raw[pos : pos + len(text)] == text


def _skip(raw: Any, pos: int) -> int:
    """Past white space and comments."""
    n = len(raw)
    while pos < n:
        c = raw[pos : pos + 1]
        if c in (b" ", b"\t", b"\r", b"\n"):
            pos += 1
        elif _at(raw, pos, b"//"):
            nl = raw.find(b"\n", pos)
            pos = n if nl < 0 else nl + 1
        elif _at(raw, pos, b"/*"):
            close = raw.find(b"*/", pos + 2)
            pos = n if close < 0 else close + 2
        else:
            break
    return pos


def _list_end(raw: Any, open_pos: int, *, nested: bool) -> int:
    """The ')' that closes the list opened at ``open_pos``: a list of numbers closes at its
    first ')'; a list of lists (points, faces) is a file's only list, so at its last."""
    end = raw.rfind(b")") if nested else raw.find(b")", open_pos)
    if end <= open_pos:
        raise MeshReadError("a list is not closed")
    return end


_PARENS = bytes.maketrans(b"()", b"  ")
# Bytes of an ascii list parsed at a time. A piece's parse holds about 9 times its size
# and up to _workers() pieces are parsed at once, so the peak grows with the piece: at
# 4 MB it was 140-180 MB on a 125 000 cell mesh (how many pieces overlapped decided it),
# at 1 MB under 50 MB and no slower.
ASCII_CHUNK = 1 << 20


def _pieces(raw: Any, start: int, end: int, cut: bytes) -> Iterator[bytes]:
    """raw[start:end] in pieces of about ASCII_CHUNK bytes, each ending at ``cut``."""
    a = start
    while a < end:
        b = min(end, a + ASCII_CHUNK)
        if b < end:
            k = raw.find(cut, b, end)
            b = end if k < 0 else k + len(cut)
        yield bytes(raw[a:b])
        a = b


def _int_tokens(body: Any) -> tuple[Any, Any]:
    """(values, last byte of each) of the unsigned integers in ``body`` (uint8), in numpy:
    each digit run is a number."""
    import numpy as np

    d = np.subtract(body, 48, dtype=np.uint8) < 10
    edge = np.diff(d.view(np.int8), prepend=np.int8(0), append=np.int8(0))
    first = np.flatnonzero(edge == 1)
    last = np.flatnonzero(edge == -1) - 1
    del d, edge
    length = last - first + 1
    vals = np.zeros(first.size, dtype=np.int64)
    for k in range(int(length.max(initial=0))):
        m = length > k
        if m.all():
            vals = vals * 10 + (body[first + k] - 48)
        else:
            vals[m] = vals[m] * 10 + (body[first[m] + k] - 48)
    return vals, last


def _workers() -> int:
    import os

    return max(1, min(4, (os.cpu_count() or 1)))


def _map_pieces(fn: Callable[[bytes], Any], pieces: Iterator[bytes]) -> list[Any]:
    """``fn`` of each piece, in order, a few at a time on threads (numpy lets go of the GIL),
    so only a few pieces are in memory at once."""
    from concurrent.futures import ThreadPoolExecutor

    n = _workers()
    if n == 1:
        return [fn(p) for p in pieces]
    out: list[Any] = []
    with ThreadPoolExecutor(n) as ex:
        batch: list[Any] = []
        for p in pieces:
            batch.append(ex.submit(fn, p))
            if len(batch) >= 2 * n:
                out.append(batch.pop(0).result())
        out.extend(f.result() for f in batch)
    return out


def _ascii_numbers(raw: Any, start: int, end: int, dtype: Any) -> Any:
    """The numbers of raw[start:end] (parentheses read as spaces), a piece at a time,
    stored as ``dtype``: labels digit by digit in numpy, scalars by numpy's parser."""
    import numpy as np

    floats = not np.issubdtype(np.dtype(dtype), np.integer)

    def one(piece: bytes) -> Any:
        if floats:
            clean = piece.translate(_PARENS)
            if not clean.strip():
                return np.zeros(0, dtype=dtype)
            vals = np.fromstring(clean, dtype=np.float64, sep=" ")
        else:
            if b"-" in piece:
                raise MeshReadError("a list of labels holds a negative number")
            vals, _last = _int_tokens(np.frombuffer(piece, dtype=np.uint8))
        return vals.astype(dtype, copy=False)

    pieces = _pieces(raw, start, end, b"\n")
    # numpy's float parser is many times slower on several threads at once: one at a time.
    parts = [one(p) for p in pieces] if floats else _map_pieces(one, pieces)
    return np.concatenate(parts) if parts else np.zeros(0, dtype=dtype)


def _list(raw: Any, pos: int, *, binary: bool, size: int, width: int, kind: str) -> tuple[Any, int]:
    """One list at ``pos`` (its count, then ``(...)`` or ``{value}``): a numpy array of
    ``width`` columns of ``kind`` ("i" labels in the file's label size, "f" float64), and
    the position after it."""
    import numpy as np

    pos = _skip(raw, pos)
    m = _NUMBER.match(raw, pos)
    if not m:
        raise MeshReadError("a list has no count")
    count = int(m.group(0))
    pos = _skip(raw, m.end())
    ldtype = np.int32 if size == 4 else np.int64
    out_dtype = ldtype if kind == "i" else np.float64
    if count == 0 and raw[pos : pos + 1] != b"(":
        # An empty list may be written as its count alone ("List<label> 0;").
        return np.zeros((0, width) if width > 1 else 0, dtype=out_dtype), pos
    if raw[pos : pos + 1] == b"{":
        close = raw.find(b"}", pos)
        value = bytes(raw[pos + 1 : close]).decode("latin-1").strip("() \t\r\n").split()
        one = np.array([float(v) for v in value] or [0.0])
        arr = np.tile(one, count).astype(out_dtype)
        return (arr.reshape(count, width) if width > 1 else arr), close + 1
    if raw[pos : pos + 1] != b"(":
        raise MeshReadError("a list does not open with '('")
    if binary and count > 0:
        start = pos + 1
        file_dtype = ldtype if kind == "i" else (np.float32 if size == 4 else np.float64)
        nbytes = count * width * np.dtype(file_dtype).itemsize
        end = _skip(raw, start + nbytes)
        if raw[end : end + 1] != b")":
            raise MeshReadError("a binary list does not end where its count says")
        view = np.frombuffer(raw, dtype=np.dtype(file_dtype).newbyteorder("<"), count=count * width, offset=start)
        out = view.astype(out_dtype)  # a native copy (the file is closed after)
        del view
        return (out.reshape(count, width) if width > 1 else out), end + 1
    end = _list_end(raw, pos, nested=width > 1)
    vals = _ascii_numbers(raw, pos + 1, end, out_dtype)
    if vals.size != count * width:
        raise MeshReadError("an ascii list holds a different number of values than its count")
    return (vals.reshape(count, width) if width > 1 else vals), end + 1


def _labels(poly: Path, name: str) -> tuple[Any, dict[str, str]]:
    with _opened(poly, name) as raw:
        head, pos = _header(raw)
        binary, label, _scalar = _sizes(head)
        arr, _end = _list(raw, pos, binary=binary, size=label, width=1, kind="i")
    return arr, head


def _face_piece(piece: bytes, label: int) -> tuple[Any, Any]:
    """(sizes, labels) of the whole faces in ``piece`` (``k(a b ...)`` each): a number whose
    next character, past any white space, is '(' is a face's count, the rest its points."""
    import numpy as np

    body = np.frombuffer(piece, dtype=np.uint8)
    vals, last = _int_tokens(body)
    if vals.size == 0:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.int32 if label == 4 else np.int64)
    # The next character past white space is the next number's first digit, or a mark ('(',
    # ')', anything else not a digit) when one comes before it: found among the marks (two
    # per face), never with an array per byte (a 4 MB piece held about 60 MB that way).
    space = (body == 32) | (body == 10) | (body == 13) | (body == 9)
    mark = np.flatnonzero(~space & (np.subtract(body, 48, dtype=np.uint8) >= 10))
    del space
    before = np.searchsorted(mark, last)  # marks before each number (none falls inside one)
    has_mark = np.append(before[1:], mark.size) > before
    is_count = np.zeros(vals.size, dtype=bool)
    is_count[has_mark] = body[mark[before[has_mark]]] == ord("(")
    del mark, before, has_mark
    sizes = vals[is_count]
    labels = vals[~is_count].astype(np.int32 if label == 4 else np.int64)
    if labels.size != int(sizes.sum()):
        raise MeshReadError("faces does not hold the points its counts say")
    return sizes, labels


def _ascii_face_list(raw: Any, open_pos: int, count: int, label: int) -> tuple[Any, Any]:
    """An ascii faceList ``( k(a b ...) ... )``: (offsets, labels), a piece at a time (each
    piece ending after a face's ')')."""
    import numpy as np

    end = _list_end(raw, open_pos, nested=True)
    done = _map_pieces(lambda piece: _face_piece(piece, label), _pieces(raw, open_pos + 1, end, b")"))
    all_sizes = [s for s, _l in done]
    all_labels = [lab for _s, lab in done]
    del done
    sizes = np.concatenate(all_sizes) if all_sizes else np.zeros(0, dtype=np.int64)
    if sizes.size != count:
        raise MeshReadError("faces holds a different number of faces than its count")
    labels = np.concatenate(all_labels) if all_labels else np.zeros(0, dtype=np.int32)
    del all_labels
    offsets = np.zeros(count + 1, dtype=np.int64)
    np.cumsum(sizes, out=offsets[1:])
    return offsets, labels


def _read_faces(poly: Path) -> tuple[Any, Any]:
    import numpy as np

    with _opened(poly, "faces") as raw:
        head, pos = _header(raw)
        binary, label, _scalar = _sizes(head)
        if head.get("class", "") == "faceCompactList":
            offsets, pos = _list(raw, pos, binary=binary, size=label, width=1, kind="i")
            labels, _pos = _list(raw, pos, binary=binary, size=label, width=1, kind="i")
            return offsets.astype(np.int64), labels
        pos = _skip(raw, pos)
        m = _NUMBER.match(raw, pos)
        if not m:
            raise MeshReadError("faces has no count")
        count = int(m.group(0))
        open_pos = _skip(raw, m.end())
        return _ascii_face_list(raw, open_pos, count, label)


def _read_points(poly: Path) -> Any:
    with _opened(poly, "points") as raw:
        head, pos = _header(raw)
        binary, _label, scalar = _sizes(head)
        arr, _end = _list(raw, pos, binary=binary, size=scalar, width=3, kind="f")
    return arr


def _read_boundary(poly: Path) -> list[Patch]:
    raw = _raw(poly, "boundary")
    _head, pos = _header(raw)
    text = raw[pos:].decode("latin-1")
    text = re.sub(r"//[^\n]*", "", text)
    out: list[Patch] = []
    for m in re.finditer(r"([A-Za-z0-9_.:-]+)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}", text):
        body = m.group(2)
        n = re.search(r"\bnFaces\s+(\d+)\s*;", body)
        s = re.search(r"\bstartFace\s+(\d+)\s*;", body)
        t = re.search(r"\btype\s+(\w+)\s*;", body)
        if n and s:
            out.append(Patch(m.group(1), t.group(1) if t else "patch", int(s.group(1)), int(n.group(1))))
    return out


def _read_cell_zones(poly: Path, n_cells: int) -> tuple[list[str], Any]:
    import numpy as np

    cell_zone = np.full(n_cells, -1, dtype=np.int32)
    try:
        raw = _raw(poly, "cellZones")
    except MeshReadError:
        return [], cell_zone
    return _cell_zones_of(raw, cell_zone)


def _cell_zones_of(raw: bytes, cell_zone: Any) -> tuple[list[str], Any]:
    head, pos = _header(raw)
    binary, label, _scalar = _sizes(head)
    pos = _skip(raw, pos)
    m = _NUMBER.match(raw, pos)
    if not m:
        return [], cell_zone
    count = int(m.group(0))
    pos = _skip(raw, m.end())
    if raw[pos : pos + 1] != b"(":
        raise MeshReadError("cellZones does not open its list")
    pos += 1
    names: list[str] = []
    for k in range(count):
        pos = _skip(raw, pos)
        w = _WORD.match(raw, pos)
        if not w:
            raise MeshReadError("a cellZone has no name")
        names.append(w.group(0).decode("latin-1"))
        key = raw.find(b"cellLabels", w.end())
        if key < 0:
            raise MeshReadError(f"cellZone {names[-1]} has no cellLabels")
        pos = _skip(raw, key + len(b"cellLabels"))
        if _at(raw, pos, b"List<label>"):
            pos += len(b"List<label>")
        cells, pos = _list(raw, pos, binary=binary, size=label, width=1, kind="i")
        cell_zone[cells] = k
        close = raw.find(b"}", pos)
        if close < 0:
            raise MeshReadError(f"cellZone {names[-1]} is not closed")
        pos = close + 1
    return names, cell_zone


def mesh_stamp(poly: Path) -> list[Any]:
    """The mesh files' identity: their sizes and modification times."""
    out: list[Any] = [str(Path(poly).resolve())]
    for name in ("owner", "neighbour", "boundary", "cellZones", "faces", "points"):
        for p in (poly / name, poly / f"{name}.gz"):
            if p.is_file():
                st = p.stat()
                out.append([name, st.st_size, st.st_mtime_ns])
    return out


_LAST: dict[str, Any] = {}
_MEMO: dict[str, Any] = {}


def read_polymesh(poly_dir: Path | str) -> PolyMesh:
    """The mesh in ``poly_dir`` (a ``constant/polyMesh`` folder). The last one read is kept
    (without its faces and points once a caller drops them) while its files are unchanged."""
    import numpy as np

    poly = Path(poly_dir)
    if not poly.is_dir():
        raise MeshReadError(f"{poly} is not a folder")
    stamp = json.dumps(mesh_stamp(poly))
    if _LAST.get("stamp") == stamp:
        return _LAST["mesh"]
    _LAST.clear()
    owner, head = _labels(poly, "owner")
    neighbour, _h = _labels(poly, "neighbour")
    note = head.get("note", "")
    nm = re.search(r"nCells:\s*(\d+)", note)
    n_cells = int(nm.group(1)) if nm else int(max(int(owner.max(initial=-1)), int(neighbour.max(initial=-1))) + 1)
    pm = re.search(r"nPoints:\s*(\d+)", note)
    names, cell_zone = _read_cell_zones(poly, n_cells)
    mesh = PolyMesh(
        n_points=int(pm.group(1)) if pm else 0,
        n_cells=n_cells,
        n_faces=int(owner.size),
        n_internal=int(neighbour.size),
        owner=owner,
        neighbour=neighbour,
        patches=_read_boundary(poly),
        zone_names=names,
        cell_zone=cell_zone.astype(np.int32, copy=False),
        poly_dir=poly,
    )
    _LAST.update(stamp=stamp, mesh=mesh)
    return mesh


# ---------------------------------------------------------------------------
# What a CHT case needs
# ---------------------------------------------------------------------------


def patch_zones(mesh: PolyMesh) -> dict[str, dict[str, int]]:
    """{patch: {zone: faces}}: the regions each patch has faces in (zone "" for cells in none)."""
    import numpy as np

    out: dict[str, dict[str, int]] = {}
    for p in mesh.patches:
        if p.n_faces <= 0:
            out[p.name] = {}
            continue
        zones = mesh.cell_zone[mesh.owner[p.start : p.start + p.n_faces]]
        idx, counts = np.unique(zones, return_counts=True)
        out[p.name] = {mesh.zone(int(i)): int(c) for i, c in zip(idx, counts, strict=True)}
    return out


def zone_interfaces(mesh: PolyMesh) -> dict[tuple[str, str], int]:
    """{(a, b): faces}, a < b: the regions that share faces."""
    import numpy as np

    if not mesh.zone_names or mesh.n_internal == 0:
        return {}
    a = mesh.cell_zone[mesh.owner[: mesh.n_internal]]
    b = mesh.cell_zone[mesh.neighbour]
    diff = a != b
    if not diff.any():
        return {}
    lo = np.minimum(a[diff], b[diff]).astype(np.int64)
    hi = np.maximum(a[diff], b[diff]).astype(np.int64)
    key = (lo + 1) * (len(mesh.zone_names) + 2) + (hi + 1)
    keys, counts = np.unique(key, return_counts=True)
    out: dict[tuple[str, str], int] = {}
    for k, c in zip(keys, counts, strict=True):
        i, j = divmod(int(k), len(mesh.zone_names) + 2)
        out[(mesh.zone(i - 1), mesh.zone(j - 1))] = int(c)
    return out


def _zone_index(mesh: PolyMesh, zone: str) -> int:
    """The zone's index; -1 (every cell) for "", a mesh of one region."""
    if not zone:
        return -1
    if zone not in mesh.zone_names:
        raise MeshReadError(f"the mesh has no cellZone {zone}")
    return mesh.zone_names.index(zone)


def _in_zone(mesh: PolyMesh, zone: str) -> Any:
    import numpy as np

    k = _zone_index(mesh, zone)
    if k < 0:
        return np.ones(mesh.n_cells, dtype=bool)
    return mesh.cell_zone == k


def thin_cells(mesh: PolyMesh, zone: str) -> tuple[int, int]:
    """(thin, near the surface) of a region: its cells whose every point is on the region's
    surface (its boundary faces and the faces it shares with other regions), and its cells
    with a point on that surface (a thick part's inside is left out, so a thick base does
    not hide thin fins)."""
    import numpy as np

    inside = _in_zone(mesh, zone)
    if not inside.any():
        return 0, 0
    offsets, labels = mesh.faces()
    n_int = mesh.n_internal
    surface = np.zeros(mesh.n_faces, dtype=bool)
    surface[n_int:] = inside[mesh.owner[n_int:]]
    surface[:n_int] = inside[mesh.owner[:n_int]] != inside[mesh.neighbour]
    counts = np.diff(offsets)
    n_points = int(labels.max(initial=-1)) + 1
    on_surface = np.zeros(n_points, dtype=bool)
    on_surface[labels[np.repeat(surface, counts)]] = True
    # A face with a point off the surface (any of its points), and one with a point on it.
    has = counts > 0
    starts = offsets[:-1][has]
    on = on_surface[labels]
    face_off = np.zeros(mesh.n_faces, dtype=bool)
    face_off[has] = np.logical_or.reduceat(~on, starts)
    face_on = np.zeros(mesh.n_faces, dtype=bool)
    face_on[has] = np.logical_or.reduceat(on, starts)
    del on, on_surface
    cell_off = np.zeros(mesh.n_cells, dtype=bool)
    cell_off[mesh.owner[face_off]] = True
    cell_off[mesh.neighbour[face_off[:n_int]]] = True
    near = np.zeros(mesh.n_cells, dtype=bool)
    near[mesh.owner[face_on]] = True
    near[mesh.neighbour[face_on[:n_int]]] = True
    near &= inside
    return int((inside & ~cell_off).sum()), int(near.sum())


def _chunk_geometry(offsets: Any, labels: Any, pts: Any, lo: int, hi: int) -> tuple[Any, Any]:
    """(centres, area vectors) of faces lo..hi (each split into triangles about its point
    mean; the centre the area-weighted centroid of the triangles)."""
    import numpy as np

    off = offsets[lo : hi + 1] - offsets[lo]
    lab = labels[offsets[lo] : offsets[hi]]
    counts = np.diff(off)
    n = hi - lo
    face_of = np.repeat(np.arange(n), counts)
    xyz = pts[lab]
    mean = np.zeros((n, 3))
    for k in range(3):
        mean[:, k] = np.bincount(face_of, weights=xyz[:, k], minlength=n)
    mean /= np.maximum(counts, 1)[:, None]
    nxt = np.arange(lab.size) + 1
    if n:
        nxt[off[1:][counts > 0] - 1] = off[:-1][counts > 0]
    c = mean[face_of]
    tri = 0.5 * np.cross(xyz - c, xyz[nxt] - c)
    area = np.zeros((n, 3))
    for k in range(3):
        area[:, k] = np.bincount(face_of, weights=tri[:, k], minlength=n)
    mag = np.linalg.norm(tri, axis=1)
    wsum = np.bincount(face_of, weights=mag, minlength=n)
    centre = np.zeros((n, 3))
    tri_c = (xyz + xyz[nxt] + c) / 3.0
    for k in range(3):
        centre[:, k] = np.bincount(face_of, weights=tri_c[:, k] * mag, minlength=n)
    good = wsum > 0
    centre[good] /= wsum[good][:, None]
    centre[~good] = mean[~good]
    return centre, area


def face_geometry(mesh: PolyMesh) -> tuple[Any, Any]:
    """(centres, area vectors) of every face, worked out in chunks."""
    import numpy as np

    offsets, labels = mesh.faces()
    pts = mesh.points()
    centre = np.zeros((mesh.n_faces, 3))
    area = np.zeros((mesh.n_faces, 3))
    for lo in range(0, mesh.n_faces, CHUNK):
        hi = min(mesh.n_faces, lo + CHUNK)
        centre[lo:hi], area[lo:hi] = _chunk_geometry(offsets, labels, pts, lo, hi)
    return centre, area


def zone_volumes(mesh: PolyMesh) -> dict[str, float]:
    """{zone: m³} (zone "" for cells in none): each cell's volume from its faces (Gauss)."""
    import numpy as np

    offsets, labels = mesh.faces()
    pts = mesh.points()
    vol = np.zeros(mesh.n_cells)
    for lo in range(0, mesh.n_faces, CHUNK):
        hi = min(mesh.n_faces, lo + CHUNK)
        centre, area = _chunk_geometry(offsets, labels, pts, lo, hi)
        flux = np.einsum("ij,ij->i", centre, area) / 3.0
        vol += np.bincount(mesh.owner[lo:hi], weights=flux, minlength=mesh.n_cells)
        top = min(hi, mesh.n_internal)
        if top > lo:
            vol -= np.bincount(mesh.neighbour[lo:top], weights=flux[: top - lo], minlength=mesh.n_cells)
    out: dict[str, float] = {}
    if mesh.zone_names:
        sums = np.bincount(mesh.cell_zone + 1, weights=vol, minlength=len(mesh.zone_names) + 1)
        for k, name in enumerate(mesh.zone_names):
            out[name] = float(sums[k + 1])
        if (mesh.cell_zone < 0).any():
            out[""] = float(sums[0])
    else:
        out[""] = float(vol.sum())
    return out


def _cell_boxes(mesh: PolyMesh) -> tuple[Any, Any]:
    """(lowest, highest) corner of each cell's bounding box, from its faces' (chunked)."""
    import numpy as np

    offsets, labels = mesh.faces()
    pts = mesh.points()
    lo_c = np.full((mesh.n_cells, 3), np.inf)
    hi_c = np.full((mesh.n_cells, 3), -np.inf)
    for lo in range(0, mesh.n_faces, CHUNK):
        hi = min(mesh.n_faces, lo + CHUNK)
        off = offsets[lo:hi] - offsets[lo]
        lab = labels[offsets[lo] : offsets[hi]]
        good = np.diff(np.append(off, lab.size)) > 0
        top = min(hi, mesh.n_internal)
        for k in range(3):
            xyz = pts[lab, k]
            f_lo = np.full(hi - lo, np.inf)
            f_hi = np.full(hi - lo, -np.inf)
            f_lo[good] = np.minimum.reduceat(xyz, off[good])
            f_hi[good] = np.maximum.reduceat(xyz, off[good])
            np.minimum.at(lo_c[:, k], mesh.owner[lo:hi], f_lo)
            np.maximum.at(hi_c[:, k], mesh.owner[lo:hi], f_hi)
            if top > lo:
                np.minimum.at(lo_c[:, k], mesh.neighbour[lo:top], f_lo[: top - lo])
                np.maximum.at(hi_c[:, k], mesh.neighbour[lo:top], f_hi[: top - lo])
    return lo_c, hi_c


def locate(mesh: PolyMesh, points: list[list[float]] | list[tuple[float, float, float]]) -> list[str | None]:
    """The region of each point (its zone name; "" in a mesh without zones), None when the
    point is in no cell. A point is in a cell when it is in the cell's bounding box and on
    the inner side of every one of its faces (within a small tolerance); of several, the
    one whose box centre is nearest."""
    import numpy as np

    if not points:
        return []
    offsets, labels = mesh.faces()
    pts = mesh.points()
    lo_c, hi_c = _cell_boxes(mesh)
    span = float(np.max(hi_c - lo_c, initial=0.0)) if mesh.n_cells else 0.0
    tol = 1e-9 * max(span, 1e-30)
    p_all = np.asarray(points, dtype=float).reshape(-1, 3)
    cands = [
        np.flatnonzero(np.all(lo_c <= p + tol, axis=1) & np.all(hi_c >= p - tol, axis=1)) for p in p_all
    ]
    del span
    union = np.unique(np.concatenate(cands)) if cands else np.zeros(0, dtype=np.int64)
    in_union = np.zeros(mesh.n_cells, dtype=bool)
    in_union[union] = True
    own_f = np.flatnonzero(in_union[mesh.owner])
    nei_f = np.flatnonzero(in_union[mesh.neighbour])
    faces_of: dict[int, list[tuple[int, float]]] = {}
    for f in own_f:
        faces_of.setdefault(int(mesh.owner[f]), []).append((int(f), 1.0))
    for f in nei_f:
        faces_of.setdefault(int(mesh.neighbour[f]), []).append((int(f), -1.0))
    geo: dict[int, tuple[Any, Any, float]] = {}
    for f in {f for rows in faces_of.values() for f, _s in rows}:
        fc, fa = _chunk_geometry(offsets, labels, pts, f, f + 1)
        size = float(np.ptp(pts[labels[offsets[f] : offsets[f + 1]]], axis=0).max(initial=0.0))
        geo[f] = (fc[0], fa[0], float(np.linalg.norm(fa[0])) * max(size, 1e-30) * 1e-6)
    out: list[str | None] = []
    for p, cand in zip(p_all, cands, strict=True):
        inside = [
            int(c)
            for c in cand
            if faces_of.get(int(c))
            and all(float(np.dot(p - geo[f][0], geo[f][1] * s)) <= geo[f][2] for f, s in faces_of[int(c)])
        ]
        if not inside:
            out.append(None)
            continue
        best = min(inside, key=lambda c: float(np.sum((0.5 * (lo_c[c] + hi_c[c]) - p) ** 2)))
        out.append(mesh.zone(int(mesh.cell_zone[best])))
    return out


# ---------------------------------------------------------------------------
# The summary Start and the case writer read
# ---------------------------------------------------------------------------


def _summary_path(poly: Path) -> Path:
    """Beside the mesh's case folder: <case>/ht-mesh-summary.json."""
    return Path(poly).parent.parent / SUMMARY_FILE


def _load_summary(poly: Path, stamp: list[Any]) -> dict[str, Any] | None:
    try:
        doc = json.loads(_summary_path(poly).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or doc.get("version") != SUMMARY_VERSION or doc.get("stamp") != stamp:
        return None
    return doc


def _save_summary(poly: Path, doc: dict[str, Any]) -> None:
    path = _summary_path(poly)
    tmp = path.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps(doc), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        tmp.unlink(missing_ok=True)


def mesh_summary(
    poly_dir: Path | str,
    *,
    thin_zones: list[str] | None = None,
    volumes: bool = False,
    points: list[list[float]] | None = None,
    keep: bool = False,
) -> dict[str, Any]:
    """What a CHT case needs of the mesh in ``poly_dir``: ``zone_names``, ``patches``
    ([name, type, n_faces]), ``patch_zones``, ``interfaces`` ([a, b, faces]), ``thin``
    ({zone: [thin, at the surface]} for ``thin_zones``), and on request ``volumes``
    ({zone: m³}) and the region of ``points`` (``located``: {"x y z": zone or None}).

    The last summary is kept in memory while the mesh files are unchanged; with ``keep``
    it is also kept beside the mesh (``<case>/ht-mesh-summary.json``) for other
    processes. What it lacks is computed and added."""
    poly = Path(poly_dir)
    if not poly.is_dir():
        raise MeshReadError(f"{poly} is not a folder")
    stamp = mesh_stamp(poly)
    memo = _MEMO.get("doc")
    if isinstance(memo, dict) and memo.get("stamp") == stamp:
        doc = memo
    else:
        doc = (_load_summary(poly, stamp) if keep else None) or {"version": SUMMARY_VERSION, "stamp": stamp}
    _MEMO["doc"] = doc
    thin_zones = list(thin_zones or [])
    keys = [point_key(p) for p in (points or [])]
    need_base = "patch_zones" not in doc
    need_thin = [z for z in thin_zones if z not in doc.get("thin", {})]
    need_vol = volumes and "volumes" not in doc
    need_pts = [k for k in keys if k not in doc.get("located", {})]
    if not (need_base or need_thin or need_vol or need_pts):
        if keep and not _summary_path(poly).is_file():
            _save_summary(poly, doc)
        return doc
    mesh = read_polymesh(poly)
    try:
        if need_base:
            doc["zone_names"] = list(mesh.zone_names)
            doc["patches"] = [[p.name, p.type, p.n_faces] for p in mesh.patches]
            doc["patch_zones"] = patch_zones(mesh)
            doc["interfaces"] = [[a, b, n] for (a, b), n in zone_interfaces(mesh).items()]
            doc["n_cells"] = mesh.n_cells
        if need_thin:
            thin = dict(doc.get("thin", {}))
            for z in need_thin:
                thin[z] = list(thin_cells(mesh, z))
            doc["thin"] = thin
        if need_vol:
            doc["volumes"] = zone_volumes(mesh)
        if need_pts:
            found = locate(mesh, [[float(c) for c in k.split()] for k in need_pts])
            located = dict(doc.get("located", {}))
            located.update(dict(zip(need_pts, found, strict=True)))
            doc["located"] = located
    finally:
        mesh.drop_geometry()
    if keep:
        _save_summary(poly, doc)
    return doc


def point_key(p: list[float] | tuple[float, ...]) -> str:
    return " ".join(f"{float(c):.9g}" for c in p)
