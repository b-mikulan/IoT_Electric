"""Batch validation, failure isolation and saved-result tests; no device access."""

import csv
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from web_mac_batch import Switch, collect, load_switches
from web_mac_table import MacEntry, ProbeError


class BatchTests(unittest.TestCase):
    def test_excel_semicolon_bom_password_and_optional_name(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            path.write_text('IP;Password;Name\n10.0.0.1;" a;b,+& ";R1\n', encoding="utf-8-sig")
            switch, = load_switches(path)
            self.assertEqual(switch.url, "http://10.0.0.1")
            self.assertEqual(switch.password, " a;b,+& ")
            self.assertNotIn(switch.password, repr(switch))
            self.assertEqual(switch.name, "R1")

    def test_two_required_columns_and_generated_name(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            path.write_text('ip,password\n10.0.0.1,"pw,with,commas"\n', encoding="utf-8")
            switch, = load_switches(path)
            self.assertEqual(switch.password, "pw,with,commas")
            self.assertEqual(switch.name, "switch-1")

    def test_invalid_input_rejected_without_echoing_cells(self):
        samples = ["ip,password\n,synthetic-secret\n", "ip,password\n10.0.0.1,\n",
                   "ip,password\n10.0.0.1,synthetic-secret,extra\n", "ip,password\n",
                   "ip,password\n10.0.0.1,synthetic-secret\nhttp://10.0.0.1,other\n",
                   "ip,password\nhttp://synthetic-secret@host,pw\n",
                   "ip,password,password\n10.0.0.1,pw,pw\n"]
        with TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            for sample in samples:
                path.write_text(sample, encoding="utf-8")
                with self.subTest(sample=sample), self.assertRaises(ProbeError) as caught:
                    load_switches(path)
                self.assertNotIn("synthetic-secret", str(caught.exception))

    def test_failure_between_successes_and_empty_table_is_distinct(self):
        switches = [Switch(f"R{n}", f"http://switch{n}.test", "synthetic-secret") for n in range(1, 4)]
        logins = []
        class Client:
            def __init__(self, url, timeout):
                self.url = url
            def login(self, password):
                logins.append((self.url, password))
        def read(client, **options):
            if "switch2" in client.url:
                raise ProbeError("synthetic-secret: login failed")
            if "switch3" in client.url:
                return []
            return [MacEntry(1, "00:11:22:33:44:55", (1, 3), 300)]
        with TemporaryDirectory() as directory:
            output = Path(directory) / "run"
            code = collect(switches, output, client_factory=Client, table_reader=read, progress=lambda _: None)
            self.assertEqual(code, 1)
            self.assertEqual(len(logins), 3)
            with (output / "summary.csv").open(encoding="utf-8-sig", newline="") as file:
                statuses = list(csv.DictReader(file))
            self.assertEqual([r['status'] for r in statuses], ["ok", "error", "ok"])
            self.assertEqual([r['mac_count'] for r in statuses], ["1", "", "0"])
            with (output / "mac_table.csv").open(encoding="utf-8-sig", newline="") as file:
                rows = list(csv.DictReader(file))
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['ports'], "1,3")
            for path in output.iterdir():
                self.assertNotIn("synthetic-secret", path.read_text(encoding="utf-8-sig"))

    def test_interrupt_preserves_first_device_and_records_current_device(self):
        class Client:
            def __init__(self, url, timeout):
                self.url = url
            def login(self, password):
                pass
        def read(client, **options):
            if "second" in client.url:
                raise KeyboardInterrupt
            return []
        with TemporaryDirectory() as directory:
            output = Path(directory) / "run"
            switches = [Switch("=unsafe-label", "http://first.test", "pw"),
                        Switch("second", "http://second.test", "pw"),
                        Switch("third", "http://third.test", "pw")]
            code = collect(switches, output, client_factory=Client, table_reader=read, progress=lambda _: None)
            self.assertEqual(code, 130)
            with (output / "summary.csv").open(encoding="utf-8-sig", newline="") as file:
                rows = list(csv.DictReader(file))
            self.assertEqual([r['status'] for r in rows], ["ok", "interrupted"])
            self.assertEqual(rows[0]['switch_name'], "'=unsafe-label")
            with self.assertRaises(FileExistsError):
                collect(switches, output, progress=lambda _: None)


if __name__ == "__main__":
    unittest.main()
