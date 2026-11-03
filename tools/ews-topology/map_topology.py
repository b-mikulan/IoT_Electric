#!/usr/bin/env python3
"""Read an EWS topology through the REST middleware; Python 3.10+, stdlib only."""

import argparse
import base64
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import closing, contextmanager
import csv
from datetime import datetime, timezone
import getpass
from http.client import HTTPException
import json
import math
import os
from pathlib import Path
import sqlite3
import ssl
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, HTTPSHandler

from pruning import catalog_reason, pruning_reasons


VERSION = 1
KINDS = {"containerItems": "container", "valueItems": "value", "historyItems": "history", "alarmItems": "alarm"}


def now():
    return datetime.now(timezone.utc).isoformat()


class RequestFailure(Exception):
    def __init__(self, message, fatal=False, transient=False):
        super().__init__(message)
        self.fatal = fatal
        self.transient = transient


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Do not forward middleware credentials to a redirected host.


class Client:
    def __init__(self, url, username, password, timeout=20, retries=0, delay=2, ca_file=None, attempt_log=None):
        self.url = url.rstrip("/")
        self.authorization = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
        self.timeout, self.retries, self.delay = timeout, retries, delay
        self.context = ssl.create_default_context(cafile=ca_file)
        self.stop = threading.Event()
        self.pacing_lock = threading.Lock()
        self.log_lock = threading.Lock()
        self.next_start = 0
        self.attempt_log = attempt_log

    def wait_turn(self):
        # One shared gate covers every worker and retry. With the default single
        # worker, the upstream gets at least --delay seconds idle between reads.
        with self.pacing_lock:
            if self.stop.wait(max(self.delay, self.next_start - time.monotonic())):
                raise RequestFailure("Scan stopped.")
            self.next_start = time.monotonic() + self.delay

    def get(self, path, authenticated=True, container_id=None):
        headers = {"Accept": "application/json"}
        if authenticated:
            headers["Authorization"] = self.authorization
        # Each worker owns its opener. TLS certificate verification stays enabled.
        opener = build_opener(NoRedirects(), HTTPSHandler(context=self.context))
        for attempt in range(self.retries + 1):
            if attempt and self.stop.wait(min(5 * 2 ** (attempt - 1), 60)):
                raise RequestFailure("Scan stopped.")
            self.wait_turn()
            started_at, started = now(), time.monotonic()
            status, failure = None, None
            try:
                with opener.open(Request(self.url + path, headers=headers), timeout=self.timeout) as response:
                    status = response.status
                    payload = json.load(response)
                if not isinstance(payload, dict):
                    raise RequestFailure("Middleware response must be a JSON object.")
                return payload
            except HTTPError as error:
                status = error.code
                error.close()
                failure = RequestFailure(
                    f"Middleware HTTP {status}: check MIDDLEWARE_USER and the plaintext password." if status in (401, 403) else f"Middleware HTTP {status}.",
                    fatal=status in (401, 403), transient=status in (408, 429, 500, 502, 503, 504))
            except (URLError, TimeoutError, OSError, HTTPException):
                failure = RequestFailure("Middleware connection failed or timed out (check URL, TLS and timeout).", transient=True)
            except (ValueError, UnicodeError):
                failure = RequestFailure("Middleware returned invalid JSON.")
            except RequestFailure as error:
                failure = error
            finally:
                if self.attempt_log is not None:
                    event = {"startedAt": started_at, "finishedAt": now(), "containerId": container_id,
                             "endpoint": "/api/containers" if container_id is not None else "/health",
                             "attempt": attempt + 1, "httpStatus": status,
                             "seconds": round(time.monotonic() - started, 3), "error": str(failure) if failure else None}
                    with self.log_lock, self.attempt_log.open("a", encoding="utf-8") as log:
                        log.write(json.dumps(event, ensure_ascii=False) + "\n")
            if failure.fatal or not failure.transient or attempt == self.retries:
                raise failure from None

    def page(self, container_id, token, metadata):
        query = {"id": container_id, "allPages": "false", "metadata": str(metadata).lower()}
        if token:
            query["moreDataRef"] = token  # Preserve exact whitespace/case in opaque cursors.
        started = time.monotonic()
        return self.get("/api/containers?" + urlencode(query), container_id=container_id), time.monotonic() - started


