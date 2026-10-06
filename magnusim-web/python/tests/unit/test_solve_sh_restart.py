"""solve.sh continuing a run (RESTART=1), run in bash with a stand-in OpenFOAM.

The stand-in ``openfoam2606`` on PATH records each command and acts it out on the
folders: decomposePar copies time folders into processor folders (only the latest
with -latestTime), the solver writes two new times after the latest one,
reconstructPar copies processor times back. A restart keeps every saved time,
decomposes the latest only, and keeps the log so far as log.<app>.N.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from cfddesk.wsl.solve_run import render_solve_script

STAND_IN = r"""#!/usr/bin/env bash
# openfoam2606 bash -c "cd '<case>' && <tool> ..."
cmd="$3"
echo "$cmd" >> "$CALLS"
cd "$(echo "$cmd" | sed -E "s/^cd '([^']*)'.*/\1/")" || exit 9
times() {
  for d in "$1"/[0-9]*; do [ -d "$d" ] && basename "$d"; done | sort -g
}
latest_in() { times "$1" | tail -n 1; }
case "$cmd" in
  *decomposePar*)
    rm -rf processor*
    for r in $(seq 0 $((NP - 1))); do
      mkdir -p "processor$r/constant"
      if [[ "$cmd" == *-latestTime* ]]; then list=$(latest_in .); else list=$(times .); fi
      for t in $list; do cp -r "$t" "processor$r/$t"; done
      echo "processor$r: $(echo $list)" >> "$CALLS.decomposed"
    done ;;
  *mpirun*)
    t=$(latest_in processor0)
    for k in 1 2; do
      n=$((t + k))
      for r in $(seq 0 $((NP - 1))); do mkdir -p "processor$r/$n"; echo "new $n" > "processor$r/$n/U"; echo "new $n" > "processor$r/$n/p"; done
      echo "Time = $n"
    done ;;
  *reconstructPar*)
    for t in $(times processor0); do
      [ "$t" = "0" ] && continue
      [ -d "$t" ] || cp -r "processor0/$t" "$t"
    done ;;
  *)
    t=$(latest_in .)
    for k in 1 2; do
      n=$((t + k)); mkdir -p "$n"; echo "new $n" > "$n/U"; echo "new $n" > "$n/p"; echo "Time = $n"
    done ;;
esac
exit 0
"""


# A stand-in mv: a move of log.simpleFoam fails when FAIL_LOG_MOVE=1; any other move is the real mv.
MV = r"""#!/usr/bin/env bash
src="${@: -2:1}"
if [ "${FAIL_LOG_MOVE:-}" = "1" ] && [ "${src##*/}" = "log.simpleFoam" ]; then
  echo "mv: cannot move $src" >&2
  exit 1
