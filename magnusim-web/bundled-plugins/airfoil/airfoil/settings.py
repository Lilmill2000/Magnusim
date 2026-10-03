"""What an Airfoil analysis study stores, its defaults, checks and upgrades.

The study record (``studies/<sid>/study.json``, saved by the workspace through
``ws.study.update``) carries two blocks besides the host's own keys:

``airfoil``
    ``{"source": "naca", "code": "2412", "points_per_side": 81, "closed_te": false}``
    or ``{"source": "dat", "name": "...", "file": "airfoil.dat"}`` (the
    checked coordinates, in Selig order, saved next to the study record).
``conditions``
    ``re``, ``mach``, ``alpha_start``, ``alpha_end``, ``alpha_step`` (degrees),
    ``ncrit``, ``xtr_top``, ``xtr_bottom`` (forced transition, x/c; 1 = free).
``view``
    What the workspace shows, so a reopened study looks as it was left:
    ``engine`` (``"neuralfoil"`` or ``"xfoil"``), ``overlay`` (every engine on
    the plots) and ``cp_alpha`` (the Cp(x) angle, or null). Only the page reads
    it, with defaults for what is missing; :func:`migrate` keeps it as it is.

Results are files beside the record (``results/neuralfoil.json``,
``results/xfoil.json``); see :mod:`airfoil.store`.
"""

from __future__ import annotations

import math
from typing import Any

from airfoil import naca

# SPDX-License-Identifier: GPL-3.0-or-later

SCHEMA_VERSION = 1
MAX_ALPHAS = 181

DEFAULT_AIRFOIL: dict[str, Any] = {
    "source": "naca",
    "code": "2412",
    "points_per_side": naca.DEFAULT_POINTS_PER_SIDE,
    "closed_te": False,
}
DEFAULT_CONDITIONS: dict[str, Any] = {
    "re": 1.0e6,
    "mach": 0.0,
    "alpha_start": -4.0,
    "alpha_end": 10.0,
    "alpha_step": 1.0,
    "ncrit": 9.0,
    "xtr_top": 1.0,
    "xtr_bottom": 1.0,
}

# (key, lowest, highest, label) of every number in ``conditions``.
_LIMITS = (
    ("re", 1.0e3, 1.0e9, "Reynolds number"),
    ("mach", 0.0, 0.7, "Mach number"),
    ("alpha_start", -30.0, 30.0, "First α"),
    ("alpha_end", -30.0, 30.0, "Last α"),
    ("alpha_step", 0.05, 10.0, "α step"),
    ("ncrit", 0.5, 14.0, "Ncrit"),
    ("xtr_top", 0.0, 1.0, "Upper transition x/c"),
    ("xtr_bottom", 0.0, 1.0, "Lower transition x/c"),
)


