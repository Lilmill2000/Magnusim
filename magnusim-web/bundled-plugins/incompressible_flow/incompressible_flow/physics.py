"""Study physics the solve reads: turbulence model, steady SIMPLE numerics and the starting flow.

The study panel saves these keys on the study's record in ``simulations.json``
(``sim.catalog.set``). ``load_run_spec`` reads them here so the written case
matches what the panel shows. Defaults are the values the web writer used
before these settings were wired, so studies that never touched them solve
exactly as before.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Literal

TurbulenceModel = Literal["laminar", "SpalartAllmaras", "kEpsilon", "realizableKE", "kOmegaSST", "LRR", "SSG"]
# The study panel's order: by the number of equations solved.
TURBULENCE_MODELS: tuple[str, ...] = (
    "laminar",
    "SpalartAllmaras",
    "kEpsilon",
    "realizableKE",
    "kOmegaSST",
    "LRR",
    "SSG",
)
RSM_MODELS: frozenset[str] = frozenset({"LRR", "SSG"})
SA_MODEL = "SpalartAllmaras"
DEFAULT_TURBULENCE = "kOmegaSST"

# The one table of each model's names: the study panel's choice label, and the
# short name the run note shows ("simpleFoam serial — Incompressible / k-epsilon / SIMPLE").
TURBULENCE_CHOICE_LABELS: dict[str, str] = {
    "laminar": "Laminar",
    "SpalartAllmaras": "Spalart-Allmaras (one equation)",
    "kEpsilon": "k-epsilon",
    "realizableKE": "Realizable k-epsilon",
    "kOmegaSST": "k-omega SST",
    "LRR": "LRR (Reynolds stress)",
    "SSG": "SSG (Reynolds stress)",
}
TURBULENCE_SHORT_LABELS: dict[str, str] = {
    "laminar": "Laminar",
    "SpalartAllmaras": "Spalart-Allmaras",
    "kEpsilon": "k-epsilon",
    "realizableKE": "Realizable k-epsilon",
    "kOmegaSST": "k-omega SST",
    "LRR": "LRR",
    "SSG": "SSG",
}

# Fields the case stores divided by density (incompressible solvers solve for
# p/rho): results show them times rho. The writer's sidecar and both analyses
# declare this list. Besides p: the wall shear stress and the time-averaged
# pressure the result function objects write (function_objects.py). Total
# pressure (pTotal) is written in Pa already.
KINEMATIC_FIELDS: tuple[str, ...] = ("p", "wallShearStress", "pMean")

# Display names used by V0.1.0 records ("k-omega SST") and loose spellings.
_ALIASES: dict[str, str] = {
    "laminar": "laminar",
    "kepsilon": "kEpsilon",
    "komegasst": "kOmegaSST",
    "sst": "kOmegaSST",
    "lrr": "LRR",
    "ssg": "SSG",
    "spalartallmaras": "SpalartAllmaras",
    "realizableke": "realizableKE",
    "realizablekepsilon": "realizableKE",
}


def normalize_turbulence(value: Any) -> str | None:
    """Canonical OpenFOAM model name, or None when ``value`` names no known model."""
    key = re.sub(r"[^a-z]", "", str(value or "").lower())
    return _ALIASES.get(key)


def turbulence_fields(model: str) -> tuple[str, ...]:
    """0/ turbulence fields a model reads (U and p are always written)."""
    if model == "laminar":
        return ()
    if model == SA_MODEL:
        return ("nuTilda", "nut")
    if model == "kOmegaSST":
        return ("k", "omega", "nut")
    if model in RSM_MODELS:
        return ("k", "epsilon", "R", "nut")
    return ("k", "epsilon", "nut")


def solved_turbulence_fields(model: str) -> tuple[str, ...]:
    """Transport equations the model solves (for solvers, residuals and relaxation)."""
    if model == SA_MODEL:
        return ("nuTilda",)
    if model == "kOmegaSST":
        return ("k", "omega")
    if model in RSM_MODELS:
        return ("R", "epsilon")
    if model in ("kEpsilon", "realizableKE"):
        return ("k", "epsilon")
    return ()


# Steady numerics presets (writer._steady_fv_schemes_body). Robust is the schemes
# every study solved with before the preset existed; Accurate is second order
# for the turbulence equations too, with lighter gradient limiting.
NUMERICS_PRESETS: tuple[str, ...] = ("robust", "accurate")
NUMERICS_LABELS: tuple[str, ...] = ("Robust", "Accurate")
DEFAULT_NUMERICS = "robust"

# SIMPLEC (SIMPLE with ``consistent yes``): the usual relaxation for it, which
# replaces the study's own Relaxation U and p while it is on.
SIMPLEC_RELAX_U = 0.9
SIMPLEC_RELAX_P = 1.0

# The starting flow (the internal field of 0/U; writer.initial_velocity). Still
# is U = 0, what every study started from before the setting existed.
INITIAL_FLOWS: tuple[str, ...] = ("still", "inlet", "custom")
INITIAL_FLOW_LABELS: tuple[str, ...] = ("Still", "From the inlet", "Custom")
DEFAULT_INITIAL_FLOW = "still"

# "Initialise with potential flow": potentialFoam runs on the written case before
# the solver (a WSL step the run declares in w27-case.json's ``pre_steps``).
# The one switch for all of it: the study panel row (analyses._settings_schema)
# and everything the writer adds for it (StudyPhysics.uses_potential_flow). On:
# the runner runs a core solve's pre_steps (cfddesk.wsl.foam_case.case_pre_steps).
# Turned off, the row is gone and a saved true changes nothing in the case.
POTENTIAL_FLOW_READY = True
# -writephi keeps its flux and -writep its pressure as the solver's start.
POTENTIAL_FLOW_TOOL = "potentialFoam"
POTENTIAL_FLOW_ARGS: tuple[str, ...] = ("-writephi", "-writep")
# Its non-orthogonal corrections: at least this many (the study's when higher).
POTENTIAL_FLOW_MIN_NON_ORTH = 3


def potential_flow_steps() -> list[dict[str, Any]]:
    """The WSL steps of a potential-flow start, as w27-case.json's ``pre_steps`` lists them."""
    return [{"tool": POTENTIAL_FLOW_TOOL, "args": list(POTENTIAL_FLOW_ARGS)}]


