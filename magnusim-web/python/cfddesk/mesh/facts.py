"""A finished mesh's facts (run health, RH2), written beside it by every mesher.

When a mesh is done its generator calls :func:`finish_mesh_facts`: ``mesh-facts.json``
(checkMesh's quality, the box, the surface cell size, the boundary layers asked and
made) and ``courant-rates.json`` (the Courant-rate table) go beside the mesh
(``magnusim_sdk.mesh_facts``), and the quality the mesh record keeps goes in the
generator's result line (``quality``), so the Mesh panel and the Assistant read it.
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from magnusim_sdk.mesh_facts import record_quality, write_mesh_facts


def finish_mesh_facts(
    case_dir: Path | str, mesher: str | None, progress: Callable[[str], Any] | None = None
) -> dict[str, Any] | None:
    """Write the mesh's facts beside it and return the quality its record keeps; None when
    they could not be made. The mesh is done by now: nothing here fails it."""
    if progress is not None:
        progress("mesh_facts")
    try:
        facts = write_mesh_facts(case_dir, mesher=mesher)
    except Exception as exc:  # noqa: BLE001 (the facts are extra; the mesh stays done)
        print(f"mesh facts: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return None
    return record_quality(facts.get("quality"))
