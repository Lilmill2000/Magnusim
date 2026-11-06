"""The cases' geometry, built with OCP (the app's own CAD kernel binding) and written as a
STEP in millimetres, the unit its header names and the app imports it in.

The body is the fluid (the internal-flow convention: an external flow is a box with the body
cut out). The STEP's header time stamp is fixed, so a plan is the same file every time.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

# The STEP header's FILE_NAME time stamp, fixed so the file (and its hash) is the same each time.
FIXED_STAMP = "2026-01-01T00:00:00"


def pipe(d_mm: float, l_mm: float) -> Any:
    """A circular pipe (a solid cylinder, the fluid) of diameter ``d_mm`` and length ``l_mm``
    along +x from the origin, centred on the x axis: three faces, the inlet disc at x = 0
    (outward normal -x), the outlet disc at x = L (+x) and the wall."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), d_mm / 2.0, l_mm).Shape()


def box(x_mm: float, y_mm: float, z_mm: float) -> Any:
    """A box (the fluid) from the origin to (``x_mm``, ``y_mm``, ``z_mm``): six flat faces, one
    at each end of each axis."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), gp_Pnt(x_mm, y_mm, z_mm)).Shape()


def fix_header_stamp(text: str) -> str:
    """The STEP text without what changes from one write to the next: its FILE_NAME time
    stamp (``FIXED_STAMP``) and the writer's per-process count in the product's name."""
    text = re.sub(r"(FILE_NAME\('[^']*',')[^']*(')", rf"\g<1>{FIXED_STAMP}\g<2>", text, count=1)
    return re.sub(r"(Open CASCADE STEP translator [0-9.]+) \d+'", r"\g<1>'", text)


def write_step(shape: Any, path: Path) -> str:
    """Write ``shape`` as a STEP in millimetres at ``path``; return its sha256."""
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    path.parent.mkdir(parents=True, exist_ok=True)
    w = STEPControl_Writer()
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    w.Transfer(shape, STEPControl_AsIs)
    tmp = path.with_suffix(".tmp.step")
    if int(w.Write(str(tmp))) != 1:
        raise RuntimeError(f"could not write {tmp}")
    text = fix_header_stamp(tmp.read_text(encoding="latin-1"))
    tmp.unlink()
    data = text.replace("\r\n", "\n").encode("latin-1")
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()
