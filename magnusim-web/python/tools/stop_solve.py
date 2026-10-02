#!/usr/bin/env python3
"""Graceful or force stop of a WSL solve (Phase 1 Step 5).

With ``--hooks solve.stop`` (some plugin listens) and ``--owner``, the
``solve.stop(ctx, forced)`` hook fires after the stop action, in a thread joined
at most 5 s. ``--probe`` never fires a hook.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.wsl.solve_hooks import HookRunner, hook_names
from cfddesk.wsl.solve_run import kill_solve, solve_is_live, stop_solve


def _hook_runner(args: argparse.Namespace) -> HookRunner | None:
    names = [n for n in hook_names(args.hooks) if n == "solve.stop"]
    if not names:
        return None
    from cfddesk.registry.solve_context import solve_context

    ctx = solve_context(
        args.owner,
        wsl_case=str(args.wsl_case or ""),
        run_id=args.run_id,
        app=args.app or None,
        case_dir=args.case_dir or None,
        n_procs=args.n_procs,
    )
    if ctx is None:
        return None
    runner = HookRunner(ctx, names)
    runner.start()
    return runner


def _say(doc: dict, runner: HookRunner | None) -> None:
    line = json.dumps(doc)
    if runner is not None and runner.events is not None:
        runner.events.write(line + "\n")
    else:
        print(line, flush=True)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Stop a running cfddesk WSL solve.")
    p.add_argument("--wsl-case", required=True)
    p.add_argument("--run-id", default=None)
    p.add_argument("--force", action="store_true", help="Skip writeNow; kill immediately")
    p.add_argument("--probe", action="store_true", help="Report whether the WSL solver is still live")
    p.add_argument("--process-names", default="", help="Comma-separated solver process names of the run")
    p.add_argument("--owner", default="", help="Solve hooks: the run's owner, core:<project>/<study>")
    p.add_argument("--hooks", default="", help="Solve hooks some plugin listens on (comma list)")
    p.add_argument("--app", default="", help="Solve hooks: the run's app")
    p.add_argument("--case-dir", default="", help="Solve hooks: the run's Windows case folder")
    p.add_argument("--n-procs", type=int, default=None, help="Solve hooks: the run's ranks")
    args = p.parse_args(argv)
    names = tuple(n.strip() for n in args.process_names.split(",") if n.strip()) or None
    if args.probe:
        try:
            live = solve_is_live(args.wsl_case, names)
            print(json.dumps({"ok": True, "live": live, "wsl_case": args.wsl_case}), flush=True)
            return 0
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
            return 1
    runner = _hook_runner(args)
    try:
        if args.force:
            kill_solve(args.wsl_case, args.run_id, names)
        else:
            stop_solve(args.wsl_case, graceful=True)
    except Exception as exc:
        _say({"ok": False, "error": str(exc)}, runner)
        return 1
    _say({"ok": True, "wsl_case": args.wsl_case, "forced": bool(args.force)}, runner)
    if runner is not None:
        runner.stop_notice(forced=bool(args.force))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
