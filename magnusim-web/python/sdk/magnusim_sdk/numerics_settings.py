"""Numerics as settings (run health, RH3): what Incompressible Flow and Heat Transfer share
of a study's schemes, linear solvers, turbulence relaxation and velocity limit, and of a
run's PIMPLE outer relaxation and outer tolerance.

- **The choices** and the fixed OpenFOAM string each one is written as (``GRAD_LIMITERS``,
  ``CONVECTION``, ``MOMENTUM``, ``NON_ORTH``). Steady runs write the convection schemes
  ``bounded``.
- **Defaults are today's values.** A key left blank (not stored, or None) is written as
  before RH3: from the Numerics preset (``PRESET_CHOICES``), from a transient study's own
  schemes when it has no preset (``NO_PRESET_TRANSIENT``), or the analysis's own default.
- **Bounds apply only to an edit.** A stored value outside its field's range is used as
  saved (:func:`numerics_from_record` keeps every value the solver can use), never refused
  at Start or Continue; :func:`out_of_range` lists it for the pre-run check's
  ``setting_out_of_range`` row.
- **"Numerics as written"**: each analysis builds its rows with :func:`row` (the Run panel's
  ``[data-run-numerics]`` and the Assistant's ``read_setup numerics`` show them).

Standard library only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .numerics_advice import description

# ---------------------------------------------------------------------------
# The choices and their OpenFOAM strings
# ---------------------------------------------------------------------------

GRAD_LIMITERS: dict[str, str] = {
    "strong": "cellLimited Gauss linear 1",
    "light": "cellMDLimited Gauss linear 0.5",
    "none": "Gauss linear",
}
GRAD_LIMITER_LABELS: tuple[str, ...] = ("Strong (cellLimited 1)", "Light (cellMDLimited 0.5)", "None")

CONVECTION: dict[str, str] = {
    "first_order": "Gauss upwind",
    "second_order": "Gauss limitedLinear 1",
}
CONVECTION_LABELS: tuple[str, ...] = ("First order (upwind)", "Second order (limitedLinear)")

MOMENTUM: dict[str, str] = {
    "first_order": "Gauss upwind",
    "second_order": "Gauss linearUpwind grad(U)",
    "second_order_limited": "Gauss limitedLinearV 1",
}
MOMENTUM_LABELS: tuple[str, ...] = (
    "First order (upwind)",
    "Second order (linearUpwind)",
    "Second order, limited (limitedLinearV)",
)

# (laplacianSchemes default, snGradSchemes default)
NON_ORTH: dict[str, tuple[str, str]] = {
    "full": ("Gauss linear corrected", "corrected"),
    "limited_05": ("Gauss linear limited corrected 0.5", "limited corrected 0.5"),
    "limited_033": ("Gauss linear limited corrected 0.33", "limited corrected 0.33"),
    "none": ("Gauss linear uncorrected", "uncorrected"),
}
NON_ORTH_LABELS: tuple[str, ...] = ("Full (corrected)", "Limited 0.5", "Limited 0.33", "None (uncorrected)")

VELOCITY_LIMITS: tuple[str, ...] = ("auto", "custom", "off")
VELOCITY_LIMIT_LABELS: tuple[str, ...] = ("Automatic", "Custom", "Off")

SCHEME_KEYS: tuple[str, ...] = (
    "grad_limiter",
    "momentum_convection",
    "turbulence_convection",
    "energy_convection",
    "non_orth_correction",
)

# Each Numerics preset as these choices (the schemes the steady writers have always used).
PRESET_CHOICES: dict[str, dict[str, str]] = {
    "robust": {
        "grad_limiter": "strong",
        "momentum_convection": "second_order",
        "turbulence_convection": "first_order",
        "energy_convection": "second_order",
        "non_orth_correction": "limited_05",
    },
    "accurate": {
        "grad_limiter": "light",
        "momentum_convection": "second_order",
        "turbulence_convection": "second_order",
        "energy_convection": "second_order",
        "non_orth_correction": "full",
    },
}
PRESET_LABELS: dict[str, str] = {"robust": "Robust", "accurate": "Accurate"}
# A transient Incompressible Flow study has no preset: the schemes its writer has always used.
NO_PRESET_TRANSIENT: dict[str, str] = {
    "grad_limiter": "strong",
    "momentum_convection": "second_order",
    "turbulence_convection": "second_order",
    "energy_convection": "second_order",
    "non_orth_correction": "limited_05",
}

# The cautions (critique 18): shown under the field and raising the Assistant's card.
CAUTION_FIRST_ORDER = (
    "First-order schemes are more stable but less accurate. Fix the time step or the mesh first; "
    "use first order only to get a run started."
)
CAUTION_LIMIT_OFF = (
    "Nothing caps the velocity. An unstable run stops with an error instead of running on with "
    "clipped cells. Fix the cause (the time step or the mesh)."
)

# The bounds an edit is held to: (min, max); None = none. Relaxation is above 0 (0 is the
# lower bound shown), the others as written.
BOUNDS: dict[str, tuple[float | None, float | None]] = {
    "p_tolerance": (1e-12, 1e-3),
    "p_rel_tol": (0.0, 0.5),
    "p_max_iter": (10, 2000),
    "eq_tolerance": (1e-14, 1e-3),
    "eq_rel_tol": (0.0, 0.5),
    "eq_max_iter": (5, 1000),
    "relax_turbulence": (0.0, 1.0),
    "velocity_limit_max": (0.0, None),
    "outer_relax_p": (0.0, 1.0),
    "outer_relax_eq": (0.0, 1.0),
    "outer_tolerance": (1e-6, 0.1),
}

# Today's linear solver settings (both writers).
P_TOLERANCE = 1e-7
P_REL_TOL = 0.01
P_MAX_ITER = 200
EQ_TOLERANCE = 1e-8
EQ_REL_TOL = 0.1

RUN_KEYS: tuple[str, ...] = ("outer_relax_p", "outer_relax_eq", "outer_tolerance")
STUDY_KEYS: tuple[str, ...] = (
    *SCHEME_KEYS,
    "p_tolerance",
    "p_rel_tol",
    "p_max_iter",
    "eq_tolerance",
    "eq_rel_tol",
    "eq_max_iter",
    "relax_turbulence",
    "velocity_limit",
    "velocity_limit_max",
)

# The Run panel's and the study panel's sub-heads ("Advanced settings").
GROUP_SCHEMES = "schemes"
GROUP_SOLVERS = "linear_solvers"
GROUP_LIMITERS = "limiters"


# ---------------------------------------------------------------------------
# The stored values
# ---------------------------------------------------------------------------


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def positive(v: Any) -> float | None:
    """A stored number the solver can use that must be above 0 (a tolerance, a relaxation, a
    limit), as saved even outside its field's range; else None (blank)."""
    n = _num(v)
    return n if n is not None and n > 0 else None


