"""A study's material regions (host API 1.8).

A study whose analysis offers several material models (a fluid and solids, for
heat transfer) holds one material record per group of bodies. Each record that
has bodies is one region of the mesh: its role (fluid or solid) is its material
model's ``role``. Bodies of one record that share a face stay one region, as
they always have; a face between two records is an interface.

A study whose analysis offers one material model has no regions here: every
body is the one fluid, as before (older projects may hold several records of
that one model; they are not regions).

Body roles are not written on the geometry (``Geometry.bodies[].role``): that
would change every mesh's fingerprint.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from cfddesk.project.paths import assemble_study_materials, find_study

_WORD = re.compile(r"[^a-z0-9]+")


def _registry(kind: str) -> Any:
    # The plugins' specs: a Generate tool runs in a process of its own, where nothing
    # has loaded them yet (load_all is cached, so the worker pays nothing).
    from cfddesk.registry.discovery import load_all

    return load_all().registry(kind)


def _analysis_models(analysis_key: str) -> list[Any]:
    """The material models an analysis offers, registered ones only, in its order."""
    if not analysis_key:
        return []
    try:
        analysis = _registry("analysis").get(analysis_key)
    except Exception:
        return []
    materials = _registry("material")
    out = []
    for key in tuple(getattr(analysis, "material_models", ()) or ()):
        try:
            out.append(materials.get(key))
        except Exception:
            continue
    return out


def region_name(name: str, taken: set[str]) -> str:
    """An OpenFOAM region name from a material name: lower-case word characters, unique in ``taken``."""
    base = _WORD.sub("_", str(name or "").lower()).strip("_") or "region"
    if not base[0].isalpha():
        base = "r_" + base
    out, n = base, 2
    while out in taken:
        out, n = f"{base}_{n}", n + 1
    taken.add(out)
    return out


def study_regions(project_dir: Path | str, sim_id: str | None) -> list[dict[str, Any]]:
    """The study's regions: ``[{name, role, material_id, material_name, model, bodies}]``.

    Empty for a study whose analysis offers one material model (one fluid region,
    as always) and for records with no bodies.
    """
    root = Path(project_dir)
    sid = str(sim_id or "").strip()
    study = find_study(root, sid) if sid else None
    if not study:
        return []
    placed: list[tuple[dict[str, Any], list[str]]] = []
    for rec in assemble_study_materials(root, sid):
        vols = rec.get("assigned_volumes")
        bodies = list(dict.fromkeys(str(v) for v in vols if str(v))) if isinstance(vols, list) else []
        if bodies:
            placed.append((rec, bodies))
    # One material (every Incompressible Flow study) is one region: no registry needed.
    if len(placed) <= 1:
        return []
    models = _analysis_models(str(study.get("analysis_type") or ""))
    if len(models) <= 1:
        return []
    by_key = {str(m.key): m for m in models}
    taken: set[str] = set()
    out: list[dict[str, Any]] = []
    for rec, bodies in placed:
        model = by_key.get(str(rec.get("material_model") or "")) or models[0]
        out.append(
            {
                "name": region_name(str(rec.get("name") or ""), taken),
                "role": str(getattr(model, "role", "fluid") or "fluid"),
                "material_id": str(rec.get("id") or ""),
                "material_name": str(rec.get("name") or ""),
                "model": str(model.key),
                "bodies": bodies,
            }
        )
    return out


def mesh_region_refusal(project_dir: Path | str, sim_id: str | None, mesher_key: str) -> str | None:
    """Why this mesher cannot mesh the study, when its materials make more than one
    region and the mesher has no ``multi_region``; None otherwise."""
    regions = study_regions(project_dir, sim_id)
    if len(regions) <= 1:
        return None
    try:
        mesher = _registry("mesher").get(mesher_key)
    except Exception:
        mesher = None
    if mesher is not None and bool(getattr(mesher, "multi_region", False)):
        return None
    label = str(getattr(mesher, "label", "") or mesher_key or "This mesher")
    names = ", ".join(f"{r['material_name'] or r['name']} ({r['role']})" for r in regions)
    return (
        f"{label} meshes every body as one fluid, but this simulation has {len(regions)} materials: {names}. "
        "Mesh it with a mesher that keeps materials apart."
    )
