"""Read the Cudy web UI's dynamic MAC table, using only Python's standard library.

Protocol and port-mask mapping come from the GS1016E browser capture. This is
an undocumented web interface, not an SNMP reader or a general Cudy API client.
Passwords/cookies stay in memory. No configuration endpoints are called.
"""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
import getpass
from http.client import HTTPException
from http.cookiejar import CookieJar
import math
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import (
    HTTPRedirectHandler, HTTPCookieProcessor, ProxyHandler, Request, build_opener,
)
import warnings


DEFAULT_URL = "http://10.110.3.241"
MAC_PAGE = "/security_Maccfg.html"
DATA_STATES = {4, 5, 6, 7}
END_STATES = {5, 7}
WAIT_STATES = {0, 1, 2, 128}


class ProbeError(Exception):
    """A safe-to-display explanation; never include raw HTTP bodies or secrets."""


def normalize_url(value: str) -> str:
    value = value.strip() or DEFAULT_URL
    if any(ord(char) < 33 or ord(char) == 127 for char in value):
        raise ProbeError("URL must not contain spaces or control characters.")
    if "://" not in value:
        value = "http://" + value
    try:
        parts = urlsplit(value)
        port = parts.port
        if (parts.scheme not in ("http", "https") or not parts.hostname
                or parts.username is not None or parts.password is not None
                or "\\" in parts.netloc or port == 0):
            raise ValueError
    except ValueError:
        raise ProbeError("Enter an HTTP(S) switch URL without credentials.") from None
    # A pasted homepage.html URL is fine; the captured endpoints live at root.
    return f"{parts.scheme}://{parts.netloc}"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Login uses a JavaScript redirect. Refuse unexpected HTTP redirects,
        # including redirects to another host, instead of forwarding credentials.
        return None


class CudyWebClient:
    def __init__(self, url: str, timeout: float = 5):
        self.url = normalize_url(url)
        self.timeout = timeout
        self.cookies = CookieJar()
        self.opener = build_opener(
            ProxyHandler({}), HTTPCookieProcessor(self.cookies), NoRedirect(),
        )

    def request(self, path: str, form: dict[str, str] | None = None) -> str:
        headers = {
            "User-Agent": "CudyMacProbe/1.0",
            "Accept": "text/html,text/plain,*/*",
            "Cache-Control": "no-cache",
            "Referer": self.url + ("/index.html" if form else "/homepage.html"),
        }
        data = None
        if form is not None:
            data = urlencode(form).encode("utf-8")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            headers["Origin"] = self.url
        request = Request(self.url + path, data=data, headers=headers)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                payload = response.read(1_048_577)
        except HTTPError as exc:
            code = exc.code
            exc.close()
            raise ProbeError(
                f"HTTP {code}. Check the switch URL and login; redirects are not followed."
            ) from None
        except (URLError, OSError, HTTPException, ValueError):
            raise ProbeError(
                "HTTP connection failed or timed out. Check ZeroTier, the URL and "
                "HTTPS certificate (if using HTTPS). No automatic retry was made."
            ) from None
        if len(payload) > 1_048_576:
            raise ProbeError("Unexpectedly large HTTP response; stopping.")
        return payload.decode("utf-8-sig", errors="replace")

    def login(self, password: str) -> None:
        self.request("/index.html")
        body = self.request("/logon.cgi", {
            "username": "admin", "password": password, "logon": "Login",
        })
        allowed = re.search(r"\bvar\s+allow\s*=\s*1\s*;", body)
        if not allowed or not any(cookie.name == "Cookies" for cookie in self.cookies):
            raise ProbeError(
                "Login was not confirmed. Check the WEB password; the switch may "
                "also have reached its session limit, or use a different login format."
            )
        # The browser follows this JavaScript navigation after allow=1.
        self.request("/homepage.html")


@dataclass(frozen=True)
class TableConfig:
    port_count: int
    page_size: int
    batch_size: int


@dataclass(frozen=True)
class MacEntry:
    vlan: int
    mac: str
    ports: tuple[int, ...]
    aging_seconds: int


@dataclass(frozen=True)
class Batch:
    state: int
    entries: tuple[MacEntry, ...]


def parse_config(html: str) -> TableConfig:
    def field(variable: str, name: str) -> int:
        block = re.search(r"\bvar\s+" + variable + r"\s*=\s*\{([^}]*)\}", html)
        match = re.search(r"\b" + name + r"\s*:\s*(\d+)\b", block[1]) if block else None
        if not match:
            raise ProbeError("MAC page format not recognized, or login session expired.")
        return int(match[1])

    config = TableConfig(field("portinfo_ds", "portnum"),
                         field("dynamiccfg", "maxshownums"),
                         field("dynamiccfg", "perrequests"))
    if not (1 <= config.port_count <= 64
            and 1 <= config.batch_size <= config.page_size <= 4096
            and config.page_size % config.batch_size == 0):
        raise ProbeError("Unsupported MAC-table size or port configuration.")
    trunks = re.search(r"\bvar\s+_trunk_info\s*=\s*\[([\d,\s]*)\]", html)
    trunk_values = [int(v.strip()) for v in trunks[1].split(",") if v.strip()] if trunks else []
    if len(trunk_values) != config.port_count or any(trunk_values):
        raise ProbeError("Port/trunk mapping is unsupported; refusing to guess port numbers.")
    return config


