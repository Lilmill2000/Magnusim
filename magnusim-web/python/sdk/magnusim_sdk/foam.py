"""OpenFOAM dictionary and field writers (ASCII headers, LF line endings).

The byte layout matches the product case writer's goldens: a plain
``FoamFile`` header with no C++ banner, and ``write_vol_field`` spacing.
"""

from __future__ import annotations

import math
from pathlib import Path


def write_text_lf(path: Path, text: str) -> None:
    """Write ``text`` as UTF-8 with LF line endings, creating parent folders."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))


def foam_header(cls: str, obj: str) -> str:
    return (
        "FoamFile\n"
        "{\n"
        "    version     2.0;\n"
        "    format      ascii;\n"
        f"    class       {cls};\n"
        f"    object      {obj};\n"
        "}\n"
    )


def write_foam_dict(path: Path, cls: str, obj: str, body: str) -> None:
    write_text_lf(path, foam_header(cls, obj) + "\n" + body.strip() + "\n")


def write_vol_field(
    path: Path,
    *,
    object_name: str,
    cls: str,
    dims: str,
    internal: str,
    patches: dict[str, dict[str, str]],
) -> None:
    lines = [
        foam_header(cls, object_name).rstrip("\n"),
        "",
        f"dimensions      {dims};",
        "",
        f"internalField   {internal};",
        "",
        "boundaryField",
        "{",
    ]
    for name, block in patches.items():
        lines.append(f"    {name}")
        lines.append("    {")
        for k, v in block.items():
            lines.append(f"        {k}          {v};")
        lines.append("    }")
    lines.append("}")
    lines.append("")
    write_text_lf(path, "\n".join(lines))


def js_plain_float(v: float) -> str:
    """A number the way JavaScript prints it by default (no exponent, no trailing zeros)."""
    if not math.isfinite(v):
        return "0"
    if v == 0:
        return "0"
    s = format(float(v), ".15f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s or "0"


def write_decompose_par_dict(path: Path, n_subdomains: int, method: str = "scotch") -> None:
    """``system/decomposeParDict`` for ``n_subdomains`` ranks."""
    write_foam_dict(
        path,
        "dictionary",
        "decomposeParDict",
        f"numberOfSubdomains {int(n_subdomains)};\nmethod          {method};",
    )
