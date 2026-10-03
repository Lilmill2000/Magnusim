"""XFOIL is GPL: ``xfoil/bin/xfoil.exe`` (MIT's own Windows build of 6.99) ships
only together with its source and the licence texts, every file is byte for byte
what was downloaded (``xfoil/SHA256SUMS``), and what the README and the
repository's THIRD_PARTY_NOTICES say about it is true of this copy. Not skipped
on any platform: these are files, not the program running.
"""

from __future__ import annotations

import hashlib
import re
import tarfile
import zipfile
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
XF = PLUGIN_DIR / "xfoil"
EXE = XF / "bin" / "xfoil.exe"
TARBALL = XF / "source" / "xfoil6.99.tgz"
SRC_ZIP = XF / "source" / "Xfoil699src.zip"
SUMS = XF / "SHA256SUMS"
README = XF / "README.md"
NOTICES = PLUGIN_DIR.parents[2] / "THIRD_PARTY_NOTICES.md"
REPO_LICENSE = PLUGIN_DIR.parents[2] / "LICENSE"

# The files the lead downloaded with Daniel's approval (2026-10-02), as recorded in
# xfoil/README.md. A replaced file must be a knowing change here too.
PINNED = {
    "bin/xfoil.exe": "c17342f84ae260c2b11a74cd0e2fb8189a5f8954c6bb7a8467a0f27055c7faea",
    "source/xfoil6.99.tgz": "5c0250643f52ce0e75d7338ae2504ce7907f2d49a30f921826717b8ac12ebe40",
    "source/Xfoil699src.zip": "940bdb5be4d0345a5062cfb430c90d1d9411f4db00ca283a48e5a1de940d08c7",
    "LICENSES/GPL-2.0.txt": "e6d6a009505e345fe949e1310334fcb0747f28dae2856759de102ab66b722cb4",
}
DOWNLOAD_ZIP_SHA256 = "e13e8fe5cc38d8ac2626e9d3b17643bdcfaa63791619f042afdaa7cd103bcb08"
LICENCES = ("GPL-2.0.txt", "GPL-3.0.txt", "LGPL-2.0.txt", "GCC-RLE-3.1.txt")


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sums() -> dict[str, str]:
    out = {}
    for line in SUMS.read_text(encoding="ascii").splitlines():
        if line.strip():
            digest, name = line.split(None, 1)
            out[name.lstrip("*").strip()] = digest
    return out


def _notices_section() -> str:
    text = NOTICES.read_text(encoding="utf-8")
    start = text.index("## XFOIL and the Airfoil plugin")
    end = text.find("\n## ", start + 1)
    return text[start : end if end > 0 else None]


