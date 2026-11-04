"""The validation set's numerics on synthetic data with known answers."""

from __future__ import annotations

import math

import numpy as np
import pytest
from magnusim_validation.extract import (
    arrays,
    band,
    downsample,
    first_crossing,
    last_drift,
    linear_fit,
    rms,
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
