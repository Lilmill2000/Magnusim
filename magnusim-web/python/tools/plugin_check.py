#!/usr/bin/env python3
"""Plugin conformance check: ``npm run plugin:check -- <plugin folder>... [--json] [--no-tests]``.

Checks one or more plugin folders against the rules in docs/plugins and says,
per rule, what passed and what to fix. An error fails the check (exit 1); a
warning is reported and does not. Exit 2: a path is not a plugin folder.

Rules, in report order (``id``: what is checked):

- ``manifest``: manifest.toml parses and matches the manifest schema
  (tools/plugin_manifest_schema.py, built from cfddesk.registry.manifest);
  plugin.py exists. A key the schema does not know is a warning (the host
  ignores it without a word, so it is usually a misspelling).
- ``key``: the manifest's key is the plugin's folder name, and a plugin that is
  not bundled does not take a bundled plugin's key (it would replace that plugin).
- ``api_version``: major.minor, the host's major version, not newer than this
  host. Using a manifest key newer than the declared version is a warning
  (an older host with that version ignores it).
- ``license``: an SPDX expression that is GPL-3.0-or-later or compatible with it.
- ``load``: the host's own loader loads the plugin (in a separate process, with
  a scratch copy of it, the bundled plugins it needs and a scratch settings
  file, never this PC's): every manifest table checks out, plugin.py imports
  and register(hub) runs. What the loader says it ignored is a warning. A link
  (symlink or junction) in the plugin that leads outside it, or back up into
  it (a loop), is an error: the host resolves paths and refuses what is outside.
- ``imports``: plugins import only magnusim_sdk, cfddesk.registry, the standard
  library and their own modules (tools/plugin_boundary.py, reused as is).
- ``register``: register() imports nothing heavy (numpy, pyvista, gmsh, OCP,
  ...) when it runs (functions it only defines may import what they like), and
  loading the plugin imports nothing heavy: neither the plugin's own code at
  load time (even what the host has loaded already) nor modules it pulls in.
- ``react``: no React of the plugin's own: not a package.json dependency, not
  in any shipped script, not loaded from a URL (the host provides React to
  frames and panels).
- ``workspace``: each [[workspaces]] entry page exists and loads its scripts
  the way the frame's Content-Security-Policy lets it run them: from the
  plugin's workspace/ folder (or /plugin-sdk/), as .js or .mjs, never inline
  and never from another site; some workspace script imports
  '@magnusim/workspace'; a frame resolves only the bare imports in the host's
  import map (docs/plugins/plugin-sdk.json).
- ``ui``: the in-page UI's entry exists, and its code imports (import, export
  from, import() and require()) only react, the JSX runtime,
  '@magnusim/plugin-ui' and files in its ui folder, as the host's bundler
  (scripts/server/plugin-ui-bundle.ts) allows: no other package, URL or
  absolute path. Type-only imports are erased, so they are free; comments are
  not code.
- ``tools``: every job tool the plugin registers is a file inside the plugin
  folder; a [python] service module is a file there too.
- ``requirements``: a [python] lock pins every package with == and hashes it.
- ``hooks``: a hook the host reserves but never fires is a warning.
- ``colours``: a hex colour outside a design token (``--name: #hex``) in the
  plugin's own styles and scripts is a warning; use the tokens.
- ``copy``: "coming soon", "TODO" and "lorem" are errors in shipped text. A
  Markdown file may name them in quotes or backticks (a rule that names them).
- ``tests``: the plugin's own tests pass: pytest over tests/ and, with a
  package.json "test" script, npm test. A plugin with no tests gets a warning.
  ``--no-tests`` skips them (reported as skipped, never as passed).

What is read for ``colours`` and ``copy``: the plugin's own sources, not
node_modules, caches, tests, e2e, fixtures, LICENSES or type declarations, not
other people's code it vendors (_vendor/, vendor/, vendored/, third_party/, or
a subfolder with a LICENSE or COPYING file of its own), and not build output
(build/, dist/, and workspace/ when the plugin builds it from src/ with a
package.json "build" script: its sources are read instead). Text files are
decoded by their byte-order mark (UTF-8, UTF-16 or UTF-32), else as UTF-8.
In scripts only string literals are read for colours (template literals over
several lines too); in HTML and SVG, #names in href/id/for/name attributes and
url(#id) are references, not colours.

One plugin's report never stops another's: a plugin that makes the check
itself fail gets an error saying so, and the other plugins are still reported.
"""

from __future__ import annotations

import argparse
import ast
import bisect
import codecs
import glob
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

PY_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = PY_ROOT.parent
for _p in (PY_ROOT, PY_ROOT / "sdk", PY_ROOT / "tools"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import plugin_boundary  # noqa: E402  (tools/, on the path above)
import plugin_manifest_schema  # noqa: E402

from cfddesk.registry import API_VERSION  # noqa: E402
from cfddesk.registry.discovery import _parse_toml  # noqa: E402

CHECKS: tuple[tuple[str, str], ...] = (
    ("manifest", "manifest.toml matches the manifest schema"),
    ("key", "the key is the folder's name"),
    ("api_version", "api_version fits this host"),
    ("license", "the licence is GPL-compatible"),
    ("load", "the host loads the plugin"),
    ("imports", "imports stay inside the plugin boundary"),
    ("register", "register() imports nothing heavy"),
    ("react", "no React of its own"),
    ("workspace", "workspace pages connect through the SDK"),
    ("ui", "the in-page UI imports only what the host provides"),
    ("tools", "job tools and the service are inside the plugin"),
    ("requirements", "requirements are pinned and hashed"),
    ("hooks", "hooks are ones the host fires"),
    ("colours", "colours come from the design tokens"),
    ("copy", "no placeholder copy"),
    ("tests", "the plugin's own tests pass"),
)

HEAVY = (
    "numpy", "scipy", "pyvista", "vtk", "vtkmodules", "gmsh", "OCP", "cadquery",
    "matplotlib", "pandas", "meshio", "trimesh", "torch", "h5py", "PIL", "sklearn",
)

# SPDX licences a plugin may use with Magnusim (GPL-3.0-or-later).
GPL_COMPATIBLE = frozenset(
    {
        "GPL-3.0-or-later", "GPL-3.0-only", "GPL-2.0-or-later", "AGPL-3.0-or-later", "AGPL-3.0-only",
        "LGPL-3.0-or-later", "LGPL-3.0-only", "LGPL-2.1-or-later", "LGPL-2.1-only",
        "MIT", "MIT-0", "X11", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "ISC", "Apache-2.0", "Zlib",
        "MPL-2.0", "Unlicense", "CC0-1.0", "BSL-1.0", "PSF-2.0", "Python-2.0", "NCSA", "UPL-1.0",
        "Artistic-2.0", "BlueOak-1.0.0",
    }
)
# Deprecated ids with the same meaning, and their current spelling.
SPDX_DEPRECATED = {
    "GPL-3.0": "GPL-3.0-only",
    "GPL-3.0+": "GPL-3.0-or-later",
    "GPL-2.0+": "GPL-2.0-or-later",
    "LGPL-3.0": "LGPL-3.0-only",
    "LGPL-3.0+": "LGPL-3.0-or-later",
    "LGPL-2.1": "LGPL-2.1-only",
    "LGPL-2.1+": "LGPL-2.1-or-later",
    "AGPL-3.0": "AGPL-3.0-only",
}
# Known not to be: the usual mistakes, with why.
SPDX_INCOMPATIBLE = {
    "GPL-2.0-only": "GPL-2.0-only code cannot be combined with GPL-3.0 code",
    "GPL-2.0": "GPL-2.0 (only) code cannot be combined with GPL-3.0 code",
    "EPL-1.0": "EPL-1.0 is not GPL-compatible",
    "CDDL-1.0": "CDDL-1.0 is not GPL-compatible",
    "MPL-1.1": "MPL-1.1 is not GPL-compatible",
    "Apache-1.1": "Apache-1.1 is not GPL-compatible",
}

# What a plugin's in-page UI may import (scripts/server/plugin-ui-bundle.ts).
UI_IMPORTS = ("react", "react/jsx-runtime", "react/jsx-dev-runtime", "@magnusim/plugin-ui")
WORKSPACE_SDK = "@magnusim/workspace"
# docs/plugins/plugin-sdk.json's imports, if that file cannot be read.
FALLBACK_IMPORT_MAP = (
    "react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "@magnusim/workspace", "@magnusim/plugin-ui",
)
# React's own code, as it appears in any build of it.
REACT_MARKERS = (
    "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE",
    "__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED",
    "__REACT_DEVTOOLS_GLOBAL_HOOK__",
)

SKIP_DIRS = frozenset(
    {"node_modules", "__pycache__", "site-packages", "tests", "e2e", "fixtures", "LICENSES", "wheels", "venv"}
)
# Other people's code a plugin carries: not its own copy or colours.
VENDOR_DIRS = frozenset({"_vendor", "vendor", "vendored", "third_party", "third-party", "thirdparty"})
_OWN_LICENCE = re.compile(r"^(LICEN[CS]E|COPYING)(\.[\w.-]+)?$", re.I)
SKIP_ROOT_DIRS = frozenset({"build", "dist"})
COPY_SUFFIXES = (
    ".py", ".pyw", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".htm", ".css", ".toml",
    ".json", ".md", ".txt", ".svg", ".yaml", ".yml",
)
COLOUR_SUFFIXES = (".css", ".scss", ".html", ".htm", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".svg")
SCRIPT_SUFFIXES = (".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx")
SKIP_FILES = re.compile(r"^(package-lock\.json|.*\.lock|.*\.min\.js|.*\.map|.*\.d\.ts|LICEN[CS]E.*|COPYING.*|THIRD_PARTY.*)$", re.I)

BANNED_COPY = (
    ("coming soon", re.compile(r"coming\s+soon", re.I)),
    ("TODO", re.compile(r"\bTODO\b")),
    ("lorem", re.compile(r"\blorem\b", re.I)),
)
# A Markdown file may name a banned word in quotes or backticks.
_MD_QUOTED = re.compile(r"`[^`]*`|\"[^\"]*\"|“[^”]*”")

HEX = re.compile(r"(?<![\w&#/$.%-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])")
_CSS_TOKEN_DECL = re.compile(r"--[\w-]+\s*:[^;{}]*")
_CSS_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_CSS_VAR = re.compile(r"var\(\s*--[\w-]+\s*,[^()]*(\([^()]*\)[^()]*)*\)")
# HTML/SVG attributes whose #name is a reference (a fragment, an id), not a colour.
_REF_ATTR = re.compile(r"\b(?:href|xlink:href|id|for|name)\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)
_URL_REF = re.compile(r"url\(\s*['\"]?#[\w-]+['\"]?\s*\)", re.I)
_ATTR_BEFORE = re.compile(r"\b(?:href|xlink:href|id|htmlFor|for|name)\s*=\s*\{?\s*$", re.I)

# Imports in a script: (keyword, type-only, specifier).
_IMPORT_FROM = re.compile(
    r"(?<![\w$.])(import|export)\s*(type\s+)?(?:[\w$]+\s*,?\s*)?(?:\{[^}]*\}|\*\s*as\s+[\w$]+|\*)?\s*from\s*([\"'])([^\"'\n]+)\3"
)
_IMPORT_BARE = re.compile(r"(?<![\w$.])import\s*([\"'])([^\"'\n]+)\1")
_IMPORT_DYNAMIC = re.compile(r"(?<![\w$.])import\(\s*([\"'])([^\"'\n]+)\1\s*\)")
_REQUIRE = re.compile(r"(?<![\w$.])require\s*\(\s*([\"'])([^\"'\n]+)\1\s*\)")
_SCRIPT_TAG = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.I | re.S)
_SRC_ATTR = re.compile(r"\bsrc\s*=\s*([\"'])([^\"']+)\1", re.I)
_TYPE_ATTR = re.compile(r"\btype\s*=\s*([\"']?)([^\"'\s>]*)\1", re.I)
# What the workspace file server sends as JavaScript (WORKSPACE_TYPES in
# scripts/server/workspace-files.ts); anything else is sent with its own type and
# X-Content-Type-Options: nosniff, so the browser never runs it as a script.
WORKSPACE_JS = (".js", ".mjs")

_PIN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(\[[^\]]*\])?\s*===?\s*[^\s;,<>=!~]+\s*(;.*)?$")
_HASH = re.compile(r"--hash[=\s]+(sha256|sha384|sha512):[0-9a-fA-F]+")
# Options that pull in requirements from elsewhere. pip reads them with optparse:
# a short option's value may follow it directly (-rother.txt), and a long option
# may be shortened to any prefix no other option shares (--requirem, --cons, --ed).
_NOT_PINNED_SHORT = ("-r", "-c", "-e")
_NOT_PINNED_LONG = (("--requirement", "--requirem"), ("--constraint", "--cons"), ("--editable", "--ed"))


