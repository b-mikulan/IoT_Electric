"""Editable review state shared by the desktop UI and its tests."""

from collections import defaultdict
from dataclasses import dataclass

from .translate import Proposal, review_proposals, validate_name
from .defaults import default_rule_for, default_target_rule_for
from .name_rules import name_rule_for, with_room


@dataclass
class NameEdit:
    name: str
    selected: bool
    manual: bool = False
    strategy: str = "automatic"


class ReviewSession:
    def __init__(self, proposals: list[Proposal], icons: dict, *, allow_duplicates: bool = False):
        self.proposals = proposals
        self.by_id = {p.entity_id: p for p in proposals}
        self.icons = icons
        self.allow_duplicates = allow_duplicates
        self._duplicate_selected: set[str] = set()
        self._selection_overrides: set[str] = set()
        self.edits = {
            p.entity_id: NameEdit(p.new if p.new is not None else p.old, p.status == "ready",
                                  strategy="default" if p.default_new is not None else "automatic")
            for p in proposals
        }
        self.rooms = [p for p in proposals if p.kind == "room"]
        self.children: dict[str | None, list[Proposal]] = defaultdict(list)
        for p in proposals:
            if p.kind == "function":
                self.children[p.room_id if p.room_id in self.by_id else None].append(p)
        for room in self.rooms:
            self._refresh_children(room.entity_id)
        self._apply_duplicate_policy()

    def duplicate_candidate_ids(self) -> set[str]:
        """Find collisions among proposed names, including unchecked rows."""
        groups = defaultdict(list)
        for p in self.proposals:
            room = self.by_id.get(p.room_id)
            if p.kind != "function" or room is None or room.kind != "room":
                continue
            name = self.edits[p.entity_id].name
            try:
                validate_name(name)
            except ValueError:
                continue
            groups[(p.room_id, name.strip().casefold())].append(p.entity_id)
        return {uid for ids in groups.values() if len(ids) > 1 for uid in ids}

    def _apply_duplicate_policy(self) -> None:
        if not self.allow_duplicates:
            return
        candidates = {
            uid for uid in self.duplicate_candidate_ids()
            if self.edits[uid].name != self.by_id[uid].old
            and (self.by_id[uid].new is not None or self.edits[uid].manual)
        }
        # Track only checks added by this option, so disabling it is reversible.
        for uid in self._duplicate_selected - candidates:
            self.edits[uid].selected = False
            self._duplicate_selected.discard(uid)
        for uid in candidates - self._selection_overrides:
            if not self.edits[uid].selected:
                self.edits[uid].selected = True
                self._duplicate_selected.add(uid)

    def set_allow_duplicates(self, enabled: bool) -> None:
        if enabled and not self.allow_duplicates:
            # Turning it on is a fresh request to check all duplicate proposals.
            self._selection_overrides.clear()
        self.allow_duplicates = enabled
        if enabled:
            self._apply_duplicate_policy()
        else:
            for uid in self._duplicate_selected:
                self.edits[uid].selected = False
            self._duplicate_selected.clear()

    def room_name(self, proposal: Proposal) -> str | None:
        room = self.by_id.get(proposal.room_id)
        if room is None or room.kind != "room":
            return None
        edit = self.edits[room.entity_id]
        return edit.name if edit.selected else room.old

    def suggested_name(self, proposal: Proposal) -> str | None:
        if self.edits[proposal.entity_id].strategy == "default" and proposal.default_new is not None:
            return proposal.default_new
        return self.automatic_name(proposal)

    def automatic_name(self, proposal: Proposal) -> str | None:
        if proposal.kind == "room":
            return proposal.automatic_new if proposal.automatic_status is not None else proposal.new
        room = self.room_name(proposal)
        if not room:
            return None
        rule = name_rule_for(proposal.old, proposal.room)
        if rule is not None:
            return rule.room_name(room)
        prefix = self.icons.get(proposal.icon_id, {}).get("hr")
        return with_room(prefix, room) if prefix else None

    def _refresh_children(self, room_id: str) -> None:
        for p in self.children[room_id]:
            edit = self.edits[p.entity_id]
            if not edit.manual:
                edit.name = self.suggested_name(p) or p.old

    def set_name(self, entity_id: str, value: str) -> None:
        self._duplicate_selected.discard(entity_id)
        self._selection_overrides.discard(entity_id)
        edit = self.edits[entity_id]
        edit.name = value
        edit.manual = True
        edit.selected = value != self.by_id[entity_id].old
        if self.by_id[entity_id].kind == "room":
            self._refresh_children(entity_id)
        self._apply_duplicate_policy()

    def set_selected(self, entity_id: str, value: bool) -> None:
        self._duplicate_selected.discard(entity_id)
        self._selection_overrides.add(entity_id)
        self.edits[entity_id].selected = value
        if self.by_id[entity_id].kind == "room":
            self._refresh_children(entity_id)
        self._apply_duplicate_policy()

    def reset(self, entity_id: str) -> None:
        self._duplicate_selected.discard(entity_id)
        self._selection_overrides.discard(entity_id)
        p = self.by_id[entity_id]
        strategy = self.edits[entity_id].strategy
        status = p.status if strategy == "default" else (p.automatic_status or p.status)
        self.edits[entity_id] = NameEdit(self.suggested_name(p) or p.old, status == "ready", strategy=strategy)
        if p.kind == "room":
            self._refresh_children(entity_id)
        self._apply_duplicate_policy()

    def set_strategy(self, entity_id: str, strategy: str) -> None:
        p = self.by_id[entity_id]
        if strategy not in ("default", "automatic") or (strategy == "default" and p.default_new is None):
            raise ValueError("Odabrani način prijevoda nije dostupan.")
        self._duplicate_selected.discard(entity_id)
        self._selection_overrides.discard(entity_id)
        edit = self.edits[entity_id]
        edit.strategy = strategy
        edit.manual = False
        edit.name = self.suggested_name(p) or p.old
        edit.selected = edit.name != p.old
        if p.kind == "room":
            self._refresh_children(entity_id)
        self._apply_duplicate_policy()

    def refresh_defaults(self, rules) -> None:
        """Refresh saved rules without replacing manual names or explicit auto choices."""
        for p in self.proposals:
            had_default = p.default_new is not None
            uses_name_rule = p.kind == "function" and name_rule_for(p.old, p.room) is not None
            rule = None if uses_name_rule else (
                default_rule_for(p.old, p.kind, p.icon_id, p.urn, rules)
                or default_target_rule_for(p.old, p.kind, p.icon_id, p.urn, rules))
            p.default_new = rule.target_hr if rule else None
            p.default_room = rule.expected_room if rule else None
            p.default_source = rule.provenance if rule else None
            p.new = rule.target_hr if rule else p.automatic_new
            p.reason = "priority_dictionary" if rule else (p.automatic_reason or p.reason)
            p.status = "unknown" if p.new is None else "unchanged" if p.new == p.old else "ready"
            edit = self.edits[p.entity_id]
            lost_default = edit.strategy == "default" and rule is None
            if edit.strategy == "default" and rule is None:
                edit.strategy = "automatic"
            elif not had_default and rule is not None and not edit.manual:
                edit.strategy = "default"
            if not edit.manual and edit.strategy == "default":
                if edit.name != rule.target_hr:
                    self._duplicate_selected.discard(p.entity_id)
                edit.name = rule.target_hr
                if p.entity_id not in self._selection_overrides:
                    edit.selected = edit.name != p.old
            elif not edit.manual and lost_default:
                self._duplicate_selected.discard(p.entity_id)
                edit.name = self.automatic_name(p) or p.old
                if p.entity_id not in self._selection_overrides:
                    edit.selected = edit.name != p.old
        # Recompute automatic children after room defaults have settled.
        for p in self.rooms:
            self._refresh_children(p.entity_id)
        self._apply_duplicate_policy()

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
