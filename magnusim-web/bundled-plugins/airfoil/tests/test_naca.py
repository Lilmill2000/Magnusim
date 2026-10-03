"""NACA 4- and 5-digit sections: shape, order and the designations refused."""

from __future__ import annotations

import pytest

from airfoil import geometry, naca


def test_naca_0012_is_symmetric_with_12_percent_at_30_percent_chord():
    sec = naca.generate("0012")
    n = len(sec.x)
    assert n == 2 * naca.DEFAULT_POINTS_PER_SIDE - 1
    le = geometry.leading_edge_index(sec.x)
    assert le == naca.DEFAULT_POINTS_PER_SIDE - 1
    assert (sec.x[le], sec.y[le]) == (0.0, 0.0)
    for i in range(le):
        mirror = n - 1 - i
        assert sec.x[i] == pytest.approx(sec.x[mirror], abs=1e-12)
        assert sec.y[i] == pytest.approx(-sec.y[mirror], abs=1e-12)
    m = geometry.measures(sec.x, sec.y)
    assert m["thickness"] == pytest.approx(0.12, abs=5e-4)
    assert m["thickness_at"] == pytest.approx(0.30, abs=0.01)
    assert m["camber"] == pytest.approx(0.0, abs=1e-9)
    # The standard form leaves a finite trailing edge: 10 t (0.2969 - 0.1260 - 0.3516 + 0.2843 - 0.1015).
    assert m["te_gap"] == pytest.approx(10 * 0.12 * 0.0021, abs=1e-6)


def test_closed_trailing_edge():
    sec = naca.generate("0012", closed_te=True)
    assert geometry.measures(sec.x, sec.y)["te_gap"] == pytest.approx(0.0, abs=1e-9)


def test_selig_order_upper_surface_first():
    sec = naca.generate("2412")
    # The thickness is laid off normal to the mean line, so the ends sit a hair off x = 1.
    assert sec.x[0] == pytest.approx(1.0, abs=1e-3) and sec.x[-1] == pytest.approx(1.0, abs=1e-3)
    assert sec.y[0] > sec.y[-1]
    assert geometry.signed_area(sec.x, sec.y) > 0
    upper_mid = sec.y[naca.DEFAULT_POINTS_PER_SIDE // 2]
    assert upper_mid > 0
    assert sec.name == "NACA 2412"


def test_naca_2412_camber_two_percent_at_forty_percent():
    sec = naca.generate("2412", 121)
    m = geometry.measures(sec.x, sec.y)
    assert m["camber"] == pytest.approx(0.02, abs=3e-4)
    assert m["camber_at"] == pytest.approx(0.40, abs=0.03)
    assert m["thickness"] == pytest.approx(0.12, abs=1e-3)


def test_naca_23012_camber_at_fifteen_percent():
    # Mean line 230: r = 0.2025, k1 = 15.957; the highest point is at x = r (1 - sqrt(r / 3)) = 0.150
    # with yc = 0.0184.
    sec = naca.generate("23012", 121)
    m = geometry.measures(sec.x, sec.y)
    assert m["camber_at"] == pytest.approx(0.15, abs=0.02)
    assert m["camber"] == pytest.approx(0.0184, abs=4e-4)


def test_five_digit_design_lift_scales_the_mean_line():
    c230 = geometry.measures(*_xy(naca.generate("23012", 121)))["camber"]
    c430 = geometry.measures(*_xy(naca.generate("43012", 121)))["camber"]
    assert c430 == pytest.approx(2 * c230, rel=0.02)


def test_reflexed_mean_line_ends_at_the_chord_line():
    sec = naca.generate("23112", 121, closed_te=True)
    assert sec.y[0] == pytest.approx(sec.y[-1], abs=1e-9)
    assert 0.5 * (sec.y[0] + sec.y[-1]) == pytest.approx(0.0, abs=1e-9)
    # Near the trailing edge the reflexed line (231) is far flatter than the standard one (230):
    # yc(0.9) = 0.00067 against 0.0022.
    assert _mean_line(sec, 0.9) == pytest.approx(0.00067, abs=2e-4)
    assert _mean_line(naca.generate("23012", 121, closed_te=True), 0.9) == pytest.approx(0.0022, abs=2e-4)


def _xy(sec):
    return sec.x, sec.y


def _mean_line(sec, at):
    upper, lower = geometry.surfaces(sec.x, sec.y)
    yu = geometry._interp([p[0] for p in upper], [p[1] for p in upper], at)
    yl = geometry._interp([p[0] for p in lower], [p[1] for p in lower], at)
    return 0.5 * (yu + yl)


@pytest.mark.parametrize("text", ["2412", "NACA 2412", "naca2412", " 0012 ", "23012", "23112"])
def test_designations_read(text):
    assert naca.parse_code(text) in {"2412", "0012", "23012", "23112"}


@pytest.mark.parametrize(
    ("text", "why"),
    [
        ("241", "4-digit or 5-digit"),
        ("2412a", "4-digit or 5-digit"),
        ("2400", "thickness"),
        ("0412", "both be 0"),
        ("2012", "both be 0"),
        ("26012", "second digit in 1, 2, 3, 4, 5"),
        ("23212", "third digit must be 0"),
        ("21112", "second digit in 2, 3, 4, 5"),
        ("03012", "design lift"),
    ],
)
def test_designations_refused_with_the_reason(text, why):
    with pytest.raises(naca.NacaError, match=why):
        naca.parse_code(text)


def test_points_per_side_limits():
    with pytest.raises(naca.NacaError, match="Points per side"):
        naca.generate("2412", naca.MIN_POINTS_PER_SIDE - 1)
    assert len(naca.generate("2412", naca.MIN_POINTS_PER_SIDE).x) == 2 * naca.MIN_POINTS_PER_SIDE - 1
