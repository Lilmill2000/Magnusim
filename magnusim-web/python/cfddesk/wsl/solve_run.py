"""Render solve.sh, spawn WSL bash, stream JSONL job events (Phase 1 Step 5)."""
from __future__ import annotations

import json
import re
import shlex
import subprocess
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, Protocol

from magnusim_sdk.progress import ProgressParser as GenericParser
from magnusim_sdk.progress import parse_extra_line, parse_residual_line  # noqa: F401

from cfddesk.jobs.events import EVENT_PREFIX, Event
from cfddesk.runner.case_id import validate_wsl_case_id, wsl_case_path
from cfddesk.runner.parallel import kill_mpirun_tree
from cfddesk.wsl.config import get_wsl_distro
from cfddesk.wsl.mesh_run import windows_to_wsl_path
from cfddesk.wsl.openfoam import escape_wsl_bash_dollars, run_wsl_bash

# controlDict may be flush-left or indented; runTimeModifiable re-reads this.
WRITE_NOW_SED = r"s/^[[:space:]]*stopAt.*/stopAt          writeNow;/"

_TEMPLATES = Path(__file__).resolve().parent / "templates"
_SOLVE_SH = _TEMPLATES / "solve.sh"


class LineOut(Protocol):
    """Where events go when not to stdout (a text stream, or the solve hooks' event stream)."""

    def write(self, text: str, /) -> int: ...

    def flush(self) -> None: ...


# solve.sh stage that starts each timed phase; any later stage/result ends it.


# Any solver's residual line (GenericParser): the field is whatever it solves for.


def solve_template_path() -> Path:
    return _SOLVE_SH


# Runs recorded before launch specs (H8) name no processes: these were the
# only solver apps then.
LEGACY_PROCESS_NAMES = ("simpleFoam", "pimpleFoam")


def _check_names(app: str, process_names: tuple[str, ...] | list[str] | None = None) -> None:
    from cfddesk.registry.contract import APP_NAME_RE

    for name in (app, *(process_names or ())):
        if not APP_NAME_RE.match(str(name or "")):
            raise ValueError(f"not a plain program name: {name!r}")


def render_solve_script(
    *,
    dst: str,
    win_out: str,
    n_procs: int,
    app: str,
    run_id: str,
    keep_frames: str = "latest",
    frame_fields: tuple[str, ...] | list[str],
) -> str:
    """Substitute placeholders in ``templates/solve.sh`` (LF, no BOM).

    ``app`` is the program the analysis's launch spec names; ``keep_frames``
    (``all`` | ``latest``) which result frames come back to Windows;
    ``frame_fields`` the fields whose files mark a written frame (the
    launch spec's).
    """
    _check_names(app)
    if keep_frames not in ("all", "latest"):
        raise ValueError(f"keep_frames must be 'all' or 'latest', got {keep_frames!r}")
    fields = [str(f) for f in frame_fields]
    if not fields or not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", f) for f in fields):
        raise ValueError(f"frame_fields must be plain field names, got {frame_fields!r}")
    raw = _SOLVE_SH.read_text(encoding="utf-8")
    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")
    n = max(1, int(n_procs))
    text = (
        raw.replace("__DST__", str(dst))
        .replace("__WIN_OUT__", str(win_out))
        .replace("__NPROCS__", str(n))
        .replace("__APP__", app)
        .replace("__KEEP_FRAMES__", keep_frames)
        .replace("__FRAME_FIELDS__", " ".join(fields))
        .replace("__RUN_ID__", str(run_id))
    )
    return text.replace("\r\n", "\n").replace("\r", "\n")


def write_solve_script(
    path: Path,
    *,
    dst: str,
    win_out: str,
    n_procs: int,
    app: str,
    run_id: str,
    keep_frames: str = "latest",
    frame_fields: tuple[str, ...] | list[str],
) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = render_solve_script(
        dst=dst,
        win_out=win_out,
        n_procs=n_procs,
        app=app,
        run_id=run_id,
        keep_frames=keep_frames,
        frame_fields=frame_fields,
    )
    path.write_bytes(body.encode("utf-8"))
    return path


