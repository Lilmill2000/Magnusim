"""Unit tests for cfddesk.jobs.events JSONL protocol."""
from __future__ import annotations

import json

import pytest

from cfddesk.jobs.events import EVENT_PREFIX, Event, emit, parse_line


def test_parse_prefixed_event():
    line = EVENT_PREFIX + json.dumps({"event": "stage", "stage": "decompose"})
    ev = parse_line(line)
    assert ev is not None
    assert ev.event == "stage"
    assert ev.fields["stage"] == "decompose"


def test_parse_bare_json():
    ev = parse_line('{"event":"result","ok":true,"exit_code":0}')
    assert ev is not None
    assert ev.event == "result"
    assert ev.fields["ok"] is True
    assert ev.fields["exit_code"] == 0


def test_parse_mpi_prefix():
    line = "[0] " + EVENT_PREFIX + '{"event":"log","line":"hi"}'
    ev = parse_line(line)
    assert ev is not None
    assert ev.fields["line"] == "hi"


def test_parse_non_event_returns_none():
    assert parse_line("Time = 1") is None
    assert parse_line("W27_RUN_START foo") is None
    assert parse_line("") is None
    assert parse_line("CFDDESK_EVENT not-json") is None


def test_parse_unknown_kind_returns_none():
    assert parse_line(EVENT_PREFIX + '{"event":"nope"}') is None


def test_emit_roundtrip(capsys):
    emit("progress", time=3.0, stage="solve")
    out = capsys.readouterr().out.strip()
    assert out.startswith(EVENT_PREFIX)
    ev = parse_line(out)
    assert ev is not None
    assert ev.event == "progress"
    assert ev.fields["time"] == 3.0


def test_emit_rejects_unknown():
    with pytest.raises(ValueError):
        emit("not_a_real_event")


def test_event_to_json_compact():
    ev = Event(event="time_saved", fields={"t": 10.0})
    s = ev.to_json()
    assert "event" in s and "time_saved" in s
    assert " " not in s  # separators compact
