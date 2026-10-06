"""A boundary's "Turbulence at the inlet" setting, and the k, omega and epsilon it gives.

Velocity inlets, pressure boundaries (where flow comes in), total-pressure inlets
and freestreams carry it. ``Auto`` is the case-wide rule (``writer.k_omega_from_scales``:
5 % intensity, a length scale of 0.07 x the largest inlet's hydraulic diameter);
the other two set the patch's own values from an intensity (in %) and either a
length scale (stored in metres) or a turbulent viscosity ratio (nut / nu).

Spalart-Allmaras solves for one field, nuTilda (the modified turbulent
viscosity), not k and omega. Its ``Auto`` is nuTilda = 3 x the fluid's
viscosity (the usual calm-inflow value for external flow, 3 to 5 x nu). The
viscosity-ratio setting gives nut = ratio x nu (the intensity plays no part);
the length-scale setting gives nut = k / omega from the intensity and the length
scale. nuTilda then follows from nut through the model's damping function
(nut = nuTilda fv1, fv1 = chi^3 / (chi^3 + cv1^3), chi = nuTilda / nu).
"""

from __future__ import annotations

import math
import re
from typing import Any

AUTO = "Auto"
LENGTH = "Intensity and length scale"
RATIO = "Intensity and viscosity ratio"
SPECS: tuple[str, ...] = (AUTO, LENGTH, RATIO)

DEFAULT_INTENSITY_PCT = 5.0
DEFAULT_LENGTH_M = 0.01
DEFAULT_RATIO = 10.0
CMU = 0.09
# Spalart-Allmaras: Auto inflow nuTilda = SA_AUTO_NU_TILDA_RATIO x nu; cv1 of its fv1.
SA_AUTO_NU_TILDA_RATIO = 3.0
SA_CV1 = 7.1


def _key(text: Any) -> str:
    return re.sub(r"[^a-z]", "", str(text or "").lower())


def turbulence_spec(bc: dict | None) -> str:
    """The record's setting as one of SPECS (blank or unknown reads as Auto)."""
    want = _key((bc or {}).get("turbulence_spec"))
    return next((s for s in SPECS if _key(s) == want), AUTO)


def _number(v: Any) -> float | None:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _setting(bc: dict, key: str, default: float) -> float | None:
    """The record's number, its default when it holds none, None when it is not a number."""
    v = bc.get(key)
    if v is None or (isinstance(v, str) and not v.strip()):
        return default
    return _number(v)


def settings_problem(bc: dict | None, model: str | None = None) -> str | None:
    """What is wrong with a non-Auto setting, in the user's words, else None.

    Under Spalart-Allmaras the viscosity-ratio setting has no intensity (the
    panel hides it), so its intensity is not checked.
    """
    d = bc or {}
    spec = turbulence_spec(d)
    if spec == AUTO:
        return None
    i = _setting(d, "turbulence_intensity", DEFAULT_INTENSITY_PCT)
    if not (model == "SpalartAllmaras" and spec == RATIO) and (i is None or not (0 < i <= 100)):
        return "the turbulence intensity must be above 0 % and at most 100 %"
    if spec == LENGTH:
        length = _setting(d, "turbulence_length_scale", DEFAULT_LENGTH_M)
        if length is None or not (length > 0):
            return "the turbulence length scale must be above 0"
    else:
        ratio = _setting(d, "turbulence_viscosity_ratio", DEFAULT_RATIO)
        if ratio is None or not (ratio > 0):
            return "the turbulent viscosity ratio must be above 0"
    return None


def k_omega(intensity: float, speed: float, *, length: float | None = None, ratio: float | None = None, nu: float = 0.0) -> tuple[float, float]:
    """(k, omega) from an intensity (fraction) at ``speed`` and a length scale (m) or a viscosity ratio."""
    u = max(abs(float(speed) or 0.0), 0.1)
    k = 1.5 * (intensity * u) ** 2
    if length is not None:
        return k, math.sqrt(k) / ((CMU**0.25) * max(length, 1e-9))
    nut = max(float(ratio or DEFAULT_RATIO), 1e-9) * max(float(nu), 1e-12)
    return k, k / nut


def nu_tilda_from_nut(nut: float, nu: float) -> float:
    """Spalart-Allmaras's nuTilda whose turbulent viscosity (nuTilda fv1) is ``nut``.

    With chi = nuTilda / nu and r = nut / nu: chi^4 / (chi^3 + cv1^3) = r, one
    root between r and r + cv1 (solved by bisection).
    """
    nu = max(float(nu), 1e-12)
    r = max(float(nut), 0.0) / nu
    if r <= 0:
        return 0.0
    cv1_3 = SA_CV1**3
    lo, hi = r, r + SA_CV1
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if mid**4 / (mid**3 + cv1_3) < r:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi) * nu


def sa_auto_nu_tilda(nu: float) -> float:
    """The Auto inflow nuTilda: 3 x the fluid's kinematic viscosity."""
    return SA_AUTO_NU_TILDA_RATIO * max(float(nu), 0.0)


def patch_scales(bc: dict | None, *, speed: float, nu: float) -> dict[str, Any] | None:
    """The patch's own scales for a non-Auto setting ({spec, I, L or ratio, k, omega, epsilon}), None for Auto.

    A setting the readiness check would refuse falls back to its defaults here
    (the run never starts with one).
    """
    d = bc or {}
    spec = turbulence_spec(d)
    if spec == AUTO:
        return None
    i_pct = _setting(d, "turbulence_intensity", DEFAULT_INTENSITY_PCT)
    if i_pct is None or not (0 < i_pct <= 100):
        i_pct = DEFAULT_INTENSITY_PCT
    out: dict[str, Any] = {"spec": spec, "intensity": i_pct / 100.0, "speed_m_s": max(abs(float(speed) or 0.0), 0.1)}
    if spec == LENGTH:
        length = _setting(d, "turbulence_length_scale", DEFAULT_LENGTH_M)
        if length is None or not (length > 0):
            length = DEFAULT_LENGTH_M
        k, omega = k_omega(out["intensity"], speed, length=length)
        out["length_scale_m"] = length
    else:
        ratio = _setting(d, "turbulence_viscosity_ratio", DEFAULT_RATIO)
        if ratio is None or not (ratio > 0):
            ratio = DEFAULT_RATIO
        k, omega = k_omega(out["intensity"], speed, ratio=ratio, nu=nu)
        out["viscosity_ratio"] = ratio
    out.update(k=k, omega=omega, epsilon=CMU * k * omega)
    return out
