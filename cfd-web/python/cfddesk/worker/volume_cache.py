"""In-process volume LRU so particle traces reuse a loaded mesh."""

from __future__ import annotations

import sys
from collections import OrderedDict
from pathlib import Path
from typing import Any

_LRU_SIZE = 4
_cache: OrderedDict[tuple[str, str, float, int], dict[str, Any]] = OrderedDict()
_pinned: tuple[str, str, float, int] | None = None

_TOOLS = Path(__file__).resolve().parents[2] / "tools"
if str(_TOOLS) not in sys.path:
    sys.path.insert(0, str(_TOOLS))


def _foam_stamp(case_dir: Path, time: str) -> tuple[float, int]:
    best_m = 0.0
    best_n = 0
    for name in ("U", "p"):
        f = case_dir / str(time) / name
        if f.is_file():
            st = f.stat()
            best_m = max(best_m, float(st.st_mtime))
            best_n += int(st.st_size)
    prepared = case_dir / ".cfddesk-prepared.vtu"
    if prepared.is_file():
        st = prepared.stat()
        best_m = max(best_m, float(st.st_mtime))
        best_n += int(st.st_size)
    return best_m, best_n


def _key(case_dir: Path, time: str) -> tuple[str, str, float, int]:
    m, n = _foam_stamp(case_dir, time)
    return (str(case_dir), str(time), m, n)


def cached_count() -> int:
    return len(_cache)


def clear() -> None:
    global _pinned
    _cache.clear()
    _pinned = None


def _pin_key(key: tuple[str, str, float, int]) -> None:
    global _pinned
    _pinned = key


def _evict() -> None:
    while len(_cache) > _LRU_SIZE:
        victim = None
        for cached in _cache:
            if cached != _pinned:
                victim = cached
                break
        if victim is None:
            break
        _cache.pop(victim, None)


def get_prepared(case_dir: str, time: str, *, pin: bool = True) -> dict[str, Any]:
    from case_units import case_density, scale_pressure
    from case_volume import load_volume
    from export_particle_trace import point_data_grid

    case = Path(case_dir).resolve()
    t = str(time or "0")
    key = _key(case, t)
    hit = _cache.get(key)
    if hit is not None:
        _cache.move_to_end(key)
        if pin:
            _pin_key(key)
        return hit

    mesh, source = load_volume(case, t)
    if mesh is None or int(getattr(mesh, "n_cells", 0) or 0) < 1:
        raise RuntimeError(f"volume read failed: {case}")
    # Cutting planes can colour from cell U/magU. Do not throw if the
    # polyhedral convert-to-points step leaves U on cells — that used to
    # skip the LRU and reload the volume on every axis change.
    grid = point_data_grid(mesh)
    slice_src = grid if grid is not None else mesh
    # Bake magU (and scale p) once so live slices skip per-cut promotion.
    try:
        from export_cut_plane import ensure_field

        try:
            ensure_field(slice_src, "magU")
        except Exception:
            pass
        if "p" in getattr(slice_src, "point_data", {}) or "p" in getattr(slice_src, "cell_data", {}):
            try:
                ensure_field(slice_src, "p")
            except Exception:
                pass
    except Exception:
        pass
    if "U" in getattr(slice_src, "point_data", {}) or "p" in getattr(slice_src, "point_data", {}):
        try:
            scale_pressure(slice_src, case_density(case))
        except Exception:
            pass
    if "U" in getattr(slice_src, "point_data", {}):
        try:
            slice_src.set_active_vectors("U")
        except Exception:
            pass
    entry = {
        "mesh": mesh,
        "grid": grid,
        "slice": slice_src,
        "source": source,
        "n_cells": int(getattr(slice_src, "n_cells", 0) or 0),
        "n_points": int(getattr(slice_src, "n_points", 0) or 0),
        "has_point_u": "U" in getattr(slice_src, "point_data", {}),
        "has_cell_u": "U" in getattr(slice_src, "cell_data", {}),
    }
    _cache[key] = entry
    _cache.move_to_end(key)
    if pin:
        _pin_key(key)
    _evict()
    return entry