@dataclass
class Finding:
    level: str  # "error" | "warning"
    check: str
    message: str
    file: str = ""
    line: int = 0


@dataclass
class Report:
    path: str
    key: str = ""
    name: str = ""
    version: str = ""
    findings: list[Finding] = field(default_factory=list)
    # check id -> "pass" | "fail" | "warn" | "n/a" | "skipped"
    checks: dict[str, str] = field(default_factory=dict)
    notes: dict[str, str] = field(default_factory=dict)
    tests: dict[str, Any] = field(default_factory=dict)

    @property
    def errors(self) -> int:
        return sum(1 for f in self.findings if f.level == "error")

    @property
    def warnings(self) -> int:
        return sum(1 for f in self.findings if f.level == "warning")

    @property
    def ok(self) -> bool:
        return self.errors == 0

    def add(self, level: str, check: str, message: str, file: Path | str = "", line: int = 0) -> None:
        self.findings.append(Finding(level, check, message, _rel(self.path, file), line))

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "key": self.key,
            "name": self.name,
            "version": self.version,
            "ok": self.ok,
            "errors": self.errors,
            "warnings": self.warnings,
            "checks": self.checks,
            "notes": self.notes,
            "tests": self.tests,
            "findings": [asdict(f) for f in self.findings],
        }


def _rel(root: str, file: Path | str) -> str:
    if not file:
        return ""
    p = Path(file)
    try:
        return p.resolve().relative_to(Path(root).resolve()).as_posix()
    except ValueError:
        return p.as_posix()


# -- what is read ---------------------------------------------------------------


def _package_json(plugin: Path) -> dict[str, Any]:
    p = plugin / "package.json"
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def builds_workspace(plugin: Path) -> bool:
    """workspace/ is build output: the plugin builds it from src/ (package.json "build")."""
    scripts = _package_json(plugin).get("scripts") or {}
    return isinstance(scripts, dict) and "build" in scripts and (plugin / "src").is_dir() and (plugin / "workspace").is_dir()


def link_target(path: Path | str) -> str | None:
    """Where a symlink or (Windows) junction points; None for anything else.

    os.path.islink is False for a junction, and os.walk follows junctions on
    Python < 3.12, so every walk here asks this instead."""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    is_reparse = bool(getattr(st, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))
    if not stat.S_ISLNK(st.st_mode) and not is_reparse:
        return None
    try:
        return os.readlink(path)
    except (OSError, ValueError):
        # A reparse point that is not a link (a cloud placeholder file, say).
        return None if not stat.S_ISLNK(st.st_mode) else ""


def walk(root: Path):
    """os.walk(root) that never enters a linked folder (symlink or junction)."""
    for top, dirs, names in os.walk(root):
        dirs[:] = [d for d in sorted(dirs) if link_target(Path(top) / d) is None]
        yield top, dirs, sorted(names)


def _vendored(folder: Path, plugin: Path) -> bool:
    """Other people's code the plugin carries (see the module docstring)."""
    if folder.name.lower() in VENDOR_DIRS:
        return True
    if folder == plugin:
        return False
    try:
        return any(_OWN_LICENCE.match(n) for n in os.listdir(folder))
    except OSError:
        return False


def own_files(plugin: Path, suffixes: tuple[str, ...]) -> list[Path]:
    """The plugin's own source and text files with these suffixes (see the module docstring)."""
    built = plugin / "workspace" if builds_workspace(plugin) else None
    out: list[Path] = []
    for top, dirs, names in walk(plugin):
        here = Path(top)
        keep = []
        for d in dirs:
            folder = here / d
            if d in SKIP_DIRS or d.startswith(".") or d.endswith(".egg-info") or (folder / "pyvenv.cfg").is_file():
                continue
            if here == plugin and d in SKIP_ROOT_DIRS:
                continue
            if built is not None and folder == built:
                continue
            if _vendored(folder, plugin):
                continue
            keep.append(d)
        dirs[:] = keep
        for n in names:
            if n.lower().endswith(suffixes) and not SKIP_FILES.match(n):
                out.append(here / n)
    return out


_BOMS = (
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
)


def decode_text(data: bytes) -> str:
    """Text as pip and editors read it: by its byte-order mark (UTF-32 first: its
    little-endian mark starts like UTF-16's), else UTF-8 (bad bytes replaced)."""
    for bom, codec in _BOMS:
        if data.startswith(bom):
            return data.decode(codec, errors="replace")
    return data.decode("utf-8", errors="replace")


def _read(path: Path) -> str:
    try:
        return decode_text(path.read_bytes())
    except OSError:
        return ""


def _line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


# Words after which a '/' starts a regular expression, not a division.
_REGEX_AFTER_WORDS = frozenset(
    {"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"}
)


