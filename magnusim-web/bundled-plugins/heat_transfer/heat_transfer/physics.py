"""The study settings a Heat Transfer solve reads: gravity, the density model,
the operating pressure and reference temperature, the starting temperature,
the turbulence model and the steady numerics.

The study panel saves these keys on the study's record (``simulations.json``);
``physics_from_record`` reads them with their defaults, so a study that never
touched a setting solves with what the panel shows. A saved value the solve
cannot use (an operating pressure of 0, a relaxation of 0, ...) is not replaced
quietly: ``physics_problem`` names it and Start refuses the run.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .materials import FluidProps

# --- Gravity ------------------------------------------------------------------

GRAVITY_CHOICES: tuple[str, ...] = ("off", "-z", "+z", "-y", "+y", "-x", "+x", "custom")
GRAVITY_LABELS: tuple[str, ...] = (
    "Off",
    "−Z (down along Z)",
    "+Z",
    "−Y (down along Y)",
    "+Y",
    "−X",
    "+X",
    "Custom direction",
)
DEFAULT_GRAVITY = "-z"
STANDARD_GRAVITY = 9.80665
_AXES: dict[str, tuple[float, float, float]] = {
    "-z": (0.0, 0.0, -1.0),
    "+z": (0.0, 0.0, 1.0),
    "-y": (0.0, -1.0, 0.0),
    "+y": (0.0, 1.0, 0.0),
    "-x": (-1.0, 0.0, 0.0),
    "+x": (1.0, 0.0, 0.0),
}

# --- Density ------------------------------------------------------------------

DENSITY_MODELS: tuple[str, ...] = ("auto", "perfect_gas", "boussinesq", "constant")
DENSITY_LABELS: tuple[str, ...] = (
    "From the fluid (gas: perfect gas, liquid: Boussinesq)",
    "Incompressible perfect gas",
    "Boussinesq",
    "Constant density",
)
DEFAULT_DENSITY = "auto"
# The OpenFOAM equationOfState of each model.
EQUATION_OF_STATE: dict[str, str] = {
    "perfect_gas": "incompressiblePerfectGas",
    "boussinesq": "Boussinesq",
    "constant": "rhoConst",
}
DENSITY_SHORT: dict[str, str] = {
    "perfect_gas": "incompressible perfect gas",
    "boussinesq": "Boussinesq",
    "constant": "constant density",
}
# Boussinesq holds while β·ΔT stays small; at 1 the density reaches zero (HT0).
BOUSSINESQ_LIMIT = 0.2

# --- Turbulence -----------------------------------------------------------------

TURBULENCE_MODELS: tuple[str, ...] = ("laminar", "kOmegaSST", "kEpsilon", "realizableKE")
TURBULENCE_LABELS: tuple[str, ...] = ("Laminar", "k-omega SST", "k-epsilon", "Realizable k-epsilon")
TURBULENCE_SHORT: dict[str, str] = dict(zip(TURBULENCE_MODELS, TURBULENCE_LABELS, strict=True))
DEFAULT_TURBULENCE = "kOmegaSST"

# --- Numerics -------------------------------------------------------------------

NUMERICS_PRESETS: tuple[str, ...] = ("robust", "accurate")
NUMERICS_LABELS: tuple[str, ...] = ("Robust", "Accurate")
DEFAULT_NUMERICS = "robust"

DEFAULT_OPERATING_PRESSURE = 101325.0
DEFAULT_REFERENCE_T = 293.15


@dataclass(frozen=True)
class StudyPhysics:
    gravity: str = DEFAULT_GRAVITY
    gravity_vector: tuple[float, float, float] = (0.0, 0.0, -1.0)
    gravity_magnitude: float = STANDARD_GRAVITY
    density_model: str = DEFAULT_DENSITY
    operating_pressure: float = DEFAULT_OPERATING_PRESSURE
    reference_temperature: float = DEFAULT_REFERENCE_T
    initial_temperature: float | None = None
    turbulence_model: str = DEFAULT_TURBULENCE
    numerics: str = DEFAULT_NUMERICS
    residual: float = 1e-5
    n_non_orthogonal: int = 1
    # Steady SIMPLE relaxation: velocity (and turbulence), p_rgh, energy. Energy above
    # about 0.5 can stall a through-flow solve with a lasting heat imbalance (a heated
    # pipe: h stalls near a residual of 1e-3 and keeps 1.1 % at 0.9, 0.02 % at 0.5); a closed
    # natural-convection case settles sooner at 0.9.
    relax_u: float = 0.7
    relax_p: float = 0.3
    relax_h: float = 0.5

    @property
    def gravity_on(self) -> bool:
        return self.gravity != "off" and self.gravity_magnitude > 0 and any(self.gravity_vector)

    def g(self) -> tuple[float, float, float]:
        """The gravity vector in m/s² ((0 0 0) when off)."""
        if not self.gravity_on:
            return (0.0, 0.0, 0.0)
        v = self.gravity_vector
        m = math.hypot(*v)
        return (v[0] / m * self.gravity_magnitude, v[1] / m * self.gravity_magnitude, v[2] / m * self.gravity_magnitude)

    def start_temperature(self) -> float:
        return self.initial_temperature if self.initial_temperature is not None else self.reference_temperature

    def density_for(self, fluid: FluidProps | None) -> str:
        """The density model the case uses: the study's, or from the fluid when automatic."""
        if self.density_model in EQUATION_OF_STATE:
            return self.density_model
        if fluid is None or fluid.gas:
            return "perfect_gas"
        return "boussinesq"


