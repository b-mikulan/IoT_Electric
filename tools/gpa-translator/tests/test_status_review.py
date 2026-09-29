from types import SimpleNamespace
import unittest

from gpa_translator.status_review import StatusReview


def group(room, urn="Switch", icon="1", mixed=False):
    values = {"On": 1, "Custom": 1} if mixed else {"On": 2}
    field = SimpleNamespace(key="OnText", label="Status ON", old_values=values,
                            suggested=None if mixed else "Upaljeno", selected=not mixed,
                            targets=[SimpleNamespace(old=value) for value, count in values.items() for _ in range(count)])
    return SimpleNamespace(room_id=room, key=(room, urn, icon), fields=[field])


class StatusReviewTests(unittest.TestCase):
    def test_edit_stays_inside_room_type_and_icon(self):
        groups = [group("r1"), group("r2"), group("r1", "BinaryStatus"), group("r1", icon="164")]
        review = StatusReview(groups)
        key = groups[0].key + ("OnText",)
        review.set_text(key, "Svijetli")
        self.assertTrue(review.edits[key].selected)
        self.assertEqual(review.edits[key].text, "Svijetli")
        self.assertTrue(all(edit.text == "Upaljeno" for other, edit in review.edits.items() if other != key))
        review.reset(key)
        self.assertEqual(review.edits[key].text, "Upaljeno")
        self.assertNotIn(key, review.manual)

    def test_mixed_originals_need_an_explicit_common_value(self):
        current = group("r1", mixed=True)
        review = StatusReview([current])
        key = current.key + ("OnText",)
        self.assertFalse(review.edits[key].selected)
        self.assertEqual(review.changed_count(), 0)
        review.set_selected(key, True)
        with self.assertRaises(ValueError):
            review.reviewed()
        review.set_text(key, "Aktivno")
        self.assertEqual(review.changed_count(), 2)
        self.assertEqual(review.reviewed()[0].text, "Aktivno")

    def test_blank_is_allowed_only_after_explicit_edit_for_mixed_values(self):
        current = group("r1", mixed=True)
        review = StatusReview([current])
        key = current.key + ("OnText",)
        review.set_text(key, "")
        self.assertEqual(review.reviewed()[0].text, "")
        self.assertEqual(review.changed_count(), 2)
        review.set_selected(key, False)
        self.assertEqual(review.changed_count(), 0)
        review.reset(key)
        self.assertFalse(review.edits[key].selected)


if __name__ == "__main__":
    unittest.main()
