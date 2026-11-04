"""The numbers a case takes from a run's series: plain numpy, no OpenFOAM, unit-tested on
synthetic data (``tests/test_extract.py``)."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import numpy as np
from numpy.typing import ArrayLike


def arrays(x: ArrayLike, y: ArrayLike) -> tuple[np.ndarray, np.ndarray]:
    """``x`` and ``y`` as float arrays of the same length, sorted by ``x``, without the pairs
    where either is not finite."""
    xa = np.asarray(x, dtype=float).reshape(-1)
    ya = np.asarray(y, dtype=float).reshape(-1)
    if xa.size != ya.size:
        raise ValueError(f"x has {xa.size} values and y {ya.size}")
    keep = np.isfinite(xa) & np.isfinite(ya)
    xa, ya = xa[keep], ya[keep]
    order = np.argsort(xa, kind="stable")
    return xa[order], ya[order]


def band(x: ArrayLike, y: ArrayLike, lo: float, hi: float) -> tuple[np.ndarray, np.ndarray]:
    """The samples with ``lo <= x <= hi`` (ends included to a relative 1e-9, so a sample
    placed on an end by floating-point arithmetic counts)."""
    xa, ya = arrays(x, y)
    eps = 1e-9 * max(1.0, abs(lo), abs(hi))
    keep = (xa >= lo - eps) & (xa <= hi + eps)
    return xa[keep], ya[keep]


def linear_fit(x: ArrayLike, y: ArrayLike) -> dict[str, float]:
    """Least-squares line y = slope·x + intercept: ``slope``, ``intercept``, the slope's
    standard error ``slope_se``, ``r2`` and ``n``. Needs at least three samples."""
    xa, ya = arrays(x, y)
    n = int(xa.size)
    if n < 3:
        raise ValueError(f"a line fit needs at least 3 samples, got {n}")
    xm, ym = float(xa.mean()), float(ya.mean())
    sxx = float(np.sum((xa - xm) ** 2))
    if sxx <= 0:
        raise ValueError("a line fit needs samples at more than one x")
    slope = float(np.sum((xa - xm) * (ya - ym)) / sxx)
    intercept = ym - slope * xm
    resid = ya - (slope * xa + intercept)
    ss_res = float(np.sum(resid**2))
    ss_tot = float(np.sum((ya - ym) ** 2))
    slope_se = math.sqrt(ss_res / (n - 2) / sxx) if n > 2 else float("nan")
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 1.0
    return {"slope": slope, "intercept": intercept, "slope_se": slope_se, "r2": r2, "n": float(n)}


def radial_fit(r: ArrayLike, u: ArrayLike) -> dict[str, float]:
    """Least-squares u = centre + curvature·r² over the samples (r a distance from the axis):
    ``centre`` (the fit's value on the axis), its standard error ``centre_se``, ``curvature``
    and ``n``. Needs at least three samples at two radii or more."""
    ra, ua = arrays(r, u)
    n = int(ra.size)
    if n < 3:
        raise ValueError(f"a radial fit needs at least 3 samples, got {n}")
    if float(np.ptp(ra**2)) <= 0:
        raise ValueError("a radial fit needs samples at more than one radius")
    a = np.vstack([np.ones(n), ra**2]).T
    coef, *_ = np.linalg.lstsq(a, ua, rcond=None)
    resid = ua - a @ coef
    s2 = float(np.sum(resid**2)) / (n - 2)
    cov = s2 * np.linalg.inv(a.T @ a)
    return {"centre": float(coef[0]), "curvature": float(coef[1]), "centre_se": math.sqrt(max(0.0, float(cov[0, 0]))),
            "n": float(n)}


def window_mean(x: ArrayLike, y: ArrayLike, lo: float, hi: float) -> dict[str, float]:
    """Mean, standard deviation, lowest, highest and count of ``y`` over ``lo <= x <= hi``."""
    _, yb = band(x, y, lo, hi)
    if yb.size == 0:
        raise ValueError(f"no samples between {lo} and {hi}")
    return {
        "mean": float(yb.mean()),
        "std": float(yb.std(ddof=1)) if yb.size > 1 else 0.0,
        "min": float(yb.min()),
        "max": float(yb.max()),
        "n": float(yb.size),
    }


def first_crossing(x: ArrayLike, y: ArrayLike, level: float, *, start: float | None = None,
                   rising: bool = True) -> float | None:
    """The first x (from ``start`` on) where ``y`` crosses ``level`` (upwards when ``rising``,
    else downwards), linearly interpolated between the two samples around it; None when it
    never does. A sample exactly at the level counts as the crossing."""
    xa, ya = arrays(x, y)
    if start is not None:
        keep = xa >= start
        xa, ya = xa[keep], ya[keep]
    if xa.size == 0:
        return None
    d = (ya - level) if rising else (level - ya)
    if d[0] >= 0:
        return float(xa[0])
    for i in range(1, xa.size):
        if d[i] >= 0 > d[i - 1]:
            t = -d[i - 1] / (d[i] - d[i - 1])
            return float(xa[i - 1] + t * (xa[i] - xa[i - 1]))
    return None


def rms(values: ArrayLike) -> float:
    a = np.asarray(values, dtype=float)
    if a.size == 0:
        raise ValueError("rms of nothing")
    return float(math.sqrt(float(np.mean(a**2))))


def downsample(x: ArrayLike, y: ArrayLike, n_max: int = 400) -> dict[str, list[float]]:
    """At most ``n_max`` evenly picked samples (the first and last kept), for result.json."""
    xa, ya = arrays(x, y)
    if xa.size > n_max:
        idx = np.unique(np.round(np.linspace(0, xa.size - 1, n_max)).astype(int))
        xa, ya = xa[idx], ya[idx]
    return {"x": [_round(v) for v in xa.tolist()], "y": [_round(v) for v in ya.tolist()]}


def _round(v: float, digits: int = 7) -> float:
    """``v`` to ``digits`` significant digits (series in result.json stay small and stable)."""
    if v == 0 or not math.isfinite(v):
        return float(v)
    return float(f"{v:.{digits}g}")


def last_drift(values: Sequence[Any], fraction: float = 0.1) -> float | None:
    """How much a history moved over its last ``fraction`` (relative to its last value):
    |last − value at the window's start| / |last|; None when it is too short or ends at 0."""
    a = np.asarray([float(v) for v in values if v is not None], dtype=float)
    if a.size < 10 or a[-1] == 0:
        return None
    k = max(1, int(round(a.size * fraction)))
    return float(abs(a[-1] - a[-1 - k]) / abs(a[-1]))
