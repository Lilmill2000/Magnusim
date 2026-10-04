"""What docs/plugins/API.md says about the Python side, as JSON (scripts/gen-plugin-docs.mjs).

Read from the sources, never written by hand:

- ``manifest_schema``: tools/plugin_manifest_schema.py, built from cfddesk.registry.manifest;
- ``sdk``: every module of magnusim_sdk, its public functions, classes (with their
  public methods) and constants, with signatures and the first paragraph of their
  docstrings, read from the source text (so the output is the same on every Python);
- ``contract``: cfddesk.registry.contract (the analysis contract) and the fields of
  cfddesk.registry.analysis.AnalysisType with the comments above them;
- ``hooks``: cfddesk.registry.hooks (the names the host fires and the reserved ones);
- the versions: API_VERSION, SDK_VERSION and CONTRACT_VERSION.

CLI: tools/plugin_docs.py prints the JSON (UTF-8).
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path
from typing import Any

PY_ROOT = Path(__file__).resolve().parents[1]
for _p in (PY_ROOT, PY_ROOT / "sdk", PY_ROOT / "tools"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import plugin_manifest_schema  # noqa: E402

from cfddesk.registry import API_VERSION  # noqa: E402
from cfddesk.registry.hooks import FIRED_HOOKS, HOOK_NAMES, RESERVED_HOOKS  # noqa: E402

SDK_DIR = PY_ROOT / "sdk" / "magnusim_sdk"
REGISTRY_DIR = PY_ROOT / "cfddesk" / "registry"


def summary(doc: str | None) -> str:
    """The first paragraph of a docstring, on one line."""
    if not doc:
        return ""
    first = doc.strip().split("\n\n", 1)[0]
    return re.sub(r"\s+", " ", first).strip()


def _segment(source: str, node: ast.AST | None) -> str:
    if node is None:
        return ""
    text = ast.get_source_segment(source, node) or ""
    return re.sub(r"\s+", " ", text).strip()


def _signature(source: str, fn: ast.FunctionDef | ast.AsyncFunctionDef, *, drop_self: bool = False) -> str:
    a = fn.args
    parts: list[str] = []

    def arg(x: ast.arg, default: ast.expr | None) -> str:
        text = x.arg
        if x.annotation is not None:
            text += f": {_segment(source, x.annotation)}"
        if default is not None:
            text += f" = {_segment(source, default)}" if x.annotation is not None else f"={_segment(source, default)}"
        return text

    positional = list(a.posonlyargs) + list(a.args)
    defaults: list[ast.expr | None] = [None] * (len(positional) - len(a.defaults)) + list(a.defaults)
    for i, (x, d) in enumerate(zip(positional, defaults, strict=True)):
        if drop_self and i == 0 and x.arg in ("self", "cls"):
            continue
        parts.append(arg(x, d))
        if a.posonlyargs and i == len(a.posonlyargs) - 1:
            parts.append("/")
    if a.vararg is not None:
        parts.append("*" + arg(a.vararg, None))
    elif a.kwonlyargs:
        parts.append("*")
    for x, d in zip(a.kwonlyargs, a.kw_defaults, strict=True):
        parts.append(arg(x, d))
    if a.kwarg is not None:
        parts.append("**" + arg(a.kwarg, None))
    ret = f" -> {_segment(source, fn.returns)}" if fn.returns is not None else ""
    return f"{fn.name}({', '.join(parts)}){ret}"


def _decorator_name(node: ast.expr) -> str:
    """property, staticmethod, setter (of @x.setter), cached_property (of @functools.cached_property)."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def _literal_strings(node: ast.expr | None) -> str | None:
    """A set, frozenset, list or tuple of string literals, written out in full; else None."""
    wrap = ""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("frozenset", "set", "tuple") and len(node.args) == 1 and not node.keywords:
        wrap, node = node.func.id, node.args[0]
    if not isinstance(node, (ast.Set, ast.List, ast.Tuple)) or not node.elts:
        return None
    if not all(isinstance(e, ast.Constant) and isinstance(e.value, str) for e in node.elts):
        return None
    items = ", ".join(json.dumps(e.value, ensure_ascii=False) for e in node.elts)  # type: ignore[attr-defined]
    body = {ast.Set: "{%s}", ast.List: "[%s]", ast.Tuple: "(%s)" if len(node.elts) > 1 else "(%s,)"}[type(node)] % items
    return f"{wrap}({body})" if wrap else body


def _all_names(tree: ast.Module) -> list[str] | None:
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__all__" for t in node.targets):
            if isinstance(node.value, (ast.List, ast.Tuple)):
                return [str(e.value) for e in node.value.elts if isinstance(e, ast.Constant)]
    return None