def start_solve(
    case_dir: Path,
    *,
    wsl_case_id: str,
    n_procs: int = 1,
    app: str,
    run_id: str = "run-1",
    keep_frames: str = "latest",
    process_names: tuple[str, ...] | None = None,
    frame_fields: tuple[str, ...],
    script_path: Path | None = None,
) -> subprocess.Popen:
    """Render solve.sh and spawn ``wsl -d <distro> -- bash <script>``.

    The Windows case at ``case_dir`` is copied into WSL by the bash template
    (same as historic ``buildSolveScript``). Caller should have written the
    case (e.g. via ``prepare_run``) before calling.
    """
    case_dir = Path(case_dir).resolve()
    if not case_dir.is_dir():
        raise FileNotFoundError(f"case_dir not found: {case_dir}")
    validate_wsl_case_id(wsl_case_id)
    # A dead Windows wrapper used to leave pimpleFoam running; Start then
    # spawned a second mpirun on the same case. Kill that leftover first.
    names = tuple(process_names or (app,))
    _check_names(app, names)
    if solve_is_live(wsl_case_id, names):
        kill_solve(wsl_case_id, run_id, names)
    dst = wsl_case_path(wsl_case_id)
    win_out = windows_to_wsl_path(case_dir)
    if script_path is None:
        td = Path(tempfile.mkdtemp(prefix="cfddesk-solve-"))
        script_path = td / f"solve-{run_id}.sh"
    write_solve_script(
        script_path,
        dst=dst,
        win_out=win_out,
        n_procs=n_procs,
        app=app,
        run_id=run_id,
        keep_frames=keep_frames,
        frame_fields=frame_fields,
    )
    sh_wsl = windows_to_wsl_path(script_path)
    argv = ["wsl", "-d", get_wsl_distro(), "--", "bash", sh_wsl]
    return subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,  # never the caller's stdin: wsl.exe would read it (the worker's request pipe)
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        encoding="utf-8",
        errors="replace",
    )


def iter_events(proc: subprocess.Popen, *, parser: Any = None) -> Iterator[Event]:
    """Yield protocol events from a running solve process."""
    progress = parser or GenericParser()
    assert proc.stdout is not None
    for line in proc.stdout:
        yield from progress.feed(line.rstrip("\n"))


def events_from_lines(
    lines: list[str] | Iterator[str],
    *,
    on_line: Callable[[str, list[Event]], None] | None = None,
    out: LineOut | None = None,
) -> list[Event]:
    """Parse a captured log (unit tests / dry-run).

    ``on_line(line, events)`` sees each line and what it parsed to (solve hooks);
    with ``out`` each event is also written there as a ``MAGNUSIM_EVENT`` line.
    """
    progress = GenericParser()
    found: list[Event] = []
    for line in lines:
        evs = progress.feed(line.rstrip("\n"))
        found.extend(evs)
        _tell_line(on_line, line, evs)
        if out is not None:
            _write_events(out, evs)
    return found


def _tell_line(on_line: Callable[[str, list[Event]], None] | None, line: str, evs: list[Event]) -> None:
    """Hand one line to ``on_line``; whatever it raises never reaches the solve."""
    if on_line is None:
        return
    try:
        on_line(line.rstrip("\n"), evs)
    except Exception:
        pass


def _write_events(out: LineOut, evs: list[Event]) -> None:
    for ev in evs:
        out.write(EVENT_PREFIX + ev.to_json() + "\n")
    if evs:
        out.flush()


