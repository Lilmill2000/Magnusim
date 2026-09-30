"""A plugin's own Python environment (manifest ``[python]``, API 1.1).

::

    [python]
    requirements = "requirements.lock"   # pinned, with hashes (pip --require-hashes)
    python = ">=3.10,<3.13"              # the interpreters it supports
    service = "my_plugin_service"        # optional: its backend (magnusim_sdk.service)
    find_links = "wheels"                # optional: a folder of wheels in the plugin (offline)

The environment is ``<web root>/.cache/plugin-envs/<key>-<lock hash>/``
(``MAGNUSIM_PLUGIN_ENVS_DIR`` moves the folder; the tests use it). It is built
from the core interpreter: ``venv`` without pip, then the core's pip installs the
lock into it (``pip --python``), wheels only. It gets ``magnusim_sdk`` through a
``.pth`` file and nothing of the core, so ``import cfddesk`` fails in it, and the
core's own packages never change. A stamp (``magnusim-env.json``) marks it ready.
A new lock hash means a new folder, so editing the lock puts the plugin back to
"Needs setup". A failed build leaves ``<key>-<hash>.failed.json`` with pip's last
lines and no environment.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cfddesk.registry.manifest import PythonEnvSpec

ENV_STAMP = "magnusim-env.json"
LOCK_HASH_LEN = 16
MODULE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")
KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
_SPEC_RE = re.compile(r"^\s*(>=|<=|==|!=|>|<)\s*(\d+(?:\.\d+){0,2})\s*$")

Emit = Callable[..., None]


class EnvError(RuntimeError):
    """Building a plugin's environment failed; ``tail`` holds the last output lines."""

    def __init__(self, message: str, tail: list[str] | None = None) -> None:
        super().__init__(message)
        self.tail = list(tail or [])


# -- the manifest's [python] table ------------------------------------------------


def lock_hash(path: Path) -> str:
    """The lock file's content hash (line endings ignored)."""
    data = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()[:LOCK_HASH_LEN]


def _inside(plugin_dir: Path, rel: str, what: str) -> Path:
    root = plugin_dir.resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"{what} {rel!r} is outside the plugin folder")
    return target


def parse_python_range(text: str) -> list[tuple[str, tuple[int, ...]]]:
    """``">=3.10,<3.13"`` as (operator, version) pairs; ValueError when it is not one."""
    out: list[tuple[str, tuple[int, ...]]] = []
    for part in str(text or "").split(","):
        if not part.strip():
            continue
        m = _SPEC_RE.match(part)
        if not m:
            raise ValueError(f"python = {text!r}: {part.strip()!r} is not like '>=3.10'")
        out.append((m.group(1), tuple(int(n) for n in m.group(2).split("."))))
    return out


def python_in_range(version: tuple[int, ...], text: str) -> bool:
    for op, want in parse_python_range(text):
        have = tuple(version[: len(want)])
        ok = {
            ">=": have >= want,
            "<=": have <= want,
            ">": have > want,
            "<": have < want,
            "==": have == want,
            "!=": have != want,
        }[op]
        if not ok:
            return False
    return True


def python_env_from_meta(meta: dict[str, Any], plugin_dir: Path) -> PythonEnvSpec | None:
    """The manifest's ``[python]`` table, checked; None when the plugin has none."""
    raw = meta.get("python")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("[python] must be a table")
    requirements = str(raw.get("requirements") or "requirements.lock")
    lock = _inside(plugin_dir, requirements, "requirements")
    if not lock.is_file():
        raise ValueError(f"requirements file {requirements!r} is missing")
    service = str(raw.get("service") or "")
    if service and not MODULE_RE.match(service):
        raise ValueError(f"service {service!r} is not a module name")
    rng = str(raw.get("python") or "")
    parse_python_range(rng)
    find_links = str(raw.get("find_links") or "")
    if find_links and not _inside(plugin_dir, find_links, "find_links").is_dir():
        raise ValueError(f"find_links folder {find_links!r} is missing")
    return PythonEnvSpec(
        requirements=requirements,
        python=rng,
        service=service,
        find_links=find_links,
        lock_hash=lock_hash(lock),
    )


# -- where environments live ------------------------------------------------------