def _comments_above(lines: list[str], lineno: int) -> str:
    out: list[str] = []
    i = lineno - 2
    while i >= 0 and lines[i].strip().startswith("#"):
        out.insert(0, lines[i].strip().lstrip("#").strip())
        i -= 1
    return " ".join(out)


def module_members(path: Path) -> dict[str, Any]:
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    wanted = _all_names(tree)
    members: list[dict[str, Any]] = []
    defined: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            name = node.name
            defined.add(name)
            if (wanted is not None and name not in wanted) or (wanted is None and name.startswith("_")):
                continue
            members.append({"kind": "function", "name": name, "signature": _signature(source, node), "doc": summary(ast.get_docstring(node))})
        elif isinstance(node, ast.ClassDef):
            name = node.name
            defined.add(name)
            if (wanted is not None and name not in wanted) or (wanted is None and name.startswith("_")):
                continue
            bases = ", ".join(_segment(source, b) for b in node.bases)
            methods = []
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and not item.name.startswith("_"):
                    if any(_decorator_name(d) in ("setter", "deleter") for d in item.decorator_list):
                        continue  # the property's own entry says it
                    is_static = any(_decorator_name(d) == "staticmethod" for d in item.decorator_list)
                    if any(_decorator_name(d) in ("property", "cached_property") for d in item.decorator_list):
                        # Read as an attribute (data.root), so shown as one: name: type.
                        sig = f"{item.name}: {_segment(source, item.returns)}" if item.returns is not None else item.name
                    else:
                        sig = _signature(source, item, drop_self=not is_static)
                    methods.append({"name": item.name, "signature": sig, "doc": summary(ast.get_docstring(item))})
            members.append({"kind": "class", "name": name, "bases": bases, "doc": summary(ast.get_docstring(node)), "methods": methods})
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in targets:
                if not isinstance(t, ast.Name):
                    continue
                name = t.id
                defined.add(name)
                public = name in wanted if wanted is not None else (name.isupper() and not name.startswith("_"))
                if not public or name == "__all__":
                    continue
                # A set or list of names is shown whole (KNOWN_KINDS: what emit accepts);
                # anything else is cut at 100 characters.
                names = _literal_strings(node.value)
                value = names if names is not None else _segment(source, node.value)
                if names is None and len(value) > 100:
                    value = value[:97] + "..."
                members.append({"kind": "constant", "name": name, "value": value, "doc": ""})
    reexports = [n for n in (wanted or []) if n not in defined]
    return {"doc": summary(ast.get_docstring(tree)), "members": members, "reexports": reexports}


def sdk_reference() -> list[dict[str, Any]]:
    out = []
    for path in sorted(SDK_DIR.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        rel = path.relative_to(SDK_DIR.parent).with_suffix("")
        parts = list(rel.parts)
        if parts[-1] == "__init__":
            parts = parts[:-1]
        info = module_members(path)
        out.append({"module": ".".join(parts), **info})
    return out


def analysis_fields() -> list[dict[str, str]]:
    path = REGISTRY_DIR / "analysis.py"
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines()
    tree = ast.parse(source)
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "AnalysisType")
    rows = []
    for node in cls.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            rows.append(
                {
                    "name": node.target.id,
                    "type": _segment(source, node.annotation),
                    "default": _segment(source, node.value),
                    "doc": _comments_above(lines, node.lineno),
                }
            )
    return rows


def contract_reference() -> dict[str, Any]:
    from cfddesk.registry.contract import CONTRACT_VERSION

    info = module_members(REGISTRY_DIR / "contract.py")
    tree = ast.parse((REGISTRY_DIR / "analysis.py").read_text(encoding="utf-8"))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "AnalysisType")
    return {
        "version": CONTRACT_VERSION,
        "doc": info["doc"],
        "full_doc": (ast.get_docstring(ast.parse((REGISTRY_DIR / "contract.py").read_text(encoding="utf-8"))) or "").strip(),
        "members": info["members"],
        "analysis_type_doc": summary(ast.get_docstring(cls)),
        "analysis_type_fields": analysis_fields(),
    }


def build() -> dict[str, Any]:
    from magnusim_sdk import SDK_VERSION

    return {
        "api_version": API_VERSION,
        "sdk_version": SDK_VERSION,
        "manifest_schema": plugin_manifest_schema.build_schema(),
        "feature_api": plugin_manifest_schema.FEATURE_API,
        "sdk": sdk_reference(),
        "contract": contract_reference(),
        "hooks": {"all": sorted(HOOK_NAMES), "fired": sorted(FIRED_HOOKS), "reserved": sorted(RESERVED_HOOKS)},
    }


def main() -> int:
    sys.stdout.buffer.write(json.dumps(build(), indent=1, ensure_ascii=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