def solve_is_live(wsl_case_id: str, process_names: tuple[str, ...] | None = None) -> bool:
    """True if mpirun or one of the run's solver processes is still attached to this case."""
    validate_wsl_case_id(wsl_case_id)
    names = tuple(process_names or LEGACY_PROCESS_NAMES)
    _check_names(names[0], names)
    dest = wsl_case_path(wsl_case_id)
    pgreps = "; ".join(f"pgrep -x {n}" for n in (*names, "mpirun"))
    inner = (
        f"CASE={shlex.quote(dest)}; "
        f"for pid in $({pgreps}; true); do "
        '[ -d "/proc/$pid" ] || continue; '
        'cmd=$(tr "\\0" " " < /proc/$pid/cmdline 2>/dev/null || true); '
        'echo "$cmd" | grep -Eq "reconstructPar|live-frames|cfddesk-kill" && continue; '
        'cwd=$(readlink -f /proc/$pid/cwd 2>/dev/null || true); '
        'if [ "$cwd" = "$CASE" ] || echo "$cmd" | grep -Fq "$CASE"; then echo LIVE; exit 0; fi; '
        "done; echo DEAD"
    )
    r = run_wsl_bash(inner, timeout=8.0)
    return "LIVE" in ((r.stdout or "") + (r.stderr or ""))


def stop_solve(wsl_case_id: str, *, graceful: bool = True) -> None:
    """Ask the solver to stopAt writeNow (graceful) or force-kill."""
    validate_wsl_case_id(wsl_case_id)
    dest = wsl_case_path(wsl_case_id)
    if graceful:
        inner = (
            f"sed -i {shlex.quote(WRITE_NOW_SED)} "
            f"{json.dumps(dest + '/system/controlDict')} 2>/dev/null || true"
        )
        subprocess.run(
            [
                "wsl",
                "-d",
                get_wsl_distro(),
                "--",
                "bash",
                "-lc",
                escape_wsl_bash_dollars(inner),
            ],
            stdin=subprocess.DEVNULL,  # never the caller's stdin: wsl.exe would read it (the worker's request pipe)
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    else:
        kill_solve(wsl_case_id)


def kill_solve(
    wsl_case_id: str, run_id: str | None = None, process_names: tuple[str, ...] | None = None
) -> None:
    """Force-kill mpirun and the run's solver processes for this WSL case."""
    validate_wsl_case_id(wsl_case_id)
    names = tuple(process_names or LEGACY_PROCESS_NAMES)
    _check_names(names[0], names)
    dest = wsl_case_path(wsl_case_id)
    kill_mpirun_tree(dest, names)
    # Also match the historic cfddesk-w27-<runId> pattern.
    extra = []
    if run_id:
        extra.append(f"pkill -f {json.dumps('cfddesk-w27-' + str(run_id))} 2>/dev/null || true")
    for name in names:
        extra.append(f"pkill -f {json.dumps(name + '.*' + dest)} 2>/dev/null || true")
    inner = "; ".join(extra) if extra else "true"
    subprocess.run(
        ["wsl", "-d", get_wsl_distro(), "--", "bash", "-lc", escape_wsl_bash_dollars(inner)],
        stdin=subprocess.DEVNULL,  # never the caller's stdin: wsl.exe would read it (the worker's request pipe)
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )


def stream_events_to_stdout(
    proc: subprocess.Popen,
    parser: Any = None,
    *,
    on_line: Callable[[str, list[Event]], None] | None = None,
    out: LineOut | None = None,
) -> tuple[int, Any]:
    """Relay events as ``MAGNUSIM_EVENT`` JSONL; return (exit_code, parser).

    ``parser`` is the analysis's log parser (its launch spec names it);
    :class:`GenericParser` when none is given. ``on_line(line, events)`` sees
    every line (solve hooks queue it and return at once); ``out`` is where the
    events go (default stdout).
    """
    parser = parser if parser is not None else GenericParser()
    if on_line is None and out is None:
        for ev in iter_events(proc, parser=parser):
            # Re-emit with prefix so Node parse_line works uniformly.
            print(EVENT_PREFIX + ev.to_json(), flush=True)
    else:
        assert proc.stdout is not None
        for line in proc.stdout:
            evs = parser.feed(line.rstrip("\n"))
            _tell_line(on_line, line, evs)
            if out is None:
                for ev in evs:
                    print(EVENT_PREFIX + ev.to_json(), flush=True)
            else:
                _write_events(out, evs)
    rc = proc.wait()
    return int(rc if rc is not None else -1), parser
