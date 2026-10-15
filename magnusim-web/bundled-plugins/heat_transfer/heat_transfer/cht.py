"""Conjugate heat transfer: a study's regions, as its mesh and its materials make them.

A Heat Transfer study with a body of a solid material solves conjugate heat
transfer (chtMultiRegionSimpleFoam / chtMultiRegionFoam): each material record
with bodies is one region, fluid or solid by its material model. Its mesh was
made with one cellZone per region (host API 1.8, ``RunInputs.mesh.regions``:
``[{name, role, bodies, cells}]``); a study of one material on every body was
meshed as before, as one region with no cellZone.

:func:`layout` reads the unsplit mesh (heat_transfer.polymesh) and says, for the
case writer and Start:

- each region's name, role, bodies, cellZone and material record;
- each region's patches (a patch on two regions' faces is in both, with each
  one's part of it, as splitMeshRegions makes it);
- the pairs of regions that touch: each gets the interface patches
  ``<a>_to_<b>`` (in a) and ``<b>_to_<a>`` (in b);
- each region's volume (a heat source given per volume) and, on request, how
  many of its cells are thin (a solid about one cell thick).

A mesh of several regions is split at solve time (``splitMeshRegions -cellZonesOnly
-overwrite``, a WSL pre-step); a case of one region gets its mesh straight in
``constant/<region>/polyMesh``.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .materials import FLUID_MODEL, SOLID_MODEL, record_bodies

FLUID = "fluid"
SOLID = "solid"
# A solid region whose cells are this thin (share of its cells with every point on
# its surface) is refused at Start: HT0's 1.5 mm fins on 1.5 mm cells (70 %) diverged,
# the same sink with 2.5 mm fins (23 %) converged. The share is among the cells near the
# solid's surface (a point on it), so a thick base does not hide thin fins (HT5: the same
# 1.5 mm fins on a 10 mm base, 66 %; 2.5 mm fins on 1.5 mm cells on that base, 58 %).
THIN_LIMIT = 0.5

# Region names a case folder cannot take (cfddesk.wsl.region_rule.RESERVED, compared in
# any case); a one-region case names its region after its material, so it checks them.
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
_WORD = re.compile(r"[^a-z0-9]+")
_BODY = re.compile(r"@(Body\d+)$")


class ChtError(ValueError):
    """The study's regions cannot be made from its mesh; the text says why (for the user)."""


def region_word(name: str) -> str:
    """A one-region case's region name from its material's name (as the meshers name regions)."""
    base = _WORD.sub("_", str(name or "").lower()).strip("_") or "solid"
    if not base[0].isalpha():
        base = "r_" + base
    base = base[:64].rstrip("_")
    if base.casefold() in RESERVED or base.casefold().startswith("processor"):
        base = ("r_" + base)[:64].rstrip("_")
    return base


def record_role(rec: dict[str, Any]) -> str:
    return SOLID if str(rec.get("material_model") or "") == SOLID_MODEL else FLUID


def placed_records(materials: Any) -> list[dict[str, Any]]:
    """This plugin's material records that have bodies, in order."""
    return [
        m
        for m in materials or []
        if isinstance(m, dict) and str(m.get("material_model") or "") in (FLUID_MODEL, SOLID_MODEL) and record_bodies(m)
    ]


def bodies_text(bodies: list[str] | tuple[str, ...]) -> str:
    """"Body2", "Body2 and Body3", "Body2, Body3 and Body4"."""
    items = [str(b) for b in bodies]
    if len(items) <= 1:
        return items[0] if items else ""
    return ", ".join(items[:-1]) + " and " + items[-1]


@dataclass(frozen=True)
class Region:
    name: str
    role: str
    bodies: tuple[str, ...]
    zone: str  # its cellZone in the unsplit mesh ("" for a mesh of one region)
    record: dict[str, Any]

    @property
    def material_name(self) -> str:
        return str(self.record.get("name") or ("Solid" if self.role == SOLID else "Fluid"))

    @property
    def label(self) -> str:
        """"Body2 (Aluminium 6061)": how the user knows the region."""
        return f"{bodies_text(self.bodies)} ({self.material_name})"