def non_negative(v: Any) -> float | None:
    """A stored number the solver can use that may be 0 (a relative tolerance), as saved."""
    n = _num(v)
    return n if n is not None and n >= 0 else None


def count(v: Any) -> int | None:
    """A stored iteration count of at least 1, as saved."""
    n = _num(v)
    return int(round(n)) if n is not None and n >= 1 else None


def choice(v: Any, table: dict[str, Any] | tuple[str, ...]) -> str | None:
    s = str(v or "").strip()
    return s if s in table else None


@dataclass(frozen=True)
class NumericsSettings:
    """A study's RH3 numerics as stored: None = blank (as today)."""

    grad_limiter: str | None = None
    momentum_convection: str | None = None
    turbulence_convection: str | None = None
    energy_convection: str | None = None
    non_orth_correction: str | None = None
    p_tolerance: float | None = None
    p_rel_tol: float | None = None
    p_max_iter: int | None = None
    eq_tolerance: float | None = None
    eq_rel_tol: float | None = None
    eq_max_iter: int | None = None
    relax_turbulence: float | None = None
    velocity_limit: str | None = None
    velocity_limit_max: float | None = None


BLANK = NumericsSettings()


def numerics_from_record(rec: dict[str, Any] | None) -> NumericsSettings:
    """The study record's RH3 numerics: each value the solver can use is kept as saved (even
    outside its field's range); a missing or unusable one is blank."""
    r = rec if isinstance(rec, dict) else {}
    return NumericsSettings(
        grad_limiter=choice(r.get("grad_limiter"), GRAD_LIMITERS),
        momentum_convection=choice(r.get("momentum_convection"), MOMENTUM),
        turbulence_convection=choice(r.get("turbulence_convection"), CONVECTION),
        energy_convection=choice(r.get("energy_convection"), CONVECTION),
        non_orth_correction=choice(r.get("non_orth_correction"), NON_ORTH),
        p_tolerance=positive(r.get("p_tolerance")),
        p_rel_tol=non_negative(r.get("p_rel_tol")),
        p_max_iter=count(r.get("p_max_iter")),
        eq_tolerance=positive(r.get("eq_tolerance")),
        eq_rel_tol=non_negative(r.get("eq_rel_tol")),
        eq_max_iter=count(r.get("eq_max_iter")),
        relax_turbulence=positive(r.get("relax_turbulence")),
        velocity_limit=choice(r.get("velocity_limit"), VELOCITY_LIMITS),
        velocity_limit_max=positive(r.get("velocity_limit_max")),
    )


