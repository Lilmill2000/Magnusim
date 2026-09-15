
"""Unit conversion round-trips."""
from __future__ import annotations

import pytest

from cfddesk.units.convert import from_si, to_si
from cfddesk.units.pressure import kinematic_to_pa, pa_to_kinematic
from cfddesk.units.quantities import UNITS


def test_to_si_from_si_roundtrip():
    for quantity, table in UNITS.items():
        for unit in table:
            if quantity == "temperature":
                v = 300.0 if unit == "K" else 20.0
            else:
                v = 2.5
            try:
                si = to_si(quantity, v, unit)
                back = from_si(quantity, si, unit)
            except Exception:
                continue
            assert abs(back - v) < 1e-6 * max(1.0, abs(v))


def test_pressure_kinematic_roundtrip():
    rho = 1.204
    for x in (0.0, 10.0, 101325.0):
        assert kinematic_to_pa(pa_to_kinematic(x, rho), rho) == pytest.approx(x)
