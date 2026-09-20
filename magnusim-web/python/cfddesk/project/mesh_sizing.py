"""Fineness ↔ base cell sizing (Phase 5 design §3)."""

from __future__ import annotations

import math

from cfddesk.project.settings import MeshRefinement

FINENESS_MIN = 1
FINENESS_MAX = 10
FINENESS_DEFAULT = 5
BASE_CELL_MIN_M = 1e-5
BASE_CELL_MAX_M = 1.0


def clamp_fineness(fineness: int) -> int:
    return max(FINENESS_MIN, min(FINENESS_MAX, int(fineness)))


def physics_refinement_for_fineness(fineness: int) -> MeshRefinement:
    """Surface levels when Physics-based meshing is on.

    Coarse (F≤3) keeps the classic ``(2, 2, 1)``. Higher fineness must raise
    **walls** as well as shrink ``base_cell`` — otherwise curved walls stay
    faceted ("cutting corners") even on Fine.
    """
    f = clamp_fineness(fineness)
    if f <= 3:
        return MeshRefinement(inlet=2, outlet=2, walls=1)
    # F4–6 → walls 2; F7–10 → walls 3. Openings one level above walls (cap 3).
    walls = min(3, 1 + (f - 1) // 3)
    io = min(3, walls + 1)
    return MeshRefinement(inlet=io, outlet=io, walls=walls)


def cells_across(fineness: int) -> float:
    """Target cells across the solid's characteristic length for F ∈ [1, 10].

    F=5 (moderate) is ~40.3 cells. The length itself must come from the
    geometry (see ``characteristic_aabb_length_m``), never a millimetre table.
    """
    f = clamp_fineness(fineness)
    return 16.0 * (2.0 ** ((f - 1) / 3.0))


def characteristic_aabb_length_m(dx: float, dy: float, dz: float) -> float:
    """Scale-free characteristic length of one solid from its AABB.

    SimScale Automatic sizing sets "the characteristic element size for each
    solid" from geometrical estimations — not a fixed millimetre slider
    (https://www.simscale.com/docs/simulation-setup/meshing/standard/).
    Their heat-sink tutorial is explicit that global fineness does **not**
    put N cells across thin fins; that needs local sizing.

    Published automatic size fields use a *relative* AABB length:
    - ANSYS: 0.05 × bbox diagonal (too coarse vs SimScale F=5 cyclone ~8 mm)
    - Altair AcuMeshSim: largest AABB side / 8
    - Bawin et al. 2020 (arXiv 2009.03984): bulk ``L_max/20``, ``hmin=L_max/1000``

    We take the **second-largest AABB side** — the in-plane size of the
    primary face — then divide by ``cells_across(F)``. That keeps the
    cyclone barrel (305×305×610 mm → 305 mm → F=5 ≈ 7.6 mm) and treats a
    22×5×22 mm plate as 22 mm, not the 5 mm thickness.
    """
    extents = sorted(float(s) for s in (dx, dy, dz) if float(s) > 0.0)
    if not extents:
        return 1e-6
    if len(extents) == 1:
        return extents[0]
    return extents[-2]


def clamp_base_cell_m(base_cell_m: float) -> float:
    return max(BASE_CELL_MIN_M, min(BASE_CELL_MAX_M, float(base_cell_m)))


def base_cell_from_fineness(bbox_diagonal_m: float, fineness: int) -> float:
    """``base_cell_m = L / N_across(F)``, clamped to UI bounds."""
    L = float(bbox_diagonal_m)
    if L <= 0:
        raise ValueError(f"bbox_diagonal_m must be > 0, got {L}")
    return clamp_base_cell_m(L / cells_across(fineness))


def fineness_from_base_cell(bbox_diagonal_m: float, base_cell_m: float) -> int:
    """Reverse-lookup closest fineness for a stored base cell + bbox diagonal.

    Solves ``N = L / base_cell``, ``N = 16 * 2^((F-1)/3)`` for F, then clamps
    to 1..10. Returns :data:`FINENESS_DEFAULT` when inputs are unusable.
    """
    L = float(bbox_diagonal_m)
    h = float(base_cell_m)
    if L <= 0 or h <= 0:
        return FINENESS_DEFAULT
    n = L / h
    if n <= 0:
        return FINENESS_DEFAULT
    f = 1.0 + 3.0 * math.log2(max(n / 16.0, 1e-12))
    return clamp_fineness(int(round(f)))
