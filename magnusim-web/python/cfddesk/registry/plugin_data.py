"""A plugin's own data in a project (API 1.2): ``magnusim_sdk.data``, re-exported.

The one copy lives in the SDK, so the host and a plugin's service (in its own
environment) use the same code. See :mod:`magnusim_sdk.data`.
"""

from __future__ import annotations

from magnusim_sdk.data import (
    FILE_TEMP_PREFIX,
    KIND_KEY_RE,
    MAX_ENTRIES,
    PLUGIN_KEY_RE,
    STALE_MESSAGE,
    STUDY_ID_RE,
    STUDY_RECORD_MESSAGE,
    FileInfo,
    PluginData,
    PluginDataError,
    StaleRevisionError,
    StudyNotFoundError,
    data_rel,
    is_study_container,
    is_study_record,
    plugin_data_folders,
    version_tuple,
)

__all__ = [
    "FILE_TEMP_PREFIX",
    "KIND_KEY_RE",
    "MAX_ENTRIES",
    "PLUGIN_KEY_RE",
    "STALE_MESSAGE",
    "STUDY_ID_RE",
    "STUDY_RECORD_MESSAGE",
    "FileInfo",
    "PluginData",
    "PluginDataError",
    "StaleRevisionError",
    "StudyNotFoundError",
    "data_rel",
    "is_study_container",
    "is_study_record",
    "plugin_data_folders",
    "version_tuple",
]
