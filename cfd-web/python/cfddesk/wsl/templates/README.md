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

## Event contract

Templates echo lines:

```
CFDDESK_EVENT {"event":"stage","stage":"decompose",...}
```

OpenFOAM / mpirun stdout is left untouched. `cfddesk.wsl.solve_run` / `tools/run_solve.py`
parse `CFDDESK_EVENT` via `cfddesk.jobs.events` and turn residual / Courant / `Time =`
lines into `residual` / `courant` / `progress` events.

Legacy `W27_*` markers are not emitted on this path (JS `buildSolveScript` still does
until a later land deletes it).
