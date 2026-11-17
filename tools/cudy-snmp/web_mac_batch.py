"""Sequential Cudy web MAC-table collection from an ip,password CSV."""

from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass, field
from datetime import datetime, timezone
import math
from pathlib import Path
import sys
from uuid import uuid4

from web_mac_table import CudyWebClient, ProbeError, normalize_url, read_mac_table


@dataclass(frozen=True)
class Switch:
    name: str
    url: str
    password: str = field(repr=False)


def load_switches(path: Path) -> list[Switch]:
    """Validate the whole input before contacting any switch. Never echo cells."""
    with path.open(encoding="utf-8-sig", newline="") as source:
        sample = source.read(8192)
        source.seek(0)
        # Excel exports may use semicolons; choose from the header, not passwords.
        header = sample.splitlines()[0] if sample else ""
        delimiter = ";" if header.count(";") > header.count(",") else ","
        reader = csv.DictReader(source, delimiter=delimiter, strict=True)
        fields = [v.strip().lower() for v in (reader.fieldnames or [])]
        if (len(fields) != len(set(fields)) or not {"ip", "password"} <= set(fields)
                or set(fields) - {"ip", "password", "name"}):
            raise ProbeError("CSV needs ip,password headers and optionally name; no other columns.")
        reader.fieldnames = fields
        switches = []
        seen = set()
        for record in reader:
            if None in record or any(record.get(key) is None for key in fields):
                raise ProbeError(f"CSV line {reader.line_num}: incorrect column count.")
            ip = record["ip"].strip()
            password = record["password"]  # Preserve intentional leading/trailing spaces.
            if not ip or not password:
                raise ProbeError(f"CSV line {reader.line_num}: IP and password are required.")
            try:
                url = normalize_url(ip)
            except ProbeError:
                raise ProbeError(f"CSV line {reader.line_num}: invalid IP/URL.") from None
            if url.lower() in seen:
                raise ProbeError(f"CSV line {reader.line_num}: duplicate switch URL.")
            seen.add(url.lower())
            name = record.get("name", "").strip() or f"switch-{len(switches) + 1}"
            if any(ord(char) < 32 or ord(char) == 127 for char in name):
                raise ProbeError(f"CSV line {reader.line_num}: invalid switch name.")
            switches.append(Switch(name, url, password))
    if not switches:
        raise ProbeError("CSV contains no switches.")
    return switches


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def csv_cell(value):
    # Keep user-supplied labels from becoming formulas when opened in Excel.
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def collect(switches: list[Switch], output: Path, *, timeout=5, max_pages=128,
            client_factory=CudyWebClient, table_reader=read_mac_table, progress=print) -> int:
    """A fresh directory per run; flush each completed device before continuing."""
    output.mkdir(parents=True, exist_ok=False)
    mac_fields = ["switch_name", "switch_url", "started_at_utc", "finished_at_utc",
                  "vlan", "mac", "ports", "aging_seconds"]
    status_fields = ["switch_name", "switch_url", "started_at_utc", "finished_at_utc",
                     "status", "mac_count", "error"]
    failures = 0
    with (output / "mac_table.csv").open("x", encoding="utf-8-sig", newline="") as mac_file, \
            (output / "summary.csv").open("x", encoding="utf-8-sig", newline="") as status_file:
        mac_writer = csv.writer(mac_file)
        status_writer = csv.writer(status_file)
        mac_writer.writerow(mac_fields)
        status_writer.writerow(status_fields)
        mac_file.flush()
        status_file.flush()
        for index, switch in enumerate(switches, 1):
            # Do not log input cells: even a malformed CSV could put a secret in a name.
            progress(f"[{index}/{len(switches)}] Reading switch...")
            started = utc_now()
            status, error, rows = "ok", "", []
            interrupted = False
            try:
                client = client_factory(switch.url, timeout=timeout)
                client.login(switch.password)
                rows = table_reader(client, max_pages=max_pages)
            except KeyboardInterrupt:
                status, error, interrupted = "interrupted", "Collection interrupted by user.", True
            except ProbeError as exc:
                status, error = "error", str(exc)
            except Exception:
                # Never serialize raw exception details, HTTP bodies or credentials.
                status, error = "error", "Unexpected device read error. No complete table confirmed."
            if status != "ok":
                failures += 1
                # Defensive redaction even if a future reader includes secrets in an error.
                for secret in (item.password for item in switches):
                    error = error.replace(secret, "[redacted]")
            finished = utc_now()
            common = [csv_cell(switch.name), switch.url, started, finished]
            if status == "ok":
                for row in rows:
                    mac_writer.writerow(common + [row.vlan, row.mac,
                                                   ",".join(map(str, row.ports)), row.aging_seconds])
            mac_file.flush()
            status_writer.writerow(common + [status, len(rows) if status == "ok" else "", error])
            status_file.flush()
            progress(f"[{index}/{len(switches)}] {status}: "
                     + (f"{len(rows)} MAC rows." if status == "ok" else "See summary.csv."))
            if interrupted:
                return 130
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_file", nargs="?", type=Path, help="CSV with ip,password[,name]")
    parser.add_argument("--output", type=Path, default=Path("output/cudy-mac"),
                        help="Parent output folder (a new run subfolder is created)")
    parser.add_argument("--timeout", type=float, default=5)
    parser.add_argument("--max-pages", type=int, default=128)
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0 or args.max_pages <= 0:
        parser.error("timeout and max-pages must be positive finite values")
    try:
        path = args.csv_file or Path(input("Switches CSV path: ").strip().strip('"'))
        switches = load_switches(path)
        run_name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8]
        output = args.output / run_name
        print(f"Loaded {len(switches)} switches. Output: {output.resolve()}")
        result = collect(switches, output, timeout=args.timeout, max_pages=args.max_pages)
        print(f"Results: {output.resolve()}")
        return result
    except ProbeError as exc:
        print(f"Batch failed: {exc}", file=sys.stderr)
        return 1
    except (OSError, UnicodeError, csv.Error):
        print("Batch failed: cannot read CSV or write results. Check paths, encoding, "
              "CSV quoting and file permissions.", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled. Earlier saved device results remain available.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
