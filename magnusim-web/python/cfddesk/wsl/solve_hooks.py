"""Solve hooks in the solve relay (API 1.3): ``solve.prepare``, ``solve.parse_line``
and ``solve.stop``.

Used by ``tools/run_solve.py`` (core runs), the foam relay (plugin OpenFOAM
cases) and ``tools/stop_solve.py``, and only when the host passes hook names
(some plugin listens). Without names nothing loads and nothing fires.

- **Output first.** The real stdout becomes a private event stream; fd 1 and
  fd 2 point at the null device, and ``sys.stdout``/``sys.stderr`` turn each
  line a listener prints into a ``log`` event (``[hook] …``, at most 500
  characters). A listener cannot inject an event line.
- **Loading** runs ``load_all()`` in a daemon thread; a failure turns hooks off
  for the run and the solve goes on.
- **solve.prepare(ctx)** runs after loading. Core runs do not wait for it; the
  foam relay waits at most 5 s for loading plus prepare.
- **solve.parse_line(ctx, lines, events, dropped)**: the read loop only queues
  lines (4096 at most; more are counted in ``dropped``). A hook thread hands
  batches of up to 256 lines or 200 ms to each listener. A call over 1 s is a
  strike; three strikes or one exception drop that listener for the run.
- **solve.stop(ctx, forced)** after a stop action, in a daemon thread joined at
  most 5 s.

Listeners run in this process, which loads every plugin's ``register(hub)``:
a plugin that ends the process or crashes natively can still end the run.
"""

from __future__ import annotations

import io
import json
import os
import queue
import sys
import threading
import time
from collections.abc import Callable, Iterable
from typing import Any, TextIO

from cfddesk.jobs.events import EVENT_PREFIX

SOLVE_HOOK_NAMES: tuple[str, ...] = ("solve.prepare", "solve.parse_line", "solve.stop")
HOOK_LINE_MAX = 500
QUEUE_MAX = 4096
BATCH_LINES = 256
BATCH_SECONDS = 0.2
STRIKE_SECONDS = 1.0
STRIKES = 3
PREPARE_WAIT_SECONDS = 5.0
STOP_JOIN_SECONDS = 5.0


def hook_names(raw: str | Iterable[str] | None) -> list[str]:
    """The solve hook names in ``raw`` (a comma list or a list), in their fixed order."""
    if raw is None:
        return []
    items = raw.split(",") if isinstance(raw, str) else list(raw)
    wanted = {str(item).strip() for item in items}
    return [name for name in SOLVE_HOOK_NAMES if name in wanted]


class LineSink:
    """The private event stream: whole lines, one writer at a time. A write that
    fails marks it ``lost`` and later writes are dropped (the run goes on)."""

    def __init__(self, stream: TextIO | None) -> None:
        self._stream = stream
        self._lock = threading.Lock()
        self.lost = stream is None

    def write(self, text: str) -> int:
        with self._lock:
            if self.lost or self._stream is None:
                return len(text)
            try:
                self._stream.write(text)
                self._stream.flush()
            except (OSError, ValueError):
                self.lost = True
        return len(text)

    def flush(self) -> None:
        return None


def hook_log_line(text: str) -> str:
    """One ``log`` event line for what a listener printed (cut to 500 characters)."""
    line = ("[hook] " + str(text).rstrip("\r"))[:HOOK_LINE_MAX]
    return EVENT_PREFIX + json.dumps({"event": "log", "line": line}, ensure_ascii=False) + "\n"


class HookOutput(io.TextIOBase):
    """``sys.stdout``/``sys.stderr`` while hooks run: each line becomes a log event."""

    def __init__(self, sink: LineSink) -> None:
        super().__init__()
        self._sink = sink
        self._buf = ""
        self._lock = threading.Lock()

    def writable(self) -> bool:
        return True

    def write(self, s: str) -> int:
        text = str(s)
        with self._lock:
            self._buf += text
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                self._sink.write(hook_log_line(line))
        return len(text)

    def flush(self) -> None:
        return None


