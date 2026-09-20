"""Render solve.sh, spawn WSL bash, stream JSONL job events (Phase 1 Step 5)."""
from __future__ import annotations

import json
import re
import shlex
import subprocess
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from cfddesk.jobs.events import EVENT_PREFIX, Event, parse_line
from cfddesk.runner.case_id import validate_wsl_case_id, wsl_case_path
from cfddesk.runner.parallel import kill_mpirun_tree
from cfddesk.wsl.config import get_wsl_distro
from cfddesk.wsl.mesh_run import windows_to_wsl_path
from cfddesk.wsl.openfoam import escape_wsl_bash_dollars, run_wsl_bash

# controlDict may be flush-left or indented; runTimeModifiable re-reads this.
WRITE_NOW_SED = r"s/^[[:space:]]*stopAt.*/stopAt          writeNow;/"

_TEMPLATES = Path(__file__).resolve().parent / "templates"
_SOLVE_SH = _TEMPLATES / "solve.sh"

_RE_TIME = re.compile(r"^Time\s*=\s*([0-9.+-eE]+)\s*$")
_RE_RESIDUAL = re.compile(
    r"Solving for (Ux|Uy|Uz|p|omega|k), Initial residual = ([0-9.eE+-]+)"
)
_RE_COURANT = re.compile(
    r"^Courant Number mean:\s*([0-9.eE+-]+)\s+max:\s*([0-9.eE+-]+)"
)
_RE_DELTAT = re.compile(r"^deltaT\s*=\s*([0-9.eE+-]+)")
_RE_MPI_PREFIX = re.compile(r"^\s*\[\d+\]\s*")


def solve_template_path() -> Path:
    return _SOLVE_SH


def render_solve_script(
    *,
    dst: str,
    win_out: str,
    n_procs: int,
    app: str,
    run_id: str,
) -> str:
    """Substitute placeholders in ``templates/solve.sh`` (LF, no BOM)."""
    raw = _SOLVE_SH.read_text(encoding="utf-8")
    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")
    n = max(1, int(n_procs))
    solver = "pimpleFoam" if app == "pimpleFoam" else "simpleFoam"
    text = (
        raw.replace("__DST__", str(dst))
        .replace("__WIN_OUT__", str(win_out))
        .replace("__NPROCS__", str(n))
        .replace("__APP__", solver)
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
) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = render_solve_script(
        dst=dst, win_out=win_out, n_procs=n_procs, app=app, run_id=run_id
    )
    path.write_bytes(body.encode("utf-8"))
    return path


@dataclass
class ProgressParser:
    """Port of w27 ``applyProgressLine`` + w30 ``transientProgressFromLine``."""

    stage: str = "starting"
    current: dict | None = None
    pending: dict = field(default_factory=dict)
    series: list[dict] = field(default_factory=list)
    saved_times: list[float] = field(default_factory=list)
    solve_started: bool = False

    def _enter_solve(self) -> None:
        if self.stage in ("starting", "decompose", "copy", ""):
            self.stage = "solve"

    def feed(self, raw: str) -> list[Event]:
        line = _RE_MPI_PREFIX.sub("", str(raw or ""))
        out: list[Event] = []

        # Prefer explicit protocol events from the bash template.
        ev = parse_line(line)
        if ev is not None:
            if ev.event == "stage":
                st = str(ev.fields.get("stage") or "")
                if st == "decompose":
                    self.stage = "decompose"
                elif st == "solve":
                    self.stage = "solve"
                elif st in ("reconstruct", "solve_end"):
                    self.stage = "reconstruct" if st == "reconstruct" else self.stage
                    if st == "solve_end":
                        self.stage = "reconstruct"
                elif st == "copy":
                    self.stage = "copy"
                elif st == "copy_to_wsl":
                    self.stage = "copy"
            if ev.event == "time_saved":
                t = ev.fields.get("t")
                try:
                    tf = float(t) if t is not None else None
                except (TypeError, ValueError):
                    tf = None
                if tf is not None and tf not in self.saved_times:
                    self.saved_times.append(tf)
                if tf is not None:
                    self._enter_solve()
            if ev.event in ("progress", "residual", "courant"):
                self._enter_solve()
            out.append(ev)
            return out

        # OpenFOAM progress lines → residual / courant / progress events
        tm = _RE_TIME.match(line)
        if tm:
            self._enter_solve()
            if self.stage != "solve":
                return out
            if self.current and isinstance(self.current.get("t"), (int, float)):
                self.series.append(dict(self.current))
            t = float(tm.group(1))
            prev = self.current or {}
            pend = self.pending or {}
            self.pending = {}
            self.current = {"t": t}
            for k in ("delta_t", "co_max", "co_mean"):
                if isinstance(pend.get(k), (int, float)):
                    self.current[k] = pend[k]
                elif isinstance(prev.get(k), (int, float)):
                    self.current[k] = prev[k]
            if not self.solve_started and t > 0:
                self.solve_started = True
            fields: dict[str, Any] = {"time": t, "sim_time": t}
            for k in ("delta_t", "co_max", "co_mean"):
                if k in self.current:
                    fields[k] = self.current[k]
            out.append(Event(event="progress", fields=fields))
            return out

        co = _RE_COURANT.match(line)
        if co:
            self._enter_solve()
            if self.stage == "solve":
                mean = float(co.group(1))
                mx = float(co.group(2))
                self.pending["co_mean"] = mean
                self.pending["co_max"] = mx
                out.append(
                    Event(event="courant", fields={"mean": mean, "max": mx})
                )
                return out
        dt = _RE_DELTAT.match(line)
        if dt:
            self._enter_solve()
            if self.stage == "solve":
                v = float(dt.group(1))
                self.pending["delta_t"] = v
                out.append(Event(event="courant", fields={"delta_t": v}))
                return out

        rm = _RE_RESIDUAL.search(line)
        if rm and self.current is not None:
            name, val_s = rm.group(1), rm.group(2)
            try:
                val = float(val_s)
            except ValueError:
                return out
            self.current[name] = val
            fields = {
                "time": self.current.get("t"),
                "field": name,
                "initial": val,
                "fields": {name: val},
            }
            out.append(Event(event="residual", fields=fields))
            return out

        # Pass through non-empty solver lines as log (skip blank)
        if line.strip():
            out.append(Event(event="log", fields={"line": line[:2000]}))
        return out

    def snapshot(self) -> dict:
        cur = self.current or {}
        residuals = []
        for s in self.series:
            residuals.append(dict(s))
        if cur and "t" in cur:
            residuals.append(dict(cur))
        return {
            "stage": self.stage,
            "iteration": cur.get("t"),
            "sim_time": cur.get("t"),
            "n_steps": len(self.series) + (1 if cur else 0),
            "residuals": residuals,
            "saved_times": list(self.saved_times),
            "co_max": cur.get("co_max"),
            "delta_t": cur.get("delta_t"),
        }


