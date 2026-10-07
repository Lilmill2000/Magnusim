"""Plugin packages: checking a zip, installing it, removing a user copy, packing a folder."""

from __future__ import annotations

import os
import stat
import zipfile
from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import plugin_catalog
from cfddesk.registry.plugin_package import (
    PackageError,
    commit_install,
    inspect_package,
    install_package,
    pack_files,
    pack_plugin,
    read_package,
    remove_user_copies,
)

WEB = Path(__file__).resolve().parents[3]


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    yield
    reset_for_tests()


@pytest.fixture()
def web(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """A web root with its own bundled folder (one plugin, demo 0.1.0) and plugins folder."""
    root = tmp_path / "web"
    bundled = root / "bundled-plugins"
    _folder(bundled / "demo", "demo", "0.1.0", tier="bundled")
    (root / "plugins").mkdir(parents=True)
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(bundled))
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(root / "plugins"))
    return root


def _manifest(key: str, version: str, api: str = "1.1", **extra: str) -> str:
    lines = [f'key = "{key}"', f'name = "{key.title()}"', f'version = "{version}"', f'api_version = "{api}"']
    lines += [f'{k} = "{v}"' for k, v in extra.items()]
    return "\n".join(lines) + "\n"


def _folder(d: Path, key: str, version: str, **extra: str) -> Path:
    d.mkdir(parents=True)
    (d / "manifest.toml").write_text(_manifest(key, version, **extra), encoding="utf-8")
    (d / "plugin.py").write_text("def register(hub):\n    return None\n", encoding="utf-8")
    return d


def _zip(path: Path, files: dict[str, str | bytes], *, link: str | None = None) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        for name, body in files.items():
            zf.writestr(name, body)
        if link:
            zi = zipfile.ZipInfo(link)
            zi.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(zi, "/etc/passwd")
    return path


def _pkg(tmp_path: Path, key: str = "demo", version: str = "0.2.0", top: str | None = None, **more: str | bytes) -> Path:
    top = key if top is None else top
    pre = f"{top}/" if top else ""
    files: dict[str, str | bytes] = {
        f"{pre}manifest.toml": _manifest(key, version),
        f"{pre}plugin.py": "def register(hub):\n    return None\n",
    }
    files.update({f"{pre}{k}": v for k, v in more.items()})
    return _zip(tmp_path / f"{key}-{version}.zip", files)


@pytest.mark.parametrize(
    ("name", "code"),
    [
        ("demo/../evil.py", "bad_name"),
        ("/abs/evil.py", "bad_name"),
        ("demo/C:evil.py", "bad_name"),
        ("demo/CON.txt", "bad_name"),
        ("demo/trailing. ", "bad_name"),
        ("demo/a/./b.py", "bad_name"),
    ],
)
def test_a_name_that_could_escape_or_break_on_windows_is_refused(tmp_path: Path, name: str, code: str):
    z = _zip(
        tmp_path / "x.zip",
        {"demo/manifest.toml": _manifest("demo", "0.2.0"), "demo/plugin.py": "", name: "x"},
    )
    with pytest.raises(PackageError) as err:
        read_package(z)
    assert err.value.code == code


def test_links_case_clashes_and_layouts_are_refused(tmp_path: Path):
    base = {"demo/manifest.toml": _manifest("demo", "0.2.0"), "demo/plugin.py": ""}
    cases = {
        "link": _zip(tmp_path / "l.zip", base, link="demo/link"),
        "case_clash": _zip(tmp_path / "c.zip", {**base, "demo/A.py": "", "demo/a.py": ""}),
        "layout": _zip(tmp_path / "t.zip", {**base, "other/x.py": ""}),
        "not_plugin": _zip(tmp_path / "n.zip", {"demo/manifest.toml": _manifest("demo", "0.2.0")}),
        "not_zip": tmp_path / "plain.zip",
    }
    (tmp_path / "plain.zip").write_text("not a zip", encoding="utf-8")
    for code, z in cases.items():
        with pytest.raises(PackageError) as err:
            read_package(z)
        assert err.value.code == code, (code, err.value.message)


