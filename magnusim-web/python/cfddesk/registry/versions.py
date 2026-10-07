"""Plugin version order (semantic versioning, prereleases included).

``0.2.0-dev < 0.2.0 < 0.2.1 < 1.0.0``; ``1.0`` equals ``1.0.0``. Prerelease
identifiers compare as semver says: numbers numerically, words by ASCII, numbers
before words, and a shorter list of equal identifiers first
(``1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0``). Build metadata (``+...``)
is ignored. A version that does not parse sorts below every one that does.
"""

from __future__ import annotations

import re

_VERSION_RE = re.compile(
    r"^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$"
)


def parse_version(text: str) -> tuple[tuple[int, int, int], tuple[str, ...]] | None:
    """(major, minor, patch), prerelease identifiers; None when it does not parse."""
    m = _VERSION_RE.match(str(text or ""))
    if not m:
        return None
    nums = (int(m.group(1)), int(m.group(2) or 0), int(m.group(3) or 0))
    pre = tuple(p for p in (m.group(4) or "").split(".") if p)
    return nums, pre


def _cmp_pre(a: tuple[str, ...], b: tuple[str, ...]) -> int:
    if not a and not b:
        return 0
    if not a:
        return 1  # a release is above any of its prereleases
    if not b:
        return -1
    for x, y in zip(a, b, strict=False):
        if x == y:
            continue
        xd, yd = x.isdigit(), y.isdigit()
        if xd and yd:
            return -1 if int(x) < int(y) else 1
        if xd != yd:
            return -1 if xd else 1  # numbers sort before words
        return -1 if x < y else 1
    return (len(a) > len(b)) - (len(a) < len(b))


def compare_versions(a: str, b: str) -> int:
    """-1, 0 or 1 as version ``a`` is below, equal to or above ``b``."""
    pa, pb = parse_version(a), parse_version(b)
    if pa is None or pb is None:
        if pa is None and pb is None:
            return 0
        return -1 if pa is None else 1
    if pa[0] != pb[0]:
        return -1 if pa[0] < pb[0] else 1
    return _cmp_pre(pa[1], pb[1])
