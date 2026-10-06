# SPDX-License-Identifier: GPL-3.0-or-later
"""A section from its dimensions (airfoil/shape.py): the NACA four-digit-modified family."""

from __future__ import annotations

import math

import pytest

from airfoil import geometry, naca, settings, shape, store

XS = [i / 4000 for i in range(4001)]


def dims(**over: object) -> dict[str, object]:
    d: dict[str, object] = {
        "thickness": 0.12,
        "thickness_at": 0.3,
        "camber": 0.02,
        "camber_at": 0.4,
        "le_radius": shape.standard_le_radius(0.12),
        "closed_te": False,
    }
    d.update(over)
    return d


@pytest.mark.parametrize("m", [0.2, 0.25, 0.3, 0.4, 0.5, 0.55, 0.6])
@pytest.mark.parametrize("index", [0.0, 1.0, 3.0, 6.0, 8.0, 9.0])
@pytest.mark.parametrize("closed", [False, True])
def test_the_thickness_is_greatest_where_asked_smooth_there_and_never_negative(m: float, index: float, closed: bool) -> None:
    f = shape.thickness_form(m, index, closed)
    v = [f.half(x) for x in XS]
    assert min(v) >= -1e-12
    assert max(v) <= 0.1 + 1e-9
    assert f.half(m) == pytest.approx(0.1, abs=1e-12)
    eps = 1e-6
    # Zero slope at the maximum, the same from both sides, and the same curvature.
    assert (f.half(m) - f.half(m - eps)) / eps == pytest.approx(0, abs=1e-5)
    assert (f.half(m + eps) - f.half(m)) / eps == pytest.approx(0, abs=1e-5)
    c_left = (f.half(m) - 2 * f.half(m - 1e-4) + f.half(m - 2e-4)) / 1e-8
    c_right = (f.half(m + 2e-4) - 2 * f.half(m + 1e-4) + f.half(m)) / 1e-8
    assert c_left == pytest.approx(c_right, rel=0.02, abs=0.05)
    assert f.half(1.0) == pytest.approx(0.0 if closed else 0.002, abs=1e-12)


def test_the_leading_edge_radius_is_the_one_asked() -> None:
    for t in (0.06, 0.12, 0.21):
        lo, hi = shape.le_radius_range(t)
        for r in (shape.standard_le_radius(t), 0.5 * shape.standard_le_radius(t), 0.9 * hi):
            f = shape.thickness_form(0.3, shape.le_index(t, r), False)
            # Near the nose y = (t/0.2) a0 sqrt(x): a circle of radius ((t/0.2) a0)^2 / 2 (the
            # published 1.1019 is 12.5 * 0.296904^2 rounded).
            assert ((t / 0.2) * f.a[0]) ** 2 / 2 == pytest.approx(r, rel=1e-5)


def test_with_the_standard_radius_and_thickness_at_30_percent_it_is_the_original_four_digit_section() -> None:
    # Abbott and von Doenhoff: index 6 at 30 % is "very nearly" the original section.
    s = shape.generate(dims(), 81)
    o = naca.generate("2412", 81)
    assert s.name == "NACA 2412-63"
    assert max(abs(a - b) for a, b in zip(s.y, o.y, strict=True)) < 0.002
    m = geometry.measures(s.x, s.y)
    assert m["thickness"] == pytest.approx(0.12, abs=2e-4)
    assert m["camber"] == pytest.approx(0.02, abs=2e-4)
    assert m["te_gap"] == pytest.approx(0.0024, abs=1e-4)


@pytest.mark.parametrize("t", [0.01, 0.06, 0.12, 0.25, 0.4])
@pytest.mark.parametrize("m", [0.2, 0.4, 0.6])
@pytest.mark.parametrize(("c", "p"), [(0.0, 0.4), (0.04, 0.2), (0.095, 0.9), (0.095, 0.1)])
def test_every_section_in_range_is_a_closed_outline_that_does_not_cross_itself(t: float, m: float, c: float, p: float) -> None:
    for frac in (0.0, 0.5, 1.0):
        r = shape.le_radius_range(t)[1] * frac
        s = shape.generate(dims(thickness=t, thickness_at=m, camber=c, camber_at=p, le_radius=r), 61)
        assert len(s.x) == 121
        assert geometry.first_crossing(s.x, s.y) is None
        # Measured upright; it is laid across the camber line, so a steep one reads a little off.
        assert geometry.measures(s.x, s.y)["thickness"] == pytest.approx(t, rel=0.1)


def test_names_whole_digits_and_names_the_rest_by_their_dimensions() -> None:
    assert shape.generate(dims(thickness_at=0.4, le_radius=shape.standard_le_radius(0.12) * (8 / 6) ** 2), 41).name == "NACA 2412-84"
    assert shape.generate(dims(camber=0.0), 41).name == "NACA 0012-63"
    # The standard radius as the page shows it (1.587 %) is still index 6.
    assert shape.generate(dims(le_radius=0.01587), 41).name == "NACA 2412-63"
    assert shape.generate(dims(thickness_at=0.35, le_radius=0.02), 41).name == "Custom t12.0@35 c2.0@40 r2.00"
    assert shape.generate(dims(camber=0.0, thickness=0.105), 41).name == "Custom t10.5@30 c0 r1.59"


@pytest.mark.parametrize(
    ("over", "field", "words"),
    [
        ({"thickness": 0.5}, "thickness", "Maximum thickness must be 1 % to 40 % of the chord."),
        ({"thickness_at": 0.7}, "thickness_at", "Maximum-thickness position must be 20 % to 60 % of the chord."),
        ({"camber": 0.12}, "camber", "Maximum camber must be 0 % to 9.5 % of the chord."),
        ({"camber_at": 0.05}, "camber_at", "Maximum-camber position must be 10 % to 90 % of the chord."),
        ({"le_radius": 0.05}, "le_radius", "Leading-edge radius must be from 0 to 3.57 % of the chord at this thickness (the standard radius is 1.59 %)."),
        ({"thickness": "x"}, "thickness", "Maximum thickness must be a number."),
        ({"le_radius": math.nan}, "le_radius", "Leading-edge radius must be from 0 to 3.57 %"),
    ],
)
def test_a_dimension_the_family_cannot_make_is_refused_naming_its_field(over: dict[str, object], field: str, words: str) -> None:
    with pytest.raises(shape.ShapeError) as err:
        shape.generate(dims(**over), 41)
    assert err.value.field == field
    assert str(err.value).startswith(words)
    with pytest.raises(settings.SettingsError) as err2:
        settings.normalize_airfoil({"source": "shape", **dims(**over)})
    assert err2.value.field == field


def test_the_study_keeps_a_shape_and_the_engines_get_its_points() -> None:
    a = settings.normalize_airfoil({"source": "shape", **dims(thickness_at=0.35, le_radius=0.02), "points_per_side": 61})
    assert a == {
        "source": "shape",
        "thickness": 0.12,
        "thickness_at": 0.35,
        "camber": 0.02,
        "camber_at": 0.4,
        "le_radius": 0.02,
        "closed_te": False,
        "points_per_side": 61,
    }
    name, x, y = store.section(None, "st-1", a)
    assert name == "Custom t12.0@35 c2.0@40 r2.00"
    assert len(x) == len(y) == 121
    assert x[60] == 0.0 and y[60] == 0.0
    assert abs(x[0] - 1.0) < 1e-3 and abs(x[-1] - 1.0) < 1e-3
