"""Read one patch's values of an OpenFOAM volScalarField file (ascii or binary), for tests."""

from __future__ import annotations

import re
import struct
from pathlib import Path

_BINARY = re.compile(rb"\bformat\s+binary\s*;")
_VALUE = re.compile(rb"\bvalue\s+(uniform\s+([^;]+);|nonuniform\s+List<scalar>\s*(\d+)\s*\()")


def patch_values(path: Path, patch: str) -> list[float]:
    """The ``value`` of ``patch`` in the field's boundaryField: a uniform value once, or
    every face's value of a nonuniform list (binary: little-endian doubles)."""
    data = Path(path).read_bytes()
    head = re.search(rb"\n\s*" + re.escape(patch.encode()) + rb"\s*\n\s*\{", data)
    if head is None:
        raise KeyError(f"{Path(path).name} has no patch {patch}")
    value = _VALUE.search(data, head.end())
    if value is None:
        raise KeyError(f"{Path(path).name}: patch {patch} has no value")
    if value.group(2) is not None:
        return [float(value.group(2))]
    n = int(value.group(3))
    start = value.end()
    if _BINARY.search(data[: head.start()]):
        return list(struct.unpack(f"<{n}d", data[start : start + 8 * n]))
    body = data[start : data.index(b")", start)].split()
    return [float(x) for x in body[:n]]