@dataclass(frozen=True)
class StudyPhysics:
    turbulence_model: str = DEFAULT_TURBULENCE
    residual_u: float = 1e-4
    residual_p: float = 1e-4
    relax_u: float = 0.7
    relax_p: float = 0.3
    n_non_orthogonal: int = 3
    numerics: str = DEFAULT_NUMERICS
    simplec: bool = False
    initial_flow: str = DEFAULT_INITIAL_FLOW
    # The Custom starting velocity in m/s (the panel shows the unit system's unit).
    initial_u: tuple[float, float, float] = (0.0, 0.0, 0.0)
    potential_flow: bool = False

    def uses_potential_flow(self) -> bool:
        """The case starts from potential flow: the study asks for it and the switch is on."""
        return POTENTIAL_FLOW_READY and self.potential_flow

    def potential_flow_non_orth(self) -> int:
        """potentialFoam's non-orthogonal corrections (potentialFlow dict)."""
        return max(POTENTIAL_FLOW_MIN_NON_ORTH, int(self.n_non_orthogonal))

    def solve_relax_u(self) -> float:
        """Relaxation of the velocity and turbulence equations the steady solve uses."""
        return simplec_relax_u(self.turbulence_model) if self.simplec else self.relax_u

    def solve_relax_p(self) -> float:
        """Relaxation of the pressure field the steady solve uses (1: none)."""
        return SIMPLEC_RELAX_P if self.simplec else self.relax_p


DEFAULT_PHYSICS = StudyPhysics()

# Reynolds-stress models blow up epsilon within a few dozen SIMPLE iterations
# at 0.7 on a cold start; 0.5 keeps them stable (the Study panel shows it).
RSM_RELAX_U = 0.5


def default_relax_u(model: str) -> float:
    """Relaxation U when the study has not set one: lower for Reynolds-stress models."""
    return RSM_RELAX_U if model in RSM_MODELS else DEFAULT_PHYSICS.relax_u


def simplec_relax_u(model: str) -> float:
    """SIMPLEC's relaxation of the velocity and turbulence equations: its own 0.9, but
    never above the model's own (a Reynolds-stress model keeps its 0.5)."""
    return min(SIMPLEC_RELAX_U, RSM_RELAX_U) if model in RSM_MODELS else SIMPLEC_RELAX_U


def _num(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def physics_from_record(rec: dict[str, Any] | None) -> StudyPhysics:
    """Read panel keys from one study record; bad or missing values keep the default."""
    rec = rec if isinstance(rec, dict) else {}
    raw_defaults = rec.get("defaults")
    defaults: dict[str, Any] = raw_defaults if isinstance(raw_defaults, dict) else {}
    model = (
        normalize_turbulence(rec.get("turbulence_model"))
        or normalize_turbulence(rec.get("turbulence_model_key"))
        or normalize_turbulence(defaults.get("turbulence_model"))
        or DEFAULT_TURBULENCE
    )
    d = DEFAULT_PHYSICS

    def positive(key: str, fallback: float) -> float:
        v = _num(rec.get(key))
        return v if v is not None and v > 0 else fallback

    def fraction(key: str, fallback: float) -> float:
        v = _num(rec.get(key))
        return v if v is not None and 0 < v <= 1 else fallback

    n = _num(rec.get("n_non_orthogonal"))
    n_non_orth = int(n) if n is not None and 0 <= n <= 20 else d.n_non_orthogonal
    preset = str(rec.get("numerics_preset") or "").strip().lower()
    start = str(rec.get("initial_flow") or "").strip().lower()

    def component(key: str) -> float:
        v = _num(rec.get(key))
        return v if v is not None else 0.0

    return StudyPhysics(
        turbulence_model=model,
        residual_u=positive("residual_u", d.residual_u),
        residual_p=positive("residual_p", d.residual_p),
        relax_u=fraction("relax_u", default_relax_u(model)),
        relax_p=fraction("relax_p", d.relax_p),
        n_non_orthogonal=n_non_orth,
        numerics=preset if preset in NUMERICS_PRESETS else d.numerics,
        simplec=_flag(rec.get("simplec")),
        initial_flow=start if start in INITIAL_FLOWS else d.initial_flow,
        initial_u=(component("initial_ux"), component("initial_uy"), component("initial_uz")),
        potential_flow=_flag(rec.get("potential_flow")),
    )


def _flag(value: Any) -> bool:
    """A saved on/off setting: True, or the text "true" / "1" an older save may hold."""
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in ("true", "1", "yes", "on")