@contextmanager
def scan_lock(path):
    """OS releases the lock even after a crash; the small lock file may remain."""
    with open(str(path) + ".lock", "a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ValueError("Another mapper is using this checkpoint.") from None
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class Store:
    def __init__(self, path, settings=None, resume=False):
        exists = path.exists()
        if exists and not resume:
            raise ValueError("Checkpoint already exists. Use --resume or a different --output directory.")
        if not exists and resume:
            raise ValueError("Checkpoint does not exist; first run without --resume.")
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        try:
            self.initialize(exists, settings)
        except BaseException:
            self.db.close()
            raise

    def initialize(self, exists, settings):
        if not exists:
            self.db.executescript("""
                CREATE TABLE settings (data TEXT NOT NULL);
                CREATE TABLE containers (
                    id TEXT PRIMARY KEY, parent_id TEXT, name TEXT, state TEXT DEFAULT 'pending',
                    token TEXT DEFAULT '', issue TEXT DEFAULT '', last_error TEXT DEFAULT '', unknown INTEGER DEFAULT 0
                );
                CREATE INDEX queue ON containers(state);
                CREATE TABLE pages (
                    seq INTEGER PRIMARY KEY, container_id TEXT, request_token TEXT, data TEXT,
                    fetched_at TEXT, seconds REAL, UNIQUE(container_id, request_token)
                );
                CREATE TABLE items (kind TEXT, id TEXT, data TEXT, PRIMARY KEY(kind, id));
                CREATE TABLE links (parent_id TEXT, kind TEXT, id TEXT, PRIMARY KEY(parent_id, kind, id));
            """)
            with self.db:
                self.db.execute("INSERT INTO settings VALUES (?)", (json.dumps({**settings, "schemaVersion": VERSION, "startedAt": now()}),))
                self.add_container(settings["rootId"], None, settings["rootId"] or "EWS")
        self.settings = json.loads(self.db.execute("SELECT data FROM settings").fetchone()[0])
        if self.settings.get("schemaVersion") != VERSION:
            raise ValueError("Unsupported checkpoint version.")
        if settings and any(self.settings.get(key) != value for key, value in settings.items()):
            raise ValueError("Checkpoint URL, root ID or metadata setting differs. Use the original options or a new output directory.")
        columns = {row["name"] for row in self.db.execute("PRAGMA table_info(containers)")}
        with self.db:
            for column in ("prune_reason", "resume_state"):
                if column not in columns:
                    self.db.execute(f"ALTER TABLE containers ADD COLUMN {column} TEXT DEFAULT ''")
        self.profile = self.settings.get("discoveryProfile", "full")
        self.pruning_dirty = False

    def add_container(self, container_id, parent_id, name, metadata=None):
        self.db.execute("INSERT OR IGNORE INTO containers(id,parent_id,name) VALUES (?,?,?)", (container_id, parent_id, name))
        self.db.execute("INSERT OR IGNORE INTO items VALUES ('container',?,?)", (container_id, json.dumps({"id": container_id, "name": name}, ensure_ascii=False)))
        if getattr(self, "profile", "full") == "catalog":
            if metadata is None:
                metadata = json.loads(self.db.execute("SELECT data FROM items WHERE kind='container' AND id=?", (container_id,)).fetchone()[0])
            parent = self.db.execute("SELECT name,prune_reason FROM containers WHERE id=?", (parent_id,)).fetchone()
            reason = catalog_reason(container_id, name, metadata, self.settings["rootId"], parent["name"] if parent else None)
            if not reason and parent and parent["prune_reason"]:
                reason = f"Below excluded branch: {parent_id}"
            row = self.db.execute("SELECT state,prune_reason FROM containers WHERE id=?", (container_id,)).fetchone()
            if reason:
                self.db.execute("UPDATE containers SET resume_state=state,state='pruned',prune_reason=? WHERE id=? AND state IN ('pending','error')", (reason, container_id))
            elif row["state"] == "pruned":
                # An allowed alias was just discovered. Recompute reachability
                # after this page's atomic commit to reopen reachable descendants.
                self.pruning_dirty = True

    def pruning_plan(self, profile):
        rows = [dict(row) for row in self.db.execute("SELECT c.*,i.data FROM containers c LEFT JOIN items i ON i.kind='container' AND i.id=c.id")]
        for row in rows:
            row["metadata"] = json.loads(row.pop("data") or "{}")
        links = [dict(row) for row in self.db.execute("SELECT parent_id,id FROM links WHERE kind='container'")]
        reasons = pruning_reasons(rows, links, self.settings["rootId"]) if profile == "catalog" else {}
        pruned = [row["id"] for row in rows if row["id"] in reasons and row["state"] in ("pending", "error")]
        restored = [row["id"] for row in rows if row["id"] not in reasons and row["state"] == "pruned"]
        return {"profile": profile, "newlyPruned": len(pruned), "restored": len(restored), "prunedIds": pruned,
                "restoredIds": restored, "reasons": reasons, "rows": rows}

    def apply_profile(self, profile, plan=None):
        plan = plan if plan is not None else self.pruning_plan(profile)
        with self.db:
            for row in plan["rows"]:
                reason = plan["reasons"].get(row["id"], "")
                if reason and row["state"] in ("pending", "error"):
                    self.db.execute("UPDATE containers SET resume_state=state,state='pruned',prune_reason=? WHERE id=?", (reason, row["id"]))
                elif not reason and row["state"] == "pruned":
                    self.db.execute("UPDATE containers SET state=resume_state,resume_state='',prune_reason='' WHERE id=?", (row["id"],))
                elif row["prune_reason"] != reason:
                    self.db.execute("UPDATE containers SET prune_reason=? WHERE id=?", (reason, row["id"]))
            self.settings["discoveryProfile"] = profile
            self.db.execute("UPDATE settings SET data=?", (json.dumps(self.settings, ensure_ascii=False),))
        self.profile = profile
        self.pruning_dirty = False
        return {key: plan[key] for key in ("profile", "newlyPruned", "restored")}

    def export_pruned(self, directory):
        target = directory / "pruned-containers.csv"
        temporary = target.with_suffix(".csv.tmp")
        with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["id", "parentId", "name", "resumeState", "reason"])
            writer.writerows(self.db.execute("SELECT id,parent_id,name,resume_state,prune_reason FROM containers WHERE state='pruned' ORDER BY rowid"))
        os.replace(temporary, target)

    def pending(self, count, active):
        # At most --workers IDs are excluded; do not load the entire queue into memory.
        placeholders = ",".join("?" for _ in active)
        exclude = f" AND id NOT IN ({placeholders})" if active else ""
        return self.db.execute("SELECT id,token FROM containers WHERE state='pending'" + exclude + " ORDER BY rowid LIMIT ?", (*active, count)).fetchall()

    def fail(self, container_id, message):
        with self.db:
            self.db.execute("UPDATE containers SET state='error',last_error=? WHERE id=?", (message, container_id))

    def retry_failed(self):
        # Retry the failed page, retaining all earlier pages. Partial responses may
        # require a full folder refresh; that is deliberately a separate option.
        with self.db:
            self.db.execute("UPDATE containers SET state='pending',last_error='' WHERE state='error'")

    def save_page(self, container_id, token, payload, seconds, max_pages):
        if not isinstance(payload.get("containers"), list) or not isinstance(payload.get("errors", []), list):
            raise RequestFailure("Invalid containers/errors arrays in middleware response.")
        issues = [str(item.get("message", "EWS item error")) if isinstance(item, dict) else "EWS item error" for item in payload.get("errors", [])]
        with self.db:
            for container in payload["containers"]:
                if not isinstance(container, dict):
                    issues.append("Invalid container record.")
                    continue
                owner_id = container_id
                header_id = container.get("id")
                if isinstance(header_id, str) and header_id and header_id != container_id:
                    # Root/alias requests can resolve to a named container header.
                    # Keep that level in the graph and read its exact ID once too.
                    owner_id = header_id
                    self.add_container(header_id, container_id, container.get("name") or header_id, container)
                    self.db.execute("INSERT OR IGNORE INTO links VALUES (?,'container',?)", (container_id, header_id))
                # The requested ID determines traversal, not string path prefixes.
                for field, kind in KINDS.items():
                    items = container.get(field, [])
                    if not isinstance(items, list):
                        issues.append(f"Invalid {field} array.")
                        continue
                    for item in items:
                        item_id = item.get("id", item.get("Id")) if isinstance(item, dict) else None
                        if not isinstance(item_id, str) or not item_id:
                            issues.append(f"Invalid {kind} ID.")
                            continue
                        self.db.execute("INSERT OR REPLACE INTO items VALUES (?,?,?)", (kind, item_id, json.dumps(item, ensure_ascii=False)))
                        self.db.execute("INSERT OR IGNORE INTO links VALUES (?,?,?)", (owner_id, kind, item_id))
                        if kind == "container":
                            self.add_container(item_id, owner_id, item.get("name", item_id), item)
                if header_id == owner_id:
                    self.db.execute("UPDATE containers SET name=? WHERE id=?", (container.get("name") or owner_id or "EWS", owner_id))
                    header = {key: value for key, value in container.items() if key not in KINDS}
                    self.db.execute("INSERT OR REPLACE INTO items VALUES ('container',?,?)", (owner_id, json.dumps(header, ensure_ascii=False)))
            self.db.execute("INSERT INTO pages(container_id,request_token,data,fetched_at,seconds) VALUES (?,?,?,?,?)", (container_id, token, json.dumps(payload, ensure_ascii=False), now(), seconds))
            count = self.db.execute("SELECT count(*) FROM pages WHERE container_id=?", (container_id,)).fetchone()[0]
            status = payload.get("status")
            status = status if isinstance(status, dict) else {}
            more, next_token = status.get("moreDataAvailable"), status.get("moreDataRef")
            state = "done"
            unknown = False
            if more is True:
                if not isinstance(next_token, str) or not next_token:
                    issues.append("More data advertised without a continuation token.")
                elif self.db.execute("SELECT 1 FROM pages WHERE container_id=? AND request_token=?", (container_id, next_token)).fetchone():
                    issues.append("Repeated continuation token.")
                elif count >= max_pages:
                    issues.append(f"Stopped at {max_pages} pages for this container.")
                else:
                    state = "pending"
            elif more is not False:
                unknown = True
                if more is not None:
                    issues.append("Invalid pagination flag.")
            if payload.get("complete") is False and more is not True and not issues:
                issues.append("Middleware reports an incomplete container.")
            previous = self.db.execute("SELECT issue,unknown FROM containers WHERE id=?", (container_id,)).fetchone()
            issue = "; ".join(filter(None, [previous["issue"], *issues]))
            if state != "pending":
                state = "partial" if issue else "unknown" if unknown or previous["unknown"] else "done"
            self.db.execute("UPDATE containers SET state=?,token=?,issue=?,unknown=? WHERE id=?", (state, next_token if state == "pending" else token, issue, int(unknown or previous["unknown"]), container_id))
        if self.pruning_dirty:
            self.apply_profile(self.profile)

    def summary(self):
        states = {row["state"]: row["n"] for row in self.db.execute("SELECT state,count(*) n FROM containers GROUP BY state")}
        kinds = {row["kind"]: row["n"] for row in self.db.execute("SELECT kind,count(*) n FROM items GROUP BY kind")}
        pages = self.db.execute("SELECT count(*),coalesce(sum(seconds),0) FROM pages").fetchone()
        return {"containers": sum(states.values()), "states": states, "items": kinds, "pages": pages[0], "discoveryProfile": self.profile,
                "requestSeconds": round(pages[1], 3), "traversalFinished": not states.get("pending"),
                "completenessConfirmed": not any(states.get(state) for state in ("pending", "error", "partial", "unknown", "pruned"))}

    def export(self, directory):
        summary = self.summary()
        target = directory / "topology.json"
        temporary = target.with_suffix(".json.tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            header = {"schemaVersion": VERSION, "source": self.settings, "exportedAt": now(), "summary": summary}
            handle.write(json.dumps(header, ensure_ascii=False, indent=2)[:-2])
            for name, query in [
                ("containers", "SELECT c.id,c.parent_id AS parentId,c.name,c.state,c.issue,c.last_error AS lastError,c.prune_reason AS pruneReason,c.resume_state AS resumeState, (SELECT count(*) FROM pages p WHERE p.container_id=c.id) AS pages FROM containers c ORDER BY c.rowid"),
                ("links", "SELECT parent_id AS parentId,kind,id FROM links ORDER BY rowid"),
                ("records", "SELECT container_id AS containerId,request_token AS requestToken,fetched_at AS fetchedAt,seconds,data FROM pages ORDER BY seq"),
            ]:
                handle.write(f',\n  "{name}": [')
                for index, row in enumerate(self.db.execute(query)):
                    record = dict(row)
                    if name == "records":
                        record["data"] = json.loads(record["data"])
                    handle.write((",\n" if index else "\n") + "    " + json.dumps(record, ensure_ascii=False))
                handle.write("\n  ]")
            handle.write("\n}\n")
        os.replace(temporary, target)
        csv_target = directory / "inventory.csv"
        with csv_target.with_suffix(".csv.tmp").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["kind", "id", "parentId", "name", "description", "type", "unit", "writeable"])
            query = """SELECT i.kind,i.id,i.data,l.parent_id FROM items i LEFT JOIN links l
                       ON i.kind=l.kind AND i.id=l.id ORDER BY i.rowid,l.rowid"""
            for row in self.db.execute(query):
                item = json.loads(row["data"])
                writer.writerow([row["kind"], row["id"], row["parent_id"], item.get("name", item.get("Name", "")),
                                 item.get("description", item.get("Description", "")), item.get("type", item.get("Type", "")),
                                 item.get("unit", ""), item.get("writeable", "")])
        os.replace(csv_target.with_suffix(".csv.tmp"), csv_target)
        summary_target = directory / "summary.json"
        summary_target.with_suffix(".json.tmp").write_text(json.dumps({**self.settings, **summary, "exportedAt": now()}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(summary_target.with_suffix(".json.tmp"), summary_target)
        self.export_pruned(directory)
        return summary


def crawl(store, client, workers=1, metadata=False, max_pages=10000, max_requests=0, progress_every=20, max_consecutive_failures=3):
    active = {}
    submitted = finished = 0
    interrupted = fatal = stopped_for_failures = False
    consecutive_failures = 0
    executor = ThreadPoolExecutor(max_workers=workers)
    try:
        while True:
            room = workers - len(active)
            if max_requests:
                room = min(room, max_requests - submitted)
            for row in store.pending(room, {value[0] for value in active.values()}):
                active[executor.submit(client.page, row["id"], row["token"], metadata)] = (row["id"], row["token"])
                submitted += 1
            if not active:
                break
            ready, _ = wait(active, timeout=0.25, return_when=FIRST_COMPLETED)
            for future in ready:
                container_id, token = active.pop(future)
                try:
                    payload, seconds = future.result()
                    store.save_page(container_id, token, payload, seconds, max_pages)
                    # EWS sometimes reports a timeout inside an HTTP 200 page.
                    timed_out = any("TIMEOUT" in str(error.get("message", "")).upper() or "TIMED OUT" in str(error.get("message", "")).upper()
                                    for error in payload.get("errors", []) if isinstance(error, dict))
                    consecutive_failures = consecutive_failures + 1 if timed_out else 0
                except RequestFailure as error:
                    store.fail(container_id, str(error))
                    print(f"Warning: {container_id or '(root)'}: {error}", file=sys.stderr)
                    fatal = fatal or error.fatal
                    consecutive_failures = consecutive_failures + 1 if error.transient else 0
                finished += 1
                if finished == 1 or finished % progress_every == 0:
                    summary = store.summary()
                    print(f"Requests: {finished}; containers: {summary['containers']}; pending: {summary['states'].get('pending', 0)}; pruned: {summary['states'].get('pruned', 0)}; values: {summary['items'].get('value', 0)}", flush=True)
                if fatal:
                    break
                if consecutive_failures >= max_consecutive_failures:
                    stopped_for_failures = True
                    print(f"Stopped after {consecutive_failures} consecutive timeout/transient failures to reduce upstream load. Pending pages are saved; resume only after checking the source server.", file=sys.stderr)
                    break
            if fatal or stopped_for_failures:
                break
    except KeyboardInterrupt:
        interrupted = True
        print("Stopping; committed pages are safe. Waiting for active HTTP requests...", file=sys.stderr)
    finally:
        client.stop.set()
        executor.shutdown(wait=True, cancel_futures=True)
    return 130 if interrupted else 1 if fatal else 2 if stopped_for_failures else 0


def positive(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("must be a positive finite number")
    return number


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--url", default=os.getenv("MIDDLEWARE_URL", "http://localhost:3000"), help="Middleware base URL (not dashboard/EWS SOAP URL)")
    result.add_argument("--username", default=os.getenv("MIDDLEWARE_USER"), help="Middleware Basic-auth username")
    result.add_argument("--password-file", type=Path, help="File containing the plaintext middleware password; otherwise env/prompt")
    result.add_argument("--root", default="", help="Exact container ID; empty starts at EWS root")
    result.add_argument("--output", type=Path, default=Path("output/ews-topology"))
    result.add_argument("--resume", action="store_true", help="Continue the existing checkpoint with the same URL/root/metadata")
    result.add_argument("--export-only", action="store_true", help="Rebuild JSON/CSV from the checkpoint without network or credentials")
    result.add_argument("--profile", choices=("full", "catalog"), help="Catalog skips technical expansion; omitted inherits checkpoint profile (new scans: full)")
    result.add_argument("--prune-only", action="store_true", help="With --resume, apply/restore a profile and export offline without any HTTP requests")
    result.add_argument("--retry-failed", action="store_true", help="With --resume, retry pages that failed with HTTP/network errors")
    result.add_argument("--metadata", action="store_true", help="Request optional EWS metadata (larger/slower; server must support it)")
    result.add_argument("--workers", type=int, choices=range(1, 9), default=1, metavar="1..8")
    result.add_argument("--timeout", type=positive, default=20, help="HTTP timeout in seconds, above EWS_CONTAINER_TIMEOUT_MS")
    result.add_argument("--retries", type=int, choices=range(0, 11), default=0, metavar="0..10", help="Extra attempts per failed page (default: no automatic retries)")
    result.add_argument("--delay", type=float, default=2, help="Minimum delay before each request and global spacing between workers (seconds)")
    result.add_argument("--max-consecutive-failures", type=int, default=3, help="Stop after this many consecutive timeout/transient page failures")
    result.add_argument("--ca-file", help="Trusted CA PEM file for an HTTPS middleware")
    result.add_argument("--max-pages-per-container", type=int, default=10000)
    result.add_argument("--max-requests", type=int, default=0, help="Pause after this many page requests per run (0=unlimited)")
    result.add_argument("--progress-every", type=int, default=20)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    store = None
    try:
        if args.max_pages_per_container < 1 or args.max_requests < 0 or args.progress_every < 1 or args.max_consecutive_failures < 1 or not math.isfinite(args.delay) or args.delay < 0:
            raise ValueError("Invalid page/request/progress/delay limit.")
        if args.retry_failed and (not args.resume or args.export_only or args.prune_only):
            raise ValueError("--retry-failed requires --resume without an offline-only mode.")
        if args.prune_only and (not args.resume or args.export_only):
            raise ValueError("--prune-only requires --resume and cannot be combined with --export-only.")
        if args.export_only and args.profile is not None:
            raise ValueError("Use --prune-only --resume to change a profile offline.")
        offline = args.export_only or args.prune_only
        url = args.url.rstrip("/")
        parts = urlsplit(url)
        if not offline and (parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment):
            raise ValueError("Use an http(s) middleware URL without credentials, query or fragment.")
        args.output.mkdir(parents=True, exist_ok=True)
        checkpoint = args.output / "checkpoint.sqlite"
        with scan_lock(checkpoint):
            settings = None if offline else {"url": url, "rootId": args.root, "metadata": args.metadata}
            store = Store(checkpoint, settings, resume=args.resume or args.export_only)
            if not args.export_only:
                profile = args.profile or store.profile
                plan = store.pruning_plan(profile)
                backup = None
                if plan["newlyPruned"] or plan["restored"] or profile != store.profile:
                    backup = args.output / ("checkpoint.before-pruning-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".sqlite")
                    with closing(sqlite3.connect(backup)) as backup_db:
                        store.db.backup(backup_db)
                pruning = store.apply_profile(profile, plan)
                if backup or args.prune_only:
                    report = {"appliedAt": now(), **pruning, "backup": str(backup.resolve()) if backup else None,
                              "pendingAfter": store.summary()["states"].get("pending", 0),
                              "note": "No stored pages/items were deleted; pruned means outside catalog scope, not empty or failed."}
                    (args.output / "pruning-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
                    print(json.dumps(report, indent=2))
            code = 0
            if not offline:
                username = args.username or input("Middleware username: ")
                password = args.password_file.read_text(encoding="utf-8-sig").rstrip("\r\n") if args.password_file else os.getenv("MIDDLEWARE_PASSWORD")
                if password is None:
                    password = getpass.getpass("Middleware password (plaintext, not hash): ")
                if not username or not password or ":" in username:
                    raise ValueError("A middleware username (without ':') and plaintext password are required.")
                client = Client(url, username, password, args.timeout, args.retries, args.delay, args.ca_file, args.output / "request-attempts.jsonl")
                client.get("/health", authenticated=False)
                print(f"Middleware health OK (REST only, not an upstream health check). Mapping with workers={args.workers}, delay={args.delay}s, retries={args.retries}, stopAfterFailures={args.max_consecutive_failures}.", flush=True)
                if args.retry_failed:
                    store.retry_failed()
                code = crawl(store, client, args.workers, args.metadata, args.max_pages_per_container, args.max_requests, args.progress_every, args.max_consecutive_failures)
            summary = store.export(args.output)
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            print(f"Saved JSON, CSV and checkpoint in {args.output.resolve()}")
            if not code and any(summary["states"].get(state) for state in ("pending", "error", "partial")):
                code = 2
            return code
    except (ValueError, OSError, sqlite3.Error, RequestFailure) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("Stopped. Use --resume if a checkpoint was created.", file=sys.stderr)
        return 130
    finally:
        if store is not None:
            store.db.close()


if __name__ == "__main__":
    sys.exit(main())
