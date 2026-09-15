"""SchemaField + JSON Schema helpers (superset of BC SettingField)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

FieldKind = Literal["float", "int", "vector3", "bool", "choice", "text", "raw_dict"]


@dataclass(frozen=True)
class SchemaField:
    """UI/settings field descriptor; supersets case.bc_registry.SettingField."""

    key: str
    label: str
    kind: FieldKind
    default: Any = None
    choices: tuple[str, ...] = ()
    unit: str = ""
    energy_only: bool = False
    rate_kind: Literal["intensive", "extensive", "none"] = "none"
    # Extensions beyond SettingField
    min: float | int | None = None
    max: float | int | None = None
    step: float | int | None = None
    depends_on: dict[str, Any] | None = None
    group: str = ""
    advanced: bool = False
    quantity: str | None = None  # Quantity name from units.quantities; str to avoid import cycles


_KIND_TO_JSON: dict[str, dict[str, Any]] = {
    "float": {"type": "number"},
    "int": {"type": "integer"},
    "bool": {"type": "boolean"},
    "text": {"type": "string"},
    "choice": {"type": "string"},
    "vector3": {
        "type": "array",
        "items": {"type": "number"},
        "minItems": 3,
        "maxItems": 3,
    },
    "raw_dict": {"type": "object"},
}


def to_json_schema(fields: list[SchemaField] | tuple[SchemaField, ...]) -> dict[str, Any]:
    """Build a JSON Schema draft-2020-12 object for the given fields."""
    properties: dict[str, Any] = {}
    required: list[str] = []
    for f in fields:
        prop: dict[str, Any] = dict(_KIND_TO_JSON.get(f.kind, {"type": "string"}))
        if f.default is not None:
            prop["default"] = f.default
        if f.kind == "choice" and f.choices:
            prop["enum"] = list(f.choices)
        if f.kind in ("float", "int"):
            if f.min is not None:
                prop["minimum"] = f.min
            if f.max is not None:
                prop["maximum"] = f.max
            if f.step is not None:
                prop["multipleOf"] = f.step
        x: dict[str, Any] = {}
        if f.unit:
            x["unit"] = f.unit
        if f.quantity:
            x["quantity"] = f.quantity
        if f.group:
            x["group"] = f.group
        if f.depends_on:
            x["depends_on"] = dict(f.depends_on)
        if f.advanced:
            x["advanced"] = True
        if f.energy_only:
            x["energy_only"] = True
        if f.rate_kind and f.rate_kind != "none":
            x["rate_kind"] = f.rate_kind
        if x:
            prop["x-cfddesk"] = x
        # Always include title for UI
        prop["title"] = f.label
        properties[f.key] = prop
        # Fields with no default are required
        if f.default is None and f.kind != "raw_dict":
            # Keep loose: only require when explicitly no default and not bool
            pass
    schema: dict[str, Any] = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    return schema


def validate(values: dict[str, Any], fields: list[SchemaField] | tuple[SchemaField, ...]) -> list[str]:
    """Return human-readable validation error strings (empty = ok)."""
    errors: list[str] = []
    by_key = {f.key: f for f in fields}
    for key, val in values.items():
        if key not in by_key:
            errors.append(f"unknown field {key!r}")
            continue
        f = by_key[key]
        if f.depends_on:
            skip = False
            for dep_key, dep_val in f.depends_on.items():
                if values.get(dep_key) != dep_val:
                    skip = True
                    break
            if skip:
                continue
        err = _check_value(f, val)
        if err:
            errors.append(err)
    for f in fields:
        if f.key not in values and f.default is None and f.kind not in ("raw_dict", "bool"):
            # optional unless explicitly needed later; no hard require this land
            pass
    return errors


def _check_value(f: SchemaField, val: Any) -> str | None:
    if val is None:
        return None
    if f.kind == "float":
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            return f"{f.key}: expected float, got {type(val).__name__}"
        num = float(val)
        if f.min is not None and num < f.min:
            return f"{f.key}: {num} < min {f.min}"
        if f.max is not None and num > f.max:
            return f"{f.key}: {num} > max {f.max}"
    elif f.kind == "int":
        if not isinstance(val, int) or isinstance(val, bool):
            return f"{f.key}: expected int, got {type(val).__name__}"
        if f.min is not None and val < f.min:
            return f"{f.key}: {val} < min {f.min}"
        if f.max is not None and val > f.max:
            return f"{f.key}: {val} > max {f.max}"
    elif f.kind == "bool":
        if not isinstance(val, bool):
            return f"{f.key}: expected bool, got {type(val).__name__}"
    elif f.kind == "text":
        if not isinstance(val, str):
            return f"{f.key}: expected text/str, got {type(val).__name__}"
    elif f.kind == "choice":
        if not isinstance(val, str):
            return f"{f.key}: expected choice str, got {type(val).__name__}"
        if f.choices and val not in f.choices:
            return f"{f.key}: {val!r} not in {list(f.choices)}"
    elif f.kind == "vector3":
        if not isinstance(val, (list, tuple)) or len(val) != 3:
            return f"{f.key}: expected vector3 (len 3), got {val!r}"
        for i, c in enumerate(val):
            if not isinstance(c, (int, float)) or isinstance(c, bool):
                return f"{f.key}[{i}]: expected number"
    elif f.kind == "raw_dict":
        if not isinstance(val, dict):
            return f"{f.key}: expected dict, got {type(val).__name__}"
    return None
