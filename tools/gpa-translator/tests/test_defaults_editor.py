from pathlib import Path
import tempfile
import tkinter as tk
import unittest
from unittest.mock import patch

from gpa_translator.defaults import DefaultRule, load_defaults, save_defaults
from gpa_translator.defaults_editor import DefaultsEditor


class DefaultsEditorTests(unittest.TestCase):
    def setUp(self):
        try:
            self.root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f"Tk GUI nije dostupan: {error}")
        self.root.withdraw()
        self.addCleanup(self.root.destroy)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "defaults.hr.json"
        self.saved = []
        self.errors = patch("gpa_translator.defaults_editor.messagebox.showerror").start()
        self.addCleanup(patch.stopall)

    def editor(self, rules=None):
        if rules is not None:
            save_defaults(self.path, rules)
        self.widget = DefaultsEditor(self.root, self.path, self.saved.append)
        self.widget.pack(fill="both", expand=True)
        self.root.update()
        return self.widget

    def select(self, widget, index):
        widget.table.selection_set(str(index))
        widget._on_select()
        self.root.update()

    def test_save_applies_active_form_and_preserves_context_metadata(self):
        rule = DefaultRule("E1", "Vrata ulaz", icon_id="43", urn="door.type",
                           expected_room="Entrance", provenance="reference_project_pair")
        widget = self.editor([rule])
        self.select(widget, 0)
        widget.values["target_hr"].set("Ulazna vrata")
        self.assertTrue(widget.dirty)
        self.assertTrue(widget.save())
        expected = DefaultRule("E1", "Ulazna vrata", icon_id="43", urn="door.type",
                               expected_room="Entrance", provenance="reference_project_pair")
        self.assertEqual(load_defaults(self.path), [expected])
        self.assertEqual(self.saved, [[expected]])
        self.assertFalse(widget.dirty)
        self.assertEqual(widget.dirty_label.get(), "")

    def test_new_file_and_filter_do_not_drop_a_draft(self):
        widget = self.editor()
        widget.values["source_name"].set("Living room")
        widget.values["target_hr"].set("Boravak")
        widget.values["kind"].set("room")
        self.assertTrue(widget.save())
        self.assertEqual(load_defaults(self.path), [DefaultRule("Living room", "Boravak", "room")])
        widget.values["target_hr"].set("Dnevni boravak")
        widget.search.set("not present")
        self.root.update()
        self.assertEqual(widget.table.get_children(), ())
        self.assertEqual(widget.values["target_hr"].get(), "Dnevni boravak")
        self.assertTrue(widget.dirty)
        self.assertTrue(widget.save())
        self.assertEqual(load_defaults(self.path)[0].target_hr, "Dnevni boravak")

    def test_conflicting_add_and_invalid_update_do_not_change_rules(self):
        initial = DefaultRule("E1", "Vrata")
        widget = self.editor([initial])
        widget.values["source_name"].set("E1")
        widget.values["target_hr"].set("Drugo ime")
        self.assertFalse(widget.add_rule())
        self.assertEqual(widget.rules, [initial])
        widget.clear_form()
        self.select(widget, 0)
        widget.values["icon_id"].set("bad/id")
        self.assertFalse(widget.save())
        self.assertEqual(load_defaults(self.path), [initial])
        self.assertEqual(self.saved, [])
        self.assertTrue(widget.dirty)

    def test_selecting_another_rule_keeps_unsaved_form(self):
        widget = self.editor([DefaultRule("E1", "Vrata"), DefaultRule("E2", "Druga vrata")])
        self.select(widget, 0)
        widget.values["target_hr"].set("Ulazna vrata")
        self.select(widget, 1)
        self.assertEqual(widget._selected_index, 0)
        self.assertEqual(widget.values["target_hr"].get(), "Ulazna vrata")
        self.assertTrue(widget.update_rule())
        self.select(widget, 1)
        self.assertEqual(widget._selected_index, 1)

    def test_corrupt_and_externally_changed_files_are_never_overwritten(self):
        self.path.write_text("{broken", encoding="utf-8")
        widget = self.editor()
        self.assertIn("Rječnik nije učitan", widget.status.get())
        self.assertFalse(widget.save())
        self.assertEqual(self.path.read_text(encoding="utf-8"), "{broken")
        self.path.unlink()
        self.assertTrue(widget.reload())
        widget.values["source_name"].set("E1")
        widget.values["target_hr"].set("Vrata")
        external = [DefaultRule("E2", "Druga vrata")]
        save_defaults(self.path, external)
        self.assertFalse(widget.save())
        self.assertEqual(load_defaults(self.path), external)
        self.assertEqual(self.saved, [])

    def test_reload_requires_discard_choice_and_delete_is_pending_until_save(self):
        initial = [DefaultRule("E1", "Vrata")]
        widget = self.editor(initial)
        self.select(widget, 0)
        self.assertTrue(widget.delete_rule())
        self.assertTrue(widget.dirty)
        self.assertEqual(load_defaults(self.path), initial)
        with patch("gpa_translator.defaults_editor.messagebox.askyesno", return_value=False):
            self.assertFalse(widget.reload())
            self.assertEqual(widget.rules, [])
        with patch("gpa_translator.defaults_editor.messagebox.askyesno", return_value=True):
            self.assertTrue(widget.reload())
        self.assertEqual(widget.rules, initial)
        self.assertFalse(widget.dirty)


if __name__ == "__main__":
    unittest.main()
