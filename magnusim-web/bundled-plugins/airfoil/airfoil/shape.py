"""A section from its dimensions: the NACA four-digit-modified family.

The dimensions are the ones a section is drawn with (fractions of the chord):
maximum thickness and where it is, maximum camber and where it is, the
leading-edge radius, and an open or closed trailing edge. Coordinates are in
Selig order, chord 1, leading edge at (0, 0), cosine-spaced in x, as
:mod:`naca` writes them.

The thickness is the four-digit-modified one (Abbott and von Doenhoff, Theory
of Wing Sections, 1959, section 6.4; Ladson and Brooks, NASA TM X-3284, 1975),
in units where the maximum thickness is 0.2:

* ahead of the maximum thickness, ``a0 sqrt(x) + a1 x + a2 x^2 + a3 x^3``;
* behind it, ``d0 + d1 (1 - x) + d2 (1 - x)^2 + d3 (1 - x)^3``.

``a0`` sets the leading-edge radius (``r = 1.1019 (t I / 6)^2``, ``I`` the
leading-edge index, 6 for the original four-digit sections, so
``a0 = 0.296904 I / 6``); ``d0`` the trailing-edge thickness (0.002, or 0 for
a closed one); ``d1`` the trailing-edge slope, from the published table by the
position of the maximum thickness (interpolated between its rows). ``d2`` and
``d3`` put the maximum at its place with a zero slope; ``a1 … a3`` meet it there
with the same height, slope and curvature. The mean line is the four-digit one.

A section whose dimensions are all whole designation digits is named as the
family names it, e.g. "NACA 2412-63" (leading-edge index 6, maximum thickness
at 30 %); any other by its dimensions, e.g. "Custom t12.0@35 c2.0@40 r1.59".
"""

# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from airfoil.naca import MAX_POINTS_PER_SIDE, MIN_POINTS_PER_SIDE

# The published trailing-edge slopes d1 by the position of the maximum thickness.
_D1 = ((0.2, 0.200), (0.3, 0.234), (0.4, 0.315), (0.5, 0.465), (0.6, 0.700))
# Leading-edge radius per (thickness * I / 6)^2, and a0 per I.
_R_COEF = 1.1019
_A0_PER_INDEX = 0.296904 / 6.0
_D0_OPEN = 0.002

# What the editor accepts (fractions of the chord).
LIMITS = {
    "thickness": (0.01, 0.40, "Maximum thickness", "1 % to 40 % of the chord"),
    "thickness_at": (0.20, 0.60, "Maximum-thickness position", "20 % to 60 % of the chord"),
    "camber": (0.0, 0.095, "Maximum camber", "0 % to 9.5 % of the chord"),
    "camber_at": (0.10, 0.90, "Maximum-camber position", "10 % to 90 % of the chord"),
}
# The leading-edge index I: 0 is a sharp leading edge; above 9 the family is not defined.
MAX_INDEX = 9.0