@dataclass
class Layout:
    regions: list[Region]
    split: bool
    patches: dict[str, list[str]]  # region -> its patches, in mesh order
    patch_types: dict[str, str]  # patch -> its type in the unsplit mesh
    touching: list[tuple[str, str]]  # region pairs that share faces (in region order)
    volumes: dict[str, float] = field(default_factory=dict)
    thin: dict[str, tuple[int, int]] = field(default_factory=dict)

    def region(self, name: str) -> Region:
        return next(r for r in self.regions if r.name == name)

    @property
    def fluids(self) -> list[Region]:
        return [r for r in self.regions if r.role == FLUID]

    @property
    def solids(self) -> list[Region]:
        return [r for r in self.regions if r.role == SOLID]

    def interfaces(self, name: str) -> list[str]:
        """The interface patches of a region: ``<name>_to_<other>``."""
        out = []
        for a, b in self.touching:
            if a == name:
                out.append(f"{a}_to_{b}")
            elif b == name:
                out.append(f"{b}_to_{a}")
        return out

    def neighbour_of(self, iface: str) -> str:
        """The other region of an interface patch ``<a>_to_<b>``."""
        for a, b in self.touching:
            if iface == f"{a}_to_{b}":
                return b
            if iface == f"{b}_to_{a}":
                return a
        raise KeyError(iface)

    def regions_of_patch(self, patch: str) -> list[str]:
        return [r for r, ps in self.patches.items() if patch in ps]

    def regions_of_record(self, bc: dict[str, Any] | None, patch: str) -> list[str]:
        """The regions a BC is on: by its faces' bodies ("face 7@Body2"; a patch the mesher
        snapped a few faces of onto a neighbouring body is not on that body), else (faces
        without a body, or none) by the mesh patch it landed on."""
        from magnusim_sdk.study import bc_faces

        bodies = {m.group(1) for f in bc_faces(bc) if (m := _BODY.search(str(f)))} if bc else set()
        if bodies:
            on = [r.name for r in self.regions if bodies & set(r.bodies)]
            return [r for r in on if patch in self.patches.get(r, [])] or on
        return self.regions_of_patch(patch)

    def groups(self) -> list[list[str]]:
        """The regions joined by interfaces, each group in region order."""
        names = [r.name for r in self.regions]
        parent = {n: n for n in names}

        def root(n: str) -> str:
            while parent[n] != n:
                parent[n] = parent[parent[n]]
                n = parent[n]
            return n

        for a, b in self.touching:
            parent[root(a)] = root(b)
        out: dict[str, list[str]] = {}
        for n in names:
            out.setdefault(root(n), []).append(n)
        return list(out.values())


def regions_of(mesh_rows: Any, records: list[dict[str, Any]], *, mesh_name: str = "The mesh") -> tuple[list[Region], bool]:
    """(regions, split): the study's regions as its mesh made them, each with its material
    record. Raises :class:`ChtError` when the mesh was made for other materials."""
    placed = placed_records(records)
    rows = [r for r in (mesh_rows or []) if isinstance(r, dict) and r.get("name")]
    stale = (
        f"{mesh_name} was made before the materials changed (each material's bodies are meshed as a region "
        "of their own): generate it again."
    )
    if not rows:
        if len(placed) != 1:
            raise ChtError(stale)
        rec = placed[0]
        return [Region(region_word(str(rec.get("name") or "")), record_role(rec), tuple(record_bodies(rec)), "", rec)], False
    out: list[Region] = []
    used: set[int] = set()
    for row in rows:
        bodies = sorted(str(b) for b in row.get("bodies") or [])
        hit = next(
            (i for i, m in enumerate(placed) if i not in used and sorted(record_bodies(m)) == bodies),
            None,
        )
        if hit is None or record_role(placed[hit]) != str(row.get("role") or FLUID):
            raise ChtError(stale)
        used.add(hit)
        rec = placed[hit]
        out.append(Region(str(row["name"]), record_role(rec), tuple(record_bodies(rec)), str(row["name"]), rec))
    if len(used) != len(placed):
        raise ChtError(stale)
    return out, len(out) > 1


