"""gmsh / gmshToFoam helpers that need nothing but the standard library."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any


def initialize_gmsh(gmsh: Any, **kwargs: Any) -> None:
    """``gmsh.initialize`` that keeps the process PATH intact.

    On Windows gmsh's initialize rewrites the process PATH to a ~300-character
    stub, after which ``subprocess`` can no longer find tools on PATH (node, ...)
    for the rest of the process. Restore it.
    """
    import os
    import sys

    path = os.environ.get("PATH")
    gmsh.initialize(**kwargs)
    if sys.platform == "win32" and path is not None:
        import ctypes

        ctypes.windll.kernel32.SetEnvironmentVariableW("PATH", path)


def apply_boundary_patch_types(boundary_path: Path, patch_types: dict[str, str]) -> int:
    """Rewrite ``type`` lines in polyMesh/boundary for known patch names.

    Returns the number of patches whose type was changed.
    """
    path = Path(boundary_path)
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines(keepends=True)
    changed = 0
    current: str | None = None
    out: list[str] = []
    skip_names = {"FoamFile", "version", "format", "arch", "class", "location", "object"}
    name_re = re.compile(r"^\s*([A-Za-z_]\w*)\s*$")
    type_re = re.compile(r"^(\s*type\s+)\S+(\s*;.*)$")
    for line in lines:
        raw = line.rstrip("\r\n")
        m_name = name_re.match(raw)
        if m_name and m_name.group(1) not in skip_names:
            current = m_name.group(1)
            out.append(line)
            continue
        stripped = raw.strip()
        if stripped == "}":
            current = None
            out.append(line)
            continue
        if current and current in patch_types:
            m_type = type_re.match(raw)
            if m_type:
                want = patch_types[current]
                nl = "\n" if line.endswith("\n") else ""
                new_line = f"{m_type.group(1)}{want}{m_type.group(2)}{nl}"
                if new_line.rstrip("\n") != raw:
                    changed += 1
                out.append(new_line)
                continue
        out.append(line)
    path.write_bytes("".join(out).replace("\r\n", "\n").encode("utf-8"))
    return changed
