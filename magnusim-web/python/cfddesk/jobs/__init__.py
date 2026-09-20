"""cfddesk.jobs — JSONL job event protocol (Phase 1 Step 7)."""
from cfddesk.jobs.events import EVENT_PREFIX, Event, emit, parse_line

__all__ = ["EVENT_PREFIX", "Event", "emit", "parse_line"]
