# XFOIL in the Airfoil plugin

XFOIL is Mark Drela's subsonic airfoil program (MIT,
<https://web.mit.edu/drela/Public/web/xfoil/>). The plugin runs it as a separate
program, `bin/xfoil.exe`, writing its commands to the program's standard input
(`airfoil/xfoil.py`). Nothing of XFOIL is linked into Magnusim.

## What ships here

| Path | What it is |
|---|---|
| `bin/xfoil.exe` | XFOIL 6.99 for Windows: MIT's own build, unmodified |
| `source/Xfoil699src.zip` | The source MIT ships inside the same Windows download, unmodified. It is the source of this `xfoil.exe` (see below) |
| `source/xfoil6.99.tgz` | MIT's 6.99 source tarball, unmodified |
| `SHA256SUMS` | SHA-256 of the program, both source archives and MIT's GPL text (`tests/test_xfoil_packaging.py` checks them) |
| `LICENSES/GPL-2.0.txt` | MIT's `gpl.txt`: GNU GPL version 2, the licence the XFOIL page links |
| `LICENSES/LGPL-2.0.txt` | The plot library's licence, `plotlib/GPL-library` from the tarball (the same file is in the zip) |
| `LICENSES/GPL-3.0.txt` | GNU GPL version 3: the plugin and the program are distributed under GPL-3.0-or-later, like Magnusim |
| `LICENSES/GCC-RLE-3.1.txt` | The GCC Runtime Library Exception 3.1, for the GNU Fortran runtime linked into the program |

Not shipped: `pplot.exe` and `pxplot.exe`, which come in the same download. The
plugin does not use them.

## How it was obtained (2026-10-02)

Downloaded from the official XFOIL page by Magnusim's maintainer, with these
checksums:

| File | URL | Bytes | SHA-256 |
|---|---|---|---|
| `XFOIL6.99.zip` (not shipped as a whole) | <https://web.mit.edu/drela/Public/web/xfoil/XFOIL6.99.zip> | 3 813 300 | `e13e8fe5cc38d8ac2626e9d3b17643bdcfaa63791619f042afdaa7cd103bcb08` |
| `xfoil6.99.tgz` | <https://web.mit.edu/drela/Public/web/xfoil/xfoil6.99.tgz> | 4 515 991 | `5c0250643f52ce0e75d7338ae2504ce7907f2d49a30f921826717b8ac12ebe40` (MD5 `8d6270fc4341d299a426b3ad41be9cc4`, the one Arch Linux's xfoil package checks) |
| `gpl.txt` | <https://web.mit.edu/drela/Public/web/gpl.txt> | 18 011 | `e6d6a009505e345fe949e1310334fcb0747f28dae2856759de102ab66b722cb4` |

From `XFOIL6.99.zip`, extracted unchanged:

| File | Date in the zip | Bytes | SHA-256 |
|---|---|---|---|
| `xfoil.exe` | 2013-05-22 | 1 002 125 | `c17342f84ae260c2b11a74cd0e2fb8189a5f8954c6bb7a8467a0f27055c7faea` |
| `Xfoil699src.zip` | 2013-12-22 | 3 031 974 | `940bdb5be4d0345a5062cfb430c90d1d9411f4db00ca283a48e5a1de940d08c7` |

`xfoil.exe` is a 32-bit Windows console program. It prints "XFOIL Version 6.99"
and was built by MIT with MinGW GCC 4.5.2 (GNU Fortran); the GNU Fortran runtime
is linked in statically, and it needs only Windows' own DLLs (`msvcrt`,
`kernel32`, `user32`, `gdi32`).

### Which source matches the program

The program and the two source archives are not the same snapshot of 6.99.
`xfoil.exe` has the top-level `RSAV` command and none of the tarball's later
`DELI` and `HALF` commands, which is what `Xfoil699src.zip` has. So
`Xfoil699src.zip`, which MIT ships with the program, is its source, and both
archives ship. Neither archive contains MIT's Windows makefile settings for this
exact build; the zip has `bin/Makefile.mingw` and `plotlib/Makefile.mingw`.

## Licence

- XFOIL's source files say "GNU General Public License ... either version 2 of
  the License, or (at your option) any later version" (GPL-2.0-or-later). Some
  files carry no header; the XFOIL page releases the whole program under the GNU
  GPL without naming a version, which lets the recipient choose any version.
- The plot library (`plotlib/`, Harold Youngren and Mark Drela) is "GNU Library
  General Public License ... version 2 ... or any later version"
  (LGPL-2.0-or-later).
- Both may be taken under GPL version 3, and the plugin and `xfoil.exe` are
  distributed under **GPL-3.0-or-later**: `LICENSES/GPL-3.0.txt`.
- The GNU Fortran runtime (libgfortran, libgcc) inside the program is GPL-3.0
  with the GCC Runtime Library Exception 3.1 (`LICENSES/GCC-RLE-3.1.txt`, copied
  verbatim from Debian's `gcc-13-base` copyright file). The MinGW.org runtime's
  startup code it was linked with was public domain in the MinGW.org 3.x
  releases of that time (the exact runtime version is not recorded in the
  program).

The program prints its own notice when it starts: "Copyright (C) 2000 Mark
Drela, Harold Youngren ... This software comes with ABSOLUTELY NO WARRANTY,
subject to the GNU General Public License."

## Our changes to XFOIL

None. The program and both source archives are byte for byte as MIT publishes
them (`SHA256SUMS`).

## Tests

- `tests/test_xfoil_packaging.py`: every file above is here and matches
  `SHA256SUMS`; the LGPL text is the tarball's own; the README and the
  repository's `THIRD_PARTY_NOTICES.md` name the same checksums.
- `tests/test_xfoil_golden.py`: the program against the committed golden
  (`tests/goldens/xfoil_naca2412_re1e6.json`, made by
  `tools/make_xfoil_golden.py`, which records the program's SHA-256 and the
  exact session), and the `xfoil_polar` job running it.
