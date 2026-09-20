"""Confirmed geometry defaults for the vortex slice-1 STEP."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

FaceRole = Literal["unassigned", "inlet", "outlet", "walls"]

VORTEX_STEP = Path(os.environ.get("CFDDESK_DEFAULT_STEP") or "Vortex CFD Test.step")

# User-confirmed 2026-07-29: OCCT cascade MM → metres.
# 304.801 mm = 12.000 in, 812.802 mm = 32.000 in (inch STEP, cascaded to MM).
CONFIRMED_SCALE_TO_METRES = 0.001
CONFIRMED_NATIVE_UNIT = "MM"
CONFIRMED_DECLARED_UNIT = "INCH"

# User-confirmed face roles 2026-07-29.
# Face 13 = closed bin floor at full body diameter — permanent wall (not a deferred outlet).
CONFIRMED_ROLES: dict[int, FaceRole] = {
    9: "inlet",
    12: "outlet",
    # walls: planar extras + all non-planar assigned at project build time
    3: "walls",
    10: "walls",
    13: "walls",
    15: "walls",
}

# Mesh sizing targets (metres). Refinement level 2 on inlet/outlet surfaces.
MESH_BASE_CELL_M = 0.025
MESH_REFINEMENT_LEVEL_INOUT = 2
MESH_MIN_CELLS_ACROSS_PASSAGE = 3.0  # block if below; target 3–4


def is_vortex_step(path: str | Path) -> bool:
    try:
        return Path(path).resolve() == VORTEX_STEP.resolve()
    except OSError:
        return Path(path).name.lower() == VORTEX_STEP.name.lower()


def roles_for_solid(n_faces: int) -> dict[int, FaceRole]:
    """Full face→role map: confirmed openings; everything else walls."""
    roles: dict[int, FaceRole] = {i: "walls" for i in range(n_faces)}
    roles.update(CONFIRMED_ROLES)
    return roles
