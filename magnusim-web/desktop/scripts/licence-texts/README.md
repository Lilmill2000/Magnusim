# Licence texts the installer's notices need and no package ships

`../notices.mjs` (`OWN_NOTICES`) adds these to THIRD_PARTY_NOTICES.txt for code that a
package ships under its own authors' notice. Each file is the upstream file as published:

| File | Upstream | Covers |
|---|---|---|
| `go-LICENSE.txt` | `LICENSE` of <https://github.com/golang/go> at tag `go1.23.12`; byte-identical to `LICENSE` of <https://github.com/golang/sys> at `c0bba94af5f8` | `@esbuild/win32-x64`'s `esbuild.exe`, a Go program: the Go 1.23.12 runtime and standard library, and `golang.org/x/sys` (esbuild 0.25.12's `go.mod`) |
| `fixed-data-table-LICENSE.txt` | `LICENSE` of <https://github.com/facebookarchive/fixed-data-table> | `normalizeWheel` in `@kitware/vtk.js`'s `macros2.js`, copied from fixed-data-table |
| `deno-std-LICENSE.txt` | `LICENSE` of <https://github.com/denoland/std> at tag `0.170.0` | `standardwebhooks`'s `dist/timing_safe_equal.js`, whose source says "Copyright 2018-2022 the Deno authors. All rights reserved. MIT license." |

When one of those packages changes version, the build stops and names it: check the new
version's files and update the entry in `notices.mjs` (and the text here if it changed).
