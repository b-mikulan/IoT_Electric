import unittest

from gpa_translator.defaults import DefaultRule
from gpa_translator.icon_images import proposal_uses_icon
from gpa_translator.name_rules import name_rule_for
from gpa_translator.review import ReviewSession
from gpa_translator.translate import propose_names, replace_entity_name
from .test_translate import xml


ROOMS = {
    "Living room": {"hr": "Boravak"},
    "Bedroom": {"hr": "Spavaća"},
    "Bathroom": {"hr": "Kupaonica"},
    "WC": {"hr": "WC"},
}
ICONS = {
    "5": {"en": "Door", "hr": "Vrata"},
    "14": {"en": "Temperature", "hr": "Temperatura"},
    "21": {"en": "Heating", "hr": "Grijanje"},
}


def fixture(functions, room_names=None, defaults=()):
    """Create real room associations, including missing and ambiguous ones."""
    prefix = "projects/$p/"
    files = {}
    for room_id, name in (room_names or {"r": "Living room"}).items():
        files[prefix + f"typedelements/${room_id}.xml"] = xml("TypedElement",
            f'<conf:EntityId>{room_id}</conf:EntityId><conf:EntityName>{name}</conf:EntityName>'
            '<conf:Type>Location</conf:Type><conf:Subtype>Room</conf:Subtype>')
    for uid, name, icon, room_ids in functions:
        files[prefix + f"channelviews/${uid}.xml"] = xml("ChannelView",
            f'<conf:EntityId>{uid}</conf:EntityId><conf:EntityName>{name}</conf:EntityName>'
            f'<conf:IconId>{icon}</conf:IconId><conf:Urn>Switch</conf:Urn>')
        for room_id in room_ids:
            files[prefix + f"channelviews/${uid}/locations/${room_id}.assoc"] = (
                f'<Association><End cat="channelview" uid="{uid}"/>'
                f'<End cat="typedelement" uid="{room_id}"/></Association>').encode()
    proposals = propose_names(files, ROOMS, ICONS, defaults)
    return files, proposals, ReviewSession(proposals, ICONS)


