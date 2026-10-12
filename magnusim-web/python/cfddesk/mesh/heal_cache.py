"""Small feature suppression for the Standard mesher, kept only when it is safe,
and cached per geometry so a re-mesh does not heal again.

gmsh's ``occ.healShapes`` repairs each face on its own and does not sew the
faces back together (``sewFaces`` off). On most parts the faces still share
their edges afterwards. On a part with many short CAD edges (a perforated
plate with 1/8 in tabs: 1,280 edges under 1.5 mm) the repaired faces no
longer share them: 7,040 curves ended up on one surface only. The surface
mesh is then not closed (two nodes at one point, a node on another face's
edge) and the volume fill stops with "PLC Error: A vertex lies in a segment".

So the healed geometry is checked: when healing leaves more open curves than
the CAD had, it is retried without the short-edge repair, and when that opens
the surface too, the CAD is meshed as it is. Healing a large part takes tens
of seconds, so the outcome is cached under ``<web root>/.cache/mesh-geometry``,
keyed by the geometry gmsh reads and the healing settings: the next mesh of the
same geometry reads the healed BREP (about a second) instead of healing again.
The healed geometry is always meshed from that BREP, cached or not, so a cache
hit and a miss mesh the same surfaces.

``MAGNUSIM_MESH_GEOMETRY_CACHE`` moves the cache (a folder) or turns it off
(``off`` / ``0``).
"""

from __future__ import annotations

import hashlib
import os
import time
from collections import Counter
from collections.abc import Callable
from pathlib import Path

# Bump when the healing steps change, so old cache entries are not reused.
HEAL_RECIPE = 1
_CACHE_ENV = "MAGNUSIM_MESH_GEOMETRY_CACHE"
_CACHE_KEEP_FILES = 40
_CACHE_KEEP_BYTES = 2 * 1024**3

# (label, healShapes keyword arguments), tried in order.
_HEAL_MODES: tuple[tuple[str, dict[str, bool]], ...] = (
    ("full", {"fixDegenerated": True, "fixSmallEdges": True, "fixSmallFaces": True}),
    ("faces", {"fixDegenerated": True, "fixSmallEdges": False, "fixSmallFaces": True}),
)


def cache_dir() -> Path | None:
    """Folder of healed geometries, or None when the cache is off."""
    raw = (os.environ.get(_CACHE_ENV) or "").strip()
    if raw.lower() in ("0", "off", "no", "false"):
        return None
    if raw:
        return Path(raw)
    # <web root>/.cache, the folder of the app's other caches (this file is
    # magnusim-web/python/cfddesk/mesh/heal_cache.py).
    return Path(__file__).resolve().parents[3] / ".cache" / "mesh-geometry"


def open_curve_count(gmsh) -> int:
    """Curves on the boundary of the model's volumes that only one surface uses.

    A closed surface has none. A seam (a cylinder's) is listed twice by its own
    surface, so it is not open.
    """
    bounding: set[int] = set()
    for _d, v in gmsh.model.getEntities(3):
        bounding.update(int(t) for t in gmsh.model.getAdjacencies(3, v)[1])
    uses: Counter[int] = Counter()
    for s in bounding:
        for _d, c in gmsh.model.getBoundary([(2, s)], combined=False, oriented=False, recursive=False):
            uses[abs(int(c))] += 1
    return sum(1 for n in uses.values() if n == 1)


def orphan_surfaces(gmsh) -> list[tuple[int, int]]:
    """Surfaces no volume uses (healShapes leaves the pre-heal faces behind)."""
    bounding: set[int] = set()
    for _d, v in gmsh.model.getEntities(3):
        bounding.update(int(t) for t in gmsh.model.getAdjacencies(3, v)[1])
    return [(2, int(t)) for _d, t in gmsh.model.getEntities(2) if int(t) not in bounding]


def _write_without(gmsh, path: Path, hidden: list[tuple[int, int]]) -> None:
    """Write the model's OCC shapes to ``path`` without the ``hidden`` surfaces.

    Hiding and exporting only what is visible takes a second; removing 322
    orphan surfaces from the OCC model one by one took 100 s.
    """
    keep = gmsh.option.getNumber("Geometry.OCCExportOnlyVisible")
    if hidden:
        gmsh.model.setVisibility(hidden, 0, recursive=False)
    gmsh.option.setNumber("Geometry.OCCExportOnlyVisible", 1)
    try:
        gmsh.write(str(path))
    finally:
        gmsh.option.setNumber("Geometry.OCCExportOnlyVisible", keep)


