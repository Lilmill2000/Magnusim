"""Shared volume loader for the result exporters.

Reads the OpenFOAM case at one time step through pyvista's OpenFOAMReader and
keeps a binary VTU copy under ``cfd-web/.cache/volume`` so later exporters
(cut plane, inspect point, particle trace, surface field) do not re-parse the
ASCII case on every request. ``.cfddesk-prepared.vtu`` in the case directory
is used only for legacy prepared cases without native fields at the requested time.

The cache key includes the time's field file stamps and the mesh points, so a
re-run of the same case invalidates the cached volume.

A multi-region case (its ``w27-case.json`` lists ``regions``, host API 1.8)
reads each region's mesh and fields, merged into one volume
(``cfddesk.results.regions``); its stamp covers every region's files.
"""
from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

import pyvista as pv

# tools/ -> python/ -> cfd-web/; server scratch lives in cfd-web/.cache
CACHE_ROOT = Path(__file__).resolve().parents[2] / ".cache" / "volume"

_PY_ROOT = Path(__file__).resolve().parents[1]
if str(_PY_ROOT) not in sys.path:
    sys.path.insert(0, str(_PY_ROOT))

from cfddesk.results.regions import read_regions, region_names, stamp_files  # noqa: E402


def _internal_mesh(mesh):
    if mesh is None:
        return None
    if isinstance(mesh, pv.MultiBlock):
        internal = None
        for i in range(mesh.n_blocks):
            block = mesh[i]
            if block is None:
                continue
            name = mesh.get_block_name(i) if hasattr(mesh, "get_block_name") else str(i)
            if "internal" in str(name).lower():
                return block
            if internal is None:
                internal = block
        return internal if internal is not None else mesh.combine()
    return mesh


def time_field_files(case_dir: Path, time: str) -> list[Path]:
    """Every field file a time folder holds (whatever the analysis solved), sorted;
    in a multi-region case every region's, region by region."""
    names = region_names(case_dir)
    folders = [Path(case_dir) / str(time) / r for r in names] if names else [Path(case_dir) / str(time)]
    out: list[Path] = []
    for folder in folders:
        try:
            out.extend(sorted(f for f in folder.iterdir() if f.is_file() and not f.name.startswith(".")))
        except OSError:
            continue
    return out


def _stamp(case_dir: Path, time: str) -> str:
    h = hashlib.sha1()
    h.update(str(case_dir).encode("utf-8"))
    h.update(b"|native-fields-v3|")
    h.update(str(time).encode("utf-8"))
    if not region_names(case_dir):
        for f in time_field_files(case_dir, time):
            st = f.stat()
            h.update(f"|{f.name}:{st.st_mtime_ns}:{st.st_size}".encode())
        pts = case_dir / "constant" / "polyMesh" / "points"
        if pts.is_file():
            st = pts.stat()
            h.update(f"|points:{st.st_mtime_ns}:{st.st_size}".encode("ascii"))
        return h.hexdigest()[:20]
    # A multi-region case: every region's fields and mesh points.
    h.update(b"|regions|")
    for f in stamp_files(case_dir, time):
        st = f.stat()
        rel = f.relative_to(case_dir).as_posix()
        h.update(f"|{rel}:{st.st_mtime_ns}:{st.st_size}".encode())
    return h.hexdigest()[:20]


def read_openfoam_volume(case_dir: Path, time: str):
    foam = case_dir / "case.foam"
    if not foam.is_file():
        foam.write_text("", encoding="ascii")
    reader = pv.OpenFOAMReader(str(foam))
    try:
        target = float(time)
        values = list(reader.time_values or [])
        if values:
            pick = min(values, key=lambda t: abs(float(t) - target))
            reader.set_active_time_value(pick)
    except Exception:
        pass
    regions = region_names(case_dir)
    if regions:
        return read_regions(reader, regions)
    try:
        reader.disable_all_patch_arrays()
        reader.enable_patch_array("internalMesh")
    except Exception:
        pass
    return _internal_mesh(reader.read())


def load_volume(case_dir: Path, time: str, *, use_cache: bool = True):
    """Return (volume UnstructuredGrid, source description)."""
    case_dir = Path(case_dir).resolve()
    prepared = case_dir / ".cfddesk-prepared.vtu"
    native_fields = bool(time_field_files(case_dir, time))
    if prepared.is_file() and not native_fields:
        mesh = pv.read(str(prepared))
        if mesh is not None and int(getattr(mesh, "n_cells", 0) or 0) > 0:
            return mesh, str(prepared)

    cache_path = None
    if use_cache:
        cache_path = CACHE_ROOT / f"vol-{_stamp(case_dir, time)}.vtu"
        if cache_path.is_file():
            try:
                mesh = pv.read(str(cache_path))
                if mesh is not None and int(getattr(mesh, "n_cells", 0) or 0) > 0:
                    return mesh, "cache:" + str(cache_path)
            except Exception:
                pass

    mesh = read_openfoam_volume(case_dir, time)
    if mesh is None or int(getattr(mesh, "n_cells", 0) or 0) < 1:
        raise RuntimeError(f"volume read failed: {case_dir} @ {time}")
    if not isinstance(mesh, pv.UnstructuredGrid):
        try:
            mesh = mesh.cast_to_unstructured_grid()
        except Exception:
            pass
    if cache_path is not None:
        try:
            CACHE_ROOT.mkdir(parents=True, exist_ok=True)
            # Per-process tmp: iso surface/volume exporters and the worker
            # warmup can all build the same cold entry concurrently.
            tmp = cache_path.with_name(f"{cache_path.stem}.{os.getpid()}.tmp.vtu")
            mesh.save(str(tmp), binary=True)
            tmp.replace(cache_path)
        except Exception:
            pass
    return mesh, "OpenFOAMReader:" + str(case_dir)
