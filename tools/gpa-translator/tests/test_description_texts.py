"""Object descriptions and display text must retain their separate roles."""

from xml.sax.saxutils import escape
import unittest

from gpa_translator.paths import DATA_DIRECTORY
from gpa_translator.status_review import StatusReview
from gpa_translator.status_texts import (
    StatusEdit, apply_status_edits, build_status_groups, load_status_dictionary,
    replace_parameter_text,
)
from gpa_translator.translate import NS


TEMPERATURE = "de.gira.schema.functions.NumericFloatStatus"
TRIGGER = "de.gira.schema.functions.Trigger"


def channel(uid="a", value="Button", icon="14", urn=TEMPERATURE,
            field="Description", parameter_set="Visu", value_type="string", extra=""):
    parameter = urn.rsplit(".", 1)[-1] + "." + field
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>\r\n'
        f'<conf:ChannelView xmlns:conf="{NS[1:-1]}">\r\n'
        f'<conf:EntityId>{uid}</conf:EntityId>'
        f'<conf:EntityName>T1</conf:EntityName>'
        f'<conf:Urn>{urn}</conf:Urn><conf:IconId>{icon}</conf:IconId>\r\n'
        f'<conf:FunctionParameters ParameterSet="{parameter_set}">\r\n'
        f'<{field} id="{parameter}" type="{value_type}" '
        f'label="Original label" defaultValue="Original default">{escape(value)}</{field}>\r\n'
        f'<Unit id="NumericFloatStatus.Unit" type="string">°C</Unit><!--keep exactly-->\r\n'
        f'{extra}</conf:FunctionParameters></conf:ChannelView>'
    ).encode("utf-8")


def files_for(*nodes):
    return {f"projects/$p/channelviews/${index}.xml": node for index, node in enumerate(nodes)}


class DescriptionTextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dictionary = load_status_dictionary(DATA_DIRECTORY / "status-texts.hr.json")

    def groups(self, files, rooms=None, room_names=None):
        return build_status_groups(files, rooms or {"a": "room", "b": "room"},
                                   self.dictionary, room_names)

    @staticmethod
    def by_source(groups, source):
        return next((group, field) for group in groups for field in group.fields
                    if source in field.old_values)

    def test_door_display_text_unlock_is_a_reviewable_existing_parameter(self):
        files = files_for(channel(value="Unlock", urn=TRIGGER, icon="10", field="Text"))
        groups = self.groups(files)
        self.assertEqual(len(groups), 1)
        group = groups[0]
        self.assertEqual(group.key, ("room", TRIGGER, "10"))
        self.assertEqual([field.key for field in group.fields], ["Text"])
        field = group.fields[0]
        self.assertEqual(field.suggested, "Otključaj")
        self.assertTrue(field.selected)
        self.assertEqual(field.targets[0].parameter_id, "Trigger.Text")
        updated, count = apply_status_edits(files, [StatusEdit(field, field.suggested, True)])
        path = next(iter(files))
        self.assertEqual(count, 1)
        self.assertEqual(updated[path], files[path].replace(b">Unlock</Text>",
                                                          ">Otključaj</Text>".encode("utf-8")))

    def test_temperature_descriptions_keep_button_average_and_sensor_roles_separate(self):
        files = files_for(channel("a"), channel("b"), channel("c", value="Average"),
                          channel("d", value="Sensor"))
        groups = self.groups(files, {uid: "room" for uid in "abcd"})
        self.assertEqual(len(groups), 3)
        for source, expected, entities in (
            ("Button", "Tipkalo", ["a", "b"]),
            ("Average", "Srednja", ["c"]),
            ("Sensor", "Senzor", ["d"]),
        ):
            group, field = self.by_source(groups, source)
            self.assertEqual(group.key[:3], ("room", TEMPERATURE, "14"))
            self.assertEqual(len(group.key), 4)
            self.assertEqual(group.entity_ids, entities)
            self.assertEqual(field.suggested, expected)
            self.assertTrue(field.selected)
        self.assertEqual(len({group.key for group in groups}), 3)

    def test_air_quality_sensor_descriptions_do_not_merge_co2_and_voc(self):
        files = files_for(channel("a", value="Sensor (VOC)", icon="120"),
                          channel("b", value="Sensor (CO2)", icon="120"))
        groups = self.groups(files)
        self.assertEqual(len(groups), 2)
        self.assertNotEqual(groups[0].key, groups[1].key)
        self.assertEqual(self.by_source(groups, "Sensor (VOC)")[1].suggested, "Senzor (VOC)")
        self.assertEqual(self.by_source(groups, "Sensor (CO2)")[1].suggested, "Senzor (CO2)")

    def test_room_icon_and_type_remain_part_of_group_identity(self):
        files = files_for(channel("a"), channel("b"), channel("c", icon="120"),
                          channel("d", value="Unlock", urn=TRIGGER, icon="10", field="Text"))
        groups = self.groups(files, {"a": "r1", "b": "r2", "c": "r1", "d": "r1"})
        self.assertEqual(len(groups), 4)
        self.assertEqual(len({group.key for group in groups}), 4)
        review = StatusReview(groups)
        group, field = self.by_source([g for g in groups if g.entity_ids == ["a"]], "Button")
        key = group.key + (field.key,)
        old_values = {other: edit.text for other, edit in review.edits.items() if other != key}
        review.set_text(key, "Zidno tipkalo")
        self.assertEqual({other: edit.text for other, edit in review.edits.items() if other != key},
                         old_values)

    def test_custom_description_is_unselected_and_edit_does_not_change_known_role(self):
        files = files_for(channel("a", value="My wall sensor"), channel("b"))
        groups = self.groups(files)
        custom_group, custom = self.by_source(groups, "My wall sensor")
        self.assertIsNone(custom.suggested)
        self.assertFalse(custom.selected)
        self.assertEqual(custom.old_values, {"My wall sensor": 1})
        self.assertEqual(len(groups), 2)
        review = StatusReview(groups)
        key = custom_group.key + (custom.key,)
        self.assertEqual(review.edits[key].text, "My wall sensor")
        review.set_text(key, "Vanjski senzor")
        updated, count = apply_status_edits(files, [review.edits[key]])
        paths = list(files)
        self.assertEqual(count, 1)
        self.assertEqual(updated[paths[1]], files[paths[1]])
        review.reset(key)
        self.assertEqual(review.edits[key].text, "My wall sensor")
        self.assertFalse(review.edits[key].selected)

    def test_average_substring_rule_accepts_unseen_suffixes_and_letter_case(self):
        for original in ("Srednja nova soba 19", "SREDNJA DNEVNA", "moja srednja vrijednost",
                         "sReDnJa", "Average", "aVeRaGe"):
            with self.subTest(original=original):
                group = self.groups(files_for(channel(value=original)),
                                    room_names={"room": "Boravak"})[0]
                field = group.fields[0]
                self.assertEqual(group.variant, "Srednja")
                self.assertEqual(group.key, ("room", TEMPERATURE, "14", "Description:Srednja"))
                self.assertEqual(field.suggested, "Srednja boravak")
                self.assertTrue(field.selected)

    def test_average_rule_uses_current_room_instead_of_original_description_suffix(self):
        files = files_for(channel(value="Srednja dječja 2"))
        group = self.groups(files, room_names={"room": "Spavaća 7"})[0]
        self.assertEqual(group.fields[0].suggested, "Srednja spavaća 7")
        renamed = self.groups(files, room_names={"room": "Radna soba"})[0]
        self.assertEqual(renamed.fields[0].suggested, "Srednja radna soba")
        self.assertEqual(renamed.key, group.key)

    def test_average_rule_preserves_room_numbers_and_wc_case(self):
        for room, expected in (("Dječja 23", "Srednja dječja 23"),
                               ("WC", "Srednja WC"),
                               ("WC 2", "Srednja WC 2")):
            with self.subTest(room=room):
                field = self.groups(files_for(channel(value="Average")),
                                    room_names={"room": room})[0].fields[0]
                self.assertEqual(field.suggested, expected)

    def test_average_rule_missing_room_context_does_not_invent_suffix(self):
        files = files_for(channel(value="Srednja unknown old room"))
        for room_names in (None, {}, {"elsewhere": "Boravak"}, {"room": ""}):
            with self.subTest(room_names=room_names):
                field = self.groups(files, room_names=room_names)[0].fields[0]
                self.assertEqual(field.suggested, "Srednja")
                self.assertTrue(field.selected)
        unassigned = self.groups(files, rooms={"a": None},
                                 room_names={"room": "Boravak"})[0]
        self.assertEqual(unassigned.fields[0].suggested, "Srednja")

    def test_average_rule_merges_matching_source_variants_and_keeps_other_roles_separate(self):
        sources = ("Average", "SREDNJA custom room", "Srednja boravak", "Button", "Sensor")
        files = files_for(*(channel(uid, value=source) for uid, source in zip("abcde", sources)))
        groups = self.groups(files, {uid: "room" for uid in "abcde"}, {"room": "Boravak"})
        self.assertEqual(len(groups), 3)
        group, field = self.by_source(groups, "Average")
        self.assertEqual(group.entity_ids, ["a", "b", "c"])
        self.assertEqual(group.variant, "Srednja")
        self.assertEqual(field.old_values, {source: 1 for source in sources[:3]})
        self.assertEqual(field.suggested, "Srednja boravak")
        self.assertTrue(field.selected)
        self.assertEqual(self.by_source(groups, "Button")[1].suggested, "Tipkalo")
        self.assertEqual(self.by_source(groups, "Sensor")[1].suggested, "Senzor")

    def test_average_rule_does_not_translate_unrelated_description_text(self):
        for original in ("Above average", "Averaged", "Prosječna temperatura", "My room"):
            with self.subTest(original=original):
                field = self.groups(files_for(channel(value=original)),
                                    room_names={"room": "Boravak"})[0].fields[0]
                self.assertIsNone(field.suggested)
                self.assertFalse(field.selected)

    def test_explicit_average_role_is_recognized_with_other_numeric_status_icons(self):
        for icon in ("2", "120", "999"):
            with self.subTest(icon=icon):
                group = self.groups(files_for(channel(value="Srednja nepoznata soba", icon=icon)),
                                    room_names={"room": "Boravak"})[0]
                self.assertEqual(group.variant, "Srednja")
                self.assertEqual(group.fields[0].suggested, "Srednja boravak")
        files = files_for(channel("a", value="Sensor (VOC)", icon="120"),
                          channel("b", value="Sensor (CO2)", icon="120"))
        groups = self.groups(files, room_names={"room": "Boravak"})
        self.assertEqual(len(groups), 2)
        self.assertEqual(self.by_source(groups, "Sensor (VOC)")[1].suggested, "Senzor (VOC)")
        self.assertEqual(self.by_source(groups, "Sensor (CO2)")[1].suggested, "Senzor (CO2)")

    def test_average_room_edit_preserves_other_parameters_and_other_roles_exactly(self):
        files = files_for(channel("a", value="Srednja stara soba"), channel("b"))
        groups = self.groups(files, room_names={"room": "Radna & dnevna 2"})
        field = self.by_source(groups, "Srednja stara soba")[1]
        updated, count = apply_status_edits(files, [StatusEdit(field, field.suggested, True)])
        paths = list(files)
        self.assertEqual(count, 1)
        self.assertEqual(updated[paths[0]], files[paths[0]].replace(
            b">Srednja stara soba</Description>",
            b">Srednja radna &amp; dnevna 2</Description>"))
        self.assertEqual(updated[paths[1]], files[paths[1]])

    def test_average_room_translation_round_trip_has_stable_key_and_no_repeated_edit(self):
        files = files_for(channel("a", value="Average"), channel("b", value="SREDNJA old room"))
        names = {"room": "Dječja 21"}
        first = self.groups(files, room_names=names)
        updated, count = apply_status_edits(files, StatusReview(first).reviewed())
        self.assertEqual(count, 2)
        second = self.groups(updated, room_names=names)
        self.assertEqual([group.key for group in second], [group.key for group in first])
        self.assertEqual(second[0].fields[0].suggested, "Srednja dječja 21")
        self.assertFalse(second[0].fields[0].selected)
        repeated, count = apply_status_edits(updated, StatusReview(second).reviewed())
        self.assertEqual(count, 0)
        self.assertEqual(repeated, updated)

    def test_room_rename_refreshes_automatic_description_without_changing_group_identity(self):
        files = files_for(channel(value="Average"))
        first = self.groups(files, room_names={"room": "Boravak"})
        review = StatusReview(first)
        key = first[0].key + ("Description",)
        self.assertEqual(review.edits[key].text, "Srednja boravak")
        renamed = self.groups(files, room_names={"room": "Dječja 4"})
        review.refresh(renamed)
        self.assertEqual(review.edits[key].text, "Srednja dječja 4")
        self.assertTrue(review.edits[key].selected)
        self.assertIs(review.edits[key].field, renamed[0].fields[0])
        updated, count = apply_status_edits(files, review.reviewed())
        self.assertEqual(count, 1)
        self.assertIn(">Srednja dječja 4</Description>".encode("utf-8"), next(iter(updated.values())))

    def test_room_refresh_preserves_manual_description_and_explicit_unchecked_choice(self):
        files = files_for(channel("a", value="Average"), channel("b", value="Average"))
        rooms = {"a": "r1", "b": "r2"}
        initial = self.groups(files, rooms, {"r1": "Boravak", "r2": "Spavaća"})
        review = StatusReview(initial)
        keys = {group.room_id: group.key + ("Description",) for group in initial}
        review.set_text(keys["r1"], "Prosjek sa senzora")
        review.set_selected(keys["r1"], False)
        review.set_selected(keys["r2"], False)
        review.refresh(self.groups(files, rooms, {"r1": "Radna soba", "r2": "WC 2"}))
        self.assertEqual(review.edits[keys["r1"]].text, "Prosjek sa senzora")
        self.assertFalse(review.edits[keys["r1"]].selected)
        self.assertEqual(review.edits[keys["r2"]].text, "Srednja WC 2")
        self.assertFalse(review.edits[keys["r2"]].selected)
        self.assertEqual(review.changed_count(), 0)
        for room_id, expected in (("r1", "Srednja radna soba"), ("r2", "Srednja WC 2")):
            review.reset(keys[room_id])
            self.assertEqual(review.edits[keys[room_id]].text, expected)
            self.assertTrue(review.edits[keys[room_id]].selected)
        self.assertEqual(review.changed_count(), 2)

    def test_mixed_english_and_croatian_same_role_requires_explicit_review(self):
        files = files_for(channel("a"), channel("b", value="Tipkalo"))
        groups = self.groups(files)
        self.assertEqual(len(groups), 1)
        group, field = self.by_source(groups, "Button")
        self.assertEqual(field.old_values, {"Button": 1, "Tipkalo": 1})
        self.assertIsNone(field.suggested)
        self.assertFalse(field.selected)
        review = StatusReview(groups)
        key = group.key + (field.key,)
        review.set_selected(key, True)
        with self.assertRaises(ValueError):
            review.reviewed()
        review.set_text(key, "Tipkalo")
        updated, count = apply_status_edits(files, review.reviewed())
        self.assertEqual(count, 1)
        self.assertEqual(self.groups(updated)[0].fields[0].old_values, {"Tipkalo": 2})

    def test_round_trip_keeps_translated_roles_separate_and_unselected(self):
        originals = [channel("a"), channel("b", value="Average"),
                     channel("c", value="Sensor"), channel("d", value="Sensor (VOC)", icon="120"),
                     channel("e", value="Sensor (CO2)", icon="120"),
                     channel("f", value="Unlock", urn=TRIGGER, icon="10", field="Text")]
        rooms = {uid: "room" for uid in "abcdef"}
        files = files_for(*originals)
        first = self.groups(files, rooms)
        review = StatusReview(first)
        updated, count = apply_status_edits(files, review.reviewed())
        self.assertEqual(count, 6)
        second = self.groups(updated, rooms)
        self.assertEqual(len(second), 6)
        self.assertEqual({group.key for group in first}, {group.key for group in second})
        self.assertEqual({field.suggested for group in second for field in group.fields},
                         {"Tipkalo", "Srednja", "Senzor", "Senzor (VOC)", "Senzor (CO2)", "Otključaj"})
        self.assertTrue(all(not field.selected for group in second for field in group.fields))
        repeated, count = apply_status_edits(updated, StatusReview(second).reviewed())
        self.assertEqual(count, 0)
        self.assertEqual(repeated, updated)

    def test_edit_applies_only_to_chosen_room_and_description_role(self):
        files = files_for(channel("a"), channel("b"), channel("c", value="Average"),
                          channel("d", value="Sensor"), channel("e"))
        groups = self.groups(files, {"a": "r", "b": "r", "c": "r", "d": "r", "e": "other"})
        group = next(g for g in groups if g.entity_ids == ["a", "b"])
        field = group.fields[0]
        updated, count = apply_status_edits(files, [StatusEdit(field, "Tipkalo & zid", True)])
        self.assertEqual(count, 2)
        paths = list(files)
        for path in paths[:2]:
            self.assertEqual(updated[path], files[path].replace(
                b">Button</Description>", ">Tipkalo &amp; zid</Description>".encode("utf-8")))
        for path in paths[2:]:
            self.assertEqual(updated[path], files[path])

    def test_description_and_display_text_can_be_cleared_and_self_closing_values_edited(self):
        for urn, icon, field, replacement in (
            (TEMPERATURE, "14", "Description", "Tipkalo"),
            (TRIGGER, "10", "Text", "Otključaj"),
        ):
            with self.subTest(field=field):
                parameter_id = urn.rsplit(".", 1)[-1] + "." + field
                before = channel(value="", urn=urn, icon=icon, field=field)
                before = before.replace(f'defaultValue="Original default"></{field}>'.encode(),
                                        b'defaultValue="Original default" />')
                self.assertEqual(replace_parameter_text(before, parameter_id, "", ""), before)
                after = replace_parameter_text(before, parameter_id, "", replacement)
                expected = before.replace(b'defaultValue="Original default" />',
                    f'defaultValue="Original default" >{replacement}</{field}>'.encode("utf-8"))
                self.assertEqual(after, expected)
                cleared = replace_parameter_text(after, parameter_id, replacement, "")
                self.assertEqual(cleared, after.replace(
                    f'>{replacement}</{field}>'.encode("utf-8"), f'></{field}>'.encode()))

    def test_manual_clear_and_reset_preserve_role_and_selection(self):
        groups = self.groups(files_for(channel()))
        group, field = self.by_source(groups, "Button")
        key = group.key + (field.key,)
        review = StatusReview(groups)
        review.set_text(key, "")
        self.assertEqual(review.edits[key].text, "")
        self.assertTrue(review.edits[key].selected)
        self.assertEqual(review.changed_count(), 1)
        review.set_selected(key, False)
        self.assertEqual(review.changed_count(), 0)
        review.reset(key)
        self.assertEqual(review.edits[key].text, "Tipkalo")
        self.assertTrue(review.edits[key].selected)
        self.assertNotIn(key, review.manual)

    def test_only_existing_supported_visu_strings_are_translated(self):
        excluded = [channel(parameter_set="Other"), channel(value_type="enum"),
                    channel(urn="unsupported"),
                    channel(field="Text"), channel(urn=TRIGGER, icon="10", field="Description")]
        for raw in excluded:
            with self.subTest(raw=raw):
                self.assertEqual(self.groups(files_for(raw)), [])
        nested = channel().replace(b">Button</Description>", b">Button<child /></Description>")
        self.assertEqual(self.groups(files_for(nested)), [])


if __name__ == "__main__":
    unittest.main()
