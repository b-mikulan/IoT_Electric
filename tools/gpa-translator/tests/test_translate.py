import tempfile
from pathlib import Path
import unittest
import zipfile

from gpa_translator.translate import (
    NS, Proposal, duplicate_name_groups, propose_names, replace_entity_name,
    review_proposals, translate_room, write_archive,
)


def xml(tag, content):
    return f'<conf:{tag} xmlns:conf="{NS[1:-1]}">{content}</conf:{tag}>'.encode()


class TranslatorTests(unittest.TestCase):
    def test_numbers_and_already_translated_rooms(self):
        rooms = {"Bathroom": {"hr": "Kupaonica"}}
        self.assertEqual(translate_room("Bathroom 12", rooms), "Kupaonica 12")
        self.assertEqual(translate_room("Kupaonica 12", rooms), "Kupaonica 12")
        self.assertIsNone(translate_room("Unknown 12", rooms))

    def test_xml_preserves_other_bytes_and_escapes_text(self):
        before = xml("ChannelView", '<conf:EntityName>Old</conf:EntityName>\r\n<conf:IconId>14</conf:IconId>')
        after = replace_entity_name(before, "Old", "Čćšžđ & soba")
        self.assertEqual(after, before.replace(b">Old<", ">Čćšžđ &amp; soba<".encode()))

    def test_room_links_collisions_arbitrary_names_and_sensor_rule(self):
        prefix = "projects/$p/"
        files = {prefix + "typedelements/$room.xml": xml("TypedElement",
            '<conf:EntityId>room</conf:EntityId><conf:EntityName>Bedroom</conf:EntityName>'
            '<conf:Type>Location</conf:Type><conf:Subtype>Room</conf:Subtype>')}
        for uid, name, icon in [("a", "2.8-9", "1"), ("b", "2.13", "1"),
                                ("c", "T1", "14"), ("d", "S1", "14"),
                                ("e", "E1", "20"), ("f", "Existing custom name", "30")]:
            files[prefix + f"channelviews/${uid}.xml"] = xml("ChannelView",
                f'<conf:EntityId>{uid}</conf:EntityId><conf:EntityName>{name}</conf:EntityName>'
                f'<conf:IconId>{icon}</conf:IconId>')
            files[prefix + f"channelviews/${uid}/locations/$link.assoc"] = (
                f'<Association><End cat="channelview" uid="{uid}"/>'
                '<End cat="typedelement" uid="room"/></Association>').encode()
        rows = {p.entity_id: p for p in propose_names(files,
            {"Bedroom": {"hr": "Spavaća"}},
            {"1": {"en": "Lighting", "hr": "Rasvjeta"},
             "14": {"en": "Temperature", "hr": "Temperatura"},
             "20": {"en": "Door", "hr": "Vrata"},
             "30": {"en": "Blind", "hr": "Sjenilo"}})}
        self.assertEqual(rows["a"].status, "review")
        self.assertEqual(rows["b"].status, "review")
        self.assertEqual(rows["c"].new, "Temperatura spavaća")
        self.assertEqual(rows["c"].status, "ready")
        self.assertEqual(rows["d"].new, "Senzor spavaća")
        self.assertEqual(rows["d"].reason, "sensor_and_room")
        self.assertEqual(rows["e"].new, "Vrata spavaća")
        self.assertEqual(rows["e"].status, "ready")
        self.assertEqual(rows["f"].new, "Sjenilo spavaća")
        self.assertEqual(rows["f"].reason, "icon_and_room")
        self.assertTrue(all(p.room_id == "room" for p in rows.values()))

    def test_missing_room_and_icon_remain_available_for_review(self):
        files = {
            "projects/$p/channelviews/$a.xml": xml("ChannelView",
                '<conf:EntityId>a</conf:EntityId><conf:EntityName>E1</conf:EntityName>'
                '<conf:IconId>20</conf:IconId>'),
            "projects/$p/channelviews/$b.xml": xml("ChannelView",
                '<conf:EntityId>b</conf:EntityId><conf:EntityName>Custom name</conf:EntityName>'
                '<conf:IconId>missing</conf:IconId>'),
        }
        rows = {p.entity_id: p for p in propose_names(
            files, {}, {"20": {"en": "Door", "hr": "Vrata"}})}
        self.assertEqual(rows["a"].reason, "missing_ambiguous_or_unknown_room")
        self.assertEqual(rows["b"].reason, "unknown_icon")
        self.assertTrue(all(p.status == "unknown" and p.room_id is None
                            for p in rows.values()))

    def test_review_applies_manual_names_and_selection_without_mutation(self):
        original = [
            Proposal("a", "a", "room", "Bedroom", "Spavaća", "ready", "room_dictionary"),
            Proposal("b", "b", "function", "E1", None, "unknown", "unknown_icon"),
            Proposal("c", "c", "function", "1.2", "Rasvjeta spavaća", "review",
                     "duplicate_name_in_room"),
        ]
        reviewed = review_proposals(original, {"a": "", "b": "Vrata čćšžđ"}, {"b", "c"})
        self.assertEqual((reviewed[0].new, reviewed[0].status), ("Bedroom", "unchanged"))
        self.assertEqual((reviewed[1].new, reviewed[1].status), ("Vrata čćšžđ", "ready"))
        self.assertEqual(reviewed[1].reason, "manual_override")
        self.assertEqual(reviewed[2].status, "ready")
        self.assertEqual(original[0].status, "ready")
        self.assertIsNone(original[1].new)
        self.assertEqual(original[2].status, "review")

    def test_review_rejects_blank_or_invalid_xml_text_and_unknown_ids(self):
        proposal = Proposal("a", "a", "function", "E1", "Vrata", "ready", "icon_and_room")
        for invalid in ["", " \t\n", "Vrata\x00", "Vrata\x0b", "Vrata\ud800", "Vrata\ufffe"]:
            with self.subTest(invalid=repr(invalid)), self.assertRaises(ValueError):
                review_proposals([proposal], {"a": invalid}, {"a"})
        with self.assertRaises(ValueError):
            review_proposals([proposal], {}, {"unknown"})
        self.assertEqual(review_proposals([proposal], {"a": "E1"}, {"a"})[0].status,
                         "unchanged")

    def test_explicit_duplicate_names_are_allowed_but_reported_by_room_id(self):
        original = [
            Proposal(uid, uid, "function", uid, "Rasvjeta", "review", "duplicate_name_in_room",
                     room="Boravak", room_id=room_id)
            for uid, room_id in [("a", "room1"), ("b", "room1"), ("c", "room2")]
        ]
        reviewed = review_proposals(original, {}, {"a", "b", "c"})
        self.assertTrue(all(p.status == "ready" for p in reviewed))
        groups = duplicate_name_groups(reviewed)
        self.assertEqual([[p.entity_id for p in group] for group in groups], [["a", "b"]])

    def test_reviewed_archive_applies_only_selected_names(self):
        files, proposals = {}, []
        for uid in ["a", "b"]:
            path = f"projects/$p/channelviews/${uid}.xml"
            files[path] = xml("ChannelView", f'<conf:EntityName>{uid}</conf:EntityName>')
            proposals.append(Proposal(path, uid, "function", uid, None, "unknown", "unknown_icon"))
        reviewed = review_proposals(proposals, {"a": "Vrata & čćšžđ", "b": "Ignored"}, {"a"})
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "reviewed.gpa"
            self.assertEqual(write_archive(output, files, reviewed), 1)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.read(proposals[0].path),
                    files[proposals[0].path].replace(b">a<", ">Vrata &amp; čćšžđ<".encode()))
                self.assertEqual(archive.read(proposals[1].path), files[proposals[1].path])

    def test_archive_preserves_unedited_files_and_has_no_directory_entries(self):
        name = "projects/$p/channelviews/$c.xml"
        raw = xml("ChannelView", '<conf:EntityName>Old</conf:EntityName>')
        files = {name: raw, "projects/$p/payload.bin": b"\x00\xff\x01"}
        change = Proposal(name, "c", "function", "Old", "Novo", "ready", "test")
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "test.gpa"
            self.assertEqual(write_archive(path, files, [change]), 1)
            with zipfile.ZipFile(path) as archive:
                self.assertFalse(any(e.is_dir() for e in archive.infolist()))
                self.assertEqual(archive.read("projects/$p/payload.bin"), files["projects/$p/payload.bin"])
                self.assertEqual(archive.read(name), raw.replace(b"Old", b"Novo"))
            with self.assertRaises(FileExistsError):
                write_archive(path, files, [change])


if __name__ == "__main__":
    unittest.main()