def _cache_key(brep: Path, *, scale: float, tol_m: float) -> str:
    import gmsh

    h = hashlib.sha256()
    with open(brep, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    h.update(f"|scale={float(scale)!r}|tol={float(tol_m)!r}|recipe={HEAL_RECIPE}".encode())
    h.update(f"|gmsh={getattr(gmsh, '__version__', '')}".encode())
    return h.hexdigest()[:40]


def _evict(folder: Path) -> None:
    try:
        entries = sorted(
            (p for p in folder.iterdir() if p.is_file() and p.suffix in (".brep", ".open")),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return
    total = 0
    for i, p in enumerate(entries):
        try:
            total += p.stat().st_size
            if i >= _CACHE_KEEP_FILES or total > _CACHE_KEEP_BYTES:
                p.unlink(missing_ok=True)
        except OSError:
            pass


def _touch(path: Path) -> None:
    try:
        os.utime(path, None)
    except OSError:
        pass


def _import(gmsh, path: Path, scale: float) -> None:
    keep = gmsh.option.getNumber("Geometry.OCCScaling")
    gmsh.option.setNumber("Geometry.OCCScaling", float(scale))
    try:
        gmsh.model.occ.importShapes(str(path))
        gmsh.model.occ.synchronize()
    finally:
        gmsh.option.setNumber("Geometry.OCCScaling", keep)


def _fresh_model(gmsh, name: str) -> None:
    gmsh.model.remove()
    gmsh.model.add(name)


def import_suppressed(
    gmsh,
    brep: Path,
    *,
    scale: float,
    tol_m: float,
    log: Callable[[str], None],
    model_name: str = "standard",
) -> str:
    """Import ``brep`` (CAD units, scaled by ``scale``) into a new gmsh model named
    ``model_name``, with features below ``tol_m`` healed when that keeps the
    surface closed. Returns how it was healed: "full", "faces" (small faces only,
    short edges kept) or "" (not healed)."""
    brep = Path(brep)
    gmsh.model.add(model_name)
    if tol_m <= 0:
        _import(gmsh, brep, scale)
        return ""
    folder = cache_dir()
    key = _cache_key(brep, scale=scale, tol_m=tol_m)
    stays_open = folder / f"{key}.open" if folder is not None else None
    for label, _flags in _HEAL_MODES if folder is not None else ():
        cached = folder / f"{key}.{label}.brep"  # type: ignore[operator]
        if not cached.is_file():
            continue
        try:
            _import(gmsh, cached, 1.0)  # written in metres
            _touch(cached)
            log("small feature suppression: healed geometry reused from an earlier mesh")
            return label
        except Exception as exc:  # unreadable entry: heal again
            log(f"healed geometry cache unreadable ({str(exc)[:120]}); healing again")
            cached.unlink(missing_ok=True)
            _fresh_model(gmsh, model_name)
    if stays_open is not None and stays_open.is_file():
        _import(gmsh, brep, scale)
        _touch(stays_open)
        log(
            f"small feature suppression skipped: healing features below {tol_m:.3g} m "
            "would open the surface (found by an earlier mesh)"
        )
        return ""

    t0 = time.monotonic()
    _import(gmsh, brep, scale)
    open0 = open_curve_count(gmsh)
    ok_mode = None
    for i, (label, flags) in enumerate(_HEAL_MODES):
        if i:
            _fresh_model(gmsh, model_name)
            _import(gmsh, brep, scale)
        gmsh.model.occ.healShapes(
            gmsh.model.getEntities(3), tolerance=float(tol_m), sewFaces=False, makeSolids=False, **flags
        )
        gmsh.model.occ.synchronize()
        opened = open_curve_count(gmsh) - open0
        if opened <= 0 and gmsh.model.getEntities(3):
            ok_mode = label
            break
        log(
            f"small feature suppression ({label}): healing left {max(opened, 0)} CAD edge(s) "
            "on one face only, so the surface would not be closed; not used"
        )
    if ok_mode is None:
        _fresh_model(gmsh, model_name)
        _import(gmsh, brep, scale)
        if stays_open is not None:
            try:
                folder.mkdir(parents=True, exist_ok=True)  # type: ignore[union-attr]
                stays_open.write_text(f"{tol_m!r}\n", encoding="ascii")
                _evict(folder)  # type: ignore[arg-type]
            except OSError:
                pass
        log(f"small feature suppression skipped: the CAD is meshed as it is ({time.monotonic() - t0:.1f}s)")
        return ""
    orphans = orphan_surfaces(gmsh)
    if orphans:
        log(f"removed {len(orphans)} orphan surface(s) left by healing")
    # Mesh from the written BREP (without the orphans), so the first mesh and
    # every later one (a cache hit) see the same surfaces in the same order.
    import tempfile

    tmp_dir = None
    healed = None
    try:
        healed = folder / f"{key}.{ok_mode}.brep" if folder is not None else None
        if healed is not None:
            folder.mkdir(parents=True, exist_ok=True)  # type: ignore[union-attr]
            target = healed
        else:
            tmp_dir = tempfile.mkdtemp(prefix="magnusim-heal-")
            target = Path(tmp_dir) / "healed.brep"
        tmp = target.with_name(f"{target.stem}.{os.getpid()}.tmp.brep")
        _write_without(gmsh, tmp, orphans)
        os.replace(tmp, target)
        if healed is not None:
            _evict(folder)  # type: ignore[arg-type]
        _fresh_model(gmsh, model_name)
        _import(gmsh, target, 1.0)
    except Exception as exc:
        log(f"healed geometry not written ({str(exc)[:120]}); healing in place")
        _fresh_model(gmsh, model_name)
        _import(gmsh, brep, scale)
        gmsh.model.occ.healShapes(
            gmsh.model.getEntities(3), tolerance=float(tol_m), sewFaces=False, makeSolids=False,
            **dict(_HEAL_MODES)[ok_mode],
        )
        gmsh.model.occ.synchronize()
        left = orphan_surfaces(gmsh)
        if left:
            gmsh.model.occ.remove(left, recursive=True)
            gmsh.model.occ.synchronize()
    finally:
        if tmp_dir is not None:
            import shutil

            shutil.rmtree(tmp_dir, ignore_errors=True)
    return ok_mode
