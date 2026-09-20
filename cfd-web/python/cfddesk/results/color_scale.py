"""Colour scale settings persisted in project.json."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ColorScaleMode = Literal["auto", "manual"]
ColorMapName = Literal["coolwarm", "viridis", "jet", "gray"]

DEFAULT_CMAP: ColorMapName = "coolwarm"


@dataclass
class ColorScale:
    """Lockable colour range for results comparison / presentation."""

    mode: ColorScaleMode = "auto"
    vmin: float | None = None
    vmax: float | None = None
    field: str = "magU"
    cmap: ColorMapName = DEFAULT_CMAP

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "vmin": self.vmin,
            "vmax": self.vmax,
            "field": self.field,
            "cmap": self.cmap,
        }

    @staticmethod
    def from_dict(data: dict | None) -> ColorScale:
        if not data:
            return ColorScale()
        mode = data.get("mode", "auto")
        if mode not in ("auto", "manual"):
            mode = "auto"
        vmin = data.get("vmin")
        vmax = data.get("vmax")
        cmap = data.get("cmap", DEFAULT_CMAP)
        if cmap not in ("coolwarm", "viridis", "jet", "gray"):
            cmap = DEFAULT_CMAP
        return ColorScale(
            mode=mode,
            vmin=float(vmin) if vmin is not None else None,
            vmax=float(vmax) if vmax is not None else None,
            field=str(data.get("field", "magU")),
            cmap=cmap,
        )

    def resolve(self, data_min: float, data_max: float) -> tuple[float, float]:
        """Return (vmin, vmax) for rendering."""
        if self.mode == "manual" and self.vmin is not None and self.vmax is not None:
            if self.vmax <= self.vmin:
                return data_min, data_max
            return self.vmin, self.vmax
        return data_min, data_max
