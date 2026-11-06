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


def sign_changes(x: ArrayLike, y: ArrayLike) -> list[dict[str, Any]]:
    """Every place where ``y`` changes sign along ``x``, in order: ``x`` the zero linearly
    interpolated between the two samples around it (a sample exactly at zero is the zero
    itself), and ``rising`` (negative to positive) or not, with the two samples around it
    (``x_before``, ``x_after``). A zero between two samples of the same sign is not seen: the
    samples must be close enough for that."""
    xa, ya = arrays(x, y)
    out: list[dict[str, Any]] = []
    prev: int | None = None  # the last sample that was not zero
    for i in range(xa.size):
        if ya[i] == 0:
            continue
        if prev is not None and (ya[prev] > 0) != (ya[i] > 0):
            if i - prev > 1:  # samples at zero in between: the first of them is the zero
                xz = float(xa[prev + 1])
            else:
                t = -ya[prev] / (ya[i] - ya[prev])
                xz = float(xa[prev] + t * (xa[i] - xa[prev]))
            out.append({"x": xz, "rising": bool(ya[i] > 0), "x_before": float(xa[prev]), "x_after": float(xa[i])})
        prev = i
    return out


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


def interp_at(x: ArrayLike, y: ArrayLike, at: ArrayLike) -> np.ndarray:
    """``y`` linearly interpolated at each of ``at`` (outside the samples: NaN, never the end
    value carried on)."""
    xa, ya = arrays(x, y)
    if xa.size < 2:
        raise ValueError(f"interpolation needs at least 2 samples, got {xa.size}")
    q = np.asarray(at, dtype=float).reshape(-1)
    out = np.interp(q, xa, ya)
    eps = 1e-9 * max(1.0, float(np.abs(xa).max()))
    out[(q < xa[0] - eps) | (q > xa[-1] + eps)] = np.nan
    return out


def extremum(x: ArrayLike, y: ArrayLike, *, kind: str = "min") -> dict[str, float]:
    """The lowest (``kind="min"``) or highest sample of ``y`` refined by the parabola through it
    and its two neighbours: ``x`` and ``value`` of the parabola's vertex (the sample itself at
    either end of the series, or when the three are on a line), and ``x_sample``, ``value_sample``."""
    if kind not in ("min", "max"):
        raise ValueError(f"kind is 'min' or 'max', not {kind!r}")
    xa, ya = arrays(x, y)
    if xa.size < 3:
        raise ValueError(f"an extremum needs at least 3 samples, got {xa.size}")
    i = int(np.argmin(ya) if kind == "min" else np.argmax(ya))
    out = {"x": float(xa[i]), "value": float(ya[i]), "x_sample": float(xa[i]), "value_sample": float(ya[i])}
    if 0 < i < xa.size - 1:
        x0, x1, x2 = xa[i - 1 : i + 2]
        y0, y1, y2 = ya[i - 1 : i + 2]
        a = np.polyfit([x0 - x1, 0.0, x2 - x1], [y0, y1, y2], 2)
        if abs(a[0]) > 0:
            dx = -a[1] / (2 * a[0])
            if x0 - x1 <= dx <= x2 - x1:
                out["x"] = float(x1 + dx)
                out["value"] = float(a[2] - a[1] ** 2 / (4 * a[0]))
    return out


def stream_function(x: ArrayLike, y: ArrayLike, u: ArrayLike) -> np.ndarray:
    """psi(x_i, y_j) = the integral of u from the first y up to y_j along each column (the
    trapezoid rule), for u on a grid ``u[i, j]`` at ``x[i]``, ``y[j]`` (u = d psi / d y; psi is
    zero on the wall at the first y)."""
    ya = np.asarray(y, dtype=float).reshape(-1)
    ua = np.asarray(u, dtype=float)
    if ua.shape != (np.asarray(x).size, ya.size):
        raise ValueError(f"u is {ua.shape}, not (len(x), len(y)) = ({np.asarray(x).size}, {ya.size})")
    dy = np.diff(ya)
    inc = 0.5 * (ua[:, 1:] + ua[:, :-1]) * dy[None, :]
    return np.concatenate([np.zeros((ua.shape[0], 1)), np.cumsum(inc, axis=1)], axis=1)


