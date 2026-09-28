"""stdio JSON-RPC loop: ``python -m cfddesk.worker``."""

from __future__ import annotations

import faulthandler
import os
import sys
from io import TextIOWrapper

from cfddesk.worker import handle_line
from cfddesk.worker import methods as _methods  # noqa: F401  — register RPCs


def _private_reply_stream():
    """Keep the real stdout for JSON-RPC replies only; point fd 1 at stderr.

    Exporters ``print`` progress JSON, and native code (VTK, gmsh) can write to
    fd 1 directly. On the shared pipe such a write can land inside a reply line,
    which the client then cannot parse and drops (looks like a lost request).
    """
    sys.stdout.flush()
    reply_fd = os.dup(1)
    os.dup2(2, 1)
    if sys.platform == "win32":
        # Native code may write through the OS handle rather than CRT fd 1.
        try:
            import ctypes
            import msvcrt

            std_output_handle = -11
            ctypes.windll.kernel32.SetStdHandle(std_output_handle, msvcrt.get_osfhandle(2))
        except Exception:
            pass
    return open(reply_fd, "w", encoding="utf-8")  # noqa: SIM115 - lives as long as the worker


def main() -> int:
    # JSON-RPC is UTF-8 regardless of the Windows console code page.
    if isinstance(sys.stdin, TextIOWrapper):
        sys.stdin.reconfigure(encoding="utf-8")
    replies = _private_reply_stream()
    if isinstance(sys.stdout, TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
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
        replies.write(out + "\n")
        replies.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