def run_value(key: str, v: Any) -> float | None:
    """A run's outer relaxation or outer tolerance as stored (None = blank)."""
    return positive(v) if key in RUN_KEYS else None


def clamp_edit(key: str, v: float | None) -> float | None:
    """An edited run key held to its bounds (an edit only: a stored value is never clamped)."""
    if v is None:
        return None
    lo, hi = BOUNDS[key]
    if lo is not None and v < lo:
        v = lo
    if hi is not None and v > hi:
        v = hi
    return v if v > 0 else None


# ---------------------------------------------------------------------------
# What is written
# ---------------------------------------------------------------------------


def foam_number(x: float) -> str:
    """A setting as the case writes it: 1e-7, 0.01, 0.7, 200."""
    x = float(x)
    if x != 0 and abs(x) < 1e-3:
        mant, exp = f"{x:.6e}".split("e")
        mant = mant.rstrip("0").rstrip(".")
        return f"{mant}e{int(exp)}"
    return f"{x:g}"


def scheme_choices(ns: NumericsSettings, *, preset: str | None) -> dict[str, tuple[str, str]]:
    """Each scheme key's choice and where it came from: ``(choice, "study" | "preset" |
    "default")``. ``preset`` None: a transient study without one (NO_PRESET_TRANSIENT)."""
    base = PRESET_CHOICES.get(preset or "") if preset else None
    out: dict[str, tuple[str, str]] = {}
    for key in SCHEME_KEYS:
        stored = getattr(ns, key)
        if stored:
            out[key] = (stored, "study")
        elif base is not None:
            out[key] = (base[key], "preset")
        else:
            out[key] = (NO_PRESET_TRANSIENT[key], "default")
    return out


def bounded(text: str, steady: bool) -> str:
    return ("bounded " + text) if steady else text


def changed_from_preset(rec: dict[str, Any] | None, preset: str) -> list[str]:
    """The scheme keys the study sets to something other than its preset's (the preset note:
    "Robust, 2 terms changed")."""
    ns = numerics_from_record(rec)
    base = PRESET_CHOICES.get(preset) or PRESET_CHOICES["robust"]
    return [k for k in SCHEME_KEYS if getattr(ns, k) and getattr(ns, k) != base[k]]


def velocity_cap(ns: NumericsSettings, speed_ref: float, *, default: str, factor: float, floor: float) -> dict[str, Any]:
    """The velocity limit a case is written with: ``{mode, cap (m/s or None), auto, custom_blank}``.
    Custom with no maximum set is written as Automatic (and says so)."""
    mode = ns.velocity_limit or default
    auto = max(float(floor), float(factor) * abs(float(speed_ref)))
    if mode == "off":
        return {"mode": "off", "cap": None, "auto": auto, "custom_blank": False}
    if mode == "custom" and ns.velocity_limit_max:
        return {"mode": "custom", "cap": float(ns.velocity_limit_max), "auto": auto, "custom_blank": False}
    return {"mode": "auto", "cap": auto, "auto": auto, "custom_blank": mode == "custom"}