def envs_root(web_root: Path | str) -> Path:
    override = os.environ.get("MAGNUSIM_PLUGIN_ENVS_DIR", "").strip()
    return Path(override) if override else Path(web_root) / ".cache" / "plugin-envs"


def env_dir(web_root: Path | str, key: str, spec: PythonEnvSpec) -> Path:
    if not KEY_RE.match(key):
        raise ValueError(f"invalid plugin key: {key!r}")
    return envs_root(web_root) / f"{key}-{spec.lock_hash}"


def env_python(env: Path) -> Path:
    win = env / "Scripts" / "python.exe"
    return win if sys.platform == "win32" else env / "bin" / "python"


def _own_item(key: str) -> re.Pattern[str]:
    """An environment folder or failure note of this plugin (any lock hash)."""
    return re.compile(re.escape(key) + "-[0-9a-f]{" + str(LOCK_HASH_LEN) + r"}(\.failed\.json)?")


def _failed_path(web_root: Path | str, key: str, spec: PythonEnvSpec) -> Path:
    return envs_root(web_root) / f"{key}-{spec.lock_hash}.failed.json"


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def env_status(web_root: Path | str, key: str, spec: PythonEnvSpec) -> dict[str, Any]:
    """``state``: ``ready`` (with ``python``), ``failed`` (with ``error``) or ``needs_setup``."""
    env = env_dir(web_root, key, spec)
    base = {"lock_hash": spec.lock_hash, "service": spec.service, "env_dir": str(env)}
    stamp = _read_json(env / ENV_STAMP)
    py = env_python(env)
    if stamp and stamp.get("lock_hash") == spec.lock_hash and py.is_file():
        return {
            **base,
            "state": "ready",
            "python": str(py),
            "python_version": stamp.get("python_version") or "",
            "installed": list(stamp.get("installed") or []),
        }
    failed = _read_json(_failed_path(web_root, key, spec))
    if failed:
        return {**base, "state": "failed", "error": str(failed.get("error") or "Setup failed"), "tail": list(failed.get("tail") or [])}
    return {**base, "state": "needs_setup"}


# -- building one --------------------------------------------------------------------


