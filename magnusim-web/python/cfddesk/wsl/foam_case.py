"""Plugin OpenFOAM cases and step-list runs (API 1.3): the case checks, the one
WSL step table and ``foam_pre.sh``.

- :func:`check_case_paths`: the folder exists, nothing inside is a link or a
  junction, and its WSL path has no character or placeholder the WSL scripts
  cannot take.
- :func:`check_case_local`: that, plus the ``controlDict`` rules, the mesh, the
  files each step needs, "already ran", the app name, the steps and the
  ``results`` rules. ``foam.check_case`` (submit) adds the registry check; the
  relay runs it at its gate, or after the prepare step that writes the case.
- :data:`STEP_TABLE`: the WSL steps any plan may run (meshing utilities
  included), their flags and the ``decomposePar`` … ``reconstructParMesh``
  spans whose steps run in parallel. There is no JS copy.
- :func:`render_foam_pre`: ``templates/foam_pre.sh`` for a list of steps,
  rendered in one pass.

Every refusal is a :class:`FoamCaseError` with a fixed text that names only
case-relative paths.
"""

from __future__ import annotations

import json
import math
import os
import re
import shlex
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cfddesk.registry.contract import APP_NAME_RE, LEGACY_FRAME_FIELDS, field_name_ok
from cfddesk.runner.case_id import InvalidWslCaseId, slugify_wsl_case_id, validate_wsl_case_id
from cfddesk.wsl.mesh_run import windows_to_wsl_path


class FoamCaseError(ValueError):
    """A refusal: ``code`` (not_found, invalid_path, not_a_case, has_results,
    app_not_allowed, pre_not_allowed, bad_request) and a fixed text."""

    def __init__(self, code: str, error: str) -> None:
        super().__init__(error)
        self.code = code
        self.error = error

    def answer(self) -> dict[str, Any]:
        return {"ok": False, "code": self.code, "error": self.error}


@dataclass(frozen=True)
class StepRule:
    """One row of the WSL step table."""

    flags: frozenset[str]
    host_adds: tuple[str, ...] = ()
    needs: str | None = None
    parallel: bool = False
    path_arg: bool = False


STEP_TABLE: dict[str, StepRule] = {
    "blockMesh": StepRule(frozenset(), needs="system/blockMeshDict"),
    "gmshToFoam": StepRule(frozenset({"-keepOrientation"}), path_arg=True),
    "surfaceFeatureExtract": StepRule(frozenset(), needs="system/surfaceFeatureExtractDict"),
    "snappyHexMesh": StepRule(frozenset({"-overwrite"}), ("-overwrite",), "system/snappyHexMeshDict", True),
    "extrudeMesh": StepRule(frozenset(), needs="system/extrudeMeshDict"),
    "changeDictionary": StepRule(frozenset(), needs="system/changeDictionaryDict", parallel=True),
    "createPatch": StepRule(frozenset({"-overwrite"}), ("-overwrite",), "system/createPatchDict", True),
    "checkMesh": StepRule(frozenset({"-allGeometry", "-allTopology"}), parallel=True),
    "renumberMesh": StepRule(frozenset({"-overwrite"}), ("-overwrite",), parallel=True),
    # A potential-flow start (a core solve's case_pre_steps): writes U, p and phi into
    # 0/. Serial only: a span ends in reconstructParMesh, which brings back the mesh
    # but not the processors' 0/ fields, so a parallel run's start would be lost.
    "potentialFoam": StepRule(frozenset({"-writep", "-writephi", "-initialiseUBCs"}), needs="system/fvSolution"),
    "decomposePar": StepRule(frozenset({"-force"}), ("-force",)),
    "reconstructParMesh": StepRule(frozenset({"-constant"}), ("-constant",)),
}
SPAN_OPEN = "decomposePar"
SPAN_CLOSE = "reconstructParMesh"
MESH_MAKERS = ("blockMesh", "gmshToFoam")
MAX_STEPS = 16
MAX_ARGS = 4
MAX_ARG_LEN = 120

FLAG_RE = re.compile(r"^-[A-Za-z][A-Za-z0-9]*$")
PATH_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$")
PLACEHOLDER_RE = re.compile(r"__[A-Z][A-Z0-9_]*__")
TIME_DIR_RE = re.compile(r"^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$")
PF_CASE_RE = re.compile(r"^cfddesk-pf-[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{8}$")
CORE_CASE_PREFIX = "cfddesk-w27-"
TOKEN_RE = re.compile(r"^[0-9a-f]{8}$")
_SHOWN_RE = re.compile(r"^[A-Za-z0-9_./-]{1,40}$")
_TOOL_SHOWN_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,63}$")
_BAD_WSL_CHARS = ("$", "`", '"', "\\")
MAX_FRAME_FIELDS = 8
MAX_KINEMATIC_FIELDS = 16

