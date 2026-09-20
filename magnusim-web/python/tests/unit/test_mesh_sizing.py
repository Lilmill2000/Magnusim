
"""Fineness / surface size helpers."""
from __future__ import annotations

import pytest

from cfddesk.mesh.standard_hexcore import standard_surface_size_m
from cfddesk.project.mesh_sizing import clamp_fineness


def test_standard_surface_size_at_ref():
    assert standard_surface_size_m(0.032, 5) == pytest.approx(0.240e-3)


def test_f_scaling():
    h5 = standard_surface_size_m(0.032, 5)
    for f in range(1, 11):
        assert standard_surface_size_m(0.032, f) == pytest.approx(h5 * 2 ** ((5 - f) / 3))


def test_clamp_fineness():
    assert clamp_fineness(0) == 1
    assert clamp_fineness(99) == 10
    assert clamp_fineness(5) == 5
