import tempfile
from pathlib import Path
import unittest
import zipfile

from gpa_translator.defaults import DefaultRule
from gpa_translator.review import ReviewSession
from gpa_translator.translate import propose_names, write_archive
from .test_translate import xml


def fixture(functions=None, room_names=None, *, defaults=(), allow_duplicates=False):
    """Use actual room associations so the tests exercise current candidates."""
    files = {}
    prefix = "projects/$p/"
    rooms = room_names if room_names is not None else {"r": "Living room"}
    for uid, name in rooms.items():
        files[prefix + f"typedelements/${uid}.xml"] = xml("TypedElement",
            f'<conf:EntityId>{uid}</conf:EntityId><conf:EntityName>{name}</conf:EntityName>'
            '<conf:Type>Location</conf:Type><conf:Subtype>Room</conf:Subtype>')
    for uid, name, room_id, icon in (functions or (
        ("a", "1.1", "r", "1"), ("b", "1.2", "r", "1"),
    )):
        files[prefix + f"channelviews/${uid}.xml"] = xml("ChannelView",
            f'<conf:EntityId>{uid}</conf:EntityId><conf:EntityName>{name}</conf:EntityName>'
            f'<conf:IconId>{icon}</conf:IconId><conf:Urn>Switch</conf:Urn>')
        if room_id is not None:
            files[prefix + f"channelviews/${uid}/locations/$link.assoc"] = (
                f'<Association><End cat="channelview" uid="{uid}"/>'
                f'<End cat="typedelement" uid="{room_id}"/></Association>').encode()
    icons = {"1": {"en": "Lighting", "hr": "Rasvjeta"}}
    proposals = propose_names(files, {"Living room": {"hr": "Boravak"}}, icons, defaults)
    return files, ReviewSession(proposals, icons, allow_duplicates=allow_duplicates)


