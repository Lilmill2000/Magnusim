"""A study's reference values: what forces, coefficients and the pressure
coefficient are measured against.

The study panel saves them on the study's record (``ref_*`` keys, SI units).
A blank value is "calculate for me": the reference speed is the inlet's speed
(the speed the writer's turbulence inlet values use, ``resolve_speed_and_dhyd``),
the reference pressure 0 Pa gauge, the centre of rotation the origin, the drag
direction the inlet's flow direction (+X without one) and the lift direction
+Z (+Y when drag runs along Z), at right angles to drag. The density is the
study fluid's. The reference area and length have no default: force
coefficients need the area, the moment coefficient the length too.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

# The study record keys the panel saves (study settings schema group "reference").
REFERENCE_KEYS: tuple[str, ...] = (
    "ref_speed",
    "ref_pressure",
    "ref_area",
    "ref_length",
    "ref_cofr",
    "ref_drag_dir",
    "ref_lift_dir",
)

Vec = tuple[float, float, float]


def _num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _vec(value: Any) -> Vec | None:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return None
    nums = [_num(v) for v in value]
    if any(n is None for n in nums):
        return None
    return (float(nums[0]), float(nums[1]), float(nums[2]))  # type: ignore[arg-type]


def _norm(v: Vec) -> float:
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def _unit(v: Vec | None) -> Vec | None:
    if v is None:
        return None
    m = _norm(v)
    if not (m > 1e-12):
        return None
    return (v[0] / m, v[1] / m, v[2] / m)


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: Vec, b: Vec) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def reference_record(study: dict[str, Any] | None) -> dict[str, Any]:
    """The study's saved reference values (only the ``ref_*`` keys it has)."""
    rec = study if isinstance(study, dict) else {}
    return {k: rec[k] for k in REFERENCE_KEYS if rec.get(k) is not None}


def has_reference_values(raw: dict[str, Any] | None) -> bool:
    """True when the study set any reference value."""
    return any((raw or {}).get(k) is not None for k in REFERENCE_KEYS)


@dataclass(frozen=True)
class Reference:
    """Resolved reference values, SI."""

    speed: float
    speed_auto: bool
    pressure: float
    rho: float
    area: float | None
    length: float | None
    cofr: Vec
    drag: Vec
    lift: Vec
    drag_auto: bool
    lift_auto: bool
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def side(self) -> Vec:
        """The side direction OpenFOAM's forceCoeffs uses: lift x drag."""
        return cross(self.lift, self.drag)

    def to_json(self) -> dict[str, Any]:
        return {
            "speed_m_s": self.speed,
            "speed_auto": self.speed_auto,
            "pressure_Pa": self.pressure,
            "rho": self.rho,
            "area_m2": self.area,
            "length_m": self.length,
            "cofr_m": list(self.cofr),
            "drag_dir": list(self.drag),
            "lift_dir": list(self.lift),
            "side_dir": list(self.side),
            "drag_auto": self.drag_auto,
            "lift_auto": self.lift_auto,
            "notes": list(self.notes),
        }


def default_lift(drag: Vec) -> Vec:
    """+Z at right angles to drag; +Y when drag runs (nearly) along Z."""
    up: Vec = (0.0, 0.0, 1.0) if abs(drag[2]) < 0.9 else (0.0, 1.0, 0.0)
    return _orthogonal(up, drag) or (0.0, 1.0, 0.0)


def _orthogonal(v: Vec, to: Vec) -> Vec | None:
    """``v`` with its part along ``to`` (a unit vector) removed, as a unit vector."""
    d = _dot(v, to)
    return _unit((v[0] - d * to[0], v[1] - d * to[1], v[2] - d * to[2]))