class NameRuleTests(unittest.TestCase):
    def test_code_families_use_actual_numbered_room_despite_wrong_or_unknown_icon(self):
        for name, expected_prefix in (
            ("AC1", "Klima"), ("ac2", "Klima"), ("AC003", "Klima"),
            ("FH", "Podno grijanje"), ("fh", "Podno grijanje"), ("fH11", "Podno grijanje"),
            ("T1", "Temperatura"), ("t27", "Temperatura"),
            ("S1", "Senzor"), ("s03", "Senzor"),
        ):
            for icon in ("5", "unknown"):
                with self.subTest(name=name, icon=icon):
                    _, _, review = fixture([("a", name, icon, ["r"])], {"r": "Bathroom 12"})
                    proposal = review.by_id["a"]
                    self.assertEqual(proposal.new, f"{expected_prefix} kupaonica 12")
                    self.assertEqual(proposal.status, "ready")
                    self.assertEqual(review.edits["a"].name, proposal.new)
                    self.assertEqual(review.edits["a"].strategy, "automatic")
                    self.assertTrue(review.edits["a"].selected)
                    self.assertFalse(proposal_uses_icon(proposal, review))

    def test_rules_match_whole_codes_only_and_leave_descriptive_names_to_dictionary(self):
        for name in ("AC", "T", "S", "AC1extra", "prefix AC1", "FH1.2", "T1-2",
                     "S1 suffix", "Auto Sensor", "Sensor Mode", "Night Mode", " S1", "S1 ",
                     "AC١", "T１", "S١"):
            with self.subTest(name=name):
                self.assertIsNone(name_rule_for(name))
        _, _, review = fixture([
            ("mode", "Sensor Mode", "unknown", ["r"]),
            ("door", "AC1extra", "5", ["r"]),
        ], defaults=[DefaultRule("Sensor Mode", "Senzor režim")])
        self.assertEqual(review.edits["mode"].name, "Senzor režim")
        self.assertEqual(review.edits["mode"].strategy, "default")
        self.assertEqual(review.edits["door"].name, "Vrata boravak")
        self.assertTrue(proposal_uses_icon(review.by_id["door"], review))

    def test_legacy_priority_entries_cannot_pin_codes_to_a_different_room(self):
        names = ("AC1", "FH", "T1", "S1")
        rules = [DefaultRule(name, f"Pogrešno {name}", expected_room="Kuhinja") for name in names]
        _, _, review = fixture([(name, name, "5", ["r"]) for name in names], defaults=rules)
        for name in names:
            with self.subTest(name=name):
                proposal = review.by_id[name]
                self.assertIsNone(proposal.default_new)
                self.assertIsNone(proposal.default_room)
                self.assertNotEqual(proposal.reason, "priority_dictionary")
                self.assertEqual(review.edits[name].strategy, "automatic")
                self.assertEqual(review.edits[name].name, name_rule_for(name).room_name("Boravak"))
        review.set_name("AC1", "Ručna klima")
        review.refresh_defaults(rules + [DefaultRule("Living room", "Dnevni prostor", kind="room")])
        self.assertEqual(review.edits["AC1"].name, "Ručna klima")
        for name in names[1:]:
            with self.subTest(refreshed=name):
                self.assertIsNone(review.by_id[name].default_new)
                self.assertEqual(review.edits[name].strategy, "automatic")
                self.assertEqual(review.edits[name].name, name_rule_for(name).room_name("Dnevni prostor"))

    def test_missing_ambiguous_or_unknown_room_never_uses_fixed_dictionary_room(self):
        for name in ("AC1", "FH", "FH2", "T1", "S1"):
            for room_ids in ([], ["r", "r2"], ["missing"], ["unknown"]):
                with self.subTest(name=name, room_ids=room_ids):
                    _, proposals, _ = fixture([("a", name, "unknown", room_ids)],
                        {"r": "Living room", "r2": "Bedroom", "unknown": "Untranslated room"},
                        [DefaultRule(name, "Stari fiksni naziv", expected_room="Boravak")])
                    proposal = next(p for p in proposals if p.entity_id == "a")
                    self.assertIsNone(proposal.new)
                    self.assertIsNone(proposal.default_new)
                    self.assertEqual(proposal.status, "unknown")
                    self.assertEqual(proposal.reason, "missing_ambiguous_or_unknown_room")

    def test_room_edit_refreshes_rule_names_and_preserves_manual_function_name(self):
        _, _, review = fixture([
            ("ac", "AC1", "unknown", ["r"]), ("fh", "FH2", "5", ["r"]),
            ("t", "T1", "5", ["r"]), ("s", "S1", "14", ["r"]),
        ], {"r": "Bedroom"})
        review.set_name("fh", "Podno kupaonica za goste")
        review.set_name("r", "Dječja soba 2")
        self.assertEqual(review.edits["ac"].name, "Klima dječja soba 2")
        self.assertEqual(review.edits["t"].name, "Temperatura dječja soba 2")
        self.assertEqual(review.edits["s"].name, "Senzor dječja soba 2")
        self.assertEqual(review.edits["fh"].name, "Podno kupaonica za goste")
        review.reset("fh")
        self.assertEqual(review.edits["fh"].name, "Podno grijanje dječja soba 2")
        review.set_selected("r", False)
        self.assertEqual(review.edits["ac"].name, "Klima bedroom")
        self.assertEqual(review.edits["s"].name, "Senzor bedroom")

    def test_room_acronym_remains_uppercase_in_cli_and_review(self):
        for code, prefix in (("AC1", "Klima"), ("FH", "Podno grijanje"),
                             ("T1", "Temperatura"), ("S1", "Senzor")):
            with self.subTest(code=code):
                _, _, review = fixture([("a", code, "5", ["r"])], {"r": "WC"})
                self.assertEqual(review.by_id["a"].new, prefix + " WC")
                self.assertEqual(review.edits["a"].name, prefix + " WC")

    def test_duplicate_rule_names_warn_within_the_actual_room_only(self):
        _, _, review = fixture([
            ("a", "AC1", "unknown", ["r"]), ("b", "AC2", "unknown", ["r"]),
            ("c", "AC3", "unknown", ["r2"]),
        ], {"r": "Living room", "r2": "Bedroom"})
        self.assertEqual(review.by_id["a"].status, "review")
        self.assertEqual(review.by_id["b"].status, "review")
        self.assertEqual(review.by_id["c"].status, "ready")
        self.assertEqual(review.by_id["c"].new, "Klima spavaća")
        review.set_selected("a", True)
        review.set_selected("b", True)
        self.assertEqual(review.duplicate_ids(), {"a", "b"})
        review.set_name("b", "Klima boravak lijeva")
        self.assertEqual(review.duplicate_ids(), set())

    def test_reopening_generated_names_preserves_sensor_and_floor_heating_semantics(self):
        files, proposals, _ = fixture([
            ("ac", "AC1", "5", ["r"]), ("fh", "FH1", "21", ["r"]),
            ("t", "T1", "unknown", ["r"]), ("s", "S1", "14", ["r"]),
        ], {"r": "Bedroom"})
        translated = dict(files)
        for proposal in proposals:
            if proposal.new is not None:
                translated[proposal.path] = replace_entity_name(
                    files[proposal.path], proposal.old, proposal.new)
        reopened = propose_names(translated, ROOMS, ICONS)
        review = ReviewSession(reopened, ICONS)
        for proposal in reopened:
            with self.subTest(entity=proposal.entity_id):
                self.assertEqual(proposal.new, proposal.old)
                self.assertEqual(proposal.status, "unchanged")
                if proposal.kind == "function":
                    self.assertFalse(proposal_uses_icon(proposal, review))
        review.set_name("r", "Kuhinja")
        self.assertEqual(review.edits["s"].name, "Senzor kuhinja")
        self.assertEqual(review.edits["fh"].name, "Podno grijanje kuhinja")
        self.assertEqual(review.edits["ac"].name, "Klima kuhinja")
        self.assertEqual(review.edits["t"].name, "Temperatura kuhinja")


if __name__ == "__main__":
    unittest.main()
