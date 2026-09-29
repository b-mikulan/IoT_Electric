import json
from pathlib import Path
import tempfile
import tkinter as tk
import unittest
from unittest.mock import patch

from gpa_translator.icon_images import IconImages, icon_cache_ready, prepare_icon_cache, proposal_uses_icon
from .test_review import session


class IconTests(unittest.TestCase):
    def test_only_icon_based_proposals_show_icons(self):
        review = session()
        self.assertFalse(proposal_uses_icon(review.by_id["r"], review))
        self.assertFalse(proposal_uses_icon(review.by_id["u"], review))
        self.assertTrue(proposal_uses_icon(review.by_id["e"], review))
        review.set_name("e", "Glavna vrata")
        self.assertTrue(proposal_uses_icon(review.by_id["e"], review))
        review.by_id["t"].old = "S1"
        self.assertFalse(proposal_uses_icon(review.by_id["t"], review))

    def test_manual_name_without_initial_icon_proposal_does_not_claim_icon(self):
        review = session()
        review.by_id["t"].new = None
        review.set_name("t", "Ručni naziv")
        self.assertFalse(proposal_uses_icon(review.by_id["t"], review))

    def test_partial_cache_is_not_ready_and_complete_cache_needs_no_export(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory / "catalog.json").write_text(json.dumps({"icons": {"14": "Temperature"}}))
            self.assertFalse(icon_cache_ready(directory))
            (directory / "14.png").write_bytes(b"test placeholder")
            with patch("gpa_translator.icon_images.subprocess.run") as export:
                self.assertTrue(prepare_icon_cache(directory))
                export.assert_not_called()

    def test_missing_installation_is_nonfatal(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict("os.environ", {"ProgramFiles(x86)": folder}), patch("gpa_translator.icon_images.subprocess.run") as export:
                self.assertFalse(prepare_icon_cache(Path(folder) / "icons"))
                export.assert_not_called()

    def test_png_resize_reference_lifetime_and_missing_image(self):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(str(error))
        root.withdraw()
        try:
            with tempfile.TemporaryDirectory() as folder:
                directory = Path(folder)
                original = tk.PhotoImage(master=root, width=80, height=80)
                original.put("#123456", to=(0, 0, 80, 80))
                (directory / "14.png").write_bytes(root.tk.call(original.name, "data", "-format", "png"))
                cache = IconImages(root, directory)
                actual = cache.get("14")
                self.assertEqual((actual.width(), actual.height()), (40, 40))
                self.assertEqual(actual.get(20, 20), (18, 52, 86))
                self.assertIs(cache.get("14"), actual)
                self.assertIsNone(cache.get("5"))
                self.assertIsNone(cache.get("../14"))
                self.assertIsNone(cache.get(None))
        finally:
            root.destroy()


if __name__ == "__main__":
    unittest.main()
