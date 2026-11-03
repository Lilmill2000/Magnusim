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
_PLACEHOLDERS = re.compile(r"__(DST|WIN_OUT|NPROCS|APP|KEEP_FRAMES|FRAME_FIELDS|RUN_ID|RESTART|REGIONS|ALL_REGIONS)__")


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
    restart: bool = False,
    regions: tuple[str, ...] | list[str] = (),
) -> str:
    """Substitute placeholders in ``templates/solve.sh`` (LF, no BOM), in one pass:
    an inserted value is never scanned again.

    ``app`` is the program the analysis's launch spec names; ``keep_frames``
    (``all`` | ``latest``) which result frames come back to Windows;
    ``frame_fields`` the fields whose files mark a written frame (the
    launch spec's); ``restart`` continues a run from its latest saved time
    (the saved times stay, a parallel run decomposes the latest only, the
    log so far is kept as log.<app>.N); ``regions`` a multi-region case's
    region names (its ``w27-case.json`` ``regions``; empty for one region).
    """
    from cfddesk.wsl.foam_case import regions_word_list

    _check_names(app)
    region_words = regions_word_list(regions)
    if keep_frames not in ("all", "latest"):
        raise ValueError(f"keep_frames must be 'all' or 'latest', got {keep_frames!r}")
    fields = [str(f) for f in frame_fields]
    if not fields or not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", f) for f in fields):
        raise ValueError(f"frame_fields must be plain field names, got {frame_fields!r}")
    raw = _SOLVE_SH.read_text(encoding="utf-8")
    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")
    n = max(1, int(n_procs))
    values = {
        "DST": str(dst),
        "WIN_OUT": str(win_out),
        "NPROCS": str(n),
        "APP": app,
        "KEEP_FRAMES": keep_frames,
        "FRAME_FIELDS": " ".join(fields),
        "RUN_ID": str(run_id),
        "RESTART": "1" if restart else "0",
        "REGIONS": region_words,
        # decomposePar / reconstructPar's flag for a multi-region case.
        "ALL_REGIONS": " -allRegions" if region_words else "",
    }
    text = _PLACEHOLDERS.sub(lambda m: values[m.group(1)], raw)
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
    restart: bool = False,
    regions: tuple[str, ...] | list[str] = (),
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
        restart=restart,
        regions=regions,
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
    restart: bool = False,
    regions: tuple[str, ...] = (),
) -> subprocess.Popen:
    """Render solve.sh and spawn ``wsl -d <distro> -- bash <script>``.

    The Windows case at ``case_dir`` is copied into WSL by the bash template
    (same as historic ``buildSolveScript``). Caller should have written the
    case (e.g. via ``prepare_run``) before calling. ``restart``: the case
    continues from its latest saved time; ``regions``: a multi-region case's
    regions (render_solve_script).
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
        restart=restart,
        regions=regions,
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


def job_event_of(line: str) -> dict[str, Any] | None:
    """A job-event line (``MAGNUSIM_EVENT {…}``, ``CFDDESK_EVENT {…}`` or a bare
    ``{"event": …}``) as the relay's ``parse_job_line`` reads it; None otherwise."""
    raw = str(line or "").strip()
    if not raw or ("EVENT " not in raw and not raw.startswith(("{", "["))):
        return None
    if raw.startswith("[") and 0 < raw.find("]") < 8:
        raw = raw[raw.find("]") + 1 :].strip()
    payload = None
    for prefix in ("MAGNUSIM_EVENT ", "CFDDESK_EVENT "):
        if raw.startswith(prefix):
            payload = raw[len(prefix) :].strip()
            break
    if payload is None and raw.startswith("{") and '"event"' in raw:
        payload = raw
    if not payload:
        return None
    try:
        data = json.loads(payload)
    except ValueError:
        return None
    if not isinstance(data, dict) or not data.get("event"):
        return None
    return data


