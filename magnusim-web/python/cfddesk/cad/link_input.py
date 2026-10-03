"""The link input (host API 1.5): a plugin's shape file and its face-name sidecar.

The rules live in ``magnusim_sdk.link``, the one copy the host and every linking
plugin use (``python -m magnusim_sdk.link check`` runs the same checks from a
shell). This module gives the link job their names:

- ``bad_brep``: the file does not read as a BREP, or a face lies outside every solid
  (faces are numbered per solid visit, so every face must be inside one);
- ``empty``: it reads, but has no solid;
- ``bad_face_names``: the sidecar breaks a rule of the face-name schema (5.11);
- ``unsupported_format``: a shape format this host does not read (1.5: only 'brep').

Nothing here is the plugin's code: the host reads the bytes the plugin wrote, in the
job's own process.
"""

from __future__ import annotations

from magnusim_sdk.link import (
    FORMATS,
    LABEL_MAX,
    MAX_BODIES,
    MAX_FACES,
    NAME_MAX,
    NAMES_FORMAT,
    NAMES_MAX_BYTES,
    NAMES_VERSION,
    LinkInputError,
    LinkShape,
    brep_encoding,
    canonical_names_sha256,
    check_face_names,
    clean_text,
    read_face_names,
    sha256_file,
)
from magnusim_sdk.link import check_shape as check_link_shape
from magnusim_sdk.link import read_shape as read_link_shape

__all__ = [
    "FORMATS",
    "LABEL_MAX",
    "MAX_BODIES",
    "MAX_FACES",
    "NAME_MAX",
    "NAMES_FORMAT",
    "NAMES_MAX_BYTES",
    "NAMES_VERSION",
    "LinkInputError",
    "LinkShape",
    "brep_encoding",
    "canonical_names_sha256",
    "check_face_names",
    "check_link_shape",
    "clean_text",
    "read_face_names",
    "read_link_shape",
    "sha256_file",
]