STOP_MARKER = ".magnusim-stop"
RAN_MARKER = ".magnusim-ran"
STATUS_FILE = ".magnusim-run.json"
NOT_AGAIN = "This case already ran. Write a new case folder for each run."
ROOT_UNUSABLE = "The WSL case folder setting is not usable"


# ---------------------------------------------------------------------------
# Names and paths (§7.6)
# ---------------------------------------------------------------------------


def _bad_char(text: str, *, quote: bool) -> str | None:
    for ch in text:
        if ch in _BAD_WSL_CHARS or (quote and ch == "'"):
            return ch
        if ord(ch) < 32 or ord(ch) == 127:
            return f"\\x{ord(ch):02x}"
    return None


def wsl_path_problem(wsl_path: str, *, what: str = "projects folder", quote: bool = False) -> str | None:
    """Why a WSL path cannot go into the WSL scripts (a character, a placeholder), or None.

    ``quote``: also refuse ``'`` (the temp folder: ``wsl -- bash <script>`` reads it as a
    command line). The case's own path may hold ``'``: it is always double-quoted.
    """
    ch = _bad_char(wsl_path, quote=quote)
    if ch is not None:
        return f"The {what} path has a character the WSL scripts cannot take: {ch}"
    m = PLACEHOLDER_RE.search(wsl_path)
    if m:
        return f"The case path has a name the WSL scripts cannot take: {m.group(0)}"
    return None


def wsl_root_ok(root: Any) -> bool:
    """The WSL case root rule: absolute, at most 200 characters, plain parts, no
    placeholder, no ``$`` `` ` `` ``"`` ``\\`` control character or ``'``."""
    if not isinstance(root, str) or not root.startswith("/") or len(root) > 200:
        return False
    parts = root.split("/")[1:]
    if not parts or any(p in ("", ".", "..") for p in parts):
        return False
    if PLACEHOLDER_RE.search(root):
        return False
    return _bad_char(root, quote=True) is None


def temp_path_problem(temp_dir: str | Path) -> str | None:
    """The relay's temp folder, as WSL sees it, must take neither ``$`` nor ``'`` (§7.6)."""
    try:
        wsl = windows_to_wsl_path(Path(temp_dir))
    except (OSError, ValueError):
        return "The temp folder path could not be read"
    return wsl_path_problem(wsl, what="temp folder", quote=True)


def plugin_case_id_ok(wsl_case: Any, token: Any) -> bool:
    """A plugin case's WSL id: ``cfddesk-pf-<plugin>-<study>-<token>``, already a slug."""
    if not isinstance(wsl_case, str) or not isinstance(token, str) or not TOKEN_RE.match(token):
        return False
    try:
        if slugify_wsl_case_id(wsl_case) != wsl_case:
            return False
        validate_wsl_case_id(wsl_case)
    except InvalidWslCaseId:
        return False
    return bool(PF_CASE_RE.match(wsl_case)) and wsl_case.endswith("-" + token)


def solve_case_id_ok(wsl_case: Any, run_id: Any, token: Any) -> bool:
    """A core solve's WSL id: ``cfddesk-w27-<run id>``, the name core runs always had
    (the prune rules and the legacy stop know it). The token still names the run's
    scripts, so it must be one."""
    if not isinstance(wsl_case, str) or not isinstance(run_id, str) or not run_id:
        return False
    if not isinstance(token, str) or not TOKEN_RE.match(token):
        return False
    if wsl_case != CORE_CASE_PREFIX + run_id:
        return False
    try:
        return validate_wsl_case_id(wsl_case) == wsl_case
    except InvalidWslCaseId:
        return False


# ---------------------------------------------------------------------------
# Links (Python 3.10: scandir, never through a link)
# ---------------------------------------------------------------------------


# The Windows reparse tags for a symlink and a junction. Only Windows Python has
# them in ``stat``; the values are fixed by Windows, so the rule reads the same
# (and is testable) on every OS.
IO_REPARSE_TAG_SYMLINK: int = getattr(stat, "IO_REPARSE_TAG_SYMLINK", 0xA000000C)
IO_REPARSE_TAG_MOUNT_POINT: int = getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003)