class ShapeError(ValueError):
    """Dimensions the family cannot make; ``field`` names the one at fault."""

    def __init__(self, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.field = field


@dataclass(frozen=True)
class ShapeSection:
    name: str
    x: list[float]
    y: list[float]


def standard_le_radius(thickness: float) -> float:
    """The leading-edge radius of an original four-digit section of this thickness (index 6)."""
    return _R_COEF * thickness**2


def le_index(thickness: float, le_radius: float) -> float:
    """The leading-edge index I that gives this radius at this thickness."""
    return 6.0 * math.sqrt(max(le_radius, 0.0) / _R_COEF) / thickness


def le_radius_range(thickness: float) -> tuple[float, float]:
    """The radii the family can make at this thickness (a sharp edge up to index 9)."""
    return 0.0, _R_COEF * (thickness * MAX_INDEX / 6.0) ** 2


def _pchip_d1(m: float) -> float:
    """d1 at a maximum-thickness position m, through the table (monotone cubic, Fritsch-Carlson)."""
    xs = [p[0] for p in _D1]
    ys = [p[1] for p in _D1]
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    s = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    d = [0.0] * n
    d[0], d[-1] = s[0], s[-1]
    for i in range(1, n - 1):
        d[i] = 0.0 if s[i - 1] * s[i] <= 0 else 2.0 / (1.0 / s[i - 1] + 1.0 / s[i])
    i = min(max(0, sum(1 for x in xs[1:-1] if m >= x)), n - 2)
    t = (m - xs[i]) / h[i]
    h00 = 2 * t**3 - 3 * t**2 + 1
    h10 = t**3 - 2 * t**2 + t
    h01 = -2 * t**3 + 3 * t**2
    h11 = t**3 - t**2
    return h00 * ys[i] + h10 * h[i] * d[i] + h01 * ys[i + 1] + h11 * h[i] * d[i + 1]


def _solve3(a: list[list[float]], b: list[float]) -> list[float]:
    """A 3x3 linear system by Gaussian elimination with partial pivoting."""
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(3):
        piv = max(range(col, 3), key=lambda r: abs(m[r][col]))
        m[col], m[piv] = m[piv], m[col]
        for r in range(3):
            if r != col:
                f = m[r][col] / m[col][col]
                m[r] = [m[r][k] - f * m[col][k] for k in range(4)]
    return [m[i][3] / m[i][i] for i in range(3)]


@dataclass(frozen=True)
class Thickness:
    """The half-thickness form (in units where the maximum thickness is 0.2)."""

    m: float
    a: tuple[float, float, float, float]
    d: tuple[float, float, float, float]

    def half(self, x: float) -> float:
        if x <= self.m:
            a0, a1, a2, a3 = self.a
            return a0 * math.sqrt(max(x, 0.0)) + a1 * x + a2 * x**2 + a3 * x**3
        d0, d1, d2, d3 = self.d
        u = 1.0 - x
        return d0 + d1 * u + d2 * u**2 + d3 * u**3


def thickness_form(thickness_at: float, index: float, closed_te: bool) -> Thickness:
    """The four-digit-modified thickness for a maximum at ``thickness_at`` and leading-edge index ``index``."""
    m = thickness_at
    u = 1.0 - m
    d0 = 0.0 if closed_te else _D0_OPEN
    d1 = _pchip_d1(m)
    # Behind the maximum: 0.1 at m with a zero slope.
    d3 = -2.0 * (0.1 - d0 - 0.5 * d1 * u) / u**3
    d2 = (-d1 - 3.0 * d3 * u**2) / (2.0 * u)
    curvature_aft = 2.0 * d2 + 6.0 * d3 * u
    # Ahead of it: the same height, a zero slope and the same curvature at m.
    a0 = _A0_PER_INDEX * index
    sm = math.sqrt(m)
    a1, a2, a3 = _solve3(
        [[m, m**2, m**3], [1.0, 2 * m, 3 * m**2], [0.0, 2.0, 6 * m]],
        [0.1 - a0 * sm, -a0 / (2 * sm), curvature_aft + a0 / (4 * m * sm)],
    )
    return Thickness(m=m, a=(a0, a1, a2, a3), d=(d0, d1, d2, d3))


def _camber(c: float, p: float, x: float) -> tuple[float, float]:
    if c == 0.0:
        return 0.0, 0.0
    if x < p:
        return c / p**2 * (2 * p * x - x**2), 2 * c / p**2 * (p - x)
    return c / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * x - x**2), 2 * c / (1 - p) ** 2 * (p - x)


def _whole(v: float, tol: float = 1e-6) -> int | None:
    r = round(v)
    return int(r) if abs(v - r) < tol else None


