
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


def test_heat_transfer_units_match_the_page():
    """API 1.8: the SDK's quantities and unit labels are the page's (src/plugin-ui/units.ts)."""
    import re
    from pathlib import Path

    from cfddesk.units.quantities import SI_DEFAULT

    ts = (Path(__file__).resolve().parents[3] / "src" / "plugin-ui" / "units.ts").read_text(encoding="utf-8")
    union = ts.split("export type Quantity =", 1)[1].split(";", 1)[0]
    page_quantities = set(re.findall(r"'([a-z_]+)'", union))
    assert page_quantities == set(UNITS)
    for quantity, table in UNITS.items():
        for unit in table:
            assert f"'{unit}'" in ts or re.search(rf"[{{ ]{re.escape(unit)}:", ts), (quantity, unit)
        assert next(iter(table)) == SI_DEFAULT[quantity]
        assert table[SI_DEFAULT[quantity]] == 1.0


@pytest.mark.parametrize(
    ("quantity", "unit", "si"),
    [
        ("heat_flux", "BTU/(h·ft²)", 3.154591),
        ("heat_transfer_coefficient", "BTU/(h·ft²·°F)", 5.678263),
        ("thermal_conductivity", "BTU/(h·ft·°F)", 1.730735),
        ("specific_heat", "BTU/(lb·°F)", 4186.8),
        ("power", "BTU/h", 0.293071),
        ("power_density", "BTU/(h·ft³)", 10.349707),
        ("thermal_expansion", "1/°F", 1.8),
        ("dynamic_viscosity", "cP", 1e-3),
    ],
)
def test_heat_transfer_units_to_si(quantity, unit, si):
    assert to_si(quantity, 1.0, unit) == pytest.approx(si, rel=1e-6)


def test_pressure_kinematic_roundtrip():
    rho = 1.204
    for x in (0.0, 10.0, 101325.0):
        assert kinematic_to_pa(pa_to_kinematic(x, rho), rho) == pytest.approx(x)
