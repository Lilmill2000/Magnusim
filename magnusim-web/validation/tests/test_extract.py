"""The validation set's numerics on synthetic data with known answers."""

from __future__ import annotations

import math

import numpy as np
import pytest
from magnusim_validation.extract import (
    arrays,
    band,
    downsample,
    extremum,
    first_crossing,
    grid_minimum,
    interp_at,
    last_drift,
    linear_fit,
    periods,
    rms,
    settled_window,
    sign_changes,
    spectrum_peak,
    stream_function,
    time_mean,
    time_rms,
    up_crossings,
    window_mean,
)


def test_a_line_fit_gives_the_slope_and_its_standard_error():
    x = np.linspace(0.0, 0.3, 301)
    fit = linear_fit(x, 4.8 - 16.0 * x)
    assert fit["slope"] == pytest.approx(-16.0, rel=1e-12)
    assert fit["intercept"] == pytest.approx(4.8, rel=1e-12)
    assert fit["slope_se"] == pytest.approx(0.0, abs=1e-9)
    assert fit["r2"] == pytest.approx(1.0)
    assert fit["n"] == 301
    # Noise gives a standard error near sigma / sqrt(Sxx).
    rng = np.random.default_rng(1)
    y = 4.8 - 16.0 * x + rng.normal(0.0, 0.01, x.size)
    noisy = linear_fit(x, y)
    expected_se = 0.01 / math.sqrt(float(np.sum((x - x.mean()) ** 2)))
    assert noisy["slope_se"] == pytest.approx(expected_se, rel=0.2)
    assert abs(noisy["slope"] + 16.0) < 4 * noisy["slope_se"]


def test_a_line_fit_needs_three_samples_at_two_places():
    with pytest.raises(ValueError):
        linear_fit([0.0, 1.0], [0.0, 1.0])
    with pytest.raises(ValueError):
        linear_fit([1.0, 1.0, 1.0], [0.0, 1.0, 2.0])


def test_samples_are_sorted_and_the_non_finite_dropped():
    x, y = arrays([3.0, 1.0, float("nan"), 2.0], [30.0, 10.0, 5.0, float("inf")])
    assert x.tolist() == [1.0, 3.0]
    assert y.tolist() == [10.0, 30.0]
    with pytest.raises(ValueError):
        arrays([1.0], [1.0, 2.0])


def test_a_band_and_its_mean():
    x = np.linspace(0.0, 1.0, 11)
    xb, yb = band(x, 2 * x, 0.3, 0.6)
    assert xb.tolist() == pytest.approx([0.3, 0.4, 0.5, 0.6])
    w = window_mean(x, 2 * x, 0.3, 0.6)
    assert w["mean"] == pytest.approx(0.9)
    assert (w["min"], w["max"], w["n"]) == pytest.approx((0.6, 1.2, 4))
    with pytest.raises(ValueError):
        window_mean(x, x, 2.0, 3.0)


def test_the_first_crossing_is_interpolated():
    x = np.linspace(0.0, 10.0, 101)
    y = 2.0 * (1.0 - np.exp(-x / 2.0))
    # 2 (1 - exp(-x/2)) = 1.5 at x = 2 ln 4.
    assert first_crossing(x, y, 1.5) == pytest.approx(2 * math.log(4), abs=2e-3)
    assert first_crossing(x, y, 2.5) is None
    # Downwards, and from a start.
    assert first_crossing(x, -y, -1.5, rising=False) == pytest.approx(2 * math.log(4), abs=2e-3)
    assert first_crossing([0, 1, 2, 3], [0, 1, 0, 1], 0.5, start=1.5) == pytest.approx(2.5)
    # A series that starts at or above the level crosses at its first sample.
    assert first_crossing([0, 1], [3, 4], 1.0) == 0.0


