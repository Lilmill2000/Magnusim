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
from dataclasses import dataclass, field
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


@dataclass(frozen=True)
class MeshRegions:
    """A study's regions as a mesher meshes them (more than one region only).

    ``bodies[k]`` are region k's 0-based body indices (``Body<i+1>``, TopExp SOLID
    order). ``interfaces`` are the face visits two bodies of DIFFERENT regions share
    (each visit, both sides): never a patch, never a wall, meshed through as the
    internal faces between two cellZones. A face two bodies of the SAME region share
    stays inside that region, as it always has.
    """

    names: tuple[str, ...]
    roles: tuple[str, ...]
    bodies: tuple[tuple[int, ...], ...]
    interfaces: frozenset[int] = field(default_factory=frozenset)

    def region_of_body(self, body: int) -> int:
        for k, members in enumerate(self.bodies):
            if body in members:
                return k
        return -1

    def summary(self) -> list[dict[str, Any]]:
        """What a mesh records about its regions (and compares to see if it is out of date)."""
        return [
            {"name": n, "role": r, "bodies": [f"Body{b + 1}" for b in bs]}
            for n, r, bs in zip(self.names, self.roles, self.bodies, strict=True)
        ]


def regions_signature(summary: list[dict[str, Any]] | None) -> list[list[Any]]:
    """A region summary as a stable comparable value (region order does not matter)."""
    rows = []
    for r in summary or []:
        if isinstance(r, dict):
            rows.append([str(r.get("role") or ""), sorted(str(b) for b in r.get("bodies") or [])])
    return sorted(rows)


def mesh_regions(project_dir: Path | str, sim_id: str | None, solid: Any) -> MeshRegions | str | None:
    """The regions a mesher splits ``solid`` into for this study: None for one region
    (every body meshed as one fluid, as always), else the regions, or the reason it
    cannot be meshed (a body no material names)."""
    regions = study_regions(project_dir, sim_id)
    if len(regions) <= 1:
        return None
    from cfddesk.cad.shared_faces import face_bodies, shared_face_ids

    n_bodies = len(getattr(solid, "volumes", None) or [])
    body_of: dict[int, int] = {}
    for k, region in enumerate(regions):
        for label in region["bodies"]:
            m = re.fullmatch(r"Body(\d+)", str(label))
            if not m or not (1 <= int(m.group(1)) <= n_bodies):
                return f"{region['material_name'] or region['name']} names {label}, which this part does not have."
            body_of[int(m.group(1)) - 1] = k
    missing = [b for b in range(n_bodies) if b not in body_of]
    if missing:
        names = ", ".join(f"Body{b + 1}" for b in missing)
        verb = "has" if len(missing) == 1 else "have"
        return (
            f"{names} {verb} no material. In this simulation every body is meshed with its material: "
            "give it one in Materials."
        )
    bodies = face_bodies(solid)
    shared = shared_face_ids(solid)
    interfaces = frozenset(
        int(f)
        for f, other in shared.items()
        if body_of.get(bodies.get(int(f), 0) - 1) != body_of.get(bodies.get(int(other), 0) - 1)
    )
    return MeshRegions(
        names=tuple(r["name"] for r in regions),
        roles=tuple(r["role"] for r in regions),
        bodies=tuple(tuple(sorted(b for b, k in body_of.items() if k == i)) for i in range(len(regions))),
        interfaces=interfaces,
    )


def body_centroids(solid: Any) -> list[tuple[float, float, float]]:
    """Each body's centre of mass (shape units), in TopExp SOLID order (``Body<i+1>``)."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    out: list[tuple[float, float, float]] = []
    explorer = TopExp_Explorer(solid.shape, TopAbs_SOLID)
    while explorer.More():
        props = GProp_GProps()
        BRepGProp.VolumeProperties_s(explorer.Current(), props)
        c = props.CentreOfMass()
        out.append((float(c.X()), float(c.Y()), float(c.Z())))
        explorer.Next()
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
