"""Every WSL call gives wsl.exe its own stdin, never the caller's.

wsl.exe forwards its stdin into Linux. Run from the worker with the inherited stdin,
it reads the worker's JSON-RPC request pipe, and those requests are never answered
(the WSL home probe of a fresh install, with no saved case root, did this at import).
"""
from __future__ import annotations

import ast
from pathlib import Path

PY_ROOT = Path(__file__).resolve().parents[2]
CALLS = {"run", "Popen", "check_output", "call", "check_call"}


def _wsl_calls(path: Path) -> list[tuple[int, bool]]:
    src = path.read_text(encoding="utf-8")
    out: list[tuple[int, bool]] = []
    for node in ast.walk(ast.parse(src)):
        if not (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in CALLS
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "subprocess"
        ):
            continue
        # The call itself, or the function it sits in, names wsl.
        segment = ast.get_source_segment(src, node) or ""
        line_start = src.rfind("\ndef ", 0, src.find(segment)) if segment else -1
        context = src[max(0, line_start) : src.find(segment) + len(segment)] if segment else ""
        if "wsl" not in context.lower():
            continue
        keywords = {k.arg for k in node.keywords}
        out.append((node.lineno, "stdin" in keywords or "input" in keywords))
    return out


def test_every_wsl_subprocess_call_sets_its_stdin():
    missing = []
    for folder in ("cfddesk/wsl", "cfddesk/runner", "cfddesk/worker"):
        for path in sorted((PY_ROOT / folder).rglob("*.py")):
            for lineno, ok in _wsl_calls(path):
                if not ok:
                    missing.append(f"{path.relative_to(PY_ROOT).as_posix()}:{lineno}")
    assert not missing, "WSL calls without stdin= (wsl.exe would read the caller's stdin): " + ", ".join(missing)


def test_the_scan_finds_the_known_calls():
    # The scan must see the WSL home probe and the relay's slot query, or it proves nothing.
    found = {
        p.relative_to(PY_ROOT).as_posix()
        for folder in ("cfddesk/wsl", "cfddesk/runner")
        for p in (PY_ROOT / folder).rglob("*.py")
        if _wsl_calls(p)
    }
    assert {"cfddesk/wsl/config.py", "cfddesk/wsl/foam_relay.py", "cfddesk/wsl/solve_run.py"} <= found
