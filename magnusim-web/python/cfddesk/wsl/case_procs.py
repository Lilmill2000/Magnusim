"""The processes of one WSL case copy, matched with a boundary (API 1.3).

``probe`` says whether anything still works in ``<case root>/<wsl case id>``;
``kill`` ends it. Plugin cases, the relay's stop controller, the core drain and
the boot check use it (``tools/wsl_case_procs.py`` is the CLI Node calls).

A process belongs to the case when

- its cwd is the case copy or below it (a folder removed under it still counts),
- a word of its command line names ``<case root>/<id>`` exactly (the next
  character is ``/``, a space, a quote or the end: ``run1`` never matches
  ``run10``), or
- a word of its command line is one of the run's scripts or ends in
  ``/<script>``.

So ``reconstructPar``, ``cp`` and ``mpirun`` working in the copy are seen, and no
``pgrep -x`` is used (``changeDictionary`` has 16 characters, more than a
process name holds). ``kill`` ends the script processes first, then the rest
(TERM, 1 s, KILL each time); with ``names`` only processes whose name is in the
list. The bash runs from ``/tmp`` under a name unique to the call, never from a
command line that names the case, and skips itself and its parent.

A WSL failure answers ``{"ok": false}`` (Node reads it as "unknown"). An id that
``start_solve`` would refuse answers "not live": nothing can run under it.
"""

from __future__ import annotations

import os
import re
import secrets
import shlex
import subprocess
from collections.abc import Iterable
from typing import Any

from cfddesk.runner.case_id import InvalidWslCaseId, validate_wsl_case_id
from cfddesk.wsl.config import get_wsl_case_root, get_wsl_distro
from cfddesk.wsl.foam_case import wsl_root_ok

SCRIPT_RE = re.compile(r"^(foam-pre|solve)-[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\.sh$")
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*$")
_MARK = "CASE_PROCS"
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

_SCRIPT = r"""#!/usr/bin/env bash
set -u
exec 2>/dev/null
ROOT=__ROOT__
NAME=__NAME__
MODE=__MODE__
SCRIPTS=(__SCRIPTS__)
NAMES=(__NAMES__)
CASE="$ROOT/$NAME"
CASE_REAL=$(readlink -f -- "$CASE" || echo "$CASE")
SELF=$$
PARENT=$PPID

# A word names the case copy: "$ROOT/$NAME" followed by /, a space, a quote or the end.
_names_case() {
  local rest="$1" seg
  while [[ "$rest" == *"$ROOT/"* ]]; do
    rest="${rest#*"$ROOT/"}"
    seg="${rest%%[/[:space:]\'\"]*}"
    [ "$seg" = "$NAME" ] && return 0
  done
  return 1
}

_is_script() {
  local w="$1" s
  for s in "${SCRIPTS[@]}"; do
    [ "$w" = "$s" ] && return 0
    case "$w" in */"$s") return 0 ;; esac
  done
  return 1
}

_in_case() {
  local cwd="${1% (deleted)}"
  [ -n "$cwd" ] || return 1
  [ "$cwd" = "$CASE" ] || [ "$cwd" = "$CASE_REAL" ] && return 0
  [[ "$cwd" == "$CASE"/* ]] || [[ "$cwd" == "$CASE_REAL"/* ]]
}

_name_ok() {
  [ "${#NAMES[@]}" -eq 0 ] && return 0
  local comm="$1" argv0="${2##*/}" n
  for n in "${NAMES[@]}"; do
    [ "$comm" = "${n:0:15}" ] && return 0
    [ "$argv0" = "$n" ] && return 0
  done
  return 1
}

# SCRIPT_PIDS and OTHER_PIDS: the case's processes, script ones apart.
_scan() {
  SCRIPT_PIDS=()
  OTHER_PIDS=()
  local d pid cwd word argv0 hit script comm
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    if [ "$pid" = "$SELF" ] || [ "$pid" = "$PARENT" ]; then continue; fi
    [ -r "$d/cmdline" ] || continue
    hit=0
    script=0
    argv0=""
    cwd=$(readlink "$d/cwd")
    _in_case "$cwd" && hit=1
    while IFS= read -r -d '' word; do
      [ -n "$argv0" ] || argv0="$word"
      if _is_script "$word"; then hit=1; script=1; fi
      if [ "$hit" -eq 0 ] && _names_case "$word"; then hit=1; fi
    done < "$d/cmdline"
    [ "$hit" -eq 1 ] || continue
    comm=$(cat "$d/comm")
    _name_ok "$comm" "$argv0" || continue
    if [ "$script" -eq 1 ]; then SCRIPT_PIDS+=("$pid"); else OTHER_PIDS+=("$pid"); fi
  done
}

_signal() {
  local sig="$1" pid
  shift
  for pid in "$@"; do kill "-$sig" "$pid" || true; done
}

if [ "$MODE" = "probe" ]; then
  _scan
  if [ "${#SCRIPT_PIDS[@]}" -gt 0 ] || [ "${#OTHER_PIDS[@]}" -gt 0 ]; then
    echo "CASE_PROCS live"
  else
    echo "CASE_PROCS dead"
  fi
  exit 0
fi

killed=0
# The run's scripts first, so nothing starts the next step meanwhile.
_scan
if [ "${#SCRIPT_PIDS[@]}" -gt 0 ]; then
  killed=$((killed + ${#SCRIPT_PIDS[@]}))
  _signal TERM "${SCRIPT_PIDS[@]}"
  sleep 1
  _scan
  [ "${#SCRIPT_PIDS[@]}" -eq 0 ] || _signal KILL "${SCRIPT_PIDS[@]}"
fi
# Then everything else in the case copy.
_scan
if [ "${#OTHER_PIDS[@]}" -gt 0 ]; then
  killed=$((killed + ${#OTHER_PIDS[@]}))
  _signal TERM "${OTHER_PIDS[@]}"
  sleep 1
  _scan
  [ "${#SCRIPT_PIDS[@]}" -eq 0 ] || _signal KILL "${SCRIPT_PIDS[@]}"
  [ "${#OTHER_PIDS[@]}" -eq 0 ] || _signal KILL "${OTHER_PIDS[@]}"
fi
echo "CASE_PROCS killed $killed"
"""


