"""Unit conventions shared by the result exporters.

simpleFoam solves kinematic pressure (m^2/s^2). Every result exporter turns
that into static gauge pressure in Pa by multiplying with the fluid density
recorded in the run's ``w27-case.json`` (``rho``). Cases without that file
(legacy / mesh-only) fall back to rho = 1, i.e. no scaling.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

PRESSURE_UNIT = "Pa"
KINEMATIC_UNIT = "m^2/s^2"


def case_density(case_dir: Path) -> float:
    """Density (kg/m^3) used to convert kinematic p to Pa; 1.0 when unknown."""
    try:
        doc = json.loads((Path(case_dir) / "w27-case.json").read_text(encoding="utf-8"))
        rho = float(doc.get("rho") or 0.0)
        if rho > 0 and np.isfinite(rho):
            return rho
    except Exception:
        pass
    return 1.0


def scale_pressure(dataset, rho: float, names=("p",)) -> None:
    """Multiply pressure arrays on a pyvista dataset in place (point + cell data)."""
    if dataset is None or rho == 1.0:
        return
    for attr in ("point_data", "cell_data"):
        data = getattr(dataset, attr, None)
        if data is None:
            continue
        for name in names:
            if name in data:
                arr = np.asarray(data[name], dtype=np.float64)
                data[name] = arr * float(rho)


def pressure_meta(rho: float) -> dict:
    return {
        "pressure_unit": PRESSURE_UNIT,
        "pressure_rho": float(rho),
        "pressure_source": KINEMATIC_UNIT + " x rho" if rho != 1.0 else KINEMATIC_UNIT,
    }
