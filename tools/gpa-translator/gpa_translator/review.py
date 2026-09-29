"""Editable review state shared by the desktop UI and its tests."""

from collections import defaultdict
from dataclasses import dataclass
import re

from .translate import Proposal, review_proposals


@dataclass
class NameEdit:
    name: str
    selected: bool
    manual: bool = False


class ReviewSession:
    def __init__(self, proposals: list[Proposal], icons: dict):
        self.proposals = proposals
        self.by_id = {p.entity_id: p for p in proposals}
        self.icons = icons
        self.edits = {
            p.entity_id: NameEdit(p.new if p.new is not None else p.old, p.status == "ready")
            for p in proposals
        }
        self.rooms = [p for p in proposals if p.kind == "room"]
        self.children: dict[str | None, list[Proposal]] = defaultdict(list)
        for p in proposals:
            if p.kind == "function":
                self.children[p.room_id if p.room_id in self.by_id else None].append(p)

    def room_name(self, proposal: Proposal) -> str | None:
        room = self.by_id.get(proposal.room_id)
        if room is None or room.kind != "room":
            return None
        edit = self.edits[room.entity_id]
        return edit.name if edit.selected else room.old

    def suggested_name(self, proposal: Proposal) -> str | None:
        if proposal.kind == "room":
            return proposal.new
        room = self.room_name(proposal)
        if not room:
            return None
        if re.fullmatch(r"S\d+", proposal.old, re.I):
            prefix = "Senzor"
        else:
            prefix = self.icons.get(proposal.icon_id, {}).get("hr")
        return f"{prefix} {room[:1].lower() + room[1:]}" if prefix else None

    def _refresh_children(self, room_id: str) -> None:
        for p in self.children[room_id]:
            edit = self.edits[p.entity_id]
            if not edit.manual:
                edit.name = self.suggested_name(p) or p.old

    def set_name(self, entity_id: str, value: str) -> None:
        edit = self.edits[entity_id]
        edit.name = value
        edit.manual = True
        edit.selected = value != self.by_id[entity_id].old
        if self.by_id[entity_id].kind == "room":
            self._refresh_children(entity_id)

    def set_selected(self, entity_id: str, value: bool) -> None:
        self.edits[entity_id].selected = value
        if self.by_id[entity_id].kind == "room":
            self._refresh_children(entity_id)

    def reset(self, entity_id: str) -> None:
        p = self.by_id[entity_id]
        self.edits[entity_id] = NameEdit(self.suggested_name(p) or p.old, p.status == "ready")
        if p.kind == "room":
            self._refresh_children(entity_id)

    def changed_count(self) -> int:
        return sum(e.selected and e.name != self.by_id[uid].old for uid, e in self.edits.items())

    def duplicate_ids(self) -> set[str]:
        groups = defaultdict(list)
        for p in self.proposals:
            if p.kind == "function" and p.room_id is not None:
                edit = self.edits[p.entity_id]
                final_name = edit.name if edit.selected else p.old
                groups[(p.room_id, final_name.strip().casefold())].append(p.entity_id)
        return {uid for ids in groups.values() if len(ids) > 1 for uid in ids}

    def reviewed(self) -> list[Proposal]:
        return review_proposals(
            self.proposals,
            {uid: e.name for uid, e in self.edits.items()},
            {uid for uid, e in self.edits.items() if e.selected},
        )
