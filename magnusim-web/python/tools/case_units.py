"""Unit conventions shared by the result exporters.

Incompressible solvers store pressure divided by density (kinematic, m^2/s^2).
The analysis that writes a case lists those fields in its ``w27-case.json``
(``kinematic_fields``, with ``rho``); every result exporter multiplies them by
``rho`` so the viewer shows Pa. Cases written before the analysis recorded the
list are Incompressible Flow's, whose kinematic field is ``p``. Cases without
the file (legacy / mesh-only) fall back to rho = 1, i.e. no scaling.
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


LEGACY_KINEMATIC_FIELDS: tuple[str, ...] = ("p",)
"""The kinematic fields of a case whose sidecar lists none: the rule for cases
written before API 1.1, all by the default analysis (pressure divided by
density). A case written since lists its own (its writer's list, or the
analysis's ``kinematic_fields``, API 1.4); an analysis that declares none and
whose writer lists none also falls back to this.
"""


def case_sidecar(case_dir: Path) -> dict:
    """The case's ``w27-case.json`` as a dict ({} when missing or unreadable)."""
    try:
        doc = json.loads((Path(case_dir) / "w27-case.json").read_text(encoding="utf-8"))
    except Exception:
        return {}
    return doc if isinstance(doc, dict) else {}


def kinematic_fields(case_dir: Path) -> tuple[str, ...]:
    """Fields the case stores divided by density (its analysis's ``kinematic_fields``)."""
    listed = case_sidecar(case_dir).get("kinematic_fields")
    if isinstance(listed, list):
        return tuple(str(x) for x in listed if str(x))
    return LEGACY_KINEMATIC_FIELDS


def field_scale(case_dir: Path, foam_name: str) -> float:
    """Factor from the stored field to what the viewer shows: rho for a kinematic field, else 1."""
    return case_density(case_dir) if foam_name in kinematic_fields(case_dir) else 1.0


def scale_kinematic(dataset, case_dir: Path) -> None:
    """Multiply every kinematic field on ``dataset`` by the case's density, in place.

    A kinematic vector's magnitude (``mag<X>``) already on the dataset is scaled
    with it (a vector such as the wall shear stress).
    """
    names = kinematic_fields(case_dir)
    scale_pressure(dataset, case_density(case_dir), names=(*names, *("mag" + n for n in names)))


def scale_pressure(dataset, rho: float, names) -> None:
    """Multiply the named arrays on a pyvista dataset by ``rho`` in place (point + cell data).

    ``names`` has no default: which fields are kinematic is the case's call
    (``kinematic_fields``), so a caller never assumes ``p``.
    """
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


def pressure_stats_in_pa(stats: dict, rho: float) -> dict:
    """Copy of parsed foam p stats with every pressure value in Pa."""
    out = dict(stats)
    for key in ("pmin", "pmax", "pmean", "uniform_scalar"):
        if out.get(key) is not None:
            out[key] = float(out[key]) * float(rho)
    for key in ("sample_head", "sample_tail"):
        if isinstance(out.get(key), list):
            out[key] = [float(v) * float(rho) for v in out[key]]
    out["pressure_range_unit"] = PRESSURE_UNIT
    return out


def pressure_meta(rho: float, kinematic: bool = True) -> dict:
    """Where a shown pressure came from; ``kinematic=False`` when the case stores it in Pa."""
    if not kinematic:
        source = PRESSURE_UNIT
    else:
        source = KINEMATIC_UNIT + " x rho" if rho != 1.0 else KINEMATIC_UNIT
    return {
        "pressure_unit": PRESSURE_UNIT,
        "pressure_rho": float(rho),
        "pressure_source": source,
    }
