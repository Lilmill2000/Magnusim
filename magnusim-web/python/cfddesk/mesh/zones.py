"""Cell zones of a written mesh (host API 1.8: one per region of a heat-transfer mesh)."""

from __future__ import annotations

import re
from pathlib import Path

# ``<name> { type cellZone; cellLabels List<label> <n>`` (ascii or binary: the count
# is written before the labels either way).
_ZONE = re.compile(rb"([A-Za-z_][\w.:-]*)\s*\{\s*type\s+cellZone\s*;\s*cellLabels\s+List<label>\s+(\d+)")


def cell_zone_sizes(polymesh: Path) -> dict[str, int]:
    """Cells per cellZone of ``constant/polyMesh`` (``{}`` when it has none)."""
    path = Path(polymesh) / "cellZones"
    if not path.is_file():
        return {}
    data = path.read_bytes()
    return {m.group(1).decode("ascii", "replace"): int(m.group(2)) for m in _ZONE.finditer(data)}