def js_scan(text: str) -> tuple[str, list[tuple[int, int]]]:
    """A script with its comments and regex literals blanked (line breaks kept, so offsets and line
    numbers stay right), and the (start, end) of each string literal in it.

    A small lexer, not a parser: it knows strings, template literals (with
    ${...} inside), regular expression literals and comments, which is what
    reading imports and colours needs."""
    out = list(text)
    spans: list[tuple[int, int]] = []
    n = len(text)

    def blank(a: int, b: int) -> None:
        for k in range(a, b):
            if out[k] != "\n":
                out[k] = " "

    def code(i: int, in_template: bool) -> int:
        """Scan code from i; inside ${...} stop after its closing brace."""
        depth = 0
        prev = ""  # "<op>" (a '/' next starts a regex), "<value>", or the last word
        while i < n:
            c = text[i]
            nxt = text[i + 1] if i + 1 < n else ""
            if c == "/" and nxt == "/":
                j = text.find("\n", i)
                j = n if j < 0 else j
                blank(i, j)
                i = j
                continue
            if c == "/" and nxt == "*":
                j = text.find("*/", i + 2)
                j = n if j < 0 else j + 2
                blank(i, j)
                i = j
                continue
            if c in "'\"":
                j = i + 1
                while j < n and text[j] != c and text[j] != "\n":
                    j += 2 if text[j] == "\\" else 1
                j = min(j + 1, n)
                spans.append((i, j))
                i, prev = j, "<value>"
                continue
            if c == "`":
                i, prev = template(i), "<value>"
                continue
            if c == "/":
                if prev in ("", "<op>") or prev in _REGEX_AFTER_WORDS:
                    j, in_class = i + 1, False
                    while j < n and text[j] != "\n":
                        ch = text[j]
                        if ch == "\\":
                            j += 2
                            continue
                        if ch == "[":
                            in_class = True
                        elif ch == "]":
                            in_class = False
                        elif ch == "/" and not in_class:
                            break
                        j += 1
                    j += 1
                    while j < n and (text[j].isalnum() or text[j] == "_"):
                        j += 1
                    blank(i, min(j, n))  # a pattern, not code (nor a string)
                    i, prev = j, "<value>"
                else:
                    i, prev = i + 1, "<op>"
                continue
            if c.isalnum() or c in "_$":
                j = i
                while j < n and (text[j].isalnum() or text[j] in "_$"):
                    j += 1
                prev = text[i:j]
                i = j
                continue
            if c.isspace():
                i += 1
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                if in_template and depth == 0:
                    return i + 1
                depth -= 1
            prev = "<value>" if c in ")]" else "<op>"
            i += 1
        return n

    def template(i: int) -> int:
        """From an opening backtick to just after its closing one."""
        start = i
        j = i + 1
        while j < n:
            c = text[j]
            if c == "\\":
                j += 2
                continue
            if c == "`":
                spans.append((start, j + 1))
                return j + 1
            if c == "$" and j + 1 < n and text[j + 1] == "{":
                spans.append((start, j))
                j = code(j + 2, True)
                start = j - 1
                continue
            j += 1
        spans.append((start, n))
        return n

    code(0, False)
    spans.sort()
    return "".join(out), spans


def _in_spans(spans: list[tuple[int, int]], starts: list[int], index: int) -> bool:
    k = bisect.bisect_right(starts, index) - 1
    return k >= 0 and spans[k][0] <= index < spans[k][1]


def script_imports(text: str, *, static_only: bool = False) -> list[tuple[str, bool, int]]:
    """(specifier, type-only, line) for every import, re-export, import() and
    require() in a script; what is in comments or inside strings is not code.
    static_only: only import and export ... from (what a browser resolves when
    the module loads; import() and require() run only when reached)."""
    code, spans = js_scan(text)
    starts = [s for s, _ in spans]
    out: list[tuple[str, bool, int]] = []

    def add(m: re.Match[str], spec: str, type_only: bool) -> None:
        if not _in_spans(spans, starts, m.start()):
            out.append((spec, type_only, _line_of(text, m.start())))

    for m in _IMPORT_FROM.finditer(code):
        add(m, m.group(4), bool(m.group(2)))
    for m in _IMPORT_BARE.finditer(code):
        add(m, m.group(2), False)
    if not static_only:
        for m in _IMPORT_DYNAMIC.finditer(code):
            add(m, m.group(2), False)
        for m in _REQUIRE.finditer(code):
            add(m, m.group(2), False)
    out.sort(key=lambda row: row[2])
    return out


def remote(spec: str) -> bool:
    """A URL with a scheme (https:, data:, ...) or a protocol-relative //host/..."""
    return spec.startswith("//") or re.match(r"^[a-z][a-z0-9+.-]*:", spec, re.I) is not None


def _bare(spec: str) -> bool:
    return not (spec.startswith(("./", "../", "/")) or remote(spec))


def names_react(url: str) -> bool:
    """A URL or path that loads React or React DOM (a CDN package path or a react*.js file)."""
    path = re.split(r"[?#]", re.sub(r"^[a-z][a-z0-9+.-]*:|^//[^/]*", "", url, flags=re.I), maxsplit=1)[0]
    for seg in path.split("/"):
        if re.match(r"^react(-dom)?(@[^/]*)?$", seg, re.I) or re.match(r"^react(-dom)?(\.[^/]*)?\.(m?js|cjs)$", seg, re.I):
            return True
    return False


def import_map(web_root: Path) -> tuple[str, ...]:
    try:
        data = json.loads((web_root / "docs" / "plugins" / "plugin-sdk.json").read_text(encoding="utf-8"))
        names = tuple(str(k) for k in (data.get("imports") or {}))
        return names or FALLBACK_IMPORT_MAP
    except (OSError, ValueError, AttributeError):
        return FALLBACK_IMPORT_MAP


# -- manifest, key, api_version, license -----------------------------------------


def _version(text: str) -> tuple[int, int] | None:
    m = re.match(r"^([0-9]+)\.([0-9]+)$", str(text or ""))
    return (int(m.group(1)), int(m.group(2))) if m else None


def check_manifest(plugin: Path, report: Report) -> dict[str, Any] | None:
    manifest = plugin / "manifest.toml"
    if not (plugin / "plugin.py").is_file():
        report.add("error", "manifest", "plugin.py is missing: a plugin folder needs plugin.py with register(hub)", plugin / "plugin.py")
    try:
        text = manifest.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        report.add("error", "manifest", f"manifest.toml could not be read: {exc}", manifest)
        return None
    meta, why = _parse_toml(text, source=str(manifest))
    if meta is None:
        report.add("error", "manifest", f"manifest.toml {why}", manifest)
        return None
    report.key = str(meta.get("key") or plugin.name)
    report.name = str(meta.get("name") or report.key)
    report.version = str(meta.get("version") or "")
    schema = plugin_manifest_schema.build_schema()
    errors, unknown = plugin_manifest_schema.validate(meta, schema)
    for msg in errors:
        report.add("error", "manifest", msg, manifest)
    for path in unknown:
        report.add(
            "warning",
            "manifest",
            f"{path} is not a manifest key of host API {API_VERSION}; the host ignores it (a misspelling?)",
            manifest,
        )
    return meta


def bundled_keys(web_root: Path) -> dict[str, Path]:
    """The app's bundled plugins by key (their folders)."""
    out: dict[str, Path] = {}
    root = web_root / "bundled-plugins"
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        if (folder / "manifest.toml").is_file():
            out.setdefault(_manifest_key(folder), folder)
    return out


def check_key(plugin: Path, meta: dict[str, Any], report: Report, web_root: Path = WEB_ROOT) -> None:
    key = meta.get("key")
    if isinstance(key, str) and key and key != plugin.name:
        report.add(
            "error",
            "key",
            f"key {key!r} is not the folder's name {plugin.name!r}: rename the folder or the key",
            plugin / "manifest.toml",
        )
    if isinstance(key, str) and key and not _is_bundled(plugin, meta):
        taken = bundled_keys(web_root).get(key)
        if taken is not None and taken.resolve() != plugin.resolve():
            report.add(
                "error",
                "key",
                f"key {key!r} is a bundled plugin's key (bundled-plugins/{taken.name}): the host would put this "
                "plugin in its place; choose another key",
                plugin / "manifest.toml",
            )


def _uses(meta: dict[str, Any]) -> list[str]:
    used = [k for k in plugin_manifest_schema.FEATURE_API if "." not in k and k in meta]
    kinds = meta.get("study_kinds")
    if isinstance(kinds, list) and any(isinstance(k, dict) and "links_geometry" in k for k in kinds):
        used.append("study_kinds.links_geometry")
    default = meta.get("default_analysis")
    if isinstance(default, dict) and "study_name" in default:
        used.append("default_analysis.study_name")
    return used


def check_api_version(plugin: Path, meta: dict[str, Any], report: Report) -> None:
    manifest = plugin / "manifest.toml"
    raw = meta.get("api_version")
    if raw is None:
        return  # the schema already says it is required
    declared = _version(str(raw))
    host = _version(API_VERSION)
    if declared is None or host is None:
        report.add("error", "api_version", f"api_version {raw!r} is not major.minor (this host is {API_VERSION})", manifest)
        return
    if declared[0] != host[0]:
        report.add(
            "error",
            "api_version",
            f"api_version {raw} has major version {declared[0]}; this host ({API_VERSION}) loads only {host[0]}.x plugins",
            manifest,
        )
        return
    if declared > host:
        report.add(
            "error",
            "api_version",
            f"api_version {raw} is newer than this host ({API_VERSION}), which cannot check what {raw} added; "
            "check it with a host of that version",
            manifest,
        )
    for feature in _uses(meta):
        since = _version(plugin_manifest_schema.FEATURE_API[feature])
        if since is not None and declared < since:
            report.add(
                "warning",
                "api_version",
                f"{feature} needs host API {plugin_manifest_schema.FEATURE_API[feature]}, but api_version is {raw}: "
                f"a {raw} host ignores it; raise api_version",
                manifest,
            )


