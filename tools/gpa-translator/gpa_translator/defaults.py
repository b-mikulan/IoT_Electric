"""Editable exact-name rules used before the room/icon naming suggestions."""

from __future__ import annotations

from dataclasses import asdict, dataclass, fields
import json
import os
from pathlib import Path
import re
import tempfile


@dataclass(frozen=True)
class DefaultRule:
    source_name: str
    target_hr: str
    kind: str = "function"
    icon_id: str | None = None
    urn: str | None = None
    expected_room: str | None = None
    provenance: str = "manual"


def _valid_xml_text(value: object) -> bool:
    return isinstance(value, str) and all(
        character in "\t\n\r" or 0x20 <= ord(character) <= 0xD7FF
        or 0xE000 <= ord(character) <= 0xFFFD
        or 0x10000 <= ord(character) <= 0x10FFFF
        for character in value
    )


def _overlap(left: DefaultRule, right: DefaultRule) -> bool:
    return all(a is None or b is None or a == b
               for a, b in ((left.icon_id, right.icon_id), (left.urn, right.urn)))


def _specificity(rule: DefaultRule) -> int:
    return int(rule.icon_id is not None) + int(rule.urn is not None)


def validate_rules(rules: list[DefaultRule]) -> list[DefaultRule]:
    """Reject empty names, invalid XML and ambiguous selector combinations.

    A more specific rule may override a broad name rule. Two overlapping rules
    with equal specificity would not identify a single result and are rejected.
    Room expectation and provenance describe a rule; neither restricts matching.
    """
    validated = list(rules)
    for index, rule in enumerate(validated, 1):
        if not isinstance(rule, DefaultRule):
            raise ValueError(f"Pravilo {index} mora biti zapis DefaultRule.")
        if not isinstance(rule.kind, str) or rule.kind not in {"room", "function"}:
            raise ValueError(f"Pravilo {index}: vrsta mora biti room ili function.")
        for label, value in (("izvorni naziv", rule.source_name),
                             ("hrvatski naziv", rule.target_hr)):
            if not _valid_xml_text(value) or not value.strip():
                raise ValueError(f"Pravilo {index}: neispravan ili prazan {label}.")
        if rule.icon_id is not None and (
            not isinstance(rule.icon_id, str) or re.fullmatch(r"[0-9]+", rule.icon_id) is None
        ):
            raise ValueError(f"Pravilo {index}: ID ikone mora biti broj ili null.")
        for label, value in (("tip funkcije", rule.urn), ("očekivana soba", rule.expected_room)):
            if value is not None and (not _valid_xml_text(value) or not value.strip()):
                raise ValueError(f"Pravilo {index}: neispravan ili prazan {label}.")
        if not _valid_xml_text(rule.provenance) or not rule.provenance.strip():
            raise ValueError(f"Pravilo {index}: izvor pravila ne smije biti prazan.")
        for other in validated[:index - 1]:
            if (rule.kind == other.kind and rule.source_name == other.source_name
                    and _specificity(rule) == _specificity(other) and _overlap(rule, other)):
                raise ValueError(
                    f"Ponovljena ili nejednoznačna pravila za naziv: {rule.source_name}"
                )
    return validated


def load_defaults(path: Path) -> list[DefaultRule]:
    """Load a schema-version-1 dictionary without accepting unknown rule fields."""
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    try:
        if (not isinstance(data, dict) or type(data.get("schema_version")) is not int
                or data["schema_version"] != 1 or not isinstance(data.get("rules"), list)):
            raise ValueError("Očekuje se schema_version 1 i popis rules.")
        allowed = {field.name for field in fields(DefaultRule)}
        rules = []
        for row in data["rules"]:
            if not isinstance(row, dict) or set(row) - allowed:
                raise ValueError("Pravilo sadrži nepoznata polja.")
            rules.append(DefaultRule(**row))
        return validate_rules(rules)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Neispravan prioritetni rječnik: {path}: {error}") from error


def save_defaults(path: Path, rules: list[DefaultRule]) -> None:
    """Validate before saving; replace atomically and retain document metadata."""
    validated = validate_rules(rules)
    data = {"schema_version": 1, "source_language": "en-GB", "target_language": "hr"}
    if path.exists():
        # Invalid previous data is not silently destroyed by a failed edit.
        load_defaults(path)
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    data["rules"] = [asdict(rule) for rule in validated]
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="\n",
                                         dir=path.parent, prefix=f".{path.name}.",
                                         suffix=".tmp", delete=False) as stream:
            temporary_path = Path(stream.name)
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def default_rule_for(
    name: str, kind: str, icon_id: str | None, urn: str | None,
    rules: list[DefaultRule],
) -> DefaultRule | None:
    """Match a whole, case-sensitive original name; never infer from a code part.

    A contextual rule takes precedence over the broader name rule. Ambiguous
    input returns no match even when a caller supplies unvalidated rules.
    ``expected_room`` is informational, so a rule also applies in another room
    and the GUI can offer the automatic room-based alternative alongside it.
    """
    matches = [rule for rule in rules if rule.source_name == name and rule.kind == kind
               and (rule.icon_id is None or rule.icon_id == icon_id)
               and (rule.urn is None or rule.urn == urn)]
    if not matches:
        return None
    strongest = max(_specificity(rule) for rule in matches)
    matches = [rule for rule in matches if _specificity(rule) == strongest]
    return matches[0] if len(matches) == 1 else None


def default_target_rule_for(
    name: str, kind: str, icon_id: str | None, urn: str | None,
    rules: list[DefaultRule],
) -> DefaultRule | None:
    """Recognise an already translated exact name after source lookup fails.

    Call ``default_rule_for`` first: an explicit source-name rule must take
    precedence over recognising another rule's output. Aliases with the same
    translated name are safe only when their expected room also agrees.
    """
    matches = [rule for rule in rules if rule.target_hr == name and rule.kind == kind
               and (rule.icon_id is None or rule.icon_id == icon_id)
               and (rule.urn is None or rule.urn == urn)]
    if not matches:
        return None
    strongest = max(_specificity(rule) for rule in matches)
    matches = [rule for rule in matches if _specificity(rule) == strongest]
    if len({rule.expected_room for rule in matches}) > 1:
        return None
    return matches[0]
