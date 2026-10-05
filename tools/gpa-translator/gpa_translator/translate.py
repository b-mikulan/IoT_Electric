"""Initial, local GPA name translator. Uses only the Python standard library."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, replace
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape
import zipfile


from .paths import DATA_DIRECTORY
from .defaults import default_rule_for, default_target_rule_for, load_defaults
from .name_rules import name_rule_for, with_room

HERE = DATA_DIRECTORY
NS = "{http://service.schema.gira.de/configuration}"


@dataclass
class Proposal:
    path: str
    entity_id: str
    kind: str
    old: str
    new: str | None
    status: str
    reason: str
    room: str | None = None
    icon_id: str | None = None
    room_id: str | None = None
    urn: str | None = None
    automatic_new: str | None = None
    automatic_status: str | None = None
    automatic_reason: str | None = None
    default_new: str | None = None
    default_room: str | None = None
    default_source: str | None = None


def load_dictionary(path: Path, key: str) -> dict:
    data = json.loads(path.read_text(encoding="utf-8-sig"))[key]
    if not isinstance(data, dict) or any(
        not isinstance(v, dict) or not isinstance(v.get("hr"), str)
        or not v["hr"].strip() for v in data.values()
    ):
        raise ValueError(f"Neispravan rječnik: {path}")
    return data


def translate_room(name: str, rooms: dict) -> str | None:
    """Translate the base name, preserving a trailing room number verbatim."""
    match = re.fullmatch(r"(.*?)(\s+\d+)?", name.strip())
    assert match is not None
    base, number = match.group(1), match.group(2) or ""
    lookup = {k.casefold(): v["hr"] for k, v in rooms.items()}
    if base.casefold() in lookup:
        return lookup[base.casefold()] + number
    # Already translated room names are valid context, too.
    if base.casefold() in {v.casefold() for v in lookup.values()}:
        return name.strip()
    return None


def text(node: ET.Element, field: str) -> str:
    return node.findtext(NS + field, default="")


def read_archive(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as archive:
        entries = [e for e in archive.infolist() if not e.is_dir()]
        names = [e.filename for e in entries]
        if len(names) != len(set(names)):
            raise ValueError("Arhiv sadrži ponovljene putanje datoteka.")
        roots = [n for n in names if re.fullmatch(r"projects/\$[^/]+\.xml", n)]
        if len(roots) != 1:
            raise ValueError("Očekuje se točno jedan projekt u mapi projects/.")
        prefix = roots[0][:-4] + "/"
        if any(n != roots[0] and not n.startswith(prefix) for n in names):
            raise ValueError("Arhiv sadrži datoteke izvan odabranog projekta.")
        return {e.filename: archive.read(e) for e in entries}



def propose_names(
    files: dict[str, bytes],
    rooms: dict[str, dict[str, str]],
    icons: dict[str, dict[str, str]],
    defaults=(),
) -> list[Proposal]:
    locations = {}
    functions = []
    links: dict[str, set[str]] = defaultdict(set)
    proposals = []
    for path, raw in files.items():
        if path.endswith(".xml") and "/typedelements/" in path:
            node = ET.fromstring(raw)
            if node.tag != NS + "TypedElement" or text(node, "Type") != "Location":
                continue
            if text(node, "Subtype") == "Collection":
                continue
            uid, old = text(node, "EntityId"), text(node, "EntityName")
            new = translate_room(old, rooms)
            locations[uid] = new
            proposals.append(Proposal(path, uid, "room", old, new,
                "unknown" if new is None else "unchanged" if new == old else "ready",
                "room_dictionary" if new is not None else "unknown_room", room_id=uid))
        elif re.search(r"/channelviews/\$[^/]+\.xml$", path):
            node = ET.fromstring(raw)
            if node.tag == NS + "ChannelView":
                functions.append((path, node))
        elif re.search(r"/channelviews/[^/]+/locations/[^/]+\.assoc$", path):
            node = ET.fromstring(raw)
            ends = list(node)
            channels = [e.get("uid") for e in ends if e.get("cat") == "channelview"]
            targets = [e.get("uid") for e in ends if e.get("cat") == "typedelement"]
            if len(channels) == len(targets) == 1 and channels[0] and targets[0]:
                links[channels[0]].add(targets[0])

    for path, node in functions:
        uid, old, icon = (text(node, key) for key in ("EntityId", "EntityName", "IconId"))
        target_ids = links[uid]
        room_id = next(iter(target_ids)) if len(target_ids) == 1 else None
        room = locations.get(room_id)
        entry = icons.get(icon)
        new, status, reason = None, "unknown", "unknown_icon"
        # Standard function codes use the actual room, independently of icons.
        naming_rule = name_rule_for(old, room)
        if naming_rule is not None:
            if room is None:
                status, reason = "unknown", "missing_ambiguous_or_unknown_room"
            else:
                new = naming_rule.room_name(room)
                status, reason = ("unchanged" if new == old else "ready"), naming_rule.reason
        else:
            if entry is None:
                status, reason = "unknown", "unknown_icon"
            elif room is None:
                status, reason = "unknown", "missing_ambiguous_or_unknown_room"
            else:
                new = with_room(entry['hr'], room)
                status, reason = ("unchanged" if new == old else "ready"), "icon_and_room"
        proposals.append(Proposal(path, uid, "function", old, new, status, reason,
                                  room, icon, room_id, urn=text(node, "Urn")))

    # Generic icons can produce identical names for several lights in one room.
    counts = Counter((p.room_id, p.new if p.status == "ready" else p.old)
                     for p in proposals if p.kind == "function")
    for p in proposals:
        if p.kind == "function" and p.status == "ready":
            if counts[(p.room_id, p.new)] > 1:
                p.status, p.reason = "review", "duplicate_name_in_room"
    for p in proposals:
        p.automatic_new, p.automatic_status, p.automatic_reason = p.new, p.status, p.reason
        uses_name_rule = p.kind == "function" and name_rule_for(p.old, p.room) is not None
        rule = None if uses_name_rule else (
            default_rule_for(p.old, p.kind, p.icon_id, p.urn, defaults)
            or default_target_rule_for(p.old, p.kind, p.icon_id, p.urn, defaults))
        if rule is not None:
            p.default_new, p.default_room, p.default_source = rule.target_hr, rule.expected_room, rule.provenance
            p.new = rule.target_hr
            p.status = "unchanged" if p.new == p.old else "ready"
            p.reason = "priority_dictionary"
        p.status = "unknown" if p.new is None else "unchanged" if p.new == p.old else "ready"
    # Check the final priority proposals, which may resolve earlier icon collisions.
    counts = Counter((p.room_id, p.new if p.status == "ready" else p.old)
                     for p in proposals if p.kind == "function")
    for p in proposals:
        if p.kind == "function" and p.status == "ready" and counts[(p.room_id, p.new)] > 1:
            p.status = "review"
    return proposals


def validate_name(name: str | None) -> str:
    """Accept nonblank XML 1.0 text; names are escaped when written."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Odabrani naziv ne smije biti prazan.")
    if any(not (char in "\t\n\r" or 0x20 <= ord(char) <= 0xD7FF
                or 0xE000 <= ord(char) <= 0xFFFD
                or 0x10000 <= ord(char) <= 0x10FFFF) for char in name):
        raise ValueError("Odabrani naziv sadrži znak koji nije dopušten u XML-u.")
    return name