def isolate_output() -> LineSink:
    """Make the real stdout the private event stream and send fd 1, fd 2 and
    ``sys.stdout``/``sys.stderr`` away from it (see the module text)."""
    for std in (sys.stdout, sys.stderr):
        try:
            std.flush()
        except (AttributeError, OSError, ValueError):
            pass
    try:
        events_fd = os.dup(1)
    except OSError:
        events_fd = -1
    null = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(null, 1)
        os.dup2(null, 2)
    finally:
        os.close(null)
    if sys.platform == "win32":
        # Native code may write through the OS handles rather than CRT fds 1 and 2.
        try:
            import ctypes
            import msvcrt

            kernel = ctypes.windll.kernel32
            kernel.SetStdHandle(-11, msvcrt.get_osfhandle(1))
            kernel.SetStdHandle(-12, msvcrt.get_osfhandle(2))
        except Exception:
            pass
    stream: TextIO | None = None
    if events_fd >= 0:
        stream = open(events_fd, "w", encoding="utf-8", errors="replace", newline="\n")  # noqa: SIM115 - lives as long as the run
    sink = LineSink(stream)
    sys.stdout = HookOutput(sink)
    sys.stderr = HookOutput(sink)
    return sink


def _load_plugins() -> None:
    from cfddesk.registry import load_all

    load_all()