def grid_minimum(x: ArrayLike, y: ArrayLike, z: ArrayLike) -> dict[str, float]:
    """The lowest value of ``z[i, j]`` (at ``x[i]``, ``y[j]``) refined by a least-squares
    quadratic surface through the 3 x 3 samples around the lowest one: ``x``, ``y`` and
    ``value`` of its minimum (the sample itself on the grid's edge, or when the surface has
    no minimum inside those samples), and ``value_sample``."""
    xa = np.asarray(x, dtype=float).reshape(-1)
    ya = np.asarray(y, dtype=float).reshape(-1)
    za = np.asarray(z, dtype=float)
    if za.shape != (xa.size, ya.size):
        raise ValueError(f"z is {za.shape}, not ({xa.size}, {ya.size})")
    masked = np.where(np.isfinite(za), za, np.inf)
    i, j = np.unravel_index(int(np.argmin(masked)), za.shape)
    out = {"x": float(xa[i]), "y": float(ya[j]), "value": float(za[i, j]), "value_sample": float(za[i, j])}
    if not (0 < i < xa.size - 1 and 0 < j < ya.size - 1):
        return out
    rows, vals = [], []
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            v = za[i + di, j + dj]
            if not np.isfinite(v):
                return out
            px, py = xa[i + di] - xa[i], ya[j + dj] - ya[j]
            rows.append([1.0, px, py, px * px, px * py, py * py])
            vals.append(v)
    c, *_ = np.linalg.lstsq(np.asarray(rows), np.asarray(vals), rcond=None)
    hess = np.array([[2 * c[3], c[4]], [c[4], 2 * c[5]]])
    if np.linalg.det(hess) <= 0 or hess[0, 0] <= 0:
        return out
    d = np.linalg.solve(hess, -np.array([c[1], c[2]]))
    if not (xa[i - 1] - xa[i] <= d[0] <= xa[i + 1] - xa[i] and ya[j - 1] - ya[j] <= d[1] <= ya[j + 1] - ya[j]):
        return out
    out["x"] = float(xa[i] + d[0])
    out["y"] = float(ya[j] + d[1])
    out["value"] = float(c[0] + c[1] * d[0] + c[2] * d[1] + c[3] * d[0] ** 2 + c[4] * d[0] * d[1] + c[5] * d[1] ** 2)
    return out


# ---------------------------------------------------------------------- periodic (transient) signals
#
# The app has no mean or frequency of a monitor over a time window (the design's gap G8), so a
# transient case's shedding is read here from the monitor's history: whole periods between the
# up-crossings of its mean, the window once its amplitude has settled, the means over that
# window, and the frequency from the spectrum with the mean period as the cross-check. The
# samples may be unevenly spaced in time (a monitor writes at the first time step after each of
# its intervals): every mean is a time integral of the piecewise-linear signal.


def _window(t: ArrayLike, y: ArrayLike, t0: float, t1: float) -> tuple[np.ndarray, np.ndarray]:
    """The piecewise-linear signal over ``[t0, t1]``: its samples inside, and the interpolated
    values at both ends."""
    ta, ya = arrays(t, y)
    if ta.size < 2:
        raise ValueError(f"a window needs at least 2 samples, got {ta.size}")
    eps = 1e-12 * max(1.0, abs(t0), abs(t1))
    if not (t1 > t0 and t0 >= ta[0] - eps and t1 <= ta[-1] + eps):
        raise ValueError(f"the window {t0:g} to {t1:g} is not inside the samples ({ta[0]:g} to {ta[-1]:g})")
    inner = (ta > t0) & (ta < t1)
    xs = np.concatenate([[t0], ta[inner], [t1]])
    ys = np.concatenate([[np.interp(t0, ta, ya)], ya[inner], [np.interp(t1, ta, ya)]])
    return xs, ys


def time_mean(t: ArrayLike, y: ArrayLike, t0: float, t1: float) -> float:
    """The time mean of ``y`` over ``[t0, t1]``: the trapezoid integral of the piecewise-linear
    signal over the window's length (unevenly spaced samples weigh as long as they last)."""
    xs, ys = _window(t, y, t0, t1)
    return float(np.sum(0.5 * (ys[1:] + ys[:-1]) * np.diff(xs)) / (t1 - t0))


