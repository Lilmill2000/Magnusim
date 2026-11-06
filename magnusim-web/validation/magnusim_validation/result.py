"""``result.json`` (schema ``magnusim-validation-result/1``): its shape is checked before it is
written and again when the report reads it. A compared quantity without its reference's
citation, its source or how it was measured is refused."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from . import SCHEMA_RESULT

STATUSES = ("ok", "setup_failed", "mesh_failed", "layers_not_applied", "solve_failed", "not_settled",
            "extract_failed", "mesh_only")
VERDICTS = ("report_only", "pass", "fail", "missing")
TOP_KEYS = ("schema", "case", "variant", "title", "group", "status", "status_detail", "coarse", "when", "app",
            "setup", "mesh", "precheck", "run", "quantities", "series", "shown", "warnings")
QUANTITY_KEYS = ("key", "label", "unit", "value", "how", "source", "reference", "tolerance", "error", "within",
                 "verdict")
REFERENCE_KEYS = ("value", "kind", "confidence", "citation", "where", "conditions")


def problems(doc: Any) -> list[str]:
    """What is wrong with a result document (an empty list when nothing is)."""
    if not isinstance(doc, dict):
        return ["not a JSON object"]
    out = [f"no {k}" for k in TOP_KEYS if k not in doc]
    if doc.get("schema") != SCHEMA_RESULT:
        out.append(f"schema is {doc.get('schema')!r}, not {SCHEMA_RESULT!r}")
    if doc.get("status") not in STATUSES:
        out.append(f"status {doc.get('status')!r} is not one of {STATUSES}")
    qs = doc.get("quantities")
    if not isinstance(qs, list) or not qs:
        out.append("no compared quantities")
        return out
    for q in qs:
        name = q.get("key", "?") if isinstance(q, dict) else "?"
        if not isinstance(q, dict):
            out.append("a quantity is not an object")
            continue
        out += [f"{name}: no {k}" for k in QUANTITY_KEYS if k not in q]
        for k in ("how", "source"):
            if not str(q.get(k) or "").strip():
                out.append(f"{name}: empty {k}")
        ref = q.get("reference") or {}
        out += [f"{name}: reference has no {k}" for k in REFERENCE_KEYS if not str(ref.get(k, "")).strip()]
        if q.get("verdict") not in VERDICTS:
            out.append(f"{name}: verdict {q.get('verdict')!r}")
        v = q.get("value")
        if v is not None and not (isinstance(v, (int, float)) and math.isfinite(v)):
            out.append(f"{name}: value {v!r} is not a finite number")
        if v is None and q.get("verdict") != "missing":
            out.append(f"{name}: no value but verdict {q.get('verdict')!r}")
        if doc.get("status") == "ok" and v is None:
            out.append(f"{name}: no value in an ok result")
    return out


def write_result(doc: dict[str, Any], path: Path) -> None:
    bad = problems(doc)
    if bad:
        raise ValueError(f"result.json of {doc.get('case')}/{doc.get('variant')} is not valid: {'; '.join(bad)}")
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def read_result(path: Path) -> dict[str, Any]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    bad = problems(doc)
    if bad:
        raise ValueError(f"{path} is not a valid result: {'; '.join(bad)}")
    return doc
