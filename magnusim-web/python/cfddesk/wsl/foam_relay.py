"""The foam relay: one run of the step-list runner (API 1.3).

``tools/run_foam_case.py`` is its CLI. Node writes a spec file
(``.cache/foam-specs/<job_id>.json``) and starts ``run_foam_case.py --launch``, a
hidden starter that starts the relay out of the app's process tree and exits.
The relay trusts nothing in the spec. In order:

1. **Gate**, before any ``wsl`` call and before the prepare step: the spec's
   shape and ids, the case's real path (inside its project; a plugin case in
   that plugin's folder), the app and field names, the step table and its
   parallel spans, the prepare step (resolved from the registry: the owning
   plugin's own JobKind tool, on the core interpreter or that plugin's ready
   environment, never another program), the WSL path rules (the case, the temp
   folder, the WSL root), then the case check (only its path part when a
   prepare step will write the case). A refusal: one ``refused`` event, a final
   status with ``outcome {phase: 'gate'}``, ``relay_end``, exit 2.
2. The status file thread (``<case>/.magnusim-run.json``, every 2 s), the stop
   controller (``<case>/.magnusim-stop``, every 1 s) and, with hook names, the
   solve hook runner.
3. ``.magnusim-stop`` already there: stopped, exit 130.
4. ``<case>/.magnusim-ran``: from here the folder cannot run again.
5. The prepare step (when set): output to ``log.prepare``; its ``stage`` lines
   become ``prepare_stage`` events and nothing else of it reaches the events.
6. After it: the full case check on what it wrote.
7. Ranks, only when a parallel step or a parallel solver will run: WSL's MPI
   slots clamp ``n_procs`` (``slots_hint`` when WSL does not say).
8. ``n > 1``: the host writes ``system/decomposeParDict``.
9. The WSL steps (``foam_pre.sh``, ``wsl -e``). Without a solver a clean run ends
   here and the relay removes the WSL copy.
10. - 12. The marker check, ``solve.prepare``, the solve (``start_solve``,
    ``solve.sh``, unchanged).
13. ``clean``: solve.sh's ``result`` was seen, nothing reached WSL, or the case's
    processes were seen gone twice (60 s at most, then ``verified_gone``).
14. The final status and ``relay_end``.

Exit codes are for logs only (Node reads ``outcome``): 0 done, 2 refused, 3
the starter failed, 130 stopped before the solve, 50 a WSL step wrote a time
folder, else the prepare tool's, the WSL step's or ``solve.sh``'s own code.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cfddesk.jobs.events import EVENT_PREFIX
from cfddesk.registry.contract import APP_NAME_RE
from cfddesk.wsl import case_procs
from cfddesk.wsl.config import get_wsl_distro
from cfddesk.wsl.foam_case import (
    RAN_MARKER,
    ROOT_UNUSABLE,
    STATUS_FILE,
    STOP_MARKER,
    FoamCaseError,
    check_case_local,
    check_case_paths,
    check_steps,
    field_name_ok,
    foam_pre_script_name,
    has_parallel_step,
    is_link,
    plugin_case_id_ok,
    render_foam_pre,
    temp_path_problem,
    wsl_root_ok,
)

JOB_ID_RE = re.compile(r"^fc-[a-z0-9]{6,12}-[0-9a-f]{6}$")
PLUGIN_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
PREPARE_JOB_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$")
STAGE_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
PREPARE_ENV_KEYS = frozenset(
    {
        "MAGNUSIM_PLUGIN_KEY",
        "MAGNUSIM_JOB_ID",
        "MAGNUSIM_PROJECT_ID",
        "MAGNUSIM_PROJECT_DIR",
        "MAGNUSIM_SIMULATION_ID",
        "MAGNUSIM_GEOMETRY_ID",
        "MAGNUSIM_CASE_DIR",
    }
)
SPECS_FOLDER = "foam-specs"
SPEC_MAX_BYTES = 256 * 1024
MAX_PREPARE_ARGS = 32
MAX_VALUE = 4096
MAX_PROCS = 64
LOG_LINE_MAX = 500
SOLVE_HOOKS = ("solve.prepare", "solve.parse_line", "solve.stop")
STOP_STRATEGIES = ("stopAt_writeNow", "sigterm")

EXIT_DONE = 0
EXIT_REFUSED = 2
EXIT_LAUNCH = 3
EXIT_STOPPED = 130

CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000

NOT_ITS_JOB = "The prepare step is not one this plugin can run"
LAUNCH_FAILED = "The case could not start"

LEVELS = ("graceful", "solver", "all")
PREPARE_STAGES = frozenset({"prepare"})
SOLVE_STAGES = frozenset({"solve"})
AFTER_SOLVE_STAGES = frozenset({"reconstruct", "solve_end", "copy", "cleanup"})


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _no_window() -> int:
    return CREATE_NO_WINDOW if sys.platform == "win32" else 0


class RefusalError(Exception):
    """A gate refusal: ``code`` and its fixed text."""

    def __init__(self, code: str, error: str) -> None:
        super().__init__(error)
        self.code = code
        self.error = error


# ---------------------------------------------------------------------------
# Event lines
# ---------------------------------------------------------------------------


def parse_job_line(line: str) -> dict[str, Any] | None:
    """A job-event line (``MAGNUSIM_EVENT {…}``, ``CFDDESK_EVENT {…}`` or a bare
    ``{"event": …}``), as Node's ``parseJobLine`` reads it; None otherwise."""
    raw = str(line or "").strip()
    if not raw:
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


class EventWriter:
    """The relay's event stream. Every event is seen by ``on_event`` first. A write
    that fails (``OSError``, ``ValueError``) sets ``stdout_lost`` and drops later
    writes: the relay keeps reading WSL, so ``solve.sh`` never sees a broken pipe."""

    def __init__(self, stream: Any, on_event: Callable[[dict[str, Any]], None] | None = None) -> None:
        self._stream = stream
        self._lock = threading.Lock()
        self._buf = ""
        self._lost = False
        self.on_event = on_event

    @property
    def stdout_lost(self) -> bool:
        return self._lost or bool(getattr(self._stream, "lost", False))

    def set_stream(self, stream: Any) -> None:
        with self._lock:
            self._stream = stream

    def _put(self, text: str) -> None:
        with self._lock:
            if self._lost:
                return
            try:
                self._stream.write(text)
                self._stream.flush()
            except (OSError, ValueError):
                self._lost = True

    def _seen(self, ev: dict[str, Any]) -> None:
        if self.on_event is not None:
            try:
                self.on_event(ev)
            except Exception:
                pass

    def emit(self, ev: dict[str, Any]) -> None:
        self._seen(ev)
        self._put(EVENT_PREFIX + json.dumps(ev, separators=(",", ":"), ensure_ascii=False) + "\n")

    def write(self, text: str) -> int:
        """Event lines from ``stream_events_to_stdout`` (``out``): seen, then passed on,
        except the solver's own lines (``log`` events). Node has no use for them, they
        are in ``log.<app>`` in the case, and a fast solver prints several a time step
        (one job log row each kept the app from answering)."""
        self._buf += str(text)
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            ev = parse_job_line(line)
            if ev is not None:
                self._seen(ev)
                if ev.get("event") == "log":
                    continue
            if line.strip():
                self._put(line + "\n")
        return len(text)

    def flush(self) -> None:
        return None

    def log(self, text: str) -> None:
        self.emit({"event": "log", "line": str(text)[:LOG_LINE_MAX]})