def time_rms(t: ArrayLike, y: ArrayLike, t0: float, t1: float, *, about: float | None = None) -> float:
    """The root-mean-square of ``y - about`` over ``[t0, t1]`` (``about`` the window's time mean
    when not given: the fluctuation's rms), by the trapezoid rule on the squared samples."""
    m = time_mean(t, y, t0, t1) if about is None else float(about)
    xs, ys = _window(t, y, t0, t1)
    sq = (ys - m) ** 2
    return float(math.sqrt(np.sum(0.5 * (sq[1:] + sq[:-1]) * np.diff(xs)) / (t1 - t0)))


def up_crossings(t: ArrayLike, y: ArrayLike, level: float = 0.0, *, band: float = 0.0) -> np.ndarray:
    """The times where ``y`` rises through ``level``, each linearly interpolated between the two
    samples around it. With a ``band`` (> 0) a crossing counts only when the signal was below
    ``level - band`` before it and reaches ``level + band`` after it (the last rise through the
    level in between is the crossing), so noise about the level makes no extra crossings."""
    ta, ya = arrays(t, y)
    d = ya - float(level)
    h = abs(float(band))
    out: list[float] = []
    armed = h == 0.0
    cand: float | None = None
    for i in range(ta.size):
        if h > 0 and d[i] <= -h:
            armed, cand = True, None
            continue
        if armed and i > 0 and d[i - 1] < 0 <= d[i]:
            f = -d[i - 1] / (d[i] - d[i - 1])
            cand = float(ta[i - 1] + f * (ta[i] - ta[i - 1]))
            if h == 0.0:
                out.append(cand)
                cand = None
                continue
        if h > 0 and cand is not None and d[i] >= h:
            out.append(cand)
            armed, cand = False, None
    return np.asarray(out, dtype=float)


def periods(t: ArrayLike, y: ArrayLike, level: float = 0.0, *, band: float = 0.0) -> list[dict[str, float]]:
    """The whole periods of ``y`` about ``level``: from each up-crossing to the next, its start
    ``t0``, end ``t1``, ``period``, highest and lowest value (each refined by the parabola through
    the extreme sample and its neighbours) and ``amplitude`` (half their difference); ``n`` the
    samples inside it."""
    ta, ya = arrays(t, y)
    tc = up_crossings(ta, ya, level, band=band)
    out: list[dict[str, float]] = []
    for a, b in zip(tc[:-1], tc[1:], strict=True):
        sel = (ta > a) & (ta < b)
        n = int(sel.sum())
        row: dict[str, float] = {"t0": float(a), "t1": float(b), "period": float(b - a), "n": float(n)}
        if n >= 3:
            hi = extremum(ta[sel], ya[sel], kind="max")["value"]
            lo = extremum(ta[sel], ya[sel], kind="min")["value"]
            row.update({"max": hi, "min": lo, "amplitude": 0.5 * (hi - lo)})
        else:
            row.update({"max": float("nan"), "min": float("nan"), "amplitude": float("nan")})
        out.append(row)
    return out


