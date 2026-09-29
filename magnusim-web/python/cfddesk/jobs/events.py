"""Job event protocol: one copy, in :mod:`magnusim_sdk.events`."""

from magnusim_sdk.events import (  # noqa: F401
    EVENT_PREFIX,
    EVENT_PREFIX_ALIASES,
    KNOWN_KINDS,
    Event,
    EventKind,
    emit,
    event_to_stdout_jsonl,
    parse_line,
)