def test_every_sign_change_is_found_and_interpolated():
    x = np.linspace(0.0, 10.0, 201)
    y = np.sin(x)
    got = sign_changes(x, y)
    # sin's zeros after its first sample (0 itself is the first sample's value, not a change).
    assert [c["x"] for c in got] == pytest.approx([math.pi, 2 * math.pi, 3 * math.pi], abs=2e-3)
    assert [c["rising"] for c in got] == [False, True, False]
    assert all(c["x_before"] < c["x"] < c["x_after"] for c in got)
    # Linear between the two samples around the zero; unsorted input is sorted first.
    assert sign_changes([1.0, 0.0], [1.0, -3.0]) == [{"x": 0.75, "rising": True, "x_before": 0.0, "x_after": 1.0}]
    # A sample exactly at zero is the zero; a touch of zero without a change is none.
    assert [c["x"] for c in sign_changes([0, 1, 2, 3], [-1.0, 0.0, 0.0, 2.0])] == [1.0]
    assert sign_changes([0, 1, 2], [1.0, 0.0, 1.0]) == []
    assert sign_changes([0, 1], [1.0, 2.0]) == []


def test_rms_downsample_and_drift():
    assert rms([3.0, -3.0, 3.0, -3.0]) == pytest.approx(3.0)
    with pytest.raises(ValueError):
        rms([])
    x = np.linspace(0, 1, 1001)
    ds = downsample(x, x * x, n_max=50)
    assert len(ds["x"]) == 50 and ds["x"][0] == 0.0 and ds["x"][-1] == 1.0
    assert len(downsample([1, 2], [3, 4])["x"]) == 2
    assert last_drift([1.0] * 5) is None
    assert last_drift([1.0] * 90 + [1.1] * 10) == pytest.approx(0.1 / 1.1)


def test_interpolation_is_linear_and_never_carries_an_end_on():
    x = [0.0, 1.0, 2.0]
    y = [0.0, 10.0, 0.0]
    got = interp_at(x, y, [0.5, 1.0, 1.75, -0.1, 2.5])
    assert got[:3] == pytest.approx([5.0, 10.0, 2.5])
    assert np.isnan(got[3]) and np.isnan(got[4])
    with pytest.raises(ValueError):
        interp_at([1.0], [1.0], [1.0])


def test_an_extremum_is_the_parabolas_vertex_through_the_three_samples_around_it():
    x = np.linspace(0.0, 1.0, 21)
    y = 2.0 * (x - 0.4567) ** 2 - 0.3
    lo = extremum(x, y, kind="min")
    # A parabola through samples of a parabola is the parabola itself.
    assert lo["x"] == pytest.approx(0.4567, abs=1e-9) and lo["value"] == pytest.approx(-0.3, abs=1e-12)
    assert lo["x_sample"] == pytest.approx(0.45)
    hi = extremum(x, -y, kind="max")
    assert hi["x"] == pytest.approx(0.4567, abs=1e-9) and hi["value"] == pytest.approx(0.3, abs=1e-12)
    # At an end of the series: the sample itself.
    edge = extremum(x, x, kind="min")
    assert edge["x"] == 0.0 and edge["value"] == 0.0
    with pytest.raises(ValueError):
        extremum(x, y, kind="mean")


def test_the_stream_function_and_its_minimum():
    """psi = A sin²(pi x) sin²(pi y) (zero on the walls, lowest A at the centre): u = d psi / d y
    integrated from the floor gives psi back, and its lowest value and centre."""
    a = -0.1
    x = np.linspace(0.01, 0.99, 99)
    y = np.linspace(0.0, 1.0, 401)
    xx, yy = np.meshgrid(x, y, indexing="ij")
    u = a * np.pi * np.sin(np.pi * xx) ** 2 * np.sin(2 * np.pi * yy)
    psi = stream_function(x, y, u)
    want = a * np.sin(np.pi * xx) ** 2 * np.sin(np.pi * yy) ** 2
    assert np.max(np.abs(psi - want)) < 1e-5
    m = grid_minimum(x, y, psi)
    assert m["x"] == pytest.approx(0.5, abs=1e-3) and m["y"] == pytest.approx(0.5, abs=1e-3)
    assert m["value"] == pytest.approx(a, rel=1e-4)
    # A bowl whose lowest point lies between the samples: found between them.
    bowl = (xx - 0.3712) ** 2 + 2.0 * (yy - 0.6153) ** 2 - 0.05
    m = grid_minimum(x, y, bowl)
    assert (m["x"], m["y"], m["value"]) == (pytest.approx(0.3712, abs=1e-9), pytest.approx(0.6153, abs=1e-9),
                                            pytest.approx(-0.05, abs=1e-12))
    with pytest.raises(ValueError):
        stream_function(x, y, u[:, :-1])