def _lf(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n")


def test_every_shipped_file_matches_its_checksum():
    assert _sums() == PINNED, "xfoil/SHA256SUMS lists other files or other checksums than were downloaded"
    for rel, digest in PINNED.items():
        f = XF / rel
        assert f.is_file(), f"xfoil/{rel} is missing"
        assert _sha(f) == digest, f"xfoil/{rel} is not the file that was downloaded"


def test_the_program_ships_with_its_source():
    # The program is a Windows executable that prints XFOIL 6.99's banner.
    exe = EXE.read_bytes()
    assert exe[:2] == b"MZ"
    assert b"XFOIL Version" in exe and b"subject to the GNU General Public License." in exe
    # Its own source: the zip MIT ships beside it has the RSAV command the program has.
    with zipfile.ZipFile(SRC_ZIP) as z:
        names = z.namelist()
        assert "Xfoil699src/src/xfoil.f" in names
        xfoil_f = z.read("Xfoil699src/src/xfoil.f")
    # (the program keeps its top-level commands as one string, "...GDESRSAV"), and
    # neither has the tarball's later DELI command.
    assert b"'RSAV'" in xfoil_f and b"GDESRSAV" in exe
    assert b"'DELI'" not in xfoil_f and b"Change written-airfoil file delimiters" not in exe
    assert b"VERSION = 6.99" in xfoil_f
    # The tarball is the full 6.99 tree, a later snapshot than the program.
    with tarfile.open(TARBALL, "r:gz") as tar:
        tnames = set(tar.getnames())
        assert {"Xfoil/src/xfoil.f", "Xfoil/plotlib/GPL-library", "Xfoil/osrc/osmap.f"} <= tnames
        member = tar.extractfile("Xfoil/src/xfoil.f")
        assert member is not None and b"'DELI'" in member.read()


def test_only_xfoil_itself_ships():
    """pplot.exe and pxplot.exe come in MIT's zip but are not used, so they are not shipped."""
    shipped = sorted(p.relative_to(XF).as_posix() for p in XF.rglob("*") if p.is_file())
    assert shipped == sorted(["README.md", "SHA256SUMS", *PINNED, *(f"LICENSES/{n}" for n in LICENCES if n != "GPL-2.0.txt")])


def test_the_licence_texts_are_the_real_ones():
    lic = XF / "LICENSES"
    for name in LICENCES:
        assert (lic / name).is_file() and (lic / name).stat().st_size > 2000, f"missing or short LICENSES/{name}"
    assert b"GNU GENERAL PUBLIC LICENSE\n\t\t       Version 2, June 1991" in _lf((lic / "GPL-2.0.txt").read_bytes())
    # The plot library's licence is the tarball's own file, unchanged.
    with tarfile.open(TARBALL, "r:gz") as tar:
        member = tar.extractfile("Xfoil/plotlib/GPL-library")
        assert member is not None
        upstream = member.read()
    assert (lic / "LGPL-2.0.txt").read_bytes() == upstream
    assert b"GNU LIBRARY GENERAL PUBLIC LICENSE" in upstream
    # GPL version 3 is the repository's own LICENSE (line endings aside).
    assert _lf((lic / "GPL-3.0.txt").read_bytes()) == _lf(REPO_LICENSE.read_bytes())
    rle = (lic / "GCC-RLE-3.1.txt").read_text(encoding="ascii")
    assert rle.startswith("GCC RUNTIME LIBRARY EXCEPTION\n\nVersion 3.1, 31 March 2009")
    assert "2. No Weakening of GCC Copyleft." in rle


def test_readme_and_notices_name_the_same_files_and_checksums():
    readme = README.read_text(encoding="utf-8")
    notices = _notices_section()
    for rel, digest in PINNED.items():
        assert digest in readme, f"xfoil/README.md does not give the SHA-256 of {rel}"
        assert f"xfoil/{rel}" in notices and digest in notices, f"THIRD_PARTY_NOTICES does not list xfoil/{rel} with its SHA-256"
    assert DOWNLOAD_ZIP_SHA256 in readme and DOWNLOAD_ZIP_SHA256 in notices
    for url in (
        "https://web.mit.edu/drela/Public/web/xfoil/XFOIL6.99.zip",
        "https://web.mit.edu/drela/Public/web/xfoil/xfoil6.99.tgz",
        "https://web.mit.edu/drela/Public/web/gpl.txt",
    ):
        assert url in readme and url in notices, url
    for name in LICENCES:
        assert f"LICENSES/{name}" in readme, name
    changes = readme.split("## Our changes to XFOIL", 1)
    assert len(changes) == 2 and changes[1].strip().startswith("None."), "the README must list our changes to XFOIL (none)"
    # Nothing left over from the plan to build the program here.
    for text in (readme, notices):
        assert not re.search(r"not (built|included)|build script|build-xfoil", text), "a stale line about building XFOIL"
    assert "GPL-3.0-or-later" in notices


def test_the_download_zip_held_this_program_and_source():
    """The program and the source zip are the members of MIT's XFOIL6.99.zip, unchanged:
    their sizes are the ones that zip lists (its own checksum is recorded above)."""
    assert EXE.stat().st_size == 1_002_125
    assert SRC_ZIP.stat().st_size == 3_031_974
    assert TARBALL.stat().st_size == 4_515_991
    assert hashlib.md5(TARBALL.read_bytes()).hexdigest() == "8d6270fc4341d299a426b3ad41be9cc4"  # noqa: S324 - Arch's published MD5

