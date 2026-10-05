"""Review and byte-preserving edits for existing GPA display/status texts."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from xml.parsers import expat
from xml.sax.saxutils import escape

from .name_rules import with_room
from .translate import NS, text


FIELDS = ("OnAction", "OffAction", "OnText", "OffText", "Text", "Description")
GroupKey = tuple[str | None, str, str] | tuple[str | None, str, str, str]


@dataclass(frozen=True)
class StatusTarget:
    path: str
    entity_id: str
    urn: str
    icon_id: str
    parameter_id: str
    parameter_set: str
    old: str


@dataclass
class StatusField:
    key: str
    label: str
    targets: list[StatusTarget] = field(default_factory=list)
    old_values: dict[str, int] = field(default_factory=dict)
    candidates: list[str] = field(default_factory=list)
    suggested: str | None = None
    selected: bool = False
    reason: str = ""


@dataclass
class StatusGroup:
    key: GroupKey
    room_id: str | None
    urn: str
    icon_id: str
    type_label: str
    fields: list[StatusField] = field(default_factory=list)
    entity_ids: list[str] = field(default_factory=list)
    variant: str | None = None


@dataclass
class StatusEdit:
    field: StatusField
    text: str
    selected: bool


def load_status_dictionary(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    try:
        if data["schema_version"] != 1 or not isinstance(data["types"], dict):
            raise ValueError
        for urn, entry in data["types"].items():
            if not isinstance(urn, str) or not isinstance(entry["label_hr"], str):
                raise ValueError
            for name, definition in entry["fields"].items():
                if name not in FIELDS or not isinstance(definition["label_hr"], str):
                    raise ValueError
                if type(definition.get("group_by_value", False)) is not bool:
                    raise ValueError
                rule = definition.get("room_rule")
                if rule is not None:
                    if (name != "Description" or not definition.get("group_by_value")
                            or not isinstance(rule, dict)):
                        raise ValueError
                    validate_status_text(rule["prefix_hr"])
                    if not rule["prefix_hr"].strip():
                        raise ValueError
                    contains = rule.get("contains_ci")
                    equals = rule.get("equals_ci", [])
                    if (contains is not None and (not isinstance(contains, str) or not contains.strip())
                            or not isinstance(equals, list)
                            or any(not isinstance(value, str) or not value.strip() for value in equals)
                            or not contains and not equals):
                        raise ValueError
            if sum(definition.get("group_by_value", False)
                   for definition in entry["fields"].values()) > 1:
                raise ValueError
            for icon, icon_entry in entry["icons"].items():
                if not isinstance(icon, str):
                    raise ValueError
                for name, translations in icon_entry["fields"].items():
                    if name not in entry["fields"]:
                        raise ValueError
                    for source, translation in translations.items():
                        if not isinstance(source, str) or not isinstance(translation["candidates"], list):
                            raise ValueError
                        for candidate in translation["candidates"]:
                            validate_status_text(candidate["text"])
                            if not isinstance(candidate["count"], int) or candidate["count"] < 1:
                                raise ValueError
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise ValueError(f"Neispravan rječnik tekstova statusa: {path}") from error
    return data


def _room_rule_prefix(old: str, rule: dict | None) -> str | None:
    if rule is None:
        return None
    value = old.casefold()
    contains = rule.get("contains_ci")
    if ((contains and contains.casefold() in value)
            or any(value == source.casefold() for source in rule.get("equals_ci", []))):
        return rule["prefix_hr"]
    return None


def _suggest_field(
    status_field: StatusField, translations: dict, room_rule: dict | None = None,
    room_name: str | None = None,
) -> None:
    status_field.old_values = dict(Counter(target.old for target in status_field.targets))
    known_hr = {candidate["text"] for entry in translations.values()
                for candidate in entry["candidates"]}
    possible = []
    choices = []
    rule_matches = []
    for old in status_field.old_values:
        prefix = _room_rule_prefix(old, room_rule)
        rule_matches.append(prefix is not None)
        if prefix is not None:
            candidates = [with_room(prefix, room_name) if room_name else prefix]
        else:
            entry = translations.get(old)
            candidates = list(dict.fromkeys(c["text"] for c in entry["candidates"])) if entry else []
        choices.extend(candidates)
        # Other dictionary values still require an exact match.
        if not candidates and old in known_hr:
            candidates = [old]
        possible.append(candidates[0] if len(candidates) == 1 else None)
    status_field.candidates = list(dict.fromkeys(choices))
    if len(status_field.old_values) > 1 and not all(rule_matches):
        status_field.reason = "Različiti izvorni tekstovi u grupi — odaberite zajednički tekst ručno."
    elif any(value is None for value in possible):
        status_field.reason = (
            "Primjer sadrži više prijevoda — potrebno je odabrati tekst."
            if choices else "Nema prijevoda za ovaj izvorni tekst — ostaje nepromijenjen."
        )
    elif len(set(possible)) == 1:
        status_field.suggested = possible[0]
        status_field.selected = any(t.old != status_field.suggested for t in status_field.targets)
        if all(rule_matches) and status_field.selected:
            status_field.reason = (
                f"Pravilo opisa prema izvornom tekstu + soba: {room_name}."
                if room_name else "Pravilo opisa prema izvornom tekstu; nema jednoznačne sobe."
            )
        else:
            status_field.reason = ("Prijevod iz rječnika prema tipu funkcije, ikoni i izvornom tekstu."
                                   if status_field.selected else "Tekst je već preveden.")


def build_status_groups(
    files: dict[str, bytes], function_rooms: dict[str, str | None], dictionary: dict,
    room_names: dict[str, str] | None = None,
) -> list[StatusGroup]:
    """Group supported existing text fields by room, function type and icon.

    Mixed dictionary values are left for explicit review. Values matching an
    explicit room rule share its generated suggestion. A description discriminator
    keeps Button, Average, CO2 and VOC descriptions in separate groups. Unrelated
    string fields are ignored; no role is inferred from object counts or names.
    """
    groups: dict[GroupKey, StatusGroup] = {}
    for path, raw in files.items():
        if not re.search(r"/channelviews/\$[^/]+\.xml$", path):
            continue
        node = ET.fromstring(raw)
        if node.tag != NS + "ChannelView":
            continue
        uid, urn, icon = (text(node, key) for key in ("EntityId", "Urn", "IconId"))
        definition = dictionary["types"].get(urn)
        if definition is None:
            continue
        found = []
        for parameters in node.findall(NS + "FunctionParameters"):
            if parameters.get("ParameterSet") != "Visu":
                continue
            for parameter in parameters:
                if (parameter.tag not in FIELDS or parameter.tag not in definition["fields"]
                        or parameter.get("type") != "string" or not parameter.get("id")
                        or len(parameter)):
                    continue
                found.append((parameter.tag, StatusTarget(path, uid, urn, icon,
                    parameter.get("id"), "Visu", parameter.text or "")))
        if not found:
            continue
        room_id = function_rooms.get(uid)
        mappings = definition["icons"].get(icon, {}).get("fields", {})
        key: GroupKey = room_id, urn, icon
        variant = None
        for name, target in found:
            if definition["fields"][name].get("group_by_value", False):
                translations = mappings.get(name, {})
                entry = translations.get(target.old)
                candidates = list(dict.fromkeys(c["text"] for c in entry["candidates"])) if entry else []
                # Recognise the same role before and after translation. Unknown
                # descriptions retain their exact value as a separate group.
                variant = (_room_rule_prefix(target.old, definition["fields"][name].get("room_rule"))
                           or (candidates[0] if len(candidates) == 1 else target.old))
                key = room_id, urn, icon, f"{name}:{variant}"
                break
        group = groups.setdefault(key, StatusGroup(key, room_id, urn, icon,
                                                   definition["label_hr"], variant=variant))
        group.entity_ids.append(uid)
        for name, target in found:
            item = next((f for f in group.fields if f.key == name), None)
            if item is None:
                item = StatusField(name, definition["fields"][name]["label_hr"])
                group.fields.append(item)
            item.targets.append(target)
    for group in groups.values():
        mappings = dictionary["types"][group.urn]["icons"].get(group.icon_id, {}).get("fields", {})
        group.fields.sort(key=lambda f: FIELDS.index(f.key))
        for item in group.fields:
            field_definition = dictionary["types"][group.urn]["fields"][item.key]
            _suggest_field(item, mappings.get(item.key, {}), field_definition.get("room_rule"),
                           (room_names or {}).get(group.room_id))
    return list(groups.values())


def validate_status_text(value: str) -> str:
    """Status text may intentionally be empty; XML 1.0 restrictions still apply."""
    if not isinstance(value, str) or any(
        not (char in "\t\n\r" or 0x20 <= ord(char) <= 0xD7FF
             or 0xE000 <= ord(char) <= 0xFFFD or 0x10000 <= ord(char) <= 0x10FFFF)
        for char in value
    ):
        raise ValueError("Tekst statusa sadrži znak koji nije dopušten u XML-u.")
    return value


def _parameter_nodes(node: ET.Element, parameter_id: str, parameter_set: str) -> list[ET.Element]:
    return [parameter for parameters in node.findall(NS + "FunctionParameters")
            if parameters.get("ParameterSet") == parameter_set
            for parameter in parameters if parameter.get("id") == parameter_id]


def _tag_end(raw: bytes, start: int) -> int:
    quote = None
    for index in range(start, len(raw)):
        char = raw[index]
        if quote is not None:
            if char == quote:
                quote = None
        elif char in (34, 39):
            quote = char
        elif char == 62:
            return index + 1
    raise ValueError("Nepotpun XML zapis parametra.")


def replace_parameter_text(
    raw: bytes, parameter_id: str, expected: str, new: str, parameter_set: str = "Visu",
) -> bytes:
    """Change one existing text value, preserving every byte outside that value.

    An empty self-closing element is expanded only when necessary. Namespace
    prefixes, attributes, whitespace, comments and other parameters stay intact.
    """
    validate_status_text(new)
    try:
        raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("Podržan je samo UTF-8 XML projekt.") from error
    root = ET.fromstring(raw)
    matches = _parameter_nodes(root, parameter_id, parameter_set)
    if (root.tag != NS + "ChannelView" or len(matches) != 1
            or matches[0].tag not in FIELDS or matches[0].get("type") != "string"
            or len(matches[0])):
        raise ValueError(f"Očekuje se jedan postojeći tekstualni parametar: {parameter_id}")
    if (matches[0].text or "") != expected:
        raise ValueError(f"Izvorni tekst parametra se promijenio: {parameter_id}")
    if new == expected:
        return raw

    parser = expat.ParserCreate(namespace_separator="|")
    stack = []
    spans = []
    namespace = NS[1:-1] + "|"

    def start_element(name, attributes):
        start = parser.CurrentByteIndex
        parent = stack[-1] if stack else None
        selected = (parent is not None and parent[0] == namespace + "FunctionParameters"
                    and parent[1].get("ParameterSet") == parameter_set
                    and attributes.get("id") == parameter_id)
        stack.append((name, attributes, start, selected))

    def end_element(name):
        _, _, start, selected = stack.pop()
        if selected:
            open_end = _tag_end(raw, start)
            self_closing = raw[start:open_end].rstrip().endswith(b"/>")
            spans.append((start, open_end, parser.CurrentByteIndex, self_closing))

    parser.StartElementHandler = start_element
    parser.EndElementHandler = end_element
    parser.Parse(raw, True)
    if len(spans) != 1:
        raise ValueError(f"Nejednoznačan XML zapis parametra: {parameter_id}")
    start, open_end, close_start, self_closing = spans[0]
    encoded = escape(new, {"\r": "&#13;"}).encode("utf-8")
    if self_closing:
        opening = raw[start:open_end]
        qualified_name = re.match(rb"<([^\s/>]+)", opening)[1]
        # Replace the closing slash only; even attribute whitespace is retained.
        result = (raw[:open_end - 2] + b">" + encoded + b"</" + qualified_name + b">"
                  + raw[open_end:])
    else:
        # Nested markup would be removed by a text replacement. Reject it,
        # including CDATA/comments, rather than making a wider edit silently.
        if b"<" in raw[open_end:close_start]:
            raise ValueError(f"Parametar sadrži dodatni XML sadržaj: {parameter_id}")
        result = raw[:open_end] + encoded + raw[close_start:]
    verified = _parameter_nodes(ET.fromstring(result), parameter_id, parameter_set)
    if len(verified) != 1 or (verified[0].text or "") != new:
        raise ValueError(f"Provjera teksta parametra nije uspjela: {parameter_id}")
    return result


def apply_status_edits(files: dict[str, bytes], edits: list[StatusEdit]) -> tuple[dict[str, bytes], int]:
    """Apply selected group edits to a copy after validating every target."""
    updated = dict(files)
    seen: dict[tuple[str, str, str], str] = {}
    count = 0
    for edit in edits:
        if not edit.selected:
            continue
        validate_status_text(edit.text)
        for target in edit.field.targets:
            key = target.path, target.parameter_set, target.parameter_id
            if key in seen:
                if seen[key] != edit.text:
                    raise ValueError("Isti parametar ima dva različita odabrana teksta.")
                continue
            seen[key] = edit.text
            if target.path not in files:
                raise ValueError("Izvorna datoteka parametra više ne postoji.")
            original = ET.fromstring(files[target.path])
            if (text(original, "EntityId") != target.entity_id
                    or text(original, "Urn") != target.urn
                    or text(original, "IconId") != target.icon_id):
                raise ValueError("Identitet, tip ili ikona funkcije su se promijenili.")
            original_parameters = _parameter_nodes(original, target.parameter_id, target.parameter_set)
            if (len(original_parameters) != 1 or original_parameters[0].tag != edit.field.key
                    or (original_parameters[0].text or "") != target.old):
                raise ValueError("Izvorni parametar statusa se promijenio.")
            updated[target.path] = replace_parameter_text(updated[target.path], target.parameter_id,
                                                          target.old, edit.text, target.parameter_set)
            count += target.old != edit.text
    return updated, count
