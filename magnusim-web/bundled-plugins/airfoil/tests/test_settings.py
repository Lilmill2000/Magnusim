"""Study settings: defaults, checks, the α list and the upgrade of older studies."""

from __future__ import annotations

import pytest

from airfoil import settings


def test_defaults_are_naca_2412_at_re_one_million_minus_four_to_ten():
    d = settings.defaults()
    assert d["airfoil"] == {"source": "naca", "code": "2412", "points_per_side": 81, "closed_te": False}
    c = settings.normalize_conditions(d["conditions"])
    assert settings.alpha_list(c) == [float(a) for a in range(-4, 11)]
    assert (c["re"], c["mach"], c["ncrit"], c["xtr_top"], c["xtr_bottom"]) == (1e6, 0.0, 9.0, 1.0, 1.0)


def test_alpha_list_keeps_the_last_angle_on_a_fractional_step():
    c = settings.normalize_conditions({"alpha_start": 0, "alpha_end": 1, "alpha_step": 0.1})
    got = settings.alpha_list(c)
    assert len(got) == 11 and got[-1] == 1.0 and got[3] == 0.3
    c = settings.normalize_conditions({"alpha_start": 0, "alpha_end": 1, "alpha_step": 0.3})
    assert settings.alpha_list(c) == [0.0, 0.3, 0.6, 0.9]


@pytest.mark.parametrize(("start", "step"), [(-4.0125, 0.05), (0.0, 0.0625), (-1.23456, 0.0789)])
def test_alpha_list_has_at_most_three_decimals_as_xfoil_writes_them(start, step):
    """XFOIL echoes α with 3 decimals; an angle with more would not match its echo."""
    from airfoil import xfoil

    c = settings.normalize_conditions({"alpha_start": start, "alpha_end": 4, "alpha_step": step})
    got = settings.alpha_list(c)
    assert len(got) > 20
    for a in got:
        assert a == round(a, 3)
        assert xfoil._match(a, [float(f"{a:.3f}")])
    assert len(set(got)) == len(got)


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"re": "lots"}, "Reynolds number must be a number"),
        ({"re": 10}, "Reynolds number must be from 1000"),
        ({"mach": 0.9}, "Mach number must be from 0 to 0.7"),
        ({"alpha_start": 5, "alpha_end": 2}, "last α must not be below the first"),
        ({"alpha_step": 0}, "α step must be from 0.05"),
        ({"alpha_start": -30, "alpha_end": 30, "alpha_step": 0.1}, "At most 181 angles"),
        ({"ncrit": float("nan")}, "Ncrit must be a finite number"),
        ({"xtr_top": 1.5}, "Upper transition x/c must be from 0 to 1"),
    ],
)
def test_conditions_refused_with_the_field(patch, message):
    with pytest.raises(settings.SettingsError, match=message):
        settings.normalize_conditions({**settings.DEFAULT_CONDITIONS, **patch})


def test_airfoil_blocks():
    assert settings.normalize_airfoil({"source": "naca", "code": "NACA 0012"})["code"] == "0012"
    assert settings.normalize_airfoil({"source": "dat", "name": "  E387 "}) == {"source": "dat", "name": "E387", "file": "airfoil.dat"}
    with pytest.raises(settings.SettingsError, match="4-digit or 5-digit"):
        settings.normalize_airfoil({"source": "naca", "code": "24x2"})
    with pytest.raises(settings.SettingsError, match="Unknown airfoil source"):
        settings.normalize_airfoil({"source": "stl"})


def test_from_study_fills_a_new_study():
    got = settings.from_study({"id": "st-1", "kind": "airfoil_analysis"})
    assert got["airfoil"]["code"] == "2412"
    assert got["conditions"]["alpha_end"] == 10.0


def test_migrate_from_version_zero():
    old = {
        "id": "st-1",
        "kind": "airfoil_analysis",
        "rev": 3,
        "schema_version": 0,
        "airfoil": "0012",
        "conditions": {"re": 5e5, "mach": 2.0, "alpha_end": "x"},
        "notes": "kept",
    }
    got = settings.migrate(old, 0, 1)
    assert got["airfoil"]["code"] == "0012"
    # A value that fails today's checks falls back to its default; the others are kept.
    assert got["conditions"]["re"] == 5e5
    assert got["conditions"]["mach"] == 0.0
    assert got["conditions"]["alpha_end"] == 10.0
    assert got["notes"] == "kept" and got["rev"] == 3
    assert old["airfoil"] == "0012"  # the input is not changed


def test_migrate_refuses_a_newer_schema():
    with pytest.raises(settings.SettingsError, match="newer"):
        settings.migrate({}, 2, 1)
    with pytest.raises(settings.SettingsError, match="writes schema version 1"):
        settings.migrate({}, 0, 2)


@pytest.mark.parametrize(
    "airfoil",
    ["24x2", {"source": "naca", "code": "24x2"}, {"source": "naca", "code": "2412", "points_per_side": 5}, {"source": "stl"}],
)
def test_migrate_replaces_an_airfoil_that_fails_todays_checks_with_the_default(airfoil):
    """An old study always opens: a section that cannot be used falls back to NACA 2412."""
    got = settings.migrate({"id": "st-1", "airfoil": airfoil, "conditions": dict(settings.DEFAULT_CONDITIONS)}, 0, 1)
    assert got["airfoil"] == settings.DEFAULT_AIRFOIL
    assert settings.from_study(got)["airfoil"] == settings.DEFAULT_AIRFOIL


@pytest.mark.parametrize(
    "conditions",
    [
        {"alpha_start": 10, "alpha_end": -4},  # each value passes, together they do not
        {"alpha_start": -30, "alpha_end": 30, "alpha_step": 0.05},  # too many angles
    ],
)
def test_migrate_gives_conditions_that_pass_when_merging_alone_does_not(conditions):
    got = settings.migrate({"id": "st-1", "airfoil": "2412", "conditions": conditions}, 0, 1)
    assert settings.normalize_conditions(got["conditions"]) == got["conditions"]
    assert got["conditions"] == settings.DEFAULT_CONDITIONS
    assert settings.from_study(got)["conditions"] == settings.DEFAULT_CONDITIONS