def is_link(st: os.stat_result, is_symlink: bool) -> bool:
    """A link or junction. On Windows by reparse tag (cloud files are allowed);
    elsewhere a symlink."""
    if sys.platform == "win32":
        tag = getattr(st, "st_reparse_tag", 0)
        return tag in (IO_REPARSE_TAG_SYMLINK, IO_REPARSE_TAG_MOUNT_POINT)
    return is_symlink


def first_link_inside(root: Path) -> str | None:
    """The case-relative path of the first link or junction under ``root``, or None."""
    stack: list[tuple[str, str]] = [(str(root), "")]
    while stack:
        folder, rel = stack.pop()
        with os.scandir(folder) as it:
            entries = sorted(it, key=lambda e: e.name)
        for entry in entries:
            shown = f"{rel}/{entry.name}" if rel else entry.name
            st = entry.stat(follow_symlinks=False)
            if is_link(st, entry.is_symlink()):
                return shown
            if stat.S_ISDIR(st.st_mode):
                stack.append((entry.path, shown))
    return None


def _root_is_link(path: Path) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return is_link(st, path.is_symlink())


def check_case_paths(case_dir: str | Path) -> Path:
    """The path part of the case check (``not_found``, ``invalid_path``)."""
    raw = Path(str(case_dir or ""))
    if not str(case_dir or "") or not raw.is_dir():
        raise FoamCaseError("not_found", "The case folder is missing")
    if _root_is_link(raw):
        raise FoamCaseError("invalid_path", "The case folder is a link or junction")
    problem = wsl_path_problem(windows_to_wsl_path(raw))
    if problem:
        raise FoamCaseError("invalid_path", problem)
    try:
        inside = first_link_inside(raw)
    except OSError:
        raise FoamCaseError("invalid_path", "The case folder could not be read") from None
    if inside is not None:
        raise FoamCaseError("invalid_path", f"The case has a link or junction inside: {inside}")
    return raw


# ---------------------------------------------------------------------------
# The WSL step table (§7.5)
# ---------------------------------------------------------------------------


def _step_err(index: int, tool: str, text: str) -> FoamCaseError:
    return FoamCaseError("pre_not_allowed", f"Step {index} ({tool}): {text}")


def _shown(arg: str) -> str:
    return arg if _SHOWN_RE.match(arg) else "this argument"


def _path_arg_problem(arg: str) -> str | None:
    if not PATH_RE.match(arg) or any(part == ".." for part in arg.split("/")) or PLACEHOLDER_RE.search(arg):
        return "the path must be a plain path inside the case"
    if not arg.endswith(".msh"):
        return "the path must name a .msh file"
    return None


