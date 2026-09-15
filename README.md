# Magnusim

Windows app for incompressible CFD (geometry â†’ mesh â†’ OpenFOAM solve) in the browser.

## Install on a new PC

1. Copy this folder, or clone the GitHub repo.
2. Double-click **Setup.bat** and leave the window open. First run can take 30â€“90 minutes (it installs Node.js, Python, WSL Ubuntu, and OpenFOAM v2606). Approve the Administrator prompt if Windows asks. If it tells you to reboot, do that and double-click Setup.bat again.
3. Double-click **start.bat**. The first time, a setup wizard asks for default units (metric or US customary), runs a hardware check that picks solver ranks for this PC, and lets you choose the local port (default 8082).
4. Double-click **stop.bat** when you are done. Close the browser tab too. Change those choices later from **Preferences** on the home screen.

The same three files live inside `cfd-web/` if you only copied that folder.

You need a 64-bit Intel/AMD Windows 10/11 PC with about 15 GB free and virtualization enabled in BIOS (required for WSL).

## Sharing / GitHub

`.gitignore` keeps `node_modules`, `python/.venv`, `projects`, and `.cache` out of git. Receivers clone and run Setup.bat.

To share a clean source zip (no projects or machine files), run `pack-portable.ps1` from this folder. It writes `dist/Magnusim-<shortsha>.zip` via `git archive`. Unzip on the other PC and double-click Setup.bat. See `cfd-web/START-HERE.txt` inside the archive.

If you zip this working tree instead, zip **before** you run Setup, or exclude `cfd-web/node_modules`, `cfd-web/python/.venv`, and `cfd-web/.cache`.

## Layout

The running app is **`cfd-web/`**. See `cfd-web/README.md` for how the web UI, Node API, and Python tools fit together.