def designation(dims: dict[str, Any]) -> str | None:
    """'NACA MPTT-IT' when every dimension is a whole designation digit, else None."""
    t = float(dims["thickness"])
    c = float(dims["camber"])
    digits = [
        _whole(c * 100),
        _whole(float(dims["camber_at"]) * 10) if c > 0 else 0,
        _whole(t * 100),
        # The page shows the radius to 0.001 % of chord: the standard one typed as shown is index 6.
        _whole(le_index(t, float(dims["le_radius"])), 0.01),
        _whole(float(dims["thickness_at"]) * 10),
    ]
    whole = [d for d in digits if d is not None]
    if len(whole) != len(digits):
        return None
    mm, pp, tt, ii, mt = whole
    if not (0 <= mm <= 9 and 0 <= pp <= 9 and 1 <= tt <= 99 and 0 <= ii <= 9 and 2 <= mt <= 6):
        return None
    return f"NACA {mm}{pp}{tt:02d}-{ii}{mt}"


def custom_name(dims: dict[str, Any]) -> str:
    """A section off the designation digits, named by its dimensions (% of chord):
    "Custom t12.0@35 c2.0@40 r1.59" (thickness at, camber at, leading-edge radius)."""
    t = float(dims["thickness"]) * 100
    c = float(dims["camber"]) * 100
    camber = f" c{c:.1f}@{float(dims['camber_at']) * 100:.0f}" if c > 0 else " c0"
    return f"Custom t{t:.1f}@{float(dims['thickness_at']) * 100:.0f}{camber} r{float(dims['le_radius']) * 100:.2f}"


def check(dims: dict[str, Any]) -> dict[str, float | bool]:
    """The dimensions, as numbers in range; :class:`ShapeError` names the one that is not."""
    out: dict[str, float | bool] = {}
    for key, (lo, hi, label, words) in LIMITS.items():
        try:
            v = float(dims.get(key))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            raise ShapeError(f"{label} must be a number.", key) from None
        if not math.isfinite(v) or not lo - 1e-12 <= v <= hi + 1e-12:
            raise ShapeError(f"{label} must be {words}.", key)
        out[key] = v
    try:
        r = float(dims.get("le_radius"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise ShapeError("Leading-edge radius must be a number.", "le_radius") from None
    lo, hi = le_radius_range(float(out["thickness"]))
    if not math.isfinite(r) or not lo <= r <= hi + 1e-12:
        raise ShapeError(
            f"Leading-edge radius must be from 0 to {hi * 100:.2f} % of the chord at this thickness "
            f"(the standard radius is {standard_le_radius(float(out['thickness'])) * 100:.2f} %).",
            "le_radius",
        )
    out["le_radius"] = r
    out["closed_te"] = bool(dims.get("closed_te", False))
    return out


def generate(dims: dict[str, Any], points_per_side: int) -> ShapeSection:
    """The section's Selig coordinates (``2 * points_per_side - 1`` points)."""
    d = check(dims)
    n = int(points_per_side)
    if not MIN_POINTS_PER_SIDE <= n <= MAX_POINTS_PER_SIDE:
        raise ShapeError(f"Points per side must be from {MIN_POINTS_PER_SIDE} to {MAX_POINTS_PER_SIDE}.", "points_per_side")
    t = float(d["thickness"])
    form = thickness_form(float(d["thickness_at"]), le_index(t, float(d["le_radius"])), bool(d["closed_te"]))
    c, p = float(d["camber"]), float(d["camber_at"])
    upper: list[tuple[float, float]] = []
    lower: list[tuple[float, float]] = []
    for i in range(n):
        x = 0.5 * (1.0 - math.cos(math.pi * i / (n - 1)))
        yt = t / 0.2 * form.half(x)
        yc, dyc = _camber(c, p, x)
        theta = math.atan(dyc)
        upper.append((x - yt * math.sin(theta), yc + yt * math.cos(theta)))
        lower.append((x + yt * math.sin(theta), yc - yt * math.cos(theta)))
    pts = list(reversed(upper)) + lower[1:]
    clean = lambda v: 0.0 if round(v, 10) == 0 else round(v, 10)  # noqa: E731
    return ShapeSection(
        name=designation(d) or custom_name(d),
        x=[clean(px) for px, _ in pts],
        y=[clean(py) for _, py in pts],
    )
