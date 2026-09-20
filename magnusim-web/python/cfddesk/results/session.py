"""Results session: selective polyhedra prep, sidecar cache, lazy point data."""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

import pyvista as pv

from cfddesk.results.loader import (
    ResultMesh,
    _finalize_field,
    prepare_grid_for_slice,
    read_foam_grid,
)

CACHE_VTU = ".cfddesk-prepared.vtu"
CACHE_META = ".cfddesk-prepared.json"


def logical_case_dir(case_dir: str | Path) -> Path:
    """Absolute case path without following junctions/symlinks.

    ``Path.resolve()`` follows Windows junctions, which silently rewrites an
    active ``results/.../run-<new>`` path into a prior fixture/target run id.
    View Results / ResultsSession must keep the caller-facing active run path.
    ``os.path.abspath`` normalizes ``.`` / ``..`` but does not follow reparse
    points, so ``case_dir`` stays bound to the project results_path.
    """
    return Path(os.path.abspath(os.fspath(case_dir)))


def _mtime_ns(path: Path) -> int:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return 0


def case_fingerprint(case_dir: Path) -> str:
    """Stable fingerprint of mesh + latest time fields for cache invalidation."""
    case_dir = Path(case_dir)
    parts: list[str] = []
    foams = sorted(case_dir.glob("*.foam"))
    for p in foams:
        parts.append(f"foam:{p.name}:{_mtime_ns(p)}")
    points = case_dir / "constant" / "polyMesh" / "points"
    owner = case_dir / "constant" / "polyMesh" / "owner"
    for p in (points, owner):
        if p.is_file():
            parts.append(f"{p.relative_to(case_dir)}:{_mtime_ns(p)}:{p.stat().st_size}")
    # Latest numeric time directory
    time_dirs: list[tuple[float, Path]] = []
    for child in case_dir.iterdir():
        if not child.is_dir():
            continue
        try:
            t = float(child.name)
        except ValueError:
            continue
        time_dirs.append((t, child))
    if time_dirs:
        _, latest = max(time_dirs, key=lambda x: x[0])
        parts.append(f"time:{latest.name}:{_mtime_ns(latest)}")
        for name in ("U", "p", "T", "p_rgh"):
            f = latest / name
            if f.is_file():
                parts.append(f"{name}:{_mtime_ns(f)}:{f.stat().st_size}")
    raw = "\n".join(parts).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:24]


@dataclass
class ResultsSession:
    """Prepared cell grid for viewing; point data built lazily for streamlines."""

    case_dir: Path
    foam_path: Path
    grid: pv.UnstructuredGrid
    field_name: str
    raw_n_cells: int
    prepared_n_cells: int
    n_points: int
    polyhedra_decomposed: bool
    from_cache: bool
    fingerprint: str
    read_s: float = 0.0
    prep_s: float = 0.0
    cache_load_s: float = 0.0
    point_data_s: float | None = None
    _point_grid: pv.UnstructuredGrid | None = field(default=None, repr=False)

    @property
    def has_mag_u(self) -> bool:
        g = self.grid
        return (
            self.field_name == "magU"
            or "U" in g.cell_data
            or "U" in g.point_data
            or "magU" in g.cell_data
        )

    def to_result_mesh(self) -> ResultMesh:
        return ResultMesh(
            path=self.foam_path,
            grid=self.grid,
            n_cells=self.prepared_n_cells,
            n_points=self.n_points,
            field_name=self.field_name,
            has_mag_u=self.has_mag_u,
            reader="foam",
            polyhedra_decomposed=self.polyhedra_decomposed,
        )

    def ensure_point_data(self) -> pv.UnstructuredGrid:
        """Cell→point interpolation — only when streamlines (or similar) need it."""
        if self._point_grid is not None:
            return self._point_grid
        t0 = time.perf_counter()
        point = self.grid.cell_data_to_point_data()
        if not isinstance(point, pv.UnstructuredGrid):
            point = pv.UnstructuredGrid(point)
        self._point_grid = point
        self.point_data_s = time.perf_counter() - t0
        return self._point_grid

    def bounds_diagonal(self) -> float:
        b = self.grid.bounds
        dx = b[1] - b[0]
        dy = b[3] - b[2]
        dz = b[5] - b[4]
        return float((dx * dx + dy * dy + dz * dz) ** 0.5)

    @classmethod
    def open(
        cls,
        case_dir: str | Path,
        *,
        prefer_field: str | None = None,
        use_cache: bool = True,
        write_cache: bool = True,
    ) -> ResultsSession:
        # Keep the active run path (do not follow junctions to a prior run id).
        case_dir = logical_case_dir(case_dir)
        fp = case_fingerprint(case_dir)
        meta_path = case_dir / CACHE_META
        vtu_path = case_dir / CACHE_VTU

        if use_cache and meta_path.is_file() and vtu_path.is_file():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                if meta.get("fingerprint") == fp:
                    t0 = time.perf_counter()
                    grid = pv.read(vtu_path)
                    if not isinstance(grid, pv.UnstructuredGrid):
                        grid = pv.UnstructuredGrid(grid)
                    cache_s = time.perf_counter() - t0
                    field = str(meta.get("field_name") or prefer_field or "magU")
                    field = _finalize_field(grid, prefer_field or field)
                    foam = case_dir / str(meta.get("foam_name", "case.foam"))
                    if not foam.is_file():
                        from cfddesk.results.loader import find_foam_marker

                        foam = find_foam_marker(case_dir)
                    return cls(
                        case_dir=case_dir,
                        foam_path=foam,
                        grid=grid,
                        field_name=field,
                        raw_n_cells=int(meta.get("raw_n_cells", grid.n_cells)),
                        prepared_n_cells=int(grid.n_cells),
                        n_points=int(grid.n_points),
                        polyhedra_decomposed=bool(meta.get("polyhedra_decomposed", False)),
                        from_cache=True,
                        fingerprint=fp,
                        cache_load_s=cache_s,
                    )
            except Exception:
                pass

        t0 = time.perf_counter()
        raw, foam, field, reader_dec = read_foam_grid(case_dir, prefer_field=prefer_field)
        read_s = time.perf_counter() - t0
        raw_n = int(raw.n_cells)

        t1 = time.perf_counter()
        grid, tri_dec = prepare_grid_for_slice(raw)
        prep_s = time.perf_counter() - t1
        if tri_dec:
            field = _finalize_field(grid, prefer_field or field, after_prep=True)

        session = cls(
            case_dir=case_dir,
            foam_path=foam,
            grid=grid,
            field_name=field,
            raw_n_cells=raw_n,
            prepared_n_cells=int(grid.n_cells),
            n_points=int(grid.n_points),
            polyhedra_decomposed=reader_dec or tri_dec,
            from_cache=False,
            fingerprint=fp,
            read_s=read_s,
            prep_s=prep_s,
        )

        if write_cache:
            try:
                grid.save(str(vtu_path))
                meta_path.write_text(
                    json.dumps(
                        {
                            "fingerprint": fp,
                            "field_name": field,
                            "foam_name": foam.name,
                            "raw_n_cells": raw_n,
                            "prepared_n_cells": int(grid.n_cells),
                            "n_points": int(grid.n_points),
                            "polyhedra_decomposed": session.polyhedra_decomposed,
                            "prep": "selective_polyhedra",
                        },
                        indent=2,
                    )
                    + "\n",
                    encoding="utf-8",
                )
            except Exception:
                pass

        return session
