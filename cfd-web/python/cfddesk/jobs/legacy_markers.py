"""Optional CFMESH_* dual-emit for one-phase frontend compat (Step 7).

Shared by generate_standard / generate_cfmesh_standard / generate_snappy so
_progress/_result/_LEGACY_MARKERS are not copy-pasted thrice.
"""
from __future__ import annotations

import json
from typing import Any

from cfddesk.jobs.events import emit

_LEGACY_MARKERS = False


def set_legacy_markers(enabled: bool) -> None:
    global _LEGACY_MARKERS
    _LEGACY_MARKERS = bool(enabled)


def legacy_enabled() -> bool:
    return _LEGACY_MARKERS


def progress(stage: str, **extra: Any) -> None:
    payload = {"stage": stage, **extra}
    emit("progress", **payload)
    if _LEGACY_MARKERS:
        print("CFMESH_PROGRESS " + json.dumps(payload, separators=(",", ":")), flush=True)


def result(ok: bool, **extra: Any) -> int:
    payload = {"ok": bool(ok), **extra}
    emit("result", **payload)
    if _LEGACY_MARKERS:
        print("CFMESH_RESULT " + json.dumps(payload, separators=(",", ":")), flush=True)
    return 0 if ok else 1
