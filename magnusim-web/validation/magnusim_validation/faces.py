"""The part's faces as the app numbers them, and the cases' face selectors.

The table is the app's own (``cfddesk.cad.preview.face_properties``: the face-visit rule the
viewport, the face table and the meshers share), so ``face N@Body1`` here is the face the
app calls that. The driver reads the imported geometry's table back from the app and stops
when it differs, so a change in numbering fails loudly instead of putting a BC on the wrong
face.

A selector picks faces by what they are, never by number:

- ``{"plane": {"axis": "x", "at_mm": 0, "sign": -1}}``: the flat faces whose centroid lies
  at ``at_mm`` on ``axis`` and whose outward normal points along ``sign`` on it;
- ``{"surface_type": "Cylinder"}``: the faces of that surface type;
- ``{"rest": true}``: every face the other selectors did not take.

Each selector says how many faces it must find (``count``, default 1 for ``plane``).
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

AXES = {"x": 0, "y": 1, "z": 2}
# How close a centroid must lie to a plane's position (mm), and how parallel a normal must be.
PLANE_TOL_MM = 0.05
NORMAL_MIN = 0.99


def face_table(step: Path) -> list[dict[str, Any]]:
    """The STEP's face table as the app computes it: id, body, area (mm²), centroid (mm),
    outward normal, surface type."""
    from cfddesk.cad.io import read_step_shape
    from cfddesk.cad.preview import face_properties

    rows = face_properties(read_step_shape(step))
    out = []
    for r in rows:
        # Rounded (the kernel's last digits differ between machines): far finer than the
        # driver's comparison with the imported table.
        row = {
            "id": int(r["id"]),
            "body": int(r.get("body") or 1),
            "area_mm2": round(float(r["area"]), 6),
            "centroid_mm": [round(float(v), 6) + 0.0 for v in r["centroid"]],
            "normal": [round(float(v), 9) + 0.0 for v in r["normal"]] if r.get("normal") else None,
            "surface_type": str(r.get("surface_type") or ""),
        }
        if r.get("shared_with"):
            row["shared_with"] = int(r["shared_with"])
        out.append(row)
    return out


def label(row: dict[str, Any]) -> str:
    """The app's face label: ``face N@BodyB``."""
    return f"face {int(row['id'])}@Body{int(row.get('body') or 1)}"


def _plane_hit(row: dict[str, Any], axis: int, at_mm: float, sign: int) -> bool:
    n = row.get("normal")
    if not n or row.get("shared_with"):
        return False
    return (
        abs(float(row["centroid_mm"][axis]) - at_mm) <= PLANE_TOL_MM
        and abs(float(n[axis])) >= NORMAL_MIN
        and math.copysign(1.0, float(n[axis])) == float(sign)
    )


def select(rows: list[dict[str, Any]], selector: dict[str, Any], taken: set[int]) -> list[dict[str, Any]]:
    """The rows one selector picks (``taken``: ids other selectors have; only ``rest`` reads it)."""
    if "plane" in selector:
        p = selector["plane"]
        axis = AXES[str(p["axis"])]
        return [r for r in rows if _plane_hit(r, axis, float(p["at_mm"]), int(p["sign"]))]
    if "surface_type" in selector:
        want = str(selector["surface_type"])
        return [r for r in rows if r["surface_type"] == want and not r.get("shared_with")]
    if selector.get("rest"):
        return [r for r in rows if int(r["id"]) not in taken and not r.get("shared_with")]
    raise ValueError(f"unknown face selector {selector!r}")


def resolve(rows: list[dict[str, Any]], selectors: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    """Each named selector's face labels; ``rest`` selectors go last. Raises when a selector
    finds another number of faces than it says, or two selectors take the same face."""
    out: dict[str, list[str]] = {}
    taken: set[int] = set()
    order = sorted(selectors, key=lambda k: 1 if selectors[k].get("rest") else 0)
    for name in order:
        sel = selectors[name]
        hits = select(rows, sel, taken)
        want = sel.get("count", 1 if "plane" in sel else None)
        if want is not None and len(hits) != int(want):
            raise ValueError(f"face selector {name!r} found {len(hits)} faces, not {want}: {sel}")
        if not hits:
            raise ValueError(f"face selector {name!r} found no face: {sel}")
        ids = {int(r["id"]) for r in hits}
        if ids & taken:
            raise ValueError(f"face selector {name!r} takes faces another selector took: {sorted(ids & taken)}")
        taken |= ids
        out[name] = [label(r) for r in sorted(hits, key=lambda r: int(r["id"]))]
    return {k: out[k] for k in selectors}
