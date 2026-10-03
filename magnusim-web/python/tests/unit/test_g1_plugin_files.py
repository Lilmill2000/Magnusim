"""G1: a plugin's own files in a project, plugins/<key>/<rel> (API 1.2).

The path rules (magnusim_sdk.data.data_rel) pass the vectors in
tests/fixtures/plugin-file-paths.json, which the host's file routes read too,
so both refuse the same spellings. PluginData's binary calls write in one step
(a ".magnusim-*" temp replaced, retried while another program holds the file),
never reach a study's record in any spelling or through a link or an 8.3 name,
and list and delete without following links. The manifest's [files] limits
reach plugins.list in bytes; a bad [files] table fails only that plugin.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from functools import partial
from pathlib import Path

import magnusim_sdk.data as sdk_data
import pytest

from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import files_spec_from_meta
from cfddesk.registry.manifest import MB, FilesSpec
from cfddesk.registry.plugin_data import (
    FILE_TEMP_PREFIX,
    STUDY_RECORD_MESSAGE,
    PluginData,
    PluginDataError,
    data_rel,
    is_study_container,
    is_study_record,
)
from cfddesk.worker import methods
from cfddesk.worker.rpc import RpcError

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
VECTORS = json.loads((FIXTURES / "plugin-file-paths.json").read_text(encoding="utf-8"))
WS_FIXTURE = FIXTURES / "workspace-plugins" / "ws-demo"
WS_KEY = "ws-demo"
KEY = "files-demo"
# A plugin of this test's own, so its [files] table is only what a test writes.
PLUG_KEY = "files-plug"
PLUG_MANIFEST = (
    'key = "files-plug"\nname = "Files plug"\nversion = "1.0.0"\napi_version = "1.2"\nlicense = "GPL-3.0-or-later"\n'
)
DEFAULT_ROW = {"max_file_bytes": 64 * MB, "max_total_bytes": 512 * MB}
STUDY_FOLDER_MESSAGE = "only the study calls write directly in the studies folder"


def _id(i: int, rel: str) -> str:
    return f"{i}-{ascii(rel[:24])}"


def _raises(code: str, fn, *args, **kwargs) -> PluginDataError:
    with pytest.raises(PluginDataError) as err:
        fn(*args, **kwargs)
    assert err.value.code == code, (err.value.code, str(err.value))
    return err.value


def _rpc_refused(fn, *args, **kwargs) -> RpcError:
    with pytest.raises(RpcError) as err:
        fn(*args, **kwargs)
    assert err.value.code == -32602
    return err.value


def _link_folder(link: Path, target: Path) -> None:
    """A junction on Windows (no admin rights needed), a symlink elsewhere."""
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    else:
        os.symlink(target, link, target_is_directory=True)


def _short_name(path: Path) -> str | None:
    import ctypes

    buf = ctypes.create_unicode_buffer(1024)
    if not ctypes.windll.kernel32.GetShortPathNameW(str(path), buf, 1024):
        return None
    short = Path(buf.value).name
    return None if short.lower() == path.name.lower() else short


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "projects" / "proj-a"
    root.mkdir(parents=True)
    (root / "project.json").write_text("{}", encoding="utf-8")
    return root


@pytest.fixture
def data(project: Path) -> PluginData:
    return PluginData(project, KEY)


def _study(data: PluginData, sid: str = "st-1") -> Path:
    data.write_json(f"studies/{sid}/study.json", {"id": sid, "kind": "k", "title": "T", "rev": 1})
    return data.root / "studies" / sid / "study.json"


# -- path rules: the shared vectors -------------------------------------


@pytest.mark.parametrize(("rel", "want"), VECTORS["allowed"], ids=[_id(i, v[0]) for i, v in enumerate(VECTORS["allowed"])])
def test_allowed_paths(rel: str, want: str):
    assert data_rel(rel, write=False) == want
    assert data_rel(rel, write=True) == want
    assert methods._plugin_data_rel(rel, write=False) == want
    assert methods._plugin_data_rel(rel, write=True) == want


@pytest.mark.parametrize("rel", VECTORS["refused_any"], ids=[_id(i, v) for i, v in enumerate(VECTORS["refused_any"])])
def test_refused_paths(rel: str):
    for write in (False, True):
        err = _raises("invalid_path", data_rel, rel, write=write)
        assert _rpc_refused(methods._plugin_data_rel, rel, write=write).message == str(err)


@pytest.mark.parametrize("rel", VECTORS["refused_write"])
def test_study_records_are_read_only(rel: str):
    clean = data_rel(rel, write=False)
    assert is_study_record(clean.split("/"))
    assert methods._plugin_data_rel(rel, write=False) == clean
    assert str(_raises("study_record", data_rel, rel, write=True)) == STUDY_RECORD_MESSAGE
    assert _rpc_refused(methods._plugin_data_rel, rel, write=True).message == STUDY_RECORD_MESSAGE
    assert methods._is_study_record(clean.split("/"))


@pytest.mark.parametrize("rel", VECTORS["study_containers"])
def test_study_containers_are_never_written_or_deleted(rel: str, data: PluginData):
    record = _study(data, "st-1")
    before = record.read_bytes()
    clean = data_rel(rel, write=False)
    assert is_study_container(clean.split("/"))
    assert methods._plugin_data_rel(rel, write=False) == clean
    # A file there would block a study's folder (or the studies folder itself).
    assert str(_raises("study_record", data_rel, rel, write=True)) == STUDY_FOLDER_MESSAGE
    assert _rpc_refused(methods._plugin_data_rel, rel, write=True).message == STUDY_FOLDER_MESSAGE
    _raises("study_record", data.write_bytes, rel, b"x")
    _raises("study_record", data.file_path, rel, write=True)
    _raises("study_record", data.delete_file, rel)
    _raises("study_record", data.delete_file, rel, recursive=True)
    assert record.read_bytes() == before
    assert [s["id"] for s in data.studies()] == ["st-1"]


def test_the_plugin_folder_itself_only_as_a_list_prefix():
    for rel in ("", "   ", ".", "./", " ./. ", None):
        assert data_rel(rel, write=False, allow_empty=True) == ""
        _raises("invalid_path", data_rel, rel, write=False)
    _raises("invalid_path", data_rel, "\\", write=False, allow_empty=True)
    _raises("invalid_path", data_rel, 5, write=False)


def test_lengths_count_utf16_code_units():
    # One emoji is two UTF-16 units, as Windows' name limits and JavaScript count it.
    face = "\U0001f600"
    assert data_rel(face * 120, write=True) == face * 120
    _raises("invalid_path", data_rel, face * 121, write=True)
    _raises("invalid_path", data_rel, "a/" * 511 + face, write=False)


def test_device_names_are_matched_ascii_only():
    # As JavaScript's /i: Python's re.I would also fold the dotless i into "conin$",
    # which Windows opens as an ordinary file.
    assert data_rel("conın$", write=True) == "conın$"
    for rel in ("CON", "Aux.tar.gz", "LpT0", "com0.x", "conIN$.log"):
        _raises("invalid_path", data_rel, rel, write=True)


# -- reading and writing bytes ------------------------------------------


def test_bytes_round_trip(data: PluginData):
    payload = bytes(range(256)) * 1000
    info = data.write_bytes("imports/Part A.step", payload)
    assert info["rel"] == "imports/Part A.step" and info["size"] == len(payload)
    path = data.root / "imports" / "Part A.step"
    assert path.read_bytes() == payload
    assert data.read_bytes("imports\\Part A.step") == payload
    assert data.file_info(" ./imports//Part A.step ") == info
    with data.open_bytes("imports/Part A.step") as fh:
        fh.seek(256)
        assert fh.read(3) == b"\x00\x01\x02"
    again = data.write_bytes("imports/Part A.step", bytearray(b"x"))
    assert again["size"] == 1 and again["etag"] != info["etag"]
    assert data.read_bytes("imports/Part A.step") == b"x"
    assert data.write_bytes("empty.bin", memoryview(b""))["size"] == 0
    assert data.read_bytes("empty.bin") == b""
    # Nothing left behind next to the files.
    assert sorted(p.name for p in path.parent.iterdir()) == ["Part A.step"]
    assert sorted(p.name for p in data.root.iterdir()) == ["empty.bin", "imports"]
    # Missing files and folders are not files.
    assert data.read_bytes("imports/none.bin") is None
    assert data.file_info("imports/none.bin") is None
    assert data.file_info("imports") is None
    assert data.read_bytes("imports") is None
    with pytest.raises(FileNotFoundError):
        data.open_bytes("imports/none.bin")
    assert data.file_path("imports/Part A.step").samefile(path)


def test_write_refuses_a_folder_or_a_file_in_the_way(data: PluginData):
    data.write_bytes("a/x.bin", b"x")
    _raises("is_folder", data.write_bytes, "a", b"")
    _raises("is_folder", data.write_bytes, "a/x.bin/y.bin", b"")
    with pytest.raises(PluginDataError) as err, data.atomic_path("a"):
        pass
    assert err.value.code == "is_folder"
    assert data.read_bytes("a/x.bin") == b"x"


def test_atomic_path_replaces_in_one_step(data: PluginData):
    data.write_bytes("mesh/case.msh", b"old")
    folder = data.root / "mesh"
    with data.atomic_path("mesh/case.msh") as tmp:
        assert tmp.parent.samefile(folder)
        # The extension stays last, so a writer that picks its format from the name still does.
        assert tmp.name.startswith(FILE_TEMP_PREFIX) and tmp.name.endswith(".part.msh")
        tmp.write_bytes(b"new")
        # Readers still see the whole old file until the block ends.
        assert (folder / "case.msh").read_bytes() == b"old"
    assert (folder / "case.msh").read_bytes() == b"new"
    assert [p.name for p in folder.iterdir()] == ["case.msh"]
    # An error inside the block keeps the old file and removes the temp.
    with pytest.raises(RuntimeError), data.atomic_path("mesh/case.msh") as tmp:
        tmp.write_bytes(b"half")
        raise RuntimeError("the mesher stopped")
    assert (folder / "case.msh").read_bytes() == b"new"
    assert [p.name for p in folder.iterdir()] == ["case.msh"]
    # A new file in a new folder.
    with data.atomic_path("exports/run-1/result.vtk") as tmp:
        tmp.write_bytes(b"vtk")
    assert data.read_bytes("exports/run-1/result.vtk") == b"vtk"


def test_replace_is_retried_while_another_program_holds_the_file(data: PluginData, monkeypatch: pytest.MonkeyPatch):
    real_replace = os.replace
    names: list[str] = []
    sleeps: list[float] = []

    def flaky(src, dst):
        names.append(Path(src).name)
        if len(names) < 3:
            raise PermissionError(13, "in use")
        return real_replace(src, dst)

    monkeypatch.setattr(sdk_data.os, "replace", flaky)
    monkeypatch.setattr(sdk_data.time, "sleep", sleeps.append)
    assert data.write_bytes("held.bin", b"abc")["size"] == 3
    assert data.read_bytes("held.bin") == b"abc"
    assert len(names) == 3 and all(n.startswith(FILE_TEMP_PREFIX) and n.endswith(".part.bin") for n in names)
    assert sleeps == pytest.approx([0.05, 0.10])

    def held(src, dst):
        raise PermissionError(13, "in use")

    monkeypatch.setattr(sdk_data.os, "replace", held)
    sleeps.clear()
    err = _raises("busy", data.write_bytes, "held.bin", b"new")
    assert str(err) == "held.bin is in use by another program"
    # 8 tries, 50..350 ms apart; the old file stays and the temp is gone.
    assert sleeps == pytest.approx([0.05 * n for n in range(1, 8)])
    assert data.read_bytes("held.bin") == b"abc"
    assert [p.name for p in data.root.iterdir()] == ["held.bin"]


def test_json_writes_use_the_reserved_temp_prefix_and_retry(data: PluginData, monkeypatch: pytest.MonkeyPatch):
    real_replace = os.replace
    names: list[str] = []

    def flaky(src, dst):
        names.append(Path(src).name)
        if len(names) == 1:
            raise PermissionError(13, "in use")
        return real_replace(src, dst)

    monkeypatch.setattr(sdk_data.os, "replace", flaky)
    monkeypatch.setattr(sdk_data.time, "sleep", lambda s: None)
    data.write_json("notes/n.json", {"a": 1})
    assert data.read_json("notes/n.json") == {"a": 1}
    assert len(names) == 2 and all(n.startswith(".magnusim-tmp-") and n.endswith(".json") for n in names)
    assert [p.name for p in (data.root / "notes").iterdir()] == ["n.json"]
    # The host's temps are never named by a path.
    _raises("invalid_path", data.read_bytes, f"notes/{names[0]}")
    assert _rpc_refused(methods._plugin_data_rel, f"notes/{names[0]}", write=False)


def test_etag_and_mtime_strings(data: PluginData):
    data.write_bytes("t.bin", b"12345")
    path = data.root / "t.bin"
    ns = 1_700_000_000_123_456_700  # a multiple of 100 ns: NTFS keeps 100 ns
    os.utime(path, ns=(ns, ns))
    st = os.stat(path)
    assert st.st_mtime_ns == ns
    info = data.file_info("t.bin")
    # mtime: ISO-8601 UTC, whole milliseconds (floored), "Z".
    # etag: '"' + ino hex + "-" + size hex + "-" + mtime ns hex + '"'.
    assert info == {
        "rel": "t.bin",
        "size": 5,
        "mtime": "2023-11-14T22:13:20.123Z",
        "etag": f'"{st.st_ino:x}-5-{ns:x}"',
    }
    assert re.fullmatch(r'"[0-9a-f]+-[0-9a-f]+-[0-9a-f]+"', info["etag"])
    late = 1_700_000_000_999_999_900
    os.utime(path, ns=(late, late))
    assert data.file_info("t.bin")["mtime"] == "2023-11-14T22:13:20.999Z"
    assert data.list_files() == [data.file_info("t.bin")]
    # Before 1970: Node's stat on Windows keeps the seconds unsigned 32-bit, so the
    # host sees 2106; file_info wraps the same way there (elsewhere both see 1969).
    os.utime(path, ns=(-1_500_000, -1_500_000))
    if os.name == "nt":
        wrapped = (2**32 - 1) * 10**9 + 998_500_000
        want = ("2106-02-07T06:28:15.998Z", f'"{st.st_ino:x}-5-{wrapped:x}"')
    else:
        want = ("1969-12-31T23:59:59.998Z", f'"{st.st_ino:x}-5--16e360"')
    info = data.file_info("t.bin")
    assert (info["mtime"], info["etag"]) == want


# -- study records, links and aliases -----------------------------------


def test_no_spelling_writes_or_deletes_a_study_record(data: PluginData):
    sid = data.create_study("bench_case", "Wing")["id"]
    record = data.root / "studies" / sid / "study.json"
    before = record.read_bytes()
    spellings = [rel.replace("st-1", sid).replace("ST-1", sid.upper()) for rel in VECTORS["refused_write"]] + [
        f"notes/../studies/{sid}/study.json",
        f"studies/{sid}/study.json.",
        f"studies/{sid}/study.json ",
        f"studies/{sid}/study.json::$DATA",
        f"studies/{sid}/STUDY~1.JSO",
        f"\tstudies/{sid}/study.json\r\n",
    ]
    for rel in spellings:
        for call in (
            partial(data.write_bytes, rel, b"{}"),
            partial(data.delete_file, rel),
            partial(data.delete_file, rel, recursive=True),
            partial(data.file_path, rel, write=True),
        ):
            with pytest.raises(PluginDataError) as err:
                call()
            assert err.value.code in {"study_record", "invalid_path"}, rel
        with pytest.raises(PluginDataError), data.atomic_path(rel):
            pass
    assert record.read_bytes() == before
    # Reading it is allowed, and a study's own files are the plugin's.
    assert data.read_bytes(f"studies/{sid}/study.json") == before
    data.write_bytes(f"studies/{sid}/polar.bin", b"p")
    assert data.delete_file(f"studies/{sid}/polar.bin") == 1
    assert [f["rel"] for f in data.list_files("studies")] == [f"studies/{sid}/study.json"]


def test_a_link_inside_the_folder_is_checked_where_it_lands(data: PluginData, tmp_path: Path):
    sid = data.create_study("bench_case", "Wing")["id"]
    record = data.root / "studies" / sid / "study.json"
    before = record.read_bytes()
    _link_folder(data.root / "alias", data.root / "studies")
    _raises("study_record", data.write_bytes, f"alias/{sid}/study.json", b"{}")
    _raises("study_record", data.delete_file, f"alias/{sid}/study.json")
    _raises("study_record", data.delete_file, f"alias/{sid}", recursive=True)
    # A study's own files, through the link, land under their real path.
    assert data.write_bytes(f"alias/{sid}/polar.bin", b"p")["rel"] == f"studies/{sid}/polar.bin"
    # A listing does not follow the link; deleting the link removes only the link.
    rels = [f["rel"] for f in data.list_files()]
    assert rels == [f"studies/{sid}/polar.bin", f"studies/{sid}/study.json"]
    assert data.delete_file("alias") == 1
    assert not os.path.lexists(data.root / "alias")
    assert record.read_bytes() == before and (data.root / "studies" / sid / "polar.bin").is_file()
    # A link out of the folder is refused both ways; deleting it keeps the target.
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "secret.bin").write_bytes(b"s")
    _link_folder(data.root / "out", outside)
    _raises("invalid_path", data.read_bytes, "out/secret.bin")
    _raises("invalid_path", data.write_bytes, "out/x.bin", b"x")
    _raises("invalid_path", data.list_files, "out")
    assert data.delete_file("out") == 1
    assert sorted(p.name for p in outside.iterdir()) == ["secret.bin"]


def test_a_link_swapped_in_for_the_plugin_folder_is_refused(project: Path, tmp_path: Path):
    other = tmp_path / "other"
    other.mkdir()
    (other / "x.bin").write_bytes(b"secret")
    (project / "plugins").mkdir()
    _link_folder(project / "plugins" / KEY, other)
    data = PluginData(project, KEY)
    _raises("invalid_path", data.read_bytes, "x.bin")
    _raises("invalid_path", data.file_info, "x.bin")
    _raises("invalid_path", data.list_files)
    _raises("invalid_path", data.write_bytes, "y.bin", b"")
    _raises("invalid_path", data.delete_file, "x.bin")
    assert sorted(p.name for p in other.iterdir()) == ["x.bin"]


@pytest.mark.skipif(os.name != "nt", reason="8.3 short names are a Windows alias")
def test_a_short_name_is_caught_where_it_lands(data: PluginData, monkeypatch: pytest.MonkeyPatch):
    sid = data.create_study("bench_case", "Wing")["id"]
    record = data.root / "studies" / sid / "study.json"
    before = record.read_bytes()
    short_file = _short_name(record)
    short_dir = _short_name(record.parent)
    if short_file is None or short_dir is None:
        pytest.skip("8.3 names are off on this volume")
    aliases = [f"studies/{sid}/{short_file}", f"studies/{short_dir}/study.json", f"studies/{short_dir}/{short_file}"]
    # The rules refuse `~` outright...
    for rel in aliases:
        _raises("invalid_path", data.write_bytes, rel, b"{}")
        _raises("invalid_path", data.delete_file, rel)
    # ...and without them, the check where it lands still sees the long name.
    monkeypatch.setattr(sdk_data, "data_rel", lambda rel, *, write, allow_empty=False: rel)
    for rel in aliases:
        _raises("study_record", data.write_bytes, rel, b"{}")
        _raises("study_record", data.delete_file, rel)
        _raises("study_record", data.file_path, rel, write=True)
    _raises("study_record", data.delete_file, f"studies/{short_dir}", recursive=True)
    assert record.read_bytes() == before


# -- delete and list -----------------------------------------------------


def test_delete_file(data: PluginData):
    for rel, body in (("a/one.bin", b"1"), ("a/b/two.bin", b"2"), ("a/b/c/three.bin", b"3"), ("solo.bin", b"s")):
        data.write_bytes(rel, body)
    for rel in ("", "   ", ".", "./", "a/.."):
        _raises("invalid_path", data.delete_file, rel)
        _raises("invalid_path", data.delete_file, rel, recursive=True)
    assert data.delete_file("missing.bin") == 0
    assert data.delete_file("nowhere/missing.bin", recursive=True) == 0
    assert data.delete_file("solo.bin/x") == 0
    assert data.delete_file("solo.bin") == 1
    assert not (data.root / "solo.bin").exists()
    _raises("is_folder", data.delete_file, "a")
    assert data.delete_file("a/b", recursive=True) == 2
    assert [f["rel"] for f in data.list_files()] == ["a/one.bin"]
    assert data.delete_file("a", recursive=True) == 1
    assert data.list_files() == [] and not (data.root / "a").exists()
    # A study's folder goes only through the study calls.
    record = _study(data, "st-2")
    data.write_bytes("studies/st-2/polar.bin", b"p")
    _raises("study_record", data.delete_file, "studies", recursive=True)
    _raises("study_record", data.delete_file, "studies/st-2", recursive=True)
    assert data.delete_file("studies/st-2/polar.bin") == 1
    assert record.is_file()


def test_a_recursive_delete_counts_files_not_links(data: PluginData, tmp_path: Path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_bytes(b"keep me")
    data.write_bytes("box/own.bin", b"mine")
    _link_folder(data.root / "box" / "out", outside)
    # As the host's delete counts: the link goes, what it leads to stays.
    assert data.delete_file("box", recursive=True) == 1
    assert not (data.root / "box").exists()
    assert (outside / "secret.txt").read_bytes() == b"keep me"


def test_delete_is_retried_while_another_program_holds_the_file(data: PluginData, monkeypatch: pytest.MonkeyPatch):
    data.write_bytes("held.bin", b"h")
    data.write_bytes("dir/a.bin", b"a")
    sleeps: list[float] = []
    monkeypatch.setattr(sdk_data.time, "sleep", sleeps.append)
    real_unlink, real_rmtree = os.unlink, shutil.rmtree
    held = {"unlink": 2, "rmtree": 2}

    def flaky(name, real):
        def call(*args, **kwargs):
            if held[name] > 0:
                held[name] -= 1
                raise PermissionError(13, "in use")
            return real(*args, **kwargs)

        return call

    monkeypatch.setattr(sdk_data.os, "unlink", flaky("unlink", real_unlink))
    monkeypatch.setattr(sdk_data.shutil, "rmtree", flaky("rmtree", real_rmtree))
    assert data.delete_file("held.bin") == 1
    assert data.delete_file("dir", recursive=True) == 1
    assert sleeps == pytest.approx([0.05, 0.10, 0.05, 0.10])
    assert data.list_files() == []
    # Held every time: busy, and the file stays.
    data.write_bytes("held.bin", b"h")
    data.write_bytes("dir/a.bin", b"a")
    held.update(unlink=99, rmtree=99)
    assert str(_raises("busy", data.delete_file, "held.bin")) == "held.bin is in use by another program"
    assert str(_raises("busy", data.delete_file, "dir", recursive=True)) == "dir is in use by another program"
    assert [f["rel"] for f in data.list_files()] == ["dir/a.bin", "held.bin"]


def test_list_files_hides_temps_and_staging(data: PluginData, project: Path):
    data.write_bytes("b.bin", b"bb")
    data.write_bytes("a/x.bin", b"x")
    data.write_json("notes/n.json", {"k": 1})
    root = data.root
    (root / ".magnusim-staging").mkdir()
    (root / ".magnusim-staging" / "0123abcd.part").write_bytes(b"...")
    (root / "a" / ".magnusim-1f2e.part").write_bytes(b"")
    (root / "notes" / ".magnusim-tmp-abc.json").write_text("{}", encoding="utf-8")
    (root / "notes" / ".MAGNUSIM-odd").write_text("", encoding="utf-8")
    (root / "notes" / ".tmp-old123.json").write_text("{}", encoding="utf-8")
    (root / "notes" / ".tmp-kept.txt").write_text("t", encoding="utf-8")
    (root / "notes" / "x.tmp-a.json").write_text("{}", encoding="utf-8")
    rels = [f["rel"] for f in data.list_files()]
    assert rels == ["a/x.bin", "b.bin", "notes/.tmp-kept.txt", "notes/n.json", "notes/x.tmp-a.json"]
    assert [f["rel"] for f in data.list_files("notes")] == rels[2:]
    assert data.list_files("./a/") == [data.file_info("a/x.bin")]
    assert data.list_files("nowhere") == []
    assert data.list_files("a/x.bin/deeper") == []
    _raises("not_folder", data.list_files, "b.bin")
    _raises("invalid_path", data.list_files, ".magnusim-staging")
    _raises("invalid_path", data.list_files, "..")
    for row in data.list_files():
        assert set(row) == {"rel", "size", "mtime", "etag"}
    # A plugin that never wrote anything has no folder yet.
    assert PluginData(project, "other-plugin").list_files() == []
    # The old JSON temp name hides files only, as the host's list does: a folder so
    # named is listed with what is in it.
    (root / ".tmp-dir.json").mkdir()
    (root / ".tmp-dir.json" / "inside.bin").write_bytes(b"in")
    assert ".tmp-dir.json/inside.bin" in [f["rel"] for f in data.list_files()]


def test_the_app_names_are_refused_where_a_link_lands(data: PluginData):
    data.write_bytes("a.bin", b"a")
    staging = data.root / ".magnusim-staging"
    staging.mkdir()
    (staging / ("0" * 32 + ".part")).write_bytes(b"half")
    _link_folder(data.root / "st", staging)
    for call in (
        partial(data.read_bytes, "st/" + "0" * 32 + ".part"),
        partial(data.file_info, "st/" + "0" * 32 + ".part"),
        partial(data.list_files, "st"),
        partial(data.write_bytes, "st/x.bin", b"x"),
        partial(data.delete_file, "st/" + "0" * 32 + ".part"),
    ):
        _raises("invalid_path", call)
    assert (staging / ("0" * 32 + ".part")).read_bytes() == b"half"
    assert [f["rel"] for f in data.list_files()] == ["a.bin"]


def test_a_file_in_a_removed_study_is_refused(data: PluginData):
    sid = data.create_study("bench_case", "Wing")["id"]
    assert data.write_bytes(f"studies/{sid}/mesh.msh", b"m")["rel"] == f"studies/{sid}/mesh.msh"
    data.delete_study(sid)
    # A job or service that ends after its study was removed does not make the folder again.
    for call in (
        partial(data.write_bytes, f"studies/{sid}/mesh.msh", b"m"),
        partial(data.file_path, f"studies/{sid}/mesh.msh", write=True),
        partial(data.write_bytes, f"Studies/{sid}/deep/er/x.bin", b"x"),
    ):
        with pytest.raises(sdk_data.StudyNotFoundError):
            call()
    with pytest.raises(sdk_data.StudyNotFoundError), data.atomic_path(f"studies/{sid}/mesh.msh"):
        pass
    assert not (data.root / "studies" / sid).exists()
    # Reading is not a write: a missing study's file is just not there.
    assert data.read_bytes(f"studies/{sid}/mesh.msh") is None
    assert data.file_path(f"studies/{sid}/mesh.msh") == data.root.resolve() / "studies" / sid / "mesh.msh"


def test_usage_counts_what_the_quota_counts(data: PluginData, tmp_path: Path):
    data.write_bytes("a/one.bin", b"12345")
    data.write_bytes("b.bin", b"123")
    # The app's own names at any depth: not counted.
    (data.root / "a" / ".magnusim-0123456789abcdef.part").write_bytes(b"x" * 1000)
    (data.root / ".magnusim-staging").mkdir()
    (data.root / ".magnusim-staging" / "u.part").write_bytes(b"x" * 1000)
    # Nor what a link leads to.
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "big.bin").write_bytes(b"x" * 1000)
    _link_folder(data.root / "out", outside)
    assert data.usage() == (8, 3)
    assert PluginData(data.project_dir, "nothing-yet").usage() == (0, 0)


# -- building one -------------------------------------------------------


def test_from_scope_and_from_env(project: Path, monkeypatch: pytest.MonkeyPatch):
    want = project.resolve() / "plugins" / KEY
    assert PluginData.from_scope({"project_dir": str(project), "plugin": KEY, "project_id": "proj-a"}).root == want
    with pytest.raises(PluginDataError, match="no open project"):
        PluginData.from_scope({"plugin": KEY})
    with pytest.raises(PluginDataError, match="invalid plugin key"):
        PluginData.from_scope({"project_dir": str(project), "plugin": "../x"})
    env = {"MAGNUSIM_PROJECT_DIR": str(project), "MAGNUSIM_PLUGIN_KEY": KEY}
    assert PluginData.from_env(env).root == want
    with pytest.raises(PluginDataError, match="MAGNUSIM_PROJECT_DIR"):
        PluginData.from_env({"MAGNUSIM_PLUGIN_KEY": KEY})
    with pytest.raises(PluginDataError, match="invalid plugin key"):
        PluginData.from_env({"MAGNUSIM_PROJECT_DIR": str(project)})
    monkeypatch.setenv("MAGNUSIM_PROJECT_DIR", str(project))
    monkeypatch.setenv("MAGNUSIM_PLUGIN_KEY", KEY)
    assert PluginData.from_env().root == want
    monkeypatch.delenv("MAGNUSIM_PROJECT_DIR")
    with pytest.raises(PluginDataError):
        PluginData.from_env()


# -- manifest [files] and plugins.list ----------------------------------


def test_versions():
    from magnusim_sdk import SDK_VERSION

    from cfddesk.registry import API_VERSION

    assert (API_VERSION, SDK_VERSION) == ("1.5", "1.3.0")
    # The installed package reports the same version (python/sdk/pyproject.toml).
    pyproject = Path(sdk_data.__file__).resolve().parents[1] / "pyproject.toml"
    assert re.search(r'^version = "([^"]+)"', pyproject.read_text(encoding="utf-8"), re.M).group(1) == SDK_VERSION


def test_files_table_is_validated():
    assert FilesSpec() == FilesSpec(64 * MB, 512 * MB)
    assert files_spec_from_meta({}) == FilesSpec()
    assert files_spec_from_meta({"files": {}}) == FilesSpec()
    assert files_spec_from_meta({"files": {"max_file_mb": 1, "max_total_mb": 1}}) == FilesSpec(MB, MB)
    assert files_spec_from_meta({"files": {"max_file_mb": 4096, "max_total_mb": 65536}}) == FilesSpec(4096 * MB, 65536 * MB)
    assert files_spec_from_meta({"files": {"max_file_mb": 200}}) == FilesSpec(200 * MB, 512 * MB)
    assert files_spec_from_meta({"files": {"max_total_mb": 64}}) == FilesSpec(64 * MB, 64 * MB)
    for bad, why in (
        ({"max_file_mb": True}, "whole number"),
        ({"max_total_mb": False}, "whole number"),
        ({"max_file_mb": 64.0}, "whole number"),
        ({"max_total_mb": 1.5}, "whole number"),
        ({"max_file_mb": "64"}, "whole number"),
        ({"max_file_mb": None}, "whole number"),
        ({"max_file_mb": 0}, "between 1 and 4096"),
        ({"max_file_mb": -1}, "between 1 and 4096"),
        ({"max_file_mb": 4097}, "between 1 and 4096"),
        ({"max_total_mb": 0}, "between 1 and 65536"),
        ({"max_total_mb": 65537}, "between 1 and 65536"),
        ({"max_file_mb": 100, "max_total_mb": 50}, "at least max_file_mb"),
        ({"max_file_mb": 1000}, "at least max_file_mb"),
    ):
        with pytest.raises(ValueError, match=why):
            files_spec_from_meta({"files": bad})
    for bad_table in (64, [1], "big"):
        with pytest.raises(ValueError, match="table"):
            files_spec_from_meta({"files": bad_table})


@pytest.fixture
def hub_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    plugins = tmp_path / "plugins"
    shutil.copytree(WS_FIXTURE, plugins / WS_KEY)
    folder = plugins / PLUG_KEY
    folder.mkdir()
    (folder / "manifest.toml").write_text(PLUG_MANIFEST, encoding="utf-8")
    (folder / "plugin.py").write_text("def register(hub):\n    return None\n", encoding="utf-8")
    projects = tmp_path / "projects"
    (projects / "proj-a").mkdir(parents=True)
    (projects / "proj-a" / "project.json").write_text(json.dumps({"id": "proj-a"}), encoding="utf-8")
    local = tmp_path / "local.json"
    local.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(projects))
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(local))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(local))
    reset_for_tests()
    load_all(force=True)
    yield {"manifest": folder / "manifest.toml", "local": local}
    reset_for_tests()


def _with_files_table(manifest: Path, table: str):
    manifest.write_text(PLUG_MANIFEST + f"\n[files]\n{table}\n", encoding="utf-8")
    reset_for_tests()
    return load_all(force=True)


def _rows() -> dict[str, dict]:
    return {r["key"]: r for r in methods.plugins_list()["plugins"]}


def test_plugins_list_rows_carry_the_limits_in_bytes(hub_env):
    rows = _rows()
    assert rows[PLUG_KEY]["status"] == "enabled"
    assert rows[PLUG_KEY]["files"] == DEFAULT_ROW
    assert all(set(r["files"]) == {"max_file_bytes", "max_total_bytes"} for r in rows.values())
    hub = _with_files_table(hub_env["manifest"], "max_file_mb = 2\nmax_total_mb = 10")
    assert hub.manifests[PLUG_KEY].files == FilesSpec(2 * MB, 10 * MB)
    assert _rows()[PLUG_KEY]["files"] == {"max_file_bytes": 2 * MB, "max_total_bytes": 10 * MB}
    # A plugin that is off is not loaded: its row carries the defaults.
    hub_env["local"].write_text(json.dumps({"plugins": {"disabled": [PLUG_KEY]}}), encoding="utf-8")
    reset_for_tests()
    load_all(force=True)
    row = _rows()[PLUG_KEY]
    assert row["status"] == "disabled" and row["files"] == DEFAULT_ROW


def test_ws_data_writes_count_against_the_files_quota(hub_env, monkeypatch: pytest.MonkeyPatch):
    # One folder, two views: ws.data cannot go past what ws.files is held to.
    _with_files_table(hub_env["manifest"], "max_file_mb = 1\nmax_total_mb = 1")
    write = partial(methods.plugin_data_write, "proj-a", PLUG_KEY)
    half = "x" * (600 * 1024)
    assert write("bulk/a.json", half) == {"ok": True}
    assert _rpc_refused(write, "bulk/b.json", half).message == "this plugin's files may take 1 MB in a project"
    # Replacing a file frees what it held; the host's temp files are not counted.
    data = PluginData(Path(os.environ["MAGNUSIM_PROJECTS_ROOT"]) / "proj-a", PLUG_KEY)
    (data.root / "bulk" / ".magnusim-0123456789abcdef.part").write_bytes(b"x" * 600 * 1024)
    assert write("bulk/a.json", half + "y") == {"ok": True}
    assert data.read_json("bulk/a.json") == half + "y"
    assert not (data.root / "bulk" / "b.json").exists()
    # And files and folders are counted.
    monkeypatch.setattr(sdk_data, "MAX_ENTRIES", 2)
    assert _rpc_refused(write, "bulk/c.json", {}).message == "a plugin may keep 2 files and folders in a project"
    assert write("bulk/a.json", {}) == {"ok": True}


def test_ws_data_keeps_the_study_rules(hub_env):
    write = partial(methods.plugin_data_write, "proj-a", PLUG_KEY)
    for rel in ("studies", "studies/index.json", "STUDIES/st-9"):
        assert _rpc_refused(write, rel, {}).message == STUDY_FOLDER_MESSAGE
    # A study's own files need the study: one removed meanwhile is not made again.
    with pytest.raises(RpcError) as err:
        write("studies/st-9/notes.json", {})
    assert err.value.code == -32004
    data = PluginData(Path(os.environ["MAGNUSIM_PROJECTS_ROOT"]) / "proj-a", PLUG_KEY)
    assert not (data.root / "studies").exists()
    sid = data.create_study("bench_case", "Wing")["id"]
    assert write(f"studies/{sid}/notes.json", {"n": 1}) == {"ok": True}
    assert methods.plugin_data_read("proj-a", PLUG_KEY, f"studies/{sid}/notes.json")["doc"] == {"n": 1}


@pytest.mark.parametrize(
    ("table", "why"),
    [
        ("max_file_mb = true", "whole number"),
        ("max_file_mb = 1.5", "whole number"),
        ('max_total_mb = "512"', "whole number"),
        ("max_file_mb = 0", "between 1 and 4096"),
        ("max_total_mb = 70000", "between 1 and 65536"),
        ("max_file_mb = 10\nmax_total_mb = 5", "at least max_file_mb"),
    ],
)
def test_a_bad_files_table_fails_only_that_plugin(hub_env, table: str, why: str):
    hub = _with_files_table(hub_env["manifest"], table)
    assert PLUG_KEY not in hub.manifests
    failure = next(f for f in hub.failures if f["key"] == PLUG_KEY)
    assert failure["error"].startswith("manifest [files]: ") and why in failure["error"]
    assert WS_KEY in hub.manifests
    assert "incompressible_steady" in hub.registry("analysis").keys()
    row = _rows()[PLUG_KEY]
    assert row["status"] == "error" and row["error"].startswith("manifest [files]: ")
    assert row["files"] == DEFAULT_ROW