def license_problem(expr: str) -> tuple[str, str] | None:
    """(level, why) when an SPDX expression is not fine for a Magnusim plugin, else None."""
    text = str(expr or "").strip()
    if not text:
        return "error", "no licence: set license to GPL-3.0-or-later or a GPL-compatible SPDX id"
    tokens = re.findall(r"\(|\)|[^\s()]+", text)
    pos = 0
    notes: list[str] = []

    def atom() -> bool:
        nonlocal pos
        if pos >= len(tokens):
            raise ValueError("ends early")
        tok = tokens[pos]
        if tok == "(":
            pos += 1
            ok = expr_or()
            if pos >= len(tokens) or tokens[pos] != ")":
                raise ValueError("a '(' is not closed")
            pos += 1
            return ok
        if tok.upper() in ("AND", "OR", "WITH", ")"):
            raise ValueError(f"unexpected {tok!r}")
        pos += 1
        if pos < len(tokens) and tokens[pos].upper() == "WITH":
            if pos + 1 >= len(tokens) or tokens[pos + 1].upper() in ("AND", "OR", "WITH") or tokens[pos + 1] in "()":
                raise ValueError("WITH needs an exception id after it")
            pos += 2  # an exception only adds permissions
        if tok in GPL_COMPATIBLE:
            return True
        if tok in SPDX_DEPRECATED:
            notes.append(f"{tok} is a deprecated SPDX id; write {SPDX_DEPRECATED[tok]}")
            return True
        if tok in SPDX_INCOMPATIBLE:
            notes.append(SPDX_INCOMPATIBLE[tok])
        else:
            notes.append(f"{tok} is not a GPL-compatible SPDX licence id this check knows")
        return False

    def expr_and() -> bool:
        nonlocal pos
        ok = atom()
        while pos < len(tokens) and tokens[pos].upper() == "AND":
            pos += 1
            ok = atom() and ok
        return ok

    def expr_or() -> bool:
        nonlocal pos
        ok = expr_and()
        while pos < len(tokens) and tokens[pos].upper() == "OR":
            pos += 1
            ok = expr_and() or ok
        return ok

    try:
        ok = expr_or()
        if pos < len(tokens):
            raise ValueError(f"unexpected {tokens[pos]!r}")
    except ValueError as exc:
        return "error", f"license {text!r} is not an SPDX expression ({exc})"
    if not ok:
        bad = "; ".join(n for n in notes if "deprecated" not in n)
        return "error", f"license {text!r}: {bad}. Magnusim is GPL-3.0-or-later; a plugin must be GPL-compatible"
    deprecated = [n for n in notes if "deprecated" in n]
    if deprecated:
        return "warning", "; ".join(deprecated)
    return None


def check_license(plugin: Path, meta: dict[str, Any], report: Report) -> None:
    problem = license_problem(str(meta.get("license") or ""))
    if problem:
        report.add(problem[0], "license", problem[1], plugin / "manifest.toml")


# -- load (the host's own loader, in a separate process) --------------------------

_COPY_IGNORE = shutil.ignore_patterns(
    "node_modules", "__pycache__", ".venv", ".cache", ".git", ".pytest_cache", ".mypy_cache", ".ruff_cache"
)


def _inside(path: str, root: str) -> bool:
    a, b = os.path.normcase(path), os.path.normcase(root)
    return a == b or a.startswith(b.rstrip("\\/") + os.sep)


def bad_link(path: str, root: str) -> str | None:
    """Why a link inside the plugin (root, resolved) is a problem, or None: it
    leads outside the plugin, or up into a folder that holds it (a loop)."""
    if link_target(path) is None:
        return None
    real = os.path.realpath(path)
    if not _inside(real, root):
        return f"leads outside the plugin, to {real}"
    if _inside(os.path.realpath(os.path.dirname(path)), real):
        return "leads back up into the plugin's own folders (a loop)"
    return None


def link_problems(plugin: Path) -> list[tuple[Path, str]]:
    """(link, why) for every symlink or junction in the plugin that the host
    cannot use. A link to another place inside the plugin is fine."""
    root = os.path.realpath(plugin)
    out: list[tuple[Path, str]] = []
    for top, _dirs, _names in walk(plugin):
        # walk() leaves linked folders out of its lists, so list the folder itself.
        try:
            entries = sorted(os.listdir(top))
        except OSError:
            continue
        for name in entries:
            path = os.path.join(top, name)
            why = bad_link(path, root)
            if why:
                out.append((Path(path), why))
    return out


def _copy_plugin(src: Path, dest: Path) -> None:
    """copytree of a plugin, leaving out caches and the links link_problems reports
    (a good link is followed: the copy sees what the host sees through it)."""
    root = os.path.realpath(src)

    def ignore(folder: str, names: list[str]) -> set[str]:
        skip = set(_COPY_IGNORE(folder, names))
        skip.update(n for n in names if bad_link(os.path.join(folder, n), root))
        return skip

    shutil.copytree(src, dest, ignore=ignore)


def _manifest_key(folder: Path) -> str:
    meta, _ = _parse_toml(_read(folder / "manifest.toml"), source=str(folder))
    return str((meta or {}).get("key") or folder.name)


def _is_bundled(plugin: Path, meta: dict[str, Any]) -> bool:
    return meta.get("tier") == "bundled" or plugin.parent.name == "bundled-plugins"


def _dependency_dirs(plugin: Path, meta: dict[str, Any], web_root: Path) -> tuple[list[Path], list[Path]]:
    """(bundled, user) plugin folders this one needs loaded: Incompressible Flow
    (the app's required plugin) and what requires_plugins names, found among
    the app's bundled plugins or the plugin's sibling folders."""
    from cfddesk.registry.discovery import REQUIRED_BUNDLED, _str_list

    wanted = set(REQUIRED_BUNDLED)
    for req in _str_list(meta.get("requires_plugins")):
        wanted.add(re.split(r"[<>=!]", req, maxsplit=1)[0].strip())
    wanted.discard(str(meta.get("key") or plugin.name))
    bundled: list[Path] = []
    user: list[Path] = []
    real_bundled = web_root / "bundled-plugins"
    for folder in sorted(real_bundled.iterdir()) if real_bundled.is_dir() else []:
        if (folder / "manifest.toml").is_file() and folder.resolve() != plugin.resolve():
            key = _manifest_key(folder)
            if key in wanted:
                bundled.append(folder)
                wanted.discard(key)
    for folder in sorted(plugin.parent.iterdir()):
        if folder.resolve() == plugin.resolve() or not (folder / "manifest.toml").is_file():
            continue
        key = _manifest_key(folder)
        if key in wanted:
            (bundled if _is_bundled(folder, {}) else user).append(folder)
            wanted.discard(key)
    return bundled, user


