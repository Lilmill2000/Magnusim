"""A workspace's commands file (manifest ``[[workspaces]] commands``, 1.9).

The rules of src/keybinds/commands.ts readCommandsFile and sharedCommandIds, with the same words,
for plugin:check: scripts/__tests__/fixtures/workspace-commands-cases.json holds the cases both
must answer alike. A key is a combo: modifiers in the order Ctrl, Alt, Shift, Meta, then a
KeyboardEvent.code. Where Python and JavaScript differ, this follows JavaScript: ids match whole
(no newline before the end), text is trimmed of JavaScript's white space, lengths count code
points (as [...s].length does), and a value is named by its kind unless it is text.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from typing import Any

COMMANDS_FORMAT = 1
ANY_CONTEXT = "any"
MAX_CONTEXTS = 32
MAX_COMMANDS = 512
MAX_KEYS = 4

CONTEXT_ID_RE = re.compile(r"[a-z][a-z0-9_-]{0,31}")
COMMAND_ID_RE = re.compile(r"[a-z][a-z0-9_.-]{0,63}")
MODIFIERS = ("Ctrl", "Alt", "Shift", "Meta")

# What JavaScript's String.prototype.trim removes: WhiteSpace and LineTerminator.
JS_WHITE_SPACE = "".join(
    chr(c) for c in (0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF)
)

# The codes a press can give: the number pad's digits and Enter are read as Digit0..9 and Enter.
KEY_CODES: frozenset[str] = frozenset(
    [f"Key{c}" for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"]
    + [f"Digit{d}" for d in "0123456789"]
    + [f"F{i}" for i in range(1, 25)]
    + ["NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEqual"]
    + ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Insert", "Delete"]
    + ["Backspace", "Enter", "Tab", "Space", "Escape"]
    + ["Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Backquote", "Comma"]
    + ["Period", "Slash", "IntlBackslash"]
)

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def is_combo(s: Any) -> bool:
    """Modifiers in the order Ctrl, Alt, Shift, Meta (each once), then a KeyboardEvent.code."""
    if not isinstance(s, str):
        return False
    parts = s.split("+")
    code = parts.pop()
    if code not in KEY_CODES:
        return False
    at = 0
    for m in parts:
        try:
            i = MODIFIERS.index(m, at)
        except ValueError:
            return False
        at = i + 1
    return True


_PAD_DIGIT = re.compile(r"(^|\+)Numpad(\d)$")
_PAD_ENTER = re.compile(r"(^|\+)NumpadEnter$")


def _pad_as(s: str) -> str | None:
    """The combo a number-pad digit or Enter key in ``s`` is read as ("Ctrl+Numpad5" -> "Ctrl+Digit5"), or None."""
    fixed = _PAD_ENTER.sub(r"\1Enter", _PAD_DIGIT.sub(r"\1Digit\2", s))
    return fixed if fixed != s and is_combo(fixed) else None


def _q(v: Any) -> str:
    """A value as the problems name it: text as JSON.stringify writes it, anything else by its kind."""
    if isinstance(v, str):
        # JSON.stringify writes a lone surrogate as an escape (json.dumps would leave it raw).
        return _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", json.dumps(v, ensure_ascii=False))
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return "a number"
    return "a list" if isinstance(v, list) else "an object"


def _text(v: Any) -> str | None:
    return v.strip(JS_WHITE_SPACE) if isinstance(v, str) else None


def _id(regex: re.Pattern[str], v: Any) -> bool:
    return isinstance(v, str) and regex.fullmatch(v) is not None


def _taken_keys(app_keys: dict[str, Any] | None) -> dict[str, str]:
    """The keys no command may have (the "reserved" and "app" groups), each with the words that say whose it is."""
    out: dict[str, str] = {}
    groups = app_keys or {}
    for c in groups.get("reserved") or []:
        for k in c.get("keys") or []:
            out[str(k)] = f"is kept for the browser and the system ({c.get('label') or ''})"
    for c in groups.get("app") or []:
        for k in c.get("keys") or []:
            out[str(k)] = f"is the app's own key ({c.get('label') or ''})"
    return out


def read_commands(doc: Any, app_keys: dict[str, Any] | None = None) -> tuple[list[dict[str, Any]], list[str]]:
    """The file's commands ({id, context, keys}; "" for an id or context that is not one) and every
    problem with it, in the file's order. ``app_keys`` is the app's keys (plugin-sdk.json
    ``app_keys``: app, local, reserved): its app and reserved keys are not a workspace command's."""
    if not isinstance(doc, dict):
        return [], ["the file is not a JSON object"]
    problems: list[str] = []
    version = doc.get("version")
    if version != COMMANDS_FORMAT or isinstance(version, bool):
        problems.append(f"version must be {COMMANDS_FORMAT}, the format this host reads")
    contexts: list[str] = []
    raw_contexts = doc.get("contexts")
    if not isinstance(raw_contexts, list):
        problems.append("contexts must be a list")
    else:
        if len(raw_contexts) > MAX_CONTEXTS:
            problems.append(f"contexts: at most {MAX_CONTEXTS}")
        for i, c in enumerate(raw_contexts):
            if not isinstance(c, dict):
                problems.append(f"contexts[{i}] is not an object")
                continue
            cid = c.get("id")
            if not _id(CONTEXT_ID_RE, cid):
                problems.append(f"contexts[{i}].id {_q(cid)} must be 1 to 32 of a-z, 0-9, _ and -, starting with a letter")
            elif cid == ANY_CONTEXT:
                problems.append(f'contexts[{i}].id "any" is reserved: it means every context')
            elif cid in contexts:
                problems.append(f"contexts[{i}].id {_q(cid)} is declared twice")
            label = _text(c.get("label"))
            if not label or len(label) > 40:
                problems.append(f"contexts[{i}].label must be 1 to 40 characters")
            if _id(CONTEXT_ID_RE, cid) and cid != ANY_CONTEXT:
                contexts.append(cid)
    declared = set(contexts)
    taken = _taken_keys(app_keys)
    raw_commands = doc.get("commands")
    if not isinstance(raw_commands, list) or not raw_commands or len(raw_commands) > MAX_COMMANDS:
        problems.append(f"commands must be a list of 1 to {MAX_COMMANDS} commands")
        return [], problems
    commands: list[dict[str, Any]] = []
    # Each command's name in a problem: its id, or its place when the id is not one.
    names: list[str] = []
    for i, c in enumerate(raw_commands):
        if not isinstance(c, dict):
            problems.append(f"commands[{i}] is not an object")
            continue
        cid = c.get("id")
        valid = _id(COMMAND_ID_RE, cid)
        if not valid:
            problems.append(f"commands[{i}].id {_q(cid)} must be 1 to 64 of a-z, 0-9, _, - and ., starting with a letter")
        elif cid in names:
            problems.append(f"commands[{i}].id {_q(cid)} is declared twice")
        label = _text(c.get("label"))
        if not label or len(label) > 60:
            problems.append(f"commands[{i}].label must be 1 to 60 characters")
        group = "" if "group" not in c else _text(c.get("group"))
        if group is None or len(group) > 40:
            problems.append(f"commands[{i}].group must be text of at most 40 characters")
        context = c.get("context")
        if context != ANY_CONTEXT and (not isinstance(context, str) or context not in declared):
            problems.append(f'commands[{i}].context {_q(context)} is not a declared context or "any"')
        keys: list[str] = []
        raw_keys = c.get("keys")
        if not isinstance(raw_keys, list) or len(raw_keys) > MAX_KEYS:
            problems.append(f"commands[{i}].keys must be a list of at most {MAX_KEYS} keys")
        else:
            for k in raw_keys:
                pad = _pad_as(k) if isinstance(k, str) else None
                if pad:
                    problems.append(f"commands[{i}].keys: {_q(k)} never comes from a press: write {_q(pad)}")
                elif not is_combo(k):
                    problems.append(
                        f"commands[{i}].keys: {_q(k)} is not a key (modifiers Ctrl, Alt, Shift, Meta in that order, "
                        "then a KeyboardEvent.code such as KeyR)"
                    )
                elif k in keys:
                    problems.append(f"commands[{i}].keys: {_q(k)} is listed twice")
                elif k in taken:
                    problems.append(f"commands[{i}].keys: {_q(k)} {taken[k]}")
                else:
                    keys.append(k)
        commands.append({"id": cid if valid else "", "context": context if isinstance(context, str) else "", "keys": keys})
        names.append(cid if valid else f"commands[{i}]")
    # A key is one command's in a context: two commands whose contexts meet (the same, or either "any").
    for i, a in enumerate(commands):
        for j, b in enumerate(commands[:i]):
            if a["context"] != b["context"] and ANY_CONTEXT not in (a["context"], b["context"]):
                continue
            for k in a["keys"]:
                if k in b["keys"]:
                    problems.append(f"{_q(k)} is the default key of both {names[j]} and {names[i]}, whose contexts meet")
    return commands, problems


def commands_problems(doc: Any, app_keys: dict[str, Any] | None = None) -> list[str]:
    """Every problem with a commands file, in the file's order ([] when it is good)."""
    return read_commands(doc, app_keys)[1]


def shared_command_ids(workspaces: Iterable[tuple[str, list[dict[str, Any]]]]) -> list[str]:
    """Command ids one plugin's workspaces both use ((workspace key, its commands) in manifest order).

    The person's keys are kept per plugin (its prefs key "keybinds"), so a plugin's command ids are
    one set."""
    owner: dict[str, str] = {}
    problems: list[str] = []
    for key, commands in workspaces:
        for c in commands:
            cid = c["id"]
            if not cid:
                continue
            first = owner.setdefault(cid, key)
            if first != key:
                problems.append(
                    f"workspace {_q(key)}: command {_q(cid)} is also workspace {_q(first)}'s: a plugin's command ids "
                    "are one set, since the person's keys are kept per plugin"
                )
    return problems