def _one_step(index: int, raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise FoamCaseError("pre_not_allowed", f"Step {index}: a step is {{tool, args, parallel}}")
    extra = sorted(set(raw) - {"tool", "args", "parallel"})
    if extra:
        raise FoamCaseError("pre_not_allowed", f"Step {index}: only tool, args and parallel are allowed")
    tool = raw.get("tool")
    if not isinstance(tool, str) or tool not in STEP_TABLE:
        if isinstance(tool, str) and _TOOL_SHOWN_RE.match(tool):
            raise FoamCaseError("pre_not_allowed", f"Step {index} ({tool}): {tool} is not an allowed step")
        raise FoamCaseError("pre_not_allowed", f"Step {index}: the tool is not an allowed step")
    rule = STEP_TABLE[tool]
    args = raw.get("args", [])
    if args is None:
        args = []
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise _step_err(index, tool, "args must be a list of strings")
    if len(args) > MAX_ARGS:
        raise _step_err(index, tool, f"at most {MAX_ARGS} arguments")
    for arg in args:
        if len(arg) > MAX_ARG_LEN:
            raise _step_err(index, tool, f"an argument is longer than {MAX_ARG_LEN} characters")
    parallel = raw.get("parallel", False)
    if parallel is None:
        parallel = False
    if not isinstance(parallel, bool):
        raise _step_err(index, tool, "parallel must be true or false")
    if parallel and not rule.parallel:
        raise _step_err(index, tool, "it cannot run in parallel")
    flags: list[str] = []
    path: str | None = None
    for pos, arg in enumerate(args):
        if FLAG_RE.match(arg):
            if arg not in rule.flags:
                raise _step_err(index, tool, f"{arg} is not allowed")
            if arg in flags:
                raise _step_err(index, tool, f"{arg} is given twice")
            if path is not None:
                raise _step_err(index, tool, f"{arg} must come before the path")
            flags.append(arg)
            continue
        if rule.path_arg and pos == len(args) - 1:
            why = _path_arg_problem(arg)
            if why:
                raise _step_err(index, tool, why)
            path = arg
            continue
        raise _step_err(index, tool, f"{_shown(arg)} is not allowed")
    if rule.path_arg and path is None:
        raise _step_err(index, tool, "needs the path of a .msh file in the case")
    out = flags + [flag for flag in rule.host_adds if flag not in flags]
    if path is not None:
        out.append(path)
    return {"tool": tool, "args": out, "parallel": parallel}


def check_steps(pre: Any) -> list[dict[str, Any]]:
    """The steps, checked against the table and the span rules, with the flags the
    host adds. Raises ``pre_not_allowed``."""
    if pre is None:
        return []
    if not isinstance(pre, list):
        raise FoamCaseError("pre_not_allowed", "The steps must be a list")
    if len(pre) > MAX_STEPS:
        raise FoamCaseError("pre_not_allowed", f"At most {MAX_STEPS} steps")
    steps = [_one_step(i, raw) for i, raw in enumerate(pre, start=1)]
    open_at: int | None = None
    for i, step in enumerate(steps, start=1):
        tool = step["tool"]
        if tool == SPAN_OPEN:
            if open_at is not None:
                raise _step_err(open_at, SPAN_OPEN, f"{SPAN_CLOSE} must follow")
            open_at = i
        elif tool == SPAN_CLOSE:
            if open_at is None:
                raise _step_err(i, tool, f"{SPAN_OPEN} must come before it")
            open_at = None
        elif open_at is not None and not step["parallel"]:
            raise _step_err(i, tool, f"steps between {SPAN_OPEN} and {SPAN_CLOSE} run in parallel")
        elif open_at is None and step["parallel"]:
            raise _step_err(i, tool, f"a parallel step needs {SPAN_OPEN} before it")
    if open_at is not None:
        raise _step_err(open_at, SPAN_OPEN, f"{SPAN_CLOSE} must follow")
    return steps


def has_parallel_step(steps: list[dict[str, Any]]) -> bool:
    return any(bool(step.get("parallel")) for step in steps)


def _lenient_needs(pre: Any) -> tuple[list[str], list[tuple[int, str, str]]]:
    """(tools, [(index, tool, file)]) of the steps that name a known tool, for the
    "needs in the case" rule (the full step check comes later)."""
    tools: list[str] = []
    needs: list[tuple[int, str, str]] = []
    if not isinstance(pre, list):
        return tools, needs
    for i, raw in enumerate(pre, start=1):
        tool = raw.get("tool") if isinstance(raw, dict) else None
        if not isinstance(tool, str) or tool not in STEP_TABLE:
            continue
        tools.append(tool)
        rule = STEP_TABLE[tool]
        if rule.needs:
            needs.append((i, tool, rule.needs))
        args = raw.get("args")
        if rule.path_arg and isinstance(args, list) and args and isinstance(args[-1], str):
            if _path_arg_problem(args[-1]) is None:
                needs.append((i, tool, args[-1]))
    return tools, needs


# ---------------------------------------------------------------------------
# controlDict
# ---------------------------------------------------------------------------


def _strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def top_level_text(text: str) -> str:
    """The dictionary's top level: comments and every ``{…}`` block removed."""
    out: list[str] = []
    depth = 0
    for ch in _strip_comments(text):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(ch)
    return "".join(out)


def dict_entry(top: str, key: str) -> str | None:
    m = re.search(rf"(?m)^[ \t]*{re.escape(key)}[ \t]+([^;\n]+?)[ \t]*;", top)
    if not m:
        return None
    return m.group(1).strip().strip('"').strip()


_ON = {"on", "yes", "true", "compressed"}
_MODIFIABLE = {"true", "yes", "on"}


# ---------------------------------------------------------------------------
# results (§7.4)
# ---------------------------------------------------------------------------


def _bad(text: str) -> FoamCaseError:
    return FoamCaseError("bad_request", text)


def check_results(results: Any, case: Path) -> dict[str, Any]:
    """``{rho, kinematic_fields, frame_fields}`` from a submit's ``results``."""
    if not isinstance(results, dict):
        raise _bad("results must be an object")
    extra = sorted(set(results) - {"rho", "kinematicFields", "frameFields"})
    if extra:
        raise _bad("results takes only rho, kinematicFields and frameFields")
    kinematic = results.get("kinematicFields")
    if not isinstance(kinematic, list):
        raise _bad("results.kinematicFields is required (it may be empty)")
    if len(kinematic) > MAX_KINEMATIC_FIELDS:
        raise _bad(f"results.kinematicFields: at most {MAX_KINEMATIC_FIELDS} fields")
    for name in kinematic:
        if not field_name_ok(name):
            raise _bad("results.kinematicFields: each must be a field name")
    rho = results.get("rho")
    if rho is not None or kinematic:
        if isinstance(rho, bool) or not isinstance(rho, (int, float)) or not math.isfinite(rho) or rho <= 0:
            raise _bad("results.rho must be a number above 0 when kinematicFields lists a field")
    frames = results.get("frameFields")
    if frames is None:
        # A case written before API 1.1 names no frame fields: its frames are LEGACY_FRAME_FIELDS.
        if all((case / "0" / name).is_file() for name in LEGACY_FRAME_FIELDS):
            frames = list(LEGACY_FRAME_FIELDS)
        else:
            legacy = " and ".join(f"0/{name}" for name in LEGACY_FRAME_FIELDS)
            raise _bad(f"results.frameFields is required: {legacy} are not both in the case")
    if not isinstance(frames, list) or not 1 <= len(frames) <= MAX_FRAME_FIELDS:
        raise _bad(f"results.frameFields: 1 to {MAX_FRAME_FIELDS} fields")
    for name in frames:
        if not field_name_ok(name):
            raise _bad("results.frameFields: each must be a field name")
        if not (case / "0" / name).is_file():
            raise _bad(f"results.frameFields: 0/{name} is not in the case")
    return {"rho": rho, "kinematic_fields": list(kinematic), "frame_fields": list(frames)}


# ---------------------------------------------------------------------------
# The whole check (§7.4)
# ---------------------------------------------------------------------------


CASE_SIDECAR = "w27-case.json"


def case_pre_steps(case_dir: str | Path) -> list[Any]:
    """The WSL steps a core solve's written case asks for before its solver:
    ``pre_steps`` in the case's ``w27-case.json`` (its analysis's case writer puts
    them there), [] when it names none. Only read here: :func:`check_steps`
    decides whether they may run. Raises :class:`FoamCaseError`."""
    path = Path(case_dir) / CASE_SIDECAR
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        raise FoamCaseError("not_a_case", f"{CASE_SIDECAR} could not be read") from None
    raw = doc.get("pre_steps") if isinstance(doc, dict) else None
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise FoamCaseError("pre_not_allowed", f"{CASE_SIDECAR}: pre_steps must be a list")
    return raw


def _has_results(case: Path, *, own_marker: bool) -> bool:
    if not own_marker and (case / RAN_MARKER).exists():
        return True
    for child in case.iterdir():
        if not child.is_dir():
            continue
        if child.name.startswith("processor"):
            return True
        if TIME_DIR_RE.match(child.name) and child.name != "0":
            return True
    return False


def check_case_local(
    case_dir: str | Path,
    app: str | None,
    pre: Any,
    results: Any,
    *,
    own_marker: bool = False,
    stop_strategy: str | None = None,
) -> dict[str, Any]:
    """Every case check except "a registered app"; raises :class:`FoamCaseError`.

    ``app`` None is a plan with no solver: no application rules, no
    ``writeCompression`` and no results rules, but ``system/controlDict`` must still
    exist. ``results`` None skips the results rules. ``own_marker`` ignores this
    run's own ``.magnusim-ran`` (the check after the prepare step).
    ``stop_strategy`` ``stopAt_writeNow`` needs the ``stopAt`` and
    ``runTimeModifiable`` lines a graceful Stop relies on.
    """
    case = check_case_paths(case_dir)
    if app is not None and not (isinstance(app, str) and APP_NAME_RE.match(app)):
        raise FoamCaseError("app_not_allowed", "The app must be a plain program name")
    control = case / "system" / "controlDict"
    if not control.is_file():
        raise FoamCaseError("not_a_case", "system/controlDict is missing")
    try:
        top = top_level_text(control.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        raise FoamCaseError("not_a_case", "system/controlDict could not be read") from None
    if app is not None:
        if dict_entry(top, "application") != app:
            raise FoamCaseError("not_a_case", f"system/controlDict: application is not {app}")
        if stop_strategy == "stopAt_writeNow":
            if dict_entry(top, "stopAt") is None:
                raise FoamCaseError("not_a_case", "system/controlDict needs a stopAt line (Stop saves the latest time through it)")
            if str(dict_entry(top, "runTimeModifiable") or "").lower() not in _MODIFIABLE:
                raise FoamCaseError("not_a_case", "system/controlDict needs runTimeModifiable true (Stop saves the latest time through it)")
        if str(dict_entry(top, "writeCompression") or "off").lower() in _ON:
            raise FoamCaseError("not_a_case", "system/controlDict: writeCompression must be off")
    tools, needs = _lenient_needs(pre)
    # The solver and every WSL step need a mesh; a plan with neither (a prepare
    # step alone) runs nothing in WSL.
    uses_mesh = app is not None or bool(pre)
    if uses_mesh and not (case / "constant" / "polyMesh").is_dir() and not any(t in MESH_MAKERS for t in tools):
        raise FoamCaseError("not_a_case", "constant/polyMesh is missing, and no step makes a mesh (blockMesh or gmshToFoam)")
    for index, tool, rel in needs:
        if not (case / rel).is_file():
            raise FoamCaseError("not_a_case", f"{rel} is missing (step {index}, {tool} needs it)")
    if _has_results(case, own_marker=own_marker):
        raise FoamCaseError("has_results", NOT_AGAIN)
    steps = check_steps(pre)
    out: dict[str, Any] = {"ok": True, "steps": steps, "write_format": None, "results": None}
    if app is not None:
        out["write_format"] = str(dict_entry(top, "writeFormat") or "ascii").lower()
        if results is not None:
            out["results"] = check_results(results, case)
    return out


# ---------------------------------------------------------------------------
# foam_pre.sh
# ---------------------------------------------------------------------------

_TEMPLATES = Path(__file__).resolve().parent / "templates"
_FOAM_PRE_SH = _TEMPLATES / "foam_pre.sh"
_PLACEHOLDERS = re.compile(r"__(DST|WIN_OUT|TOKEN|STEPS)__")


def foam_pre_template_path() -> Path:
    return _FOAM_PRE_SH


def foam_pre_script_name(token: str) -> str:
    return f"foam-pre-{token}.sh"


def _steps_block(steps: list[dict[str, Any]], n_procs: int) -> str:
    n = max(1, int(n_procs))
    lines: list[str] = []
    for i, step in enumerate(steps, start=1):
        tool = str(step["tool"])
        if tool not in STEP_TABLE:
            raise ValueError(f"not an allowed step: {tool!r}")
        if n == 1 and tool in (SPAN_OPEN, SPAN_CLOSE):
            lines.append(f"_step_skipped {i} {tool}")
            continue
        args = " ".join(shlex.quote(str(a)) for a in step.get("args") or [])
        parallel = bool(step.get("parallel")) and n > 1
        if parallel:
            words = f"mpirun --oversubscribe -np {n} {tool}" + (f" {args}" if args else "") + " -parallel"
        else:
            words = tool + (f" {args}" if args else "")
        lines.append("_stop_check")
        lines.append(f"STEP_{i}=({words})")
        lines.append(f'( cd "$DST" && openfoam2606 "${{STEP_{i}[@]}}" ) > "log.{tool}.{i}" 2>&1')
        lines.append(f"_step_done {i} {tool} $? {'true' if parallel else 'false'} {n if parallel else 1}")
    return "\n".join(lines)


def render_foam_pre(*, dst: str, win_out: str, token: str, steps: list[dict[str, Any]], n_procs: int) -> str:
    """``templates/foam_pre.sh`` for checked steps (:func:`check_steps`), LF, one pass:
    an inserted value is never scanned again."""
    if not TOKEN_RE.match(str(token)):
        raise ValueError(f"bad token {token!r}")
    for value, what in ((dst, "dst"), (win_out, "win_out")):
        if wsl_path_problem(str(value)):
            raise ValueError(f"{what} cannot go into the script: {value!r}")
    raw = _FOAM_PRE_SH.read_text(encoding="utf-8").lstrip("﻿")
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    values = {"DST": str(dst), "WIN_OUT": str(win_out), "TOKEN": str(token), "STEPS": _steps_block(steps, n_procs)}
    return _PLACEHOLDERS.sub(lambda m: values[m.group(1)], raw)
