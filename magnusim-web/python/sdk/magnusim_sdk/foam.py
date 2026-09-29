"""OpenFOAM dictionary and field writers (ASCII headers, LF line endings).

The byte layout matches the product case writer's goldens: a plain
``FoamFile`` header with no C++ banner, and ``write_vol_field`` spacing.
"""

from __future__ import annotations

import math
import re
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


def parse_boundary_patch_types(path: Path) -> dict[str, str]:
    """Patch name -> type from a ``constant/polyMesh/boundary`` file."""
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    text = re.sub(r"FoamFile\s*\{.*?\}\s*", "", text, count=1, flags=re.S)
    types: dict[str, str] = {}
    for m in re.finditer(
        r"(?m)^\s*([A-Za-z_][\w]*)\s*\n\s*\{\s*\n\s*type\s+([A-Za-z_]\w*)\s*;",
        text,
    ):
        types[m.group(1)] = m.group(2)
    return types


def dictionary_header(object_name: str) -> str:
    """``FoamFile`` header of a dictionary, followed by the banner rule line."""
    # No C++ banner: a trailing '\\' on the banner line comments out FoamFile.
    return (
        "FoamFile\n"
        "{\n"
        "    version     2.0;\n"
        "    format      ascii;\n"
        "    class       dictionary;\n"
        f"    object      {object_name};\n"
        "}\n"
        "// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //\n"
    )


def write_foam_text(path: Path, text: str) -> None:
    """Write an OpenFOAM dictionary as ASCII with LF line endings (CRLF breaks Foam parsers)."""
    Path(path).write_bytes(text.replace("\r\n", "\n").encode("ascii", errors="strict"))


def boundary_patch_names(boundary_path: Path) -> list[str]:
    """Patch names in a ``constant/polyMesh/boundary`` file, in file order.

    OpenFOAM writes indented names before a ``{`` / ``type`` block; the header
    of a binary mesh's boundary file is still ASCII.
    """
    path = Path(boundary_path)
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    names: list[str] = []
    for m in re.finditer(
        r"(?m)^\s+([A-Za-z_][A-Za-z0-9_]*)\s*\r?\n\s*\{\s*\r?\n\s*type\s+(\S+);",
        text,
    ):
        if m.group(1) != "FoamFile":
            names.append(m.group(1))
    return names


def _num_or_none(text: str) -> float | None:
    try:
        v = float(text)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def parse_surface_field_value(text: str) -> dict:
    """One ``surfaceFieldValue.dat``: ``{area, faces, columns, rows}``.

    Rows are ``[time, value, …]``; a vector value ``(a b c)`` is a list.
    Numbers that do not parse are None.
    """
    out: dict = {"area": None, "faces": None, "columns": [], "rows": []}
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            m = re.match(r"^#\s*Area\s*:\s*([0-9.eE+-]+)", line)
            if m:
                out["area"] = _num_or_none(m.group(1))
            m = re.match(r"^#\s*Faces\s*:\s*(\d+)", line)
            if m:
                out["faces"] = int(m.group(1))
            m = re.match(r"^#\s*Time\s+(.*)$", line)
            if m:
                out["columns"] = m.group(1).strip().split()
            continue
        toks: list = []
        for t in re.finditer(r"\(([^)]*)\)|([0-9.eE+-]+)", line):
            if t.group(1) is not None:
                toks.append([_num_or_none(x) for x in t.group(1).strip().split()])
            else:
                toks.append(_num_or_none(t.group(2)))
        if not toks or not isinstance(toks[0], float):
            continue
        out["rows"].append(toks)
    return out


def read_surface_field_value(case_dir: Path, name: str) -> dict | None:
    """``postProcessing/<name>/<time>/surfaceFieldValue.dat``, every time folder merged.

    A restart appends a new time folder; its rows supersede the earlier rows
    from its first time on. None when the function object wrote nothing.
    """
    folder = Path(case_dir) / "postProcessing" / name
    if not folder.is_dir():
        return None
    try:
        times = sorted(
            (d.name for d in folder.iterdir() if re.fullmatch(r"\d+(\.\d+)?", d.name)),
            key=float,
        )
    except OSError:
        return None
    merged: dict | None = None
    for t in times:
        f = folder / t / "surfaceFieldValue.dat"
        if not f.is_file():
            continue
        try:
            parsed = parse_surface_field_value(f.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if merged is None:
            merged = parsed
            continue
        first_t = parsed["rows"][0][0] if parsed["rows"] else math.inf
        merged["rows"] = [r for r in merged["rows"] if r[0] < first_t] + parsed["rows"]
        if parsed["area"] is not None:
            merged["area"] = parsed["area"]
    return merged
