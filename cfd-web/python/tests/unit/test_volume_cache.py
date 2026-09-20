"""Worker volume LRU must keep cell-only U meshes for cutting planes."""
from __future__ import annotations

import pyvista as pv

from cfddesk.worker import volume_cache
import case_volume  # noqa: E402  — volume_cache puts tools/ on sys.path


def test_get_prepared_caches_cell_only_u(tmp_path, monkeypatch):
    volume_cache.clear()
    mesh = pv.ImageData(dimensions=(3, 3, 3)).cast_to_unstructured_grid()
    mesh.cell_data["U"] = [[1.0, 0.0, 0.0]] * mesh.n_cells

    def _load(case, time, **_kw):
        return mesh, "test-cell-u"

    monkeypatch.setattr(case_volume, "load_volume", _load)
    first = volume_cache.get_prepared(str(tmp_path), "1")
    assert first["mesh"] is mesh
    assert first["has_cell_u"] or first["has_point_u"]
    slice_src = first.get("slice") or first.get("grid")
    assert slice_src is not None
    assert "magU" in slice_src.point_data or "magU" in slice_src.cell_data
    second = volume_cache.get_prepared(str(tmp_path), "1")
    assert second is first
    assert volume_cache.cached_count() == 1
    volume_cache.clear()
    assert volume_cache.cached_count() == 0


def test_get_prepared_requires_a_mesh(tmp_path, monkeypatch):
    volume_cache.clear()

    def _load(case, time, **_kw):
        raise RuntimeError(f"volume read failed: {case}")

    monkeypatch.setattr(case_volume, "load_volume", _load)
    try:
        volume_cache.get_prepared(str(tmp_path), "0")
    except RuntimeError as exc:
        assert "volume read failed" in str(exc)
    else:
        raise AssertionError("expected volume read failed")