def run_load_probe(plugin: Path, meta: dict[str, Any], web_root: Path) -> dict[str, Any]:
    """Load the plugin with the host's loader in a fresh interpreter; its findings as a dict."""
    key = str(meta.get("key") or plugin.name)
    bundled_tier = _is_bundled(plugin, meta)
    deps_bundled, deps_user = _dependency_dirs(plugin, meta, web_root)
    with tempfile.TemporaryDirectory(prefix="magnusim-plugin-check-") as scratch_name:
        scratch = Path(scratch_name)
        dirs = {name: scratch / name for name in ("base-bundled", "base-plugins", "bundled", "plugins", "web")}
        for d in dirs.values():
            d.mkdir()
        target = dirs["bundled" if bundled_tier else "plugins"] / plugin.name
        try:
            for dep in deps_bundled:
                for name in ("base-bundled", "bundled"):
                    _copy_plugin(dep, dirs[name] / dep.name)
            for dep in deps_user:
                for name in ("base-plugins", "plugins"):
                    _copy_plugin(dep, dirs[name] / dep.name)
            _copy_plugin(plugin, target)
        except (shutil.Error, OSError) as exc:
            why = str(exc)
            return {"error": f"the plugin could not be copied for the load check: {why[:600]}"}
        settings = scratch / "settings.json"
        settings.write_text(json.dumps({"plugins": {"enabled": [key], "disabled": []}}), encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k not in ("MAGNUSIM_PLUGINS_DIR", "MAGNUSIM_BUNDLED_DIR")}
        env.update(
            {
                "MAGNUSIM_LOCAL_JSON": str(settings),
                "CFDDESK_LOCAL_JSON": str(settings),
                "MAGNUSIM_PLUGIN_ENVS_DIR": str(scratch / "envs"),
                "PYTHONIOENCODING": "utf-8",
            }
        )
        args = {
            "key": key,
            "target": str(target),
            "web": str(dirs["web"]),
            "base": [str(dirs["base-bundled"]), str(dirs["base-plugins"])],
            "full": [str(dirs["bundled"]), str(dirs["plugins"])],
        }
        try:
            done = subprocess.run(
                [sys.executable, str(Path(__file__).resolve()), "--probe", json.dumps(args)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                timeout=300,
                cwd=str(scratch),
            )
        except subprocess.TimeoutExpired:
            return {"error": "loading the plugin took more than 300 s"}
        line = next((ln for ln in reversed(done.stdout.splitlines()) if ln.startswith("{")), "")
        try:
            out: dict[str, Any] = json.loads(line)
        except ValueError:
            tail = (done.stderr or done.stdout).strip().splitlines()[-8:]
            return {"error": "the load check itself failed: " + " | ".join(tail)}
        # Paths in the copy -> paths in the plugin.
        for job in out.get("jobs", []):
            job["tool_path"] = str(job.get("tool_path", "")).replace(str(target), str(plugin))
        return out


class _HeavyImportWatch:
    """Records each heavy package the plugin's own code imports while it is active:
    import statements and __import__() (builtins.__import__) and
    importlib.import_module(), even when the package is loaded already."""

    def __init__(self, plugin_dir: Path) -> None:
        self.roots = {
            os.path.normcase(os.path.abspath(plugin_dir)).rstrip("\\/") + os.sep,
            os.path.normcase(os.path.realpath(plugin_dir)).rstrip("\\/") + os.sep,
        }
        self.heavy: set[str] = set()

    def _note(self, name: object, level: int, depth: int) -> None:
        if level or not isinstance(name, str) or name.startswith("."):
            return
        root = name.split(".")[0]
        if root not in HEAVY:
            return
        try:
            filename = sys._getframe(depth).f_code.co_filename
        except ValueError:
            return
        here = os.path.normcase(os.path.abspath(filename))
        if any(here.startswith(r) for r in self.roots):
            self.heavy.add(root)

    def __enter__(self) -> _HeavyImportWatch:
        import builtins
        import importlib

        self._builtins, self._importlib = builtins, importlib
        self._import, self._import_module = builtins.__import__, importlib.import_module
        real_import, real_import_module, note = self._import, self._import_module, self._note

        def watched_import(name, globals=None, locals=None, fromlist=(), level=0):  # noqa: A002 (the builtin's names)
            note(name, level, 2)
            return real_import(name, globals, locals, fromlist, level)

        def watched_import_module(name, package=None):
            note(name, 0, 2)
            return real_import_module(name, package)

        builtins.__import__ = watched_import
        importlib.import_module = watched_import_module  # type: ignore[assignment]
        return self

    def __exit__(self, *exc: object) -> None:
        self._builtins.__import__ = self._import
        self._importlib.import_module = self._import_module  # type: ignore[assignment]


def _probe(args: dict[str, Any]) -> dict[str, Any]:
    """Runs in the child process: load once without the plugin, then with it."""
    from cfddesk.registry import discovery, load_all
    from cfddesk.registry.hooks import RESERVED_HOOKS, get_hooks

    # The probe must never write the app's own log.
    discovery._log_required_failure = lambda row: ""  # type: ignore[assignment]
    key = str(args["key"])
    web = Path(args["web"])
    os.environ["MAGNUSIM_BUNDLED_DIR"], os.environ["MAGNUSIM_PLUGINS_DIR"] = args["base"]
    load_all(web_root=web, force=True)
    before = set(sys.modules)
    os.environ["MAGNUSIM_BUNDLED_DIR"], os.environ["MAGNUSIM_PLUGINS_DIR"] = args["full"]
    t0 = time.perf_counter()
    with _HeavyImportWatch(Path(args["target"])) as watch:
        hub = load_all(web_root=web, force=True)
    load_s = time.perf_counter() - t0
    new = sorted(set(sys.modules) - before)
    # New modules show what loading pulled in; the watch shows what the plugin's own
    # code imported, including what the host had loaded already (numpy, pyvista, vtk).
    heavy = sorted({m.split(".")[0] for m in new if m.split(".")[0] in HEAVY} | watch.heavy)
    out: dict[str, Any] = {"key": key, "load_s": round(load_s, 3), "heavy": heavy}
    out["failures"] = [str(r.get("error") or "") for r in hub.failures if str(r.get("key")) == key]
    out["incompatible"] = [r for r in hub.incompatible if str(r.get("key")) == key]
    out["off"] = [r for r in hub.off_plugins if str(r.get("key")) == key]
    manifest = hub.manifests.get(key)
    out["loaded"] = manifest is not None
    out["warnings"] = list(getattr(manifest, "manifest_warnings", []) or [])
    env = getattr(manifest, "python_env", None)
    out["service"] = getattr(env, "service", "") if env else ""
    jobs = []
    reg = hub.registry("job")
    target = Path(args["target"]).resolve()
    for job_key in reg.keys():
        if reg.owner(job_key) != key:
            continue
        spec = reg.get(job_key)
        package = hub.job_package(job_key)
        tool = str(getattr(spec, "tool", ""))
        path = (Path(package) / tool).resolve() if package is not None else None
        jobs.append(
            {
                "key": job_key,
                "tool": tool,
                "python": str(getattr(spec, "python", "core")),
                "package": str(package) if package is not None else "",
                "tool_path": str(path) if path is not None else "",
                "inside": bool(path is not None and (path == target or target in path.parents)),
                "exists": bool(path is not None and path.is_file()),
            }
        )
    out["jobs"] = jobs
    hooks = get_hooks()
    named: set[str] = set()
    for table in (getattr(hooks, "_on", {}), getattr(hooks, "_around", {})):
        for name, rows in table.items():
            if any(len(row) > 1 and row[1] == key for row in rows):
                named.add(name)
    out["hooks"] = sorted(named)
    out["reserved_hooks"] = sorted(named & set(RESERVED_HOOKS))
    out["methods"] = sorted(m for (k, m) in getattr(hub, "_methods", {}) if k == key)
    return out


def check_load(plugin: Path, meta: dict[str, Any], report: Report, web_root: Path) -> dict[str, Any] | None:
    manifest = plugin / "manifest.toml"
    for link, why in link_problems(plugin):
        rel = link.relative_to(plugin).as_posix()
        report.add(
            "error",
            "load",
            f"a link that {why}: the host resolves links and refuses what is outside the plugin (a tool, a page, "
            "a file); copy what it needs into the plugin",
            rel,  # as written: resolving it would follow the link
        )
    probe = run_load_probe(plugin, meta, web_root)
    if probe.get("error"):
        report.add("error", "load", str(probe["error"]), manifest)
        return None
    for why in probe.get("failures", []):
        report.add("error", "load", f"the host refuses to load it: {why}", manifest)
    for row in probe.get("incompatible", []):
        report.add("error", "load", f"the host skips it: api_version {row.get('api_version')} does not fit host {row.get('host')}", manifest)
    if not probe.get("loaded") and not probe.get("failures") and not probe.get("incompatible"):
        report.add("error", "load", "the host did not load it and gave no reason", manifest)
    for why in probe.get("warnings", []):
        report.add("warning", "load", f"the host ignores part of the manifest: {why}", manifest)
    report.notes["load"] = f"loaded in {probe.get('load_s', 0):.2f} s" if probe.get("loaded") else "not loaded"
    return probe


# -- imports and register ---------------------------------------------------------


def check_imports(plugin: Path, report: Report) -> None:
    problems, _skipped = plugin_boundary.check_plugin(plugin, report.key or plugin.name)
    for p in problems:
        report.add("error", "imports", str(p.get("problem")), str(p.get("file") or ""), int(p.get("line") or 0))


def _runs_with(fn: ast.AST):
    """The nodes that run when fn runs: not the bodies of functions and lambdas it
    only defines (they run when called)."""
    stack = list(ast.iter_child_nodes(fn))
    while stack:
        node = stack.pop()
        yield node
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            stack.extend(ast.iter_child_nodes(node))


def _parse(path: Path) -> ast.Module | None:
    try:
        return ast.parse(path.read_bytes(), filename=str(path))
    except (OSError, SyntaxError, ValueError):
        return None  # imports reports a file Python cannot parse


def _find_register(plugin: Path, path: Path, tree: ast.Module, hops: int = 2) -> tuple[Path, ast.AST] | str | None:
    """register's definition: (file, node); "imported" when plugin.py binds the name
    in another way the AST cannot follow; None when nothing binds it."""
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "register":
            return path, node
    for node in tree.body:
        if isinstance(node, ast.ImportFrom):
            alias = next((a for a in node.names if (a.asname or a.name) == "register"), None)
            if alias is None:
                continue
            # Re-exported from the plugin's own module: follow it (a hop or two).
            base = path.parent if node.level else plugin
            for _ in range(max(0, node.level - 1)):
                base = base.parent
            parts = (node.module or "").split(".") if node.module else []
            for cand in (base.joinpath(*parts).with_suffix(".py") if parts else None, base.joinpath(*parts) / "__init__.py"):
                if cand is not None and cand.is_file() and hops > 0:
                    sub = _parse(cand)
                    found = _find_register(plugin, cand, sub, hops - 1) if sub is not None and alias.name == "register" else None
                    if isinstance(found, tuple):
                        return found
            return "imported"
        if isinstance(node, ast.Import) and any(a.asname == "register" for a in node.names):
            return "imported"
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(isinstance(tg, ast.Name) and tg.id == "register" for tg in targets):
                return "imported"
    return None


def check_register(plugin: Path, report: Report, probe: dict[str, Any] | None) -> None:
    plugin_py = plugin / "plugin.py"
    tree = _parse(plugin_py)
    seen: set[str] = set()
    if tree is not None:
        found = _find_register(plugin, plugin_py, tree)
        if found is None:
            report.add("error", "register", "plugin.py has no top-level register(hub)", plugin_py)
        elif isinstance(found, tuple):
            where, register = found
            for node in _runs_with(register):
                names: list[str] = []
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
                    names = [node.module]
                for name in names:
                    if name.split(".")[0] in HEAVY:
                        seen.add(name.split(".")[0])
                        report.add(
                            "error",
                            "register",
                            f"register() imports {name}: register only declares things; import it in the function that uses it",
                            where,
                            node.lineno,
                        )
        # "imported": register comes from where the AST cannot follow; loading the
        # plugin (below, and the load rule) still checks what it does.
    if probe is not None and probe.get("loaded"):
        for name in probe.get("heavy", []):
            if name in seen:
                continue  # said above, where it is
            report.add(
                "error",
                "register",
                f"loading the plugin imports {name}: keep heavy packages out of plugin.py and the modules it imports "
                "at load time (import them inside the functions that use them)",
                plugin_py,
            )


# -- React, workspace, ui ---------------------------------------------------------


def _shipped_scripts(plugin: Path, folder: str, suffixes: tuple[str, ...] = (".js", ".mjs", ".cjs")) -> list[Path]:
    root = plugin / folder
    if not root.is_dir():
        return []
    out = []
    for top, dirs, names in walk(root):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "__pycache__", "tests") and not d.startswith(".")]
        out += [Path(top) / n for n in names if n.lower().endswith(suffixes) and not n.endswith(".d.ts")]
    return out


