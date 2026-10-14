"""The preview's STEP sidecar (source.bbrep) when the geometry is removed while it is made.

OCCT's binary writer crashes the process (a segfault, no exception) when the folder it
writes to is not there: a geometry removed while its preview wrote the sidecar took the
worker down with it. The sidecar is written in the system temp folder and moved in; a move
into a removed folder fails, and the folder is not made again.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from tests.conftest import FIXTURES

STEP = FIXTURES / "geometry" / "transient-test.step"


def _geometry(tmp_path: Path) -> Path:
    folder = tmp_path / "Geometry_part"
    folder.mkdir()
    step = folder / "source.step"
    shutil.copy(STEP, step)
    return step


def test_sidecar_into_a_removed_geometry_folder_is_not_written_and_does_not_make_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from cfddesk.cad import io, preview

    step = _geometry(tmp_path)
    shape = io._load_step(step)
    real_mkstemp = tempfile.mkstemp

    def remove_then_mkstemp(*args, **kwargs):
        # The geometry is removed after the sidecar's checks, before it is written.
        shutil.rmtree(step.parent)
        return real_mkstemp(*args, **kwargs)

    monkeypatch.setattr(preview.tempfile, "mkstemp", remove_then_mkstemp)
    assert preview.ensure_step_sidecar(step, shape) == (None, False)
    assert not step.parent.exists()
    assert list(tmp_path.iterdir()) == []


def test_sidecar_is_written_beside_the_step_with_its_mtime(tmp_path: Path):
    from cfddesk.cad import io, preview

    step = _geometry(tmp_path)
    side, written = preview.ensure_step_sidecar(step, io._load_step(step))
    assert written and side == io.step_sidecar_path(step)
    assert side.stat().st_mtime_ns == step.stat().st_mtime_ns
    assert sorted(p.name for p in step.parent.iterdir()) == ["source.bbrep", "source.step"]
    assert io.read_step_shape(step) is not None
