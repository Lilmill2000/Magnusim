"""Read, check and write airfoil coordinate files (.dat).

Two layouts are read, the ones the UIUC database and XFOIL use:

- **Selig**: a name line, then x y pairs from the upper trailing edge over the
  upper surface to the leading edge and back along the lower surface.
- **Lednicer**: a name line, a line with the two point counts (such as
  "61. 61."), then the upper surface and the lower surface, each from the
  leading edge to the trailing edge, usually with a blank line before each.

What comes back is always Selig order, chord 1, leading edge at (0, 0), with a
list of what was changed on the way (``warnings``). A file that cannot be used
raises :class:`DatError` with a message that names the line.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from airfoil import geometry

# SPDX-License-Identifier: GPL-3.0-or-later

MAX_BYTES = 256 * 1024
MAX_NAME = 80
_SPLIT = re.compile(r"[\s,;]+")


class DatError(ValueError):
    """A coordinate file that cannot be used; the message says why and where."""


@dataclass
class Section:
    name: str
    x: list[float]
    y: list[float]
    layout: str  # "selig" or "lednicer"
    warnings: list[str] = field(default_factory=list)


def _numbers(text: str) -> list[float] | None:
    parts = [p for p in _SPLIT.split(text.strip()) if p]
    out: list[float] = []
    for p in parts:
        try:
            out.append(float(p.replace("D", "E").replace("d", "e")))
        except ValueError:
            return None
    return out


def _plain_name(text: str) -> str:
    clean = "".join(ch for ch in text if ch.isprintable()).strip()
    return clean[:MAX_NAME]


def parse(text: str, filename: str = "") -> Section:
    """Read a .dat file's text into a checked Selig section."""
    if len(text.encode("utf-8", "replace")) > MAX_BYTES:
        raise DatError(f"The file is larger than {MAX_BYTES // 1024} KB; an airfoil file is a few KB.")
    text = text.lstrip("﻿")
    lines = text.splitlines()
    name = ""
    rows: list[tuple[int, float, float]] = []  # (line number, x, y)
    breaks: list[int] = []  # indexes into rows where a blank line came before
    started = False
    for no, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            if started and line == "":
                breaks.append(len(rows))
            continue
        nums = _numbers(line)
        if not started and not name and (nums is None or len(nums) != 2):
            name = _plain_name(line)
            continue
        if nums is None:
            raise DatError(f"Line {no}: expected two numbers (x and y), found “{_plain_name(line)[:40]}”.")
        if len(nums) != 2:
            raise DatError(f"Line {no}: expected two numbers (x and y), found {len(nums)}.")
        if not all(math.isfinite(v) for v in nums):
            raise DatError(f"Line {no}: the numbers must be finite.")
        rows.append((no, nums[0], nums[1]))
        started = True
    if not name:
        stem = re.sub(r"\.[A-Za-z0-9]{1,4}$", "", str(filename or "").replace("\\", "/").split("/")[-1])
        name = _plain_name(stem) or "Imported airfoil"
    if not rows:
        raise DatError("The file has no coordinates.")
    warnings: list[str] = []
    first = rows[0]
    if first[1] >= 2 and first[2] >= 2 and first[1].is_integer() and first[2].is_integer():
        x, y = _from_lednicer(rows, int(first[1]), int(first[2]))
        layout = "lednicer"
        warnings.append("Read as a Lednicer file (upper and lower surfaces apart) and joined in Selig order.")
    else:
        x, y = [r[1] for r in rows], [r[2] for r in rows]
        layout = "selig"
    x, y = _check(x, y, warnings)
    return Section(name=name, x=x, y=y, layout=layout, warnings=warnings)


def _from_lednicer(rows: list[tuple[int, float, float]], n_upper: int, n_lower: int) -> tuple[list[float], list[float]]:
    pts = rows[1:]
    if len(pts) != n_upper + n_lower:
        raise DatError(
            f"Line {rows[0][0]}: the file says {n_upper} upper and {n_lower} lower points, "
            f"but it has {len(pts)} points."
        )
    upper = pts[:n_upper]
    lower = pts[n_upper:]
    ux, uy = [p[1] for p in reversed(upper)], [p[2] for p in reversed(upper)]
    lx, ly = [p[1] for p in lower], [p[2] for p in lower]
    if lower and upper and math.isclose(lower[0][1], upper[0][1], abs_tol=1e-9) and math.isclose(lower[0][2], upper[0][2], abs_tol=1e-9):
        lx, ly = lx[1:], ly[1:]
    return ux + lx, uy + ly


def _check(x: list[float], y: list[float], warnings: list[str]) -> tuple[list[float], list[float]]:
    # Repeated points next to each other add nothing and upset panel codes.
    kx, ky = [x[0]], [y[0]]
    dropped = 0
    for i in range(1, len(x)):
        if math.isclose(x[i], kx[-1], abs_tol=1e-12) and math.isclose(y[i], ky[-1], abs_tol=1e-12):
            dropped += 1
            continue
        kx.append(x[i])
        ky.append(y[i])
    if dropped:
        warnings.append(f"Removed {dropped} repeated point{'s' if dropped != 1 else ''}.")
    x, y = kx, ky
    if len(x) < geometry.MIN_POINTS:
        raise DatError(f"The file has {len(x)} points; an airfoil needs at least {geometry.MIN_POINTS}.")
    if len(x) > geometry.MAX_POINTS:
        raise DatError(f"The file has {len(x)} points; at most {geometry.MAX_POINTS} are read.")
    x0, x1 = min(x), max(x)
    chord = x1 - x0
    if chord <= 0:
        raise DatError("Every point has the same x: this is not an airfoil.")
    le = geometry.leading_edge_index(x)
    if le == 0 or le == len(x) - 1:
        raise DatError(
            "The points must start at the trailing edge, run over one surface to the leading edge "
            "and back along the other (Selig order)."
        )
    if min(x[0], x[-1]) < x0 + 0.5 * chord:
        raise DatError("The first and last points must be at the trailing edge (Selig order).")
    # Unit chord, leading edge at the origin. An outline that already passes within 0.2 % of
    # chord of the origin is left where it is: a cambered NACA section's foremost point sits a
    # hair ahead of (and above) its mean line's origin, which is one of its points.
    lex, ley = x[le], y[le]
    at_origin = min(math.hypot(a, b) for a, b in zip(x, y, strict=True)) <= 2e-3
    if abs(chord - 1.0) > 1e-3 or not at_origin:
        x = [(v - lex) / chord for v in x]
        y = [(v - ley) / chord for v in y]
        if abs(chord - 1.0) > 1e-3:
            warnings.append(f"Scaled to chord 1 (it was {chord:.6g}).")
        else:
            warnings.append("Moved so that the leading edge is at (0, 0).")
    if geometry.signed_area(x, y) < 0:
        x, y = x[::-1], y[::-1]
        warnings.append("The points ran over the lower surface first; reversed to Selig order (upper surface first).")
    crossing = geometry.first_crossing(x, y)
    if crossing is not None:
        i, j = crossing
        raise DatError(f"The outline crosses itself (between points {i + 1} and {j + 1}).")
    m = geometry.measures(x, y)
    if m["thickness"] < 0.002:
        raise DatError("The section is thinner than 0.2 % of its chord.")
    return x, y


def write(name: str, x: list[float], y: list[float]) -> str:
    """Selig text: the name, then one "x y" line per point."""
    out = [_plain_name(name) or "Airfoil"]
    out.extend(f"{a: .8f} {b: .8f}" for a, b in zip(x, y, strict=True))
    return "\n".join(out) + "\n"