fi
for m in /usr/bin/mv /bin/mv; do [ -x "$m" ] && exec "$m" "$@"; done
exit 127
"""


def _bash() -> str | None:
    if sys.platform == "win32":
        # Git's bash (the PATH's bash.exe may be WSL's).
        for root in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramW6432", "")):
            path = Path(root or ".") / "Git" / "bin" / "bash.exe"
            if root and path.is_file():
                return str(path)
        return None
    return shutil.which("bash")


BASH = _bash()
pytestmark = pytest.mark.skipif(BASH is None, reason="needs a POSIX bash")


def _posix(p: Path) -> str:
    return p.as_posix()


def _seed(win: Path) -> None:
    for t in ("0", "10", "20"):
        (win / t).mkdir(parents=True)
        for f in ("U", "p"):
            (win / t / f).write_text(f"old {t}\n", encoding="utf-8")
    (win / "constant" / "polyMesh").mkdir(parents=True)
    (win / "constant" / "polyMesh" / "owner").write_text("x\n", encoding="utf-8")
    (win / "postProcessing" / "mon" / "0").mkdir(parents=True)
    (win / "postProcessing" / "mon" / "0" / "surfaceFieldValue.dat").write_text("# Time\n1 2\n", encoding="utf-8")
    (win / "log.simpleFoam").write_text("first part\n", encoding="utf-8")


def _run(
    tmp_path: Path, win: Path, *, n_procs: int, restart: bool, tag: str, fail_log_move: bool = False
) -> tuple[subprocess.CompletedProcess, list[str]]:
    stub = tmp_path / "bin"
    stub.mkdir(exist_ok=True)
    for name, body in (("openfoam2606", STAND_IN), ("mv", MV)):
        (stub / name).write_bytes(body.encode("utf-8"))
        (stub / name).chmod(0o755)
    calls = tmp_path / f"calls-{tag}.txt"
    dst = tmp_path / "wsl" / "cfddesk-w27-r1"
    script = tmp_path / f"solve-{tag}.sh"
    script.write_bytes(
        render_solve_script(
            dst=_posix(dst),
            win_out=_posix(win),
            n_procs=n_procs,
            app="simpleFoam",
            run_id="r1",
            keep_frames="all",
            frame_fields=("U", "p"),
            restart=restart,
        ).encode("utf-8")
    )
    env = {**os.environ, "CALLS": _posix(calls), "NP": str(n_procs), "FAIL_LOG_MOVE": "1" if fail_log_move else "0"}
    # The stand-ins first on bash's own PATH (Git's bash puts /usr/bin before the Windows PATH).
    bin_dir = _posix(stub)
    if re.match(r"^[A-Za-z]:/", bin_dir):
        bin_dir = "/" + bin_dir[0].lower() + bin_dir[2:]
    proc = subprocess.run(
        [str(BASH), "-c", f'PATH="{bin_dir}:$PATH" exec bash "{_posix(script)}"'],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    lines = calls.read_text(encoding="utf-8").splitlines() if calls.is_file() else []
    return proc, lines


def _times(win: Path) -> list[str]:
    return sorted((d.name for d in win.iterdir() if d.is_dir() and d.name.isdigit()), key=int)


@pytest.mark.parametrize("n_procs", [1, 2])
def test_a_restart_keeps_the_times_and_the_log_parts(tmp_path: Path, n_procs: int):
    win = tmp_path / "case"
    _seed(win)
    proc, calls = _run(tmp_path, win, n_procs=n_procs, restart=True, tag="a")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert '"event":"result","ok":true' in proc.stdout
    # The saved times stay as they were; the new ones come after the latest.
    assert _times(win) == ["0", "10", "20", "21", "22"]
    for t in ("10", "20"):
        assert (win / t / "U").read_text(encoding="utf-8") == f"old {t}\n"
    assert (win / "22" / "U").read_text(encoding="utf-8") == "new 22\n"
    assert (win / "postProcessing" / "mon" / "0" / "surfaceFieldValue.dat").is_file()
    # The log so far is the first part; the new log is log.simpleFoam.
    assert (win / "log.simpleFoam.1").read_text(encoding="utf-8") == "first part\n"
    assert "Time = 22" in (win / "log.simpleFoam").read_text(encoding="utf-8")
    if n_procs > 1:
        assert [c for c in calls if "decomposePar" in c] == [f"cd '{_posix(tmp_path / 'wsl' / 'cfddesk-w27-r1')}' && decomposePar -force -latestTime"]
        decomposed = (tmp_path / "calls-a.txt.decomposed").read_text(encoding="utf-8").splitlines()
        assert decomposed == ["processor0: 20", "processor1: 20"], "only the latest time is decomposed"
    else:
        assert not any("decomposePar" in c for c in calls)

    # Continued again: the next part.
    proc, _calls = _run(tmp_path, win, n_procs=n_procs, restart=True, tag="b")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _times(win) == ["0", "10", "20", "21", "22", "23", "24"]
    assert (win / "log.simpleFoam.1").read_text(encoding="utf-8") == "first part\n"
    assert "Time = 22" in (win / "log.simpleFoam.2").read_text(encoding="utf-8")
    assert "Time = 24" in (win / "log.simpleFoam").read_text(encoding="utf-8")


def test_a_log_that_cannot_be_kept_is_a_warning_and_the_run_goes_on(tmp_path: Path):
    win = tmp_path / "case"
    _seed(win)
    proc, _calls = _run(tmp_path, win, n_procs=1, restart=True, tag="w", fail_log_move=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    events = [json.loads(line.split(" ", 1)[1]) for line in proc.stdout.splitlines() if line.startswith("MAGNUSIM_EVENT ")]
    assert {"event": "warning", "code": "log_kept", "message": "The earlier solver log could not be kept"} in events
    assert events[-1]["event"] == "result" and events[-1]["ok"] is True
    assert not (win / "log.simpleFoam.1").exists()
    assert _times(win) == ["0", "10", "20", "21", "22"]
    # Without a failure there is no warning.
    win2 = tmp_path / "case2"
    _seed(win2)
    proc, _calls = _run(tmp_path, win2, n_procs=1, restart=True, tag="w2")
    assert '"event":"warning"' not in proc.stdout


def test_a_plain_solve_decomposes_every_time_and_replaces_the_log(tmp_path: Path):
    win = tmp_path / "case"
    _seed(win)
    proc, calls = _run(tmp_path, win, n_procs=2, restart=False, tag="c")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert [c.split("&& ", 1)[1] for c in calls if "decomposePar" in c] == ["decomposePar -force"]
    assert not (win / "log.simpleFoam.1").exists()
    assert "first part" not in (win / "log.simpleFoam").read_text(encoding="utf-8")