def limit_u_text(number: str) -> str:
    """system/fvOptions with the limitVelocity cap (``number``: the cap as the writer prints it)."""
    return f"""limitU
{{
    type            limitVelocity;
    active          yes;
    selectionMode   all;
    max             {number};
}}"""


# ---------------------------------------------------------------------------
# "Numerics as written"
# ---------------------------------------------------------------------------


def fmt3(x: float | None) -> str:
    """A speed or a factor: 3 significant figures ("226", "22.6", "0.5")."""
    if x is None or not math.isfinite(x):
        return "?"
    if x == 0:
        return "0"
    digits = 2 - int(math.floor(math.log10(abs(x))))
    r = round(x, digits)
    if digits <= 0:
        return f"{int(round(r))}"
    s = f"{r:.{digits}f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


def row(group: str, label: str, value: str, source: str = "") -> dict[str, str]:
    """One "Numerics as written" row. ``source``: study, preset, default, run, fixed or ''."""
    return {"group": group, "label": label, "value": value, "source": source}


SOURCE_WORDS = {"study": "set in the study", "run": "set on the run", "default": "default", "fixed": "fixed"}


def source_words(source: str, preset: str | None = None) -> str:
    if source == "preset":
        return f"{PRESET_LABELS.get(preset or '', 'the')} preset"
    return SOURCE_WORDS.get(source, "")


def limit_value(
    v: dict[str, Any],
    *,
    speed: float | None,
    factor: float,
    floor: float,
    inlet: str = "",
    unknown: str = "the speed is known once the mesh is generated",
) -> str:
    """The velocity limit as "Numerics as written" says it: "226 m/s = 10 × 22.6 m/s (inlet
    velocity_inlet_1_1)", "50 m/s (at least 50 m/s; 10 × 1.2 m/s is less)", "Off". ``unknown``:
    why there is no speed yet (``speed`` None)."""
    if v["mode"] == "off":
        return "Off: nothing caps the velocity"
    if v["mode"] == "custom":
        return f"{fmt3(v['cap'])} m/s (custom)"
    lead = "Custom with no maximum set, so automatic: " if v.get("custom_blank") else ""
    if speed is None:
        return f"{lead}{fmt3(factor)} × the reference speed, at least {fmt3(floor)} m/s ({unknown})"
    where = f" (inlet {inlet})" if inlet else ""
    if factor * abs(speed) >= floor:
        return f"{lead}{fmt3(v['cap'])} m/s = {fmt3(factor)} × {fmt3(speed)} m/s{where}"
    return f"{lead}{fmt3(v['cap'])} m/s (at least {fmt3(floor)} m/s; {fmt3(factor)} × {fmt3(speed)} m/s{where} is less)"


def solver_value(name: str, tol: float, rel_tol: float, max_iter: int | None, *, default_max: str = "") -> str:
    """"GAMG, tolerance 1e-7, relTol 0.01, maxIter 200"."""
    bits = [name, f"tolerance {foam_number(tol)}", f"relTol {foam_number(rel_tol)}"]
    if max_iter is not None:
        bits.append(f"maxIter {int(max_iter)}")
    elif default_max:
        bits.append(default_max)
    return ", ".join(bits)


# ---------------------------------------------------------------------------
# Stored values outside their field's range (setting_out_of_range)
# ---------------------------------------------------------------------------


def range_number(x: float, small: bool) -> str:
    """A bound or a value as the row says it: 1e-2 for a tolerance's range, else 0.5, 2000."""
    if small and x != 0:
        mant, exp = f"{float(x):.6e}".split("e")
        mant = mant.rstrip("0").rstrip(".")
        return f"{mant}e{int(exp)}"
    return f"{float(x):g}"


