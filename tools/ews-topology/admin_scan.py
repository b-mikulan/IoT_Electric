#!/usr/bin/env python3
"""Private dashboard worker: one JSON configuration line on stdin, JSON progress on stdout."""
import json
from pathlib import Path
import sys
import threading
from urllib.parse import urlsplit

from map_topology import Client, Store, crawl, scan_lock, RequestFailure


def main():
    stopped = threading.Event()

    def emit(value):
        try:
            print(json.dumps(value, ensure_ascii=False), flush=True)
        except (BrokenPipeError, OSError):
            stopped.set()

    def control():
        # Any further stdin input, or the parent closing/dying, requests a pause.
        sys.stdin.readline()
        stopped.set()

    store = None
    try:
        config = json.loads(sys.stdin.readline())
        directory = Path(config["output"])
        url = config["url"].rstrip("/")
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError("Invalid middleware address")
        if config["profile"] not in ("catalog", "full") or not config["username"] or not config["password"]:
            raise ValueError("Missing configuration")
        threading.Thread(target=control, daemon=True).start()
        # Protect all admin jobs, including a child finishing after its parent
        # restarted. The normal mapper's own checkpoint lock is retained too.
        with scan_lock(directory.parent / "admin-active"), scan_lock(directory / "checkpoint.sqlite"):
            store = Store(directory / "checkpoint.sqlite", {"url": url, "rootId": config["root"], "metadata": False}, resume=config["resume"])
            store.apply_profile(config["profile"])
            if config.get("retryFailed"):
                store.retry_failed()
            emit({"event": "progress", "summary": store.summary(), "requests": 0})
            client = Client(url, config["username"], config["password"], timeout=config["timeout"], retries=0,
                            delay=config["delay"], ca_file=config.get("caFile"), attempt_log=directory / "request-attempts.jsonl")
            if not stopped.is_set():
                client.get("/health", authenticated=False)
            code = crawl(store, client, workers=1, max_requests=config["maxRequests"], progress_every=1000000,
                         on_progress=lambda summary, requests: emit({"event": "progress", "summary": summary, "requests": requests}),
                         should_stop=stopped.is_set)
            summary = store.export(directory)
            emit({"event": "finished", "summary": summary, "code": code})
            return code
    except (Exception, KeyboardInterrupt) as error:
        # Never expose raw exceptions, URLs, credentials or controller payloads.
        emit({"event": "failed", "reason": "connection" if isinstance(error, RequestFailure) else "worker"})
        return 1
    finally:
        if store is not None:
            store.db.close()


if __name__ == "__main__":
    sys.exit(main())
