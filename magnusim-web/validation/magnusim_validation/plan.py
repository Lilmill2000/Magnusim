"""The plan of one run (``plan.json``): the geometry file and its face table, and every request
the driver sends to the app, with the face labels resolved from the app's own face table.

A plan is the same every time for the same case, variant and options (the STEP's header
time stamp is fixed), so a change in it shows in a diff. The driver adds the run's time
to the project's title. A Hex-dominant plan also carries what its mesh will be
(``mesh.estimate``, mesh_plan.py), worked out with the mesher's own sizing functions.

A variant the case says may use another's mesh (``MESH_FROM``: two turbulence models on one
mesh) carries ``mesh_from`` (that variant and this plan's ``mesh_key``, a hash of its geometry,
fluid, BCs and mesh): the driver reuses the other run's mesh only when its plan has the same
key, else this run meshes its own.

Mesh or study settings given on the command line (``--mesh-settings``, ``--study-settings``: a
development probe) are merged into the case's own and recorded under ``overrides``; such a
plan's runs go to ``results-probe/`` and never into the report.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import ModuleType
from typing import Any

from . import SCHEMA_PLAN
from .faces import face_table, resolve
from .geometry import write_step
from .mesh_plan import estimate, shape_bounds_and_volume

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


def merge_settings(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    """``base`` with ``over``'s keys set (nested objects key by key)."""
    out = dict(base)
    for k, v in over.items():
        out[k] = merge_settings(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def make_plan(case: ModuleType, variant: str, out_dir: Path, *, coarse: bool = False, cores: int = 4,
              mesh_settings: dict[str, Any] | None = None,
              study_settings: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build the case's geometry in ``out_dir`` and write ``plan.json`` there; return the plan."""
    if variant not in case.VARIANTS:
        raise ValueError(f"{case.ID} has no variant {variant!r} (has: {', '.join(case.VARIANTS)})")
    out_dir.mkdir(parents=True, exist_ok=True)
    step = out_dir / GEOMETRY_FILE
    # A case whose variants differ in geometry builds, selects and words it per variant.
    per_variant = hasattr(case, "build_geometry_for")
    shape = case.build_geometry_for(variant) if per_variant else case.build_geometry()
    sha = write_step(shape, step)
    rows = face_table(step)
    selectors = case.face_selectors(variant) if per_variant else case.FACE_SELECTORS
    labels = resolve(rows, selectors)
    body = case.requests(variant, coarse=coarse, cores=cores)
    overrides: dict[str, Any] = {}
    if mesh_settings:
        body["mesh"]["settings"] = merge_settings(body["mesh"]["settings"], mesh_settings)
        overrides["mesh_settings"] = mesh_settings
        # Layers turned off by hand and none asked face by face: the probe expects none.
        inflated = any(str(r.get("type") or "").lower() == "inflate boundary layer"
                       for r in body["mesh"].get("refinements") or [])
        if body["mesh"]["settings"].get("automatic_boundary_layers") is False and not inflated:
            body["mesh"].setdefault("expect", {})["layers"] = False
    if study_settings:
        body["study"]["settings"] = merge_settings(body["study"]["settings"], study_settings)
        overrides["study_settings"] = study_settings
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
            "builder": case.geometry_words(variant) if per_variant else case.GEOMETRY_WORDS,
            "faces": rows,
            "selectors": selectors,
            "labels": labels,
        },
        **_fill_faces(body, labels),
    }
    if overrides:
        plan["overrides"] = overrides
    plan["mesh_key"] = mesh_key(plan)
    src = (getattr(case, "MESH_FROM", None) or {}).get(variant)
    if src:
        plan["mesh_from"] = {"variant": src, "key": plan["mesh_key"]}
    bounds_mm, volume_mm3 = shape_bounds_and_volume(shape)
    est = estimate(plan["mesh"], rows, bounds_mm, volume_mm3)
    if est is not None:
        plan["mesh"]["estimate"] = est
    (out_dir / PLAN_FILE).write_text(json.dumps(plan, indent=1) + "\n", encoding="utf-8", newline="\n")
    return plan


def mesh_key(plan: dict[str, Any]) -> str:
    """A hash of what a plan's mesh depends on and what its solve shares with it: the geometry,
    the study's kind, the fluid, the BCs and the mesh (its settings and refinements)."""
    mesh = plan.get("mesh") or {}
    doc = {
        "geometry": (plan.get("geometry") or {}).get("sha256"),
        "study": {k: (plan.get("study") or {}).get(k) for k in ("analysis_type", "time_dependency")},
        "material": plan.get("material"),
        "bcs": plan.get("bcs"),
        "mesh": {k: mesh.get(k) for k in ("name", "settings", "refinements")},
    }
    return hashlib.sha256(json.dumps(doc, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def read_plan(run_dir: Path) -> dict[str, Any]:
    doc = json.loads((run_dir / PLAN_FILE).read_text(encoding="utf-8"))
    if doc.get("schema") != SCHEMA_PLAN:
        raise ValueError(f"{run_dir / PLAN_FILE} is not a {SCHEMA_PLAN} plan")
    return doc