def test_a_bad_manifest_key_or_version_is_refused(tmp_path: Path):
    for manifest in (_manifest("bad key", "1.0.0"), _manifest("demo", "soon")):
        z = _zip(tmp_path / "m.zip", {"demo/manifest.toml": manifest, "demo/plugin.py": ""})
        with pytest.raises(PackageError) as err:
            read_package(z)
        assert err.value.code == "manifest"


def test_the_plugins_files_may_also_be_at_the_top_of_the_zip(tmp_path: Path):
    pkg = read_package(_pkg(tmp_path, top=""))
    assert (pkg.key, pkg.top) == ("demo", "")
    assert sorted(rel for _n, rel in pkg.files) == ["manifest.toml", "plugin.py"]


def test_mac_finder_data_is_ignored(tmp_path: Path):
    z = _zip(
        tmp_path / "mac.zip",
        {
            "demo/manifest.toml": _manifest("demo", "0.2.0"),
            "demo/plugin.py": "",
            "__MACOSX/demo/._plugin.py": "x",
        },
    )
    assert read_package(z).top == "demo"


def test_a_zip_bomb_is_refused_by_its_stated_size(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from cfddesk.registry import plugin_package

    monkeypatch.setattr(plugin_package, "MAX_UNPACKED_BYTES", 1000)
    with pytest.raises(PackageError) as err:
        read_package(_pkg(tmp_path, big="0" * 5000))
    assert err.value.code == "too_big"


def test_an_update_must_be_newer_than_the_apps_copy(web: Path, tmp_path: Path):
    for v in ("0.1.0", "0.0.9", "0.1.0-rc.1"):
        with pytest.raises(PackageError) as err:
            inspect_package(_pkg(tmp_path, version=v), web)
        assert err.value.code == "not_newer" and "0.1.0" in err.value.message
    info = inspect_package(_pkg(tmp_path, version="0.2.0"), web)
    assert (info["action"], info["bundled_version"], info["installed_version"]) == ("update", "0.1.0", "")


def test_a_package_for_another_plugin_api_is_refused(web: Path, tmp_path: Path):
    z = _zip(
        tmp_path / "api.zip",
        {"demo/manifest.toml": _manifest("demo", "0.2.0", api="9.0"), "demo/plugin.py": ""},
    )
    with pytest.raises(PackageError) as err:
        inspect_package(z, web)
    assert err.value.code == "incompatible"


def test_install_replaces_the_user_copies_and_the_app_uses_it(web: Path, tmp_path: Path):
    plugins = web / "plugins"
    _folder(plugins / "demo-old", "demo", "0.1.5")
    info = install_package(_pkg(tmp_path, version="0.3.0", **{"lib/helper.py": "X = 1\n"}), web)
    assert info["action"] == "update" and info["installed_version"] == "0.1.5"
    assert sorted(p.name for p in plugins.iterdir()) == ["demo"]
    assert (plugins / "demo" / "lib" / "helper.py").read_text(encoding="utf-8") == "X = 1\n"
    # The replaced copy waits until the new one is known to load, then goes; nothing is left behind.
    assert (Path(info["parked"]) / "demo-old" / "manifest.toml").is_file()
    commit_install(info["parked"])
    for name in ("plugin-incoming", "plugin-replaced"):
        assert not any((web / ".cache" / name).iterdir())
    load_all(web_root=web, force=True)
    row = {r["key"]: r for r in plugin_catalog(web)}["demo"]
    assert (row["version"], row["copy"], row["root"], row["dir"]) == ("0.3.0", "update", "user", "demo")


def test_a_user_plugin_installs_reinstalls_and_downgrades(web: Path, tmp_path: Path):
    assert install_package(_pkg(tmp_path, key="mine", version="1.0.0"), web)["action"] == "install"
    assert inspect_package(_pkg(tmp_path, key="mine", version="1.0.0"), web)["action"] == "reinstall"
    assert inspect_package(_pkg(tmp_path, key="mine", version="0.9.0"), web)["action"] == "downgrade"
    assert inspect_package(_pkg(tmp_path, key="mine", version="1.1.0"), web)["action"] == "update"


def test_a_folder_holding_another_plugin_is_never_overwritten(web: Path, tmp_path: Path):
    _folder(web / "plugins" / "mine", "someone_else", "1.0.0")
    with pytest.raises(PackageError) as err:
        install_package(_pkg(tmp_path, key="mine", version="1.0.0"), web)
    assert err.value.code == "folder_taken"
    assert (web / "plugins" / "mine" / "manifest.toml").read_text(encoding="utf-8").startswith('key = "someone_else"')


def test_a_failed_swap_puts_the_old_copy_back(web: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from cfddesk.registry import plugin_package

    old = _folder(web / "plugins" / "demo", "demo", "0.2.0")
    real = os.replace
    monkeypatch.setattr(plugin_package, "_retry", lambda fn, attempts=9: fn())

    def refuse_into_plugins(src, dst):
        if Path(dst) == web / "plugins" / "demo" and "plugin-incoming" in str(src):
            raise PermissionError(13, "in use", str(dst))
        return real(src, dst)

    monkeypatch.setattr(plugin_package.os, "replace", refuse_into_plugins)
    with pytest.raises(PackageError) as err:
        install_package(_pkg(tmp_path, version="0.3.0"), web)
    assert err.value.code == "busy"
    assert (old / "manifest.toml").read_text(encoding="utf-8") == _manifest("demo", "0.2.0")


def test_remove_takes_every_user_copy_and_the_app_copy_returns(web: Path, tmp_path: Path):
    install_package(_pkg(tmp_path, version="0.3.0"), web)
    _folder(web / "plugins" / "demo-b", "demo", "0.2.5")
    out = remove_user_copies("demo", web)
    assert sorted(out["removed"]) == ["demo", "demo-b"] and out["bundled_version"] == "0.1.0"
    assert list((web / "plugins").iterdir()) == []
    load_all(web_root=web, force=True)
    row = {r["key"]: r for r in plugin_catalog(web)}["demo"]
    assert (row["version"], row["copy"], row["root"], row["unused_copies"]) == ("0.1.0", "app", "bundled", [])
    with pytest.raises(PackageError) as err:
        remove_user_copies("demo", web)
    assert err.value.code == "not_found"


def test_pack_leaves_out_tests_and_caches_and_round_trips(tmp_path: Path):
    src = _folder(tmp_path / "src" / "demo", "demo", "0.4.0-beta.1")
    for rel in ("tests/test_x.py", "e2e/a.spec.js", "node_modules/m/i.js", "__pycache__/p.pyc", "pkg/mod.py", "ui/index.js"):
        (src / rel).parent.mkdir(parents=True, exist_ok=True)
        (src / rel).write_text("x", encoding="utf-8")
    files, origin = pack_files(src)
    assert origin == "folder"
    assert files == ["manifest.toml", "pkg/mod.py", "plugin.py", "ui/index.js"]
    out = pack_plugin(src, tmp_path / "dist")
    assert Path(out["zip"]).name == "demo-v0.4.0-beta.1.zip" and out["files"] == 4
    sha = Path(out["zip"] + ".sha256").read_text(encoding="utf-8")
    assert sha.startswith(out["sha256"]) and sha.rstrip().endswith("demo-v0.4.0-beta.1.zip")
    assert read_package(out["zip"]).top == "demo"


def test_pack_takes_only_the_files_git_tracks_in_a_checkout():
    files, origin = pack_files(WEB / "bundled-plugins" / "incompressible_flow")
    assert origin == "git"
    assert "manifest.toml" in files and "plugin.py" in files
    assert not [f for f in files if f.startswith(("tests/", "e2e/")) or "__pycache__" in f]


# -- review fixes: the old copy is kept until the new one loads; other drives; names ---------


def _broken_pkg(tmp_path: Path, key: str, version: str) -> Path:
    return _zip(
        tmp_path / f"{key}-{version}-broken.zip",
        {
            f"{key}/manifest.toml": _manifest(key, version),
            f"{key}/plugin.py": "def register(hub):\n    raise RuntimeError('v2 is broken')\n",
        },
    )


def _install_through_worker(web: Path, zip_path: Path, key: str, monkeypatch: pytest.MonkeyPatch):
    """plugins.package_install as the server calls it: an upload in .cache/plugin-incoming."""
    from cfddesk.worker import methods

    monkeypatch.setattr(methods, "web_root", lambda: web)
    incoming = web / ".cache" / "plugin-incoming"
    incoming.mkdir(parents=True, exist_ok=True)
    name = "upload-0123456789abcdef.zip"
    (incoming / name).write_bytes(zip_path.read_bytes())
    return methods.plugins_package_install(upload=name, key=key)


def test_a_user_plugin_whose_new_version_does_not_load_keeps_the_old_one(web: Path, tmp_path: Path, monkeypatch):
    from cfddesk.worker.rpc import RpcError

    _install_through_worker(web, _pkg(tmp_path, key="mine", version="1.0.0"), "mine", monkeypatch)
    with pytest.raises(RpcError) as err:
        _install_through_worker(web, _broken_pkg(tmp_path, "mine", "2.0.0"), "mine", monkeypatch)
    assert err.value.data == {"code": "did_not_load"}
    assert err.value.message == "Mine 2.0.0 did not load (v2 is broken); the previous version 1.0.0 is kept."
    assert (web / "plugins" / "mine" / "manifest.toml").read_text(encoding="utf-8") == _manifest("mine", "1.0.0")
    assert sorted(p.name for p in (web / "plugins").iterdir()) == ["mine"]
    assert not any((web / ".cache" / "plugin-replaced").iterdir())
    row = {r["key"]: r for r in plugin_catalog(web)}["mine"]
    assert (row["version"], row["status"]) == ("1.0.0", "enabled")


def test_a_new_plugin_that_does_not_load_is_not_installed(web: Path, tmp_path: Path, monkeypatch):
    from cfddesk.worker.rpc import RpcError

    with pytest.raises(RpcError) as err:
        _install_through_worker(web, _broken_pkg(tmp_path, "mine", "1.0.0"), "mine", monkeypatch)
    assert err.value.message == "Mine 1.0.0 did not load (v2 is broken); nothing was installed."
    assert list((web / "plugins").iterdir()) == []


def test_an_update_that_does_not_load_leaves_the_app_copy_and_no_folder(web: Path, tmp_path: Path, monkeypatch):
    from cfddesk.worker.rpc import RpcError

    with pytest.raises(RpcError) as err:
        _install_through_worker(web, _broken_pkg(tmp_path, "demo", "0.2.0"), "demo", monkeypatch)
    assert err.value.message.startswith("Demo 0.2.0 did not load (")
    assert "v2 is broken" in err.value.message
    assert err.value.message.endswith("Magnusim keeps the version it ships with (0.1.0).")
    assert list((web / "plugins").iterdir()) == []
    row = {r["key"]: r for r in plugin_catalog(web)}["demo"]
    assert (row["version"], row["copy"], row["unused_copies"]) == ("0.1.0", "app", [])


def test_an_install_that_loads_drops_the_replaced_copy(web: Path, tmp_path: Path, monkeypatch):
    _install_through_worker(web, _pkg(tmp_path, key="mine", version="1.0.0"), "mine", monkeypatch)
    out = _install_through_worker(web, _pkg(tmp_path, key="mine", version="1.1.0"), "mine", monkeypatch)
    assert out["installed"]["version"] == "1.1.0" and "parked" not in out["installed"]
    assert not any((web / ".cache" / "plugin-replaced").iterdir())
    assert {r["key"]: r for r in out["plugins"]}["mine"]["version"] == "1.1.0"


def test_a_plugins_folder_on_another_drive_stages_beside_it(web: Path, monkeypatch: pytest.MonkeyPatch):
    from cfddesk.registry import plugin_package

    real = os.stat

    class Other:
        def __init__(self, st):
            self.st = st

        def __getattr__(self, name):
            return 99 if name == "st_dev" else getattr(self.st, name)

    plugins = web / "plugins"
    monkeypatch.setattr(plugin_package.os, "stat", lambda p, *a, **k: Other(real(p)) if Path(p) == plugins else real(p))
    roots = plugin_package._staging_roots(web)
    assert roots[0] == plugins.resolve().parent / ".magnusim-plugin-staging"
    assert plugins not in roots[0].parents


def test_a_move_across_drives_says_so_at_once(web: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import errno
    import time

    from cfddesk.registry import plugin_package

    real = os.replace

    def across(src, dst):
        if Path(dst) == web / "plugins" / "demo":
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        return real(src, dst)

    monkeypatch.setattr(plugin_package.os, "replace", across)
    t = time.monotonic()
    with pytest.raises(PackageError) as err:
        install_package(_pkg(tmp_path, version="0.3.0"), web)
    assert time.monotonic() - t < 2.0
    assert err.value.code == "other_drive" and "another drive" in err.value.message


@pytest.mark.parametrize("name", ["demo/CONIN$.txt", "demo/clock$", "demo/COM" + chr(0xB9) + ".log", "demo/lpt" + chr(0xB3)])
def test_more_names_windows_reserves_are_refused(tmp_path: Path, name: str):
    z = _zip(tmp_path / "r.zip", {"demo/manifest.toml": _manifest("demo", "0.2.0"), "demo/plugin.py": "", name: "x"})
    with pytest.raises(PackageError) as err:
        read_package(z)
    assert err.value.code == "bad_name"


def test_a_key_that_differs_only_in_case_is_refused(web: Path, tmp_path: Path):
    with pytest.raises(PackageError) as err:
        inspect_package(_pkg(tmp_path, key="Demo", version="9.0.0"), web)
    assert err.value.code == "case_clash" and "'demo'" in err.value.message


def test_a_rollback_that_fails_keeps_the_previous_version_out_of_the_sweep(web: Path, tmp_path: Path, monkeypatch):
    from cfddesk.registry import plugin_package
    from cfddesk.worker.rpc import RpcError

    _install_through_worker(web, _pkg(tmp_path, key="mine", version="1.0.0"), "mine", monkeypatch)
    monkeypatch.setattr(plugin_package, "_retry", lambda fn, attempts=9: fn())
    real = os.replace

    def held(src, dst):
        if "plugin-replaced" in str(src) and Path(dst).parent == web / "plugins":
            raise PermissionError(13, "in use", str(dst))
        return real(src, dst)

    monkeypatch.setattr(plugin_package.os, "replace", held)
    with pytest.raises(RpcError) as err:
        _install_through_worker(web, _broken_pkg(tmp_path, "mine", "2.0.0"), "mine", monkeypatch)
    assert err.value.data == {"code": "rollback_failed"}
    assert err.value.message.startswith("Mine 2.0.0 did not load (v2 is broken), and the previous version could not be put back")
    kept = [p for p in (web / ".cache" / "plugin-replaced").iterdir() if p.name.endswith("-keep")]
    assert len(kept) == 1 and str(kept[0]) in err.value.message
    assert (kept[0] / "mine" / "manifest.toml").read_text(encoding="utf-8") == _manifest("mine", "1.0.0")
    plugin_package.sweep(web, older_than_s=0)
    assert kept[0].is_dir()
