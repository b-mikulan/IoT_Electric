"""Offline tests. All credentials and MAC addresses below are synthetic."""

from email.message import Message
from io import BytesIO, StringIO
from contextlib import redirect_stdout
import unittest
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPHandler, HTTPCookieProcessor, ProxyHandler, build_opener
from urllib.response import addinfourl

from web_mac_table import (
    CudyWebClient, MAC_PAGE, NoRedirect, ProbeError, TableConfig,
    normalize_url, parse_batch, parse_config, print_table, read_mac_table,
)


CONFIG_HTML = """
<script>var _trunk_info=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];</script>
<script>var portinfo_ds={portnum:16,maxhostnum:100,maxhostnums:[]}</script>
<script>var dynamiccfg={maxshownums:64,perrequests:16,};</script>
"""
CONFIG = TableConfig(16, 64, 16)
FIRST = "/freshdynamicmac.cgi?firstreq=1&times=4"
NEXT = "/freshdynamicmac.cgi?firstreq=0&times=4"
POLL = "/dynamicmacentry.xml"


def batch(state, start=0, count=0):
    records = [f"1,{n + 1:012x},0x8,300;" for n in range(start, start + count)]
    return f"{state};{count};" + "".join(records)


class ScriptedClient:
    def __init__(self, steps):
        self.steps = [(MAC_PAGE, CONFIG_HTML), *steps]

    def request(self, path):
        if not self.steps:
            raise AssertionError("Unexpected additional request")
        expected, response = self.steps.pop(0)
        if path != expected:
            raise AssertionError(f"Expected {expected}, got {path}")
        if isinstance(response, Exception):
            raise response
        return response


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now

    def sleep(self, duration):
        self.now += duration


class RecordedHTTP(HTTPHandler):
    """Exercises urllib encoding, cookie handling and errors without a socket."""

    def __init__(self, replies):
        super().__init__()
        self.replies = list(replies)
        self.requests = []

    def http_open(self, req):
        self.requests.append(req)
        status, text, header_values = self.replies.pop(0)
        headers = Message()
        for key, value in header_values.items():
            headers[key] = value
        response = addinfourl(BytesIO(text.encode()), headers, req.full_url, status)
        response.msg = "Test response"
        return response


def http_client(replies):
    client = CudyWebClient("http://switch.test")
    handler = RecordedHTTP(replies)
    client.opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(client.cookies),
                                NoRedirect(), handler)
    return client, handler


class UrlAndLoginTests(unittest.TestCase):
    def test_url_accepts_ip_or_pasted_page(self):
        self.assertEqual(normalize_url("10.0.0.1"), "http://10.0.0.1")
        self.assertEqual(normalize_url("https://switch.test:8443/homepage.html?x=1#tab"),
                         "https://switch.test:8443")

    def test_rejects_credentials_or_invalid_url(self):
        for url in ("http://user:secret@switch.test", "file:///etc/passwd", "http://",
                    "http://switch.test:bad", "http://switch.test:0", "http://a\nb"):
            with self.subTest(url=url), self.assertRaises(ProbeError):
                normalize_url(url)

    def test_login_encodes_password_and_reuses_cookie(self):
        client, handler = http_client([
            (200, "<html>Login</html>", {}),
            (200, "<script>var allow = 1;</script>", {"Set-Cookie": "Cookies=synthetic-session"}),
            (200, "<html>Homepage</html>", {}),
            (200, CONFIG_HTML, {}),
        ])
        password = "synthetic +&= password"
        client.login(password)
        client.request(MAC_PAGE)
        posted = handler.requests[1]
        self.assertEqual(posted.get_method(), "POST")
        self.assertEqual(parse_qs(posted.data.decode()),
                         {"username": ["admin"], "password": [password], "logon": ["Login"]})
        self.assertEqual(urlsplit(posted.full_url).path, "/logon.cgi")
        for request in handler.requests[2:]:
            self.assertEqual(request.get_header("Cookie"), "Cookies=synthetic-session")
            self.assertIsNone(request.data)
        self.assertFalse(handler.replies)

    def test_http_200_alone_is_not_login_success(self):
        for body, headers in [
            ("<script>var allow = 0;</script>", {"Set-Cookie": "Cookies=synthetic-session"}),
            ("<script>var allow = 1;</script>", {}),
            ("<html>Login again</html>", {}),
        ]:
            client, handler = http_client([(200, "index", {}), (200, body, headers)])
            with self.subTest(body=body), self.assertRaisesRegex(ProbeError, "Login was not confirmed"):
                client.login("synthetic")
            self.assertEqual(len(handler.requests), 2)

    def test_refuses_redirect_and_does_not_echo_body(self):
        client, handler = http_client([
            (302, "private body", {"Location": "http://elsewhere.test"}),
        ])
        with self.assertRaisesRegex(ProbeError, "HTTP 302") as caught:
            client.request("/index.html")
        self.assertNotIn("private body", str(caught.exception))
        self.assertEqual(len(handler.requests), 1)

    def test_oversize_response_is_rejected(self):
        client, _ = http_client([(200, "a" * 1_048_577, {})])
        with self.assertRaisesRegex(ProbeError, "large HTTP response"):
            client.request("/index.html")


