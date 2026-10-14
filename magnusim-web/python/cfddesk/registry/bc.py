"""Boundary-condition specs: BC types (variants) and BC families.

A BC type (:class:`BcTypeSpec`, kind ``bc``) is one variant the case writer
knows: which patch type it needs and how it writes U, p and T. A BC family
(:class:`BcFamily`, kind ``bc_family``) is what the user picks in the Boundary
Conditions panel ("Velocity inlet", "Wall"): its variants are BC types, and a
saved record (``record["bc_type"]`` is the family's ``record_type``) selects
one of them by its values (``BcTypeSpec.match``).

The core registers no BC types or families: plugins do (Incompressible Flow
owns the product ones). case.bc_registry and case.bc_menu are 1.x shims over
the hub. Do not import bc_registry at module top level: it imports this module.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from cfddesk.registry.base import RegistryError, _plain_json, _schema_to_json
from cfddesk.registry.schema import SchemaField

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub

SemanticClass = Literal["inlet", "outlet", "wall"]
PatchType = Literal["patch", "wall"]

WriterFn = Callable[[str, dict[str, Any], dict[str, Any]], str]
# (patch_name, settings, context) -> Foam boundaryField entry body (without name braces)


@dataclass(frozen=True)
class BcTypeSpec:
    key: str
    label: str
    semantic: SemanticClass
    patch_type: PatchType
    settings_schema: tuple[SchemaField, ...] = ()
    write_U: WriterFn | None = None
    write_p: WriterFn | None = None
    write_T: WriterFn | None = None  # energy
    # Turbulence handled via semantic class in ras.py helpers
    supported: bool = True
    # API 1.4: the BcFamily key this type is a variant of ("" = none).
    family: str = ""
    # API 1.4: the record values that select this variant within its family,
    # e.g. (("velocity_type", "Flow rate"), ("flow_rate_type", "Mass flow")).
    match: tuple[tuple[str, str], ...] = ()


BC_COLORS: tuple[str, ...] = ("inlet", "outlet", "pressure", "freestream", "wall", "symmetry", "other")
"""The colours a BC family may use in the picker and the viewport."""

BcColor = Literal["inlet", "outlet", "pressure", "freestream", "wall", "symmetry", "other"]

# (field, unit_field, quantity, when): the record field holding a value, the
# field holding its unit label, the unit quantity it converts as, and the
# record values it applies to ({} = always). The first row that applies wins.
BcValueRow = tuple[str, str, str, dict[str, Any]]

# record -> (variant key, settings in SI units)
BcResolveFn = Callable[[dict[str, Any]], tuple[str, dict[str, Any]]]


@dataclass(frozen=True)
class BcFamily:
    """A boundary condition the user picks (API 1.4, registry kind ``bc_family``).

    ``record_type`` is the string a saved record stores in ``bc_type``;
    ``aliases`` are older strings read as this family. ``variants`` are BC type
    keys (the first is the default). ``defaults`` seeds a new record, per unit
    system: ``{"metric": {...}, "imperial": {...}}``. ``values`` say which
    record fields carry units (see :data:`BcValueRow`). ``fields`` is the
    generic editor used when ``ui`` names no ``bc-settings`` slot component.
    ``resolve`` turns a record into its variant key and SI settings (Python
    only; never published).
    """

    key: str
    label: str
    record_type: str
    aliases: tuple[str, ...] = ()
    color: BcColor = "other"
    hint: str = ""
    variants: tuple[str, ...] = ()
    defaults: dict[str, dict[str, Any]] = field(default_factory=dict)
    values: tuple[BcValueRow, ...] = ()
    fields: tuple[SchemaField, ...] = ()
    ui: str = ""
    resolve: BcResolveFn | None = None


@dataclass(frozen=True)
class BcFieldGroup:
    """Fields an analysis adds to the BCs of its studies (API 1.8, ``AnalysisType.bc_fields``).

    The BC editor draws the group under the family's own settings, in studies of
    that analysis only, and saves its fields in the same BC record (top-level
    keys), so another plugin's family gains them without changing. ``families``
    are the bc_family keys it applies to (empty: every family the analysis
    offers). ``ui`` names a ``bc-section`` slot component that draws the group
    instead of the generic form. A field key may not be one the family itself
    holds, nor a host record key (:data:`BC_RECORD_KEYS`).
    """

    key: str
    title: str
    fields: tuple[SchemaField, ...]
    families: tuple[str, ...] = ()
    ui: str = ""
    description: str = ""


# Keys a saved BC record holds for the host: never a field group's.
BC_RECORD_KEYS: frozenset[str] = frozenset(
    {
        "id", "name", "bc_type", "type", "faces", "face", "saved", "created_at", "updated_at",
        "persistence", "geometry_id", "simulation_id", "project_id", "geometry_rev", "lost_faces",
        "folder", "kind", "patch",
    }
)

_GROUP_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def _family_record_keys(fam: Any) -> set[str]:
    """The record keys a BC family holds: its fields, its seed keys and its value/unit fields."""
    keys = {f.key for f in getattr(fam, "fields", ()) or ()}
    for seed in dict(getattr(fam, "defaults", None) or {}).values():
        keys |= set(dict(seed or {}))
    for row in getattr(fam, "values", ()) or ():
        keys |= {str(row[0]), str(row[1])}
    return keys


def _offered_families(hub: RegistryHub, spec: Any) -> list[str]:
    """The bc_family keys an analysis offers: those with a variant among its bc_types."""
    offered = {str(k) for k in getattr(spec, "bc_types", ()) or ()}
    return [
        fam.key for fam in hub.registry("bc_family").items() if offered & {str(v) for v in getattr(fam, "variants", ()) or ()}
    ]


def _validate_bc_seeds(hub: RegistryHub, spec: Any) -> None:
    """An analysis's ``bc_seeds`` (API 1.8): families it offers, fields they hold, plain values
    (a choice field's value one of its choices)."""
    seeds = dict(getattr(spec, "bc_seeds", None) or {})
    if not seeds:
        return
    key = getattr(spec, "key", "?")
    families = hub.registry("bc_family")
    offered = set(_offered_families(hub, spec))
    for fam_key, seed in seeds.items():
        if str(fam_key) not in offered:
            raise RegistryError(
                f"analysis {key!r}: bc_seeds names bc_family {fam_key!r}, which it does not offer; offered={sorted(offered)}"
            )
        if not isinstance(seed, dict) or not seed:
            raise RegistryError(f"analysis {key!r}: bc_seeds[{fam_key!r}] must be a non-empty dict of field values")
        fields = {f.key: f for f in getattr(families.get(str(fam_key)), "fields", ()) or ()}
        for fk, value in seed.items():
            if fk not in fields:
                raise RegistryError(
                    f"analysis {key!r}: bc_seeds[{fam_key!r}] field {fk!r} is not a field of the family; fields={sorted(fields)}"
                )
            if not isinstance(value, (str, int, float, bool)):
                raise RegistryError(f"analysis {key!r}: bc_seeds[{fam_key!r}][{fk!r}] must be a string, number or bool")
            choices = tuple(getattr(fields[fk], "choices", ()) or ())
            if choices and value not in choices:
                raise RegistryError(
                    f"analysis {key!r}: bc_seeds[{fam_key!r}][{fk!r}] = {value!r} is not one of {list(choices)}"
                )


def bc_seeds_row(spec: Any) -> dict[str, dict[str, Any]]:
    """An analysis row's ``bc_seeds`` (API 1.8): {bc_family key: {field: value}}."""
    return {str(k): dict(v) for k, v in dict(getattr(spec, "bc_seeds", None) or {}).items()}


def validate_analysis_bc_fields(hub: RegistryHub) -> None:
    """Fail (``analysis '<key>': ...``) when an analysis's BC field groups (API 1.8) name a
    family that is not registered, repeat a key, or use a record key a family or the host holds;
    or when its ``bc_seeds`` name a family it does not offer or a field the family does not hold."""
    families = hub.registry("bc_family")
    family_keys = set(families.keys())
    for spec in hub.registry("analysis").items():
        _validate_bc_seeds(hub, spec)
        groups = tuple(getattr(spec, "bc_fields", ()) or ())
        if not groups:
            continue
        key = getattr(spec, "key", "?")
        seen_groups: set[str] = set()
        seen_fields: set[str] = set()
        for group in groups:
            gkey = str(getattr(group, "key", "") or "")
            if not _GROUP_KEY_RE.match(gkey) or gkey in seen_groups:
                raise RegistryError(f"analysis {key!r}: bc_fields group key {gkey!r} must be lower_snake_case and unique")
            seen_groups.add(gkey)
            if not str(getattr(group, "title", "") or "").strip():
                raise RegistryError(f"analysis {key!r}: bc_fields group {gkey!r} has no title")
            named = [str(f) for f in getattr(group, "families", ()) or ()]
            unknown = [f for f in named if f not in family_keys]
            if unknown:
                raise RegistryError(
                    f"analysis {key!r}: bc_fields group {gkey!r} names unknown bc_family {unknown}; "
                    f"registered families={sorted(family_keys)}"
                )
            taken: set[str] = set()
            for fam_key in named or _offered_families(hub, spec):
                taken |= _family_record_keys(families.get(fam_key))
            for f in getattr(group, "fields", ()) or ():
                fk = str(getattr(f, "key", "") or "")
                if fk in BC_RECORD_KEYS or fk in taken:
                    raise RegistryError(
                        f"analysis {key!r}: bc_fields group {gkey!r} field {fk!r} is a key the BC record already holds"
                    )
                if fk in seen_fields:
                    raise RegistryError(f"analysis {key!r}: bc_fields field {fk!r} is in two groups")
                seen_fields.add(fk)


def bc_field_groups(spec: Any) -> list[dict[str, Any]]:
    """An analysis row's ``bc_fields`` (API 1.8): each group's key, title, families, ui,
    description and its fields as a JSON Schema."""
    key = str(getattr(spec, "key", ""))
    return [
        {
            "key": str(g.key),
            "title": str(g.title),
            "families": [str(f) for f in g.families],
            "ui": str(g.ui or ""),
            "description": str(g.description or ""),
            "schema": _schema_to_json(tuple(g.fields), kind="analysis", key=key, bag=f"bc_fields.{g.key}"),
        }
        for g in getattr(spec, "bc_fields", ()) or ()
    ]


def validate_analysis_bc_refs(hub: RegistryHub) -> None:
    """Fail if any AnalysisType.bc_types key is not registered.

    Soft-pass: keep bc_types as tuple[str] wired to the bc registry ? no third list.
    """
    bc_keys = set(hub.registry("bc").keys())
    for spec in hub.registry("analysis").items():
        bag = tuple(getattr(spec, "bc_types", ()) or ())
        unknown = [k for k in bag if k not in bc_keys]
        if unknown:
            key = getattr(spec, "key", "?")
            raise RegistryError(
                f"analysis {key!r}: unknown bc key(s) {unknown}; "
                f"registered bcs={sorted(bc_keys)}"
            )


def validate_bc_families(hub: RegistryHub) -> None:
    """Fail if a BC family names a variant that is not a registered BC type, or
    a BC type names a family that is not registered (an empty family is none).

    The message starts with ``bc_family '<key>'`` or ``bc '<key>'`` so
    discovery can unload the plugin that owns it.
    """
    bc_keys = set(hub.registry("bc").keys())
    families = hub.registry("bc_family")
    family_keys = set(families.keys())
    for fam in families.items():
        key = getattr(fam, "key", "?")
        variants = tuple(getattr(fam, "variants", ()) or ())
        if not variants:
            raise RegistryError(f"bc_family {key!r}: lists no variants")
        unknown = [v for v in variants if v not in bc_keys]
        if unknown:
            raise RegistryError(
                f"bc_family {key!r}: unknown bc variant(s) {unknown}; "
                f"registered bcs={sorted(bc_keys)}"
            )
        color = getattr(fam, "color", "other")
        if color not in BC_COLORS:
            raise RegistryError(
                f"bc_family {key!r}: color {color!r} is not one of {list(BC_COLORS)}"
            )
    for spec in hub.registry("bc").items():
        fam_key = str(getattr(spec, "family", "") or "")
        if fam_key and fam_key not in family_keys:
            key = getattr(spec, "key", "?")
            raise RegistryError(
                f"bc {key!r}: unknown bc_family {fam_key!r}; "
                f"registered families={sorted(family_keys)}"
            )


def describe_bc(spec: Any) -> dict[str, Any]:
    """The API 1.4 keys a ``bc`` registry row adds."""
    return {
        "semantic": str(getattr(spec, "semantic", "") or ""),
        "patch_type": str(getattr(spec, "patch_type", "") or ""),
        "family": str(getattr(spec, "family", "") or ""),
        "match": [[str(f), str(v)] for f, v in getattr(spec, "match", ()) or ()],
    }


def describe_bc_family(spec: Any) -> dict[str, Any]:
    """The keys a ``bc_family`` registry row adds (every field but ``resolve``)."""
    key = str(getattr(spec, "key", ""))
    return {
        "record_type": str(getattr(spec, "record_type", "") or ""),
        "aliases": [str(a) for a in getattr(spec, "aliases", ()) or ()],
        "color": str(getattr(spec, "color", "other") or "other"),
        "hint": str(getattr(spec, "hint", "") or ""),
        "variants": [str(v) for v in getattr(spec, "variants", ()) or ()],
        "defaults": _plain_json(dict(getattr(spec, "defaults", None) or {})),
        "values": [
            {"field": str(f), "unit_field": str(u), "quantity": str(q), "when": _plain_json(dict(w or {}))}
            for f, u, q, w in getattr(spec, "values", ()) or ()
        ],
        "fields": _schema_to_json(getattr(spec, "fields", ()) or (), kind="bc_family", key=key, bag="fields"),
        "ui": str(getattr(spec, "ui", "") or ""),
    }
