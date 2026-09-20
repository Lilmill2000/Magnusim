# Magnusim

Windows app for incompressible CFD (geometry → mesh → OpenFOAM solve) in the browser.

The running app is **`magnusim-web/`**. Clone this repo and run Setup.bat. Versioned zip downloads (for example Magnusim V0.1.0) are release packages, not this source tree.

**Creator and maintainer:** Daniel Milligan ([@lilmill2000](https://x.com/lilmill2000) on X). This is an open-source project.

## Install on a new PC

1. Clone this repo, or copy this folder.
2. Double-click **Setup.bat** and leave the window open. First run can take 30–90 minutes (it installs Node.js, Python, WSL Ubuntu, and OpenFOAM v2606). Approve the Administrator prompt if Windows asks. If it tells you to reboot, do that and double-click Setup.bat again.
3. Double-click **run.bat**. The first time, a setup wizard asks for default units (metric or US customary), runs a hardware check that picks solver ranks for this PC, and lets you choose the local port (default 8082).
4. Double-click **stop.bat** when you are done. Close the browser tab too. Change those choices later from **Preferences** on the home screen.
5. To uninstall, close Setup.bat, run.bat, and File Explorer windows on this folder, then double-click **uninstall.bat**. It asks you to type `DELETE MAGNUSIM` before it removes this entire folder (including local projects). Shared Node.js, Python, and WSL stay unless you confirm those optional removals.

The same Setup / run / stop files also live inside `magnusim-web/` if you only opened that folder.

You need a 64-bit Intel/AMD Windows 10/11 PC with about 15 GB free and virtualization enabled in BIOS (required for WSL).

## Sharing / GitHub

`.gitignore` keeps `node_modules`, `python/.venv`, `projects`, and `.cache` out of git. Receivers clone this same tree and run Setup.bat.

To share a clean source zip (no projects or machine files), commit the intended state, then run `pack-portable.ps1` from this folder. It writes `dist/Magnusim-<shortsha>.zip` from `git archive` of this repo. Unzip on the other PC and double-click Setup.bat.

Do not zip an installed working tree: it can contain private projects, media, credentials, local preferences, and cached results.

Existing Git history also needs review before a public push; ignore rules do not erase old commits.

The original Magnusim source is licensed under [Apache 2.0](LICENSE). Dependencies
retain their own licenses; read [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
before distributing a combined application or environment bundle.
Removed unfinished UI features are recorded in [ROADMAP.md](ROADMAP.md).

This is a trusted local application. Read [SECURITY.md](SECURITY.md) before exposing
it remotely. The API does not provide user authentication.

## Layout

The running app is **`magnusim-web/`**. See `magnusim-web/README.md` for how the web UI, Node API, and Python tools fit together.