def start_solve(
    case_dir: Path,
    *,
    wsl_case_id: str,
    n_procs: int = 1,
    app: str = "simpleFoam",
    run_id: str = "run-1",
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
    if solve_is_live(wsl_case_id):
        kill_solve(wsl_case_id, run_id)
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
    )
    sh_wsl = windows_to_wsl_path(script_path)
    argv = ["wsl", "-d", get_wsl_distro(), "--", "bash", sh_wsl]
    return subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        encoding="utf-8",
        errors="replace",
    )


def iter_events(proc: subprocess.Popen, *, parser: ProgressParser | None = None) -> Iterator[Event]:
    """Yield protocol events from a running solve process."""
    progress = parser or ProgressParser()
    assert proc.stdout is not None
    for line in proc.stdout:
        yield from progress.feed(line.rstrip("\n"))


def events_from_lines(lines: list[str] | Iterator[str]) -> list[Event]:
    """Parse a captured log (unit tests / dry-run)."""
    progress = ProgressParser()
    out: list[Event] = []
    for line in lines:
        out.extend(progress.feed(line.rstrip("\n")))
    return out


def solve_is_live(wsl_case_id: str) -> bool:
    """True if mpirun / simpleFoam / pimpleFoam is still attached to this case."""
    validate_wsl_case_id(wsl_case_id)
    dest = wsl_case_path(wsl_case_id)
    inner = (
        f"CASE={shlex.quote(dest)}; "
        "for pid in $(pgrep -x pimpleFoam; pgrep -x simpleFoam; pgrep -x mpirun; true); do "
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
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    else:
        kill_solve(wsl_case_id)


def kill_solve(wsl_case_id: str, run_id: str | None = None) -> None:
    """Force-kill mpirun / simpleFoam / pimpleFoam for this WSL case."""
    validate_wsl_case_id(wsl_case_id)
    dest = wsl_case_path(wsl_case_id)
    kill_mpirun_tree(dest)
    # Also match pimpleFoam + historic cfddesk-w27-<runId> pattern.
    extra = []
    if run_id:
        extra.append(f"pkill -f {json.dumps('cfddesk-w27-' + str(run_id))} 2>/dev/null || true")
    extra.append(f"pkill -f {json.dumps('pimpleFoam.*' + dest)} 2>/dev/null || true")
    inner = "; ".join(extra) if extra else "true"
    subprocess.run(
        ["wsl", "-d", get_wsl_distro(), "--", "bash", "-lc", escape_wsl_bash_dollars(inner)],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )


def stream_events_to_stdout(proc: subprocess.Popen) -> tuple[int, ProgressParser]:
    """Relay events as ``MAGNUSIM_EVENT`` JSONL; return (exit_code, parser)."""
    parser = ProgressParser()
    for ev in iter_events(proc, parser=parser):
        # Re-emit with prefix so Node parse_line works uniformly.
        print(EVENT_PREFIX + ev.to_json(), flush=True)
    rc = proc.wait()
    return int(rc if rc is not None else -1), parser
