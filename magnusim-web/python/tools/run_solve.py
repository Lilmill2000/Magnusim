#!/usr/bin/env python3
"""Stream a WSL OpenFOAM solve as MAGNUSIM_EVENT JSONL (Phase 1 Step 5).

CLI: tools/run_solve.py --case-dir ... --wsl-case ... --n-procs N --app <program> --run-id ...
     [--keep-frames all|latest] [--process-names a,b] [--log-parser JSON]
     [--owner core:<project>/<study> --hooks solve.prepare,solve.parse_line,...]

The app, frames kept, process names and log parser come from the analysis's
launch spec (prepare_run reports it; Node passes it on). ``--hooks`` is given
only when some plugin listens (cfddesk.wsl.solve_hooks); the solve never waits
for a hook.

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
from cfddesk.registry.contract import LEGACY_FRAME_FIELDS
from cfddesk.runner.case_id import wsl_case_path
from cfddesk.wsl.mesh_run import windows_to_wsl_path
from cfddesk.wsl.solve_hooks import HookRunner, hook_names
from cfddesk.wsl.solve_run import (
    events_from_lines,
    render_solve_script,
    start_solve,
    stream_events_to_stdout,
    write_solve_script,
)


def _hook_runner(args: argparse.Namespace, case_dir: Path | None = None) -> HookRunner | None:
    """Solve hooks for this run, started (output isolated, plugins loading), or None.

    Only when Node passed hook names (some plugin listens) and a valid owner.
    The solve never waits for them: solve.prepare is a notice for core runs.
    """
    names = hook_names(args.hooks)
    if not names:
        return None
    from cfddesk.registry.solve_context import solve_context

    ctx = solve_context(
        args.owner,
        wsl_case=str(args.wsl_case or ""),
        run_id=args.run_id,
        app=args.app or None,
        case_dir=str(case_dir) if case_dir is not None else None,
        n_procs=args.n_procs,
    )
    if ctx is None:
        return None
    runner = HookRunner(ctx, names)
    runner.start()
    return runner


def _parse_log(path: Path, runner: HookRunner | None = None) -> int:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    out = runner.events if runner is not None else None
    events = events_from_lines(lines, on_line=runner.feed if runner is not None else None, out=out)
    if out is None:
        for ev in events:
            print(EVENT_PREFIX + ev.to_json(), flush=True)
    kinds = {}
    for ev in events:
        kinds[ev.event] = kinds.get(ev.event, 0) + 1
    # Summary result if the log did not already emit one
    if not any(ev.event == "result" for ev in events):
        summary = EVENT_PREFIX + json.dumps(
            {"event": "result", "ok": True, "parsed_only": True, "counts": kinds},
            separators=(",", ":"),
        )
        if out is None:
            print(summary, flush=True)
        else:
            out.write(summary + "\n")
    if runner is not None:
        runner.close()
    return 0


def _frame_fields(args: argparse.Namespace) -> tuple[str, ...]:
    return tuple(f.strip() for f in args.frame_fields.split(",") if f.strip()) or LEGACY_FRAME_FIELDS


def _render_only(args: argparse.Namespace) -> int:
    dst = wsl_case_path(args.wsl_case)
    win_out = windows_to_wsl_path(Path(args.case_dir).resolve())
    frame_fields = _frame_fields(args)
    body = render_solve_script(
        dst=dst,
        win_out=win_out,
        n_procs=args.n_procs,
        app=args.app,
        run_id=args.run_id,
        keep_frames=args.keep_frames,
        frame_fields=frame_fields,
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
            keep_frames=args.keep_frames,
            frame_fields=frame_fields,
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
    p.add_argument("--app", default="", help="Program to run: the launch spec's app (a registered solver application)")
    p.add_argument("--keep-frames", default="latest", choices=("all", "latest"))
    p.add_argument("--frame-fields", default=",".join(LEGACY_FRAME_FIELDS), help="Comma-separated fields that mark a written result frame")
    p.add_argument("--process-names", default="", help="Comma-separated solver process names (default: the app)")
    p.add_argument("--log-parser", default="", help="Launch spec log_parser as JSON {module, factory, path}")
    p.add_argument("--run-id", default="run-1")
    p.add_argument("--parse-log", type=Path, default=None, help="Offline: parse a captured log to JSONL")
    p.add_argument("--render-only", action="store_true", help="Render solve.sh and exit (no WSL)")
    p.add_argument("--render-out", type=Path, default=None, help="With --render-only, write script here")
    p.add_argument("--owner", default="", help="Solve hooks: the run's owner, core:<project>/<study>")
    p.add_argument("--hooks", default="", help="Solve hooks some plugin listens on (comma list)")
    args = p.parse_args(argv)

    if args.parse_log is not None:
        return _parse_log(args.parse_log, _hook_runner(args))

    if args.case_dir is None or args.wsl_case is None:
        print(
            json.dumps({"ok": False, "error": "--case-dir and --wsl-case required (unless --parse-log)"}),
            flush=True,
        )
        return 2

    if not args.app:
        print(json.dumps({"ok": False, "error": "--app required (the analysis launch spec's app)"}), flush=True)
        return 2

    if args.render_only:
        return _render_only(args)

    case_dir = Path(args.case_dir).resolve()
    if not (case_dir / "constant" / "polyMesh").is_dir() and not (case_dir / "system").is_dir():
        # soft check: allow missing polyMesh only if system exists (error will come from bash)
        pass

    from cfddesk.registry.contract import APP_NAME_RE, load_log_parser

    if not APP_NAME_RE.match(args.app or ""):
        print(json.dumps({"ok": False, "error": f"not a plain program name: {args.app!r}"}), flush=True)
        return 2
    names = tuple(n.strip() for n in args.process_names.split(",") if n.strip()) or (args.app,)
    parser = load_log_parser(json.loads(args.log_parser) if args.log_parser else None)
    # Started before the solve and never waited for.
    runner = _hook_runner(args, case_dir)
    proc = start_solve(
        case_dir,
        wsl_case_id=args.wsl_case,
        n_procs=args.n_procs,
        app=args.app,
        run_id=args.run_id,
        keep_frames=args.keep_frames,
        process_names=names,
        frame_fields=_frame_fields(args),
    )
    if runner is None:
        rc, parser = stream_events_to_stdout(proc, parser)
    else:
        rc, parser = stream_events_to_stdout(proc, parser, on_line=runner.feed, out=runner.events)
        runner.close(join=2.0)
    parser.snapshot()
    # Ensure a trailing result if the template somehow did not emit one
    # (stream already printed events; only add if missing — check via stage)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