def layout(
    mesh_rows: Any,
    records: list[dict[str, Any]],
    poly_dir: Path | str,
    *,
    mesh_name: str = "The mesh",
    thin: bool = False,
    volumes: bool = False,
    keep: bool = False,
) -> Layout:
    """The case's regions on the mesh in ``poly_dir`` (the unsplit ``constant/polyMesh``).

    The mesh is read once (heat_transfer.polymesh.mesh_summary); with ``keep`` what was
    read is kept beside the mesh for the next check of the same mesh files."""
    regions, split = regions_of(mesh_rows, records, mesh_name=mesh_name)
    thin_zones = [r.zone for r in regions if r.role == SOLID] if thin else []
    doc = summary(poly_dir, mesh_name=mesh_name, thin_zones=thin_zones, volumes=volumes, keep=keep)
    zones = {r.name: r.zone for r in regions}
    if split:
        missing = [r.zone for r in regions if r.zone not in doc["zone_names"]]
        if missing:
            raise ChtError(f"{mesh_name} has no cell zone {missing[0]}: generate it again.")
    by_patch = doc["patch_zones"]
    patches: dict[str, list[str]] = {r.name: [] for r in regions}
    for name, _type, n_faces in doc["patches"]:
        for r in regions:
            if n_faces > 0 and (not split or by_patch.get(name, {}).get(r.zone)):
                patches[r.name].append(name)
    touching: list[tuple[str, str]] = []
    if split:
        names = [r.name for r in regions]
        zone_name = {z: n for n, z in zones.items()}
        for a, b, _n in doc["interfaces"]:
            if a in zone_name and b in zone_name:
                pair = sorted((zone_name[a], zone_name[b]), key=names.index)
                touching.append((pair[0], pair[1]))
        touching.sort(key=lambda ab: (names.index(ab[0]), names.index(ab[1])))
    out = Layout(
        regions=regions,
        split=split,
        patches=patches,
        patch_types={name: kind for name, kind, _n in doc["patches"]},
        touching=touching,
    )
    if volumes:
        vols = doc["volumes"]
        out.volumes = {r.name: float(vols.get(r.zone, 0.0) if r.zone else sum(vols.values())) for r in regions}
    if thin:
        out.thin = {r.name: (int(doc["thin"][r.zone][0]), int(doc["thin"][r.zone][1])) for r in regions if r.role == SOLID}
    return out


def summary(
    poly_dir: Path | str,
    *,
    mesh_name: str = "The mesh",
    thin_zones: list[str] | None = None,
    volumes: bool = False,
    points: list[list[float]] | None = None,
    keep: bool = False,
) -> dict[str, Any]:
    """heat_transfer.polymesh.mesh_summary, with a mesh that cannot be read (or is too large
    for the memory left) a :class:`ChtError` in the user's words."""
    from .polymesh import MeshReadError, mesh_summary

    try:
        return mesh_summary(poly_dir, thin_zones=thin_zones, volumes=volumes, points=points, keep=keep)
    except MemoryError as exc:
        raise ChtError(
            f"{mesh_name} is too large to check in the memory this computer has free: close other programs "
            "and try again, or make the mesh coarser."
        ) from exc
    except (MeshReadError, OSError, ValueError, IndexError) as exc:
        raise ChtError(f"{mesh_name} cannot be read ({exc}): generate it again.") from exc


def thin_problem(lay: Layout) -> str | None:
    """A solid region about one cell thick, in the user's words, else None."""
    for r in lay.solids:
        n_thin, n = lay.thin.get(r.name, (0, 0))
        if n > 0 and n_thin / n >= THIN_LIMIT:
            pct = int(math.floor(100.0 * n_thin / n))
            return (
                f"{r.label} is about one cell thick: {pct} % of its cells at its surface touch it on every side. "
                "Refine the mesh there so the solid is at least 2 cells across (thinner solids make the solve "
                "diverge), or make the part thicker."
            )
    return None


def locate_points(lay: Layout, poly_dir: Path | str, points: list[list[float]], *, keep: bool = False) -> list[str | None]:
    """The region each point is in (None: in no cell of the mesh)."""
    from .polymesh import point_key

    located = summary(poly_dir, points=points, keep=keep).get("located", {})
    zones = [located.get(point_key(p)) for p in points]
    by_zone = {r.zone: r.name for r in lay.regions}
    out: list[str | None] = []
    for z in zones:
        if z is None:
            out.append(None)
        elif not lay.split:
            out.append(lay.regions[0].name)
        else:
            out.append(by_zone.get(z))
    return out