class CaseProcsError(ValueError):
    """Arguments the script must not take (a script or process name, the root)."""


def case_root(root: str | None = None) -> str | None:
    """The WSL case root to match under: ``root``, else ``MAGNUSIM_WSL_CASE_ROOT``,
    else the configured one; None when it fails the root rule."""
    value = root
    if value is None:
        value = (os.environ.get("MAGNUSIM_WSL_CASE_ROOT") or os.environ.get("CFDDESK_WSL_CASE_ROOT") or "").strip()
        if not value:
            value = get_wsl_case_root()
    return value if wsl_root_ok(value) else None


def render_script(*, root: str, wsl_case: str, mode: str, scripts: Iterable[str] = (), names: Iterable[str] = ()) -> str:
    """The bash for one probe or kill (LF). Every value is quoted; names are checked."""
    if mode not in ("probe", "kill"):
        raise CaseProcsError(f"mode must be probe or kill, not {mode!r}")
    if not wsl_root_ok(root):
        raise CaseProcsError("the WSL case root is not usable")
    script_list = [str(s) for s in scripts]
    name_list = [str(n) for n in names]
    for s in script_list:
        if not SCRIPT_RE.match(s):
            raise CaseProcsError(f"not a run script name: {s!r}")
    for n in name_list:
        if not NAME_RE.match(n):
            raise CaseProcsError(f"not a process name: {n!r}")
    values = {
        "ROOT": shlex.quote(root),
        "NAME": shlex.quote(validate_wsl_case_id(wsl_case)),
        "MODE": mode,
        "SCRIPTS": " ".join(shlex.quote(s) for s in script_list),
        "NAMES": " ".join(shlex.quote(n) for n in name_list),
    }
    return re.sub(r"__(ROOT|NAME|MODE|SCRIPTS|NAMES)__", lambda m: values[m.group(1)], _SCRIPT)


def remote_script_name() -> str:
    """Where the bash goes in WSL: unique to this call, so a probe and a kill of one
    case never overwrite or delete each other's script."""
    return f"/tmp/cfddesk-procs-{os.getpid()}-{secrets.token_hex(8)}.sh"


def run_script(text: str, *, timeout: float) -> str | None:
    """Run the bash in WSL from a /tmp file; its stdout, or None when WSL failed."""
    remote = shlex.quote(remote_script_name())
    cmd = f"cat > {remote} && bash {remote}; ec=$?; rm -f {remote}; exit $ec"
    argv = ["wsl", "-d", get_wsl_distro(), "-e", "bash", "-c", cmd]
    try:
        # Bytes: a text-mode pipe on Windows would turn the script's LF into CRLF.
        r = subprocess.run(
            argv,
            input=text.replace("\r\n", "\n").encode("utf-8"),
            capture_output=True,
            timeout=timeout,
            check=False,
            creationflags=_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return (r.stdout or b"").decode("utf-8", errors="replace")


def parse_output(text: str | None) -> dict[str, Any]:
    """The script's answer line, as the CLI prints it."""
    for line in reversed((text or "").splitlines()):
        words = line.strip().split()
        if len(words) >= 2 and words[0] == _MARK:
            if words[1] in ("live", "dead"):
                return {"ok": True, "live": words[1] == "live"}
            if words[1] == "killed" and len(words) == 3 and words[2].isdigit():
                return {"ok": True, "killed": int(words[2])}
    return {"ok": False}


def _prepared(
    wsl_case: str, mode: str, scripts: Iterable[str], names: Iterable[str], root: str | None
) -> tuple[str | None, dict[str, Any] | None]:
    """(script text, None) or (None, the answer to give at once)."""
    try:
        validate_wsl_case_id(wsl_case)
    except InvalidWslCaseId:
        empty: dict[str, Any] = {"ok": True, "invalid_id": True}
        empty.update({"live": False} if mode == "probe" else {"killed": 0})
        return None, empty
    where = case_root(root)
    if where is None:
        return None, {"ok": False, "error": "the WSL case root is not usable"}
    try:
        return render_script(root=where, wsl_case=wsl_case, mode=mode, scripts=scripts, names=names), None
    except CaseProcsError as exc:
        return None, {"ok": False, "error": str(exc)}


def probe(wsl_case: str, scripts: Iterable[str] = (), *, root: str | None = None, timeout: float = 12.0) -> dict[str, Any]:
    """``{"ok": true, "live": bool}``; ``{"ok": false}`` when WSL did not answer."""
    text, early = _prepared(wsl_case, "probe", scripts, (), root)
    if early is not None:
        return early
    assert text is not None
    return parse_output(run_script(text, timeout=timeout))


def kill(
    wsl_case: str,
    scripts: Iterable[str] = (),
    *,
    names: Iterable[str] | None = None,
    root: str | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """``{"ok": true, "killed": n}``: scripts first, then the rest (only ``names`` when given)."""
    text, early = _prepared(wsl_case, "kill", scripts, names or (), root)
    if early is not None:
        return early
    assert text is not None
    return parse_output(run_script(text, timeout=timeout))
