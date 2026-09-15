# WSL bash templates

Placeholders are literal tokens replaced by Python (`str.replace`), never shell-expanded
before render:

| Token | Meaning |
|---|---|
| `__DST__` | Absolute WSL ext4 case path (`~/cases/cfddesk-…`) |
| `__WIN_OUT__` | Windows run folder as `/mnt/c/…` (staging + live results) |
| `__NPROCS__` | Integer rank count |
| `__APP__` | `simpleFoam` or `pimpleFoam` |
| `__RUN_ID__` | Run id (e.g. `run-1`) |

Snappy hex-dominant (`snappy_hexdominant.sh`) uses `__DST__`, `__WIN_OUT__`, and
related tokens documented in that file's header.

## Event contract

Templates echo lines:

```
MAGNUSIM_EVENT {"event":"stage","stage":"decompose",...}
```

(`CFDDESK_EVENT` is still accepted as a parse alias.)

OpenFOAM / mpirun stdout is left untouched. `cfddesk.wsl.solve_run` /
`tools/run_solve.py` parse events via `cfddesk.jobs.events` and turn residual /
Courant / `Time =` lines into `residual` / `courant` / `progress` events.

Legacy `W27_*` / `W25_*` markers are **not** emitted on this path. The JS
`buildSolveScript` / `writeSolveCase` writers were deleted in Phase 1 land6;
solve ownership is `prepare_run` + `run_solve` + `solve.sh`.

## Mesh pipeline scripts

These are written onto the Windows case and synced to WSL (LF, no BOM). Placeholders
are substituted by `cfddesk.wsl.mesh_run` at write time:

| File | Placeholders | Used by |
|---|---|---|
| `run_snappy_parallel.sh` | `__N__`, `__METHOD__` | `write_run_snappy_parallel_sh` / parallel snappy |
| `run_gmsh_standard.sh` | (none) | `write_run_gmsh_standard_sh` |
| `run_standard_mesh.sh` | (none) | `write_run_standard_sh` (gmsh + optional layers) |
| `run_cfmesh_standard.sh` | (none) | `write_run_cfmesh_standard_sh` |

Markers: `MESH_SCRIPT_OK` / `MESH_SCRIPT_FAIL: <step>` (parsed in Python).
