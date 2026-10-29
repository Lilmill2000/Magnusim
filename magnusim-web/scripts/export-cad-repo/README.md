# Magnusim CAD

Magnusim CAD is a free CAD app for Windows. You model parts from sketches with
dimensions and constraints (extrude, revolve, sweep and loft; fillets, chamfers,
shells and booleans; patterns, mirrors and named parameters), open STEP files,
edit them and export STEP again, and you can work with an AI Assistant that uses
the same tools you do.

It is the CAD edition of [Magnusim](https://github.com/Lilmill2000/Magnusim):
Magnusim's project screen and its CAD workspace, with no simulation. It needs no
Python, no OpenFOAM and no internet connection; the modeling kernel (Open
CASCADE) and the sketch solver (FreeCAD's PlaneGCS) run as WebAssembly inside the
app.

## Download

The installer is on this repository's [Releases](../../releases) page:
`Magnusim-CAD-Setup-<version>.exe`, for 64-bit Windows. It installs for your
Windows account only, without administrator rights. It is not code-signed, so
Windows SmartScreen may ask before it runs it (More info > Run anyway).

## The Assistant

The Assistant works with a model you choose in Settings > Assistant: your own
key for one of the cloud model providers listed there, a model server running on
your PC, or a coding agent you have installed and signed in to yourself. A key
you give it is kept on your PC, encrypted for your Windows account. Without one,
everything else works the same.

With the app running, `node scripts/assistant-run.mjs "prompt"` in
`magnusim-web/` runs one Assistant turn from a terminal and prints what happens
(`--help` lists its options). Outside the app's window it is the one way to start
a turn on a coding agent: the app checks that it runs on your Windows account.

## Build from source

You need 64-bit Windows, Git and Node.js 24 (22.18 or later works too). In a
clone of this repository:

```
cd magnusim-web
npm ci
npm run dist
```

`npm run dist` installs the CAD plugin's and the desktop shell's own packages
(`npm ci` in `bundled-plugins/cad` and in `desktop`), then fetches Electron's
runtime the first time, builds the page, checks the staged app, writes its
third-party notices and builds the installer:
`magnusim-web/desktop/dist/Magnusim-CAD-Setup-<version>.exe`. Once those
packages are installed, `npm run dist` in `desktop/` builds it again.

Other scripts in `magnusim-web/`:

- `npm run build`: the page alone, into `dist/page`;
- `npm run typecheck`: the app's TypeScript; `npm run typecheck:cad`: the CAD
  plugin's (after `npm ci --prefix bundled-plugins/cad`);
- `npm run build:cad:check`: rebuilds the CAD workspace and checks it matches
  the committed `bundled-plugins/cad/workspace/` (after the same `npm ci`);
- `npm run dev`: the app's server with the page from source; open the address
  it prints in a browser.

The kernel and solver WebAssembly modules in `bundled-plugins/cad/workspace/`
are prebuilt. Their sources, pinned to exact upstream commits with our patches,
and the Linux scripts that rebuild them are in `bundled-plugins/cad/kernel-build/`
and `bundled-plugins/cad/solver-build/`.

## Where the code comes from

This repository is a copy of Magnusim CAD's code, refreshed from
[Magnusim](https://github.com/Lilmill2000/Magnusim) at each release, one commit
per release. Magnusim CAD and Magnusim's CAD plugin are the same code, so code
changes are made in Magnusim and arrive here with the next release; the tests
stay there too. Issues are welcome here. `EXPORT.json` names the Magnusim
commit each copy was made from and lists every file in it.

## Licence

Magnusim CAD is free software under the GNU General Public License, version 3 or
(at your option) any later version: see `LICENSE`.

Third-party software keeps its own licences: `THIRD_PARTY_NOTICES.md`, the CAD
plugin's `magnusim-web/bundled-plugins/cad/LICENSES/` (the kernel's and the
solver's licences, and how to rebuild them), and, in the installed app,
`THIRD_PARTY_NOTICES.txt` with every npm package it ships.
