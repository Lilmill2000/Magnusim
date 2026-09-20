"""In-process CAD LRU keyed by (step_path, mtime). Disk VTP remains L2."""

from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
from typing import Any

_LRU_SIZE = 4
_cache: OrderedDict[tuple[str, float], Any] = OrderedDict()


def cache_key(step_path: str | Path) -> tuple[str, float]:
    path = Path(step_path).resolve()
    mtime = path.stat().st_mtime if path.is_file() else 0.0
    return (str(path), mtime)


def get(step_path: str | Path) -> Any | None:
    key = cache_key(step_path)
    if key not in _cache:
        return None
    _cache.move_to_end(key)
    return _cache[key]


def put(step_path: str | Path, shape: Any) -> Any:
    key = cache_key(step_path)
    _cache[key] = shape
    _cache.move_to_end(key)
    while len(_cache) > _LRU_SIZE:
        _cache.popitem(last=False)
    return shape


def clear() -> None:
    _cache.clear()


def load_shape(step_path: str | Path) -> Any:
    hit = get(step_path)
    if hit is not None:
        return hit
    from cfddesk.cad.preview import load_step

    shape = load_step(Path(step_path))
    return put(step_path, shape)
