"""Which programs the WSL OpenFOAM toolchain has, for plugins' ``wsl_tool`` requirements.

Probing starts WSL and sources OpenFOAM, which takes seconds, so it runs once in
a background thread and is cached in ``<web root>/.cache/wsl-tools.json`` for a
day. Until it answers, a plugin's wsl_tool requirements are unknown (not
reported missing). Without WSL (CI, Linux) they stay unknown.
``MAGNUSIM_WSL_TOOLS`` (a JSON list of names) replaces the probe (tests).
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
from collections.abc import Iterable
from pathlib import Path

log = logging.getLogger(__name__)

CACHE_TTL_S = 24 * 3600
TOOL_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.+-]{0,63}$")

_lock = threading.Lock()
_known: dict[str, bool] = {}
_checked_at = 0.0
_running = False


def _cache_file(web_root: Path | None) -> Path | None:
    return Path(web_root) / ".cache" / "wsl-tools.json" if web_root else None


def _load_cache(web_root: Path | None) -> None:
    global _checked_at
    f = _cache_file(web_root)
    if f is None or _checked_at or not f.is_file():
        return
    try:
        doc = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    tools = doc.get("tools") if isinstance(doc, dict) else None
    at = float(doc.get("checked_at") or 0) if isinstance(doc, dict) else 0.0
    if isinstance(tools, dict) and time.time() - at < CACHE_TTL_S:
        _known.update({str(k): bool(v) for k, v in tools.items()})
        _checked_at = at


def probe(names: Iterable[str]) -> dict[str, bool] | None:
    """Ask WSL which of ``names`` exist under the OpenFOAM environment (None: no WSL)."""
    want = sorted({n for n in names if TOOL_NAME.match(n)})
    if not want:
        return {}
    if shutil.which("wsl") is None:
        return None
    from cfddesk.wsl.openfoam import OPENFOAM_WRAPPER, run_wsl_bash

    # `command -v a b c` prints the path of each program it finds (no `$` to
    # survive wsl.exe's quoting); a missing one is simply not printed.
    try:
        done = run_wsl_bash(f"{OPENFOAM_WRAPPER} bash -c 'command -v {' '.join(want)}'", timeout=90)
    except Exception as exc:  # noqa: BLE001 - no answer is "unknown", never "missing"
        log.info("WSL tool probe failed: %s", exc)
        return None
    found = {Path(line.strip()).name for line in done.stdout.splitlines() if line.strip()}
    if not found and done.returncode != 0 and "not found" in done.stderr and OPENFOAM_WRAPPER in done.stderr:
        return {n: False for n in want}
    if not found and done.returncode != 0:
        return None
    return {n: n in found for n in want}


def _run_probe(names: list[str], web_root: Path | None) -> None:
    global _checked_at, _running
    try:
        result = probe(names)
        if result is None:
            return
        with _lock:
            _known.update(result)
            _checked_at = time.time()
            snapshot = dict(_known)
        f = _cache_file(web_root)
        if f is not None:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps({"checked_at": _checked_at, "tools": snapshot}, indent=2), encoding="utf-8")
    finally:
        with _lock:
            _running = False


def available(names: Iterable[str], web_root: Path | None) -> set[str] | None:
    """The names the toolchain has, or None while that is not known yet."""
    global _running
    want = {n for n in names if TOOL_NAME.match(n)}
    if not want:
        return set()
    fake = os.environ.get("MAGNUSIM_WSL_TOOLS")
    if fake is not None:
        try:
            listed = json.loads(fake)
        except ValueError:
            listed = []
        return {str(n) for n in listed if str(n) in want}
    with _lock:
        _load_cache(web_root)
        fresh = _checked_at and time.time() - _checked_at < CACHE_TTL_S
        if fresh and want <= set(_known):
            return {n for n in want if _known.get(n)}
        if not _running:
            _running = True
            threading.Thread(
                target=_run_probe, args=(sorted(want | set(_known)), web_root), name="wsl-tools", daemon=True
            ).start()
    return None


def reset_for_tests() -> None:
    global _checked_at, _running
    with _lock:
        _known.clear()
        _checked_at = 0.0
        _running = False
