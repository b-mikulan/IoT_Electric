import unittest

from gpa_translator.review import ReviewSession
from gpa_translator.translate import Proposal


def session():
    rows = [
        Proposal("room.xml", "r", "room", "Bedroom", "Spavaća", "ready", "room_dictionary", room_id="r"),
        Proposal("temp.xml", "t", "function", "T1", "Temperatura spavaća", "ready", "icon_and_room",
                 room="Spavaća", icon_id="14", room_id="r"),
        Proposal("door.xml", "e", "function", "E1", "Vrata spavaća", "ready", "icon_and_room",
                 room="Spavaća", icon_id="5", room_id="r"),
        Proposal("unknown.xml", "u", "function", "Custom", None, "unknown", "unknown_icon",
                 room="Spavaća", icon_id="9999", room_id="r"),
    ]
    return ReviewSession(rows, {"14": {"en": "Temperature", "hr": "Temperatura"},
                                "5": {"en": "Door", "hr": "Vrata"}})


class ReviewTests(unittest.TestCase):
    def test_room_changes_refresh_only_automatic_children(self):
        review = session()
        review.set_name("e", "Ulazna vrata")
        review.set_name("r", "Glavna spavaća")
        self.assertEqual(review.edits["t"].name, "Temperatura glavna spavaća")
        self.assertEqual(review.edits["e"].name, "Ulazna vrata")
        self.assertEqual(review.edits["u"].name, "Custom")
        self.assertFalse(review.edits["u"].selected)
        review.set_selected("r", False)
        self.assertEqual(review.edits["t"].name, "Temperatura bedroom")
        self.assertEqual(review.edits["e"].name, "Ulazna vrata")

    def test_reset_child_uses_current_room_and_reset_room_updates_children(self):
        review = session()
        review.set_name("e", "Ručno")
        review.set_name("r", "Soba 12")
        review.reset("e")
        self.assertEqual(review.edits["e"].name, "Vrata soba 12")
        self.assertFalse(review.edits["e"].manual)
        review.reset("r")
        self.assertEqual(review.edits["e"].name, "Vrata spavaća")

    def test_manual_unknown_name_selected_and_blank_rejected(self):
        review = session()
        review.set_name("u", "Ručni naziv čćšžđ")
        rows = {p.entity_id: p for p in review.reviewed()}
        self.assertEqual(rows["u"].status, "ready")
        self.assertEqual(rows["u"].new, "Ručni naziv čćšžđ")
        review.set_name("u", "")
        with self.assertRaises(ValueError):
            review.reviewed()
        review.set_selected("u", False)
        self.assertEqual({p.entity_id: p for p in review.reviewed()}["u"].new, "Custom")

    def test_duplicate_warning_uses_effective_names_and_selections(self):
        review = session()
        review.set_name("u", " VRATA SPAVAĆA ")
        self.assertEqual(review.duplicate_ids(), {"u", "e"})
        review.set_selected("u", False)
        self.assertEqual(review.duplicate_ids(), set())


if __name__ == "__main__":
    unittest.main()
