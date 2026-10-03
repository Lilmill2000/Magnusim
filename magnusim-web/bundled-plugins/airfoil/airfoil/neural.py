"""NeuralFoil: a polar in a fraction of a second from a trained network.

NeuralFoil (MIT, Peter Sharpe) is called through AeroSandbox's
``Airfoil.get_aero_from_neuralfoil``, which adds the compressibility
correction for the Mach number and blends in post-stall behaviour. Both
packages live in the plugin's own environment; they are imported on first use
(a few seconds), which :func:`warm` does when the workspace opens.
"""

from __future__ import annotations

import math
import time
from typing import Any

# SPDX-License-Identifier: GPL-3.0-or-later

MODEL_SIZES = ("xxsmall", "xsmall", "small", "medium", "large", "xlarge", "xxlarge", "xxxlarge")
DEFAULT_MODEL = "xlarge"

_modules: dict[str, Any] = {}


class NeuralFoilMissingError(RuntimeError):
    """NeuralFoil is not installed in this environment."""


def _load() -> tuple[Any, Any, Any]:
    if not _modules:
        try:
            import aerosandbox as asb
            import neuralfoil as nf
            import numpy as np
        except ImportError as exc:
            raise NeuralFoilMissingError(
                f"NeuralFoil is not installed in the Airfoil plugin's environment ({exc}). "
                "Open Settings → Plugins and click Install dependencies."
            ) from None
        _modules.update(np=np, asb=asb, nf=nf)
    return _modules["np"], _modules["asb"], _modules["nf"]


def versions() -> dict[str, str]:
    np, asb, nf = _load()
    return {
        "neuralfoil": str(getattr(nf, "__version__", "")),
        "aerosandbox": str(getattr(asb, "__version__", "")),
        "numpy": str(getattr(np, "__version__", "")),
    }


def _round(v: Any) -> float | None:
    f = float(v)
    if not math.isfinite(f):
        return None
    return float(f"{f:.6g}")


def evaluate(
    name: str,
    x: list[float],
    y: list[float],
    alphas: list[float],
    conditions: dict[str, float],
    model_size: str = DEFAULT_MODEL,
) -> list[dict[str, float | None]]:
    """One row per α: cl, cd, cm, cl_cd, confidence (0 to 1), xtr_top, xtr_bottom."""
    if model_size not in MODEL_SIZES:
        raise ValueError(f"Unknown NeuralFoil model {model_size!r}.")
    np, asb, _nf = _load()
    foil = asb.Airfoil(name=name, coordinates=np.column_stack([np.asarray(x, dtype=float), np.asarray(y, dtype=float)]))
    aero = foil.get_aero_from_neuralfoil(
        alpha=np.asarray(alphas, dtype=float),
        Re=float(conditions["re"]),
        mach=float(conditions["mach"]),
        n_crit=float(conditions["ncrit"]),
        xtr_upper=float(conditions["xtr_top"]),
        xtr_lower=float(conditions["xtr_bottom"]),
        model_size=model_size,
    )

    def column(key: str) -> list[Any]:
        values = aero.get(key)
        if values is None:
            return [math.nan] * len(alphas)
        arr = np.broadcast_to(np.asarray(values, dtype=float).reshape(-1), (len(alphas),))
        return [float(v) for v in arr]

    cl, cd, cm = column("CL"), column("CD"), column("CM")
    conf, xt, xb = column("analysis_confidence"), column("Top_Xtr"), column("Bot_Xtr")
    rows: list[dict[str, float | None]] = []
    for i, a in enumerate(alphas):
        rows.append(
            {
                "alpha": float(a),
                "cl": _round(cl[i]),
                "cd": _round(cd[i]),
                "cm": _round(cm[i]),
                "cl_cd": _round(cl[i] / cd[i]) if cd[i] and math.isfinite(cd[i]) else None,
                "confidence": _round(conf[i]),
                "xtr_top": _round(xt[i]),
                "xtr_bottom": _round(xb[i]),
            }
        )
    return rows


def warm() -> dict[str, Any]:
    """Import NeuralFoil and run one point, so the first real polar is quick."""
    t0 = time.perf_counter()
    _load()
    imported = time.perf_counter() - t0
    from airfoil import naca  # local: keeps this module's import light

    sec = naca.generate("0012", 41)
    evaluate(
        sec.name,
        sec.x,
        sec.y,
        [0.0],
        {"re": 1e6, "mach": 0.0, "ncrit": 9.0, "xtr_top": 1.0, "xtr_bottom": 1.0},
    )
    return {"import_s": round(imported, 3), "total_s": round(time.perf_counter() - t0, 3), **versions()}
