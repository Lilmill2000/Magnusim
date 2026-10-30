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

From a terminal, `scripts/assistant-run.mjs` runs one Assistant turn and prints
what happens. It works only with the app's server started from this repository,
not with the installed app (that one keeps its Assistant files in its own folder
and does not show its port). In `magnusim-web/`, after `npm ci`:

```
npm run dev
node scripts/assistant-run.mjs --port <port> "prompt"
```

`npm run dev` prints the address it listens on (`Magnusim CAD server on
http://127.0.0.1:<port>/`; `npm run dev -- --port <port>` chooses it), and the
second command, in another terminal, takes that port (`--help` lists its other
options). For a turn on a coding agent it reads the server's per-launch token
from `%APPDATA%\Magnusim\assistant\mcp.json`, which the server writes when it
starts with the Assistant set up (`MAGNUSIM_ASSISTANT_HOME`, set the same for
both, moves that folder).

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

The tests are not in this repository: the CAD plugin's unit, kernel and e2e
tests and the scripts that run them (its `npm test`, `npm run typecheck` and
`test:*` scripts), and `npm test` in `desktop/`, stay in Magnusim.

The kernel and solver WebAssembly modules in `bundled-plugins/cad/workspace/`
are prebuilt. Their sources, pinned to exact upstream commits with our patches,
and the Linux scripts that rebuild them are in `bundled-plugins/cad/kernel-build/`
and `bundled-plugins/cad/solver-build/`. On Linux or WSL, run `./build.sh` in
either folder to rebuild its module into `workspace/`: the script's first lines
say what it needs and its options, and the folder's `SOURCES.md` has the pins
(`./repro-check.sh --against-shipped` in `kernel-build/` compares a rebuilt
kernel with the shipped one).

## Where the code comes from

This repository is a copy of Magnusim CAD's code, one commit per copy.
Magnusim CAD and Magnusim's CAD plugin are the same code, so code changes are
made in Magnusim and arrive here with the next copy.
{{copied-from}}
Issues are welcome here. `EXPORT.json` says what each copy was made from and
lists every file in it, with the few the copy changes or leaves out and why.

## Licence

Magnusim CAD is free software under the GNU General Public License, version 3 or
(at your option) any later version: see `LICENSE`.

Third-party software keeps its own licences: `THIRD_PARTY_NOTICES.md`, the CAD
plugin's `magnusim-web/bundled-plugins/cad/LICENSES/` (the kernel's and the
solver's licences, and how to rebuild them), and, in the installed app,
`THIRD_PARTY_NOTICES.txt` with every npm package it ships.