def settled_window(t: ArrayLike, y: ArrayLike, *, rel: float = 0.02, n_check: int = 5,
                   min_periods: int = 20, tail: float = 0.3, band_frac: float = 0.1) -> dict[str, Any]:
    """Where a periodic signal (a lift coefficient's history) has settled, and the window of whole
    periods after it.

    The signal's periods are taken about its mean over the last ``tail`` of its time (then about
    the window's own mean). Its settled amplitude is the mean of its last ``n_check`` periods'
    amplitudes; it has settled when those agree within ``rel`` (their spread over that mean),
    and the window starts at the first period from which every period's amplitude is within
    ``rel`` of the settled one. ``settled`` is False, with the ``reason`` in words, when the
    signal hardly moves, has fewer than ``n_check`` periods, has not settled, or leaves fewer than
    ``min_periods`` whole periods in its window. The window's whole periods are ``periods``;
    ``t0`` and ``t1`` its start and end; ``period`` its mean period (its length over the count)."""
    ta, ya = arrays(t, y)
    out: dict[str, Any] = {"settled": False, "reason": "", "rel": rel, "n_check": n_check, "min_periods": min_periods,
                           "periods_all": [], "periods": [], "t0": None, "t1": None, "n_periods": 0}
    if ta.size < 20 or ta[-1] <= ta[0]:
        out["reason"] = f"only {ta.size} samples"
        return out
    t_from = float(ta[0] + (1.0 - tail) * (ta[-1] - ta[0]))
    level = time_mean(ta, ya, t_from, float(ta[-1]))
    last = ya[ta >= t_from]
    swing = 0.5 * float(last.max() - last.min()) if last.size else 0.0
    if not swing > 1e-9 * max(1.0, abs(level)):
        out["reason"] = "the signal does not oscillate over the last part of the run"
        return out

    def judge(lv: float) -> dict[str, Any]:
        pers = [p for p in periods(ta, ya, lv, band=band_frac * swing) if math.isfinite(p["amplitude"])]
        res: dict[str, Any] = {"level": lv, "periods_all": pers, "periods": []}
        if len(pers) < n_check:
            res["reason"] = f"only {len(pers)} whole periods in the run: no settled oscillation"
            return res
        amps = np.asarray([p["amplitude"] for p in pers], dtype=float)
        a_set = float(amps[-n_check:].mean())
        spread = float(amps[-n_check:].max() - amps[-n_check:].min()) / a_set
        res.update({"amplitude": a_set, "spread_last": spread})
        if spread > rel:
            res["reason"] = (f"its amplitude still changes by {100 * spread:.2g} % over the last {n_check} periods "
                             f"(settled means within {100 * rel:g} %)")
            return res
        off = np.abs(amps - a_set) / a_set > rel
        k0 = int(np.nonzero(off)[0][-1]) + 1 if off.any() else 0
        res.update({"start_index": k0, "periods": pers[k0:]})
        return res

    res = judge(level)
    if res["periods"]:
        win = res["periods"]
        res2 = judge(time_mean(ta, ya, win[0]["t0"], win[-1]["t1"]))
        if res2["periods"]:
            res = res2
    out.update({k: v for k, v in res.items() if k in ("level", "periods_all", "periods", "amplitude", "spread_last",
                                                      "start_index", "reason")})
    win = out["periods"]
    if win:
        out.update({"t0": win[0]["t0"], "t1": win[-1]["t1"], "n_periods": len(win)})
        out["period"] = (out["t1"] - out["t0"]) / len(win)
        out["period_spread"] = float(np.ptp([p["period"] for p in win])) / out["period"]
        if len(win) < min_periods:
            out["reason"] = (f"only {len(win)} whole periods after the transient (from t = {out['t0']:.4g}); "
                             f"at least {min_periods} are asked for")
        else:
            out["settled"] = True
            out["reason"] = ""
    return out


def spectrum_peak(t: ArrayLike, y: ArrayLike, t0: float, t1: float, *, pad: int = 8) -> dict[str, Any]:
    """The frequency of the strongest peak of ``y``'s spectrum over ``[t0, t1]``: the signal
    resampled evenly at its median sample spacing, its mean taken off, a Hann window, zero
    padded ``pad`` times, and the peak refined by a parabola through the logarithms of the three
    magnitudes around the highest one. Also the bin spacing ``df`` and the (one-sided) magnitude
    spectrum ``freq``, ``mag`` (normalised to the peak)."""
    ta, ya = arrays(t, y)
    inside = ta[(ta >= t0) & (ta <= t1)]
    if inside.size < 8:
        raise ValueError(f"a spectrum needs at least 8 samples in its window, got {inside.size}")
    dt = float(np.median(np.diff(inside)))
    n = int(math.floor((t1 - t0) / dt)) + 1
    tu = t0 + dt * np.arange(n)
    yu = np.interp(tu, ta, ya)
    yu = yu - yu.mean()
    m = int(pad) * n
    mag = np.abs(np.fft.rfft(yu * np.hanning(n), n=m))
    f = np.fft.rfftfreq(m, dt)
    k = int(np.argmax(mag[1:])) + 1
    f_peak = float(f[k])
    if 0 < k < mag.size - 1 and mag[k - 1] > 0 and mag[k + 1] > 0:
        a, b, c = (math.log(float(mag[i])) for i in (k - 1, k, k + 1))
        den = a - 2.0 * b + c
        if den < 0:
            f_peak += 0.5 * (a - c) / den * float(f[1] - f[0])
    return {"f": f_peak, "df": float(f[1] - f[0]), "dt": dt, "n": n, "pad": int(pad),
            "freq": f, "mag": mag / float(mag[k])}