class ParserTests(unittest.TestCase):
    def test_config_from_page(self):
        self.assertEqual(parse_config(CONFIG_HTML), CONFIG)

    def test_unsupported_page_or_trunks_fail(self):
        for html in ("<html>Login</html>", CONFIG_HTML.replace("[0,0,0", "[1,0,0"),
                     CONFIG_HTML.replace("perrequests:16", "perrequests:0")):
            with self.subTest(html=html), self.assertRaises(ProbeError):
                parse_config(html)

    def test_one_based_dynamic_port_bits(self):
        for mask, ports in (("0x8", (3,)), ("0x10000", (16,)), ("0x2", (1,)), ("0xa", (1, 3))):
            with self.subTest(mask=mask):
                result = parse_batch(f"7;1;1,aabbccddeeff,{mask},300;", CONFIG)
                self.assertEqual(result.entries[0].ports, ports)
                self.assertEqual(result.entries[0].mac, "AA:BB:CC:DD:EE:FF")

    def test_malformed_responses_fail(self):
        for body in ("<html>Login</html>", "7;2;1,aabbccddeeff,0x8,300;",
                     "7;1;1,not-a-mac,0x8,300;", "7;1;1,aabbccddeeff,0x1,300;",
                     "7;1;1,aabbccddeeff,0x20000,300;", "7;1;4095,aabbccddeeff,0x8,300;",
                     "7;1;1,aabbccddeeff,0x8,-1;", "128;1;1,aabbccddeeff,0x8,300;",
                     "99;0;", "7;-1;", "7;1;1,aabbccddeeff,0x8;", "7;0;unexpected"):
            with self.subTest(body=body), self.assertRaises(ProbeError):
                parse_batch(body, CONFIG)


class WalkTests(unittest.TestCase):
    def run_walk(self, steps, **options):
        client = ScriptedClient(steps)
        clock = Clock()
        result = read_mac_table(client, clock=clock, sleep=clock.sleep, **options)
        self.assertFalse(client.steps, "Not all expected requests were made")
        return result

    def test_complete_490_row_walk(self):
        steps = []
        offset = 0
        for page in range(8):
            steps.append((FIRST if page == 0 else NEXT, "1;0; ;"))
            count = min(64, 490 - offset)
            while count:
                size = min(16, count)
                state = 7 if offset + size == 490 else 6
                steps.append((POLL, batch(state, offset, size)))
                count -= size
                offset += size
        result = self.run_walk(steps)
        self.assertEqual(len(result), 490)

    def test_start_response_can_contain_data(self):
        result = self.run_walk([(FIRST, batch(5, 0, 1))])
        self.assertEqual(len(result), 1)

    def test_terminal_empty_response_stops(self):
        for state in (5, 7):
            with self.subTest(state=state):
                self.assertEqual(self.run_walk([(FIRST, f"{state};0; ;")]), [])

    def test_full_last_page_does_not_request_an_extra_page(self):
        steps = [(FIRST, batch(4, 0, 16))]
        steps += [(POLL, batch(6, 16, 16)), (POLL, batch(6, 32, 16)), (POLL, batch(7, 48, 16))]
        self.assertEqual(len(self.run_walk(steps)), 64)

    def test_empty_end_after_full_page(self):
        steps = [(FIRST, batch(4, 0, 16))]
        steps += [(POLL, batch(6, n, 16)) for n in (16, 32, 48)]
        steps += [(NEXT, "7;0;")]
        self.assertEqual(len(self.run_walk(steps)), 64)

    def test_wait_states_and_128_do_not_mean_empty_table(self):
        messages = []
        steps = [(FIRST, "0;0;"), (POLL, "1;0;"), (POLL, "2;0;"),
                 (POLL, "128;0;"), (POLL, batch(7, 0, 1))]
        self.assertEqual(len(self.run_walk(steps, progress=messages.append)), 1)
        self.assertTrue(any("128" in message for message in messages))

    def test_waiting_has_a_deadline(self):
        for state in (2, 128):
            with self.subTest(state=state), self.assertRaisesRegex(ProbeError, "timed out"):
                self.run_walk([(FIRST, f"{state};0;")], page_timeout=0.1, poll_interval=0.1)

    def test_page_limit_is_not_success(self):
        steps = [(FIRST, batch(4, 0, 16))]
        steps += [(POLL, batch(6, n, 16)) for n in (16, 32, 48)]
        with self.assertRaisesRegex(ProbeError, "Page limit"):
            self.run_walk(steps, max_pages=1)

    def test_duplicate_rows_are_not_silently_counted(self):
        with self.assertRaisesRegex(ProbeError, "Repeated VLAN/MAC"):
            self.run_walk([(FIRST, batch(4, 0, 1)), (POLL, batch(7, 0, 1))])

    def test_failure_mid_walk_is_not_retried(self):
        with self.assertRaisesRegex(ProbeError, "connection failed"):
            self.run_walk([(FIRST, batch(4, 0, 1)), (POLL, ProbeError("connection failed"))])

    def test_expired_session_is_not_an_empty_table(self):
        with self.assertRaisesRegex(ProbeError, "session expiry"):
            self.run_walk([(FIRST, "<html>Login again</html>")])

    def test_output_has_port_mac_vlan_and_age(self):
        rows = self.run_walk([(FIRST, batch(7, 0, 1))])
        output = StringIO()
        with redirect_stdout(output):
            print_table(rows)
        self.assertIn("00:00:00:00:00:01", output.getvalue())
        self.assertIn("300", output.getvalue())
        self.assertIn("Rows per port: 3=1", output.getvalue())


if __name__ == "__main__":
    unittest.main()