class SolverLogCounter:
    """Which lines of the solve's output are the solver's own (the ones ``tee`` writes to
    ``log.<app>``) and the byte offset of each in the run's whole log (spec 2.3 "Log offsets").

    - Counting starts at the ``stage`` event ``solve``, at ``log_base`` (the earlier parts'
      size: a number, or a function read at that moment). Lines before it (the copy in,
      decomposePar's output) are not the solver's.
    - Every event line is skipped (``time_saved`` and ``log`` events come between solver lines).
    - A solver line's offset is the running count; the count then grows by its UTF-8 length + 1.
    - The next ``stage`` event (``solve_end``, ``reconstruct``) ends the span.

    Known drift: the pipe is read as text with ``errors="replace"`` and universal newlines, so
    an invalid byte, a CR, or an event line written into the middle of a solver line shifts
    later offsets by a few bytes; the solver-log route then finds the line by its key.
    """

    def __init__(self, log_base: int | Callable[[], int] = 0) -> None:
        self._base = log_base
        self.active = False
        self.done = False
        self.at = 0
        self.last_event: dict[str, Any] | None = None

    def feed(self, line: str) -> int | None:
        """The line's offset when it is a solver line, else None (``last_event``: its event)."""
        ev = job_event_of(line)
        self.last_event = ev
        if ev is not None:
            if ev.get("event") == "stage":
                stage = str(ev.get("stage") or "")
                if stage == "solve" and not self.active and not self.done:
                    self.active = True
                    base = self._base
                    try:
                        self.at = int(base() if callable(base) else base)
                    except Exception:
                        self.at = 0
                elif self.active:
                    self.active = False
                    self.done = True
            return None
        if not self.active:
            return None
        at = self.at
        self.at += len(line.encode("utf-8", errors="replace")) + 1
        return at


def stream_events_to_stdout(
    proc: subprocess.Popen,
    parser: Any = None,
    *,
    on_line: Callable[[str, list[Event]], None] | None = None,
    out: LineOut | None = None,
    health: Any = None,
    log_base: int | Callable[[], int] = 0,
) -> tuple[int, Any]:
    """Relay events as ``MAGNUSIM_EVENT`` JSONL; return (exit_code, parser).

    ``parser`` is the analysis's log parser (its launch spec names it);
    :class:`GenericParser` when none is given. ``on_line(line, events)`` sees
    every line (solve hooks queue it and return at once); ``out`` is where the
    events go (default stdout).

    ``health`` (a :class:`magnusim_sdk.health.HealthTracker`, RH1) sees each solver line,
    with its offset in the run's whole log (:class:`SolverLogCounter`, from ``log_base``),
    before ``parser.feed``; ``health`` events go out with the parser's (at once on a verdict
    change, at most every 15 s on a change of its checks, every 60 s, and once at the end).
    The parser's optional ``health_advice(report, hints)`` replaces the words and fixes.
    """
    parser = parser if parser is not None else GenericParser()
    if on_line is None and out is None and health is None:
        for ev in iter_events(proc, parser=parser):
            # Re-emit with prefix so Node parse_line works uniformly.
            print(EVENT_PREFIX + ev.to_json(), flush=True)
        rc = proc.wait()
        return int(rc if rc is not None else -1), parser
    emitter = None
    counter = None
    if health is not None:
        from magnusim_sdk.health import HealthEmitter

        emitter = HealthEmitter(health, advice=getattr(parser, "health_advice", None))
        counter = SolverLogCounter(log_base)

    def send(evs: list[Event]) -> None:
        if not evs:
            return
        if out is None:
            for ev in evs:
                print(EVENT_PREFIX + ev.to_json(), flush=True)
        else:
            _write_events(out, evs)

    assert proc.stdout is not None
    for line in proc.stdout:
        text = line.rstrip("\n")
        if counter is not None:
            _health_line(counter, health, text)
        evs = parser.feed(text)
        _tell_line(on_line, line, evs)
        if emitter is not None:
            for ev in evs:
                if ev.event == "converged":
                    health.converged()
            payload = _health_poll(emitter)
            if payload is not None:
                evs = [*evs, _health_event(payload)]
        send(evs)
    rc = proc.wait()
    if emitter is not None:
        try:
            final = emitter.final()
        except Exception:
            final = None
        if final is not None:
            send([_health_event(final)])
    return int(rc if rc is not None else -1), parser


def _health_event(payload: dict[str, Any]) -> Event:
    return Event(event="health", fields={k: v for k, v in payload.items() if k != "event"})


def _health_line(counter: SolverLogCounter, health: Any, text: str) -> None:
    """One output line to the tracker when it is the solver's; a saved time is noted."""
    try:
        at = counter.feed(text)
        if at is not None:
            health.line(text, at)
        elif counter.last_event is not None and counter.last_event.get("event") == "time_saved":
            t = counter.last_event.get("t")
            if isinstance(t, (int, float)) and not isinstance(t, bool):
                health.saved(float(t))
    except Exception:
        # Health never stops a solve.
        pass


def _health_poll(emitter: Any) -> dict[str, Any] | None:
    try:
        payload = emitter.poll()
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None