class HookRunner:
    """Fires the solve hooks of one run (see the module text)."""

    def __init__(
        self,
        ctx: Any,
        names: Iterable[str],
        *,
        sink: LineSink | None = None,
        loader: Callable[[], Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
        strike_seconds: float = STRIKE_SECONDS,
        batch_lines: int = BATCH_LINES,
        batch_seconds: float = BATCH_SECONDS,
        queue_max: int = QUEUE_MAX,
    ) -> None:
        self.ctx = ctx
        self.names = hook_names(list(names))
        self.events = sink
        self._loader = loader or _load_plugins
        self._clock = clock
        self._strike_seconds = strike_seconds
        self._batch_lines = max(1, int(batch_lines))
        self._batch_seconds = batch_seconds
        self._queue: queue.Queue[tuple[str, list[dict[str, Any]]]] = queue.Queue(maxsize=queue_max)
        self._lock = threading.Lock()
        self._dropped = 0
        self._closed = False
        self._ready = threading.Event()
        self._loaded = False
        self._bus: Any = None
        self._parse_thread: threading.Thread | None = None
        self._strikes: dict[int, int] = {}
        self._gone: set[int] = set()
        self.dropped_listeners: list[tuple[str, str]] = []

    @property
    def active(self) -> bool:
        """Some hook was asked for and the run's context is valid."""
        return bool(self.names) and self.ctx is not None

    @property
    def loaded(self) -> bool:
        return self._loaded

    def start(self) -> LineSink | None:
        """Isolate the output and start loading. Returns the event stream to write to
        (None when hooks are off: then nothing changed)."""
        if not self.active:
            self._ready.set()
            return self.events
        if self.events is None:
            self.events = isolate_output()
        threading.Thread(target=self._load, name="solve-hooks-load", daemon=True).start()
        return self.events

    def wait_ready(self, timeout: float = PREPARE_WAIT_SECONDS) -> bool:
        """Wait for loading and ``solve.prepare`` (the foam relay waits at most 5 s)."""
        return self._ready.wait(max(0.0, float(timeout)))

    def log(self, text: str) -> None:
        if self.events is not None:
            self.events.write(hook_log_line(text))

    def _load(self) -> None:
        try:
            self._loader()
            from cfddesk.registry.hooks import get_hooks

            self._bus = get_hooks()
            self._loaded = True
        except Exception as exc:
            self.log(f"solve hooks are off for this run: the plugins could not be loaded ({exc})")
            self._ready.set()
            return
        if "solve.prepare" in self.names and self._bus.has_listeners("solve.prepare"):
            try:
                self._bus.notify("solve.prepare", ctx=self.ctx)
            except Exception as exc:
                self.log(f"solve.prepare failed: {exc}")
        if "solve.parse_line" in self.names and self._bus.has_listeners("solve.parse_line"):
            thread = threading.Thread(target=self._parse_loop, name="solve-hooks-lines", daemon=True)
            thread.start()
            self._parse_thread = thread
        self._ready.set()

    def feed(self, line: str, events: Iterable[Any] = ()) -> None:
        """Queue one line for ``solve.parse_line`` and return at once (never waits)."""
        if not self.active or "solve.parse_line" not in self.names or self._closed:
            return
        evs = [ev.to_dict() if hasattr(ev, "to_dict") else dict(ev) for ev in events]
        try:
            self._queue.put_nowait((str(line), evs))
        except queue.Full:
            with self._lock:
                self._dropped += 1

    def _next_batch(self) -> list[tuple[str, list[dict[str, Any]]]]:
        try:
            first = self._queue.get(timeout=self._batch_seconds)
        except queue.Empty:
            return []
        batch = [first]
        deadline = time.monotonic() + self._batch_seconds
        while len(batch) < self._batch_lines:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            try:
                batch.append(self._queue.get(timeout=left))
            except queue.Empty:
                break
        return batch

    def _parse_loop(self) -> None:
        while True:
            batch = self._next_batch()
            if batch:
                self.deliver(batch)
            elif self._closed:
                return

    def deliver(self, batch: list[tuple[str, list[dict[str, Any]]]]) -> None:
        """Hand one batch to each listener of ``solve.parse_line`` still in the run."""
        lines = [line for line, _evs in batch]
        events = [ev for _line, evs in batch for ev in evs]
        with self._lock:
            dropped, self._dropped = self._dropped, 0
        for plugin, fn in self._bus.listeners("solve.parse_line"):
            key = id(fn)
            if key in self._gone:
                continue
            t0 = self._clock()
            try:
                fn(ctx=self.ctx, lines=lines, events=events, dropped=dropped)
            except Exception as exc:
                self._drop(key, plugin, f"raised: {exc}")
                continue
            if self._clock() - t0 > self._strike_seconds:
                self._strikes[key] = self._strikes.get(key, 0) + 1
                if self._strikes[key] >= STRIKES:
                    self._drop(key, plugin, f"took over {self._strike_seconds:g} s {STRIKES} times")

    def _drop(self, key: int, plugin: str, why: str) -> None:
        self._gone.add(key)
        self.dropped_listeners.append((plugin, why))
        self.log(f"{plugin or '?'} solve.parse_line is off for this run: it {why}")

    def stop_notice(self, forced: bool, join: float = STOP_JOIN_SECONDS) -> None:
        """Fire ``solve.stop(ctx, forced)`` after a stop action, joined at most ``join`` s."""
        if not self.active or "solve.stop" not in self.names:
            return
        t0 = time.monotonic()

        def run() -> None:
            if not self._ready.wait(join):
                return
            if self._loaded and self._bus.has_listeners("solve.stop"):
                self._bus.notify("solve.stop", ctx=self.ctx, forced=bool(forced))

        thread = threading.Thread(target=run, name="solve-hooks-stop", daemon=True)
        thread.start()
        thread.join(max(0.0, join - (time.monotonic() - t0)))

    def close(self, join: float = 2.0) -> None:
        """No more lines; let the hook thread hand on what is queued (at most ``join`` s
        in all, loading included)."""
        self._closed = True
        if not self.active:
            return
        t0 = time.monotonic()
        self._ready.wait(max(0.0, join))
        thread = self._parse_thread
        if thread is not None:
            thread.join(max(0.0, join - (time.monotonic() - t0)))
