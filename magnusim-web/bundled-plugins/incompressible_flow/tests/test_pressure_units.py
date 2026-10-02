"""A Pressure BC's value in Pa, by the app's own unit table (magnusim_sdk.units)."""

from __future__ import annotations

import pytest
from magnusim_sdk.units import UNITS

from incompressible_flow.contract import _pressure_pa
from incompressible_flow.writer import pressure_pa

PA = UNITS["pressure"]


@pytest.mark.parametrize("convert", [pressure_pa, _pressure_pa], ids=["writer", "contract"])
@pytest.mark.parametrize(
    ("unit", "factor"),
    [
        ("Pa", 1.0),
        ("", 1.0),
        ("kPa", PA["kPa"]),
        ("bar", PA["bar"]),
        ("psi", PA["psi"]),
        ("inH₂O", PA["inH₂O"]),
        ("inH2O", PA["inH₂O"]),
        ("in H2O", PA["inH₂O"]),
        ("inwc", PA["inH₂O"]),
        ("mmH₂O", PA["mmH₂O"]),
        ("mmH2O", PA["mmH₂O"]),
    ],
)
def test_pressure_in_pa_uses_the_app_factors(convert, unit, factor):
    assert convert({"value": 2.5, "unit": unit}) == 2.5 * factor


def test_the_factors_are_the_apps():
    # The case writer once had psi 6894.757 and inH2O 249.089; the app has these.
    assert pressure_pa({"value": 1, "unit": "psi"}) == 6894.757293168
    assert pressure_pa({"value": 1, "unit": "inH2O"}) == 249.08891


@pytest.mark.parametrize("convert", [pressure_pa, _pressure_pa], ids=["writer", "contract"])
def test_no_number_is_zero(convert):
    for value in (None, "x", float("nan")):
        assert convert({"value": value, "unit": "psi"}) == 0.0
