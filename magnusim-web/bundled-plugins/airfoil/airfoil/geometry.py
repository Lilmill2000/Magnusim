"""Checks and measures of a section given as Selig coordinates (lists of x and y)."""

from __future__ import annotations

import math
from collections.abc import Sequence

# SPDX-License-Identifier: GPL-3.0-or-later

MIN_POINTS = 10
MAX_POINTS = 1000


def signed_area(x: Sequence[float], y: Sequence[float]) -> float:
    """Shoelace area of the closed outline; above 0 when it runs counter-clockwise (Selig)."""
    n = len(x)
    s = 0.0
    for i in range(n):
        j = (i + 1) % n
        s += x[i] * y[j] - x[j] * y[i]
    return 0.5 * s


def leading_edge_index(x: Sequence[float]) -> int:
    """The point with the smallest x (the first one when several share it)."""
    best = 0
    for i, v in enumerate(x):
        if v < x[best]:
            best = i
    return best


def _cross(ax: float, ay: float, bx: float, by: float) -> float:
    return ax * by - ay * bx


Point = tuple[float, float]


def _segments_cross(p1: Point, p2: Point, p3: Point, p4: Point) -> bool:
    """True when segment p1-p2 properly crosses p3-p4 (touching ends do not count)."""
    d1 = _cross(p4[0] - p3[0], p4[1] - p3[1], p1[0] - p3[0], p1[1] - p3[1])
    d2 = _cross(p4[0] - p3[0], p4[1] - p3[1], p2[0] - p3[0], p2[1] - p3[1])
    d3 = _cross(p2[0] - p1[0], p2[1] - p1[1], p3[0] - p1[0], p3[1] - p1[1])
    d4 = _cross(p2[0] - p1[0], p2[1] - p1[1], p4[0] - p1[0], p4[1] - p1[1])
    return d1 * d2 < 0 and d3 * d4 < 0


def first_crossing(x: Sequence[float], y: Sequence[float]) -> tuple[int, int] | None:
    """The first pair of outline segments (i, j) that cross, or None.

    The outline is open at the trailing edge (Selig), so the last point does not
    join the first; segments that share a point are never compared.
    """
    pts = list(zip(x, y, strict=True))
    n = len(pts) - 1  # segments i: pts[i] -> pts[i + 1]
    for i in range(n):
        a, b = pts[i], pts[i + 1]
        ax0, ax1 = min(a[0], b[0]), max(a[0], b[0])
        ay0, ay1 = min(a[1], b[1]), max(a[1], b[1])
        for j in range(i + 2, n):
            c, d = pts[j], pts[j + 1]
            if max(c[0], d[0]) < ax0 or min(c[0], d[0]) > ax1 or max(c[1], d[1]) < ay0 or min(c[1], d[1]) > ay1:
                continue
            if _segments_cross(a, b, c, d):
                return i, j
    return None


def _interp(xs: Sequence[float], ys: Sequence[float], at: float) -> float:
    """Linear interpolation on a surface whose x increases (xs sorted)."""
    if at <= xs[0]:
        return ys[0]
    if at >= xs[-1]:
        return ys[-1]
    lo, hi = 0, len(xs) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if xs[mid] <= at:
            lo = mid
        else:
            hi = mid
    span = xs[hi] - xs[lo]
    if span <= 0:
        return ys[lo]
    f = (at - xs[lo]) / span
    return ys[lo] + f * (ys[hi] - ys[lo])


def surfaces(x: Sequence[float], y: Sequence[float]) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """Upper and lower surfaces, each from the leading edge to the trailing edge, sorted by x."""
    le = leading_edge_index(x)
    upper = sorted(zip(x[: le + 1], y[: le + 1], strict=True))
    lower = sorted(zip(x[le:], y[le:], strict=True))
    return upper, lower


def measures(x: Sequence[float], y: Sequence[float]) -> dict[str, float]:
    """Maximum thickness and camber (fractions of chord) and where they are, and the trailing-edge gap."""
    upper, lower = surfaces(x, y)
    ux, uy = [p[0] for p in upper], [p[1] for p in upper]
    lx, ly = [p[0] for p in lower], [p[1] for p in lower]
    x0 = min(x)
    chord = max(x) - x0
    best_t, at_t, best_c, at_c = 0.0, 0.0, 0.0, 0.0
    samples = 400
    for i in range(samples + 1):
        xs = x0 + chord * (0.5 * (1 - math.cos(math.pi * i / samples)))
        yu = _interp(ux, uy, xs)
        yl = _interp(lx, ly, xs)
        t = yu - yl
        c = 0.5 * (yu + yl)
        if t > best_t:
            best_t, at_t = t, xs
        if abs(c) > abs(best_c):
            best_c, at_c = c, xs
    te_gap = math.hypot(x[0] - x[-1], y[0] - y[-1])
    scale = chord if chord > 0 else 1.0
    return {
        "thickness": best_t / scale,
        "thickness_at": (at_t - x0) / scale,
        "camber": best_c / scale,
        "camber_at": (at_c - x0) / scale,
        "te_gap": te_gap / scale,
        "chord": chord,
    }


def decimate(x: Sequence[float], y: Sequence[float], max_points: int) -> tuple[list[float], list[float]]:
    """At most ``max_points`` points, keeping both trailing-edge ends and the leading edge."""
    n = len(x)
    if n <= max_points:
        return list(x), list(y)
    le = leading_edge_index(x)
    keep_upper = max(2, round((max_points - 1) * le / (n - 1)) + 1)
    keep_lower = max(2, max_points - keep_upper + 1)

    def pick(lo: int, hi: int, count: int) -> list[int]:
        if count >= hi - lo + 1:
            return list(range(lo, hi + 1))
        return sorted({lo + round(k * (hi - lo) / (count - 1)) for k in range(count)})

    idx = pick(0, le, keep_upper) + pick(le, n - 1, keep_lower)[1:]
    return [x[i] for i in idx], [y[i] for i in idx]
