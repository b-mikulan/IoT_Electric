"""Offline regression checks; no switch, credentials or event loop required."""

import contextlib
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import pysnmp.hlapi.v3arch.asyncio as api
from pysnmp.proto.rfc1902 import Integer32, ObjectName, OctetString
from pysnmp.proto.rfc1905 import endOfMibView, noSuchObject

spec = importlib.util.spec_from_file_location("mac_table", Path(__file__).with_name("mac_table.py"))
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)

BRIDGE = "1.3.6.1.2.1.17.4.3.1"
QBRIDGE = "1.3.6.1.2.1.17.7.1.2.2.1"
MAC_INDEX = ".0.17.34.51.68.85"
MAC = "00:11:22:33:44:55"


def numeric(oid):
    return tuple(map(int, oid.split(".")))


def response(name, value, status=0):
    return None, Integer32(status), Integer32(1 if status else 0), [(ObjectName(name), value)]


def run_probe(rows=(), version="2c", limit=100, mode=None, diagnose=False, mac=None, fdb_id=None, get_mode=None):
    requests = []
    engine = MagicMock()

    async def next_cmd(*args, **kwargs):
        if mac is not None:
            raise AssertionError("Exact lookup must never use GETNEXT")
        current = args[4][0]
        requests.append(current)
        if mode == "repeat":
            return response(current, Integer32(7))
        if mode == "timeout":
            return "simulated timeout", Integer32(0), Integer32(0), []
        for name, value in sorted(rows, key=lambda row: numeric(row[0])):
            if numeric(name) > numeric(current):
                return response(name, value)
        if version == "1":
            return response(current, Integer32(0), 2)
        return response(current, endOfMibView)

    async def get_cmd(*args, **kwargs):
        current = args[4][0]
        requests.append(current)
        if current == "1.3.6.1.2.1.1.1.0":
            return response(current, OctetString("test switch"))
        if get_mode == "wrong_oid":
            return response("1.3.6.1.2.1.31.1.1.1.2.1", Integer32(7))
        if get_mode == "timeout":
            return "simulated GET timeout", Integer32(0), Integer32(0), []
        for name, value in rows:
            if name == current:
                return response(name, value)
        if version == "1":
            return response(current, Integer32(0), 2)
        return response(current, noSuchObject)

    options = SimpleNamespace(host="127.0.0.1", port=161, timeout=.1, retries=0,
                              version=version, max_rows=limit, diagnose=diagnose,
                              mac=mac, fdb_id=fdb_id)
    output = io.StringIO()
    with contextlib.ExitStack() as stack:
        for name, value in {
            "SnmpEngine": MagicMock(return_value=engine),
            "UdpTransportTarget": SimpleNamespace(create=AsyncMock(return_value=object())),
            "ObjectIdentity": lambda value: value,
            "ObjectType": lambda value: [value],
            "get_cmd": get_cmd,
            "next_cmd": next_cmd,
        }.items():
            stack.enter_context(patch.object(api, name, value))
        stack.enter_context(contextlib.redirect_stdout(output))
        stack.enter_context(contextlib.redirect_stderr(output))
        # All awaited I/O is replaced by immediately completing async stubs.
        # Driving once also ensures the checks cannot accidentally open sockets.
        coroutine = tool.probe(options, "test-only")
        try:
            coroutine.send(None)
        except StopIteration as completed:
            code = completed.value
        else:
            coroutine.close()
            raise AssertionError("Unexpected asynchronous I/O")
    engine.close_dispatcher.assert_called_once()
    return code, output.getvalue(), requests