def _run(
    args: list[str], *, what: str, timeout: float, emit: Emit | None = None, cwd: Path | None = None
) -> list[str]:
    """Run a step and return its stdout lines; all output goes to ``emit`` as log events. EnvError on failure."""
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP")}
    env.update({"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PIP_NO_INPUT": "1"})
    try:
        done = subprocess.run(
            args,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as exc:
        raise EnvError(f"{what} took longer than {timeout:g} s") from exc
    except OSError as exc:
        raise EnvError(f"{what} could not start: {exc}") from exc
    out = [ln for ln in (done.stdout or "").splitlines() if ln.strip()]
    lines = out + [ln for ln in (done.stderr or "").splitlines() if ln.strip()]
    if emit is not None:
        for ln in lines[-200:]:
            emit("log", line=ln[:400])
    if done.returncode != 0:
        raise EnvError(f"{what} failed", lines[-20:])
    return out


def _has_requirements(lock: Path) -> bool:
    for line in lock.read_text(encoding="utf-8", errors="replace").splitlines():
        text = line.strip()
        if text and not text.startswith("#") and not text.startswith("--"):
            return True
    return False


def sdk_root() -> Path:
    """The folder holding ``magnusim_sdk`` (what the environment's ``.pth`` adds)."""
    import magnusim_sdk

    return Path(magnusim_sdk.__file__).resolve().parents[1]


_VERIFY = (
    "import importlib.util, json, sys; import magnusim_sdk; "
    "print(json.dumps({'sdk': magnusim_sdk.SDK_VERSION, "
    "'cfddesk': importlib.util.find_spec('cfddesk') is not None, "
    "'python': '.'.join(map(str, sys.version_info[:3]))}))"
)


def create_env(
    web_root: Path | str,
    key: str,
    spec: PythonEnvSpec,
    plugin_dir: Path,
    *,
    emit: Emit | None = None,
    core_python: str | None = None,
) -> dict[str, Any]:
    """Build (or rebuild) the plugin's environment for its current lock. EnvError on failure."""
    say = emit or (lambda *_a, **_k: None)
    core = core_python or sys.executable
    root = envs_root(web_root)
    root.mkdir(parents=True, exist_ok=True)
    env = env_dir(web_root, key, spec)
    failed = _failed_path(web_root, key, spec)
    failed.unlink(missing_ok=True)
    try:
        if env.exists():
            shutil.rmtree(env)
        say("stage", stage="venv", label="Creating the environment")
        _run([core, "-m", "venv", "--without-pip", str(env)], what="Creating the environment", timeout=300)
        py = env_python(env)
        probe = "import json, sys; print(json.dumps(list(sys.version_info[:3])))"
        info = json.loads(_run([str(py), "-I", "-S", "-c", probe], what="Reading its Python version", timeout=60)[-1])
        version = tuple(int(n) for n in info)
        if spec.python and not python_in_range(version, spec.python):
            raise EnvError(f"needs Python {spec.python}; the app's Python is {'.'.join(map(str, version))}")
        purelib = Path(
            _run(
                [str(py), "-I", "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
                what="Finding its site-packages",
                timeout=60,
            )[-1].strip()
        )
        purelib.mkdir(parents=True, exist_ok=True)
        # The SDK and nothing of the core: python/sdk only, never python/.
        (purelib / "magnusim_sdk.pth").write_text(str(sdk_root()) + "\n", encoding="utf-8")
        lock = _inside(plugin_dir, spec.requirements, "requirements")
        if _has_requirements(lock):
            say("stage", stage="pip", label="Installing dependencies")
            args = [
                core, "-m", "pip", "--python", str(py), "install",
                "--disable-pip-version-check", "--no-input", "--require-hashes", "--only-binary=:all:",
                "-r", str(lock),
            ]  # fmt: skip
            if spec.find_links:
                args += ["--no-index", "--find-links", str(_inside(plugin_dir, spec.find_links, "find_links"))]
            _run(args, what="Installing dependencies", timeout=1800, emit=say, cwd=plugin_dir)
        say("stage", stage="verify", label="Checking the environment")
        check = json.loads(_run([str(py), "-I", "-c", _VERIFY], what="Checking the environment", timeout=60)[-1])
        if check.get("cfddesk"):
            raise EnvError("the environment can import the core (cfddesk); it must see only magnusim_sdk")
        listed = _run(
            [core, "-m", "pip", "--python", str(py), "list", "--format=json", "--disable-pip-version-check"],
            what="Listing its packages",
            timeout=120,
        )
        installed = sorted(str(row.get("name")) for row in json.loads(listed[-1]) if isinstance(row, dict))
        stamp = {
            "key": key,
            "lock_hash": spec.lock_hash,
            "python_version": ".".join(map(str, version)),
            "sdk_version": check.get("sdk"),
            "installed": installed,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        (env / ENV_STAMP).write_text(json.dumps(stamp, indent=2) + "\n", encoding="utf-8")
    except (EnvError, OSError, ValueError) as exc:
        tail = exc.tail if isinstance(exc, EnvError) else []
        shutil.rmtree(env, ignore_errors=True)
        failed.write_text(
            json.dumps({"error": str(exc), "tail": tail, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}, indent=2),
            encoding="utf-8",
        )
        raise EnvError(str(exc), tail) from exc
    # Environments for older locks of this plugin are no longer used.
    for other in root.glob(f"{key}-*"):
        if other != env and _own_item(key).fullmatch(other.name):
            if other.is_dir():
                shutil.rmtree(other, ignore_errors=True)
            else:
                other.unlink(missing_ok=True)
    say("stage", stage="done", label="Ready")
    return env_status(web_root, key, spec)


def remove_envs(web_root: Path | str, key: str) -> list[str]:
    """Delete every environment (and failure note) of this plugin; returns what was removed."""
    if not KEY_RE.match(key):
        raise ValueError(f"invalid plugin key: {key!r}")
    root = envs_root(web_root)
    removed: list[str] = []
    if not root.is_dir():
        return removed
    pattern = _own_item(key)
    for item in root.iterdir():
        if not pattern.fullmatch(item.name):
            continue
        if item.is_dir():
            shutil.rmtree(item, ignore_errors=True)
        else:
            item.unlink(missing_ok=True)
        removed.append(item.name)
    return removed
