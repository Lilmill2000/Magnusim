"""OpenFOAM dictionary and field writers (ASCII headers, LF line endings).

The byte layout matches the product case writer's goldens: a plain
``FoamFile`` header with no C++ banner, and ``write_vol_field`` spacing.
"""

from __future__ import annotations

import math
import re
from pathlib import Path


def write_text_lf(path: Path, text: str) -> None:
    """Write ``text`` as UTF-8 with LF line endings, creating parent folders."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))


def foam_header(cls: str, obj: str) -> str:
    return (
        "FoamFile\n"
        "{\n"
        "    version     2.0;\n"
        "    format      ascii;\n"
        f"    class       {cls};\n"
        f"    object      {obj};\n"
        "}\n"
    )


def write_foam_dict(path: Path, cls: str, obj: str, body: str) -> None:
    write_text_lf(path, foam_header(cls, obj) + "\n" + body.strip() + "\n")


def write_vol_field(
    path: Path,
    *,
    object_name: str,
    cls: str,
    dims: str,
    internal: str,
    patches: dict[str, dict[str, str]],
) -> None:
    lines = [
        foam_header(cls, object_name).rstrip("\n"),
        "",
        f"dimensions      {dims};",
        "",
        f"internalField   {internal};",
        "",
        "boundaryField",
        "{",
    ]
    for name, block in patches.items():
        lines.append(f"    {name}")
        lines.append("    {")
        for k, v in block.items():
            lines.append(f"        {k}          {v};")
        lines.append("    }")
    lines.append("}")
    lines.append("")
    write_text_lf(path, "\n".join(lines))


def js_plain_float(v: float) -> str:
    """A number the way JavaScript prints it by default (no exponent, no trailing zeros)."""
    if not math.isfinite(v):
        return "0"
    if v == 0:
        return "0"
    s = format(float(v), ".15f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s or "0"


def write_decompose_par_dict(path: Path, n_subdomains: int, method: str = "scotch") -> None:
    """``system/decomposeParDict`` for ``n_subdomains`` ranks."""
    write_foam_dict(
        path,
        "dictionary",
        "decomposeParDict",
        f"numberOfSubdomains {int(n_subdomains)};\nmethod          {method};",
    )


def parse_boundary_patch_types(path: Path) -> dict[str, str]:
    """Patch name -> type from a ``constant/polyMesh/boundary`` file."""
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    text = re.sub(r"FoamFile\s*\{.*?\}\s*", "", text, count=1, flags=re.S)
    types: dict[str, str] = {}
    for m in re.finditer(
        r"(?m)^\s*([A-Za-z_][\w]*)\s*\n\s*\{\s*\n\s*type\s+([A-Za-z_]\w*)\s*;",
        text,
    ):
        types[m.group(1)] = m.group(2)
    return types


def dictionary_header(object_name: str) -> str:
    """``FoamFile`` header of a dictionary, followed by the banner rule line."""
    # No C++ banner: a trailing '\\' on the banner line comments out FoamFile.
    return (
        "FoamFile\n"
        "{\n"
        "    version     2.0;\n"
        "    format      ascii;\n"
        "    class       dictionary;\n"
        f"    object      {object_name};\n"
        "}\n"
        "// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //\n"
    )


def write_foam_text(path: Path, text: str) -> None:
    """Write an OpenFOAM dictionary as ASCII with LF line endings (CRLF breaks Foam parsers)."""
    Path(path).write_bytes(text.replace("\r\n", "\n").encode("ascii", errors="strict"))


def boundary_patch_names(boundary_path: Path) -> list[str]:
    """Patch names in a ``constant/polyMesh/boundary`` file, in file order.

    OpenFOAM writes indented names before a ``{`` / ``type`` block; the header
    of a binary mesh's boundary file is still ASCII.
    """
    path = Path(boundary_path)
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    names: list[str] = []
    for m in re.finditer(
        r"(?m)^\s+([A-Za-z_][A-Za-z0-9_]*)\s*\r?\n\s*\{\s*\r?\n\s*type\s+(\S+);",
        text,
    ):
        if m.group(1) != "FoamFile":
            names.append(m.group(1))
    return names


def _num_or_none(text: str) -> float | None:
    try:
        v = float(text)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def parse_surface_field_value(text: str) -> dict:
    """One ``surfaceFieldValue.dat``: ``{area, faces, columns, rows}``.

    Rows are ``[time, value, …]``; a vector value ``(a b c)`` is a list.
    Numbers that do not parse are None.
    """
    out: dict = {"area": None, "faces": None, "columns": [], "rows": []}
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            m = re.match(r"^#\s*Area\s*:\s*([0-9.eE+-]+)", line)
            if m:
                out["area"] = _num_or_none(m.group(1))
            m = re.match(r"^#\s*Faces\s*:\s*(\d+)", line)
            if m:
                out["faces"] = int(m.group(1))
            m = re.match(r"^#\s*Time\s+(.*)$", line)
            if m:
                out["columns"] = m.group(1).strip().split()
            continue
        toks: list = []
        for t in re.finditer(r"\(([^)]*)\)|([0-9.eE+-]+)", line):
            if t.group(1) is not None:
                toks.append([_num_or_none(x) for x in t.group(1).strip().split()])
            else:
                toks.append(_num_or_none(t.group(2)))
        if not toks or not isinstance(toks[0], float):
            continue
        out["rows"].append(toks)
    return out


def start_time_folders(folder: Path) -> list[Path]:
    """The start-time folders of a function object's folder, oldest first (a
    continued run starts a new one). Times may be written with an exponent."""
    try:
        found = [d for d in Path(folder).iterdir() if d.is_dir() and re.fullmatch(r"\d+(\.\d+)?([eE][-+]?\d+)?", d.name)]
    except OSError:
        return []
    return sorted(found, key=lambda d: float(d.name))


def restart_dat_files(folder: Path, stem: str) -> list[Path]:
    """A function object's ``<stem>.dat`` files in each start-time folder of
    ``folder`` (``postProcessing/<name>``), oldest first.

    A continued run starts a new start-time folder. A run started again from the
    same time finds ``<stem>.dat`` there and OpenFOAM writes ``<stem>_<time>.dat``
    beside it: that one is the later. Times may be written with an exponent.
    """
    out: list[Path] = []
    for d in start_time_folders(folder):
        for f in (d / f"{stem}.dat", d / f"{stem}_{d.name}.dat"):
            if f.is_file():
                out.append(f)
    return out


def function_object_folder(case_dir: Path, name: str, region: str = "") -> Path | None:
    """The folder function object ``name`` writes its start-time folders in, or None.

    ``postProcessing/<name>`` in a case of one region. In a multi-region case
    (host API 1.8) a function object given ``region <r>`` writes to
    ``postProcessing/<r>/<name>`` (field function objects: wallHeatFlux,
    volFieldValue, surfaceFieldValue) or ``postProcessing/<name>/<r>`` (probes);
    the first that exists.
    """
    root = Path(case_dir) / "postProcessing"
    places = [root / region / name, root / name / region] if region else [root / name]
    for folder in places:
        if folder.is_dir():
            return folder
    return None


def function_object_files(case_dir: Path, name: str, filename: str, region: str = "") -> list[Path]:
    """File ``filename`` of function object ``name`` in each of its start-time
    folders, oldest first (:func:`function_object_folder`; for a ``.dat`` file the
    ``<stem>_<time>.dat`` a run started again from the same time writes comes after
    its ``<stem>.dat``). A probes object's files are named after their field
    (``T``, ``U``); a field function object's after its type (``wallHeatFlux.dat``).
    """
    folder = function_object_folder(case_dir, name, region)
    if folder is None:
        return []
    if filename.endswith(".dat"):
        return restart_dat_files(folder, filename[: -len(".dat")])
    return [d / filename for d in start_time_folders(folder) if (d / filename).is_file()]


def read_surface_field_value(case_dir: Path, name: str, region: str = "") -> dict | None:
    """``postProcessing/<name>/<time>/surfaceFieldValue.dat``, every time folder merged.

    A restart appends a new time folder (or, from the same time, a
    ``surfaceFieldValue_<time>.dat`` beside the first: restart_dat_files); its
    rows supersede the earlier rows from its first time on. ``region``: the
    function object's region in a multi-region case (:func:`function_object_folder`).
    None when the function object wrote nothing.
    """
    folder = function_object_folder(case_dir, name, region)
    if folder is None:
        return None
    merged: dict | None = None
    for f in restart_dat_files(folder, "surfaceFieldValue"):
        try:
            parsed = parse_surface_field_value(f.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if merged is None:
            merged = parsed
            continue
        first_t = parsed["rows"][0][0] if parsed["rows"] else math.inf
        merged["rows"] = [r for r in merged["rows"] if r[0] < first_t] + parsed["rows"]
        if parsed["area"] is not None:
            merged["area"] = parsed["area"]
    return merged


# ------------------------------------------------------------------ a saved time's boundary entries
#
# A run continued with new numerics (RH3) starts from its latest saved time, whose field files
# hold the boundary conditions it saved: the case writer's new wall treatment (a new 0/) would not
# reach the solver. sync_wall_entries puts the writer's new entries for the wall patches into that
# time's files, keeping each entry's saved value. The saved files may be binary (writeFormat
# binary: a list's values are raw bytes after its count), so they are read as bytes and a list is
# skipped by its count, never by its text.

_LIST_COMPONENTS = {"scalar": 1, "vector": 3, "sphericalTensor": 1, "symmTensor": 6, "tensor": 9, "label": 1, "bool": 1}
_FieldFormat = tuple[bool, int, int]


class FoamFieldError(ValueError):
    """A field file the reader cannot follow (so nothing in it is rewritten)."""


def _field_format(b: bytes) -> _FieldFormat:
    """(binary, bytes per scalar, bytes per label) from a field file's FoamFile header."""
    at = b.find(b"FoamFile", 0, 8192)
    head_end = b.find(b"}", at) if at >= 0 else -1
    head = b[: head_end + 1] if head_end >= 0 else b""
    binary = re.search(rb"format\s+binary\s*;", head) is not None
    scalar = re.search(rb"scalar=(\d+)", head)
    label = re.search(rb"label=(\d+)", head)
    return binary, (int(scalar.group(1)) // 8 if scalar else 8), (int(label.group(1)) // 8 if label else 4)


def _skip_space(b: bytes, i: int) -> int:
    n = len(b)
    while i < n:
        c = b[i : i + 1]
        if c in (b" ", b"\t", b"\r", b"\n"):
            i += 1
        elif b.startswith(b"//", i):
            j = b.find(b"\n", i)
            i = n if j < 0 else j + 1
        elif b.startswith(b"/*", i):
            j = b.find(b"*/", i + 2)
            if j < 0:
                raise FoamFieldError("an unclosed comment")
            i = j + 2
        else:
            break
    return i


def _skip_list(b: bytes, i: int, fmt: _FieldFormat) -> int:
    """``i`` at ``List<T>``: the index just past the list (its count, then its values in ``(...)``,
    or one value in ``{...}`` for a uniform list)."""
    binary, scalar, label = fmt
    close = b.find(b">", i)
    kind = b[i + 5 : close].decode("ascii", errors="replace") if close >= 0 else ""
    if kind not in _LIST_COMPONENTS:
        raise FoamFieldError(f"a list of {kind!r}")
    j = _skip_space(b, close + 1)
    m = re.match(rb"\d+", b[j : j + 24])
    if not m:
        raise FoamFieldError("a list without its count")
    count = int(m.group(0))
    j = _skip_space(b, j + len(m.group(0)))
    size = (label if kind == "label" else 1 if kind == "bool" else scalar) * _LIST_COMPONENTS[kind]
    opener = b[j : j + 1]
    if opener not in (b"(", b"{"):
        raise FoamFieldError("a list without its values")
    closer = b")" if opener == b"(" else b"}"
    if binary:
        end = j + 1 + (count if opener == b"(" else 1) * size
        if b[end : end + 1] != closer:
            raise FoamFieldError("a binary list whose length does not match its count")
        return end + 1
    if opener == b"{" or _LIST_COMPONENTS[kind] == 1:
        end = b.find(closer, j + 1)
    else:
        end = j
        for _ in range(count + 1):  # each value's own ")" and the list's
            end = b.find(b")", end + 1)
            if end < 0:
                break
    if end < 0:
        raise FoamFieldError("an unclosed list")
    return end + 1


def _scan_to(b: bytes, i: int, stop: bytes, fmt: _FieldFormat) -> int:
    """The index of the first ``stop`` (``;`` or ``}``) at depth 0 from ``i``, skipping comments,
    strings, lists, ``{...}`` blocks and code blocks."""
    n = len(b)
    depth = 0
    while i < n:
        i = _skip_space(b, i)
        if i >= n:
            break
        c = b[i : i + 1]
        if depth == 0 and c == stop:
            return i
        if c == b"{":
            depth += 1
            i += 1
        elif c == b"}":
            if depth == 0:
                raise FoamFieldError("a block closed before its statement ended")
            depth -= 1
            i += 1
        elif c == b'"':
            j = b.find(b'"', i + 1)
            if j < 0:
                raise FoamFieldError("an unclosed string")
            i = j + 1
        elif b.startswith(b"#{", i):
            j = b.find(b"#}", i + 2)
            if j < 0:
                raise FoamFieldError("an unclosed code block")
            i = j + 2
        elif b.startswith(b"List<", i):
            i = _skip_list(b, i, fmt)
        else:
            i += 1
    raise FoamFieldError(f"no {stop.decode()} where one was expected")


def _word(b: bytes, i: int) -> tuple[bytes, int]:
    """The keyword or patch name at ``i`` (a quoted name with its quotes) and the index after it."""
    if b[i : i + 1] == b'"':
        j = b.find(b'"', i + 1)
        if j < 0:
            raise FoamFieldError("an unclosed name")
        return b[i : j + 1], j + 1
    m = re.match(rb"[^\s{};\"]+", b[i : i + 4096])
    if not m:
        raise FoamFieldError(f"no name at byte {i}")
    return m.group(0), i + len(m.group(0))


def _block_end(b: bytes, i: int, fmt: _FieldFormat) -> int:
    """``i`` at ``{``: the index of its matching ``}``."""
    return _scan_to(b, i + 1, b"}", fmt)


def _skip_directive(b: bytes, i: int, end: int) -> int:
    j = b.find(b"\n", i, end)
    return end if j < 0 else j + 1


def boundary_entries(b: bytes) -> dict[str, tuple[int, int]]:
    """The patch entries of a field file's ``boundaryField`` (ascii or binary): each patch's name
    and the span of its entry, from its ``{`` to its ``}`` inclusive."""
    fmt = _field_format(b)
    i = 0
    n = len(b)
    while True:
        i = _skip_space(b, i)
        if i >= n:
            raise FoamFieldError("no boundaryField")
        if b[i : i + 1] == b"#":
            i = _skip_directive(b, i, n)
            continue
        key, i = _word(b, i)
        i = _skip_space(b, i)
        if b[i : i + 1] == b"{":
            end = _block_end(b, i, fmt)
            if key == b"boundaryField":
                return _entries_in(b, i + 1, end, fmt)
            i = end + 1
        else:
            i = _scan_to(b, i, b";", fmt) + 1


def _entries_in(b: bytes, i: int, end: int, fmt: _FieldFormat) -> dict[str, tuple[int, int]]:
    out: dict[str, tuple[int, int]] = {}
    while True:
        i = _skip_space(b, i)
        if i >= end:
            return out
        if b[i : i + 1] == b"#":
            i = _skip_directive(b, i, end)
            continue
        name, i = _word(b, i)
        i = _skip_space(b, i)
        if b[i : i + 1] != b"{":
            raise FoamFieldError(f"patch {name.decode(errors='replace')} has no entry")
        close = _block_end(b, i, fmt)
        out[name.decode("utf-8", errors="replace")] = (i, close + 1)
        i = close + 1


def _statements(b: bytes, start: int, end: int, fmt: _FieldFormat) -> list[tuple[bytes, int, int]]:
    """The statements in an entry's body (between its braces): (keyword, start, end past its ``;``
    or ``}``)."""
    out: list[tuple[bytes, int, int]] = []
    i = start
    while True:
        i = _skip_space(b, i)
        if i >= end:
            return out
        key, j = _word(b, i)
        j = _skip_space(b, j)
        stop = _block_end(b, j, fmt) if b[j : j + 1] == b"{" else _scan_to(b, j, b";", fmt)
        out.append((key, i, stop + 1))
        i = stop + 1


def _entry_parts(b: bytes, span: tuple[int, int], fmt: _FieldFormat) -> tuple[list[bytes], bytes | None]:
    """An entry's statements other than its value (each as written), and its value statement."""
    others: list[bytes] = []
    value: bytes | None = None
    for key, s, e in _statements(b, span[0] + 1, span[1] - 1, fmt):
        if key == b"value":
            value = b[s:e]
        else:
            others.append(b[s:e])
    return others, value


def _norm(parts: list[bytes]) -> list[bytes]:
    return [b" ".join(p.split()) for p in parts]


def boundary_entry_types(path: Path) -> dict[str, str]:
    """Each patch's ``type`` in a field file's ``boundaryField`` (ascii or binary)."""
    b = Path(path).read_bytes()
    fmt = _field_format(b)
    out: dict[str, str] = {}
    for name, span in boundary_entries(b).items():
        others, _ = _entry_parts(b, span, fmt)
        for s in others:
            words = s.rstrip(b";").split()
            if len(words) >= 2 and words[0] == b"type":
                out[name] = words[1].decode("utf-8", errors="replace")
    return out


def sync_wall_entries(time_file: Path, fresh_file: Path, patches: list[str]) -> list[str]:
    """Give the ``patches`` of a saved time's field file (``time_file``: what the run solved with,
    ascii or binary) the entries the case writer just wrote in ``fresh_file`` (its new ``0/`` file),
    each with the value the run saved. Returns the patches whose entry changed (none: the file is
    left as it is). Raises :class:`FoamFieldError` when either file cannot be followed."""
    saved = Path(time_file).read_bytes()
    fresh = Path(fresh_file).read_bytes()
    fmt_saved, fmt_fresh = _field_format(saved), _field_format(fresh)
    saved_entries, fresh_entries = boundary_entries(saved), boundary_entries(fresh)
    changes: list[tuple[int, int, bytes]] = []
    done: list[str] = []
    for name in patches:
        if name not in saved_entries or name not in fresh_entries:
            continue
        old_others, value = _entry_parts(saved, saved_entries[name], fmt_saved)
        new_others, fresh_value = _entry_parts(fresh, fresh_entries[name], fmt_fresh)
        if _norm(old_others) == _norm(new_others):
            continue
        keep = value if value is not None else fresh_value
        body = b"".join(b"        " + s + b"\n" for s in [*new_others, *([keep] if keep is not None else [])])
        start, end = saved_entries[name]
        changes.append((start, end, b"{\n" + body + b"    }"))
        done.append(name)
    if not changes:
        return []
    out = saved
    for s, e, text in sorted(changes, reverse=True):
        out = out[:s] + text + out[e:]
    tmp = Path(time_file).with_name(Path(time_file).name + ".sync")
    tmp.write_bytes(out)
    tmp.replace(time_file)
    return done


def saved_time_folder(case_dir: Path, t: float) -> Path | None:
    """The folder of saved time ``t`` in a case (its name as the run wrote it), or None."""
    try:
        for child in Path(case_dir).iterdir():
            if child.is_dir() and re.fullmatch(r"\d+(\.\d+)?([eE][-+]?\d+)?", child.name) and float(child.name) == float(t):
                return child
    except OSError:
        return None
    return None


def restart_wall_entries(case_dir: Path, t: float, fields: list[str], region: str = "") -> dict[str, list[str]]:
    """A run continued with new numerics from its saved time ``t``: each of ``fields`` the case
    writer just wrote in ``0/`` (``0/<region>/``) gets those entries on its wall patches (type
    ``wall``, or ``mappedWall`` for a region's interface, in the mesh's boundary) in the saved time's file, with the values the run saved
    (:func:`sync_wall_entries`), so the case solves with the walls it is written with. Returns
    the patches changed by field. Raises :class:`FoamFieldError` when a file cannot be followed."""
    case = Path(case_dir)
    saved = saved_time_folder(case, t)
    poly = case / "constant" / region / "polyMesh" / "boundary" if region else case / "constant" / "polyMesh" / "boundary"
    if saved is None or not poly.is_file():
        return {}
    walls = [n for n, kind in parse_boundary_patch_types(poly).items() if kind in ("wall", "mappedWall")]
    out: dict[str, list[str]] = {}
    for name in fields:
        fresh = case / "0" / region / name if region else case / "0" / name
        old = saved / region / name if region else saved / name
        if not (fresh.is_file() and old.is_file()):
            continue
        with old.open("rb") as fh:
            if b"FoamFile" not in fh.read(8192):
                continue  # not a field file (the solver would refuse it as it is)
        try:
            changed = sync_wall_entries(old, fresh, walls)
        except FoamFieldError as exc:
            raise FoamFieldError(f"{old.relative_to(case).as_posix()}: {exc}") from exc
        if changed:
            out[name] = changed
    return out
