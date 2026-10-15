"""The polyMesh files a boundary face split rewrites (OpenFOAM ESI v2606, ascii or binary).

A Force result control measures exactly the faces the user picked: the case writer
moves those boundary faces into patches of their own (incompressible_flow.force_faces).
That rewrites ``faces``, ``owner`` and ``boundary`` of the run's copy of the mesh;
``points``, ``neighbour`` and the internal faces stay as they are.

Lists are read and written in the file's own format (``format ascii|binary``, the
``arch`` label and scalar widths) and line endings, keeping its header as it was.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_HEADER = re.compile(rb"FoamFile\s*\{(?P<body>[^}]*)\}", re.S)
_ENTRY = re.compile(rb"^\s*(\w+)\s+([^;]*);", re.M)
_COMMENT_OR_SPACE = re.compile(rb"(?:\s+|//[^\n]*\n|/\*.*?\*/)*", re.S)
_COUNT = re.compile(rb"(\d+)\s*\(")


class PolyMeshError(ValueError):
    """A polyMesh file this module cannot read (a format it does not know)."""


@dataclass
class FoamList:
    """One list-valued polyMesh file: its bytes around the list(s) and the lists.

    ``parts`` holds the bytes before, between and after the lists (``len(lists) + 1``
    pieces); ``lists`` the values (labels as int64 arrays, faces as ``(offsets, labels)``).
    """

    path: Path
    fmt: str
    cls: str
    label_bytes: int
    scalar_bytes: int
    newline: bytes
    parts: list[bytes] = field(default_factory=list)
    lists: list[Any] = field(default_factory=list)


def _header(raw: bytes, path: Path) -> tuple[dict[str, str], int]:
    m = _HEADER.search(raw)
    if not m:
        raise PolyMeshError(f"{path.name}: no FoamFile header")
    entries = {k.decode(): v.decode().strip().strip('"') for k, v in _ENTRY.findall(m.group("body"))}
    return entries, m.end()


def _widths(arch: str) -> tuple[int, int]:
    label = re.search(r"label=(\d+)", arch or "")
    scalar = re.search(r"scalar=(\d+)", arch or "")
    return (int(label.group(1)) // 8 if label else 4, int(scalar.group(1)) // 8 if scalar else 8)


def _label_dtype(nbytes: int) -> Any:
    import numpy as np

    if nbytes not in (4, 8):
        raise PolyMeshError(f"label width {nbytes * 8} is not supported")
    return np.dtype("<i4" if nbytes == 4 else "<i8")


def _skip(raw: bytes, pos: int) -> int:
    m = _COMMENT_OR_SPACE.match(raw, pos)
    return m.end() if m else pos


def _read_binary_list(raw: bytes, pos: int, itemsize: int, path: Path) -> tuple[int, int, int]:
    """(count, data start, data end) of a binary list whose count starts at ``pos``."""
    m = _COUNT.match(raw, pos)
    if not m:
        raise PolyMeshError(f"{path.name}: no list at byte {pos}")
    count = int(m.group(1))
    start = m.end()
    end = start + count * itemsize
    if raw[end : end + 1] != b")":
        raise PolyMeshError(f"{path.name}: binary list of {count} does not end where expected")
    return count, start, end


def _ascii_list_body(raw: bytes, pos: int, path: Path) -> tuple[int, int, int]:
    """(count, body start, body end) of an ascii list (its closing parenthesis at body end)."""
    m = _COUNT.match(raw, pos)
    if not m:
        raise PolyMeshError(f"{path.name}: no list at byte {pos}")
    count = int(m.group(1))
    start = m.end()
    depth = 1
    i = start
    n = len(raw)
    while i < n and depth:
        c = raw[i]
        if c == 0x28:  # (
            depth += 1
        elif c == 0x29:  # )
            depth -= 1
        i += 1
    if depth:
        raise PolyMeshError(f"{path.name}: list of {count} is not closed")
    return count, start, i - 1


def read_list(path: Path | str) -> FoamList:
    """Read ``owner``/``neighbour`` (labelList) or ``faces`` (faceList, faceCompactList)."""
    import numpy as np

    path = Path(path)
    raw = path.read_bytes()
    head, end = _header(raw, path)
    fmt = head.get("format", "ascii")
    cls = head.get("class", "")
    lb, sb = _widths(head.get("arch", ""))
    newline = b"\r\n" if b"\r\n" in raw[:end] else b"\n"
    out = FoamList(path=path, fmt=fmt, cls=cls, label_bytes=lb, scalar_bytes=sb, newline=newline)
    pos = _skip(raw, end)
    n_lists = 2 if cls == "faceCompactList" else 1
    if cls not in ("labelList", "faceList", "faceCompactList"):
        raise PolyMeshError(f"{path.name}: class {cls!r} is not a label or face list")
    prev = 0
    for _ in range(n_lists):
        pos = _skip(raw, pos)
        if fmt == "binary":
            if cls == "faceList":
                raise PolyMeshError(f"{path.name}: binary faceList is not supported")
            count, start, stop = _read_binary_list(raw, pos, lb, path)
            values = np.frombuffer(raw[start:stop], dtype=_label_dtype(lb)).astype(np.int64)
            out.parts.append(raw[prev:pos])
            out.lists.append(values)
            prev = stop + 1
            pos = stop + 1
        else:
            count, start, stop = _ascii_list_body(raw, pos, path)
            body = raw[start:stop]
            out.parts.append(raw[prev:pos])
            if cls == "faceList":
                sizes = np.array([int(s) for s in re.findall(rb"(\d+)\s*\(", body)], dtype=np.int64)
                labels = np.array(re.sub(rb"\d+\s*\(", b" ", body).replace(b")", b" ").split(), dtype=np.int64)
                if len(sizes) != count or int(sizes.sum()) != len(labels):
                    raise PolyMeshError(f"{path.name}: {count} faces could not be read")
                offsets = np.zeros(count + 1, dtype=np.int64)
                np.cumsum(sizes, out=offsets[1:])
                out.lists.append(offsets)
                out.lists.append(labels)
            else:
                values = np.array(body.split(), dtype=np.int64)
                if len(values) != count:
                    raise PolyMeshError(f"{path.name}: expected {count} labels, read {len(values)}")
                out.lists.append(values)
            prev = stop + 1
            pos = stop + 1
    out.parts.append(raw[prev:])
    if cls == "faceList" and fmt != "binary":
        # One textual list holds both the offsets and the labels.
        out.parts.insert(1, b"")
    return out


def faces_of(lst: FoamList) -> tuple[Any, Any]:
    """``(offsets, labels)`` of a faces file (face i is labels[offsets[i]:offsets[i+1]])."""
    if lst.cls not in ("faceList", "faceCompactList"):
        raise PolyMeshError(f"{lst.path.name}: not a face list")
    return lst.lists[0], lst.lists[1]


def _ascii_labels(values: Any, nl: bytes) -> bytes:
    body = nl.join(str(int(v)).encode() for v in values)
    return str(len(values)).encode() + nl + b"(" + nl + body + (nl if len(values) else b"") + b")"


def _ascii_faces(offsets: Any, labels: Any, nl: bytes) -> bytes:
    rows = []
    for i in range(len(offsets) - 1):
        f = labels[offsets[i] : offsets[i + 1]]
        rows.append(f"{len(f)}({' '.join(str(int(v)) for v in f)})".encode())
    n = len(offsets) - 1
    return str(n).encode() + nl + b"(" + nl + nl.join(rows) + (nl if n else b"") + b")"


def _binary_labels(values: Any, label_bytes: int) -> bytes:
    import numpy as np

    data = np.asarray(values, dtype=_label_dtype(label_bytes)).tobytes()
    return str(len(values)).encode() + b"\n(" + data + b")"


def write_list(lst: FoamList, path: Path | str | None = None) -> None:
    """Write ``lst`` (its values may have been replaced) in the format it was read in."""
    target = Path(path) if path is not None else lst.path
    nl = lst.newline
    if lst.cls == "faceList" and lst.fmt != "binary":
        offsets, labels = lst.lists
        chunks = [lst.parts[0], _ascii_faces(offsets, labels, nl), lst.parts[2]]
    else:
        chunks = []
        for i, values in enumerate(lst.lists):
            chunks.append(lst.parts[i])
            if lst.fmt == "binary":
                chunks.append(_binary_labels(values, lst.label_bytes))
            else:
                chunks.append(_ascii_labels(values, nl))
        chunks.append(lst.parts[-1])
    target.write_bytes(b"".join(chunks))


def read_points(path: Path | str) -> Any:
    """The mesh points, ``(n, 3)`` in metres."""
    import numpy as np

    path = Path(path)
    raw = path.read_bytes()
    head, end = _header(raw, path)
    _lb, sb = _widths(head.get("arch", ""))
    pos = _skip(raw, end)
    if head.get("format", "ascii") == "binary":
        count, start, stop = _read_binary_list(raw, pos, 3 * sb, path)
        dtype = np.dtype("<f8" if sb == 8 else "<f4")
        return np.frombuffer(raw[start:stop], dtype=dtype).astype(np.float64).reshape(count, 3)
    count, start, stop = _ascii_list_body(raw, pos, path)
    values = np.array(raw[start:stop].replace(b"(", b" ").replace(b")", b" ").split(), dtype=np.float64)
    if len(values) != 3 * count:
        raise PolyMeshError(f"{path.name}: expected {count} points")
    return values.reshape(count, 3)


# ---- boundary -----------------------------------------------------------------------

_PATCH = re.compile(r"(\w+)\s*\{([^{}]*)\}", re.S)


@dataclass
class Patch:
    name: str
    entries: list[tuple[str, str]]

    def get(self, key: str, default: str = "") -> str:
        return next((v for k, v in self.entries if k == key), default)

    def set(self, key: str, value: str) -> None:
        for i, (k, _v) in enumerate(self.entries):
            if k == key:
                self.entries[i] = (k, value)
                return
        self.entries.append((key, value))

    @property
    def start(self) -> int:
        return int(self.get("startFace", "0"))

    @property
    def size(self) -> int:
        return int(self.get("nFaces", "0"))


@dataclass
class Boundary:
    path: Path
    head: str
    tail: str
    newline: str
    patches: list[Patch]


def read_boundary(path: Path | str) -> Boundary:
    path = Path(path)
    text = path.read_bytes().decode("utf-8")
    nl = "\r\n" if "\r\n" in text else "\n"
    m = _HEADER.search(text.encode())
    if not m:
        raise PolyMeshError("boundary: no FoamFile header")
    hdr_end = len(text.encode()[: m.end()].decode())
    rest = text[hdr_end:]
    cm = re.search(r"(\d+)\s*\(", rest)
    if not cm:
        raise PolyMeshError("boundary: no patch list")
    open_at = hdr_end + cm.end()
    close_at = text.rindex(")")
    body = text[open_at:close_at]
    patches = []
    for name, inner in _PATCH.findall(body):
        entries = []
        for line in inner.splitlines():
            line = line.strip()
            if not line or not line.endswith(";"):
                continue
            key, _, value = line[:-1].partition(" ")
            entries.append((key, value.strip()))
        patches.append(Patch(name=name, entries=entries))
    if len(patches) != int(cm.group(1)):
        raise PolyMeshError(f"boundary: expected {cm.group(1)} patches, read {len(patches)}")
    return Boundary(path=path, head=text[: hdr_end + cm.start()], tail=text[close_at + 1 :], newline=nl, patches=patches)


def write_boundary(b: Boundary, path: Path | str | None = None) -> None:
    nl = b.newline
    lines = [str(len(b.patches)), "("]
    for p in b.patches:
        lines.append(f"    {p.name}")
        lines.append("    {")
        lines.extend(f"        {k:<16}{v};" for k, v in p.entries)
        lines.append("    }")
    lines.append(")")
    Path(path or b.path).write_bytes((b.head + nl.join(lines) + b.tail).encode("utf-8"))
