"""The plan of one run (``plan.json``): the geometry file and its face table, and every request
the driver sends to the app, with the face labels resolved from the app's own face table.

A plan is the same every time for the same case, variant and options (the STEP's header
time stamp is fixed), so a change in it shows in a diff. The driver adds the run's time
to the project's title.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import ModuleType
from typing import Any

from . import SCHEMA_PLAN
from .faces import face_table, resolve
from .geometry import write_step

GEOMETRY_FILE = "geometry.step"
PLAN_FILE = "plan.json"


def _fill_faces(obj: Any, labels: dict[str, list[str]]) -> Any:
    """``obj`` with every ``"faces": ["@<selector>", ...]`` replaced by the labels the selectors
    resolved to."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "faces" and isinstance(v, list) and all(isinstance(s, str) and s.startswith("@") for s in v):
                faces: list[str] = []
                for s in v:
                    faces.extend(labels[s[1:]])
                out[k] = faces
            else:
                out[k] = _fill_faces(v, labels)
        return out
    if isinstance(obj, list):
        return [_fill_faces(v, labels) for v in obj]
    return obj


def make_plan(case: ModuleType, variant: str, out_dir: Path, *, coarse: bool = False, cores: int = 4) -> dict[str, Any]:
    """Build the case's geometry in ``out_dir`` and write ``plan.json`` there; return the plan."""
    if variant not in case.VARIANTS:
        raise ValueError(f"{case.ID} has no variant {variant!r} (has: {', '.join(case.VARIANTS)})")
    out_dir.mkdir(parents=True, exist_ok=True)
    step = out_dir / GEOMETRY_FILE
    sha = write_step(case.build_geometry(), step)
    rows = face_table(step)
    selectors = case.FACE_SELECTORS
    labels = resolve(rows, selectors)
    body = case.requests(variant, coarse=coarse, cores=cores)
    plan: dict[str, Any] = {
        "schema": SCHEMA_PLAN,
        "case": case.ID,
        "variant": variant,
        "title": f"{case.TITLE}, {case.VARIANT_LABELS[variant]}",
        "coarse": bool(coarse),
        "geometry": {
            "file": GEOMETRY_FILE,
            "sha256": sha,
            "units": "mm",
            "builder": case.GEOMETRY_WORDS,
            "faces": rows,
            "selectors": selectors,
            "labels": labels,
        },
        **_fill_faces(body, labels),
    }
    (out_dir / PLAN_FILE).write_text(json.dumps(plan, indent=1) + "\n", encoding="utf-8", newline="\n")
    return plan


def read_plan(run_dir: Path) -> dict[str, Any]:
    doc = json.loads((run_dir / PLAN_FILE).read_text(encoding="utf-8"))
    if doc.get("schema") != SCHEMA_PLAN:
        raise ValueError(f"{run_dir / PLAN_FILE} is not a {SCHEMA_PLAN} plan")
    return doc
