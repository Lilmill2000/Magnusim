"""Shared volume loader for the result exporters.

Reads the OpenFOAM case at one time step through pyvista's OpenFOAMReader and
keeps a binary VTU copy under ``cfd-web/.cache/volume`` so later exporters
(cut plane, inspect point, particle trace, surface field) do not re-parse the
ASCII case on every request. ``.cfddesk-prepared.vtu`` in the case directory
is used only for legacy prepared cases without native fields at the requested time.

The cache key includes the U/p file stamps, so a re-run of the same case
invalidates the cached volume.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import pyvista as pv

# tools/ -> python/ -> cfd-web/; server scratch lives in cfd-web/.cache
CACHE_ROOT = Path(__file__).resolve().parents[2] / ".cache" / "volume"


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


def _stamp(case_dir: Path, time: str) -> str:
    h = hashlib.sha1()
    h.update(str(case_dir).encode("utf-8"))
    h.update(b"|native-fields-v2|")
    h.update(str(time).encode("utf-8"))
    for name in ("U", "p", "U.gz", "p.gz"):
        f = case_dir / str(time) / name
        if f.is_file():
            st = f.stat()
            h.update(f"|{name}:{st.st_mtime_ns}:{st.st_size}".encode("ascii"))
    pts = case_dir / "constant" / "polyMesh" / "points"
    if pts.is_file():
        st = pts.stat()
        h.update(f"|points:{st.st_mtime_ns}:{st.st_size}".encode("ascii"))
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
    native_fields = any(
        (case_dir / str(time) / name).is_file()
        for name in ("U", "p", "U.gz", "p.gz")
    )
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
            tmp = cache_path.with_suffix(".tmp.vtu")
            mesh.save(str(tmp), binary=True)
            tmp.replace(cache_path)
        except Exception:
            pass
    return mesh, "OpenFOAMReader:" + str(case_dir)
