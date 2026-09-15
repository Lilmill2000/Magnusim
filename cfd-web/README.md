# CFD Desk — web app (`cfd-web`)

Vite + vtk.js single-page app. The dev server also hosts the `/api/*` backend as a Vite
middleware (`scripts/vite-plugin-case-fields.js`) which shells out to the Python side in
`python/` and to OpenFOAM v2606 inside WSL (`Ubuntu-24.04`). This folder is the whole app.

## First install (another PC or a GitHub clone)

Double-click **Setup.bat** in this folder (or in the parent folder). That installs Node.js,
Python, npm packages, the `python/.venv` CAD/mesh stack, WSL Ubuntu, and OpenFOAM v2606.
Leave the window open; the first run can take 30–90 minutes. If Windows asks for
Administrator, accept. If it asks you to reboot, reboot and run Setup.bat again.

Setup writes `.cfddesk-local.json` with this machine’s WSL user and `~/cases` path so
mesh/solve use this machine’s WSL user and `~/cases`. The first time you start the app, a wizard
sets default units, runs a hardware check (solver rank count), and lets you pick
the listen port. **Preferences** on the home screen opens that again.

## Run

Double-click `start.bat`, or from this folder:

```
npm run dev        # http://127.0.0.1:8082 (port is fixed)
```

Double-click `stop.bat` to kill the dev server (and only that process tree). Close the browser tab too — the vtk.js viewport keeps burning CPU if you leave it open.

Server modules under `scripts/` are **not** hot-reloaded — restart the dev server after
editing them. `src/` and `index.html` hot-reload normally. Python tools are spawned per
request, so edits under `python/` take effect immediately (export caches key on their mtime).

## Layout

| Path | Purpose |
|------|---------|
| `index.html`, `src/main.js`, `src/dashboard.js`, `src/style.css` | Frontend: home / projects, workbench (geometry → simulation → materials → boundary conditions → mesh), viewer, capture/record |
| `scripts/` | Node API middleware (one module per feature) |
| `scripts/vite-plugin-case-fields.js` | API router + post-processing exports (fields, cutting plane, iso, particle trace, inspect point) |
| `scripts/python-env.js` | Locates the Python interpreter and `python/tools/*.py` for the modules below |
| `scripts/w16-project-geometry.js` | Projects + STEP import (CAD preview, Body1 STL, thumbnails) |
| `scripts/w17-*.js` … `w26-*.js` | Simulation, materials, boundary conditions, mesh settings, refinements, monitors |
| `scripts/w21-mesh-generate.js` | `POST /api/mesh/generate`: routes to the mesh engines, tracks the job, persists `mesh.json` |
| `scripts/w27-solve.js` | Solver runs in WSL, residuals, monitors, result times |
| `scripts/w28-media.js` | Screenshots and recordings saved under a run or mesh |
| `python/` | Python side: `.venv`, the `cfddesk` library package and the CLI tools the API spawns — see `python/README.md` |
| `python/HEXCORE-PROCESS-BACKUP-2026-09-02/` | Frozen known-good cfMesh hexcore path (do not edit or delete) |
| `projects/<id>/` | Per-project data: `project.json`, `mesh.json`, `boundary_conditions.json`, `geometry/`, `mesh/run-<id>/`, `runs/`, `media/` |
| `.cache/` | Server scratch (export caches, job scripts and logs). Safe to delete. |
| `public/` | Static assets |

Python interpreter: `CFDDESK_PYTHON` env var, default `python\.venv\Scripts\python.exe`.
