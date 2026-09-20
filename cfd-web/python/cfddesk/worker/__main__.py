"""stdio JSON-RPC loop: ``python -m cfddesk.worker``."""

from __future__ import annotations

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
    for line in sys.stdin:
        out = handle_line(line)
        if out is None:
            continue
        sys.stdout.write(out + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