# ---------------------------------------------------------------------------
# State and the status file
# ---------------------------------------------------------------------------


class RelayState:
    """What the status file says (§7.3), fed by every event the relay passes on."""

    def __init__(self, job_id: str, token: str) -> None:
        self.lock = threading.Lock()
        self.job_id = job_id
        self.token = token
        self.relay_pid = os.getpid()
        self.started_at = _now_iso()
        self.stage: str | None = None
        self.prepare: dict[str, Any] | None = None
        self.time: float | None = None
        self.n_steps = 0
        self.saved: list[float] = []
        self.n_saved = 0
        self.n_procs = 1
        self.wsl_reached = False
        self.pre_ok = False
        self.cleanup_seen = False
        self.result_ok = False
        self.result_seen = False
        self.stop: dict[str, Any] | None = None
        self.stdout_lost = False
        self.final: dict[str, Any] = {}
        self.stage_listener: Callable[[str], None] | None = None

    def observe(self, ev: dict[str, Any]) -> None:
        kind = ev.get("event")
        stage: str | None = None
        with self.lock:
            if kind == "stage":
                stage = str(ev.get("stage") or "")
                self.stage = stage
                if stage == "cleanup":
                    self.cleanup_seen = True
            elif kind == "pre":
                stage = "pre"
                self.stage = stage
            elif kind == "progress":
                t = ev.get("time")
                if isinstance(t, (int, float)) and not isinstance(t, bool):
                    self.time = float(t)
                self.n_steps += 1
            elif kind == "time_saved":
                t = ev.get("t")
                if isinstance(t, (int, float)) and not isinstance(t, bool):
                    self.saved = (self.saved + [float(t)])[-50:]
                    self.n_saved += 1
            elif kind == "result":
                self.result_seen = True
                self.result_ok = bool(ev.get("ok"))
            elif kind == "pre_result":
                self.pre_ok = bool(ev.get("ok"))
        if stage is not None and self.stage_listener is not None:
            self.stage_listener(stage)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            doc: dict[str, Any] = {
                "job_id": self.job_id,
                "token": self.token,
                "relay_pid": self.relay_pid,
                "started_at": self.started_at,
                "updated_at": _now_iso(),
                "stage": self.stage,
                "prepare": dict(self.prepare) if self.prepare else None,
                "time": self.time,
                "n_steps": self.n_steps,
                "saved": list(self.saved),
                "n_saved": self.n_saved,
                "n_procs": self.n_procs,
                "wsl_reached": self.wsl_reached,
                "pre_ok": self.pre_ok,
                "cleanup_seen": self.cleanup_seen,
                "result_ok": self.result_ok,
                "stop": json.loads(json.dumps(self.stop)) if self.stop else None,
                "stdout_lost": self.stdout_lost,
            }
            doc.update(self.final)
        return doc


def replace_retrying(tmp: Path, target: Path, *, tries: int = 5, wait: float = 0.05) -> bool:
    """``os.replace`` with retries while Windows holds the target (a reader)."""
    for attempt in range(tries + 1):
        try:
            os.replace(tmp, target)
            return True
        except PermissionError:
            if attempt >= tries:
                return False
            time.sleep(wait)
    return False


