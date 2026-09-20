"""STEP length-unit resolution — never silent."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.Interface import Interface_Static
from OCP.TopoDS import TopoDS_Shape

# Cascade / native unit name → metres
UNIT_TO_METRES: dict[str, float] = {
    "M": 1.0,
    "METRE": 1.0,
    "METER": 1.0,
    "MM": 0.001,
    "MILLIMETRE": 0.001,
    "MILLIMETER": 0.001,
    "CM": 0.01,
    "INCH": 0.0254,
    "IN": 0.0254,
    "FT": 0.3048,
    "FOOT": 0.3048,
}


@dataclass(frozen=True)
class BBoxReport:
    """Axis-aligned bounds in a stated unit system."""

    xmin: float
    ymin: float
    zmin: float
    xmax: float
    ymax: float
    zmax: float
    unit: str

    @property
    def extents(self) -> tuple[float, float, float]:
        return (self.xmax - self.xmin, self.ymax - self.ymin, self.zmax - self.zmin)

    def scaled(self, factor: float, unit: str) -> BBoxReport:
        return BBoxReport(
            xmin=self.xmin * factor,
            ymin=self.ymin * factor,
            zmin=self.zmin * factor,
            xmax=self.xmax * factor,
            ymax=self.ymax * factor,
            zmax=self.zmax * factor,
            unit=unit,
        )


@dataclass
class UnitResolution:
    """Explicit unit contract for a loaded STEP."""

    path: str
    # Entities found in the STEP text (may be more than one).
    header_length_units: list[str] = field(default_factory=list)
    # Unit referenced by GLOBAL_UNIT_ASSIGNED_CONTEXT length slot, if parsed.
    geometric_context_unit: str | None = None
    # OCCT cascade unit after ReadFile (coordinates on the shape).
    cascade_unit: str = "UNKNOWN"
    # Proposed native→metres factor from cascade_unit (not applied until confirmed).
    proposed_scale_to_metres: float | None = None
    ambiguous: bool = False
    ambiguity_notes: list[str] = field(default_factory=list)
    bbox_native: BBoxReport | None = None
    bbox_metres_proposed: BBoxReport | None = None

    def summary_lines(self) -> list[str]:
        lines = [
            f"STEP: {self.path}",
            f"Header length-unit entities: {', '.join(self.header_length_units) or '(none found)'}",
            f"Geometric context length unit: {self.geometric_context_unit or '(unresolved)'}",
            f"OCCT cascade unit (shape coords): {self.cascade_unit}",
        ]
        if self.proposed_scale_to_metres is not None:
            lines.append(
                f"Proposed scale_to_metres (cascade -> m): {self.proposed_scale_to_metres}"
            )
        else:
            lines.append("Proposed scale_to_metres: UNKNOWN — must choose explicitly")
        if self.bbox_native is not None:
            e = self.bbox_native.extents
            lines.append(
                f"BBox extents ({self.bbox_native.unit}): "
                f"{e[0]:.6g} × {e[1]:.6g} × {e[2]:.6g}"
            )
            lines.append(
                f"BBox min/max ({self.bbox_native.unit}): "
                f"[{self.bbox_native.xmin:.6g}, {self.bbox_native.ymin:.6g}, {self.bbox_native.zmin:.6g}] .. "
                f"[{self.bbox_native.xmax:.6g}, {self.bbox_native.ymax:.6g}, {self.bbox_native.zmax:.6g}]"
            )
        if self.bbox_metres_proposed is not None:
            e = self.bbox_metres_proposed.extents
            lines.append(
                f"BBox extents (m, proposed): {e[0]:.6g} × {e[1]:.6g} × {e[2]:.6g}"
            )
        if self.ambiguous:
            lines.append("AMBIGUOUS — do not infer silently:")
            lines.extend(f"  - {n}" for n in self.ambiguity_notes)
        return lines


def _normalize_unit_token(token: str) -> str:
    t = token.strip().upper().replace(".", "")
    aliases = {
        "MILLI METRE": "MM",
        "MILLIMETRE": "MM",
        "MILLIMETER": "MM",
        "METRE": "M",
        "METER": "M",
        "INCH": "INCH",
        "IN": "INCH",
    }
    return aliases.get(t, t)


def parse_step_header_units(path: Path) -> tuple[list[str], str | None, list[str]]:
    """Parse length-unit clues from STEP text.

    Returns (all_length_unit_labels, geometric_context_unit_or_None, notes).
    """
    text = path.read_text(encoding="utf-8", errors="replace")
    notes: list[str] = []
    found: list[str] = []

    # SI length units: SI_UNIT(.MILLI.,.METRE.) or SI_UNIT($,.METRE.)
    for m in re.finditer(
        r"SI_UNIT\s*\(\s*([^,)]*)\s*,\s*\.METRE\.\s*\)", text, flags=re.IGNORECASE
    ):
        prefix = m.group(1).strip().upper().replace(".", "")
        if prefix in ("MILLI",):
            label = "MM (SI_UNIT MILLI METRE)"
        elif prefix in ("", "$", "NONE"):
            label = "M (SI_UNIT METRE)"
        else:
            label = f"SI_UNIT({prefix},METRE)"
        if label not in found:
            found.append(label)

    # Conversion-based (e.g. inch)
    for m in re.finditer(
        r"CONVERSION_BASED_UNIT\s*\(\s*'([^']+)'", text, flags=re.IGNORECASE
    ):
        label = f"{m.group(1)} (CONVERSION_BASED_UNIT)"
        if label not in found:
            found.append(label)

    geometric: str | None = None
    # GLOBAL_UNIT_ASSIGNED_CONTEXT((#len,#ang,#solid)) — resolve first ref if inch/mm/m nearby
    ctx = re.search(
        r"GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\(\s*(#[0-9]+)",
        text,
        flags=re.IGNORECASE,
    )
    if ctx:
        ref = ctx.group(1)
        # Find entity block starting with that id
        ent = re.search(
            rf"{re.escape(ref)}\s*=\s*\((.*?)\)\s*;",
            text,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if ent:
            block = ent.group(1)
            if re.search(r"CONVERSION_BASED_UNIT\s*\(\s*'inch'", block, re.I):
                geometric = "INCH"
            elif re.search(r"SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.", block, re.I):
                geometric = "MM"
            elif re.search(r"SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.", block, re.I):
                geometric = "M"
            else:
                notes.append(
                    f"GLOBAL_UNIT_ASSIGNED_CONTEXT length ref {ref} not classified from block"
                )
        else:
            notes.append(f"Could not resolve entity {ref} for geometric context unit")
    else:
        notes.append("No GLOBAL_UNIT_ASSIGNED_CONTEXT found in STEP text")

    return found, geometric, notes


def cascade_unit_name() -> str:
    raw = Interface_Static.CVal_s("xstep.cascade.unit") or ""
    raw = raw.strip().upper()
    return raw if raw else "UNKNOWN"


def shape_bbox(shape: TopoDS_Shape, unit: str) -> BBoxReport:
    """Axis-aligned bbox from exact BRep geometry (not triangulation).

    ``BRepBndLib.Add(..., useTriangulation=True)`` (OCCT default) switches to
    the face mesh when one exists and enlarges by deflection + tolerance, so the
    box grows after any ``tessellate_faces`` / STL export remesh. Downstream
    blockMesh extents, auto ``locationInMesh``, and relative mesh deflection
    then become order-dependent. ``useTriangulation=False`` forces the geometry
    branch and is stable across tessellation (verified on Manual cyclone STEP).

    ``AddOptimal`` with triangulation off is also stable but returns a slightly
    tighter box than unmeshed ``Add``; we keep ``Add`` so load-time
    ``UnitResolution.bbox_native`` and later live queries stay on the same
    algorithm the app has always used for an unmeshed STEP.
    """
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box, False)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    return BBoxReport(xmin, ymin, zmin, xmax, ymax, zmax, unit=unit)


def resolve_units(path: str | Path, shape: TopoDS_Shape) -> UnitResolution:
    """Report declared + cascade units and proposed scale; flag ambiguity."""
    path = Path(path).resolve()
    header_units, geometric, parse_notes = parse_step_header_units(path)
    cascade = cascade_unit_name()
    cascade_key = _normalize_unit_token(cascade)

    res = UnitResolution(
        path=str(path),
        header_length_units=header_units,
        geometric_context_unit=geometric,
        cascade_unit=cascade,
        ambiguity_notes=list(parse_notes),
    )

    # Distinct unit *kinds* in header (ignore SI mm used only as inch conversion factor)
    kinds = set()
    for label in header_units:
        low = label.lower()
        if "inch" in low:
            kinds.add("INCH")
        elif "milli" in low or label.startswith("MM"):
            kinds.add("MM")
        elif label.startswith("M ") or label == "M (SI_UNIT METRE)":
            kinds.add("M")

    if len(kinds) > 1:
        res.ambiguous = True
        res.ambiguity_notes.append(
            f"Multiple length-unit kinds in STEP text: {sorted(kinds)}"
        )

    if geometric and cascade_key not in ("UNKNOWN",) and geometric != cascade_key:
        # Common & expected when STEP is inch and OCCT cascades to MM — still surface it.
        res.ambiguous = True
        res.ambiguity_notes.append(
            f"Geometric context unit is {geometric} but OCCT cascade unit is {cascade} "
            f"(shape coordinates are in {cascade}). Confirm which scale applies."
        )

    scale = UNIT_TO_METRES.get(cascade_key)
    res.proposed_scale_to_metres = scale
    if scale is None:
        res.ambiguous = True
        res.ambiguity_notes.append(
            f"No known metres factor for cascade unit '{cascade}' — choose scale explicitly"
        )

    res.bbox_native = shape_bbox(shape, unit=cascade if cascade != "UNKNOWN" else "native")
    if scale is not None:
        res.bbox_metres_proposed = res.bbox_native.scaled(scale, unit="m")

    return res


def scale_factor_for_unit(unit: str) -> float | None:
    return UNIT_TO_METRES.get(_normalize_unit_token(unit))