# ------------------------------------------------------------------- periodic (transient) signals

def _uneven_times(t_end: float, dt: float, seed: int = 3) -> np.ndarray:
    """Sample times as a transient monitor writes them: about every ``dt``, each at the first time
    step after its interval (so jittered by up to a fifth of ``dt``)."""
    rng = np.random.default_rng(seed)
    base = np.arange(0.0, t_end, dt)
    return np.unique(np.clip(base + rng.uniform(0.0, 0.2 * dt, base.size), 0.0, t_end))


def _shedding(t: np.ndarray, *, f: float = 16.4, amp: float = 0.33, tau: float = 0.25, t_on: float = 0.6,
              level: float = 0.0) -> np.ndarray:
    """A lift coefficient that grows from almost nothing and settles: amplitude amp / (1 +
    exp(-(t - t_on) / tau)), at frequency ``f``, about ``level``."""
    return level + amp / (1.0 + np.exp(-(t - t_on) / tau)) * np.sin(2 * np.pi * f * t + 0.3)


def test_time_means_of_unevenly_sampled_signals_weigh_each_sample_by_its_time():
    t = _uneven_times(1.0, 0.001)
    # A line's mean over any window is its middle's value; a sine's over whole periods its level.
    assert time_mean(t, 2.0 + 3.0 * t, 0.2, 0.8) == pytest.approx(2.0 + 3.0 * 0.5, rel=1e-12)
    f = 10.0
    y = 1.5 + 0.4 * np.sin(2 * np.pi * f * t)
    assert time_mean(t, y, 0.1, 0.9) == pytest.approx(1.5, abs=2e-5)
    assert time_rms(t, y, 0.1, 0.9) == pytest.approx(0.4 / math.sqrt(2.0), rel=1e-4)
    assert time_rms(t, y, 0.1, 0.9, about=0.0) == pytest.approx(math.sqrt(1.5**2 + 0.08), rel=1e-4)
    # Clustered samples do not pull the mean: half the samples bunched in the first tenth.
    tc = np.concatenate([np.linspace(0.0, 0.1, 5000), np.linspace(0.1, 1.0, 100)[1:]])
    assert time_mean(tc, tc, 0.0, 1.0) == pytest.approx(0.5, rel=1e-9)
    assert np.mean(tc) < 0.2
    with pytest.raises(ValueError):
        time_mean(t, y, 0.5, 2.0)


def test_up_crossings_and_whole_periods_ignore_noise_about_the_level():
    t = _uneven_times(1.0, 0.0005)
    f = 12.5
    clean = np.sin(2 * np.pi * f * t)
    tc = up_crossings(t, clean)
    assert tc.size == 12 and np.allclose(np.diff(tc), 1.0 / f, atol=2e-6)
    # Noise of 5 % of the amplitude makes extra crossings, unless a band holds them off.
    noisy = clean + 0.05 * np.random.default_rng(7).standard_normal(t.size)
    assert up_crossings(t, noisy).size > 12
    tn = up_crossings(t, noisy, band=0.2)
    assert tn.size == 12 and np.allclose(np.diff(tn), 1.0 / f, atol=2e-3)
    pers = periods(t, clean, band=0.1)
    assert len(pers) == 11
    assert all(abs(p["amplitude"] - 1.0) < 1e-4 and abs(p["period"] - 0.08) < 1e-5 for p in pers)
    assert all(p["n"] > 150 for p in pers)