class DuplicateToggleTests(unittest.TestCase):
    def test_off_by_default_and_enable_checks_pending_duplicates_without_renaming(self):
        _, review = fixture()
        self.assertFalse(review.allow_duplicates)
        self.assertTrue(all(review.by_id[uid].status == "review" for uid in ("a", "b")))
        self.assertFalse(review.edits["a"].selected)
        self.assertFalse(review.edits["b"].selected)
        names = {uid: edit.name for uid, edit in review.edits.items()}

        review.set_allow_duplicates(True)

        self.assertTrue(review.allow_duplicates)
        self.assertEqual({uid: edit.name for uid, edit in review.edits.items()}, names)
        self.assertTrue(review.edits["a"].selected)
        self.assertTrue(review.edits["b"].selected)
        self.assertEqual(review.duplicate_ids(), {"a", "b"})
        self.assertTrue(all(p.status == "ready" for p in review.reviewed()
                            if p.entity_id in ("a", "b")))

    def test_constructor_can_start_enabled_and_off_undoes_only_automatic_checks(self):
        _, review = fixture(allow_duplicates=True)
        self.assertTrue(review.allow_duplicates)
        self.assertTrue(review.edits["a"].selected)
        self.assertTrue(review.edits["b"].selected)
        self.assertTrue(review.edits["r"].selected)
        review.set_allow_duplicates(False)
        self.assertFalse(review.edits["a"].selected)
        self.assertFalse(review.edits["b"].selected)
        self.assertTrue(review.edits["r"].selected)
        self.assertEqual(review.edits["a"].name, "Rasvjeta boravak")

    def test_disable_preserves_manual_names_and_explicit_row_selection(self):
        _, review = fixture()
        review.set_name("a", "Rasvjeta boravak")
        self.assertTrue(review.edits["a"].manual)
        review.set_allow_duplicates(True)
        review.set_selected("b", True)
        review.set_allow_duplicates(False)
        self.assertEqual(review.edits["a"].name, "Rasvjeta boravak")
        self.assertTrue(review.edits["a"].selected)
        self.assertTrue(review.edits["b"].selected)

    def test_row_opt_out_survives_room_refresh_and_repeated_enable(self):
        _, review = fixture(allow_duplicates=True)
        review.set_selected("a", False)
        review.set_name("r", "Kuhinja")
        self.assertEqual(review.edits["a"].name, "Rasvjeta kuhinja")
        self.assertFalse(review.edits["a"].selected)
        self.assertTrue(review.edits["b"].selected)
        review.set_allow_duplicates(True)
        self.assertFalse(review.edits["a"].selected)
        review.set_allow_duplicates(False)
        review.set_allow_duplicates(True)
        self.assertTrue(review.edits["a"].selected)
        self.assertTrue(review.edits["b"].selected)

    def test_reset_with_permission_rechecks_pending_duplicate(self):
        _, review = fixture(allow_duplicates=True)
        review.set_selected("a", False)
        review.reset("a")
        self.assertTrue(review.edits["a"].selected)
        self.assertFalse(review.edits["a"].manual)
        self.assertEqual(review.edits["a"].name, "Rasvjeta boravak")
        review.set_allow_duplicates(False)
        self.assertFalse(review.edits["a"].selected)

    def test_default_refresh_checks_new_collisions_but_preserves_opt_out(self):
        rules = [DefaultRule("1.1", "Rasvjeta lijeva"), DefaultRule("1.2", "Rasvjeta desna")]
        _, review = fixture(defaults=rules, allow_duplicates=True)
        review.set_selected("a", False)
        review.refresh_defaults([
            DefaultRule("1.1", "Stropna rasvjeta"), DefaultRule("1.2", "Stropna rasvjeta"),
        ])
        self.assertEqual(review.edits["a"].name, "Stropna rasvjeta")
        self.assertEqual(review.edits["b"].name, "Stropna rasvjeta")
        self.assertFalse(review.edits["a"].selected)
        self.assertTrue(review.edits["b"].selected)
        review.reset("a")
        self.assertTrue(review.edits["a"].selected)

    def test_same_name_in_separate_rooms_does_not_trigger_automatic_checks(self):
        _, review = fixture([
            ("a", "1.1", "r", "1"), ("b", "1.2", "r2", "1"),
        ], {"r": "Living room", "r2": "Living room"})
        review.set_selected("a", False)
        review.set_selected("b", False)
        self.assertEqual(review.edits["a"].name, review.edits["b"].name)
        review.set_allow_duplicates(True)
        self.assertFalse(review.edits["a"].selected)
        self.assertFalse(review.edits["b"].selected)
        self.assertEqual(review.duplicate_ids(), set())

    def test_missing_room_is_not_a_duplicate_group_even_for_manual_names(self):
        _, review = fixture([
            ("a", "1.1", None, "1"), ("b", "1.2", None, "1"),
        ])
        for uid in ("a", "b"):
            review.set_name(uid, "Rasvjeta")
            review.set_selected(uid, False)
        review.set_allow_duplicates(True)
        self.assertFalse(review.edits["a"].selected)
        self.assertFalse(review.edits["b"].selected)
        self.assertEqual(review.duplicate_ids(), set())

    def test_unknown_and_unchanged_candidates_are_not_automatically_selected(self):
        _, unknown = fixture([
            ("a", "Custom", "r", "missing"), ("b", "Custom", "r", "missing"),
        ], allow_duplicates=True)
        self.assertIsNone(unknown.by_id["a"].new)
        self.assertFalse(unknown.edits["a"].selected)
        self.assertFalse(unknown.edits["b"].selected)

        _, unchanged = fixture([
            ("a", "Rasvjeta boravak", "r", "1"),
            ("b", "Rasvjeta boravak", "r", "1"),
        ], allow_duplicates=True)
        self.assertEqual(unchanged.edits["a"].name, unchanged.by_id["a"].old)
        self.assertFalse(unchanged.edits["a"].selected)
        self.assertFalse(unchanged.edits["b"].selected)

    def test_changed_candidate_can_collide_with_an_unchanged_existing_name(self):
        _, review = fixture([
            ("a", "1.1", "r", "1"), ("b", "Rasvjeta boravak", "r", "1"),
        ], allow_duplicates=True)
        self.assertTrue(review.edits["a"].selected)
        self.assertFalse(review.edits["b"].selected)
        self.assertEqual(review.duplicate_ids(), {"a", "b"})

    def test_invalid_candidate_is_never_checked_by_permission(self):
        for invalid in ("", " \t\n", "Rasvjeta\x00", "Rasvjeta\x0b", "Rasvjeta\ud800"):
            with self.subTest(invalid=repr(invalid)):
                _, review = fixture()
                for uid in ("a", "b"):
                    review.set_name(uid, invalid)
                    review.set_selected(uid, False)
                review.set_allow_duplicates(True)
                self.assertFalse(review.edits["a"].selected)
                self.assertFalse(review.edits["b"].selected)
                reviewed = {p.entity_id: p for p in review.reviewed()}
                self.assertEqual(reviewed["a"].new, "1.1")
                self.assertEqual(reviewed["b"].new, "1.2")

    def test_candidate_matching_normalizes_case_and_surrounding_whitespace(self):
        _, review = fixture()
        review.set_name("a", " Stropna ČĆŠŽĐ ")
        review.set_name("b", "stropna čćšžđ")
        review.set_selected("a", False)
        review.set_selected("b", False)
        review.set_allow_duplicates(True)
        self.assertTrue(review.edits["a"].selected)
        self.assertTrue(review.edits["b"].selected)
        self.assertEqual(review.duplicate_ids(), {"a", "b"})
        self.assertEqual(review.edits["a"].name, " Stropna ČĆŠŽĐ ")

    def test_duplicate_selected_names_are_exported_to_archive(self):
        files, review = fixture(allow_duplicates=True)
        reviewed = review.reviewed()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "duplicates.gpa"
            self.assertEqual(write_archive(path, files, reviewed), 3)
            with zipfile.ZipFile(path) as archive:
                for uid in ("a", "b"):
                    raw = archive.read(review.by_id[uid].path)
                    self.assertIn(b"<conf:EntityName>Rasvjeta boravak</conf:EntityName>", raw)
                self.assertEqual(set(archive.namelist()), set(files))
                self.assertFalse(any(info.is_dir() for info in archive.infolist()))


if __name__ == "__main__":
    unittest.main()
