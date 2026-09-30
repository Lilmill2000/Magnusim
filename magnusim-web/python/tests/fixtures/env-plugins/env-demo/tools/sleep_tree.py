"""Job tool: starts a child process and waits (gate:h12-kill-tree).

Stopping the job must stop the child too.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--seconds", default="600")
args = parser.parse_args()
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
print("MAGNUSIM_EVENT " + json.dumps({"event": "log", "line": f"child {child.pid}", "child_pid": child.pid, "prefix": sys.prefix}), flush=True)
time.sleep(float(args.seconds))
child.kill()