class StatusWriter:
    """Writes ``<case>/.magnusim-run.json`` every 2 s and at the end, atomically. A
    write that fails is skipped; it never ends the relay."""

    def __init__(self, path: Path, state: RelayState, *, every: float = 2.0) -> None:
        self.path = path
        self.state = state
        self.every = every
        self._lock = threading.Lock()
        self._halt = threading.Event()
        self._thread: threading.Thread | None = None

    def write_now(self) -> bool:
        with self._lock:
            tmp = self.path.with_name(STATUS_FILE + ".part")
            try:
                tmp.write_text(json.dumps(self.state.snapshot(), indent=1), encoding="utf-8")
            except OSError:
                return False
            if replace_retrying(tmp, self.path):
                return True
            try:
                tmp.unlink()
            except OSError:
                pass
            return False

    def _loop(self) -> None:
        while not self._halt.wait(self.every):
            self.write_now()

    def start(self) -> None:
        self.write_now()
        self._thread = threading.Thread(target=self._loop, name="foam-status", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._halt.set()
        if self._thread is not None:
            self._thread.join(5.0)
        self.write_now()


# ---------------------------------------------------------------------------
# The stop controller (§7.2)
# ---------------------------------------------------------------------------


def stage_class(stage: str | None) -> str:
    if stage in PREPARE_STAGES:
        return "prepare"
    if stage in SOLVE_STAGES:
        return "solve"
    if stage in AFTER_SOLVE_STAGES:
        return "after"
    return "before"


def read_marker_level(path: Path) -> str | None:
    """The level a ``.magnusim-stop`` asks for; None when there is no marker. A marker
    that cannot be read is a graceful stop."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        return "graceful" if path.exists() else None
    try:
        level = json.loads(text).get("level")
    except (ValueError, AttributeError):
        return "graceful"
    return level if level in LEVELS else "graceful"


def kill_process_tree(pid: int, *, wait: float = 2.0) -> int:
    """End a process and every child (TERM, ``wait`` s, KILL). How many were signalled."""
    import psutil

    try:
        root = psutil.Process(int(pid))
        procs = [*root.children(recursive=True), root]
    except psutil.Error:
        return 0
    for p in procs:
        try:
            p.terminate()
        except psutil.Error:
            pass
    _gone, alive = psutil.wait_procs(procs, timeout=wait)
    for p in alive:
        try:
            p.kill()
        except psutil.Error:
            pass
    return len(procs)


class StopController:
    """Applies ``.magnusim-stop`` by stage (§7.2). Levels only go up. While a marker
    exists, each new stage applies the rule again at the current level. Its own
    timers (writeNow → solver after 20 s; after the solve → all after 120 s) keep
    running while Node restarts. Never ``kill_solve``, ``kill_mpirun_tree`` or
    ``solve_is_live``: those match by prefix; :mod:`case_procs` matches exactly."""

    def __init__(
        self,
        *,
        marker: Path,
        wsl_case: str,
        scripts: list[str],
        process_names: list[str],
        stop_strategy: str | None,
        root: str,
        kill_case: Callable[..., Any],
        write_now: Callable[..., Any],
        kill_prepare: Callable[[int], Any],
        prepare_pid: Callable[[], int | None],
        wsl_reached: Callable[[], bool],
        on_change: Callable[[dict[str, Any]], None],
        notify: Callable[[bool], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        graceful_seconds: float = 20.0,
        after_seconds: float = 120.0,
        every: float = 1.0,
    ) -> None:
        self.marker = marker
        self.wsl_case = wsl_case
        self.scripts = list(scripts)
        self.process_names = list(process_names)
        self.stop_strategy = stop_strategy
        self.root = root
        self._kill_case = kill_case
        self._write_now = write_now
        self._kill_prepare = kill_prepare
        self._prepare_pid = prepare_pid
        self._wsl_reached = wsl_reached
        self._on_change = on_change
        self._notify = notify
        self._clock = clock
        self.graceful_seconds = graceful_seconds
        self.after_seconds = after_seconds
        self.every = every
        self.level: str | None = None
        self.stage: str | None = None
        self.applied: list[dict[str, Any]] = []
        self._done: set[tuple[str | None, str]] = set()
        self._graceful_at: float | None = None
        self._after_at: float | None = None
        self._lock = threading.Lock()
        self._act = threading.Lock()
        self._wake = threading.Event()
        self._halt = threading.Event()
        self._thread: threading.Thread | None = None

    def record(self) -> dict[str, Any] | None:
        if self.level is None:
            return None
        return {"level": self.level, "applied": [dict(a) for a in self.applied]}

    def set_stage(self, stage: str | None) -> None:
        """A new stage from the events: the thread applies the rule again at once."""
        with self._lock:
            self.stage = stage
        self._wake.set()

    def _raise(self, level: str) -> None:
        if self.level is None or LEVELS.index(level) > LEVELS.index(self.level):
            self.level = level

    def _plan(self) -> list[tuple[str, Callable[[], Any], bool]]:
        """Under the lock: the actions due now as (name, call, forced)."""
        level = self.level
        stage = self.stage
        if level is None:
            return []
        key = (stage, level)
        if key in self._done:
            return []
        cls = stage_class(stage)
        scripts = list(self.scripts)
        if cls == "prepare":
            pid = self._prepare_pid()
            if pid is None:
                # Not started yet (or already ended): the next tick looks again.
                return []
            self._done.add(key)
            return [("kill_prepare", lambda: self._kill_prepare(pid), True)]
        if level == "all" or cls == "before":
            if not self._wsl_reached():
                # Nothing in WSL yet; the next stage applies the rule again.
                return []
            self._done.add(key)
            return [("kill_case", lambda: self._kill_case(self.wsl_case, scripts, root=self.root), True)]
        if cls == "solve":
            self._done.add(key)
            if level == "graceful" and self.stop_strategy == "stopAt_writeNow":
                if self._graceful_at is None:
                    self._graceful_at = self._clock()
                return [("write_now", lambda: self._write_now(self.wsl_case, graceful=True), False)]
            names = [*self.process_names, "mpirun"]
            return [("kill_solver", lambda: self._kill_case(self.wsl_case, [], names=names, root=self.root), True)]
        # After the solve, below "all": solve.sh still copies back what was saved.
        self._done.add(key)
        if self._after_at is None:
            self._after_at = self._clock()
        return [("wait", lambda: None, False)]

    def tick(self) -> list[str]:
        """Read the marker, run the timers and apply what is due. The actions run."""
        level = read_marker_level(self.marker)
        with self._lock:
            if level is None:
                return []
            self._raise(level)
            now = self._clock()
            if self.level == "graceful" and self._graceful_at is not None and now - self._graceful_at >= self.graceful_seconds:
                self._raise("solver")
            if self.level != "all" and self._after_at is not None and now - self._after_at >= self.after_seconds:
                self._raise("all")
            due = self._plan()
            stage, current = self.stage, self.level
        done: list[str] = []
        with self._act:
            for name, call, forced in due:
                try:
                    call()
                except Exception:
                    pass
                with self._lock:
                    self.applied.append({"level": current, "stage": stage, "action": name, "at": _now_iso()})
                    record = self.record()
                done.append(name)
                if record is not None:
                    try:
                        self._on_change(record)
                    except Exception:
                        pass
                if name != "wait" and self._notify is not None:
                    try:
                        self._notify(forced)
                    except Exception:
                        pass
        return done

    def _loop(self) -> None:
        while not self._halt.is_set():
            self._wake.wait(self.every)
            self._wake.clear()
            if self._halt.is_set():
                return
            try:
                self.tick()
            except Exception:
                pass

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="foam-stop", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._halt.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(5.0)


# ---------------------------------------------------------------------------
# The prepare step
# ---------------------------------------------------------------------------


@dataclass
class PrepareStep:
    """A resolved prepare step: the owning plugin's own JobKind tool."""

    job: str
    runtime: str
    args: list[str]
    env: dict[str, str]
    interpreter: str
    tool: str
    cwd: str


def app_root() -> Path:
    env = (os.environ.get("MAGNUSIM_WEB_ROOT") or os.environ.get("CFDDESK_WEB_ROOT") or "").strip()
    if env:
        return Path(env)
    from cfddesk.wsl.config import web_root

    return web_root()


def check_prepare_shape(raw: Any, *, plugin: str, job_id: str, case_dir: str) -> dict[str, Any]:
    """The prepare spec's shape (no registry yet); raises ``invalid_spec``."""
    if not isinstance(raw, dict) or set(raw) - {"job", "runtime", "args", "env"}:
        raise RefusalError("invalid_spec", NOT_ITS_JOB)
    job = raw.get("job")
    runtime = raw.get("runtime")
    args = raw.get("args", [])
    env = raw.get("env", {})
    if not isinstance(job, str) or not PREPARE_JOB_RE.match(job) or runtime not in ("core", "plugin"):
        raise RefusalError("invalid_spec", NOT_ITS_JOB)
    if not isinstance(args, list) or len(args) > MAX_PREPARE_ARGS:
        raise RefusalError("invalid_spec", NOT_ITS_JOB)
    for arg in args:
        if not isinstance(arg, str) or len(arg) > MAX_VALUE or "\x00" in arg:
            raise RefusalError("invalid_spec", NOT_ITS_JOB)
    if not isinstance(env, dict):
        raise RefusalError("invalid_spec", NOT_ITS_JOB)
    must = {"MAGNUSIM_PLUGIN_KEY": plugin, "MAGNUSIM_JOB_ID": job_id, "MAGNUSIM_CASE_DIR": case_dir}
    for name, value in env.items():
        if name not in PREPARE_ENV_KEYS or not isinstance(value, str) or len(value) > MAX_VALUE or "\x00" in value:
            raise RefusalError("invalid_spec", NOT_ITS_JOB)
        if name in must and value != must[name]:
            raise RefusalError("invalid_spec", NOT_ITS_JOB)
    return {"job": job, "runtime": runtime, "args": list(args), "env": dict(env)}


def tool_in_package(package: Path | None, tool: str) -> Path | None:
    """The JobKind's ``.py`` tool inside its package by real path, with no link
    between them; None otherwise."""
    if package is None or not str(tool or ""):
        return None
    root = Path(os.path.realpath(package))
    parts = [p for p in str(tool).replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts) or not parts[-1].endswith(".py"):
        return None
    here = root
    for part in parts:
        here = here / part
        try:
            st = os.lstat(here)
        except OSError:
            return None
        if is_link(st, here.is_symlink()):
            return None
    real = Path(os.path.realpath(here))
    if os.path.normcase(str(real)) != os.path.normcase(str(here)) or not real.is_file():
        return None
    return real


def _load_registry() -> Any:
    from cfddesk.registry import load_all

    return load_all()


def resolve_prepare(shape: dict[str, Any], *, plugin: str, loader: Callable[[], Any] | None = None) -> PrepareStep:
    """Find the step's tool, interpreter and folder from the registry, as
    ``jobs.describe`` does; raises ``prepare_unavailable`` or ``invalid_spec``."""
    try:
        hub = (loader or _load_registry)()
    except Exception:
        raise RefusalError("prepare_unavailable", "The prepare step is not available: the plugins could not be loaded") from None
    job = shape["job"]
    runtime = shape["runtime"]
    jobs = hub.registry("job")
    if job not in jobs.keys():
        raise RefusalError("prepare_unavailable", "The prepare step's job is not loaded (its plugin may be off)")
    if jobs.owner(job) != plugin:
        raise RefusalError("invalid_spec", NOT_ITS_JOB)
    spec = jobs.get(job)
    if str(getattr(spec, "python", "core") or "core") != runtime:
        raise RefusalError("prepare_unavailable", "The prepare step's job changed since the run was planned")
    tool = tool_in_package(hub.job_package(job), str(spec.tool))
    if tool is None:
        raise RefusalError("prepare_unavailable", "The prepare step's tool is not in its plugin's folder")
    if runtime == "core":
        # The app's interpreter, in the app's folder (as /api/jobs runs a core job).
        return PrepareStep(job, runtime, shape["args"], shape["env"], sys.executable, str(tool), str(app_root()))
    from cfddesk.registry.plugin_env import env_status

    manifest = hub.manifests.get(plugin)
    folder = hub.plugin_dir(plugin)
    env_spec = getattr(manifest, "python_env", None) if manifest is not None else None
    if env_spec is None or folder is None:
        raise RefusalError("prepare_unavailable", f"{plugin} declares no [python] environment")
    state = env_status(app_root(), plugin, env_spec)
    if state.get("state") != "ready" or not state.get("python"):
        name = getattr(manifest, "name", "") or plugin
        raise RefusalError("prepare_unavailable", f"{name} needs setup: install its dependencies in Settings > Plugins")
    return PrepareStep(job, runtime, shape["args"], shape["env"], str(state["python"]), str(tool), str(folder))


def prepare_environment(step: PrepareStep, base: dict[str, str] | None = None) -> dict[str, str]:
    """The relay's environment plus the step's; a plugin runtime sees nothing of the
    core's Python paths (as ``isolatedPythonEnv``)."""
    env = dict(os.environ if base is None else base)
    env.update(step.env)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    if step.runtime == "plugin":
        for name in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"):
            env.pop(name, None)
        env["PYTHONNOUSERSITE"] = "1"
    return env


# ---------------------------------------------------------------------------
# Ranks
# ---------------------------------------------------------------------------

_SLOTS_QUERY = (
    "lscpu 2>/dev/null | awk -F: '/^Core\\(s\\) per socket/{gsub(/[ \\t]/,\"\",$2); c=$2} "
    "/^Socket\\(s\\)/{gsub(/[ \\t]/,\"\",$2); s=$2} END{v=(c+0)*(s+0); print v+0}'"
)


def wsl_mpi_slots(timeout: float = 20.0) -> int:
    """Open MPI slots as WSL reports them (cores x sockets); 0 when unknown."""
    try:
        r = subprocess.run(
            ["wsl", "-d", get_wsl_distro(), "-e", "bash", "-c", _SLOTS_QUERY],
            stdin=subprocess.DEVNULL,  # never the caller's stdin: wsl.exe would read it (the worker's request pipe)
            capture_output=True,
            timeout=timeout,
            check=False,
            creationflags=_no_window(),
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0
    words = (r.stdout or b"").decode("utf-8", errors="replace").split()
    try:
        return max(0, int(words[-1])) if words else 0
    except ValueError:
        return 0


def clamp_ranks(n_procs: int, slots: int, slots_hint: int | None) -> int:
    n = max(1, int(n_procs))
    if slots >= 1:
        return max(1, min(n, slots))
    if slots_hint:
        return max(1, min(n, int(slots_hint)))
    return n


# ---------------------------------------------------------------------------
# The relay
# ---------------------------------------------------------------------------


def _default_hook_runner(ctx: Any, names: list[str]) -> Any:
    from cfddesk.wsl.solve_hooks import HookRunner

    return HookRunner(ctx, names)


def _default_start_solve(*args: Any, **kwargs: Any) -> Any:
    from cfddesk.wsl.solve_run import start_solve

    return start_solve(*args, **kwargs)


def _default_write_now(wsl_case: str, *, graceful: bool = True) -> Any:
    from cfddesk.wsl.solve_run import stop_solve

    return stop_solve(wsl_case, graceful=graceful)


def _default_remove_case(wsl_case: str) -> bool:
    from cfddesk.runner.cleanup import remove_wsl_case

    return remove_wsl_case(wsl_case)


@dataclass
class RelayDeps:
    """What the relay runs; tests swap these."""

    popen: Callable[..., Any] = subprocess.Popen
    start_solve: Callable[..., Any] = _default_start_solve
    kill_case: Callable[..., Any] = case_procs.kill
    probe_case: Callable[..., Any] = case_procs.probe
    write_now: Callable[..., Any] = _default_write_now
    remove_case: Callable[[str], Any] = _default_remove_case
    mpi_slots: Callable[[], int] = wsl_mpi_slots
    registry_loader: Callable[[], Any] | None = None
    hook_runner: Callable[[Any, list[str]], Any] = _default_hook_runner
    kill_tree: Callable[[int], Any] = kill_process_tree
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    gone_seconds: float = 60.0
    probe_every: float = 2.0
    status_every: float = 2.0
    stop_every: float = 1.0
    hook_wait: float = 5.0


def _inside(child: str, parent: str) -> bool:
    c = os.path.normcase(os.path.abspath(child))
    p = os.path.normcase(os.path.abspath(parent))
    return c == p or c.startswith(p.rstrip("\\/") + os.sep)


def _part_ok(part: Any) -> bool:
    return (
        isinstance(part, str)
        and 0 < len(part) <= 255
        and part not in (".", "..")
        and not any(ch in part for ch in "/\\:\x00")
    )


class Relay:
    """One run of a spec file (see the module text)."""

    def __init__(self, spec_path: str | Path, *, projects_root: str | Path, out: Any = None, deps: RelayDeps | None = None) -> None:
        self.spec_path = Path(spec_path)
        self.projects_root = Path(projects_root)
        self.deps = deps or RelayDeps()
        self.writer = EventWriter(out if out is not None else sys.stdout)
        self.spec: dict[str, Any] = {}
        self.case: Path | None = None
        self.case_ok = False
        self.state: RelayState | None = None
        self.status: StatusWriter | None = None
        self.controller: StopController | None = None
        self.hooks: Any = None
        self.steps: list[dict[str, Any]] = []
        self.prepare: PrepareStep | None = None
        self.prepare_shape: dict[str, Any] | None = None
        self.solver: dict[str, Any] | None = None
        self.n = 1
        self._prepare_pid: int | None = None
        self._phase = "gate"
        self._verified = False

    # -- spec and gate -------------------------------------------------------

    def read_spec(self) -> dict[str, Any]:
        path = self.spec_path
        if path.parent.name != SPECS_FOLDER or not JOB_ID_RE.match(path.stem) or path.suffix != ".json":
            raise RefusalError("invalid_spec", "The run's spec file is not one the host wrote")
        try:
            if path.stat().st_size > SPEC_MAX_BYTES:
                raise RefusalError("invalid_spec", "The run's spec file is too large")
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise RefusalError("invalid_spec", "The run's spec file could not be read") from None
        if not isinstance(doc, dict) or doc.get("v") != 1:
            raise RefusalError("invalid_spec", "The run's spec file is not one this host reads")
        return doc

    def _shape(self) -> None:
        s = self.spec
        bad = RefusalError("invalid_spec", "The run's spec is not valid")
        if s.get("kind") not in ("foam", "mesh"):
            raise bad
        if s.get("job_id") != self.spec_path.stem or not JOB_ID_RE.match(str(s.get("job_id") or "")):
            raise bad
        pid = s.get("project_id")
        if not _part_ok(pid) or len(str(pid)) > 200:
            raise bad
        plugin = s.get("plugin")
        if not isinstance(plugin, str) or not PLUGIN_KEY_RE.match(plugin) or plugin.endswith("."):
            raise bad
        if not plugin_case_id_ok(s.get("wsl_case"), s.get("token")):
            raise bad
        n = s.get("n_procs")
        if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= MAX_PROCS:
            raise bad
        hint = s.get("slots_hint")
        if hint is not None and (isinstance(hint, bool) or not isinstance(hint, int) or hint < 1):
            raise bad
        for key in ("case_dir", "case_base"):
            if not isinstance(s.get(key), str) or not s.get(key):
                raise bad
        parts = s.get("case_parts")
        if not isinstance(parts, list) or not 1 <= len(parts) <= 16 or not all(_part_ok(p) for p in parts):
            raise bad
        if s.get("prepare") is None and not s.get("pre") and s.get("solver") is None:
            raise bad
        if s.get("solver") is None and (s.get("owner") is not None or s.get("hooks")):
            raise bad

    def _real_path(self) -> None:
        s = self.spec
        case_dir = str(s["case_dir"])
        if not os.path.isdir(case_dir):
            raise RefusalError("not_found", "The case folder is missing")
        real_case = os.path.normcase(os.path.realpath(case_dir))
        base_real = os.path.realpath(str(s["case_base"]))
        expect = os.path.normcase(os.path.join(base_real, *[str(p) for p in s["case_parts"]]))
        if real_case != expect:
            raise RefusalError("invalid_path", "The case folder is not where the run says it is")
        project = os.path.realpath(str(self.projects_root / str(s["project_id"])))
        if not _inside(base_real, project) or not os.path.isdir(project):
            raise RefusalError("invalid_path", "The case folder is not in its project")
        if s["kind"] == "foam":
            own = os.path.realpath(os.path.join(project, "plugins", str(s["plugin"])))
            if os.path.normcase(base_real) != os.path.normcase(own):
                raise RefusalError("invalid_path", "The case folder is not in the plugin's folder")
        self.case = Path(case_dir)
        self.case_ok = True

    def _solver_shape(self) -> None:
        raw = self.spec.get("solver")
        if raw is None:
            return
        bad = RefusalError("invalid_spec", "The run's solver spec is not valid")
        if not isinstance(raw, dict):
            raise bad
        app = raw.get("app")
        if not isinstance(app, str) or not APP_NAME_RE.match(app):
            raise RefusalError("app_not_allowed", "The app must be a plain program name")
        frames = raw.get("frame_fields")
        if not isinstance(frames, list) or not 1 <= len(frames) <= 8:
            raise RefusalError("bad_request", "frameFields: 1 to 8 field names")
        if not all(field_name_ok(f) for f in frames):
            raise RefusalError("bad_request", "frameFields: each must be a field name")
        if raw.get("keep_frames") not in ("all", "latest"):
            raise bad
        names = raw.get("process_names") or [app]
        if not isinstance(names, list) or not 1 <= len(names) <= 8 or not all(isinstance(n, str) and APP_NAME_RE.match(n) for n in names):
            raise bad
        if raw.get("stop_strategy") not in STOP_STRATEGIES:
            raise bad
        parallel = raw.get("parallel", False)
        if parallel not in (True, False, "mpirun", "none"):
            raise bad
        hooks = self.spec.get("hooks") or []
        if not isinstance(hooks, list) or not all(h in SOLVE_HOOKS for h in hooks):
            raise bad
        owner = self.spec.get("owner")
        if owner is not None and not isinstance(owner, str):
            raise bad
        self.solver = {
            "app": app,
            "keep_frames": raw["keep_frames"],
            "frame_fields": [str(f) for f in frames],
            "process_names": [str(n) for n in names],
            "stop_strategy": raw["stop_strategy"],
            "parallel": parallel in (True, "mpirun"),
        }

    def gate(self) -> None:
        """Step 1. Raises :class:`RefusalError`; nothing has run yet."""
        self.spec = self.read_spec()
        self._shape()
        self._real_path()
        self._solver_shape()
        try:
            self.steps = check_steps(self.spec.get("pre") or [])
        except FoamCaseError as exc:
            raise RefusalError(exc.code, exc.error) from None
        s = self.spec
        if s.get("prepare") is not None:
            self.prepare_shape = check_prepare_shape(
                s["prepare"], plugin=str(s["plugin"]), job_id=str(s["job_id"]), case_dir=str(s["case_dir"])
            )
        if not wsl_root_ok(s.get("wsl_root")):
            raise RefusalError("invalid_path", ROOT_UNUSABLE)
        problem = temp_path_problem(tempfile.gettempdir())
        if problem:
            raise RefusalError("invalid_path", problem)
        if self.prepare_shape is not None:
            self.prepare = resolve_prepare(self.prepare_shape, plugin=str(s["plugin"]), loader=self.deps.registry_loader)
        try:
            if self.prepare is not None:
                check_case_paths(str(s["case_dir"]))
            else:
                self._check_case(own_marker=False)
        except FoamCaseError as exc:
            raise RefusalError(exc.code, exc.error) from None

    def _check_case(self, *, own_marker: bool) -> None:
        solver = self.solver
        check_case_local(
            str(self.spec["case_dir"]),
            solver["app"] if solver else None,
            self.spec.get("pre") or [],
            None,
            own_marker=own_marker,
            stop_strategy=solver["stop_strategy"] if solver else None,
        )

    # -- helpers -------------------------------------------------------------

    @property
    def marker(self) -> Path:
        assert self.case is not None
        return self.case / STOP_MARKER

    def _stopped_now(self) -> bool:
        return self.case is not None and read_marker_level(self.marker) is not None

    def _scripts(self) -> list[str]:
        token = str(self.spec["token"])
        return [foam_pre_script_name(token), f"solve-pf-{token}.sh"]

    def _foreign_marker(self) -> bool:
        """``.magnusim-ran`` of another job: the folder is that run's, its status too."""
        if self.case is None:
            return False
        try:
            doc = json.loads((self.case / RAN_MARKER).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return False
        except (OSError, ValueError):
            return True
        return not isinstance(doc, dict) or doc.get("job_id") != self.spec.get("job_id")

    def _relay_end(self, code: int, outcome: dict[str, Any], clean: bool) -> None:
        self.writer.emit({"event": "relay_end", "exit_code": code, "clean": clean, "outcome": outcome})

    def refused(self, r: RefusalError) -> int:
        self.writer.emit({"event": "refused", "code": r.code, "error": r.error})
        outcome = {"ok": False, "phase": "gate", "code": r.code, "error": r.error}
        if self.case_ok and self.case is not None and not self._foreign_marker():
            state = self.state or RelayState(str(self.spec.get("job_id") or ""), str(self.spec.get("token") or ""))
            state.final = {"outcome": outcome, "exit_code": EXIT_REFUSED, "clean": True}
            StatusWriter(self.case / STATUS_FILE, state).write_now()
        self._relay_end(EXIT_REFUSED, outcome, True)
        return EXIT_REFUSED

    # -- running -------------------------------------------------------------

    def run(self) -> int:
        try:
            self.gate()
        except RefusalError as r:
            return self.refused(r)
        return self._run_checked()

    def _start_parts(self) -> None:
        s = self.spec
        job_id = str(s["job_id"])
        # Every process the relay starts carries the job id (foam_relay_ctl finds them).
        os.environ["MAGNUSIM_JOB_ID"] = job_id
        os.environ["MAGNUSIM_WSL_CASE_ROOT"] = str(s["wsl_root"])
        assert self.case is not None
        state = RelayState(job_id, str(s["token"]))
        self.state = state
        self.writer.on_event = state.observe
        if self.solver is not None and s.get("hooks"):
            from cfddesk.registry.solve_context import parse_owner, solve_context

            ids = parse_owner(str(s.get("owner") or ""))
            ctx = None
            if ids and ids.get("project_id") == s["project_id"] and ids.get("plugin") == s["plugin"]:
                ctx = solve_context(
                    str(s["owner"]),
                    wsl_case=str(s["wsl_case"]),
                    run_id=f"pf-{s['token']}",
                    app=self.solver["app"],
                    case_dir=str(s["case_dir"]),
                    n_procs=int(s["n_procs"]),
                )
            if ctx is not None:
                self.hooks = self.deps.hook_runner(ctx, list(s["hooks"]))
                sink = self.hooks.start()
                if sink is not None:
                    self.writer.set_stream(sink)
        self.status = StatusWriter(self.case / STATUS_FILE, state, every=self.deps.status_every)
        solver = self.solver or {}

        def on_change(record: dict[str, Any]) -> None:
            with state.lock:
                state.stop = record

        def notify(forced: bool) -> None:
            if self.hooks is not None:
                self.hooks.stop_notice(forced)

        self.controller = StopController(
            marker=self.marker,
            wsl_case=str(s["wsl_case"]),
            scripts=self._scripts(),
            process_names=list(solver.get("process_names") or []),
            stop_strategy=solver.get("stop_strategy"),
            root=str(s["wsl_root"]),
            kill_case=self.deps.kill_case,
            write_now=self.deps.write_now,
            kill_prepare=self.deps.kill_tree,
            prepare_pid=lambda: self._prepare_pid,
            wsl_reached=lambda: state.wsl_reached,
            on_change=on_change,
            notify=notify,
            clock=self.deps.clock,
            every=self.deps.stop_every,
        )
        state.stage_listener = self.controller.set_stage
        self.status.start()
        self.controller.start()

    def _run_checked(self) -> int:
        try:
            self._start_parts()
        except Exception as exc:
            self.writer.log(f"the relay could not start its parts: {exc}")
            self._relay_end(1, {"ok": False, "phase": "start", "code": "relay_error", "error": LAUNCH_FAILED}, True)
            return 1
        assert self.state is not None and self.status is not None and self.controller is not None
        code = 1
        outcome: dict[str, Any] = {"ok": False, "phase": self._phase}
        try:
            code, outcome = self._steps()
        except Exception as exc:
            self.writer.log(f"the relay failed: {exc}")
            outcome = {"ok": False, "phase": self._phase, "code": "relay_error", "error": "The relay failed. See the log"}
            code = 1
        clean = self._clean()
        self.controller.stop()
        if self.hooks is not None:
            try:
                self.hooks.close(join=2.0)
            except Exception:
                pass
        with self.state.lock:
            self.state.stdout_lost = self.writer.stdout_lost
            self.state.final = {"outcome": outcome, "exit_code": code, "clean": clean}
            if self._verified:
                self.state.final["verified_gone"] = True
        self.status.stop()
        self._relay_end(code, outcome, clean)
        return code

    def _clean(self) -> bool:
        assert self.state is not None
        if self.state.result_seen or not self.state.wsl_reached:
            return True
        deps = self.deps
        deadline = deps.clock() + deps.gone_seconds
        dead = 0
        while True:
            try:
                r = deps.probe_case(str(self.spec["wsl_case"]), self._scripts(), root=str(self.spec["wsl_root"]))
            except Exception:
                r = {"ok": False}
            if r.get("ok") and not r.get("live"):
                dead += 1
                if dead >= 2:
                    self._verified = True
                    return True
            else:
                dead = 0
            if deps.clock() >= deadline:
                return False
            deps.sleep(deps.probe_every)

    def _stopped(self, phase: str) -> tuple[int, dict[str, Any]]:
        return EXIT_STOPPED, {"ok": False, "stopped": True, "phase": phase}

    def _steps(self) -> tuple[int, dict[str, Any]]:
        s = self.spec
        assert self.case is not None and self.state is not None
        self._phase = "start"
        if self._stopped_now():
            return self._stopped("start")
        (self.case / RAN_MARKER).write_text(
            json.dumps({"job_id": s["job_id"], "token": s["token"], "at": _now_iso()}), encoding="utf-8"
        )
        if self.prepare is not None:
            self._phase = "prepare"
            code = self._run_prepare()
            if self._stopped_now():
                return self._stopped("prepare")
            if code != 0:
                return code, {"ok": False, "phase": "prepare", "job": self.prepare.job, "exit_code": code}
            try:
                self._check_case(own_marker=True)
            except FoamCaseError as exc:
                self.writer.emit({"event": "refused", "code": exc.code, "error": exc.error})
                return EXIT_REFUSED, {"ok": False, "phase": "gate", "code": exc.code, "error": exc.error}
        solver = self.solver
        wants_parallel = has_parallel_step(self.steps) or bool(solver and solver["parallel"])
        n = 1
        if wants_parallel:
            n = max(1, int(s["n_procs"]))
            if n > 1:
                n = clamp_ranks(n, self.deps.mpi_slots(), s.get("slots_hint"))
            self.writer.emit({"event": "ranks", "n_procs": n})
        self.n = n
        with self.state.lock:
            self.state.n_procs = n
        if n > 1:
            from magnusim_sdk.foam import write_decompose_par_dict

            write_decompose_par_dict(self.case / "system" / "decomposeParDict", n)
        if self.steps:
            self._phase = "pre"
            if self._stopped_now():
                return self._stopped("pre")
            code, result = self._run_pre(n)
            if not (result or {}).get("ok") or code != 0:
                if self._stopped_now() or (result or {}).get("stopped"):
                    if code == EXIT_STOPPED:
                        # Nothing came back: the copy goes now.
                        self._remove_case()
                    return self._stopped("pre")
                failed: dict[str, Any] = {"ok": False, "phase": "pre", "exit_code": code if code != 0 else 1}
                if result is not None:
                    failed["tool"] = result.get("tool")
                    failed["index"] = result.get("index")
                    given = result.get("exit_code")
                    if isinstance(given, int) and not isinstance(given, bool) and given != 0:
                        failed["exit_code"] = given
                return int(failed["exit_code"]), failed
            if solver is None:
                # The copy back succeeded: the WSL copy is not needed any more.
                self._remove_case()
                return EXIT_DONE, {"ok": True, "phase": "pre"}
        if solver is None:
            return EXIT_DONE, {"ok": True, "phase": "prepare"}
        self._phase = "solve"
        if self._stopped_now():
            return self._stopped("solve")
        if self.hooks is not None:
            self.hooks.wait_ready(self.deps.hook_wait)
        if self._stopped_now():
            return self._stopped("solve")
        return self._run_solve(n)

    def _remove_case(self) -> None:
        try:
            self.deps.remove_case(str(self.spec["wsl_case"]))
        except Exception as exc:
            self.writer.log(f"the WSL copy could not be removed: {exc}")

    def _run_prepare(self) -> int:
        step = self.prepare
        assert step is not None and self.case is not None and self.state is not None
        self.writer.emit({"event": "stage", "stage": "prepare"})
        t0 = time.monotonic()
        kwargs: dict[str, Any] = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True
        proc = self.deps.popen(
            [step.interpreter, step.tool, *step.args],
            cwd=step.cwd,
            env=prepare_environment(step),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            **kwargs,
        )
        self._prepare_pid = int(proc.pid)
        with self.state.lock:
            self.state.prepare = {"job": step.job, "pid": int(proc.pid), "exit_code": None}
        # A stop that came while the step started is applied now.
        if self.controller is not None:
            self.controller.set_stage("prepare")
        assert proc.stdout is not None
        with open(self.case / "log.prepare", "ab") as log:
            for raw in proc.stdout:
                log.write(raw)
                log.flush()
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                ev = parse_job_line(line)
                name = ev.get("stage") if ev and ev.get("event") == "stage" else None
                if isinstance(name, str) and STAGE_NAME_RE.match(name):
                    self.writer.emit({"event": "prepare_stage", "stage": name})
        code = proc.wait()
        code = int(code if code is not None else -1)
        self._prepare_pid = None
        with self.state.lock:
            self.state.prepare = {"job": step.job, "pid": int(proc.pid), "exit_code": code}
        self.writer.emit({"event": "prepare", "job": step.job, "exit_code": code})
        self.writer.emit({"event": "phase", "phase": "prepare", "seconds": round(time.monotonic() - t0, 3)})
        return code

    def _run_pre(self, n: int) -> tuple[int, dict[str, Any] | None]:
        from cfddesk.runner.case_id import wsl_case_path
        from cfddesk.wsl.mesh_run import windows_to_wsl_path

        assert self.case is not None and self.state is not None
        s = self.spec
        token = str(s["token"])
        text = render_foam_pre(
            dst=wsl_case_path(str(s["wsl_case"])),
            win_out=windows_to_wsl_path(self.case),
            token=token,
            steps=self.steps,
            n_procs=n,
        )
        folder = Path(tempfile.mkdtemp(prefix="cfddesk-foam-pre-"))
        script = folder / foam_pre_script_name(token)
        script.write_bytes(text.encode("utf-8"))
        result: dict[str, Any] | None = None
        t_start: float | None = None
        try:
            argv = ["wsl", "-d", get_wsl_distro(), "-e", "bash", windows_to_wsl_path(script)]
            with self.state.lock:
                self.state.wsl_reached = True
            proc = self.deps.popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                creationflags=_no_window(),
            )
            assert proc.stdout is not None
            for raw in proc.stdout:
                line = (raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)).rstrip("\r\n")
                ev = parse_job_line(line)
                if ev is None:
                    if line.strip():
                        self.writer.log(line)
                    continue
                kind = ev.get("event")
                if kind == "stage" and ev.get("stage") == "pre_copy_in":
                    t_start = _t_wall(ev)
                if kind == "result":
                    result = ev
                    self.writer.emit({**ev, "event": "pre_result"})
                    t_end = _t_wall(ev)
                    if t_start is not None and t_end is not None:
                        self.writer.emit({"event": "phase", "phase": "pre", "seconds": round(max(0.0, t_end - t_start), 3)})
                    continue
                self.writer.emit(ev)
            code = proc.wait()
        finally:
            shutil.rmtree(folder, ignore_errors=True)
        return int(code if code is not None else -1), result

    def _run_solve(self, n: int) -> tuple[int, dict[str, Any]]:
        from magnusim_sdk.progress import ProgressParser as GenericParser

        from cfddesk.wsl.solve_run import stream_events_to_stdout

        assert self.case is not None and self.state is not None and self.solver is not None
        solver = self.solver
        s = self.spec
        ranks = n if solver["parallel"] else 1
        with self.state.lock:
            self.state.wsl_reached = True
        proc = self.deps.start_solve(
            self.case,
            wsl_case_id=str(s["wsl_case"]),
            n_procs=ranks,
            app=solver["app"],
            run_id=f"pf-{s['token']}",
            keep_frames=solver["keep_frames"],
            process_names=tuple(solver["process_names"]),
            frame_fields=tuple(solver["frame_fields"]),
        )
        on_line = self.hooks.feed if self.hooks is not None else None
        code, _parser = stream_events_to_stdout(proc, GenericParser(), on_line=on_line, out=self.writer)
        outcome = {
            "ok": bool(self.state.result_ok and code == 0),
            "phase": "solve",
            "exit_code": int(code),
            "stopped": self._stopped_now(),
        }
        return int(code), outcome


def _t_wall(ev: dict[str, Any]) -> float | None:
    try:
        raw = ev.get("t_wall")
        return float(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def run_relay(spec_path: str | Path, *, projects_root: str | Path, out: Any = None, deps: RelayDeps | None = None) -> int:
    """Run one spec file; returns the exit code (for logs only)."""
    return Relay(spec_path, projects_root=projects_root, out=out, deps=deps).run()


# ---------------------------------------------------------------------------
# The hidden starter and the console self-test
# ---------------------------------------------------------------------------


def launch(child_args: list[str], *, script: str, job_id: str | None = None, out: Any = None) -> int:
    """Start the relay with no console window, out of the app's process tree, on the
    starter's own stdout and stderr (Node's pipes); print ``relay_launch`` and return 0,
    or ``relay_launch_failed`` and 3."""
    stream = out if out is not None else sys.stdout

    def say(doc: dict[str, Any]) -> None:
        try:
            stream.write(EVENT_PREFIX + json.dumps(doc, separators=(",", ":")) + "\n")
            stream.flush()
        except (OSError, ValueError):
            pass

    argv = [sys.executable, script, *child_args]
    env = dict(os.environ)
    if job_id and JOB_ID_RE.match(job_id):
        env["MAGNUSIM_JOB_ID"] = job_id
    common: dict[str, Any] = {"stdin": subprocess.DEVNULL, "stdout": sys.stdout, "stderr": sys.stderr, "env": env}
    breakaway = True
    try:
        if sys.platform == "win32":
            flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB
            try:
                child = subprocess.Popen(argv, creationflags=flags, **common)
            except OSError as exc:
                if getattr(exc, "winerror", None) != 5:
                    raise
                # The job the app runs in does not allow breaking away.
                breakaway = False
                child = subprocess.Popen(argv, creationflags=flags & ~CREATE_BREAKAWAY_FROM_JOB, **common)
        else:
            child = subprocess.Popen(argv, start_new_session=True, **common)
    except Exception:
        say({"event": "relay_launch_failed", "error": LAUNCH_FAILED})
        return EXIT_LAUNCH
    say({"event": "relay_launch", "launcher_pid": os.getpid(), "relay_pid": child.pid, "breakaway": breakaway})
    return EXIT_DONE


def selftest_console(out_path: str | Path, sleep_seconds: float = 0.0) -> int:
    """Tests only: write ``{pid, console_hwnd, console_visible}``, sleep, then ``{late: true}``
    (one JSON object per line)."""
    hwnd = 0
    visible = False
    if sys.platform == "win32":
        import ctypes

        hwnd = int(ctypes.windll.kernel32.GetConsoleWindow() or 0)
        visible = bool(ctypes.windll.user32.IsWindowVisible(hwnd)) if hwnd else False
    path = Path(out_path)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"pid": os.getpid(), "console_hwnd": hwnd, "console_visible": visible}) + "\n")
    time.sleep(max(0.0, float(sleep_seconds)))
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"late": True}) + "\n")
    return 0
