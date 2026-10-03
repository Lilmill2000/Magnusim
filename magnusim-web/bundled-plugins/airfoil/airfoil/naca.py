"""NACA 4- and 5-digit sections as Selig coordinates.

Coordinates run from the upper trailing edge over the upper surface to the
leading edge and back along the lower surface (Selig order), chord 1, leading
edge at (0, 0). Points are cosine-spaced in x, so the leading edge is fine.

4-digit "MPTT": maximum camber M % of chord at P/10 of chord, thickness TT %.
5-digit "LPQTT": design lift coefficient 3L/20, maximum camber at P/20 of
chord, Q = 0 a standard mean line and Q = 1 a reflexed one, thickness TT %.
The mean-line constants are the published ones (Abbott and von Doenhoff,
Theory of Wing Sections, 1959, section 6.6).

The thickness form is the standard one, with a finite trailing edge
(-0.1015 x^4); ``closed_te`` uses -0.1036, which closes it.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

# SPDX-License-Identifier: GPL-3.0-or-later

# Standard 5-digit mean lines (Q = 0): P -> (r, k1).
_FIVE_STANDARD = {
    1: (0.0580, 361.400),
    2: (0.1260, 51.640),
    3: (0.2025, 15.957),
    4: (0.2900, 6.643),
    5: (0.3910, 3.230),
}
# Reflexed 5-digit mean lines (Q = 1): P -> (r, k1, k2/k1).
_FIVE_REFLEX = {
    2: (0.1300, 51.990, 0.000764),
    3: (0.2170, 15.793, 0.00677),
    4: (0.3180, 6.520, 0.0303),
    5: (0.4410, 3.191, 0.1355),
}

MIN_POINTS_PER_SIDE = 20
MAX_POINTS_PER_SIDE = 250
DEFAULT_POINTS_PER_SIDE = 81  # 161 points in all, about what XFOIL panels with


class NacaError(ValueError):
    """A designation or option this generator cannot make (the message says why)."""


@dataclass(frozen=True)
class NacaSection:
    code: str
    name: str
    x: list[float]
    y: list[float]


_CODE = re.compile(r"^\s*(?:naca\s*)?(\d{4,5})\s*$", re.IGNORECASE)


def parse_code(text: str) -> str:
    """The 4 or 5 digits of a designation such as "2412", "NACA 23012" or "naca0012"."""
    m = _CODE.match(str(text or ""))
    if not m:
        raise NacaError("Enter a NACA 4-digit or 5-digit designation, such as 2412 or 23012.")
    code = m.group(1)
    if len(code) == 4:
        _check_four(code)
    else:
        _check_five(code)
    return code


def _check_four(code: str) -> None:
    m, p, t = int(code[0]), int(code[1]), int(code[2:])
    if t <= 0:
        raise NacaError(f"NACA {code}: the thickness (last two digits) must be above 0.")
    if (m == 0) != (p == 0):
        raise NacaError(f"NACA {code}: camber and its position must both be 0 or both be above 0.")


def _check_five(code: str) -> None:
    lift, pos, reflex, t = int(code[0]), int(code[1]), int(code[2]), int(code[3:])
    if t <= 0:
        raise NacaError(f"NACA {code}: the thickness (last two digits) must be above 0.")
    if lift == 0:
        raise NacaError(f"NACA {code}: the first digit (design lift) must be above 0.")
    if reflex not in (0, 1):
        raise NacaError(f"NACA {code}: the third digit must be 0 (standard) or 1 (reflexed).")
    table = _FIVE_REFLEX if reflex else _FIVE_STANDARD
    if pos not in table:
        allowed = ", ".join(str(k) for k in sorted(table))
        kind = "reflexed" if reflex else "standard"
        raise NacaError(f"NACA {code}: a {kind} 5-digit mean line has its second digit in {allowed}.")


def _thickness(x: float, t: float, closed_te: bool) -> float:
    a4 = -0.1036 if closed_te else -0.1015
    return 5.0 * t * (0.2969 * math.sqrt(x) - 0.1260 * x - 0.3516 * x**2 + 0.2843 * x**3 + a4 * x**4)


def _camber_four(code: str, x: float) -> tuple[float, float]:
    m = int(code[0]) / 100.0
    p = int(code[1]) / 10.0
    if m == 0.0:
        return 0.0, 0.0
    if x < p:
        return m / p**2 * (2 * p * x - x**2), 2 * m / p**2 * (p - x)
    return m / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * x - x**2), 2 * m / (1 - p) ** 2 * (p - x)


def _camber_five(code: str, x: float) -> tuple[float, float]:
    lift, pos, reflex = int(code[0]), int(code[1]), int(code[2])
    scale = (3.0 * lift / 20.0) / 0.3  # the tables are for a design lift of 0.3
    if not reflex:
        r, k1 = _FIVE_STANDARD[pos]
        if x < r:
            yc = k1 / 6.0 * (x**3 - 3 * r * x**2 + r**2 * (3 - r) * x)
            dy = k1 / 6.0 * (3 * x**2 - 6 * r * x + r**2 * (3 - r))
        else:
            yc = k1 * r**3 / 6.0 * (1 - x)
            dy = -k1 * r**3 / 6.0
        return scale * yc, scale * dy
    r, k1, k21 = _FIVE_REFLEX[pos]
    tail = k21 * (1 - r) ** 3
    if x < r:
        yc = k1 / 6.0 * ((x - r) ** 3 - tail * x - r**3 * x + r**3)
        dy = k1 / 6.0 * (3 * (x - r) ** 2 - tail - r**3)
    else:
        yc = k1 / 6.0 * (k21 * (x - r) ** 3 - tail * x - r**3 * x + r**3)
        dy = k1 / 6.0 * (3 * k21 * (x - r) ** 2 - tail - r**3)
    return scale * yc, scale * dy


def generate(code_text: str, points_per_side: int = DEFAULT_POINTS_PER_SIDE, closed_te: bool = False) -> NacaSection:
    """The section's Selig coordinates (``2 * points_per_side - 1`` points)."""
    code = parse_code(code_text)
    n = int(points_per_side)
    if not MIN_POINTS_PER_SIDE <= n <= MAX_POINTS_PER_SIDE:
        raise NacaError(f"Points per side must be from {MIN_POINTS_PER_SIDE} to {MAX_POINTS_PER_SIDE}.")
    t = int(code[-2:]) / 100.0
    camber = _camber_four if len(code) == 4 else _camber_five
    upper: list[tuple[float, float]] = []
    lower: list[tuple[float, float]] = []
    for i in range(n):
        beta = math.pi * i / (n - 1)
        x = 0.5 * (1.0 - math.cos(beta))
        yt = _thickness(x, t, closed_te)
        yc, dyc = camber(code, x)
        theta = math.atan(dyc)
        upper.append((x - yt * math.sin(theta), yc + yt * math.cos(theta)))
        lower.append((x + yt * math.sin(theta), yc - yt * math.cos(theta)))
    # Upper surface from the trailing edge to the leading edge, then the lower one back.
    pts = list(reversed(upper)) + lower[1:]
    xs = [_clean(p[0]) for p in pts]
    ys = [_clean(p[1]) for p in pts]
    return NacaSection(code=code, name=f"NACA {code}", x=xs, y=ys)


def _clean(v: float) -> float:
    """Round to 1e-10 so that -0.0 and float noise never reach a file or a test."""
    out = round(v, 10)
    return 0.0 if out == 0 else out
