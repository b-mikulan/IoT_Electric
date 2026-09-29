from copy import deepcopy
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

from gpa_translator.paths import DATA_DIRECTORY
from gpa_translator.status_texts import (
    StatusEdit, apply_status_edits, build_status_groups, load_status_dictionary,
    replace_parameter_text,
)
from gpa_translator.translate import NS


URN = "de.gira.schema.functions.Switch"


def channel(uid="a", icon="1", on="On", off="Off", extra="", urn=URN):
    return (f'<conf:ChannelView xmlns:conf="{NS[1:-1]}">\r\n'
            f'<conf:EntityId>{uid}</conf:EntityId><conf:EntityName>Old</conf:EntityName>'
            f'<conf:Urn>{urn}</conf:Urn><conf:IconId>{icon}</conf:IconId>\r\n'
            '<conf:FunctionParameters ParameterSet="Visu">\r\n'
            f'<OnText id="Switch.OnText" type="string" defaultValue="On">{on}</OnText>\r\n'
            f'<OffText id="Switch.OffText" type="string" defaultValue="Off">{off}</OffText>'
            f'{extra}</conf:FunctionParameters></conf:ChannelView>').encode()


def files_for(*nodes):
    return {f"projects/$p/channelviews/${index}.xml": node for index, node in enumerate(nodes)}


class StatusTextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dictionary = load_status_dictionary(DATA_DIRECTORY / "status-texts.hr.json")

    def groups(self, files, rooms=None):
        return build_status_groups(files, rooms or {"a": "room", "b": "room"}, self.dictionary)

    def test_room_type_and_icon_are_separate_groups(self):
        files = files_for(channel(), channel("b"), channel("c", icon="164"),
                          channel("d"), channel("e", urn="de.gira.schema.functions.KNX.Light"))
        groups = self.groups(files, {"a": "r", "b": "r", "c": "r", "d": "other", "e": "r"})
        self.assertEqual(len(groups), 4)
        first = groups[0]
        self.assertEqual(first.entity_ids, ["a", "b"])
        self.assertEqual(first.key, ("r", URN, "1"))
        self.assertEqual(first.fields[0].old_values, {"On": 2})
        self.assertEqual(first.fields[0].suggested, "Upaljeno")
        self.assertTrue(first.fields[0].selected)

    def test_reference_ambiguity_and_custom_or_mixed_text_are_not_selected(self):
        ambiguous = self.groups(files_for(channel(icon="164")))[0].fields[0]
        self.assertIsNone(ambiguous.suggested)
        self.assertFalse(ambiguous.selected)
        self.assertEqual(set(ambiguous.candidates), {"Uključeno", "Isključeno"})
        custom = self.groups(files_for(channel(on="My custom text")))[0].fields[0]
        self.assertFalse(custom.selected)
        self.assertEqual(custom.old_values, {"My custom text": 1})
        mixed = self.groups(files_for(channel(), channel("b", on="Upaljeno")))[0].fields[0]
        self.assertFalse(mixed.selected)
        self.assertIsNone(mixed.suggested)
        self.assertEqual(mixed.old_values, {"On": 1, "Upaljeno": 1})

    def test_existing_translation_and_empty_remain_unchanged(self):
        existing = self.groups(files_for(channel(on="Upaljeno")))[0].fields[0]
        self.assertEqual(existing.suggested, "Upaljeno")
        self.assertFalse(existing.selected)
        empty = self.groups(files_for(channel(on="")))[0].fields[0]
        self.assertEqual(empty.old_values, {"": 1})
        self.assertFalse(empty.selected)

    def test_only_supported_existing_visu_string_fields(self):
        extra = ('<Description id="Switch.Description" type="string">Other</Description>'
                 '<OnAction id="Switch.OnAction" type="enum">Turn on</OnAction>')
        raw = channel(extra=extra).replace(b'</conf:ChannelView>',
            b'<conf:FunctionParameters ParameterSet="Other"><OnText id="Other.OnText" '
            b'type="string">Other</OnText></conf:FunctionParameters></conf:ChannelView>')
        group = self.groups(files_for(raw))[0]
        self.assertEqual([f.key for f in group.fields], ["OnText", "OffText"])
        self.assertEqual(self.groups(files_for(channel(urn="unsupported"))), [])

    def test_patch_escapes_text_preserves_attributes_whitespace_and_other_fields(self):
        before = channel(extra='<!--keep--><Description id="Description">On</Description>')
        after = replace_parameter_text(before, "Switch.OnText", "On", 'Čć & < >\r\n')
        self.assertEqual(after, before.replace(b">On</OnText>",
            ">Čć &amp; &lt; &gt;&#13;\n</OnText>".encode()))
        self.assertIn(b'defaultValue="On"', after)
        self.assertIn(b'<OffText id="Switch.OffText" type="string" defaultValue="Off">Off</OffText>', after)

    def test_empty_and_selfclosing_are_editable_and_clearable(self):
        before = channel(on="").replace(b'defaultValue="On"></OnText>', b'defaultValue="On" />')
        self.assertEqual(replace_parameter_text(before, "Switch.OnText", "", ""), before)
        after = replace_parameter_text(before, "Switch.OnText", "", "Upaljeno")
        self.assertEqual(after, before.replace(b'defaultValue="On" />', b'defaultValue="On" >Upaljeno</OnText>'))
        cleared = replace_parameter_text(after, "Switch.OnText", "Upaljeno", "")
        self.assertEqual(cleared, after.replace(b">Upaljeno</OnText>", b"></OnText>"))

    def test_patch_accepts_other_conf_prefix_but_rejects_markup_stale_and_duplicates(self):
        before = channel().replace(b'conf:', b'c:').replace(b'xmlns:conf=', b'xmlns:c=')
        self.assertIn(b">Upaljeno</OnText>", replace_parameter_text(before, "Switch.OnText", "On", "Upaljeno"))
        with self.assertRaises(ValueError):
            replace_parameter_text(before, "Switch.OnText", "stale", "New")
        with self.assertRaises(ValueError):
            replace_parameter_text(channel(on="On<!--comment-->"), "Switch.OnText", "On", "New")
        with self.assertRaises(ValueError):
            replace_parameter_text(channel(extra='<OnText id="Switch.OnText" type="string">On</OnText>'),
                                   "Switch.OnText", "On", "New")
        with self.assertRaises(ValueError):
            replace_parameter_text(before, "Switch.OnText", "On", "\x00")

    def test_selected_batch_applies_only_to_group_targets_without_mutating_input(self):
        files = files_for(channel(), channel("b"), channel("c", icon="164"))
        before = dict(files)
        groups = self.groups(files, {"a": "r", "b": "r", "c": "r"})
        updated, count = apply_status_edits(files, [StatusEdit(groups[0].fields[0], "Novo & č", True),
                                                  StatusEdit(groups[0].fields[1], "Ignored", False)])
        self.assertEqual(count, 2)
        self.assertEqual(files, before)
        paths = list(files)
        self.assertEqual(updated[paths[2]], files[paths[2]])
        for path in paths[:2]:
            self.assertEqual(updated[path], files[path].replace(b">On</OnText>", ">Novo &amp; č</OnText>".encode()))

    def test_write_checks_identity_and_rejects_conflicting_edits(self):
        files = files_for(channel())
        group = self.groups(files)[0]
        field = group.fields[0]
        edits = [StatusEdit(field, "New", True)]
        path = next(iter(files))
        with self.assertRaises(ValueError):
            apply_status_edits({path: files[path].replace(b'<conf:IconId>1<', b'<conf:IconId>164<')}, edits)
        with self.assertRaises(ValueError):
            apply_status_edits(files, edits + [StatusEdit(field, "Different", True)])
        updated, count = apply_status_edits(files, edits + edits)
        self.assertEqual(count, 1)


if __name__ == "__main__":
    unittest.main()
