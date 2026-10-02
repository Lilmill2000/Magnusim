"""The plugin manifest's JSON Schema, built from the host's own definitions.

``manifest.toml`` is read by :mod:`cfddesk.registry.discovery` into the
dataclasses of :mod:`cfddesk.registry.manifest`. This module turns those into a
JSON Schema (``docs/plugins/manifest.schema.json``, written by
``npm run gen:plugin-docs``) and validates a parsed manifest against it
(``tools/plugin_check.py``):

- the tables of arrays (``[[study_kinds]]``, ``[[workspaces]]``,
  ``[[start_actions]]``) take their keys, types and defaults from the
  dataclasses' fields, so a field added there shows up here;
- every top-level ``PluginManifest`` field is mapped to its manifest key or
  listed as one the host sets itself. A field this module does not know makes
  :func:`build_schema` raise, so the generated docs cannot fall behind
  ``manifest.py`` silently (``gen:plugin-docs:check`` fails in CI);
- patterns and enums are the loader's own (``PLUGIN_KEY_RE``, ``KIND_KEY_RE``,
  the icon path pattern, ``START_ACTION_PLACES``).

The loader stays the authority on what loads; the schema adds what a parser
cannot say, such as a misspelt key, which the host ignores without a word.

CLI: tools/plugin_manifest_schema.py prints the schema.
"""

from __future__ import annotations

import dataclasses
import json
import re
import sys
from pathlib import Path
from typing import Any