def lower_label(label: str) -> str:
    """A label inside a sentence: "Relaxation turbulence" → "relaxation turbulence"; "p tolerance" stays."""
    if len(label) > 1 and label[0].isupper() and label[1].islower():
        return label[0].lower() + label[1:]
    return label


def out_of_range(fields: list[dict[str, Any]], values: dict[str, Any]) -> list[dict[str, Any]]:
    """The stored values outside their field's range that the solver uses as saved:
    ``fields`` are ``{key, label, min, max, kind}`` (a schema's), ``values`` the stored ones.
    Each answer is ``{key, label, value, min, max, text}``: "Saved p tolerance 1e-2 is
    outside 1e-12 to 1e-3."."""
    out: list[dict[str, Any]] = []
    for f in fields:
        key = str(f.get("key") or "")
        lo = f.get("min")
        hi = f.get("max")
        if lo is None and hi is None:
            continue
        v = _num(values.get(key)) if isinstance(values, dict) else None
        if v is None:
            continue
        below = lo is not None and v < float(lo)
        above = hi is not None and v > float(hi)
        if not (below or above):
            continue
        small = lo is not None and 0 < float(lo) < 1e-3
        label = str(f.get("label") or key)
        if lo is not None and hi is not None:
            span = f"outside {range_number(float(lo), small)} to {range_number(float(hi), small)}"
        elif lo is not None:
            span = f"below {range_number(float(lo), small)}"
        else:
            span = f"above {range_number(float(hi), small)}"  # type: ignore[arg-type]
        shown = range_number(v, small)
        out.append(
            {
                "key": key,
                "label": label,
                "value": v,
                "min": lo,
                "max": hi,
                "text": f"Saved {lower_label(label)} {shown} is {span}.",
                "short": f"{label} {shown}",
            }
        )
    return out


# ---------------------------------------------------------------------------
# The schema fields (each analysis makes its SchemaFields from these)
# ---------------------------------------------------------------------------


