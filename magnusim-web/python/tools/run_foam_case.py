#!/usr/bin/env python3
"""One run of the step-list runner: a plugin OpenFOAM case, or a meshing plan
(cfddesk.wsl.foam_relay).

CLI:
  run_foam_case.py --launch --spec <path>      the starter: starts the relay with no
                                               console window, out of the app's process
                                               tree, prints relay_launch and exits 0
                                               (relay_launch_failed and 3 when it cannot)
  run_foam_case.py --spec <path>               the relay
  run_foam_case.py --selftest console --out <file> [--sleep S]   tests only

The spec file is ``<job_id>.json`` in a ``foam-specs`` folder, written by Node; the
relay trusts nothing in it. Case names never appear on a command line.
"""
from __future__ import annotations

import argparse
import faulthandler
import os
import sys
from pathlib import Path

# The relay says it is alive before any import that can take long, so the runner can
# tell a relay that died starting (nothing said) from one that runs. A hard crash
# leaves its stack on stderr (the job log), and a start that takes 2 minutes leaves
# where it is; the relay cancels that once its parts run (foam_relay.Relay._run_checked).
STARTUP_DUMP_S = 120
if "--spec" in sys.argv and "--launch" not in sys.argv and "--selftest" not in sys.argv:
    try:
        sys.stdout.write(f'MAGNUSIM_EVENT {{"event":"relay_alive","pid":{os.getpid()}}}\n')
        sys.stdout.flush()
    except (OSError, ValueError):
        pass
    if sys.stderr is not None:
        faulthandler.enable()
        faulthandler.dump_traceback_later(STARTUP_DUMP_S, exit=False)

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.wsl import foam_relay


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Run one step-list run (plugin OpenFOAM case).")
    p.add_argument("--launch", action="store_true", help="Start the relay hidden and exit")
    p.add_argument("--spec", type=Path, default=None, help="The run's spec file (.cache/foam-specs/<job_id>.json)")
    p.add_argument("--selftest", choices=("console",), default=None, help="Tests only")
    p.add_argument("--out", type=Path, default=None, help="--selftest: where to write")
    p.add_argument("--sleep", type=float, default=0.0, help="--selftest: seconds before the late line")
    args = p.parse_args(argv)

    if args.selftest == "console":
        if args.out is None:
            p.error("--selftest console needs --out")
        child = ["--selftest", "console", "--out", str(args.out), "--sleep", str(args.sleep)]
        if args.launch:
            return foam_relay.launch(child, script=str(Path(__file__).resolve()))
        return foam_relay.selftest_console(args.out, args.sleep)

    if args.spec is None:
        p.error("--spec is required")
    if args.launch:
        return foam_relay.launch(
            ["--spec", str(args.spec)], script=str(Path(__file__).resolve()), job_id=args.spec.stem
        )
    from cfddesk.worker.paths import projects_root

    return foam_relay.run_relay(args.spec, projects_root=projects_root())


if __name__ == "__main__":
    raise SystemExit(main())
