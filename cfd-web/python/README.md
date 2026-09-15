# cfd-web / python

Everything the web app runs through Python lives here. The Node API
(`../scripts/*.js`) spawns `.venv/Scripts/python.exe` on scripts in `tools/`
(see `../scripts/python-env.js`; override with the `CFDDESK_PYTHON` env var).

| Path | Purpose |
|------|---------|
| `.venv/` | Python 3.10 virtual environment: pyvista/VTK, gmsh, cadquery-ocp (OCCT), numpy, psutil. `cfddesk` is installed editable from this folder. |
| `cfddesk/` | Library package (importable as `cfddesk`) |
| `cfddesk/cad/` | STEP loading (OCCT), units, bounding boxes, STL export/quality, gap and passage measurement |
| `cfddesk/mesh/` | Mesh engines: gmsh Standard surface mesh + hex core (`gmsh_standard`, `standard_hexcore`, `hexcore_bodyfit`, `octree_hex`), cfMesh `cartesianMesh` (`cfmesh_standard`), OpenFOAM dict writers (`case_writer`, `create_patch`, `feature_edges`, `snappy_policy`) |
| `cfddesk/case/` | OpenFOAM case writers: boundary conditions, RAS turbulence, function objects for surface averages |
| `cfddesk/project/` | Project model + settings (mesh sizing, refinements, initial conditions, numerics) |
| `cfddesk/results/` | Post-processing helpers used by the exporters (patch surfaces, loaders, colour scales) |
| `cfddesk/runner/` | Windows ⇄ WSL case sync, case ids, parallel decomposition |
| `cfddesk/wsl/` | Runs the OpenFOAM / cfMesh pipelines inside WSL |
| `cfddesk/materials/`, `cfddesk/units/` | Material library and unit conversion |
| `tools/` | CLI entry points spawned by the API (one process per request) |
| `tools/generate_standard.py` | **Standard** mesher (default) |
| `tools/generate_cfmesh_standard.py` | cfMesh `cartesianMesh` engine (Standard + Hex element core on) |
| `tools/export_*.py` | Result exports: surface fields, cutting plane, particle trace, iso surface/volume, inspect point, mesh surface/section |
| `tools/convert_step_to_stl.py`, `export_step_cad_preview.py`, `render_geometry_thumb.py` | Geometry import, CAD preview and thumbnails |
| `tools/case_units.py`, `case_volume.py` | Shared helpers for the exporters (pressure units, cached volume read) |
| `HEXCORE-PROCESS-BACKUP-2026-09-02/` | Frozen copy of the known-good cfMesh hexcore path. Do not edit or delete; see its README to restore. |

Re-create the environment (only if `.venv` is lost). Prefer **Setup.bat** in
`cfd-web/` (or the repo root) so Node, WSL, and OpenFOAM stay in sync. Manual:

```powershell
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -e .
```
