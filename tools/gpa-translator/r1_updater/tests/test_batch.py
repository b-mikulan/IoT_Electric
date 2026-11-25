from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from r1_updater import update_r1


class BatchTests(unittest.TestCase):
    def test_sorted_batch_continues_after_error_and_reads_password_once(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory)
            for name in ("C.gpa", "b.GPA", "a.gpa", "notes.txt"):
                (folder / name).touch()
            output = folder / "output"
            output.mkdir()
            (output / "nested.gpa").touch()
            argv = ["update_r1.py", str(folder), "--set-user-password", "--set-installer-password",
                    "--output", str(output)]
            stdin = StringIO("sample-only\ninstaller-sample\nunused\n")
            with (patch.object(sys, "argv", argv), patch.object(sys, "stdin", stdin),
                  patch.object(update_r1, "process_project", side_effect=[None, ValueError("invalid"), None]) as run,
                  redirect_stdout(StringIO()) as stdout, redirect_stderr(StringIO()) as stderr):
                self.assertEqual(update_r1.main(), 1)
            self.assertEqual([call.args for call in run.call_args_list],
                             [(folder / n, output / n, {"User": "sample-only", "Installer": "installer-sample"})
                              for n in ("a.gpa", "b.GPA", "C.gpa")])
            self.assertEqual(stdin.readline(), "unused\n")
            self.assertIn("b.GPA", stderr.getvalue())
            self.assertIn("uspješno: 2, greške: 1", stdout.getvalue())

    def test_blank_user_password_still_processes_project_with_installer_password(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "a.gpa"
            source.touch()
            argv = ["update_r1.py", str(source), "--set-installer-password", "--set-user-password"]
            with (patch.object(sys, "argv", argv), patch.object(sys, "stdin", StringIO("\ninstaller-sample\n")),
                  patch.object(update_r1, "process_project") as run, redirect_stdout(StringIO())):
                self.assertEqual(update_r1.main(), 0)
            run.assert_called_once_with(source, None, {"Installer": "installer-sample"})

    def test_existing_output_is_preserved(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory)
            output = folder / "results"
            output.mkdir()
            (folder / "a.gpa").touch()
            saved = output / "a.gpa"
            saved.write_bytes(b"existing")
            with (patch.object(sys, "argv", ["update_r1.py", str(folder), "--output", str(output)]),
                  redirect_stdout(StringIO()), redirect_stderr(StringIO()) as stderr):
                self.assertEqual(update_r1.main(), 1)
            self.assertIn("Izlaz već postoji", stderr.getvalue())
            self.assertEqual(saved.read_bytes(), b"existing")