def review_proposals(
    proposals: list[Proposal], names: dict[str, str], selected: set[str],
) -> list[Proposal]:
    """Apply explicit review choices without mutating the original proposals.

    ``names`` and ``selected`` use stable entity IDs. Explicitly selected review
    or unknown rows are allowed, including duplicate names approved by the user.
    """
    if selected - {p.entity_id for p in proposals}:
        raise ValueError("Odabir sadrži nepoznati ID elementa.")
    reviewed = []
    for proposal in proposals:
        if proposal.entity_id not in selected:
            reviewed.append(replace(proposal, new=proposal.old, status="unchanged",
                                    reason="not_selected"))
            continue
        new = validate_name(names.get(proposal.entity_id, proposal.new))
        reviewed.append(replace(proposal, new=new,
            status="unchanged" if new == proposal.old else "ready",
            reason="manual_override" if new != proposal.new else proposal.reason))
    return reviewed


def duplicate_name_groups(proposals: list[Proposal]) -> list[list[Proposal]]:
    """Return warnings for duplicate final function names within the same room."""
    groups: dict[tuple[str | None, str], list[Proposal]] = defaultdict(list)
    for proposal in proposals:
        if proposal.kind == "function":
            final_name = proposal.new if proposal.status == "ready" else proposal.old
            assert final_name is not None
            groups[(proposal.room_id, final_name.strip().casefold())].append(proposal)
    return [group for group in groups.values() if len(group) > 1]


