"""Binary BREPs (source.bbrep) when the folder is removed while they are written.

OCCT's binary writer crashes the process (a segfault, no exception) when the folder it
writes to is not there: a geometry removed while its preview wrote the sidecar took the
worker down with it, and an import (``io.write_step_sidecar``) runs in the worker too.
``io.write_bbrep`` writes in the system temp folder and moves the file in; a move into a
removed folder fails, and the folder is not made again.
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


def _remove_before_write(monkeypatch: pytest.MonkeyPatch, folder: Path) -> list[str]:
    """``folder`` is removed after the checks, before the file is written (the temp name
    is made just before the write); the temp names made are returned."""
    from cfddesk.cad import io

    real_mkstemp = tempfile.mkstemp
    names: list[str] = []

    def remove_then_mkstemp(*args, **kwargs):
        shutil.rmtree(folder)
        fd, name = real_mkstemp(*args, **kwargs)
        names.append(name)
        return fd, name

    monkeypatch.setattr(io.tempfile, "mkstemp", remove_then_mkstemp)
    return names


def test_sidecar_into_a_removed_geometry_folder_is_not_written_and_does_not_make_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from cfddesk.cad import io, preview

    step = _geometry(tmp_path)
    shape = io._load_step(step)
    names = _remove_before_write(monkeypatch, step.parent)
    assert preview.ensure_step_sidecar(step, shape) == (None, False)
    assert not step.parent.exists()
    assert list(tmp_path.iterdir()) == []
    assert names and not any(Path(n).exists() for n in names)


def test_import_sidecar_into_a_removed_geometry_folder_is_not_written_and_does_not_make_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """``write_step_sidecar`` (an import, in the worker): None, no crash, no folder."""
    from cfddesk.cad import io

    step = _geometry(tmp_path)
    shape = io._load_step(step)
    names = _remove_before_write(monkeypatch, step.parent)
    assert io.write_step_sidecar(shape, step) is None
    assert not step.parent.exists()
    assert list(tmp_path.iterdir()) == []
    assert names and not any(Path(n).exists() for n in names)


def test_import_sidecar_is_whole_and_newer_than_the_step(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from cfddesk.cad import io

    step = _geometry(tmp_path)
    real_mkstemp = tempfile.mkstemp
    names: list[str] = []

    def record(*args, **kwargs):
        fd, name = real_mkstemp(*args, **kwargs)
        names.append(name)
        return fd, name

    monkeypatch.setattr(io.tempfile, "mkstemp", record)
    side = io.write_step_sidecar(io._load_step(step), step)
    assert side == io.step_sidecar_path(step)
    assert side.stat().st_mtime_ns >= step.stat().st_mtime_ns
    assert sorted(p.name for p in step.parent.iterdir()) == ["source.bbrep", "source.step"]
    assert names and not any(Path(n).exists() for n in names)
    assert not io.read_step_shape(step).IsNull()


def test_bbrep_moved_from_another_volume_is_copied_beside_it_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The temp folder on another volume (the move fails): copied to a temp name beside
    the file, then renamed; that name does not stay."""
    from cfddesk.cad import io

    step = _geometry(tmp_path)
    side = io.step_sidecar_path(step)
    real_replace = io.os.replace
    moves: list[tuple[str, str]] = []

    def cross_volume(src, dst):
        moves.append((str(src), str(dst)))
        if Path(src).parent != Path(dst).parent:
            raise OSError(18, "Invalid cross-device link")
        return real_replace(src, dst)

    monkeypatch.setattr(io.os, "replace", cross_volume)
    stamp = step.stat().st_mtime_ns
    assert io.write_bbrep(io._load_step(step), side, triangles=False, mtime_ns=stamp)
    assert len(moves) == 2 and Path(moves[1][0]).parent == step.parent
    assert side.stat().st_mtime_ns == stamp
    assert sorted(p.name for p in step.parent.iterdir()) == ["source.bbrep", "source.step"]


def test_link_preview_store_into_a_removed_job_folder_fails_the_job_not_the_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A text BREP is stored as source.bbrep in the job's staging folder: removed meanwhile
    (project deleted, job cancelled), the build raises (preview_failed), not a ``bad_brep``
    refusal of the plugin's shape, and the folder is not made again."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.BRepTools import BRepTools

    from cfddesk.cad import link_preview
    from cfddesk.cad.link_input import LinkInputError

    text = tmp_path / "shape.brep"
    assert BRepTools.Write_s(BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape(), str(text))
    out = tmp_path / "staging" / "job"
    out.mkdir(parents=True)
    _remove_before_write(monkeypatch, out)
    with pytest.raises(RuntimeError, match="folder was removed") as err:
        link_preview.build(text, "brep", None, None, out)
    assert not isinstance(err.value, LinkInputError)
    assert not out.exists()


def test_sidecar_is_written_beside_the_step_with_its_mtime(tmp_path: Path):
    from cfddesk.cad import io, preview

    step = _geometry(tmp_path)
    side, written = preview.ensure_step_sidecar(step, io._load_step(step))
    assert written and side == io.step_sidecar_path(step)
    assert side.stat().st_mtime_ns == step.stat().st_mtime_ns
    assert sorted(p.name for p in step.parent.iterdir()) == ["source.bbrep", "source.step"]
    assert io.read_step_shape(step) is not None
