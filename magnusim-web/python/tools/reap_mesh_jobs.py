#!/usr/bin/env python3
"""Kill leftover generate_* processes after a server restart."""
from __future__ import annotations

import json
import sys
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.mesh.generate_guard import reap_all_generators


def main() -> int:
    killed = reap_all_generators()
    print(json.dumps({"ok": True, "killed": killed}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
