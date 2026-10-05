"""Room-aware names for standard GPA function codes."""

from dataclasses import dataclass
import re


def with_room(prefix: str, room: str) -> str:
    """Use normal sentence case while preserving room acronyms such as WC."""
    suffix = room if room.isupper() else room[:1].lower() + room[1:]
    return f"{prefix} {suffix}"


@dataclass(frozen=True)
class NameRule:
    pattern: str
    prefix: str
    reason: str
    label: str

    def room_name(self, room: str) -> str:
        return with_room(self.prefix, room)


NAME_RULES = (
    NameRule(r"AC[0-9]+", "Klima", "air_conditioning_and_room", "Oznaka klime AC"),
    NameRule(r"FH[0-9]*", "Podno grijanje", "floor_heating_and_room", "Oznaka podnog grijanja FH"),
    NameRule(r"T[0-9]+", "Temperatura", "temperature_and_room", "Oznaka temperature T"),
    NameRule(r"S[0-9]+", "Senzor", "sensor_and_room", "Oznaka senzora S"),
)


def name_rule_for(name: str, room: str | None = None) -> NameRule | None:
    """Match whole codes, or a generated name when reopening a translated room.

    Numbers identify functions in the source; the room association supplies the
    suffix. Recognizing an exact generated name keeps later imports from
    replacing, for example, a sensor name with its Temperature icon label.
    """
    for rule in NAME_RULES:
        if re.fullmatch(rule.pattern, name, re.I):
            return rule
    if room:
        for rule in NAME_RULES:
            if name == rule.room_name(room):
                return rule
    return None