def parse_batch(body: str, config: TableConfig) -> Batch:
    parts = body.strip().split(";")
    try:
        state, count = int(parts[0]), int(parts[1])
    except (ValueError, IndexError):
        raise ProbeError("Invalid MAC response (possibly a login page/session expiry).") from None
    records = [part.strip() for part in parts[2:] if part.strip()]
    if state not in DATA_STATES | WAIT_STATES:
        raise ProbeError(f"Unknown MAC response state {state}; stopping.")
    if not 0 <= count <= config.batch_size or len(records) != count:
        raise ProbeError("MAC response row count does not match its contents.")
    if state not in DATA_STATES and count:
        raise ProbeError("Unexpected MAC rows in a waiting/error response.")

    entries = []
    for record in records:
        columns = record.split(",")
        if len(columns) != 4:
            raise ProbeError("Invalid MAC row: expected VLAN, MAC, port mask, aging time.")
        vlan_text, mac, mask_text, age_text = (s.strip() for s in columns)
        if not re.fullmatch(r"[0-9a-fA-F]{12}", mac):
            raise ProbeError("Invalid MAC address in the response.")
        try:
            vlan, mask, age = int(vlan_text), int(mask_text, 16), int(age_text)
        except ValueError:
            raise ProbeError("Invalid numeric value in a MAC row.") from None
        # The dynamic table's JavaScript uses bit n for physical port n.
        # This differs from the zero-based masks in the static-MAC form.
        allowed_mask = ((1 << (config.port_count + 1)) - 1) & ~1
        if not 1 <= vlan <= 4094 or age < 0 or mask <= 0 or mask & ~allowed_mask:
            raise ProbeError("MAC row contains an unsupported VLAN, port mask or aging time.")
        ports = tuple(n for n in range(1, config.port_count + 1) if mask & (1 << n))
        entries.append(MacEntry(vlan, ":".join(mac[i:i + 2] for i in range(0, 12, 2)).upper(),
                                ports, age))
    return Batch(state, tuple(entries))


def read_mac_table(client, *, max_pages: int = 128, page_timeout: float = 30,
                   poll_interval: float = 0.1, progress=None,
                   clock=time.monotonic, sleep=time.sleep) -> list[MacEntry]:
    config = parse_config(client.request(MAC_PAGE))
    rows: list[MacEntry] = []
    seen: set[tuple[int, str]] = set()
    warned_128 = False
    times = config.page_size // config.batch_size
    for page in range(1, max_pages + 1):
        deadline = clock() + page_timeout
        page_rows = 0
        path = f"/freshdynamicmac.cgi?firstreq={int(page == 1)}&times={times}"
        while True:
            if clock() >= deadline:
                raise ProbeError(f"Page {page} timed out. Read incomplete; rerun the probe.")
            batch = parse_batch(client.request(path), config)
            if batch.state == 128 and not warned_128:
                if progress:
                    progress("Warning: switch returned state 128 (also seen in the capture); "
                             "waiting within the page timeout.")
                warned_128 = True
            for entry in batch.entries:
                key = (entry.vlan, entry.mac)
                if key in seen:
                    raise ProbeError("Repeated VLAN/MAC entry; the table may have changed "
                                     "or another reader interfered. Rerun the probe.")
                seen.add(key)
                rows.append(entry)
            page_rows += len(batch.entries)
            if page_rows > config.page_size:
                raise ProbeError("Page exceeded the advertised row count. Read incomplete.")
            if batch.state in END_STATES:
                if progress:
                    progress(f"Page {page}: {page_rows} rows; end of table.")
                return rows
            if page_rows == config.page_size:
                if progress:
                    progress(f"Page {page}: {page_rows} rows; total {len(rows)}.")
                break
            sleep(poll_interval)
            path = "/dynamicmacentry.xml"
    raise ProbeError(f"Page limit ({max_pages}) reached before end of table. Read incomplete.")


def print_table(rows: list[MacEntry]) -> None:
    print("\nVLAN  MAC address        Port(s)     Aging (s)")
    for row in sorted(rows, key=lambda entry: (entry.ports, entry.vlan, entry.mac)):
        ports = ",".join(map(str, row.ports))
        print(f"{row.vlan:<5} {row.mac:<18} {ports:<11} {row.aging_seconds}")
    print(f"\nCompleted: {len(rows)} unique VLAN/MAC entries in the dynamic table.")
    counts = Counter(port for row in rows for port in row.ports)
    if counts:
        print("Rows per port: " + ", ".join(f"{port}={count}" for port, count in sorted(counts.items())))
    else:
        print("The switch reported an empty dynamic table; this does not prove no devices are connected.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=5, help="HTTP timeout in seconds (default: 5)")
    parser.add_argument("--max-pages", type=int, default=128, help="Page safety limit (default: 128)")
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0 or args.max_pages <= 0:
        parser.error("timeout and max-pages must be positive finite values")
    try:
        url = normalize_url(input(f"Cudy URL [{DEFAULT_URL}]: "))
        with warnings.catch_warnings():
            # Refuse getpass's visible-input fallback when no terminal is available.
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = getpass.getpass("Cudy WEB password (admin): ")
        if not password:
            raise ProbeError("Web password cannot be empty.")
        print(f"Target: {url}, web user: admin; reading dynamic MAC table.")
        client = CudyWebClient(url, timeout=args.timeout)
        client.login(password)
        del password
        print("Login confirmed. Reading pages...")
        rows = read_mac_table(client, max_pages=args.max_pages, progress=print)
        print_table(rows)
        return 0
    except (ProbeError, getpass.GetPassWarning) as exc:
        message = str(exc) if isinstance(exc, ProbeError) else "Run in an interactive terminal for hidden password input."
        print(f"Probe failed: {message}", file=sys.stderr)
        print("No complete MAC table confirmed.", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled; no complete MAC table confirmed.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
