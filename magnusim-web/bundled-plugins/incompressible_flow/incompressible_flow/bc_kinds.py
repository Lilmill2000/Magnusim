"""Which of this plugin's boundary conditions a saved record is, beyond the four
families magnusim_sdk.study names (velocity inlet, velocity outlet, pressure, wall).

A record's ``bc_type`` is its family's record_type (or an alias); it is compared
without case, spaces, ``_`` or ``-``. Standard library only.
"""

from __future__ import annotations

import math
import re
from typing import Any


def _type_text(bc: Any) -> str:
    raw = (bc or {}).get("bc_type") if isinstance(bc, dict) else getattr(bc, "bc_type", "")
    return re.sub(r"[\s_-]+", "", str(raw or "")).lower()


def is_symmetry(bc: Any) -> bool:
    return _type_text(bc) in ("symmetry", "symmetryplane")


def is_freestream(bc: Any) -> bool:
    return _type_text(bc) in ("freestream", "farfield")


def is_total_pressure_inlet(bc: Any) -> bool:
    return _type_text(bc) in ("totalpressureinlet", "totalpressure")


WALL_KINDS: tuple[str, ...] = ("No-slip", "Slip", "Moving", "Rotating")


def wall_kind(rec: Any) -> str:
    """A wall record's (or the study defaults') treatment: one of WALL_KINDS, No-slip when unknown."""
    raw = (rec or {}).get("wall_type") if isinstance(rec, dict) else getattr(rec, "wall_type", "")
    want = re.sub(r"[\s_-]+", "", str(raw or "")).lower()
    return next((k for k in WALL_KINDS if re.sub(r"[\s_-]+", "", k).lower() == want), "No-slip")


def _vec3(raw: Any, default: tuple[float, float, float]) -> list[float]:
    if isinstance(raw, (list, tuple)) and len(raw) >= 3:
        try:
            v = [float(raw[0]), float(raw[1]), float(raw[2])]
        except (TypeError, ValueError):
            return list(default)
        if all(math.isfinite(x) for x in v):
            return v
    return list(default)


def _num(raw: Any, default: float) -> float:
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return default
    return n if math.isfinite(n) else default


RPM = 2.0 * math.pi / 60.0


def wall_velocity(rec: Any) -> list[float]:
    """A moving wall's velocity in m/s (stored in m/s; none reads as the field default, 1 m/s along x)."""
    return _vec3((rec or {}).get("wall_velocity"), (1.0, 0.0, 0.0))


def wall_rotation(rec: Any) -> tuple[list[float], list[float], float]:
    """A rotating wall's (origin in m, axis as given, speed in rad/s from rpm; 100 rpm when it has none)."""
    d = rec or {}
    origin = _vec3(d.get("rotation_origin"), (0.0, 0.0, 0.0))
    axis = _vec3(d.get("rotation_axis"), (0.0, 0.0, 1.0))
    return origin, axis, _num(d.get("rotation_speed"), 100.0) * RPM


def wall_motion_problem(rec: Any) -> str | None:
    """What a moving or rotating wall lacks, in the user's words, else None."""
    if wall_kind(rec) != "Rotating":
        return None
    _origin, axis, _omega = wall_rotation(rec)
    if not math.hypot(*axis) > 0:
        return "its rotation axis has no direction (all three components are 0)"
    return None
