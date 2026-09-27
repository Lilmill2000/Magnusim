"""stdio JSON-RPC loop: ``python -m cfddesk.worker``."""

from __future__ import annotations

import faulthandler
import os
import sys
from io import TextIOWrapper

from cfddesk.worker import handle_line
from cfddesk.worker import methods as _methods  # noqa: F401  — register RPCs


def main() -> int:
    # JSON-RPC is UTF-8 regardless of the Windows console code page.
    if isinstance(sys.stdin, TextIOWrapper):
        sys.stdin.reconfigure(encoding="utf-8")
    if isinstance(sys.stdout, TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8")
    if isinstance(sys.stderr, TextIOWrapper):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    # MAGNUSIM_WORKER_STACKS=<file>: a request still running after 20 s dumps every
    # thread's stack there (finds what a stuck call is waiting on).
    stacks = None
    stacks_path = os.environ.get("MAGNUSIM_WORKER_STACKS")
    if stacks_path:
        stacks = open(stacks_path, "a", encoding="utf-8")  # noqa: SIM115 - lives as long as the worker
    for line in sys.stdin:
        if stacks is not None:
            stacks.write(f"--- pid {os.getpid()} request {line[:200].strip()}\n")
            stacks.flush()
            faulthandler.dump_traceback_later(20, repeat=True, file=stacks)
        out = handle_line(line)
        if stacks is not None:
            faulthandler.cancel_dump_traceback_later()
        if out is None:
            continue
        sys.stdout.write(out + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
