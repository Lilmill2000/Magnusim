"""A plugin's own data in a project (API 1.1): ``magnusim_sdk.data``, re-exported.

The one copy lives in the SDK, so the host and a plugin's service (in its own
environment) use the same code. See :mod:`magnusim_sdk.data`.
"""

from __future__ import annotations

from magnusim_sdk.data import (
    KIND_KEY_RE,
    PLUGIN_KEY_RE,
    STALE_MESSAGE,
    STUDY_ID_RE,
    PluginData,
    PluginDataError,
    StaleRevisionError,
    plugin_data_folders,
    version_tuple,
)

__all__ = [
    "KIND_KEY_RE",
    "PLUGIN_KEY_RE",
    "STALE_MESSAGE",
    "STUDY_ID_RE",
    "PluginData",
    "PluginDataError",
    "StaleRevisionError",
    "plugin_data_folders",
    "version_tuple",
]
