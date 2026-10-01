"""The WSL case sweep against a real WSL folder (a throwaway root under /tmp).

Deselected by default (``pytest -m wsl`` runs it). ctime cannot be set back, so
"old" is max_age_hours=0 and "fresh" is the default 24 h on the same new folders.
"""
from __future__ import annotations

import shlex
import uuid

import pytest

from cfddesk.runner.cleanup import prune_wsl_cases
from cfddesk.wsl.openfoam import run_wsl_bash

pytestmark = pytest.mark.wsl

OLD = ["cfddesk-w27-old1", "cfddesk-cfdweb-old2", "cfddesk-w25-run-copy-abc-1"]
BUSY_CWD = "cfddesk-w27-busycwd"
BUSY_CMD = "cfddesk-w27-busycmd"
# Never swept: reserved ids, names the app does not make, a link.
FOREIGN = ["cfddesk-manual-keep", "cfddesk-cfmesh", "zz-exp-base", "bench-ball", "cfddesk-Bad Name", "cfddesk-w27-UPPER"]
LINK = "cfddesk-w27-link"


def _sh(cmd: str) -> str:
    r = run_wsl_bash(cmd, timeout=60)
    assert r.returncode == 0, f"{cmd}\n{r.stdout}\n{r.stderr}"
    return r.stdout


def _names(root: str) -> set[str]:
    out = _sh(f"ls -A {shlex.quote(root)}")
    return {line for line in out.splitlines() if line}


@pytest.fixture
def case_root():
    tag = uuid.uuid4().hex[:12]
    base = f"/tmp/magnusim-prune-test-{tag}"
    root = f"{base}/cases"
    marker = f"magnusim-prune-test-{tag}"
    # Anchored: only the holders' command lines start with the marker (the
    # shells running pgrep/pkill name it too).
    pat = shlex.quote(f"^magnusim-prune-test-{tag}-")
    q = shlex.quote
    parts = [f"mkdir -p {q(root)} {q(base)}/outside", f"touch {q(base)}/outside/keep.txt"]
    for name in [*OLD, BUSY_CWD, BUSY_CMD, *FOREIGN]:
        parts.append(f"mkdir -p {q(f'{root}/{name}')}/system && echo x > {q(f'{root}/{name}')}/system/controlDict")
    parts.append(f"ln -s {q(base)}/outside {q(f'{root}/{LINK}')}")
    # A sweep that died part way left its trash (pid 999999 is not running).
    parts.append(f"mkdir -p {q(root)}/.magnusim-prune-999999/cfddesk-w27-x && touch {q(root)}/.magnusim-prune-999999/cfddesk-w27-x/f")
    # One process works in a case, another names a case on its command line.
    parts.append(
        f"cd {q(f'{root}/{BUSY_CWD}')} && (setsid bash -c 'exec -a {marker}-cwd sleep 600' </dev/null >/dev/null 2>&1 &)"
    )
    parts.append(
        f"cd / && (setsid bash -c 'exec -a {marker}-cmd:{root}/{BUSY_CMD}/system/controlDict sleep 600' </dev/null >/dev/null 2>&1 &)"
    )
    # Wait for both holders in the same shell: WSL ends a session's processes
    # when its shell exits, before a just-forked child reaches setsid.
    parts.append(f"for i in $(seq 50); do [ $(pgrep -fc {pat}) -ge 2 ] && exit 0; sleep 0.1; done; exit 1")
    try:
        _sh(" && ".join(parts))
        yield root
    finally:
        run_wsl_bash(f"pkill -f {pat}; rm -rf -- {q(base)}", timeout=60)


def test_sweep_keeps_everything_changed_within_the_age(case_root):
    before = _names(case_root)
    doc = prune_wsl_cases(root=case_root, max_age_hours=24)
    assert doc["ok"] is True, doc
    assert doc["removed"] == 0
    assert doc["kept_recent"] == len(OLD)
    assert doc["kept_busy"] == 2
    assert _names(case_root) == before - {".magnusim-prune-999999"}


def test_dry_run_counts_without_removing(case_root):
    doc = prune_wsl_cases(root=case_root, max_age_hours=0, dry_run=True)
    assert doc["ok"] is True, doc
    assert doc["dry_run"] is True
    assert doc["removed"] == len(OLD)
    assert doc["freed_kb"] > 0
    assert set(OLD) <= _names(case_root)


def test_sweep_removes_only_finished_app_cases(case_root):
    doc = prune_wsl_cases(root=case_root, max_age_hours=0)
    assert doc["ok"] is True, doc
    assert doc["removed"] == len(OLD)
    assert doc["kept_busy"] == 2
    assert doc["root"] == case_root
    left = _names(case_root)
    assert not (set(OLD) & left)
    assert {BUSY_CWD, BUSY_CMD, LINK, *FOREIGN} <= left
    # No trash left behind, the dead sweep's included.
    assert not [n for n in left if n.startswith(".magnusim-prune-")]
    # The link was not followed.
    base = case_root.rsplit("/", 1)[0]
    _sh(f"test -f {shlex.quote(base)}/outside/keep.txt")


@pytest.mark.parametrize("root", ["/", "/tmp", "/home/drmil", "/tmp/x/cases/", "/tmp/../cases", "cases", "/tmp/a b/cases"])
def test_sweep_refuses_a_root_that_is_not_a_case_root(root):
    doc = prune_wsl_cases(root=root, max_age_hours=0, dry_run=True)
    if root == "/tmp/x/cases/":
        # A trailing slash is trimmed; the folder does not exist, so nothing to do.
        assert doc["ok"] is True and doc["removed"] == 0
        return
    assert doc["ok"] is False
    assert "case root" in doc["error"]


def test_missing_root_is_nothing_to_do():
    doc = prune_wsl_cases(root=f"/tmp/magnusim-prune-none-{uuid.uuid4().hex[:8]}/cases", max_age_hours=0)
    assert doc["ok"] is True
    assert doc["removed"] == 0