def _pages(plugin: Path, folder: str) -> list[Path]:
    root = plugin / folder
    if not root.is_dir():
        return []
    out = []
    for top, dirs, names in walk(root):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "__pycache__", "tests") and not d.startswith(".")]
        out += [Path(top) / n for n in names if n.lower().endswith((".html", ".htm"))]
    return out


def _script_tags(html: str):
    """(attributes, body, offset, src or None, type) for each <script> of a page."""
    for tag in _SCRIPT_TAG.finditer(html):
        attrs, body = tag.group(1), tag.group(2)
        src = _SRC_ATTR.search(attrs)
        kind = _TYPE_ATTR.search(attrs)
        yield attrs, body, tag.start(), (src.group(2) if src else None), (kind.group(2).strip().lower() if kind else "")


def _runs_as_script(kind: str) -> bool:
    """A <script type> the browser runs (anything else is a data block it never runs)."""
    return kind in ("", "module") or any(w in kind for w in ("javascript", "ecmascript", "jscript", "livescript"))


def check_react(plugin: Path, report: Report) -> None:
    pkg = _package_json(plugin)
    for section in ("dependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"):
        deps = pkg.get(section) or {}
        names = deps if isinstance(deps, list) else list(deps) if isinstance(deps, dict) else []
        for name in names:
            if name in ("react", "react-dom") or str(name).startswith("react-dom/"):
                report.add(
                    "error",
                    "react",
                    f"package.json {section} has {name}: the host provides React; keep it in devDependencies "
                    "(types and tests) and mark it external in the build",
                    plugin / "package.json",
                )
    for script in _shipped_scripts(plugin, "workspace") + _shipped_scripts(plugin, "ui"):
        if re.match(r"^react(-dom)?([.-].*)?\.(m?js|cjs)$", script.name, re.I):
            report.add("error", "react", f"{script.name} looks like a copy of React; the host provides React", script)
            continue
        text = _read(script)
        marker = next((m for m in REACT_MARKERS if m in text), None)
        if marker:
            report.add(
                "error",
                "react",
                f"this script holds React's own code ({marker}): mark react, react-dom/client and the JSX runtime "
                "external in the build; the host provides them",
                script,
                _line_of(text, text.index(marker)),
            )
    # React from a URL (a CDN): a second React the host does not provide.
    urls: list[tuple[Path, int, str]] = []
    for page in _pages(plugin, "workspace") + _pages(plugin, "ui"):
        html = _read(page)
        for _attrs, _body, at, src, _kind in _script_tags(html):
            if src and remote(src):
                urls.append((page, _line_of(html, at), src))
    for script in _shipped_scripts(plugin, "workspace") + _shipped_scripts(plugin, "ui", SCRIPT_SUFFIXES):
        for spec, type_only, line in script_imports(_read(script)):
            if not type_only and remote(spec):
                urls.append((script, line, spec))
    for path, line, url in urls:
        if names_react(url):
            report.add(
                "error",
                "react",
                f"loads React from {url}: the host provides React (import 'react' and 'react-dom/client', "
                "which the host's import map resolves)",
                path,
                line,
            )


def _workspace_ref(ref: str, base: Path, plugin: Path, key: str) -> tuple[str | None, Path | None]:
    """A script a workspace frame loads (a <script src> or an import): (why the
    frame cannot run it, or None; the plugin file it names, when it names one)."""
    clean = re.split(r"[?#]", ref, maxsplit=1)[0]
    if ref.startswith("node:"):
        return f"{ref}, a Node.js module, which a browser cannot load: the page fails to start", None
    if remote(ref):
        return (
            f"{ref}, which is on another site: the frame's Content-Security-Policy runs scripts only from /plugin-sdk/ "
            "and the plugin's own workspace/ folder; bundle it into workspace/",
            None,
        )
    if clean.startswith("/"):
        if clean.startswith("/plugin-sdk/"):
            return None, None
        own = f"/plugins/{key}/workspace/"
        if not clean.startswith(own):
            return f"{ref}, a path the frame's Content-Security-Policy does not allow (only /plugin-sdk/ and {own})", None
        return None, plugin / "workspace" / clean[len(own):]
    return None, base / clean


def _check_workspace_file(ref: str, target: Path, folder: Path, kinds: tuple[str, ...] = WORKSPACE_JS) -> str | None:
    if not target.resolve().is_file():
        return f"{ref}, which is missing"
    if folder.resolve() not in target.resolve().parents:
        return f"{ref} from outside workspace/, which the host does not serve"
    if not target.name.lower().endswith(kinds):
        return (
            f"{ref}, which the host serves as {target.suffix or 'a file with no extension'}, not JavaScript, so the "
            "browser never runs it: name it .js or .mjs"
        )
    return None


def check_workspace(plugin: Path, meta: dict[str, Any], report: Report, web_root: Path) -> bool:
    """False when the plugin has no workspace (the check does not apply)."""
    rows = meta.get("workspaces")
    if not isinstance(rows, list) or not rows:
        return False
    allowed = set(import_map(web_root))
    folder = plugin / "workspace"
    key = str(meta.get("key") or plugin.name)
    sdk_seen = False
    for row in rows:
        if not isinstance(row, dict):
            continue
        entry = str(row.get("entry") or "workspace/index.html").replace("\\", "/")
        page = plugin / entry
        if not page.is_file():
            report.add("error", "workspace", f"workspace {row.get('key')!r}: its entry {entry} is missing", plugin / "manifest.toml")
            continue
        html = _read(page)
        tags = list(_script_tags(html))
        if not any(src for _a, _b, _at, src, kind in tags if _runs_as_script(kind)):
            report.add("error", "workspace", f"{entry} loads no script file, so the page never connects to the app", page)
        for _attrs, body, at, src, kind in tags:
            line = _line_of(html, at)
            if kind == "importmap":
                report.add(
                    "error",
                    "workspace",
                    f"{entry} has an import map of its own: the host adds the frame's import map, and its "
                    "Content-Security-Policy runs no other; import only what the host's map has",
                    page,
                    line,
                )
                continue
            if not _runs_as_script(kind):
                continue  # a data block (application/json, ...): never run
            if src:
                why, target = _workspace_ref(src, page.parent, plugin, key)
                if why is None and target is not None:
                    why = _check_workspace_file(src, target, folder)
                    why = f"loads {why}" if why else None
                elif why is not None:
                    why = f"loads {why}"
                if why:
                    report.add("error", "workspace", f"{entry} {why}", page, line)
            elif body.strip():
                report.add(
                    "error",
                    "workspace",
                    f"{entry} has an inline script: the frame's Content-Security-Policy runs no inline script, so "
                    "it never runs; move it to a .js file in workspace/ and load it with <script type=\"module\" src=...>",
                    page,
                    line,
                )
    for path in _shipped_scripts(plugin, "workspace"):
        text = _read(path)
        static = set(script_imports(text, static_only=True))
        for spec, type_only, line in script_imports(text):
            if spec == WORKSPACE_SDK:
                sdk_seen = True
            if type_only:
                continue
            if spec.startswith("node:") and (spec, type_only, line) not in static:
                # import("node:fs") / require("node:fs"): Node-only branches of a
                # build (WASM glue checks where it runs); a browser never reaches them.
                continue
            if _bare(spec):
                if spec not in allowed:
                    report.add(
                        "error",
                        "workspace",
                        f"imports {spec!r}, which a workspace frame cannot resolve: the host's import map has "
                        f"{', '.join(sorted(allowed))}; bundle it into your build or drop it",
                        path,
                        line,
                    )
                continue
            why, target = _workspace_ref(spec, path.parent, plugin, key)
            if why is None and target is not None:
                # import ... with { type: 'json' | 'css' } loads those as modules too.
                why = _check_workspace_file(spec, target, folder, WORKSPACE_JS + (".json", ".css"))
            if why:
                report.add("error", "workspace", f"imports {why}", path, line)
    if not sdk_seen:
        report.add(
            "error",
            "workspace",
            "no workspace script imports '@magnusim/workspace': the page never calls connect(), so it cannot "
            "reach the app",
            folder if folder.is_dir() else plugin / "manifest.toml",
        )
    return True


