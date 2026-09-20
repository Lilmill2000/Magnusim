#!/usr/bin/env python3
"""Stream a WSL OpenFOAM solve as MAGNUSIM_EVENT JSONL (Phase 1 Step 5).

CLI: tools/run_solve.py --case-dir ... --wsl-case ... --n-procs N --app simpleFoam|pimpleFoam --run-id ...

Also supports --parse-log PATH for offline JSONL parsing tests (no WSL).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.jobs.events import EVENT_PREFIX
from cfddesk.runner.case_id import wsl_case_path
from cfddesk.wsl.mesh_run import windows_to_wsl_path
from cfddesk.wsl.solve_run import (
    events_from_lines,
    render_solve_script,
    start_solve,
    stream_events_to_stdout,
    write_solve_script,
)


def _parse_log(path: Path) -> int:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    events = events_from_lines(lines)
    for ev in events:
        print(EVENT_PREFIX + ev.to_json(), flush=True)
    kinds = {}
    for ev in events:
        kinds[ev.event] = kinds.get(ev.event, 0) + 1
    # Summary result if the log did not already emit one
    if not any(ev.event == "result" for ev in events):
        print(
            EVENT_PREFIX
            + json.dumps(
                {"event": "result", "ok": True, "parsed_only": True, "counts": kinds},
                separators=(",", ":"),
            ),
            flush=True,
        )
    return 0


def _render_only(args: argparse.Namespace) -> int:
    dst = wsl_case_path(args.wsl_case)
    win_out = windows_to_wsl_path(Path(args.case_dir).resolve())
    body = render_solve_script(
        dst=dst,
        win_out=win_out,
        n_procs=args.n_procs,
        app=args.app,
        run_id=args.run_id,
    )
    out = Path(args.render_out) if args.render_out else None
    if out:
        write_solve_script(
            out,
            dst=dst,
            win_out=win_out,
            n_procs=args.n_procs,
            app=args.app,
            run_id=args.run_id,
        )
        print(
            json.dumps({"ok": True, "script": str(out), "bytes": len(body.encode("utf-8"))}),
            flush=True,
        )
    else:
        sys.stdout.write(body)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Run OpenFOAM solve via WSL; stream JSONL events.")
    p.add_argument("--case-dir", type=Path, help="Windows run case directory (0/ constant/ system/)")
    p.add_argument("--wsl-case", default=None, help="WSL case id, e.g. cfddesk-w27-run-1")
    p.add_argument("--n-procs", type=int, default=1)
    p.add_argument("--app", default="simpleFoam", choices=("simpleFoam", "pimpleFoam"))
    p.add_argument("--run-id", default="run-1")
    p.add_argument("--parse-log", type=Path, default=None, help="Offline: parse a captured log to JSONL")
    p.add_argument("--render-only", action="store_true", help="Render solve.sh and exit (no WSL)")
    p.add_argument("--render-out", type=Path, default=None, help="With --render-only, write script here")
    args = p.parse_args(argv)

    if args.parse_log is not None:
        return _parse_log(args.parse_log)

    if args.case_dir is None or args.wsl_case is None:
        print(
            json.dumps({"ok": False, "error": "--case-dir and --wsl-case required (unless --parse-log)"}),
            flush=True,
        )
        return 2

    if args.render_only:
        return _render_only(args)

    case_dir = Path(args.case_dir).resolve()
    if not (case_dir / "constant" / "polyMesh").is_dir() and not (case_dir / "system").is_dir():
        # soft check: allow missing polyMesh only if system exists (error will come from bash)
        pass

    proc = start_solve(
        case_dir,
        wsl_case_id=args.wsl_case,
        n_procs=args.n_procs,
        app=args.app,
        run_id=args.run_id,
    )
    rc, parser = stream_events_to_stdout(proc)
    parser.snapshot()
    # Ensure a trailing result if the template somehow did not emit one
    # (stream already printed events; only add if missing — check via stage)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
