"""Solid volume and rough mesh cell-count estimation."""

from __future__ import annotations

from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.TopoDS import TopoDS_Shape


def solid_volume_native(shape: TopoDS_Shape) -> float:
    """Solid volume in native OCCT (cascade) length units, cubed.

    Mirrors the "native" convention used by ``cfddesk.cad.units.shape_bbox``:
    the caller applies ``scale_to_metres ** 3`` to convert to m^3.
    """
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    volume = float(props.Mass())
    if volume <= 0:
        raise RuntimeError(
            f"non-positive solid volume ({volume}) — shape is not a closed solid"
        )
    return volume


def shape_center_of_mass_native(shape: TopoDS_Shape) -> tuple[float, float, float, str]:
    """Volume centre of mass in native OCCT length units (same frame as the STEP).

    Falls back to surface properties if the shape has no positive volume.
    Does not rotate or rebase the global coordinate system.
    """
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    kind = "volume"
    if float(props.Mass()) <= 0:
        BRepGProp.SurfaceProperties_s(shape, props)
        kind = "surface"
        if float(props.Mass()) <= 0:
            raise RuntimeError("shape has no volume or surface mass for centre of mass")
    c = props.CentreOfMass()
    return (float(c.X()), float(c.Y()), float(c.Z()), kind)


def estimate_cell_count(
    volume_m3: float,
    base_cell_m: float,
    max_refinement_level: int,
) -> int:
    """Rough upper-bound snappyHexMesh cell-count estimate.

    ``eff = base_cell_m / (2**max_refinement_level)`` is the finest
    (most-refined) isotropic cell edge length snappyHexMesh produces at
    ``max_refinement_level``. Treating the whole domain volume as if it were
    refined to that level gives ``n = volume_m3 / eff**3`` — a conservative
    (upper-bound) estimate, since real snappy meshes only refine near the
    flagged surfaces, not the whole volume.
    """
    if volume_m3 <= 0:
        raise ValueError(f"volume_m3 must be > 0, got {volume_m3}")
    if base_cell_m <= 0:
        raise ValueError(f"base_cell_m must be > 0, got {base_cell_m}")
    if max_refinement_level < 0:
        raise ValueError(
            f"max_refinement_level must be >= 0, got {max_refinement_level}"
        )
    eff = base_cell_m / (2**max_refinement_level)
    n = volume_m3 / (eff**3)
    return int(round(n))


def estimate_cell_count_range(
    volume_m3: float,
    base_cell_m: float,
    max_refinement_level: int,
    *,
    lo_fraction: float = 0.55,
) -> tuple[int, int]:
    """Approximate lo–hi cell band (Phase 5 design §3).

    ``hi`` is the existing upper-bound estimate; ``lo = lo_fraction * hi``.
    Not snappy truth — suitable for UI captioning only.
    """
    hi = estimate_cell_count(volume_m3, base_cell_m, max_refinement_level)
    lo = max(1, int(round(float(lo_fraction) * hi)))
    if lo > hi:
        lo, hi = hi, lo
    return lo, hi


def format_cell_count(n: int) -> str:
    """Compact cell-count label (e.g. 220k, 1.5M)."""
    n = int(n)
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M".replace(".0M", "M")
    if n >= 10_000:
        return f"{n / 1000:.0f}k"
    if n >= 1000:
        return f"{n / 1000:.1f}k".replace(".0k", "k")
    return f"{n:,}"