class MacTableTests(unittest.TestCase):
    def test_bridge_ports_status_and_interface_joined_without_duplicate_count(self):
        code, output, requests = run_probe([
            (BRIDGE + ".1" + MAC_INDEX, OctetString(bytes.fromhex("001122334455"))),
            (BRIDGE + ".2" + MAC_INDEX, Integer32(7)),
            (BRIDGE + ".3" + MAC_INDEX, Integer32(3)),
            ("1.3.6.1.2.1.17.1.4.1.2.7", Integer32(107)),
            ("1.3.6.1.2.1.2.2.1.2.107", OctetString("Ethernet7")),
        ])
        self.assertEqual(code, 0)
        self.assertIn(f"MAC={MAC}  bridge_port=7  ifIndex=107  interface='Ethernet7'  status=learned(3)", output)
        self.assertIn("MAC rows returned: 1", output)
        self.assertIn("Confirmed learned rows: 1", output)
        self.assertIn(BRIDGE + ".2", requests)
        self.assertIn(BRIDGE + ".3", requests)

    def test_qbridge_preserves_fdb_id_and_status(self):
        code, output, _ = run_probe([
            (QBRIDGE + ".2.4096" + MAC_INDEX, Integer32(7)),
            (QBRIDGE + ".3.4096" + MAC_INDEX, Integer32(5)),
        ])
        self.assertEqual(code, 0)
        self.assertIn(f"QBRIDGE  FDB ID=4096  MAC={MAC}", output)
        self.assertIn("status=mgmt(5)", output)
        self.assertIn("MAC rows returned: 1", output)

    def test_invalid_and_self_entries_not_reported_as_learned(self):
        for status in (2, 4):
            with self.subTest(status=status):
                code, output, _ = run_probe([(BRIDGE + ".3" + MAC_INDEX, Integer32(status))])
                self.assertEqual(code, 0)
                self.assertIn(f"status={tool.FDB_STATUS[status]}({status})", output)
                self.assertIn("Confirmed learned rows: 0", output)

    def test_missing_status_and_mapping_remain_unknown(self):
        code, output, _ = run_probe([(BRIDGE + ".2" + MAC_INDEX, Integer32(7))])
        self.assertEqual(code, 0)
        self.assertIn("bridge_port=7  ifIndex=unknown  interface='unknown'  status=unknown (not returned)", output)

    def test_zero_port_never_mapped_to_interface(self):
        code, output, _ = run_probe([(QBRIDGE + ".2.1" + MAC_INDEX, Integer32(0))])
        self.assertEqual(code, 0)
        self.assertIn("bridge_port=0 (not learned)  ifIndex=unknown", output)

    def test_same_mac_in_different_fdbs_is_preserved(self):
        code, output, _ = run_probe([
            (QBRIDGE + ".2.1" + MAC_INDEX, Integer32(7)),
            (QBRIDGE + ".2.2" + MAC_INDEX, Integer32(8)),
        ])
        self.assertEqual(code, 0)
        self.assertIn("MAC rows returned: 2", output)
        self.assertIn("FDB ID=1", output)
        self.assertIn("FDB ID=2", output)

    def test_subtree_boundary_not_counted_as_mac(self):
        code, output, _ = run_probe([("1.3.6.1.2.1.99.1", Integer32(7))])
        self.assertEqual(code, 1)
        self.assertIn("GETNEXT left subtree", output)
        self.assertIn("MAC rows returned: 0", output)

    def test_v2_end_exception(self):
        code, output, _ = run_probe()
        self.assertEqual(code, 1)
        self.assertIn("GETNEXT returned an SNMP exception", output)

    def test_v1_no_such_name(self):
        code, output, _ = run_probe(version="1")
        self.assertEqual(code, 1)
        self.assertIn("SNMP v1 noSuchName", output)

    def test_nonincreasing_oid_rejected(self):
        code, output, _ = run_probe(mode="repeat")
        self.assertEqual(code, 1)
        self.assertIn("Non-increasing OID", output)

    def test_timeout_reported(self):
        code, output, _ = run_probe(mode="timeout")
        self.assertEqual(code, 1)
        self.assertIn("simulated timeout", output)

    def test_partial_table_has_distinct_exit_status(self):
        code, output, _ = run_probe([
            (QBRIDGE + ".2.1" + MAC_INDEX, Integer32(7)),
            (QBRIDGE + ".2.2" + MAC_INDEX, Integer32(8)),
        ], limit=1)
        self.assertEqual(code, 2)
        self.assertIn("output is incomplete", output)
        self.assertIn("MAC rows returned: 1", output)

    def test_exact_limit_is_complete(self):
        code, output, _ = run_probe([(QBRIDGE + ".2.1" + MAC_INDEX, Integer32(7))], limit=1)
        self.assertEqual(code, 0)
        self.assertNotIn("output is incomplete", output)

    def test_bad_mac_index_not_counted(self):
        code, output, _ = run_probe([(BRIDGE + ".2.0.17.34.51.68.256", Integer32(7))])
        self.assertEqual(code, 1)
        self.assertIn("Malformed FDB index", output)
        self.assertIn("MAC rows returned: 0", output)

    def test_invalid_port_not_counted(self):
        code, output, _ = run_probe([(BRIDGE + ".2" + MAC_INDEX, Integer32(-1))])
        self.assertEqual(code, 1)
        self.assertIn("Invalid bridge port", output)
        self.assertIn("MAC rows returned: 0", output)

    def test_diagnostic_limit_does_not_make_complete_mac_table_fail(self):
        code, output, _ = run_probe([(QBRIDGE + ".2.1" + MAC_INDEX, Integer32(7))], limit=1, diagnose=True)
        self.assertEqual(code, 0)
        self.assertIn("Diagnostic MIB-2 OIDs", output)

    def test_exact_bridge_get_works_when_walk_is_unavailable(self):
        code, output, requests = run_probe([
            (BRIDGE + ".2" + MAC_INDEX, Integer32(7)),
            (BRIDGE + ".3" + MAC_INDEX, Integer32(3)),
            ("1.3.6.1.2.1.17.1.4.1.2.7", Integer32(107)),
            ("1.3.6.1.2.1.2.2.1.2.107", OctetString("Ethernet7")),
        ], mac=tool.mac_address(MAC))
        self.assertEqual(code, 0)
        self.assertIn(f"MAC={MAC}  bridge_port=7  ifIndex=107  interface='Ethernet7'  status=learned(3)", output)
        self.assertIn(BRIDGE + ".2" + MAC_INDEX, requests)
        self.assertNotIn("GETNEXT request", output)
        self.assertIn("Q-BRIDGE lookup skipped", output)

    def test_exact_qbridge_get_includes_supplied_fdb_id(self):
        code, output, requests = run_probe([
            (QBRIDGE + ".2.4096" + MAC_INDEX, Integer32(8)),
            (QBRIDGE + ".3.4096" + MAC_INDEX, Integer32(3)),
        ], mac=tool.mac_address(MAC), fdb_id=4096)
        self.assertEqual(code, 0)
        self.assertIn(QBRIDGE + ".2.4096" + MAC_INDEX, requests)
        self.assertIn(f"QBRIDGE  FDB ID=4096  MAC={MAC}  bridge_port=8", output)
        self.assertIn("MAC rows returned: 1", output)

    def test_exact_lookup_does_not_count_exception_values(self):
        code, output, _ = run_probe(mac=tool.mac_address(MAC))
        self.assertEqual(code, 1)
        self.assertIn("Exact instance not accessible", output)
        self.assertIn("MAC rows returned: 0", output)

    def test_exact_v1_no_such_name_continues_other_queries(self):
        code, output, requests = run_probe([
            (BRIDGE + ".2" + MAC_INDEX, Integer32(7)),
        ], mac=tool.mac_address(MAC), version="1")
        self.assertEqual(code, 0)
        self.assertIn("SNMP v1 noSuchName", output)
        self.assertIn(BRIDGE + ".3" + MAC_INDEX, requests)
        self.assertIn("bridge_port=7", output)

    def test_exact_get_wrong_oid_is_rejected(self):
        code, output, _ = run_probe(mac=tool.mac_address(MAC), get_mode="wrong_oid")
        self.assertEqual(code, 1)
        self.assertIn("GET returned a different OID", output)
        self.assertIn("MAC rows returned: 0", output)

    def test_exact_get_transport_error_is_reported(self):
        code, output, _ = run_probe(mac=tool.mac_address(MAC), get_mode="timeout")
        self.assertEqual(code, 1)
        self.assertIn("simulated GET timeout", output)

    def test_exact_diagnose_does_not_walk_subtrees(self):
        code, output, _ = run_probe([
            (BRIDGE + ".2" + MAC_INDEX, Integer32(7)),
        ], mac=tool.mac_address(MAC), diagnose=True)
        self.assertEqual(code, 0)
        self.assertIn("subtree walks skipped", output)
        self.assertNotIn("GETNEXT request", output)

    def test_mac_parser_formats(self):
        for text in (MAC, MAC.lower(), MAC.replace(":", "-"), MAC.replace(":", "")):
            with self.subTest(text=text):
                self.assertEqual(tool.mac_address(text), (0, 17, 34, 51, 68, 85))

    def test_invalid_mac_and_fdb_arguments_rejected(self):
        for args in (["--mac", "not-a-mac"], ["--mac", "00:11:22:33:4455"],
                     ["--fdb-id", "1"], ["--mac", MAC, "--fdb-id", "-1"],
                     ["--mac", MAC, "--fdb-id", "4294967296"]):
            with self.subTest(args=args), patch("sys.argv", ["mac_table.py"] + args), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                tool.arguments()
            self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
