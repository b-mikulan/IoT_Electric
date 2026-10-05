from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from gpa_translator.defaults import (
    DefaultRule, default_rule_for, default_target_rule_for, load_defaults,
    save_defaults, validate_rules,
)
from gpa_translator.name_rules import name_rule_for


class DefaultsTests(unittest.TestCase):
    def test_whole_name_and_kind_are_exact(self):
        rules = [DefaultRule("1.1", "Rasvjeta ulaz")]
        self.assertEqual(default_rule_for("1.1", "function", "1", "Switch", rules), rules[0])
        for name in ("11.1", "1.10", "prefix 1.1", "1.1 suffix", " 1.1"):
            self.assertIsNone(default_rule_for(name, "function", "1", "Switch", rules))
        self.assertIsNone(default_rule_for("1.1", "room", None, None, rules))
        named = [DefaultRule("Supply", "Dobavni")]
        self.assertIsNone(default_rule_for("supply", "function", None, None, named))

    def test_context_precedence_and_room_is_only_information(self):
        broad = DefaultRule("E1", "Vrata status", expected_room="Ulaz")
        narrow = DefaultRule("E1", "Vrata otvorena", icon_id="5", urn="BinaryStatus")
        rules = validate_rules([broad, narrow])
        self.assertEqual(default_rule_for("E1", "function", "5", "BinaryStatus", rules), narrow)
        self.assertEqual(default_rule_for("E1", "function", "20", "BinaryStatus", rules), broad)
        self.assertEqual(default_rule_for("E1", "function", None, None, rules), broad)

    def test_ambiguous_context_is_rejected_and_cannot_pick_arbitrarily(self):
        rules = [DefaultRule("E1", "Vrata", icon_id="5"),
                 DefaultRule("E1", "Signal", urn="BinaryStatus")]
        with self.assertRaises(ValueError):
            validate_rules(rules)
        self.assertIsNone(default_rule_for("E1", "function", "5", "BinaryStatus", rules))
        # Distinct icons cannot apply to the same object and are allowed.
        validate_rules([rules[0], replace(rules[0], icon_id="20", target_hr="Druga vrata")])
        with self.assertRaises(ValueError):
            validate_rules([rules[0], rules[0]])

    def test_translated_targets_are_preserved_but_explicit_source_wins(self):
        light = DefaultRule("1.3", "Stropna blagovaonica", expected_room="Blagovaonica")
        override = DefaultRule("Stropna blagovaonica", "Rasvjeta stol")
        rules = validate_rules([light, override])
        self.assertEqual(default_target_rule_for(light.target_hr, "function", "1", "Switch", rules), light)
        selected = (default_rule_for(light.target_hr, "function", "1", "Switch", rules)
                    or default_target_rule_for(light.target_hr, "function", "1", "Switch", rules))
        self.assertEqual(selected, override)
        for name in ("Unknown", "stropna blagovaonica", "Stropna blagovaonica 2"):
            self.assertIsNone(default_target_rule_for(name, "function", "1", "Switch", rules))
        contextual = [replace(light, icon_id="1")]
        self.assertIsNone(default_target_rule_for(light.target_hr, "function", "20", "Switch", contextual))
        self.assertIsNone(default_target_rule_for(light.target_hr, "room", "1", "Switch", rules))

    def test_output_aliases_need_consistent_room_expectation(self):
        rules = [DefaultRule("35.39", "Ogledalo kupaonica 2", expected_room="Kupaonica 2"),
                 DefaultRule("36.39", "Ogledalo kupaonica 2", expected_room="Kupaonica 2")]
        self.assertIsNotNone(default_target_rule_for("Ogledalo kupaonica 2", "function", "1", "Switch", rules))
        rules[1] = replace(rules[1], expected_room="Other room")
        self.assertIsNone(default_target_rule_for("Ogledalo kupaonica 2", "function", "1", "Switch", rules))

    def test_blank_invalid_and_control_characters_are_rejected(self):
        base = DefaultRule("E1", "Vrata")
        for invalid in (
            replace(base, source_name=""), replace(base, target_hr=" \t"),
            replace(base, target_hr="Vrata\x00"), replace(base, kind="other"),
            replace(base, kind=[]), replace(base, icon_id="not-an-id"),
            replace(base, expected_room=""), replace(base, urn=""),
            replace(base, provenance=""),
        ):
            with self.subTest(rule=invalid):
                with self.assertRaises(ValueError):
                    validate_rules([invalid])

    def test_save_round_trip_preserves_metadata_and_old_file_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "defaults.json"
            first = [DefaultRule("E1", "Vrata & Čćšžđ")]
            save_defaults(path, first)
            self.assertEqual(load_defaults(path), first)
            data = json.loads(path.read_text(encoding="utf-8"))
            data["notes"] = ["Keep these notes"]
            path.write_text(json.dumps(data), encoding="utf-8")
            second = [replace(first[0], target_hr="Druga vrata")]
            save_defaults(path, second)
            self.assertEqual(load_defaults(path), second)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["notes"], data["notes"])
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                save_defaults(path, [replace(first[0], target_hr="")])
            self.assertEqual(path.read_bytes(), before)
            with patch("gpa_translator.defaults.os.replace", side_effect=OSError("disk error")):
                with self.assertRaises(OSError):
                    save_defaults(path, first)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_invalid_json_rule_fields_and_version_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            for data in (
                {"schema_version": True, "rules": []},
                {"schema_version": 2, "rules": []},
                {"schema_version": 1, "rules": [{"source_name": "E1"}]},
                {"schema_version": 1, "rules": [{"source_name": "E1", "target_hr": "Vrata", "secret": "x"}]},
            ):
                path.write_text(json.dumps(data), encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_defaults(path)

    def test_seed_rules_include_email_overrides_and_no_ambiguous_or_numbered_rooms(self):
        dictionary = Path(__file__).resolve().parents[1] / "data" / "defaults.hr.json"
        rules = load_defaults(dictionary)
        by_name = {(rule.kind, rule.source_name): rule for rule in rules}
        self.assertEqual(by_name["function", "1.1"].target_hr, "Rasvjeta ulaz")
        self.assertEqual(by_name["function", "1.2"].target_hr, "Rasvjeta hodnik")
        self.assertEqual(by_name["function", "1.3"].target_hr, "Stropna blagovaonica")
        self.assertEqual(by_name["function", "35.39"].target_hr, "Ogledalo kupaonica 2")
        self.assertEqual(by_name["function", "36.39"].target_hr, "Ogledalo kupaonica 2")
        self.assertEqual(by_name["function", "E1"].target_hr, "Vrata status")
        self.assertEqual(by_name["function", "Sensor Mode"].target_hr, "Senzor režim")
        self.assertEqual(by_name["function", "Night Mode"].target_hr, "Noćni režim")
        self.assertTrue(all(name_rule_for(rule.source_name) is None
                            for rule in rules if rule.kind == "function"))
        self.assertTrue(all(not rule.source_name.split()[-1].isdigit()
                            for rule in rules if rule.kind == "room"))


if __name__ == "__main__":
    unittest.main()
