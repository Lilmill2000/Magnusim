"""Plugin manifest dataclass."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from cfddesk.registry.requirements import Requirement


@dataclass(frozen=True)
class StudyKind:
    """A project-level study a plugin owns (manifest ``[[study_kinds]]``, API 1.1)."""

    key: str
    title: str
    # One SVG path (``d``) drawn in a 24x24 box with the tree's stroke icons.
    icon: str = ""
    # The workspace that opens it (H13); empty until the plugin has one.
    workspace: str = ""
    schema_version: int = 1
    # API 1.4: a study of this kind may link one project geometry (used from 1.5).
    # Needs a workspace: the link is a workspace bridge call.
    links_geometry: bool = False


# Where the host draws a start action (manifest ``[[start_actions]]`` ``places``).
START_ACTION_PLACES = ("empty_project", "header", "new_project", "home")


@dataclass(frozen=True)
class StartAction:
    """A button that creates a study of a kind and opens it in its workspace
    (manifest ``[[start_actions]]``, API 1.4).

    ``places`` keeps only the places this host knows, in the manifest's order.
    ``home_label`` is Home's text and ``header_label`` the header button's; ""
    means the host's default (``label``, and the workspace title).
    """

    study_kind: str
    label: str
    hint: str = ""
    icon: str = ""
    places: tuple[str, ...] = START_ACTION_PLACES
    home_label: str = ""
    header_label: str = ""


@dataclass(frozen=True)
class WorkspaceSpec:
    """A full workspace a plugin draws itself (manifest ``[[workspaces]]``, API 1.1).

    It runs in a sandboxed frame (opaque origin) inside the host's chrome and
    talks to the app only through the workspace bridge. ``entry`` is an HTML
    file in the plugin's ``workspace/`` folder, which the host serves at
    ``/plugins/<key>/workspace/``. A study kind opens it (``workspace = key``).
    """

    key: str
    title: str
    icon: str = ""
    entry: str = "workspace/index.html"


MB = 1024 * 1024


@dataclass(frozen=True)
class FilesSpec:
    """Size limits for a plugin's own files in a project (manifest ``[files]``, API 1.2).

    ``max_file_mb`` (1..4096, default 64) and ``max_total_mb`` (1..65536,
    default 512, at least ``max_file_mb``), kept here in bytes. The host holds a
    workspace's uploads (``ws.files``) to both, and its JSON writes (``ws.data``)
    to the total; the plugin's own Python writes are not capped.
    """

    max_file_bytes: int = 64 * MB
    max_total_bytes: int = 512 * MB


@dataclass(frozen=True)
class PythonEnvSpec:
    """A plugin's own Python environment (manifest ``[python]``, API 1.1).

    Paths are relative to the plugin folder. ``lock_hash`` is the lock file's
    content hash: a new one means a new environment ("Needs setup").
    """

    requirements: str = "requirements.lock"
    python: str = ""  # supported interpreter range, e.g. ">=3.10,<3.13"
    service: str = ""  # module run by magnusim_sdk.service (its backend)
    find_links: str = ""  # a folder of wheels in the plugin (offline installs)
    lock_hash: str = ""


@dataclass
class PluginManifest:
    key: str
    name: str
    version: str = "0.0.0"
    requires: list[Requirement] = field(default_factory=list)
    provides: dict[str, list[str]] = field(default_factory=dict)
    ui: str | None = None  # relative dir under the plugin folder, e.g. "ui"
    ui_entry: str = "index.js"  # file under `ui`, loaded as /plugins/<key>/ui/<entry>
    authors: list[str] = field(default_factory=list)
    description: str = ""
    overrides: list[str] = field(default_factory=list)
    api_version: str = "1.0"
    source: str = ""  # "bundled" (bundled-plugins/), "local" (plugins/) or "entry_point"
    # SPDX identifier. Magnusim is GPL-3.0-or-later; a distributed plugin must be
    # GPL-3.0-or-later or GPL-compatible (docs/plugins/authoring.md).
    license: str = ""
    # Bundled tier (API 1.1). A required plugin cannot be turned off, and the
    # app refuses to create or run simulations without it.
    tier: str = "user"  # "bundled" | "user"
    required: bool = False
    # An optional bundled plugin with default_enabled = false ships off: it is not
    # imported until someone on this PC turns it on (plugins.enabled).
    default_enabled: bool = True
    # Plugins this one needs loaded first: "key" or "key>=1.0".
    requires_plugins: list[str] = field(default_factory=list)
    # "kind:key" specs of this plugin that other plugins may not drop.
    protected: list[str] = field(default_factory=list)
    # [default_analysis] (a required bundled plugin only): the analysis a study
    # gets when none is named, {"steady", "transient", "aliases"}; aliases are
    # the names studies saved before analysis keys carry.
    default_analysis: dict[str, Any] = field(default_factory=dict)
    # Project-level studies it owns (plugins/<key>/studies/<sid>).
    study_kinds: list[StudyKind] = field(default_factory=list)
    # Full workspaces it draws in a sandboxed frame ([[workspaces]]).
    workspaces: list[WorkspaceSpec] = field(default_factory=list)
    # Buttons that create a study and open it ([[start_actions]], API 1.4).
    start_actions: list[StartAction] = field(default_factory=list)
    # What the manifest asked for that this host ignores (shown on its Settings row).
    manifest_warnings: list[str] = field(default_factory=list)
    # Size limits for its own files in a project ([files]).
    files: FilesSpec = field(default_factory=FilesSpec)
    # Its own environment and service ([python]); None runs in the core (bundled, no extra packages).
    python_env: PythonEnvSpec | None = None