DEFAULT_PHYSICS = StudyPhysics()


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _vec(value: Any) -> tuple[float, float, float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return None
    out = [_num(c) for c in value]
    if any(c is None for c in out):
        return None
    return (float(out[0]), float(out[1]), float(out[2]))  # type: ignore[arg-type]


def physics_from_record(rec: dict[str, Any] | None) -> StudyPhysics:
    """The study's settings; a missing or bad value keeps its default."""
    rec = rec if isinstance(rec, dict) else {}
    d = DEFAULT_PHYSICS
    gravity = str(rec.get("gravity") or d.gravity).strip().lower()
    if gravity not in GRAVITY_CHOICES:
        gravity = d.gravity
    if gravity == "custom":
        vector = _vec(rec.get("gravity_vector")) or d.gravity_vector
    else:
        vector = _AXES.get(gravity, (0.0, 0.0, 0.0))
    mag = _num(rec.get("gravity_magnitude"))
    density = str(rec.get("density_model") or d.density_model).strip().lower()
    p_op = _num(rec.get("operating_pressure"))
    t_ref = _num(rec.get("reference_temperature"))
    t0 = _num(rec.get("initial_temperature"))
    model = str(rec.get("turbulence_model") or d.turbulence_model)
    preset = str(rec.get("numerics_preset") or d.numerics).strip().lower()
    residual = _num(rec.get("residual_target"))
    n = _num(rec.get("n_non_orthogonal"))

    def fraction(key: str, fallback: float) -> float:
        v = _num(rec.get(key))
        return v if v is not None and 0 < v <= 1 else fallback

    return StudyPhysics(
        gravity=gravity,
        gravity_vector=vector,
        gravity_magnitude=mag if mag is not None and mag >= 0 else d.gravity_magnitude,
        density_model=density if density in DENSITY_MODELS else d.density_model,
        operating_pressure=p_op if p_op is not None and p_op > 0 else d.operating_pressure,
        reference_temperature=t_ref if t_ref is not None and t_ref > 0 else d.reference_temperature,
        initial_temperature=t0 if t0 is not None and t0 > 0 else None,
        turbulence_model=model if model in TURBULENCE_MODELS else d.turbulence_model,
        numerics=preset if preset in NUMERICS_PRESETS else d.numerics,
        residual=residual if residual is not None and residual > 0 else d.residual,
        n_non_orthogonal=int(n) if n is not None and 0 <= n <= 10 else d.n_non_orthogonal,
        relax_u=fraction("relax_u", d.relax_u),
        relax_p=fraction("relax_p", d.relax_p),
        relax_h=fraction("relax_h", d.relax_h),
    )


# Saved settings that must be above 0 (and, for the relaxations, at most 1): (key, label).
_POSITIVE: tuple[tuple[str, str], ...] = (
    ("operating_pressure", "operating pressure"),
    ("reference_temperature", "reference temperature"),
    ("initial_temperature", "starting temperature"),
    ("residual_target", "residual target"),
)
_FRACTIONS: tuple[tuple[str, str], ...] = (
    ("relax_u", "relaxation U"),
    ("relax_p", "relaxation p_rgh"),
    ("relax_h", "relaxation energy"),
)


def physics_problem(rec: dict[str, Any] | None) -> str | None:
    """A saved study setting the solve cannot use, in the user's words, else None.

    Temperatures and pressures are checked as stored (K, Pa): "above absolute zero".
    """
    rec = rec if isinstance(rec, dict) else {}
    for key, label in _POSITIVE:
        v = _num(rec.get(key))
        if v is not None and v <= 0:
            what = "absolute zero" if key.endswith("temperature") else "0"
            return f"the {label} must be above {what}"
    for key, label in _FRACTIONS:
        v = _num(rec.get(key))
        if v is not None and not 0 < v <= 1:
            return f"the {label} is {v:g}; it must be above 0 and at most 1"
    gravity = str(rec.get("gravity") or DEFAULT_GRAVITY).strip().lower()
    mag = _num(rec.get("gravity_magnitude"))
    if gravity != "off" and mag is not None and mag <= 0:
        return "the gravity magnitude must be above 0 (or set Gravity to Off)"
    if gravity == "custom":
        vec = _vec(rec.get("gravity_vector"))
        if vec is not None and not any(vec):
            return "the gravity direction has no length (all three components are 0)"
    return None


def solved_turbulence_fields(model: str) -> tuple[str, ...]:
    if model == "kOmegaSST":
        return ("k", "omega")
    if model in ("kEpsilon", "realizableKE"):
        return ("k", "epsilon")
    return ()
