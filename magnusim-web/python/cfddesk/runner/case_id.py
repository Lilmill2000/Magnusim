"""WSL case-id validation and slugification.

Destructive sync uses ``rm -rf`` on ``~/cases/<id>``. An empty id would resolve
to the case root itself — never allow that. IDs must be filesystem-safe
(``cfddesk-[a-z0-9-]+``) so spaces in Windows project folder names cannot
break ``cd`` / OpenFOAM commands.
"""

from __future__ import annotations

import re

from cfddesk.wsl.config import get_wsl_case_root


# Re-export for ``from cfddesk.runner.case_id import WSL_CASE_ROOT``.
# Value comes from ``.cfddesk-local.json`` / env (see ``cfddesk.wsl.config``).
def __getattr__(name: str):
    if name == "WSL_CASE_ROOT":
        return get_wsl_case_root()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

# Exact production pattern: prefix + lowercase alnum segments.
WSL_CASE_ID_RE = re.compile(r"^cfddesk-[a-z0-9]+(?:-[a-z0-9]+)*$")


class InvalidWslCaseId(ValueError):
    """Raised when a WSL case id is empty, unsafe, or malformed."""


def slugify_wsl_case_id(raw: str) -> str:
    """Build a safe ``cfddesk-…`` id from a project folder name or prior id.

    Spaces and other non ``[a-z0-9-]`` characters become hyphens. Empty input
    after cleaning raises — never return a blank id.
    """
    s = (raw or "").strip().lower()
    if s.startswith("cfddesk-"):
        body = s[len("cfddesk-") :]
    else:
        body = s
    body = re.sub(r"[^a-z0-9]+", "-", body)
    body = re.sub(r"-+", "-", body).strip("-")
    if not body:
        raise InvalidWslCaseId(
            f"cannot slugify wsl_case_id from {raw!r} — empty after cleaning"
        )
    return validate_wsl_case_id(f"cfddesk-{body}")


def validate_wsl_case_id(wsl_case_id: str) -> str:
    """Refuse empty / whitespace-only / non-matching ids."""
    if wsl_case_id is None or not str(wsl_case_id).strip():
        raise InvalidWslCaseId(
            "wsl_case_id is empty or whitespace-only — refusing to resolve "
            f"under {get_wsl_case_root()}/ (would target the case root)"
        )
    s = str(wsl_case_id).strip()
    # Reject path separators / traversal before regex
    if "/" in s or "\\" in s or ".." in s:
        raise InvalidWslCaseId(f"wsl_case_id must be a single path segment, got {s!r}")
    if not WSL_CASE_ID_RE.fullmatch(s):
        raise InvalidWslCaseId(
            f"wsl_case_id must match cfddesk-[a-z0-9-]+ (no spaces/uppercase), got {s!r}"
        )
    return s


def wsl_case_path(wsl_case_id: str) -> str:
    """Absolute ext4 path ``~/cases/<validated_id>``. Never returns the case root."""
    name = validate_wsl_case_id(wsl_case_id)
    dest = f"{get_wsl_case_root()}/{name}"
    assert_safe_wsl_case_dest(dest)
    return dest


def assert_safe_wsl_case_dest(dest: str) -> str:
    """Refuse ``rm -rf`` targets that are not a proper subdirectory of the case root."""
    d = dest.rstrip("/")
    root = get_wsl_case_root().rstrip("/")
    if not d or d == root or d == "/":
        raise InvalidWslCaseId(
            f"refusing destructive WSL path equal to case root or filesystem root: {dest!r}"
        )
    if not d.startswith(root + "/"):
        raise InvalidWslCaseId(
            f"refusing WSL path outside {root}/: {dest!r}"
        )
    # Exactly one extra segment under the root
    rel = d[len(root) + 1 :]
    if not rel or "/" in rel:
        raise InvalidWslCaseId(
            f"refusing nested or empty WSL case dest (must be {root}/<id>): {dest!r}"
        )
    validate_wsl_case_id(rel)
    return d
