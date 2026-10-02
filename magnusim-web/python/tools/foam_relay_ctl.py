#!/usr/bin/env python3
"""Find or end a foam relay by identity, never by a pid Node kept (cfddesk.wsl.foam_relay).

CLI:
  foam_relay_ctl.py alive --job-id <fc-...>  -> {"ok": true, "alive": bool, "pids": [...]}
  foam_relay_ctl.py kill --job-id <fc-...>   -> {"ok": true, "killed": n}

A process is the job's when its command line has ``run_foam_case.py`` and
``<job_id>.json`` (the venv launcher and the real python), or when its
environment has ``MAGNUSIM_JOB_ID=<job_id>`` (the relay sets it for everything
it starts, so a prepare step's tool and its children are found even when the
relay died first). A process whose environment cannot be read is skipped. A
reused pid never matches. ``kill`` ends each match with its children
(``wsl.exe`` too): TERM, then KILL after 2 s.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any

JOB_ID_RE = re.compile(r"^fc-[a-z0-9]{6,12}-[0-9a-f]{6}$")
RELAY_SCRIPT = "run_foam_case.py"


def _base(word: str) -> str:
    return re.split(r"[\\/]", str(word))[-1]


def command_line_matches(cmdline: list[str] | None, job_id: str) -> bool:
    words = [_base(w) for w in (cmdline or [])]
    return RELAY_SCRIPT in words and f"{job_id}.json" in words


def _psutil() -> Any:
    import psutil

    return psutil


def find(job_id: str, *, ps: Any = None) -> list[Any]:
    """The job's processes (relay, launcher, prepare tool and what they started)."""
    ps = ps or _psutil()
    me = os.getpid()
    found: list[Any] = []
    for proc in ps.process_iter(["pid", "cmdline"]):
        try:
            if proc.pid == me:
                continue
            info = getattr(proc, "info", None) or {}
            cmdline = info.get("cmdline")
            if command_line_matches(cmdline, job_id):
                found.append(proc)
                continue
            try:
                env = proc.environ()
            except (ps.AccessDenied, ps.NoSuchProcess, ps.ZombieProcess, OSError):
                continue
            if (env or {}).get("MAGNUSIM_JOB_ID") == job_id:
                found.append(proc)
        except (ps.NoSuchProcess, ps.ZombieProcess):
            continue
    return found


def alive(job_id: str, *, ps: Any = None) -> dict[str, Any]:
    procs = find(job_id, ps=ps)
    return {"ok": True, "alive": bool(procs), "pids": sorted(int(p.pid) for p in procs)}


def kill(job_id: str, *, ps: Any = None, wait: float = 2.0) -> dict[str, Any]:
    ps = ps or _psutil()
    targets: dict[int, Any] = {}
    for proc in find(job_id, ps=ps):
        try:
            for child in proc.children(recursive=True):
                targets.setdefault(int(child.pid), child)
        except (ps.NoSuchProcess, ps.AccessDenied, ps.ZombieProcess):
            pass
        targets.setdefault(int(proc.pid), proc)
    procs = list(targets.values())
    for proc in procs:
        try:
            proc.terminate()
        except (ps.NoSuchProcess, ps.AccessDenied, ps.ZombieProcess):
            pass
    _gone, still = ps.wait_procs(procs, timeout=wait)
    for proc in still:
        try:
            proc.kill()
        except (ps.NoSuchProcess, ps.AccessDenied, ps.ZombieProcess):
            pass
    return {"ok": True, "killed": len(procs)}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Find or end a foam relay by its job id.")
    p.add_argument("mode", choices=("alive", "kill"))
    p.add_argument("--job-id", required=True)
    args = p.parse_args(argv)
    if not JOB_ID_RE.match(args.job_id):
        print(json.dumps({"ok": False, "error": "not a job id"}), flush=True)
        return 2
    try:
        doc = alive(args.job_id) if args.mode == "alive" else kill(args.job_id)
    except Exception as exc:
        doc = {"ok": False, "error": str(exc)}
    print(json.dumps(doc), flush=True)
    return 0 if doc.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
