import unittest

from gpa_translator.defaults import DefaultRule
from gpa_translator.review import ReviewSession
from gpa_translator.translate import propose_names
from .test_translate import xml


def fixture(defaults):
    prefix = "projects/$p/"
    files = {prefix + "typedelements/$room.xml": xml("TypedElement",
        '<conf:EntityId>room</conf:EntityId><conf:EntityName>Living room</conf:EntityName>'
        '<conf:Type>Location</conf:Type><conf:Subtype>Room</conf:Subtype>')}
    for uid, name in (("a", "1.3"), ("b", "1.4")):
        files[prefix + f"channelviews/${uid}.xml"] = xml("ChannelView",
            f'<conf:EntityId>{uid}</conf:EntityId><conf:EntityName>{name}</conf:EntityName>'
            '<conf:Urn>Switch</conf:Urn><conf:IconId>1</conf:IconId>')
        files[prefix + f"channelviews/${uid}/locations/$link.assoc"] = (
            f'<Association><End cat="channelview" uid="{uid}"/>'
            '<End cat="typedelement" uid="room"/></Association>').encode()
    icons = {"1": {"en": "Lighting", "hr": "Rasvjeta"}}
    proposals = propose_names(files, {"Living room": {"hr": "Boravak"}}, icons, defaults)
    return ReviewSession(proposals, icons)


RULE = DefaultRule("1.3", "Stropna blagovaonica", expected_room="Blagovaonica")


class PriorityReviewTests(unittest.TestCase):
    def test_priority_wins_and_original_automation_is_kept_as_alternative(self):
        review = fixture([RULE])
        p = review.by_id["a"]
        self.assertEqual(p.default_new, "Stropna blagovaonica")
        self.assertEqual(p.automatic_new, "Rasvjeta boravak")
        self.assertEqual(p.reason, "priority_dictionary")
        self.assertEqual(review.edits["a"].strategy, "default")
        self.assertEqual(review.edits["a"].name, "Stropna blagovaonica")
        self.assertEqual(review.edits["b"].name, "Rasvjeta boravak")
        self.assertEqual(p.status, "ready")
        # The default resolves the initial identical automatic light names.
        self.assertEqual(review.by_id["b"].status, "ready")

    def test_mode_can_switch_both_ways_and_follow_current_room(self):
        review = fixture([RULE])
        review.set_strategy("a", "automatic")
        self.assertEqual(review.edits["a"].name, "Rasvjeta boravak")
        review.set_name("room", "Degažman")
        self.assertEqual(review.edits["a"].name, "Rasvjeta degažman")
        review.set_strategy("a", "default")
        self.assertEqual(review.edits["a"].name, "Stropna blagovaonica")
        review.set_name("room", "Kuhinja")
        self.assertEqual(review.edits["a"].name, "Stropna blagovaonica")

    def test_default_edit_does_not_replace_manual_names_or_explicit_auto_choice(self):
        review = fixture([RULE, DefaultRule("1.4", "Stropna otok")])
        review.set_name("a", "Ručna rasvjeta")
        review.set_strategy("b", "automatic")
        review.refresh_defaults([DefaultRule("1.3", "Promijenjeni default"), DefaultRule("1.4", "Drugi default")])
        self.assertEqual(review.edits["a"].name, "Ručna rasvjeta")
        self.assertEqual(review.edits["b"].strategy, "automatic")
        self.assertEqual(review.edits["b"].name, "Rasvjeta boravak")
        review.reset("a")
        self.assertEqual(review.edits["a"].name, "Promijenjeni default")

    def test_remove_and_add_rule_refreshes_current_proposals(self):
        review = fixture([RULE])
        review.refresh_defaults([])
        self.assertEqual(review.edits["a"].strategy, "automatic")
        self.assertEqual(review.edits["a"].name, "Rasvjeta boravak")
        review.refresh_defaults([RULE])
        self.assertEqual(review.edits["a"].strategy, "default")
        self.assertEqual(review.edits["a"].name, "Stropna blagovaonica")

    def test_room_default_updates_automatic_functions(self):
        review = fixture([DefaultRule("Living room", "Dnevni prostor", kind="room")])
        self.assertEqual(review.edits["a"].name, "Rasvjeta dnevni prostor")
        review.set_strategy("room", "automatic")
        self.assertEqual(review.edits["a"].name, "Rasvjeta boravak")

    def test_unknown_default_without_automation_still_can_choose_old_name(self):
        review = fixture([RULE])
        review.by_id["a"].icon_id = "unknown"
        review.set_strategy("a", "automatic")
        self.assertEqual(review.edits["a"].name, "1.3")
        self.assertFalse(review.edits["a"].selected)
        review.set_strategy("a", "default")
        self.assertEqual(review.edits["a"].name, "Stropna blagovaonica")


if __name__ == "__main__":
    unittest.main()
