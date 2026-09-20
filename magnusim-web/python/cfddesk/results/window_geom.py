"""Persisted results-window geometry (project.json → results.window)."""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_WIDTH = 1000
DEFAULT_HEIGHT = 700


@dataclass
class ResultsWindowGeom:
    x: int | None = None
    y: int | None = None
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT

    def to_dict(self) -> dict:
        return {
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
        }

    @staticmethod
    def from_dict(data: dict | None) -> ResultsWindowGeom:
        if not data:
            return ResultsWindowGeom()
        def _int(key: str, default: int | None) -> int | None:
            v = data.get(key, default)
            if v is None:
                return None
            return int(v)

        w = _int("width", DEFAULT_WIDTH) or DEFAULT_WIDTH
        h = _int("height", DEFAULT_HEIGHT) or DEFAULT_HEIGHT
        return ResultsWindowGeom(
            x=_int("x", None),
            y=_int("y", None),
            width=max(640, w),
            height=max(480, h),
        )