def inlet_flow_direction(spec: Any) -> Vec | None:
    """The direction the study's main inlet blows (the inlet the reference speed is
    taken from): a vector inlet's own direction, else into the domain through its
    faces (against their area-weighted normal). With no velocity inlet, the
    fastest freestream's direction. None without either, or without normals."""
    from magnusim_sdk.study import bc_faces, is_velocity_inlet

    from .writer import _bc_dict, faces_area, inlet_direction, inlet_ref_speed

    rho = float(getattr(spec, "rho", 0) or 0) or 1.2
    props = getattr(spec, "face_props", None) or {}
    best: tuple[float, Vec | None] | None = None
    for m in getattr(spec, "mapped", None) or []:
        raw = m.get("bc") if isinstance(m, dict) else None
        if not raw or not is_velocity_inlet(raw):
            continue
        bc = _bc_dict(raw)
        faces = bc_faces(bc)
        speed = inlet_ref_speed(bc, faces_area(faces, props) / max(1, len(faces)), rho)
        direction = inlet_direction(bc)
        vec: Vec | None = (direction[0], direction[1], direction[2]) if direction else None
        if vec is None:
            acc = [0.0, 0.0, 0.0]
            for f in faces:
                fp = props.get(f)
                n = getattr(fp, "normal", None) if fp is not None else None
                if not n or len(n) != 3:
                    continue
                a = getattr(fp, "area_m2", None) or 1.0
                for i in range(3):
                    acc[i] -= float(n[i]) * float(a)
            vec = _unit((acc[0], acc[1], acc[2]))
        if best is None or speed > best[0]:
            best = (speed, vec)
    if best is not None:
        return best[1]
    return freestream_flow_direction(spec)


def freestream_flow_direction(spec: Any) -> Vec | None:
    """The direction the study's fastest freestream blows (external flow with no
    inlet). None without a freestream or with a zero velocity."""
    from .bc_kinds import is_freestream
    from .writer import _bc_dict, freestream_velocity

    best: tuple[float, Vec] | None = None
    for m in getattr(spec, "mapped", None) or []:
        raw = m.get("bc") if isinstance(m, dict) else None
        if not raw or not is_freestream(raw):
            continue
        v = freestream_velocity(_bc_dict(raw))
        vec = _unit((v[0], v[1], v[2]))
        speed = _norm((v[0], v[1], v[2]))
        if vec is not None and (best is None or speed > best[0]):
            best = (speed, vec)
    return best[1] if best else None


def resolve_reference(spec: Any) -> Reference:
    """The reference values a run measures against: the study's, blanks filled in."""
    raw = getattr(spec, "reference", None) or {}
    notes: list[str] = []
    rho = float(getattr(spec, "rho", 0) or 0) or 1.2

    speed = _num(raw.get("ref_speed"))
    speed_auto = not (speed is not None and speed > 0)
    if speed_auto:
        from .writer import resolve_speed_and_dhyd

        speed = resolve_speed_and_dhyd(spec)[0]
    pressure = _num(raw.get("ref_pressure"))
    area = _num(raw.get("ref_area"))
    length = _num(raw.get("ref_length"))
    cofr = _vec(raw.get("ref_cofr")) or (0.0, 0.0, 0.0)

    drag = _unit(_vec(raw.get("ref_drag_dir")))
    drag_auto = drag is None
    if drag is None:
        drag = inlet_flow_direction(spec) or (1.0, 0.0, 0.0)
    lift_raw = _unit(_vec(raw.get("ref_lift_dir")))
    lift = _orthogonal(lift_raw, drag) if lift_raw is not None else None
    lift_auto = lift is None
    if lift_raw is not None and lift is None:
        notes.append("The lift direction runs along the drag direction: the default lift direction is used.")
    if lift is None:
        lift = default_lift(drag)

    return Reference(
        speed=float(speed or 1.0),
        speed_auto=speed_auto,
        pressure=float(pressure or 0.0),
        rho=rho,
        area=area if area is not None and area > 0 else None,
        length=length if length is not None and length > 0 else None,
        cofr=cofr,
        drag=drag,
        lift=lift,
        drag_auto=drag_auto,
        lift_auto=lift_auto,
        notes=tuple(notes),
    )
