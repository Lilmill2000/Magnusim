# Magnusim — web app (`cfd-web`)

Vite + vtk.js single-page app. The dev server also hosts the `/api/*` backend as a Vite
middleware (`scripts/server/index.ts`) with a persistent Python JSON-RPC worker in
`python/` and to OpenFOAM v2606 inside WSL (`Ubuntu-24.04`). This folder is the whole app.

## First install (another PC or a GitHub clone)

Double-click **Setup.bat** in this folder (or in the parent folder). That installs Node.js,
Python, npm packages, the `python/.venv` CAD/mesh stack, WSL Ubuntu, and OpenFOAM v2606.
Leave the window open; the first run can take 30–90 minutes. If Windows asks for
Administrator, accept. If it asks you to reboot, reboot and run Setup.bat again.

Setup writes `.magnusim-local.json` (legacy `.cfddesk-local.json` still read) with this machine’s WSL user and `~/cases` path so
mesh/solve use this machine’s WSL user and `~/cases`. The first time you start the app, a wizard
sets default units, runs a hardware check (solver rank count), and lets you pick
the listen port. **Preferences** on the home screen opens that again.

## Run

Double-click `run.bat`, or from this folder:

```
npm run dev        # http://127.0.0.1:8082 by default; preferences/MAGNUSIM_PORT can change it
```

Double-click `stop.bat` to kill the dev server (and only that process tree). Close the browser tab too — the vtk.js viewport keeps burning CPU if you leave it open.

Server modules under `scripts/` are **not** hot-reloaded — restart the dev server after
editing them. `src/` and `index.html` hot-reload normally. Restart after Python changes too: the persistent worker keeps imported modules in memory.
`npm run build` builds the frontend; `npm run preview` serves that build with the local API.

## Layout

| Path | Purpose |
|------|---------|
| `index.html`, `src/app/main.tsx`, `src/workbench/runtime.js`, `src/home/controller.ts`, `src/style.css` | Frontend: home / projects, workbench (geometry → simulation → materials → boundary conditions → mesh), viewer, capture/record |
| `scripts/` | Node API middleware (one module per feature) |
| `scripts/server/` + `scripts/vite-plugin-case-fields.js` | Typed API router, Python worker, jobs, and legacy post-processing exports (fields, cutting plane, iso, particle trace, inspect point) |
| `scripts/python-env.js` | Locates the Python interpreter and `python/tools/*.py` for the modules below |
| `scripts/w16-project-geometry.js` | Projects + STEP import (CAD preview, Body1 STL, thumbnails) |
| `scripts/w17-*.js` … `w26-*.js` | Simulation, materials, boundary conditions, mesh settings, refinements, monitors |
| `scripts/w21-mesh-generate.js` | `POST /api/mesh/generate`: routes to the mesh engines, tracks the job, persists `mesh.json` |
| `scripts/w27-solve.js` | Solver runs in WSL, residuals, monitors, result times |
| `scripts/w28-media.js` | Screenshots and recordings saved under a run or mesh |
| `python/` | Python side: `.venv`, the `cfddesk` library package (import path kept; product name Magnusim) and the CLI tools the API spawns — see `python/README.md` |
| `python/HEXCORE-PROCESS-BACKUP-2026-09-02/` | Frozen known-good cfMesh hexcore path (do not edit or delete) |
| `projects/<id>/` | Project catalog + `geometries/Geometry_*/simulations/<study>/` with scoped setup, `meshes/<mesh>/case/`, and `simulation_runs/<run>/case/`; project media remain in `media/` |
| `.cache/` | Server scratch (export caches, job scripts and logs). Safe to delete. |
| `public/` | Static assets |

Python interpreter: `MAGNUSIM_PYTHON` env var (falls back to `CFDDESK_PYTHON`), default `python\.venv\Scripts\python.exe`.


## Validation

Use Node 24 LTS and Python 3.10–3.12. Run `npm test` and `npm run build` here;
run `ruff check cfddesk tools tests`, `mypy cfddesk`, and `pytest` under `python/`.
The default browser suite tests UI workflows in isolated fixtures. Set
`MAGNUSIM_E2E_WSL=1` to require real meshing and solving on a configured WSL PC.

Remote hosting requires an authenticated reverse proxy and an explicit
`MAGNUSIM_ALLOWED_HOSTS` list. See [security](../SECURITY.md) and
[dependency licensing](../THIRD_PARTY_NOTICES.md).
