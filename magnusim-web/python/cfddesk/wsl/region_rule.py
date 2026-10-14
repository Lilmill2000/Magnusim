"""The one rule for a multi-region case's regions (host API 1.8).

A multi-region case lists its regions in its ``w27-case.json`` (``regions``:
``[{name, role}]``, role ``fluid`` or ``solid``; other keys in a row are
ignored). Each name is a folder in ``constant/``, ``system/``, ``0/`` and every
saved time, so it is a plain OpenFOAM word that is not a file those folders
hold, not ``processor...``, and not the same as another region's name in any
case (two names that differ only in case are one folder on Windows).

The runner (``cfddesk.wsl.foam_case``), the results (``cfddesk.results.regions``)
and the names a study's mesh gives its regions (``cfddesk.project.regions``)
read and make names by this rule (it lives in ``wsl``, the lowest of them in the
core's package graph, tools/core_layers.py). Node (``scripts/project-layout.js``) and the
viewer (``src/workbench/resultRegions.ts``) keep a copy of the list rule.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

MAX_NAME = 64
REGION_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
ROLES = ("fluid", "solid")
MAX_REGIONS = 32

# Names a region may not take: the files and folders a case's constant/, system/
# and 0/ hold besides the region folders (compared in any case: one name on Windows).
RESERVED = frozenset(
    name.casefold()
    for name in (
        "polyMesh", "uniform", "regionProperties", "cellToRegion", "triSurface", "extendedFeatureEdgeMesh",
        "g", "hRef", "pRef", "controlDict", "fvSchemes", "fvSolution", "fvOptions", "fvConstraints", "fvModels",
        "decomposeParDict", "transportProperties", "thermophysicalProperties", "physicalProperties",
        "turbulenceProperties", "momentumTransport", "radiationProperties", "dynamicMeshDict",
        "blockMeshDict", "snappyHexMeshDict", "surfaceFeatureExtractDict", "extrudeMeshDict",
        "changeDictionaryDict", "createPatchDict", "topoSetDict", "include",
        "constant", "system", "lagrangian", "VTK", "postProcessing", "dynamicCode", "MRFProperties",
        "thermophysicalTransport", "combustionProperties",
        "T", "U", "p", "p_rgh", "k", "epsilon", "omega", "nut", "alphat", "rho", "phi", "h", "qr",
    )
)


class RegionListError(ValueError):
    """``regions`` is there and not valid; the text says why."""


def region_name_ok(name: Any) -> bool:
    """A region name the scripts and the case folders can take."""
    return (
        isinstance(name, str)
        and bool(REGION_RE.match(name))
        and name.casefold() not in RESERVED
        and not name.casefold().startswith("processor")
    )


def parse_regions(raw: Any, *, where: str = "w27-case.json") -> list[dict[str, str]]:
    """``regions`` as ``[{name, role}]`` in its order ([] when it is None). Raises
    :class:`RegionListError` when it is not a list of at most :data:`MAX_REGIONS`
    rows with a :func:`region_name_ok` name and a role, or two names are one."""
    if raw is None:
        return []
    bad = RegionListError(f"{where}: regions must be a list of {{name, role}}")
    if not isinstance(raw, list) or len(raw) > MAX_REGIONS:
        raise bad
    out: list[dict[str, str]] = []
    for row in raw:
        if not isinstance(row, dict):
            raise bad
        name, role = row.get("name"), row.get("role")
        if not region_name_ok(name) or role not in ROLES:
            raise bad
        same = [r["name"] for r in out if r["name"].casefold() == str(name).casefold()]
        if same and same[0] == name:
            raise RegionListError(f"{where}: region {name} is listed twice")
        if same:
            raise RegionListError(f"{where}: regions {same[0]} and {name} differ only in case (one folder on Windows)")
        out.append({"name": str(name), "role": str(role)})
    return out


def file_clash(case_dir: str | Path, names: list[str]) -> str | None:
    """The first region name that is a file (not a folder) in the case's
    ``constant/``, ``system/`` or ``0/``, in any case, as ``<folder>/<file>``; else None."""
    wanted = {n.casefold(): n for n in names}
    for folder in ("constant", "system", "0"):
        try:
            entries = list((Path(case_dir) / folder).iterdir())
        except OSError:
            continue
        for entry in sorted(entries, key=lambda e: e.name):
            if entry.name.casefold() in wanted and not entry.is_dir():
                return f"{folder}/{entry.name}"
    return None
