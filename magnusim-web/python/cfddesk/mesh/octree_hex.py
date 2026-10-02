"""Inside-the-solid test for the Standard hex core (``SolidIn``)."""

from __future__ import annotations

import numpy as np
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.gp import gp_Pnt
from OCP.TopAbs import TopAbs_IN

from cfddesk.cad.step import LoadedSolid


class SolidIn:
    """Cached BRepClass3d queries. ``p`` is metres; classifier is native."""

    def __init__(self, solid: LoadedSolid, scale_to_metres: float) -> None:
        self._scale = float(scale_to_metres)
        if self._scale <= 0:
            raise ValueError(f"invalid scale_to_metres={self._scale}")
        self._clf = BRepClass3d_SolidClassifier(solid.shape)
        self._cache: dict[tuple[int, int, int], bool] = {}

    def inside(self, p: np.ndarray) -> bool:
        key = (
            int(round(float(p[0]) * 1e7)),
            int(round(float(p[1]) * 1e7)),
            int(round(float(p[2]) * 1e7)),
        )
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        self._clf.Perform(
            gp_Pnt(
                float(p[0]) / self._scale,
                float(p[1]) / self._scale,
                float(p[2]) / self._scale,
            ),
            1e-7,
        )
        ok = self._clf.State() == TopAbs_IN
        self._cache[key] = ok
        return ok
