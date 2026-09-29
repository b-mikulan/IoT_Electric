"""Persistent, editable choices for status text groups in the GUI."""

from collections import defaultdict

from .status_texts import StatusEdit


class StatusReview:
    def __init__(self, groups):
        self.groups = groups
        self.by_room = defaultdict(list)
        self.edits = {}
        self.manual = set()
        for group in groups:
            self.by_room[group.room_id].append(group)
            for field in group.fields:
                key = group.key + (field.key,)
                self.edits[key] = self._initial(field)

    @staticmethod
    def _initial(field):
        value = field.suggested
        if value is None:
            value = next(iter(field.old_values)) if len(field.old_values) == 1 else ""
        return StatusEdit(field, value, field.selected)

    def set_text(self, key, value):
        edit = self.edits[key]
        self.edits[key] = StatusEdit(edit.field, value, any(t.old != value for t in edit.field.targets))
        self.manual.add(key)

    def set_selected(self, key, selected):
        edit = self.edits[key]
        self.edits[key] = StatusEdit(edit.field, edit.text, selected)

    def reset(self, key):
        self.edits[key] = self._initial(self.edits[key].field)
        self.manual.discard(key)

    def unresolved(self, key):
        edit = self.edits[key]
        return (key not in self.manual and edit.field.suggested is None
                and len(edit.field.old_values) > 1)

    def changed_count(self):
        return sum(sum(t.old != edit.text for t in edit.field.targets)
                   for key, edit in self.edits.items() if edit.selected and not self.unresolved(key))

    def reviewed(self):
        for key, edit in self.edits.items():
            if edit.selected and self.unresolved(key):
                raise ValueError(f"Polje '{edit.field.label}' sadrži različite izvorne tekstove. "
                                 "Unesite zajednički tekst ili uklonite kvačicu.")
        return list(self.edits.values())
