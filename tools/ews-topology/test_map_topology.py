import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr, redirect_stdout
import csv
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import map_topology as mapper


TOKEN = " 0000 / &+ ž "
PASSWORD = "test-private-password"


def page(children=(), values=(), more=False, token=None, errors=(), **extra):
    return {"containers": [{"containerItems": [{"id": child, "name": child} for child in children],
                             "valueItems": [{"id": value, "name": value, "unit": "°C", "writeable": 1} for value in values]}],
            "errors": list(errors), "status": {"moreDataAvailable": more, "moreDataRef": token},
            "complete": not more and not errors, **extra}


class Fixture:
    def __init__(self):
        self.calls = []
        self.broken = True
        self.denied = False
        self.failures = 0
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                parsed = urlsplit(self.path)
                if parsed.path == "/health":
                    fixture.calls.append(("health", ""))
                    return self.reply(200, {"status": "ok"})
                expected = "Basic " + base64.b64encode(f"user:{PASSWORD}".encode()).decode()
                if self.headers.get("Authorization") != expected or fixture.denied:
                    return self.reply(401, {"error": "Unauthorized"})
                if parsed.path != "/api/containers":
                    return self.reply(404, {})
                query = parse_qs(parsed.query, keep_blank_values=True)
                if query.get("allPages") != ["false"] or query.get("metadata") != ["false"]:
                    return self.reply(400, {})
                container_id, token = query["id"][0], query.get("moreDataRef", [""])[0]
                fixture.calls.append((container_id, token))
                if container_id == "" and token == "":
                    payload = page(["00/A", "opaque-child", "broken", "legacy", "partial"], ["01/root"], True, TOKEN)
                elif container_id == "" and token == TOKEN:
                    payload = page(values=["01/root-2"])
                    payload["containers"][0].update({"historyItems": [{"Id": "03/history", "Name": "Trend", "Metadata": {"source": "fixture"}}],
                                                       "alarmItems": [{"Id": "04/alarm", "Name": "Alarm"}]})
                elif container_id == "00/A":
                    payload = page(["00/A", "00/A/room", "opaque-child"], ["01/shared"])
                elif container_id == "00/A/room":
                    payload = page(["00/A"], ["01/room"])
                elif container_id == "opaque-child":
                    payload = page(values=["01/shared"])
                elif container_id == "broken" and fixture.broken:
                    fixture.failures += 1
                    return self.reply(503, {"error": "temporary"})
                elif container_id == "broken":
                    payload = page(values=["01/recovered"])
                elif container_id == "legacy":
                    payload = page()
                    payload.update(status=None, complete=None)
                elif container_id == "partial":
                    payload = page(values=["01/readable"], errors=[{"id": "missing", "message": "One item unreadable"}])
                else:
                    return self.reply(404, {})
                self.reply(200, payload)

            def reply(self, code, payload):
                data = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class TopologyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def fixture(self):
        fixture = Fixture()
        self.addCleanup(fixture.close)
        return fixture

    def run_cli(self, fixture, *extra):
        args = ["--url", fixture.url, "--username", "user", "--output", str(self.directory), "--delay", "0", "--retries", "0", *extra]
        with patch.dict(os.environ, {"MIDDLEWARE_PASSWORD": PASSWORD}), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return mapper.main(args)

    def store(self, root=""):
        store = mapper.Store(self.directory / "checkpoint.sqlite", {"url": "http://middleware", "rootId": root, "metadata": False})
        self.addCleanup(store.db.close)
        return store

    def test_budget_resume_parallel_traversal_exports_and_offline_export(self):
        fixture = self.fixture()
        self.assertEqual(self.run_cli(fixture, "--max-requests", "1"), 2)
        first = json.loads((self.directory / "topology.json").read_text(encoding="utf-8"))
        self.assertEqual(first["summary"]["pages"], 1)
        self.assertEqual(first["summary"]["states"]["pending"], 6)
        self.assertFalse(first["summary"]["traversalFinished"])
        self.assertEqual(self.run_cli(fixture, "--resume", "--workers", "3"), 2)
        report = json.loads((self.directory / "topology.json").read_text(encoding="utf-8"))
        summary = report["summary"]
        self.assertTrue(summary["traversalFinished"])
        self.assertFalse(summary["completenessConfirmed"])
        self.assertEqual(summary["items"], {"alarm": 1, "container": 7, "history": 1, "value": 5})
        states = {item["id"]: item["state"] for item in report["containers"]}
        self.assertEqual(states["broken"], "error")
        self.assertEqual(states["legacy"], "unknown")
        self.assertEqual(states["partial"], "partial")
        self.assertEqual(states[""], "done")
        self.assertEqual(fixture.calls.count(("", "")), 1)
        self.assertEqual(fixture.calls.count(("", TOKEN)), 1)
        self.assertEqual(fixture.calls.count(("00/A", "")), 1)
        shared_links = [link for link in report["links"] if link["id"] == "01/shared"]
        self.assertEqual(len(shared_links), 2)
        histories = [item for record in report["records"] for container in record["data"]["containers"] for item in container.get("historyItems", [])]
        self.assertEqual(histories[0]["Metadata"], {"source": "fixture"})
        with (self.directory / "inventory.csv").open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(len([row for row in rows if row["id"] == "01/shared"]), 2)
        self.assertTrue(any(row["kind"] == "history" and row["name"] == "Trend" for row in rows))
        self.assertFalse(any(PASSWORD.encode() in path.read_bytes() for path in self.directory.iterdir() if path.is_file()))
        call_count = len(fixture.calls)
        with redirect_stdout(io.StringIO()), patch.object(mapper.Client, "get", side_effect=AssertionError("Offline export used network")):
            self.assertEqual(mapper.main(["--output", str(self.directory), "--export-only"]), 2)
        self.assertEqual(len(fixture.calls), call_count)

        fixture.broken = False
        self.assertEqual(self.run_cli(fixture, "--resume", "--retry-failed"), 2)  # 'partial' is still explicit.
        recovered = json.loads((self.directory / "summary.json").read_text(encoding="utf-8"))
        self.assertNotIn("error", recovered["states"])
        self.assertEqual(recovered["items"]["value"], 6)
        self.assertEqual(fixture.calls.count(("", "")), 1)

    def test_scoped_run_never_requests_root_and_finishes_confirmed(self):
        fixture = self.fixture()
        self.assertEqual(self.run_cli(fixture, "--root", "00/A", "--workers", "2"), 0)
        report = json.loads((self.directory / "topology.json").read_text(encoding="utf-8"))
        self.assertTrue(report["summary"]["completenessConfirmed"])
        self.assertEqual(report["summary"]["containers"], 3)
        self.assertNotIn(("", ""), fixture.calls)
        self.assertEqual(report["containers"][0]["parentId"], None)
        self.assertEqual(report["containers"][0]["id"], "00/A")

    def test_checkpoint_refuses_overwrite_mismatch_and_double_process(self):
        store = self.store()
        with self.assertRaisesRegex(ValueError, "already exists"):
            mapper.Store(self.directory / "checkpoint.sqlite", store.settings)
        with self.assertRaisesRegex(ValueError, "differs"):
            mapper.Store(self.directory / "checkpoint.sqlite", {"url": "http://other", "rootId": "", "metadata": False}, resume=True)
        with mapper.scan_lock(self.directory / "checkpoint.sqlite"):
            with self.assertRaisesRegex(ValueError, "Another mapper"):
                with mapper.scan_lock(self.directory / "checkpoint.sqlite"):
                    self.fail("Acquired a duplicate lock")

    def test_unsafe_pagination_stops_but_preserves_readable_points(self):
        for index, payload in enumerate([page(values=["value"], more=True), page(values=["value"], more=True, token="same")]):
            with self.subTest(index=index):
                directory = self.directory / str(index)
                directory.mkdir()
                store = mapper.Store(directory / "checkpoint.sqlite", {"url": "http://middleware", "rootId": "", "metadata": False})
                try:
                    if index:
                        store.save_page("", "", payload, 0.1, 100)
                        store.save_page("", "same", payload, 0.1, 100)
                    else:
                        store.save_page("", "", payload, 0.1, 100)
                    self.assertEqual(store.summary()["states"], {"partial": 1})
                    self.assertEqual(store.summary()["items"]["value"], 1)
                finally:
                    store.db.close()

    def test_failed_page_retry_retains_previous_item_warnings(self):
        store = self.store()
        first = page(values=["readable"], more=True, token=TOKEN, errors=[{"message": "Missing item"}])
        store.save_page("", "", first, 0.1, 100)
        store.fail("", "Timeout")
        store.retry_failed()
        store.save_page("", TOKEN, page(values=["second"]), 0.1, 100)
        summary = store.export(self.directory)
        self.assertEqual(summary["states"], {"partial": 1})
        report = json.loads((self.directory / "topology.json").read_text(encoding="utf-8"))
        self.assertIn("Missing item", report["containers"][0]["issue"])
        self.assertEqual(summary["items"]["value"], 2)

    def test_page_limit_and_malformed_payload(self):
        store = self.store()
        with self.assertRaises(mapper.RequestFailure):
            store.save_page("", "", {"containers": None}, 0.1, 2)
        self.assertEqual(store.summary()["pages"], 0)
        store.save_page("", "", page(more=True, token=TOKEN), 0.1, 1)
        self.assertEqual(store.summary()["states"], {"partial": 1})

    def test_root_response_preserves_named_container_headers_and_exact_parent_links(self):
        store = self.store()
        response = page(children=["opaque-child"], values=["point"])
        response["containers"][0].update(id="00/actual-server", name="Server", metadata={"Room": "Kitchen"})
        store.save_page("", "", response, 0.1, 100)
        store.export(self.directory)
        report = json.loads((self.directory / "topology.json").read_text(encoding="utf-8"))
        self.assertIn({"parentId": "", "kind": "container", "id": "00/actual-server"}, report["links"])
        self.assertIn({"parentId": "00/actual-server", "kind": "container", "id": "opaque-child"}, report["links"])
        self.assertIn({"parentId": "00/actual-server", "kind": "value", "id": "point"}, report["links"])
        self.assertEqual({row["id"] for row in store.pending(10, set())}, {"00/actual-server", "opaque-child"})

    def test_transient_http_failures_retry_and_authentication_stops_globally(self):
        fixture = self.fixture()
        client = mapper.Client(fixture.url, "user", PASSWORD, retries=2, delay=0)
        with patch.object(client.stop, "wait", return_value=False):
            with self.assertRaises(mapper.RequestFailure):
                client.page("broken", "", False)
        self.assertEqual(fixture.failures, 3)
        fixture.denied = True
        self.assertEqual(self.run_cli(fixture), 1)
        summary = json.loads((self.directory / "summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["states"], {"error": 1})

    def test_interruption_keeps_last_committed_page_and_can_resume(self):
        store = self.store()

        class InterruptedClient:
            stop = threading.Event()

            def page(self, container_id, token, metadata):
                if token == "":
                    return page(values=["first"], more=True, token=TOKEN), 0.1
                raise KeyboardInterrupt()

        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(mapper.crawl(store, InterruptedClient()), 130)
        self.assertEqual(store.summary()["pages"], 1)
        self.assertEqual(store.pending(1, set())[0]["token"], TOKEN)
        store.save_page("", TOKEN, page(values=["second"]), 0.1, 100)
        self.assertTrue(store.summary()["completenessConfirmed"])

    def test_default_load_is_one_worker_two_second_delay_without_retries(self):
        args = mapper.parser().parse_args([])
        self.assertEqual((args.workers, args.delay, args.retries, args.max_consecutive_failures), (1, 2, 0, 3))

    def test_request_spacing_is_shared_by_workers(self):
        starts = []
        client = mapper.Client("http://fixture", "user", PASSWORD, delay=0.03)

        class Response(io.BytesIO):
            status = 200

        class Opener:
            def open(self, *args, **kwargs):
                starts.append(time.monotonic())
                return Response(b'{"containers":[],"errors":[]}')

        with patch.object(mapper, "build_opener", return_value=Opener()):
            with ThreadPoolExecutor(max_workers=4) as executor:
                list(executor.map(lambda _: client.get("/api/containers"), range(4)))
        self.assertEqual(len(starts), 4)
        self.assertTrue(all(b - a >= 0.025 for a, b in zip(sorted(starts), sorted(starts)[1:])))

    def test_repeated_transient_failures_stop_without_consuming_pending_queue(self):
        store = self.store()
        store.save_page("", "", page(children=["a", "b", "c", "d", "e"]), 0.1, 100)

        class FailedClient:
            stop = threading.Event()
            calls = []

            def page(self, container_id, *args):
                self.calls.append(container_id)
                raise mapper.RequestFailure("HTTP 504", transient=True)

        client = FailedClient()
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(mapper.crawl(store, client), 2)
        self.assertEqual(client.calls, ["a", "b", "c"])
        self.assertEqual(store.summary()["states"], {"done": 1, "error": 3, "pending": 2})
        self.assertEqual([row["id"] for row in store.pending(10, set())], ["d", "e"])
        store.retry_failed()
        self.assertEqual(len(store.pending(10, set())), 5)
        self.assertEqual(store.summary()["pages"], 1)

    def test_success_resets_failure_streak_but_item_reference_errors_do_not_stop_scan(self):
        store = self.store()
        store.save_page("", "", page(children=["a", "b", "c", "d", "e"]), 0.1, 100)

        class MixedClient:
            stop = threading.Event()
            calls = []

            def page(self, container_id, *args):
                self.calls.append(container_id)
                if container_id in ("a", "c", "d"):
                    raise mapper.RequestFailure("HTTP 504", transient=True)
                return page(errors=[{"message": "INVALID_REFERENCE"}]), 0.1

        client = MixedClient()
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(mapper.crawl(store, client), 0)
        self.assertEqual(client.calls, ["a", "b", "c", "d", "e"])
        self.assertNotIn("pending", store.summary()["states"])

    def test_timeout_errors_inside_http_200_pages_trigger_stop_and_preserve_partial_data(self):
        store = self.store()
        store.save_page("", "", page(children=["a", "b", "c", "d"]), 0.1, 100)

        class TimeoutClient:
            stop = threading.Event()

            def page(self, container_id, *args):
                return page(values=[container_id + "/readable"], errors=[{"message": "TIMEOUT"}]), 0.1

        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(mapper.crawl(store, TimeoutClient()), 2)
        self.assertEqual(store.summary()["states"], {"done": 1, "partial": 3, "pending": 1})
        self.assertEqual(store.summary()["items"]["value"], 3)

    def test_stopping_parallel_scan_leaves_uncommitted_requests_pending(self):
        store = self.store()
        store.save_page("", "", page(children=["a", "b", "c", "d"]), 0.1, 100)

        class Client:
            stop = threading.Event()

            def page(self, container_id, *args):
                if container_id == "a":
                    raise mapper.RequestFailure("HTTP 504", transient=True)
                self.stop.wait(1)
                raise mapper.RequestFailure("Scan stopped.")

        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(mapper.crawl(store, Client(), workers=3, max_consecutive_failures=1), 2)
        self.assertEqual(store.summary()["states"], {"done": 1, "error": 1, "pending": 3})

    def test_attempt_log_records_failed_request_duration_without_credentials(self):
        fixture = self.fixture()
        log = self.directory / "attempts.jsonl"
        client = mapper.Client(fixture.url, "user", PASSWORD, delay=0, attempt_log=log)
        with self.assertRaises(mapper.RequestFailure):
            client.page("broken", "", False)
        event = json.loads(log.read_text(encoding="utf-8"))
        self.assertEqual(event["httpStatus"], 503)
        self.assertEqual(event["containerId"], "broken")
        self.assertEqual(event["attempt"], 1)
        self.assertGreaterEqual(event["seconds"], 0)
        self.assertTrue(event["startedAt"] and event["finishedAt"])
        self.assertNotIn(PASSWORD, log.read_text(encoding="utf-8"))

    def save_folder(self, store, container_id, children, values=()):
        response = page(values=values)
        response["containers"][0].update(id=container_id, name=container_id or "Root", type="folder", containerItems=children)
        store.save_page(container_id, "", response, 0.1, 100)

    def test_catalog_cuts_existing_technical_descendants_but_keeps_alarm_history_and_hardware_paths(self):
        store = self.store()
        self.save_folder(store, "", [
            {"id": key, "name": name, "type": "folder"}
            for key, name in [("prog", "Programs"), ("points", "Points"), ("vals", "Values"),
                              ("alarms", "Alarms"), ("logs", "Logs"), ("io", "IO Resources"), ("sys", "System")]
        ] + [{"id": "unknown", "name": "Unknown structure", "type": "structure"}])
        self.save_folder(store, "prog", [{"id": "opaque-program-leaf", "name": "Work", "type": "structure"}], ["11/program/property"])
        # Preserve the original semantic name after the fixture's header update.
        store.db.execute("UPDATE containers SET name='Programs' WHERE id='prog'")
        store.db.execute("UPDATE items SET data=? WHERE kind='container' AND id='prog'", (json.dumps({"type": "folder"}),))
        store.db.commit()
        self.save_folder(store, "logs", [{"id": "charts", "name": "Trend Charts", "type": "folder"},
                                         {"id": "trends", "name": "Trend Logs", "type": "folder"}])
        self.save_folder(store, "alarms", [{"id": "nc", "name": "NC", "type": "structure"}])
        store.db.execute("UPDATE containers SET name='Alarms' WHERE id='alarms'")
        store.db.commit()
        before = store.summary()
        plan = store.pruning_plan("catalog")
        self.assertEqual(set(plan["prunedIds"]), {"opaque-program-leaf", "charts", "nc"})
        store.apply_profile("catalog", plan)
        self.assertEqual(store.summary()["states"]["pruned"], 3)
        self.assertEqual(store.summary()["pages"], before["pages"])
        self.assertEqual(store.summary()["items"], before["items"])
        self.assertEqual({row["id"] for row in store.pending(100, set())}, {"points", "vals", "io", "sys", "unknown", "trends"})

    def test_catalog_prunes_new_branches_before_any_network_task_and_retains_definitions(self):
        store = self.store()
        store.apply_profile("catalog")

        class CatalogClient:
            stop = threading.Event()
            calls = []

            def page(self, container_id, *args):
                self.calls.append(container_id)
                response = page()
                if container_id == "":
                    response["containers"][0]["containerItems"] = [
                        {"id": key, "name": name, "type": "folder"} for key, name in
                        [("programs", "Programs"), ("graphics", "Graphics"), ("values", "Values"), ("logs", "Logs"), ("alarms", "Alarms")]]
                elif container_id == "logs":
                    response["containers"][0]["containerItems"] = [
                        {"id": "charts", "name": "Trend Charts", "type": "folder"}, {"id": "trends", "name": "Trend Logs", "type": "folder"}]
                elif container_id == "values":
                    response = page(values=["01/real-point"])
                elif container_id == "trends":
                    response["containers"][0]["historyItems"] = [{"Id": "03/history", "Name": "History"}]
                elif container_id == "alarms":
                    response["containers"][0]["alarmItems"] = [{"Id": "02/alarm", "Name": "Alarm"}]
                else:
                    raise AssertionError("Technical branch was sent to middleware: " + container_id)
                return response, 0.1

        client = CatalogClient()
        with redirect_stdout(io.StringIO()):
            self.assertEqual(mapper.crawl(store, client), 0)
        self.assertEqual(set(client.calls), {"", "values", "logs", "alarms", "trends"})
        self.assertEqual(store.summary()["items"]["value"], 1)
        self.assertEqual(store.summary()["items"]["history"], 1)
        self.assertEqual(store.summary()["items"]["alarm"], 1)
        self.assertEqual(store.summary()["states"]["pruned"], 3)
        self.assertFalse(store.summary()["completenessConfirmed"])
        self.assertTrue(store.summary()["traversalFinished"])

    def test_catalog_preserves_descendants_reachable_through_allowed_alias_and_cycles(self):
        store = self.store()
        self.save_folder(store, "", [{"id": "programs", "name": "Programs", "type": "folder"},
                                      {"id": "device", "name": "Device", "type": "folder"}])
        self.save_folder(store, "programs", [{"id": "shared", "name": "Shared", "type": "structure"}])
        store.db.execute("UPDATE containers SET name='Programs' WHERE id='programs'")
        self.save_folder(store, "device", [{"id": "shared", "name": "Shared", "type": "structure"}])
        store.db.execute("INSERT OR IGNORE INTO links VALUES ('shared','container','programs')")
        store.db.commit()
        store.apply_profile("catalog")
        self.assertEqual(store.db.execute("SELECT state FROM containers WHERE id='shared'").fetchone()[0], "pending")

    def test_new_allowed_alias_reopens_previously_pruned_descendants(self):
        store = self.store()
        self.save_folder(store, "", [{"id": "programs", "name": "Programs", "type": "folder"},
                                      {"id": "device", "name": "Device", "type": "folder"}])
        self.save_folder(store, "programs", [{"id": "shared", "name": "Shared", "type": "structure"}])
        store.db.execute("UPDATE containers SET name='Programs' WHERE id='programs'")
        store.db.commit()
        store.apply_profile("catalog")
        self.assertEqual(store.db.execute("SELECT state FROM containers WHERE id='shared'").fetchone()[0], "pruned")
        self.save_folder(store, "device", [{"id": "shared", "name": "Shared", "type": "structure"}])
        self.assertEqual(store.db.execute("SELECT state FROM containers WHERE id='shared'").fetchone()[0], "pending")

    def test_catalog_retry_does_not_reactivate_skips_and_full_profile_restores_original_error(self):
        store = self.store()
        self.save_folder(store, "", [{"id": "graphics", "name": "Graphics", "type": "folder"}])
        store.fail("graphics", "Previous HTTP 504")
        store.apply_profile("catalog")
        store.retry_failed()
        self.assertEqual(store.summary()["states"], {"done": 1, "pruned": 1})
        restored = store.apply_profile("full")
        self.assertEqual(restored["restored"], 1)
        self.assertEqual(store.summary()["states"], {"done": 1, "error": 1})
        self.assertEqual(store.db.execute("SELECT last_error FROM containers WHERE id='graphics'").fetchone()[0], "Previous HTTP 504")

    def test_explicit_root_is_not_pruned_and_unknown_structures_are_kept(self):
        store = self.store(root="root-program")
        response = page()
        response["containers"][0].update(id="root-program", name="Programs", type="folder",
                                          containerItems=[{"id": "unknown", "name": "Custom", "type": "structure"}])
        store.save_page("root-program", "", response, 0.1, 100)
        store.apply_profile("catalog")
        self.assertNotIn("pruned", store.summary()["states"])
        self.assertEqual(store.pending(10, set())[0]["id"], "unknown")

    def test_offline_pruning_backs_up_exports_reasons_and_profile_survives_resume(self):
        store = self.store()
        self.save_folder(store, "", [{"id": "graphics", "name": "Graphics", "type": "folder"}])
        store.db.close()
        with patch.object(mapper.Client, "get", side_effect=AssertionError("Offline mode used network")), redirect_stdout(io.StringIO()):
            self.assertEqual(mapper.main(["--output", str(self.directory), "--resume", "--profile", "catalog", "--prune-only"]), 0)
        self.assertEqual(len(list(self.directory.glob("checkpoint.before-pruning-*.sqlite"))), 1)
        report = json.loads((self.directory / "pruning-report.json").read_text())
        self.assertEqual(report["newlyPruned"], 1)
        self.assertTrue(Path(report["backup"]).is_file())
        self.assertTrue((self.directory / "pruned-containers.csv").is_file())
        resumed = mapper.Store(self.directory / "checkpoint.sqlite", resume=True)
        self.assertEqual(resumed.profile, "catalog")
        self.assertEqual(resumed.summary()["states"]["pruned"], 1)
        resumed.db.close()
        with patch.object(mapper.Client, "get", side_effect=AssertionError("Offline restore used network")), redirect_stdout(io.StringIO()):
            self.assertEqual(mapper.main(["--output", str(self.directory), "--resume", "--profile", "full", "--prune-only"]), 2)
        summary = json.loads((self.directory / "summary.json").read_text())
        self.assertEqual(summary["states"], {"done": 1, "pending": 1})


if __name__ == "__main__":
    unittest.main()