def test_the_settled_window_starts_where_the_amplitude_has_settled():
    """A shedding signal growing from almost nothing to 0.33 (half-way at t = 0.6 s): its window
    starts once every period's amplitude is within 2 % of the settled one, holds whole periods
    only, and its period and spectrum give the frequency."""
    f, tau, t_on, amp = 16.4, 0.12, 0.6, 0.33
    t = _uneven_times(3.0, 0.0012)
    y = _shedding(t, f=f, amp=amp, tau=tau, t_on=t_on, level=0.004)
    w = settled_window(t, y)
    assert w["settled"] and w["reason"] == ""
    # The amplitude is within 2 % of its final value from t_on + tau ln(1/0.02 - 1) on.
    t_in = t_on + tau * math.log(1.0 / 0.02 - 1.0)
    assert t_in - 1.0 / f < w["t0"] < t_in + 1.5 / f
    assert all(abs(p["amplitude"] / amp - 1.0) <= 0.02 for p in w["periods"])
    assert w["n_periods"] >= 20 and w["t1"] <= 3.0 and w["t1"] > 3.0 - 1.0 / f
    assert w["period"] == pytest.approx(1.0 / f, rel=2e-4)
    assert w["amplitude"] == pytest.approx(amp, rel=2e-3) and w["level"] == pytest.approx(0.004, abs=2e-3)
    sp = spectrum_peak(t, y, w["t0"], w["t1"])
    assert sp["f"] == pytest.approx(f, rel=1e-3)
    assert sp["df"] == pytest.approx(1.0 / (8 * (w["t1"] - w["t0"])), rel=0.01)
    assert sp["mag"].max() == pytest.approx(1.0)
    # The means over the window's whole periods: the level, and the rms of a sine.
    assert time_mean(t, y, w["t0"], w["t1"]) == pytest.approx(0.004, abs=5e-5)
    assert time_rms(t, y, w["t0"], w["t1"]) == pytest.approx(amp / math.sqrt(2.0), rel=3e-3)


def test_a_signal_that_has_not_settled_says_why():
    t = _uneven_times(3.0, 0.0012)
    # Still growing at the end: its last 5 periods' amplitudes differ by more than 2 %.
    growing = settled_window(t, _shedding(t, tau=0.8, t_on=2.0))
    assert not growing["settled"] and "still changes" in growing["reason"] and growing["periods"] == []
    # Settled too late: fewer than 20 whole periods after the transient.
    late = settled_window(t, _shedding(t, tau=0.05, t_on=2.2))
    assert not late["settled"] and "whole periods after the transient" in late["reason"]
    assert 5 <= late["n_periods"] < 20
    # No oscillation at all (a steady wake), or too few periods.
    flat = settled_window(t, 1e-12 * np.ones_like(t))
    assert not flat["settled"] and "does not oscillate" in flat["reason"]
    short = settled_window(t, np.sin(2 * np.pi * 1.0 * t))
    assert not short["settled"] and "whole periods in the run" in short["reason"]
    assert not settled_window(t[:10], t[:10])["settled"]
    # A smaller window is enough when asked.
    assert settled_window(t, _shedding(t, tau=0.05, t_on=2.2), min_periods=5)["settled"]


def test_the_spectrum_peak_finds_the_frequency_between_its_bins():
    t = _uneven_times(2.0, 0.001)
    for f in (9.73, 16.4, 31.1):
        y = 0.2 + np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t)
        sp = spectrum_peak(t, y, 0.1, 1.9)
        assert sp["f"] == pytest.approx(f, rel=1e-3)
    with pytest.raises(ValueError):
        spectrum_peak(t, t, 0.0, 0.003)
