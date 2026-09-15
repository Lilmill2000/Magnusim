"""One JSONL event protocol for mesh and solve jobs (Phase 1 Step 7).

Bash templates echo lines prefixed with ``CFDDESK_EVENT `` followed by a JSON
object. Python tools may also call :func:`emit` directly. Node
``scripts/job-runner.js`` splits stdout by line and relays via
:func:`parse_line`.

Legacy ``W27_*`` / ``CFMESH_*`` markers are NOT required on the new path;
``run_solve`` / progress parsing derive residual/Courant from OpenFOAM lines.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal

EVENT_PREFIX = "CFDDESK_EVENT "

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
    """Print one ``CFDDESK_EVENT`` JSONL line to stdout (flushed)."""
    kind = str(event)
    if kind not in KNOWN_KINDS:
        raise ValueError(f"unknown event kind: {kind!r}")
    payload = {"event": kind, **fields}
    print(EVENT_PREFIX + json.dumps(payload, separators=(",", ":"), ensure_ascii=False), flush=True)


def parse_line(line: str) -> Event | None:
    """Parse a single stdout line into an :class:`Event`, or None if not ours.

    Accepts:
    - ``CFDDESK_EVENT {...}``
    - bare JSON object with an ``event`` key (already-normalized JSONL)
    """
    raw = (line or "").strip()
    if not raw:
        return None
    # Strip optional MPI rank prefix like ``[0] ``
    if raw.startswith("[") and "]" in raw[:8]:
        raw = raw.split("]", 1)[1].lstrip()
    payload_s: str | None = None
    if raw.startswith(EVENT_PREFIX):
        payload_s = raw[len(EVENT_PREFIX) :].strip()
    elif raw.startswith("{") and '"event"' in raw:
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
    return Event(event=kind, fields=fields)  # type: ignore[arg-type]


def event_to_stdout_jsonl(ev: Event) -> None:
    """Write a bare JSON object line (no prefix) — useful for Node relays."""
    print(ev.to_json(), flush=True)
