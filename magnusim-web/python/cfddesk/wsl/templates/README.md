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

`foam_pre.sh` (`cfddesk.wsl.foam_case.render_foam_pre`) runs the WSL steps of a
step-list run (plugin OpenFOAM cases, meshing plans): `__DST__`, `__WIN_OUT__`,
`__TOKEN__` and `__STEPS__`, replaced in one pass (`re.sub` with a lookup), so an
inserted value is never scanned again. `__STEPS__` becomes one bash array per step,
`STEP_<i>=(<tool> <quoted args>)`, run as `openfoam2606 "${STEP_<i>[@]}"` with its
output in `log.<tool>.<i>`; no argument is pasted into `bash -c`. A step inside a
`decomposePar` … `reconstructParMesh` span runs as
`mpirun --oversubscribe -np <n> <tool> … -parallel` (the line `solve.sh` uses for a
parallel solve) when the run has more than one rank; with one rank the span runs
serially and `decomposePar` and `reconstructParMesh` only report `"skipped":true`.
It checks `__WIN_OUT__/.magnusim-stop` before and after each step (exit 130),
copies back `constant/polyMesh`, `0/` (when there is one) and `log.*` through
`.magnusim-*.part` names, never `processor*`, and never creates `__WIN_OUT__`.
Exit 50: a step wrote a result time folder; 46: no `constant/polyMesh` after the
steps. The relay runs it with `wsl -e bash <script>` (no shell in between).

`solve.sh` removes `__DST__` once the run succeeded and everything came back to
`__WIN_OUT__`. `prune_cases.sh` (no tokens: `ROOT MAX_AGE_MIN DRY` arguments, run
by `cfddesk.runner.cleanup`) sweeps the case root for copies failed or stopped
runs left behind.

## Event contract

Templates echo lines:

```
MAGNUSIM_EVENT {"event":"stage","stage":"decompose",...}
```

(`CFDDESK_EVENT` is still accepted as a parse alias.)

OpenFOAM / mpirun stdout is left untouched. `cfddesk.wsl.solve_run` (run by the
step-list runner's relay, `cfddesk.wsl.foam_relay`) parses events via
`cfddesk.jobs.events` and the analysis's log parser turns residual / Courant /
`Time =` lines into `residual` / `courant` / `progress` events.

Legacy `W27_*` / `W25_*` markers are **not** emitted on this path. The JS
`buildSolveScript` / `writeSolveCase` writers were deleted in Phase 1 land6;
solve ownership is the analysis's prepare job (or `prepare_run`) + the relay + `solve.sh`.
`tools/run_solve.py` keeps `--parse-log` (a captured log to events) and
`--render-only` (write `solve.sh`, no WSL).

## Mesh pipeline scripts

These are written onto the Windows case and synced to WSL (LF, no BOM). Placeholders
are substituted by `cfddesk.wsl.mesh_run` at write time:

| File | Placeholders | Used by |
|---|---|---|
| `run_standard_mesh.sh` | (none) | `write_run_standard_sh` (gmsh + optional layers) |
| `run_cfmesh_standard.sh` | (none) | `write_run_cfmesh_standard_sh` |

Markers: `MESH_SCRIPT_OK` / `MESH_SCRIPT_FAIL: <step>` (parsed in Python).
