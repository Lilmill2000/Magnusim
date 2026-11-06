"""Reference tables (``validation/refs/*.csv``): each a CSV whose header lines carry its
citation, where in the source the values are (table, figure, equation), the conditions they
hold for, what kind of value they are, how sure they are and how that was checked, then the
values themselves. A table without its citation, where, conditions, kind or confidence is
refused, so no reference value reaches a result without them.

    # citation: U. Ghia, K. N. Ghia, C. T. Shin (1982), "...", J. Comput. Phys. 48(3):387-411
    # where: Table I, u along the vertical line through the centre (x = 0.5)
    # conditions: ...
    # kind: numerical
    # confidence: SECONDARY
    # checked: ...
    # note: ...
    y,u_re100,u_re1000
    1.0000,1.00000,1.00000
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .model import CONFIDENCE, KINDS, Reference
from .paths import VALIDATION

REFS = VALIDATION / "refs"
REQUIRED = ("citation", "where", "conditions", "kind", "confidence")


@dataclass(frozen=True)
class Table:
    """One reference table: its header (``meta``), its columns and its rows (numbers, or
    text where a cell is not one, ``None`` where it is empty)."""

    name: str
    meta: dict[str, str]
    columns: tuple[str, ...]
    rows: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    def column(self, name: str) -> list[Any]:
        if name not in self.columns:
            raise KeyError(f"{self.name} has no column {name!r} (has: {', '.join(self.columns)})")
        return [r[name] for r in self.rows]

    def value(self, **match: Any) -> float:
        """The ``value`` of the one row whose columns equal ``match`` (``re=100, quantity="u_min"``)."""
        hits = [r for r in self.rows if all(_same(r.get(k), v) for k, v in match.items())]
        if len(hits) != 1:
            raise KeyError(f"{self.name}: {len(hits)} rows match {match}")
        return float(hits[0]["value"])

    def row(self, **match: Any) -> dict[str, Any]:
        hits = [r for r in self.rows if all(_same(r.get(k), v) for k, v in match.items())]
        if len(hits) != 1:
            raise KeyError(f"{self.name}: {len(hits)} rows match {match}")
        return hits[0]

    def reference(self, value: float, *, unit: str = "", where: str = "", conditions: str = "",
                  note: str = "") -> Reference:
        """A Reference for one of the table's values, carrying the table's citation, where
        (with the file's name, so the value can be traced), conditions, kind and confidence."""
        bits = [self.meta.get("note", ""), note]
        return Reference(
            value=float(value),
            unit=unit,
            kind=self.meta["kind"],
            confidence=self.meta["confidence"],
            citation=self.meta["citation"],
            where=f"{where or self.meta['where']} (validation/refs/{self.name})",
            conditions=conditions or self.meta["conditions"],
            note=" ".join(b.strip() for b in bits if b and b.strip()),
        )


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return float(a) == float(b)
    return str(a) == str(b)


def _cell(text: str) -> Any:
    s = text.strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return s


def parse(text: str, name: str = "<text>") -> Table:
    """A reference table from its CSV text; raises when its header lacks what a reference needs."""
    meta: dict[str, str] = {}
    body: list[str] = []
    for line in text.replace("\r\n", "\n").split("\n"):
        if line.startswith("#"):
            key, sep, val = line[1:].partition(":")
            if not sep:
                raise ValueError(f"{name}: header line {line!r} is not '# key: value'")
            meta[key.strip()] = val.strip()
        elif line.strip():
            body.append(line)
    missing = [k for k in REQUIRED if not meta.get(k)]
    if missing:
        raise ValueError(f"{name}: no {', '.join(missing)} in its header")
    if meta["kind"] not in KINDS:
        raise ValueError(f"{name}: kind {meta['kind']!r} is not one of {KINDS}")
    if meta["confidence"] not in CONFIDENCE:
        raise ValueError(f"{name}: confidence {meta['confidence']!r} is not one of {CONFIDENCE}")
    reader = csv.reader(io.StringIO("\n".join(body)))
    rows_raw = list(reader)
    if not rows_raw:
        raise ValueError(f"{name}: no columns")
    columns = tuple(c.strip() for c in rows_raw[0])
    rows = []
    for raw in rows_raw[1:]:
        if len(raw) != len(columns):
            raise ValueError(f"{name}: row {raw} has {len(raw)} cells, the header {len(columns)}")
        rows.append({c: _cell(v) for c, v in zip(columns, raw, strict=True)})
    return Table(name=name, meta=meta, columns=columns, rows=tuple(rows))


def read(name: str, root: Path = REFS) -> Table:
    """``refs/<name>`` as a Table."""
    path = root / name
    return parse(path.read_text(encoding="utf-8"), name)