def _ui_dir(meta: dict[str, Any]) -> tuple[str | None, str]:
    from cfddesk.registry.discovery import _ui_fields

    return _ui_fields(meta)


def check_ui(plugin: Path, meta: dict[str, Any], report: Report) -> bool:
    ui, entry = _ui_dir(meta)
    if not ui:
        return False
    root = plugin / ui
    if not (root / entry).is_file():
        report.add("error", "ui", f"the UI entry {ui}/{entry} is missing", plugin / "manifest.toml")
        return True
    for top, dirs, names in walk(root):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "__pycache__", "tests") and not d.startswith(".")]
        for n in names:
            if not n.lower().endswith(SCRIPT_SUFFIXES) or n.endswith(".d.ts") or re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", n):
                continue
            path = Path(top) / n
            for spec, type_only, line in script_imports(_read(path)):
                if type_only or spec in UI_IMPORTS:
                    continue
                if spec.startswith(("./", "../")):
                    target = (path.parent / spec).resolve()
                    if root.resolve() not in target.parents:
                        report.add("error", "ui", f"imports {spec!r}, which leaves the {ui} folder", path, line)
                    continue
                # The host's bundler (plugin-ui-bundle.ts) refuses every other
                # specifier: packages, URLs and absolute paths alike.
                report.add(
                    "error",
                    "ui",
                    f"imports {spec!r}: a plugin UI may import only {', '.join(UI_IMPORTS)} and its own files "
                    "(./ or ../ inside its folder); the host's bundler refuses anything else",
                    path,
                    line,
                )
    return True


# -- tools, requirements, hooks ---------------------------------------------------


def check_tools(plugin: Path, meta: dict[str, Any], report: Report, probe: dict[str, Any] | None) -> bool:
    applies = False
    if probe is not None:
        for job in probe.get("jobs", []):
            applies = True
            if not job.get("package"):
                report.add(
                    "error",
                    "tools",
                    f"job {job['key']!r} is registered without package_dir, so the host runs a core tool named "
                    f"{job['tool']!r}: use hub.register_job(spec, plugin=PLUGIN, package_dir=<the plugin folder>)",
                    plugin / "plugin.py",
                )
            elif not job.get("inside"):
                report.add("error", "tools", f"job {job['key']!r}: its tool {job['tool']!r} is outside the plugin folder", plugin / "plugin.py")
            elif not job.get("exists"):
                report.add("error", "tools", f"job {job['key']!r}: its tool {job['tool']!r} is missing", plugin / "plugin.py")
            if job.get("python") == "plugin" and not isinstance(meta.get("python"), dict):
                report.add(
                    "error",
                    "tools",
                    f"job {job['key']!r} runs on the plugin's own environment (python=\"plugin\") but the manifest has no [python] table",
                    plugin / "manifest.toml",
                )
    py = meta.get("python")
    service = str(py.get("service") or "") if isinstance(py, dict) else ""
    if service:
        applies = True
        parts = service.split(".")
        candidates = [plugin.joinpath(*parts).with_suffix(".py"), plugin.joinpath(*parts) / "__init__.py"]
        if not any(c.is_file() for c in candidates):
            report.add(
                "error",
                "tools",
                f"[python] service {service!r} is not a module in the plugin folder (looked for "
                f"{candidates[0].relative_to(plugin).as_posix()} and {candidates[1].relative_to(plugin).as_posix()})",
                plugin / "manifest.toml",
            )
    return applies


def lock_problems(text: str) -> list[tuple[int, str]]:
    """(line, problem) for a requirements lock that is not pinned and hashed (the
    text decoded as pip decodes it: see decode_text)."""
    out: list[tuple[int, str]] = []
    logical: list[tuple[int, str]] = []
    start, buf = 0, ""
    for i, raw in enumerate(text.lstrip(chr(0xFEFF)).splitlines(), 1):
        line = re.sub(r"(^|\s)#.*$", "", raw).rstrip()
        if not buf:
            start = i
        if line.endswith("\\"):
            buf += line[:-1] + " "
            continue
        buf += line
        if buf.strip():
            logical.append((start, buf.strip()))
        buf = ""
    if buf.strip():
        logical.append((start, buf.strip()))
    for line_no, entry in logical:
        if entry.startswith("-"):
            opt = entry.split()[0]
            name = opt.split("=", 1)[0]
            banned = None
            if not opt.startswith("--") and opt[:2] in _NOT_PINNED_SHORT:
                banned = opt[:2]
            for full, shortest in _NOT_PINNED_LONG:
                if name.startswith(shortest) and full.startswith(name):
                    banned = full
            if banned:
                shown = banned if opt == banned else f"{banned} (as {opt})"
                out.append((line_no, f"{shown} is not allowed in a lock: list every package pinned with == and hashed"))
            continue
        requirement = re.split(r"\s--hash", entry, maxsplit=1)[0].strip()
        if not _PIN.match(requirement):
            out.append((line_no, f"{requirement!r} is not pinned: write name==version (one exact version)"))
        if not _HASH.search(entry):
            out.append((line_no, f"{requirement!r} has no --hash=sha256:...; pip installs plugin locks with --require-hashes"))
    return out


def check_requirements(plugin: Path, meta: dict[str, Any], report: Report) -> bool:
    py = meta.get("python")
    if not isinstance(py, dict):
        return False
    rel = str(py.get("requirements") or "requirements.lock")
    lock = plugin / rel
    if not lock.is_file():
        report.add("error", "requirements", f"[python] requirements {rel!r} is missing", plugin / "manifest.toml")
        return True
    for line, why in lock_problems(_read(lock)):
        report.add("error", "requirements", why, lock, line)
    return True


def check_hooks(plugin: Path, report: Report, probe: dict[str, Any] | None) -> bool:
    if probe is None or not probe.get("loaded"):
        return False
    for name in probe.get("reserved_hooks", []):
        report.add(
            "warning",
            "hooks",
            f"it listens to {name!r}, which this host reserves and never fires (API {API_VERSION}); the listener never runs",
            plugin / "plugin.py",
        )
    return bool(probe.get("hooks"))


# -- colours and copy -------------------------------------------------------------


def _blank(match: re.Match[str]) -> str:
    """The match as spaces, keeping its line breaks (so line numbers stay right)."""
    return re.sub(r"[^\n]", " ", match.group(0))


def _colour_text(text: str) -> str:
    """CSS text with what is not a stray colour blanked: comments, var(--token, #hex)
    fallbacks (the token is used), token definitions (--name: #hex, where a hex
    belongs) and url(#id) references."""
    text = _CSS_COMMENT.sub(_blank, text)
    text = _CSS_VAR.sub(_blank, text)
    text = _CSS_TOKEN_DECL.sub(_blank, text)
    return _URL_REF.sub(_blank, text)


def colour_hits(path: Path, text: str) -> list[tuple[int, str]]:
    """(line, hex) for each hex colour outside a token in one file's text."""
    suffix = path.suffix.lower()
    hits: list[tuple[int, str]] = []
    if suffix in SCRIPT_SUFFIXES:
        # Only string literals hold colours in a script; template literals may span lines.
        _code, spans = js_scan(text)
        for start, end in spans:
            if _ATTR_BEFORE.search(text, max(0, start - 40), start):
                continue  # href="#add", id='#bed': a reference, not a colour
            literal = _colour_text(text[start:end])
            hits += [(_line_of(text, start + m.start()), m.group(0)) for m in HEX.finditer(literal)]
        return hits
    if suffix in (".html", ".htm", ".svg"):
        text = _REF_ATTR.sub(_blank, text)
    text = _colour_text(text)
    return [(_line_of(text, m.start()), m.group(0)) for m in HEX.finditer(text)]


def check_colours(plugin: Path, report: Report) -> None:
    for path in own_files(plugin, COLOUR_SUFFIXES):
        for line, colour in colour_hits(path, _read(path)):
            report.add(
                "warning",
                "colours",
                f"hex colour {colour} outside a token: use var(--mg-…) from the design tokens",
                path,
                line,
            )


def check_copy(plugin: Path, report: Report) -> None:
    for path in own_files(plugin, COPY_SUFFIXES):
        is_md = path.suffix.lower() == ".md"
        for i, line in enumerate(_read(path).splitlines(), 1):
            scope = _MD_QUOTED.sub(" ", line) if is_md else line
            for word, rx in BANNED_COPY:
                if rx.search(scope):
                    report.add(
                        "error",
                        "copy",
                        f"{word!r} in shipped text: finish it or remove it (no placeholder copy)",
                        path,
                        i,
                    )


# -- tests ------------------------------------------------------------------------


def _python_tests(plugin: Path) -> bool:
    tests = plugin / "tests"
    if not tests.is_dir():
        return False
    for _top, dirs, names in walk(tests):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "__pycache__") and not d.startswith(".")]
        if any(re.match(r"^(test_.*|.*_test)\.py$", n) for n in names):
            return True
    return False


def _tail(text: str, n: int = 15) -> str:
    return "\n".join(text.strip().splitlines()[-n:])