def study_field_specs(
    *,
    transient: bool,
    energy: bool,
    simplec: bool,
    p_name: str,
    eq_max_iter_default: int | None,
    velocity_limit_default: str,
    extra: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """The RH3 study fields as SchemaField keyword arguments (numerics_schema, advanced).
    ``energy``: an energy equation (Heat Transfer); ``simplec``: Relaxation turbulence is unused
    while SIMPLEC is on; ``p_name``: the pressure field's name (p or p_rgh); ``extra``: words an
    analysis adds after a key's advice (its defaults)."""
    more = extra or {}

    def d(key: str) -> str:
        return description(key, more.get(key, ""))

    def solver(key: str, label: str, kind: str, default: Any, *, optional: bool = False) -> dict[str, Any]:
        lo, hi = BOUNDS[key]
        return {
            "key": key,
            "label": label,
            "kind": kind,
            "default": default,
            "min": lo,
            "max": hi,
            "group": GROUP_SOLVERS,
            "advanced": True,
            "optional": optional,
            "description": d(key),
        }

    out: list[dict[str, Any]] = [
        {
            "key": "grad_limiter",
            "label": "Gradient limiter",
            "kind": "choice",
            "choices": tuple(GRAD_LIMITERS),
            "choice_labels": GRAD_LIMITER_LABELS,
            "group": GROUP_SCHEMES,
            "advanced": True,
            "optional": True,
            "description": d("grad_limiter"),
        },
        {
            "key": "momentum_convection",
            "label": "Momentum convection",
            "kind": "choice",
            "default": "second_order",
            "choices": tuple(MOMENTUM),
            "choice_labels": MOMENTUM_LABELS,
            "group": GROUP_SCHEMES,
            "advanced": True,
            "caution": {"first_order": CAUTION_FIRST_ORDER},
            "description": d("momentum_convection"),
        },
        {
            "key": "turbulence_convection",
            "label": "Turbulence convection",
            "kind": "choice",
            "choices": tuple(CONVECTION),
            "choice_labels": CONVECTION_LABELS,
            "group": GROUP_SCHEMES,
            "advanced": True,
            "optional": True,
            "caution": {"first_order": CAUTION_FIRST_ORDER},
            "description": d("turbulence_convection"),
        },
    ]
    if energy:
        out.append(
            {
                "key": "energy_convection",
                "label": "Energy convection",
                "kind": "choice",
                "default": "second_order",
                "choices": tuple(CONVECTION),
                "choice_labels": CONVECTION_LABELS,
                "group": GROUP_SCHEMES,
                "advanced": True,
                "caution": {"first_order": CAUTION_FIRST_ORDER},
                "description": d("energy_convection"),
            }
        )
    out.append(
        {
            "key": "non_orth_correction",
            "label": "Non-orthogonal correction",
            "kind": "choice",
            "choices": tuple(NON_ORTH),
            "choice_labels": NON_ORTH_LABELS,
            "group": GROUP_SCHEMES,
            "advanced": True,
            "optional": True,
            "description": d("non_orth_correction"),
        }
    )
    out += [
        solver("p_tolerance", f"{p_name} tolerance", "float", P_TOLERANCE),
        solver("p_rel_tol", f"{p_name} relative tolerance", "float", P_REL_TOL),
        solver("p_max_iter", f"{p_name} max iterations", "int", P_MAX_ITER),
        solver("eq_tolerance", "Equations tolerance", "float", EQ_TOLERANCE),
        solver("eq_rel_tol", "Equations relative tolerance", "float", EQ_REL_TOL),
        solver("eq_max_iter", "Equations max iterations", "int", eq_max_iter_default, optional=eq_max_iter_default is None),
    ]
    if not transient:
        lo, hi = BOUNDS["relax_turbulence"]
        out.append(
            {
                "key": "relax_turbulence",
                "label": "Relaxation turbulence",
                "kind": "float",
                "min": lo,
                "max": hi,
                "group": "relaxation",
                "advanced": True,
                "optional": True,
                **({"depends_on": {"simplec": False}} if simplec else {}),
                "description": d("relax_turbulence"),
            }
        )
    out += [
        {
            "key": "velocity_limit",
            "label": "Velocity limit",
            "kind": "choice",
            "default": velocity_limit_default,
            "choices": VELOCITY_LIMITS,
            "choice_labels": VELOCITY_LIMIT_LABELS,
            "group": GROUP_LIMITERS,
            "advanced": True,
            "caution": {"off": CAUTION_LIMIT_OFF},
            "description": d("velocity_limit"),
        },
        {
            "key": "velocity_limit_max",
            "label": "Velocity limit maximum",
            "kind": "float",
            "min": BOUNDS["velocity_limit_max"][0],
            "unit": "",
            "quantity": "velocity",
            "group": GROUP_LIMITERS,
            "advanced": True,
            "optional": True,
            "depends_on": {"velocity_limit": "custom"},
            "description": d("velocity_limit_max"),
        },
    ]
    return out


def run_field_specs(*, p_name: str, extra: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """The RH3 run fields as SchemaField keyword arguments (control_schema, advanced)."""
    more = extra or {}
    out: list[dict[str, Any]] = []
    for key, label in (
        ("outer_relax_p", f"Outer relaxation {p_name}"),
        ("outer_relax_eq", "Outer relaxation equations"),
        ("outer_tolerance", "Outer tolerance"),
    ):
        lo, hi = BOUNDS[key]
        out.append(
            {
                "key": key,
                "label": label,
                "kind": "float",
                "default": None,
                "min": lo,
                "max": hi,
                "group": "control",
                "advanced": True,
                "optional": True,
                "description": description(key, more.get(key, "")),
            }
        )
    return out


def bounds_of(fields: Any) -> list[dict[str, Any]]:
    """``{key, label, min, max}`` of SchemaField-like objects (for :func:`out_of_range`)."""
    out: list[dict[str, Any]] = []
    for f in fields or ():
        out.append({"key": getattr(f, "key", ""), "label": getattr(f, "label", ""), "min": getattr(f, "min", None), "max": getattr(f, "max", None)})
    return out