class SettingsError(ValueError):
    """Settings that cannot be used (the message names the field; ``field`` is its key:
    ``code`` or ``points_per_side`` of the airfoil, or a key of the conditions)."""

    def __init__(self, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.field = field


def _number(value: Any, label: str, field: str | None = None) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise SettingsError(f"{label} must be a number.", field) from None
    if not math.isfinite(v):
        raise SettingsError(f"{label} must be a finite number.", field)
    return v


def normalize_conditions(raw: Any) -> dict[str, float]:
    """The conditions with defaults filled in and every number checked."""
    src = raw if isinstance(raw, dict) else {}
    out: dict[str, float] = {}
    for key, lo, hi, label in _LIMITS:
        v = _number(src.get(key, DEFAULT_CONDITIONS[key]), label, key)
        if not lo <= v <= hi:
            raise SettingsError(f"{label} must be from {lo:g} to {hi:g}.", key)
        out[key] = v
    if out["alpha_end"] < out["alpha_start"]:
        raise SettingsError("The last α must not be below the first.", "alpha_end")
    if len(alpha_list(out)) > MAX_ALPHAS:
        raise SettingsError(f"At most {MAX_ALPHAS} angles: use a larger α step or a shorter range.", "alpha_step")
    return out


def normalize_airfoil(raw: Any) -> dict[str, Any]:
    """The airfoil block, checked; a NACA code is stored as its digits."""
    src = raw if isinstance(raw, dict) else {}
    source = str(src.get("source") or "naca")
    if source == "naca":
        try:
            code = naca.parse_code(str(src.get("code", DEFAULT_AIRFOIL["code"])))
        except naca.NacaError as exc:
            raise SettingsError(str(exc), "code") from None
        pps = int(_number(src.get("points_per_side", DEFAULT_AIRFOIL["points_per_side"]), "Points per side", "points_per_side"))
        if not naca.MIN_POINTS_PER_SIDE <= pps <= naca.MAX_POINTS_PER_SIDE:
            raise SettingsError(
                f"Points per side must be from {naca.MIN_POINTS_PER_SIDE} to {naca.MAX_POINTS_PER_SIDE}.", "points_per_side"
            )
        return {"source": "naca", "code": code, "points_per_side": pps, "closed_te": bool(src.get("closed_te", False))}
    if source == "dat":
        name = str(src.get("name") or "").strip()[:80] or "Imported airfoil"
        return {"source": "dat", "name": name, "file": "airfoil.dat"}
    raise SettingsError(f"Unknown airfoil source {source!r}: use a NACA designation or import a .dat file.")


def alpha_list(conditions: dict[str, float]) -> list[float]:
    """Every α from the first to the last in steps (the last one included when it lands on a step).

    Each α has at most 3 decimals: XFOIL writes α back with 3, so an angle with
    more would not match its own polar row. The step is at least 0.05°, so no
    two angles round to the same value.
    """
    a0, a1, step = conditions["alpha_start"], conditions["alpha_end"], conditions["alpha_step"]
    count = int(math.floor((a1 - a0) / step + 1e-9)) + 1
    return [round(a0 + i * step, 3) for i in range(max(count, 1))]


def defaults() -> dict[str, Any]:
    return {"airfoil": dict(DEFAULT_AIRFOIL), "conditions": dict(DEFAULT_CONDITIONS)}


def from_study(study: dict[str, Any]) -> dict[str, Any]:
    """A study's settings, defaults filled in (a new study has none yet)."""
    return {
        "airfoil": normalize_airfoil(study.get("airfoil") or DEFAULT_AIRFOIL),
        "conditions": normalize_conditions(study.get("conditions") or DEFAULT_CONDITIONS),
    }


def migrate(study: dict[str, Any], from_version: int, to_version: int) -> dict[str, Any]:
    """Upgrade a study record saved with an older ``schema_version`` (the host's ``migrate_study``).

    Version 0 is a study written before the kind had a schema version: it may
    lack either block, or carry the airfoil as a bare designation
    (``"airfoil": "2412"``). Values that do not pass today's checks fall back to
    the defaults, so an old study always opens; keys this version does not know
    are kept as they were.
    """
    if to_version != SCHEMA_VERSION:
        raise SettingsError(f"This plugin writes schema version {SCHEMA_VERSION}, not {to_version}.")
    if from_version > SCHEMA_VERSION:
        raise SettingsError(f"Schema version {from_version} is newer than this plugin's ({SCHEMA_VERSION}).")
    out = dict(study)
    airfoil = out.get("airfoil")
    if isinstance(airfoil, str):
        airfoil = {"source": "naca", "code": airfoil}
    try:
        out["airfoil"] = normalize_airfoil(airfoil if isinstance(airfoil, dict) else DEFAULT_AIRFOIL)
    except SettingsError:
        out["airfoil"] = dict(DEFAULT_AIRFOIL)
    raw_conditions = out.get("conditions")
    conditions: dict[str, Any] = raw_conditions if isinstance(raw_conditions, dict) else {}
    try:
        out["conditions"] = normalize_conditions(conditions)
    except SettingsError:
        merged = dict(DEFAULT_CONDITIONS)
        for key, lo, hi, _label in _LIMITS:
            try:
                v = float(conditions.get(key, merged[key]))
            except (TypeError, ValueError):
                continue
            if math.isfinite(v) and lo <= v <= hi:
                merged[key] = v
        try:
            out["conditions"] = normalize_conditions(merged)
        except SettingsError:
            out["conditions"] = dict(DEFAULT_CONDITIONS)
    return out
