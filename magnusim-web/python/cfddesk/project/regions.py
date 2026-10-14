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


def _placed(root: Path, sid: str) -> tuple[dict[str, Any] | None, list[tuple[dict[str, Any], list[str]]]]:
    """The study and its material records that have bodies, with their bodies."""
    study = find_study(root, sid) if sid else None
    if not study:
        return None, []
    placed: list[tuple[dict[str, Any], list[str]]] = []
    for rec in assemble_study_materials(root, sid):
        vols = rec.get("assigned_volumes")
        bodies = list(dict.fromkeys(str(v) for v in vols if str(v))) if isinstance(vols, list) else []
        if bodies:
            placed.append((rec, bodies))
    return study, placed


def study_regions(project_dir: Path | str, sim_id: str | None) -> list[dict[str, Any]]:
    """The study's regions: ``[{name, role, material_id, material_name, model, bodies}]``.

    Empty for a study whose analysis offers one material model (one fluid region,
    as always), for a study with one material, and for records with no bodies.
    """
    study, placed = _placed(Path(project_dir), str(sim_id or "").strip())
    # One material (every Incompressible Flow study) is one region: no registry needed.
    if study is None or len(placed) <= 1:
        return []
    return _rows(study, placed)


def regions_for_mesh(project_dir: Path | str, sim_id: str | None, n_bodies: int) -> list[dict[str, Any]]:
    """The regions a mesh of this study is split into, or [] when it is meshed as before
    (every body one fluid region).

    An analysis that offers several material models (heat transfer) meshes each
    material's bodies as a region and leaves out a body no material names; one
    material on every body is meshed as before. An analysis with one model meshes
    every body as one fluid, whatever its records say.
    """
    study, placed = _placed(Path(project_dir), str(sim_id or "").strip())
    if study is None or not placed:
        return []
    every = {f"Body{i + 1}" for i in range(int(n_bodies))}
    # One material on every body (every Incompressible Flow study too): as before, no registry needed.
    if len(placed) == 1 and every and every <= set(placed[0][1]):
        return []
    rows = _rows(study, placed)
    covered = {b for r in rows for b in r["bodies"]}
    if len(rows) == 1 and every and every <= covered:
        return []
    return rows


def _rows(study: dict[str, Any], placed: list[tuple[dict[str, Any], list[str]]]) -> list[dict[str, Any]]:
    """Region rows of the placed records ([] for an analysis with one material model)."""
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
    # 0-based bodies no material names: left out of the mesh (their faces are no
    # patch; a face a kept body shares with one is a boundary of the kept body).
    left_out: tuple[int, ...] = ()

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

    def left_out_labels(self) -> list[str]:
        return [f"Body{b + 1}" for b in self.left_out]

    def left_out_faces(self, bodies: dict[int, int]) -> set[int]:
        """Face ids of the left-out bodies (``bodies``: face id -> 1-based body)."""
        gone = {b + 1 for b in self.left_out}
        return {int(f) for f, b in bodies.items() if b in gone}

    def inside(self, shared: dict[int, int], bodies: dict[int, int]) -> dict[int, int]:
        """The shared faces still inside the mesh: both bodies kept. A face a kept body
        shares with a left-out one is a boundary of the kept body."""
        gone = {b + 1 for b in self.left_out}
        return {
            int(f): int(t)
            for f, t in shared.items()
            if bodies.get(int(f)) not in gone and bodies.get(int(t)) not in gone
        }

    def left_out_refusal(self, named_faces, bodies: dict[int, int]) -> str | None:
        """Why the mesh can't be made when a BC is on a left-out body's face; else None."""
        gone = {b + 1 for b in self.left_out}
        for name, fids in named_faces:
            for fid in fids:
                body = bodies.get(int(fid))
                if body in gone:
                    return (
                        f"Face {int(fid) + 1}@Body{body} is on Body{body}, which this simulation leaves out of the "
                        f'mesh (it has no material), so it can\'t take a boundary condition. Remove it from "{name}", '
                        f"or give Body{body} a material."
                    )
        return None


def regions_signature(summary: list[dict[str, Any]] | None) -> list[list[Any]]:
    """A region summary as a stable comparable value (region order does not matter)."""
    rows = []
    for r in summary or []:
        if isinstance(r, dict):
            rows.append([str(r.get("role") or ""), sorted(str(b) for b in r.get("bodies") or [])])
    return sorted(rows)


def mesh_regions(project_dir: Path | str, sim_id: str | None, solid: Any) -> MeshRegions | str | None:
    """The regions a mesher splits ``solid`` into for this study (``regions_for_mesh``):
    None when it is meshed as before (every body one fluid region), else the regions
    and the bodies left out, or the reason it cannot be meshed."""
    from cfddesk.cad.shared_faces import face_bodies, shared_face_ids

    n_bodies = len(getattr(solid, "volumes", None) or [])
    regions = regions_for_mesh(project_dir, sim_id, n_bodies)
    if not regions:
        return None
    body_of: dict[int, int] = {}
    for k, region in enumerate(regions):
        for label in region["bodies"]:
            m = re.fullmatch(r"Body(\d+)", str(label))
            if not m or not (1 <= int(m.group(1)) <= n_bodies):
                return f"{region['material_name'] or region['name']} names {label}, which this part does not have."
            body_of[int(m.group(1)) - 1] = k
    # A body no material names is left out of the mesh.
    left_out = tuple(b for b in range(n_bodies) if b not in body_of)
    bodies = face_bodies(solid)
    shared = shared_face_ids(solid)
    interfaces = frozenset(
        int(f)
        for f, other in shared.items()
        if (a := body_of.get(bodies.get(int(f), 0) - 1)) is not None
        and (b := body_of.get(bodies.get(int(other), 0) - 1)) is not None
        and a != b
    )
    return MeshRegions(
        names=tuple(r["name"] for r in regions),
        roles=tuple(r["role"] for r in regions),
        bodies=tuple(tuple(sorted(b for b, k in body_of.items() if k == i)) for i in range(len(regions))),
        interfaces=interfaces,
        left_out=left_out,
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


def mesh_region_refusal(
    project_dir: Path | str, sim_id: str | None, mesher_key: str, n_bodies: int | None = None
) -> str | None:
    """Why this mesher cannot mesh the study, when its materials make more than one
    region or leave a body out (``n_bodies`` known) and the mesher has no
    ``multi_region``; None otherwise."""
    if n_bodies is not None:
        regions = regions_for_mesh(project_dir, sim_id, n_bodies)
        if not regions:
            return None
        covered = {b for r in regions for b in r["bodies"]}
        left = [f"Body{i + 1}" for i in range(n_bodies) if f"Body{i + 1}" not in covered]
    else:
        regions = study_regions(project_dir, sim_id)
        left = []
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
    if left:
        return (
            f"{label} meshes every body as one fluid, but this simulation leaves {', '.join(left)} out "
            f"(no material) and meshes {names}. Mesh it with a mesher that keeps materials apart."
        )
    return (
        f"{label} meshes every body as one fluid, but this simulation has {len(regions)} materials: {names}. "
        "Mesh it with a mesher that keeps materials apart."
    )
