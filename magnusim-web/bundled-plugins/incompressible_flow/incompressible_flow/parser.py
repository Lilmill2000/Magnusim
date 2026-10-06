"""Incompressible Flow's solver-output parser: the SDK engine, residuals of its fields."""

from __future__ import annotations

import re
from dataclasses import dataclass

from magnusim_sdk.progress import ProgressParser

RESIDUAL_FIELDS = re.compile(
    r"Solving for (Ux|Uy|Uz|p|omega|k|epsilon|nuTilda|R(?:xx|xy|xz|yy|yz|zz)), Initial residual = ([0-9.eE+-]+)"
)


@dataclass
class IncompressibleParser(ProgressParser):
    """Velocity, pressure and turbulence residuals; everything else as ProgressParser."""

    residual_re = RESIDUAL_FIELDS
