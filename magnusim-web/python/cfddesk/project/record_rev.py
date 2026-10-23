"""A record's revision (``rev``), as scripts/record-rev.js keeps it (Assistant phase 5, C2).

A write that changes a record sets ``rev`` to the stored rev + 1 (1 for a new record); a
write that changes nothing keeps it. A save may carry ``base_rev``, the rev it read: when
that is not the stored rev the save is refused (:class:`StaleRecordError`, the worker's
-32012, which the app server answers 409 ``stale_record``). ``base_rev`` is never stored.
Writers that only report on a record (a mesh's result, a run's status) keep the stored rev.
"""

from __future__ import annotations

import json
from typing import Any

STALE_RECORD_TEXT = "This was changed elsewhere."
STALE_RECORD_RPC = -32012

# Keys that are not the record's content: a write that changes only these changes nothing.
_NOT_CONTENT = frozenset({"rev", "base_rev", "updated_at", "dir", "folder"})


class StaleRecordError(Exception):
    """A save made from an older copy than the stored record."""

    def __init__(self, kind: str, item_id: str, rev: int) -> None:
        super().__init__(STALE_RECORD_TEXT)
        self.kind = kind
        self.id = str(item_id or "")
        self.rev = int(rev)

    def data(self) -> dict[str, Any]:
        return {"code": "stale_record", "kind": self.kind, "id": self.id, "rev": self.rev}


def record_rev(rec: Any) -> int:
    """A stored record's rev (0 when it has none, or is not there)."""
    n = rec.get("rev") if isinstance(rec, dict) else None
    return n if isinstance(n, int) and not isinstance(n, bool) and n > 0 else 0


def base_rev_of(rec: Any) -> int | None:
    """The rev a save says it read (``base_rev``, a whole number), or None."""
    n = rec.get("base_rev") if isinstance(rec, dict) else None
    return n if isinstance(n, int) and not isinstance(n, bool) and n >= 0 else None


def check_base_rev(kind: str, item_id: Any, stored: Any, base: int | None) -> None:
    """Raise :class:`StaleRecordError` when ``base`` is given and is not the stored rev."""
    if base is None:
        return
    rev = record_rev(stored)
    if base != rev:
        raise StaleRecordError(kind, str(item_id or ""), rev)


def _content(rec: dict[str, Any]) -> str:
    return json.dumps({k: v for k, v in rec.items() if k not in _NOT_CONTENT}, sort_keys=True, default=str)


def same_content(nxt: dict[str, Any], on_disk: dict[str, Any] | None) -> bool:
    """True when ``nxt`` holds what ``on_disk`` holds (rev, base_rev and updated_at aside)."""
    return isinstance(on_disk, dict) and _content(nxt) == _content(on_disk)


def stamp_rev(bound: dict[str, Any], on_disk: dict[str, Any] | None, *, bump: bool = True) -> dict[str, Any]:
    """Stamp a record about to be written (in place); see the module docstring."""
    bound.pop("base_rev", None)
    prev = record_rev(on_disk)
    if not bump:
        if prev > 0:
            bound["rev"] = prev
        else:
            bound.pop("rev", None)
        return bound
    bound["rev"] = prev if (on_disk is not None and prev > 0 and same_content(bound, on_disk)) else prev + 1
    return bound


def first_stale(kind: str, stored: list[dict[str, Any]], sent: list[Any]) -> StaleRecordError | None:
    """The first sent record whose ``base_rev`` is not the stored one of its id, or None."""
    by_id = {str(r.get("id")): r for r in stored if isinstance(r, dict) and r.get("id") is not None}
    for rec in sent:
        if not isinstance(rec, dict) or rec.get("id") in (None, ""):
            continue
        base = base_rev_of(rec)
        if base is None:
            continue
        rev = record_rev(by_id.get(str(rec.get("id"))))
        if base != rev:
            return StaleRecordError(kind, str(rec.get("id")), rev)
    return None