_PY_ROOT = Path(__file__).resolve().parents[1]
for _p in (_PY_ROOT, _PY_ROOT / "sdk"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from magnusim_sdk.data import KIND_KEY_RE, PLUGIN_KEY_RE

from cfddesk.registry import API_VERSION
from cfddesk.registry import manifest as manifest_mod
from cfddesk.registry.discovery import _ICON_PATH_RE, HEADER_LABEL_MAX
from cfddesk.registry.requirements import Requirement

API_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+$")

# The host API version that introduced each manifest key (compatibility.md).
# Keys of the 1.0 manifest are not listed.
FEATURE_API: dict[str, str] = {
    "tier": "1.1",
    "required": "1.1",
    "requires_plugins": "1.1",
    "protected": "1.1",
    "study_kinds": "1.1",
    "workspaces": "1.1",
    "python": "1.1",
    "default_enabled": "1.2",
    "default_analysis": "1.2",
    "files": "1.2",
    "start_actions": "1.4",
    "study_kinds.links_geometry": "1.4",
}

# PluginManifest fields that are not manifest keys: the host or register() sets them.
HOST_SET_FIELDS: dict[str, str] = {
    "provides": "filled by the host from what register() registers",
    "source": "set by the host: bundled, local or entry_point",
    "manifest_warnings": "set by the host: what the manifest asked for that it ignores",
}

# PluginManifest field -> manifest key, where they differ.
FIELD_KEYS: dict[str, str] = {"python_env": "python"}

_STR_OR_LIST = {"anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]}

TOP_LEVEL: dict[str, dict[str, Any]] = {
    "key": {
        "type": "string",
        "pattern": PLUGIN_KEY_RE.pattern,
        "description": "The plugin's id, the same as its folder name. Letters, digits, '.', '_' and '-'.",
    },
    "name": {"type": "string", "minLength": 1, "description": "The name Settings → Plugins shows."},
    "version": {
        "type": "string",
        "pattern": r"^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.-]+)?$",
        "default": "0.0.0",
        "description": "The plugin's own version; another plugin's requires_plugins compares it.",
    },
    "api_version": {
        "type": "string",
        "pattern": API_VERSION_RE.pattern,
        "default": "1.0",
        "description": (
            "The host API the plugin is written for, major.minor. A host loads it only when the major "
            "version matches its own; a later minor version only adds things."
        ),
    },
    "license": {
        "type": "string",
        "minLength": 1,
        "description": "SPDX licence expression: GPL-3.0-or-later, or a licence compatible with it.",
    },
    "description": {"type": "string", "default": "", "description": "One sentence for the plugin's Settings row."},
    "authors": {**_STR_OR_LIST, "description": "A list of names, or one string of names separated by commas."},
    "ui": {
        "anyOf": [
            {"type": "string"},
            {"type": "boolean", "enum": [False]},
            {
                "type": "object",
                "properties": {"dir": {"type": "string"}, "path": {"type": "string"}, "entry": {"type": "string"}},
                "additionalProperties": False,
            },
        ],
        "description": (
            "The folder of the plugin's in-page panels (usually \"ui\"), or a table {dir, entry}. "
            "Leave it out when the plugin has none."
        ),
    },
    "ui_entry": {
        "type": "string",
        "default": "index.js",
        "description": "The entry file in the ui folder. A .tsx, .ts or .jsx entry is bundled by the host when served.",
    },
    "overrides": {**_STR_OR_LIST, "description": "kind:key specs this plugin replaces (a list, or one string separated by commas)."},
    "requires": {
        "type": "array",
        "items": "Requirement",
        "description": "What the plugin needs on this PC (a WSL program, a Python package, a GPU); Settings shows what is missing.",
    },
    "tier": {
        "type": "string",
        "enum": ["bundled", "user"],
        "description": "Informational: the folder decides the tier (bundled-plugins/ is bundled, plugins/ is user).",
    },
    "required": {
        "type": "boolean",
        "default": False,
        "description": "Bundled tier only: the app cannot create or run simulations without it, and it cannot be turned off.",
    },
    "default_enabled": {
        "type": "boolean",
        "default": True,
        "description": "Bundled tier only: false ships the plugin off until someone turns it on in Settings → Plugins.",
    },
    "requires_plugins": {**_STR_OR_LIST, "description": "Plugins loaded before this one: \"key\" or \"key>=1.0\"."},
    "protected": {**_STR_OR_LIST, "description": "Bundled tier only: kind:key specs of this plugin that other plugins may not drop."},
    "default_analysis": {
        "type": "object",
        "properties": {
            "steady": {"type": "string", "pattern": r"^[A-Za-z][A-Za-z0-9_]*$"},
            "transient": {"type": "string", "pattern": r"^[A-Za-z][A-Za-z0-9_]*$"},
            "aliases": {"type": "array", "items": {"type": "string", "pattern": r"^[A-Za-z][A-Za-z0-9_]*$"}},
        },
        "required": ["steady"],
        "additionalProperties": False,
        "description": (
            "A required bundled plugin only: the analysis a study gets when none is named (steady, its transient "
            "sibling, and the names older studies stored for it)."
        ),
    },
    "study_kinds": {"type": "array", "items": "StudyKind", "description": "Project-level studies the plugin owns."},
    "workspaces": {"type": "array", "items": "WorkspaceSpec", "description": "Full pages the plugin draws in a sandboxed frame."},
    "start_actions": {
        "type": "array",
        "items": "StartAction",
        "description": "Buttons that create a study of a kind and open it in its workspace.",
    },
    "files": {
        "type": "object",
        "properties": {
            "max_file_mb": {
                "type": "integer",
                "minimum": 1,
                "maximum": 4096,
                "default": 64,
                "description": "The largest file a workspace may write through ws.files, in MB.",
            },
            "max_total_mb": {
                "type": "integer",
                "minimum": 1,
                "maximum": 65536,
                "default": 512,
                "description": "All the plugin's files in one project, in MB; at least max_file_mb.",
            },
        },
        "additionalProperties": False,
        "description": "Size limits for the plugin's own files in a project.",
    },
    "python": {
        "type": "object",
        "properties": {
            "requirements": {
                "type": "string",
                "default": "requirements.lock",
                "description": "The lock file, every package pinned with == and hashed (pip --require-hashes).",
            },
            "python": {"type": "string", "default": "", "description": "Supported interpreter range, e.g. \">=3.10,<3.13\"."},
            "service": {
                "type": "string",
                "default": "",
                "description": "The module magnusim_sdk.service runs as the plugin's backend, in its own environment.",
            },
            "find_links": {"type": "string", "default": "", "description": "A folder of wheels in the plugin, for installs with no network."},
        },
        "additionalProperties": False,
        "description": "The plugin's own Python environment, built from its lock file, and its service.",
    },
}

# PythonEnvSpec / FilesSpec fields -> keys of their tables (lock_hash and the byte sizes are computed).
NESTED_FIELD_KEYS: dict[str, dict[str, str | None]] = {
    "PythonEnvSpec": {"requirements": "requirements", "python": "python", "service": "service", "find_links": "find_links", "lock_hash": None},
    "FilesSpec": {"max_file_bytes": "max_file_mb", "max_total_bytes": "max_total_mb"},
}

# The tables of arrays, built from their dataclasses: (dataclass, required keys, per-key extras).
ARRAY_TABLES: dict[str, tuple[type, tuple[str, ...], dict[str, dict[str, Any]]]] = {
    "StudyKind": (
        manifest_mod.StudyKind,
        ("key", "title"),
        {
            "key": {"pattern": KIND_KEY_RE.pattern, "description": "lower_snake_case, unique in the plugin."},
            "title": {"minLength": 1, "maxLength": 80, "description": "Shown in the project tree and the menus."},
            "icon": {"pattern": _ICON_PATH_RE.pattern, "description": "One SVG path (its d attribute) drawn in a 24×24 box."},
            "workspace": {"description": "The key of the [[workspaces]] page that opens a study of this kind."},
            "schema_version": {
                "minimum": 1,
                "description": "The version of this kind's study records; the service's migrate_study upgrades older ones.",
            },
            "links_geometry": {
                "description": "A study of this kind may link one project geometry (needs a workspace; the call comes with 1.5).",
            },
        },
    ),
    "WorkspaceSpec": (
        manifest_mod.WorkspaceSpec,
        ("key", "title"),
        {
            "key": {"pattern": KIND_KEY_RE.pattern, "description": "lower_snake_case, unique in the plugin."},
            "title": {"minLength": 1, "maxLength": 80, "description": "The host's header shows it above the page."},
            "icon": {"pattern": _ICON_PATH_RE.pattern, "description": "One SVG path (its d attribute) drawn in a 24×24 box."},
            "entry": {
                "pattern": r"^workspace/.+\.[Hh][Tt][Mm][Ll]$",
                "description": "An .html file in the plugin's workspace/ folder, which is all the host serves.",
            },
        },
    ),
    "StartAction": (
        manifest_mod.StartAction,
        ("study_kind", "label"),
        {
            "study_kind": {"pattern": KIND_KEY_RE.pattern, "description": "A [[study_kinds]] key with a workspace; one action per kind."},
            "label": {"minLength": 1, "maxLength": 40, "description": "The button's text, one line."},
            "hint": {"maxLength": 120, "description": "A line under or beside the button."},
            "icon": {"pattern": _ICON_PATH_RE.pattern, "description": "One SVG path; the kind's icon when left out."},
            "places": {
                "items": {"type": "string", "enum": list(manifest_mod.START_ACTION_PLACES), "x-open-enum": True},
                "description": "Where the host draws it (default: all). A place this host does not know is left out with a warning.",
            },
            "home_label": {"minLength": 1, "maxLength": 40, "description": "Home's text for the button (default: label)."},
            "header_label": {
                "minLength": 1,
                "maxLength": HEADER_LABEL_MAX,
                "description": "The header button's text (default: the workspace title); needs \"header\" in places.",
            },
        },
    ),
    "Requirement": (
        Requirement,
        ("name",),
        {
            "kind": {"enum": ["wsl_tool", "python", "gpu"], "default": "wsl_tool", "description": "What is needed."},
            "name": {"description": "The program, package or device."},
            "version_spec": {"description": "A version range, e.g. \">=2306\"."},
        },
    ),
}


class SchemaDriftError(RuntimeError):
    """manifest.py has a field this module does not describe."""


def _json_type(annotation: str) -> dict[str, Any]:
    text = str(annotation).replace(" ", "")
    if text == "str":
        return {"type": "string"}
    if text == "bool":
        return {"type": "boolean"}
    if text == "int":
        return {"type": "integer"}
    if text in ("tuple[str,...]", "list[str]"):
        return {"type": "array", "items": {"type": "string"}}
    if text in ("RequirementKind", "Literal['wsl_tool','python','gpu']"):
        return {"type": "string"}
    raise SchemaDriftError(f"no JSON type for the annotation {annotation!r}")


def _default(field: dataclasses.Field[Any]) -> Any:
    if field.default is not dataclasses.MISSING:
        value = field.default
        return list(value) if isinstance(value, tuple) else value
    return None


def _table_schema(name: str) -> dict[str, Any]:
    cls, required, extras = ARRAY_TABLES[name]
    props: dict[str, Any] = {}
    names = [f.name for f in dataclasses.fields(cls)]
    for extra in extras:
        if extra not in names:
            raise SchemaDriftError(f"{name}.{extra} is described here but is no longer a field of {cls.__name__}")
    for field in dataclasses.fields(cls):
        extra = extras.get(field.name)
        if extra is None or "description" not in extra:
            raise SchemaDriftError(
                f"{cls.__module__}.{cls.__name__}.{field.name} is new: describe it in "
                "python/tools/plugin_manifest_schema.py (ARRAY_TABLES) and run npm run gen:plugin-docs"
            )
        prop = _json_type(str(field.type))
        default = _default(field)
        if default is not None and not (name == "StartAction" and field.name == "places"):
            prop["default"] = default
        if name == "StartAction" and field.name == "places":
            prop["default"] = list(manifest_mod.START_ACTION_PLACES)
        prop.update({k: v for k, v in extra.items()})
        if prop.get("type") == "array" and "items" in extra:
            prop["items"] = extra["items"]
        props[field.name] = prop
    return {"type": "object", "properties": props, "required": list(required), "additionalProperties": False}


def _check_top_level_fields() -> None:
    for field in dataclasses.fields(manifest_mod.PluginManifest):
        if field.name in HOST_SET_FIELDS:
            continue
        key = FIELD_KEYS.get(field.name, field.name)
        if key not in TOP_LEVEL:
            raise SchemaDriftError(
                f"cfddesk.registry.manifest.PluginManifest.{field.name} is new: map it to its manifest key in "
                "python/tools/plugin_manifest_schema.py (TOP_LEVEL, or HOST_SET_FIELDS when the host sets it) "
                "and run npm run gen:plugin-docs"
            )
    known = {f.name for f in dataclasses.fields(manifest_mod.PluginManifest)}
    for key in TOP_LEVEL:
        field = next((f for f, k in FIELD_KEYS.items() if k == key), key)
        if field not in known:
            raise SchemaDriftError(f"manifest key {key!r} has no PluginManifest field any more")
    for cls_name, mapping in NESTED_FIELD_KEYS.items():
        cls = getattr(manifest_mod, cls_name)
        have = {f.name for f in dataclasses.fields(cls)}
        if have != set(mapping):
            new = sorted(have - set(mapping))
            gone = sorted(set(mapping) - have)
            raise SchemaDriftError(f"{cls_name} changed (new {new}, gone {gone}): update NESTED_FIELD_KEYS and TOP_LEVEL")
        table = "python" if cls_name == "PythonEnvSpec" else "files"
        for key in mapping.values():
            if key is not None and key not in TOP_LEVEL[table]["properties"]:
                raise SchemaDriftError(f"[{table}] {key} is not described")


def build_schema() -> dict[str, Any]:
    """The manifest's JSON Schema (draft 2020-12). Raises SchemaDriftError when manifest.py moved on."""
    _check_top_level_fields()
    defs = {name: _table_schema(name) for name in ARRAY_TABLES}
    props: dict[str, Any] = {}
    for key, spec in TOP_LEVEL.items():
        prop = json.loads(json.dumps(spec))
        if isinstance(prop.get("items"), str):
            prop["items"] = {"$ref": f"#/$defs/{prop['items']}"}
        if key in FEATURE_API:
            prop["x-since"] = FEATURE_API[key]
        props[key] = prop
    links = defs["StudyKind"]["properties"].get("links_geometry")
    if links is not None:
        links["x-since"] = FEATURE_API["study_kinds.links_geometry"]
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "manifest.schema.json",
        "title": "Magnusim plugin manifest (manifest.toml)",
        "description": (
            f"A plugin's manifest.toml for host API {API_VERSION}. Generated by npm run gen:plugin-docs from "
            "python/cfddesk/registry/manifest.py; do not edit."
        ),
        "x-api-version": API_VERSION,
        "type": "object",
        "required": ["key", "name", "version", "api_version", "license"],
        "properties": props,
        "additionalProperties": False,
        "$defs": defs,
    }


# -- a small validator: what the schema above uses, nothing more -------------------


def _type_ok(value: Any, kind: str) -> bool:
    if kind == "string":
        return isinstance(value, str)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "array":
        return isinstance(value, list)
    if kind == "object":
        return isinstance(value, dict)
    return False


def _resolve(schema: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    ref = schema.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/$defs/"):
        return dict(root["$defs"][ref.split("/")[-1]])
    return schema


def _where(path: str) -> str:
    return path or "the manifest"


def validate(value: Any, schema: dict[str, Any], root: dict[str, Any] | None = None, path: str = "") -> tuple[list[str], list[str]]:
    """(errors, unknown keys) of ``value`` against ``schema``. Unknown keys are dotted paths."""
    root = root or schema
    schema = _resolve(schema, root)
    errors: list[str] = []
    unknown: list[str] = []
    if "anyOf" in schema:
        for option in schema["anyOf"]:
            e, u = validate(value, option, root, path)
            if not e:
                return [], u
        kinds = []
        for option in schema["anyOf"]:
            opt = _resolve(option, root)
            kinds.append("a table" if opt.get("type") == "object" else "false" if opt.get("enum") == [False] else
                         "a list of text" if opt.get("type") == "array" else f"a {opt.get('type')}")
        return [f"{_where(path)} must be {' or '.join(kinds)}"], []
    kind = schema.get("type")
    if kind and not _type_ok(value, kind):
        names = {"string": "text", "boolean": "true or false", "integer": "a whole number", "array": "a list", "object": "a table"}
        return [f"{_where(path)} must be {names.get(kind, kind)}, not {value!r}"], []
    if "enum" in schema and value not in schema["enum"] and not schema.get("x-open-enum"):
        errors.append(f"{_where(path)} must be one of {', '.join(repr(v) for v in schema['enum'])}, not {value!r}")
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{_where(path)} {value!r} does not match {schema['pattern']}")
        if "minLength" in schema and len(value.strip()) < schema["minLength"]:
            errors.append(f"{_where(path)} is empty")
        if "maxLength" in schema and len(value.strip()) > schema["maxLength"]:
            errors.append(f"{_where(path)} is {len(value.strip())} characters; at most {schema['maxLength']}")
    if isinstance(value, int) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{_where(path)} must be at least {schema['minimum']}, not {value}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{_where(path)} must be at most {schema['maximum']}, not {value}")
    if isinstance(value, list) and "items" in schema:
        for i, item in enumerate(value):
            e, u = validate(item, schema["items"], root, f"{path}[{i}]")
            errors += e
            unknown += u
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for req in schema.get("required", []):
            if req not in value:
                errors.append(f"{_where(path)} needs {req}")
        for key, item in value.items():
            sub = f"{path}.{key}" if path else str(key)
            if key in props:
                e, u = validate(item, props[key], root, sub)
                errors += e
                unknown += u
            elif schema.get("additionalProperties") is False:
                unknown.append(sub)
    return errors, unknown


def main() -> int:
    text = json.dumps(build_schema(), indent=2, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(text.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