def replace_entity_name(raw: bytes, expected: str, new: str) -> bytes:
    """Keep the original XML bytes except for the EntityName text."""
    original = ET.fromstring(raw)
    if text(original, "EntityName") != expected:
        raise ValueError("Izvorni naziv se promijenio.")
    pattern = rb"(<conf:EntityName(?:\s[^>]*)?>)([^<]*)(</conf:EntityName>)"
    matches = list(re.finditer(pattern, raw))
    if len(matches) != 1:
        raise ValueError("Očekuje se jedno tekstualno polje conf:EntityName.")
    match = matches[0]
    validate_name(new)
    result = (raw[:match.start(2)] + escape(new, {"\r": "&#13;"}).encode("utf-8")
              + raw[match.end(2):])
    if text(ET.fromstring(result), "EntityName") != new:
        raise ValueError("Provjera izmijenjenog XML-a nije uspjela.")
    return result


def write_archive(path: Path, files: dict[str, bytes], proposals: list[Proposal]) -> int:
    updated = dict(files)
    changes = [p for p in proposals if p.status == "ready"]
    for p in changes:
        assert p.new is not None
        updated[p.path] = replace_entity_name(files[p.path], p.old, p.new)
    # Exclusive creation protects both originals and earlier output files.
    with path.open("xb") as stream:
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, content in updated.items():
                archive.writestr(name, content)  # No explicit directory entries.
    with zipfile.ZipFile(path) as archive:
        if any(e.is_dir() for e in archive.infolist()):
            raise ValueError("Izlaz sadrži zasebne zapise mapa.")
        if set(archive.namelist()) != set(updated):
            raise ValueError("Izlazne putanje ne odgovaraju izvornim putanjama.")
        for name, content in updated.items():
            if archive.read(name) != content:
                raise ValueError(f"Provjera sadržaja nije uspjela: {name}")
    return len(changes)


def main() -> int:
    # Windows redirected consoles can otherwise reject Croatian characters.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Prijedlozi GPA naziva prema ikoni i prostoriji.")
    parser.add_argument("project", type=Path)
    parser.add_argument("--rooms", type=Path, default=HERE / "rooms.hr.json")
    parser.add_argument("--icons", type=Path, default=HERE / "icons.hr.json")
    parser.add_argument("--defaults", type=Path, default=HERE / "defaults.hr.json")
    parser.add_argument("--report", type=Path, help="Spremi JSON prijedloge u novu datoteku.")
    parser.add_argument("--output", type=Path, help="Primijeni samo ready prijedloge u novi GPA arhiv.")
    args = parser.parse_args()
    try:
        destinations = [p.resolve() for p in (args.report, args.output) if p]
        if len(destinations) != len(set(destinations)) or any(p.exists() for p in destinations):
            raise ValueError("Izlazi moraju biti različite, nove datoteke.")
        files = read_archive(args.project)
        proposals = propose_names(files, load_dictionary(args.rooms, "translations"),
                                  load_dictionary(args.icons, "icons"), load_defaults(args.defaults))
        report = {"schema_version": 1, "input": str(args.project),
                  "summary": dict(Counter(p.status for p in proposals)),
                  "proposals": [asdict(p) for p in proposals]}
        if args.report:
            with args.report.open("x", encoding="utf-8") as stream:
                json.dump(report, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
        if args.output:
            count = write_archive(args.output, files, proposals)
            print(f"Spremljeno: {args.output} ({count} promjena)")
        print(json.dumps(report if not args.report else report["summary"], ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, KeyError, ET.ParseError, zipfile.BadZipFile) as error:
        print(f"Greška: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