def check_tests(plugin: Path, report: Report, run: bool) -> None:
    pkg_test = (_package_json(plugin).get("scripts") or {}).get("test")
    has_py = _python_tests(plugin)
    suites = (["pytest"] if has_py else []) + (["npm test"] if pkg_test else [])
    report.tests = {"suites": suites, "status": "none", "results": {}}
    e2e = [d for d in ("tests/e2e", "e2e") if (plugin / d).is_dir()]
    if e2e:
        report.tests["e2e"] = f"{e2e[0]}/ is not run here: it needs the app (see its playwright config)"
    if not suites:
        report.add("warning", "tests", "no tests: add pytest tests in tests/ (npm run plugin:new writes a set)", plugin / "tests")
        return
    if not run:
        report.tests["status"] = "skipped"
        return
    with tempfile.TemporaryDirectory(prefix="magnusim-plugin-tests-") as scratch:
        settings = Path(scratch) / "settings.json"
        settings.write_text("{}", encoding="utf-8")
        env = dict(os.environ)
        extra = os.pathsep.join(str(p) for p in (PY_ROOT, PY_ROOT / "sdk"))
        env["PYTHONPATH"] = extra + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        # The tests never see this PC's settings (or write them).
        env["MAGNUSIM_LOCAL_JSON"] = str(settings)
        env["CFDDESK_LOCAL_JSON"] = str(settings)
        env.pop("MAGNUSIM_PLUGINS_DIR", None)
        env.pop("MAGNUSIM_BUNDLED_DIR", None)
        env["PYTHONIOENCODING"] = "utf-8"
        failed = False
        for suite in suites:
            t0 = time.perf_counter()
            if suite == "pytest":
                cmd = [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"]
            else:
                if not (plugin / "node_modules").is_dir():
                    report.add(
                        "error",
                        "tests",
                        "npm test needs the plugin's own packages: run npm ci in the plugin folder first (or pass --no-tests)",
                        plugin / "package.json",
                    )
                    report.tests["results"][suite] = {"status": "not run"}
                    failed = True
                    continue
                cmd = ["npm", "test"]
            try:
                done = subprocess.run(
                    cmd,
                    cwd=str(plugin),
                    env=env,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=1800,
                    shell=(os.name == "nt" and suite != "pytest"),
                )
                code, output = done.returncode, (done.stdout or "") + (done.stderr or "")
            except subprocess.TimeoutExpired:
                code, output = -1, "timed out after 1800 s"
            seconds = round(time.perf_counter() - t0, 1)
            status = "passed" if code == 0 else "failed"
            report.tests["results"][suite] = {"status": status, "seconds": seconds, "exit": code}
            if code != 0:
                failed = True
                report.add("error", "tests", f"{suite} failed (exit {code}):\n{_tail(output)}", plugin / "tests" if suite == "pytest" else plugin / "package.json")
        report.tests["status"] = "failed" if failed else "passed"


# -- running ----------------------------------------------------------------------


def check_plugin(path: Path | str, *, run_tests: bool = True, web_root: Path = WEB_ROOT, load: bool = True) -> Report:
    # The real path: a trailing .., and on Windows the folder's real letter case
    # (the key rule compares the key with the folder's name).
    plugin = Path(path).resolve()
    report = Report(path=str(path))
    meta = check_manifest(plugin, report)
    if meta is None:
        for cid, _ in CHECKS:
            report.checks[cid] = "fail" if cid == "manifest" else "skipped"
        report.notes["skipped"] = "the manifest could not be read, so nothing else was checked"
        return report
    applies: dict[str, bool] = {}
    check_key(plugin, meta, report, web_root)
    check_api_version(plugin, meta, report)
    check_license(plugin, meta, report)
    probe = check_load(plugin, meta, report, web_root) if load else None
    check_imports(plugin, report)
    check_register(plugin, report, probe)
    check_react(plugin, report)
    applies["workspace"] = check_workspace(plugin, meta, report, web_root)
    applies["ui"] = check_ui(plugin, meta, report)
    applies["tools"] = check_tools(plugin, meta, report, probe)
    applies["requirements"] = check_requirements(plugin, meta, report)
    applies["hooks"] = check_hooks(plugin, report, probe)
    check_colours(plugin, report)
    check_copy(plugin, report)
    check_tests(plugin, report, run_tests)
    for cid, _ in CHECKS:
        found = [f for f in report.findings if f.check == cid]
        if any(f.level == "error" for f in found):
            report.checks[cid] = "fail"
        elif found:
            report.checks[cid] = "warn"
        elif cid in ("load", "hooks") and not load:
            report.checks[cid] = "skipped"
        elif cid == "tests" and report.tests.get("status") == "skipped":
            report.checks[cid] = "skipped"
        elif cid in applies and not applies[cid]:
            report.checks[cid] = "n/a"
        else:
            report.checks[cid] = "pass"
    return report


def _check_or_report_crash(folder: Path, **kw: Any) -> Report:
    """check_plugin, or, when the check itself fails on this plugin, a report that
    says so: the other plugins of the run are still checked and reported."""
    try:
        return check_plugin(folder, **kw)
    except Exception as exc:  # noqa: BLE001 (any failure becomes this plugin's finding)
        import traceback

        report = Report(path=str(folder))
        tail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
        report.add("error", "load", f"plugin:check itself failed on this plugin, so its rules were not all run: {tail}")
        for cid, _ in CHECKS:
            report.checks[cid] = "fail" if cid == "load" else "skipped"
        return report


def expand(paths: list[str], base: Path) -> list[Path]:
    """Paths relative to ``base``; a glob (bundled-plugins/*) is expanded here, as Windows shells do not."""
    out: list[Path] = []
    for raw in paths:
        p = Path(raw)
        full = p if p.is_absolute() else base / p
        if any(ch in raw for ch in "*?[") and not full.exists():
            hits = sorted(Path(h) for h in glob.glob(str(full)))
            out += [h for h in hits if (h / "manifest.toml").is_file()]
        else:
            out.append(full)
    return out


_MARK = {"pass": "ok  ", "fail": "FAIL", "warn": "warn", "n/a": "n/a ", "skipped": "skip"}


def render(report: Report) -> str:
    head = f"{report.path}"
    if report.key:
        head += f"  ({report.key}{' ' + report.version if report.version else ''})"
    lines = [head]
    titles = dict(CHECKS)
    for cid, _ in CHECKS:
        status = report.checks.get(cid, "skipped")
        extra = ""
        if cid == "tests":
            results = report.tests.get("results") or {}
            if results:
                extra = "  " + ", ".join(f"{k}: {v.get('status')}" + (f" in {v['seconds']} s" if "seconds" in v else "") for k, v in results.items())
            elif report.tests.get("status") == "skipped":
                extra = f"  not run (--no-tests): {', '.join(report.tests.get('suites') or [])}"
        elif cid in report.notes:
            extra = f"  {report.notes[cid]}"
        lines.append(f"  {_MARK.get(status, status)}  {cid:<12} {titles[cid]}{extra}")
        for f in report.findings:
            if f.check != cid:
                continue
            where = f.file + (f":{f.line}" if f.line else "") if f.file else ""
            label = "error" if f.level == "error" else "warning"
            msg = f.message.replace("\n", "\n" + " " * 14)
            lines.append(f"          {label}: {where + ': ' if where else ''}{msg}")
    if report.tests.get("e2e"):
        lines.append(f"  note: {report.tests['e2e']}")
    verdict = "PASS" if report.ok else "FAIL"
    lines.append(f"  {verdict}: {report.errors} error(s), {report.warnings} warning(s)")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["--probe"]:
        out = json.dumps(_probe(json.loads(argv[1])))
        sys.stdout.write("\n" + out + "\n")
        return 0
    p = argparse.ArgumentParser(
        prog="plugin:check",
        description="Check Magnusim plugin folders against the plugin rules (docs/plugins).",
    )
    p.add_argument("paths", nargs="+", help="plugin folders (globs are expanded: bundled-plugins/*)")
    p.add_argument("--json", action="store_true", help="print one JSON report instead of text")
    p.add_argument("--no-tests", action="store_true", help="do not run the plugins' own tests (reported as skipped)")
    p.add_argument("--base", default=os.environ.get("INIT_CWD") or os.getcwd(), help=argparse.SUPPRESS)
    args = p.parse_args(argv)
    folders = expand(args.paths, Path(args.base))
    bad = [f for f in folders if not (f / "manifest.toml").is_file()]
    if not folders or bad:
        for f in bad:
            print(f"plugin:check: {f} is not a plugin folder (no manifest.toml)", file=sys.stderr)
        if not folders:
            print("plugin:check: no plugin folders match " + " ".join(args.paths), file=sys.stderr)
        return 2
    reports = [_check_or_report_crash(f, run_tests=not args.no_tests) for f in folders]
    if args.json:
        doc = {"ok": all(r.ok for r in reports), "host_api": API_VERSION, "plugins": [r.as_dict() for r in reports]}
        sys.stdout.buffer.write((json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    else:
        text = "\n\n".join(render(r) for r in reports) + "\n"
        if len(reports) > 1:
            passed = sum(1 for r in reports if r.ok)
            text += f"\n{passed} of {len(reports)} plugin(s) pass\n"
        sys.stdout.buffer.write(text.encode("utf-8"))
    return 0 if all(r.ok for r in reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
