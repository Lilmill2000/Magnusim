"""One JSONL event protocol for mesh and solve jobs (Phase 1 Step 7).

Bash templates echo lines prefixed with ``MAGNUSIM_EVENT `` followed by a JSON
object (``CFDDESK_EVENT `` is still accepted as an alias). Python tools may
also call :func:`emit` directly. Node ``scripts/job-runner.js`` splits stdout
by line and relays via :func:`parse_line`.

Legacy ``W27_*`` / ``CFMESH_*`` markers are NOT required on the new path;
``run_solve`` / progress parsing derive residual/Courant from OpenFOAM lines.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal

# Prefer Magnusim branding; keep CFDDESK_EVENT as parse/emit alias for mid-flight.
EVENT_PREFIX = "MAGNUSIM_EVENT "
EVENT_PREFIX_ALIASES = ("MAGNUSIM_EVENT ", "CFDDESK_EVENT ")

EventKind = Literal[
    "start",
    "stage",
    "progress",
    "log",
    "residual",
    "courant",
    "time_saved",
    "counts",
    "result",
    "error",
]

KNOWN_KINDS = frozenset(
    {
        "start",
        "stage",
        "progress",
        "log",
        "residual",
        "courant",
        "time_saved",
        "counts",
        "result",
        "error",
    }
)


@dataclass
class Event:
    """One job protocol event. Extra fields ride in ``fields``."""

    event: EventKind
    fields: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"event": self.event}
        out.update(self.fields)
        return out

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), separators=(",", ":"), ensure_ascii=False)


def emit(event: str, **fields: Any) -> None:
    """Print one ``MAGNUSIM_EVENT`` JSONL line to stdout (flushed)."""
    kind = str(event)
    if kind not in KNOWN_KINDS:
        raise ValueError(f"unknown event kind: {kind!r}")
    payload = {"event": kind, **fields}
    print(EVENT_PREFIX + json.dumps(payload, separators=(",", ":"), ensure_ascii=False), flush=True)


def parse_line(line: str) -> Event | None:
    """Parse a single stdout line into an :class:`Event`, or None if not ours.

    Accepts:
    - ``MAGNUSIM_EVENT {...}`` (preferred)
    - ``CFDDESK_EVENT {...}`` (alias)
    - bare JSON object with an ``event`` key (already-normalized JSONL)
    """
    raw = (line or "").strip()
    if not raw:
        return None
    # Strip optional MPI rank prefix like ``[0] ``
    if raw.startswith("[") and "]" in raw[:8]:
        raw = raw.split("]", 1)[1].lstrip()
    payload_s: str | None = None
    for prefix in EVENT_PREFIX_ALIASES:
        if raw.startswith(prefix):
            payload_s = raw[len(prefix) :].strip()
            break
    if payload_s is None and raw.startswith("{") and '"event"' in raw:
        payload_s = raw
    if not payload_s:
        return None
    try:
        data = json.loads(payload_s)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    kind = data.get("event")
    if kind not in KNOWN_KINDS:
        return None
    fields = {k: v for k, v in data.items() if k != "event"}
    return Event(event=kind, fields=fields)


def event_to_stdout_jsonl(ev: Event) -> None:
    """Write a bare JSON object line (no prefix) — useful for Node relays."""
    print(ev.to_json(), flush=True)
