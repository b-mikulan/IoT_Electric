# Offline EWS topology mapper

`map_topology.py` reads the building through the **middleware REST API**, independently of the dashboard. Requires **Python 3.10+**, with no third-party packages. It only calls `GET /health` and `GET /api/containers`; it never reads live point values, sends commands, or changes widget configuration.

For a large building, the important difference is durable progress: every container page and its newly discovered children are committed together to SQLite. A restart continues from the last committed page instead of repeating the entire scan. The source server still does work for every request. Defaults are deliberately slow: **one worker, a two-second pause before each request, no automatic retries, and a stop after three consecutive timeout/transient failures**. These defaults reduce load; they are not a guarantee that a particular building server can sustain an unlimited crawl. Existing dashboard polling adds its own load.

## Run from the repository root

PowerShell (the password is requested without displaying it):

```powershell
python tools/ews-topology/map_topology.py --url http://localhost:3000 --username YOUR_MIDDLEWARE_USER
```

Use the middleware address reachable from this machine, including the published port if it runs on another server. This is **not** the dashboard URL or EWS SOAP URL. Credentials are the same username and **plaintext** password used in Swagger's Authorize dialog; `MIDDLEWARE_PASSWORD_HASH` cannot be used. The script does not automatically load `.env`.

Alternatively, set `MIDDLEWARE_URL`, `MIDDLEWARE_USER`, and `MIDDLEWARE_PASSWORD` in the process environment, or use `--password-file path/to/password.txt` for a mounted plaintext secret. There is no password command-line option, and credentials are not written to the checkpoint or exports. The password file may end with a newline. HTTPS certificate verification stays enabled; `--ca-file path/to/ca.pem` adds your trusted CA. Redirects are rejected; give the final middleware URL.

Full scan with the conservative defaults:

```powershell
python tools/ews-topology/map_topology.py --url http://SERVER:3000 --username YOUR_USER --workers 1 --delay 2 --retries 0 --output output/building-map
```

Continue after Ctrl+C, a process crash, or a request budget pause, with the **same URL, root ID and metadata option**:

```powershell
python tools/ews-topology/map_topology.py --url http://SERVER:3000 --username YOUR_USER --workers 1 --delay 2 --retries 0 --output output/building-map --resume
```

The checkpoint is saved after every successful page. Ctrl+C stops scheduling work and waits for active requests to finish or time out, then exports the committed data. A forced process kill can skip that final export, but `--resume` and `--export-only` can still use the checkpoint. Only one process may use a checkpoint at a time; its lock is released by the OS after a crash.

To inspect a smaller branch or take a short sample first:

```powershell
python tools/ews-topology/map_topology.py --username YOUR_USER --root "00/ES/Application" --output output/application-map
python tools/ews-topology/map_topology.py --username YOUR_USER --max-requests 50 --output output/sample-map
```

`--max-requests` counts page tasks in the current run, including failed tasks; HTTP retries are additional attempts. Pending work remains in the checkpoint and can be resumed. Repeating a finished scan requires a new output directory, which keeps snapshots of the building separate.

## Prune technical expansion while keeping useful catalog data

The discovered queue can grow faster than requests finish: one device lists Points, Values, Programs, Alarms and Logs; those folders then expose more objects. `--profile catalog` stops expanding known presentation/program/configuration branches while retaining equipment, direct points, history and alarm definitions.

Apply it to an existing checkpoint **offline**, without middleware access or credentials:

```powershell
python tools/ews-topology/map_topology.py --output output/ews-topology --resume --profile catalog --prune-only
```

It automatically saves a `checkpoint.before-pruning-<timestamp>.sqlite` backup before changing queue states. It does not delete any saved pages, points, metadata or links. Unread excluded containers become `pruned`, with the reason and previous state in the export and `pruned-containers.csv`. `pruning-report.json` records the change and backup path.

The catalog profile skips folders whose EWS type is `folder` and whose exact names are **Programs, Graphics, Trend Charts, Views, Dashboards, Schedules, Diagnostic Files, Certificate Files**. It also skips `graphic`, `schedule`, and `mentaprogram` objects, alarm notification-class `NC` structures under Alarms, and ontology graph expansion. This is an explicit scope choice: these branches may contain useful technical properties/references; they are **not proven empty**. Existing collected data from them remains available.

It keeps **Points, Values, Items, Application, IO Resources, External Bindings, System, Logs, Trend Logs and Alarms**, and unknown `structure` objects. Saved data shows native point definitions under Points/Values, histories under Trend Logs and alarm definitions under Alarms; a blanket type-`structure` or Logs/Alarms exclusion would discard useful discovery. Do not interpret type `structure` as a terminal leaf: some structures have children.

Exclusions propagate through saved container links, including descendants of technical folders already read earlier. A descendant reachable through an allowed second parent is retained. A specifically requested `--root` is always retained. The rules also apply to **newly discovered** containers before a request is scheduled, so later device discoveries do not refill the queue with these same technical branches.

Continue with bounded, paced requests:

```powershell
python tools/ews-topology/map_topology.py --url http://localhost:3000 --output output/ews-topology --resume --profile catalog --workers 1 --delay 3 --retries 0 --max-requests 50 --max-consecutive-failures 3
```

The profile is remembered in the checkpoint. Omitting `--profile` on a later resume inherits it; a new checkpoint defaults to `full`. `--retry-failed` only retries actual `error` states and does not re-enable pruned work. Use it if there are still genuine failed folders to retry.

To restore the unread technical branches offline:

```powershell
python tools/ews-topology/map_topology.py --output output/ews-topology --resume --profile full --prune-only
```

The previous `pending`/`error` states and continuation tokens are restored, without discarding successful reads. Pruned folders are explicitly excluded from full completeness: a drained catalog queue is not proof that the entire server topology has been mapped.

If a scan appears to affect the source server, stop that running process with **Ctrl+C**. Editing the script does not update an already running process. After checking source-server health, use a bounded retry from the original checkpoint:

```powershell
python tools/ews-topology/map_topology.py --url http://localhost:3000 --output output/ews-topology --resume --retry-failed --workers 1 --delay 3 --retries 0 --max-requests 50 --max-consecutive-failures 3
```

This reads at most 50 page tasks in that run. With one worker, there are no simultaneous mapper requests, and the source has at least three seconds between completed requests and the next start. It stops sooner if three consecutive page tasks report a transient/timeout failure. It does not automatically restart after that stop.

## Files

The default directory is `output/ews-topology/`, already covered by the repository's ignored `output/` directory:

| File | Purpose |
| --- | --- |
| `topology.json` | Container states, parent relationships, all discovered links, and raw API pages under `records[].data` |
| `inventory.csv` | Flat inventory of containers, values, histories and alarms, with IDs, parents, names, types, units and write capability |
| `summary.json` | Counts of unique objects, pages, pending/error/incomplete folders and whether completeness was confirmed |
| `checkpoint.sqlite` | Durable queue, pages and inventory; needed for resume/export |
| `checkpoint.sqlite.lock` | OS process lock; may remain after exit |
| `request-attempts.jsonl` | Append-only attempt timestamps, durations, HTTP status and generic errors; includes failed requests, excludes credentials |
| `pruned-containers.csv` | Currently excluded unread containers, previous states and exclusion reasons |
| `pruning-report.json` | Most recent explicit pruning/restoration report, with automatic backup path |

JSON/CSV exports are streamed from SQLite, so the script does not hold the whole building or repeatedly rewrite a huge JSON file during the scan. Exports are replaced atomically at the end of each run. SQLite stores all pages as they arrive. Keep the checkpoint together with the snapshot.

For a persistent, searchable building catalog with recognized device functions, run `npm run catalog -- import` from the repository root. The [building catalog](../building-catalog/README.md) reads this checkpoint directly into a separate SQLite database without contacting the controller or changing scan progress. Its snapshot view preserves partial and pruned coverage explicitly.

`containers[].parentId` records the first discovered parent; `links[]` preserves additional parents and cycles. IDs and continuation tokens stay exact, including case and whitespace. Traversal follows returned child links rather than assuming that IDs are filesystem paths. If a root or alias request resolves to a different named container header, that level is preserved and its exact ID is also read once. Items are counted by `(kind, id)`; the CSV contains one row per parent link, so the same referenced object may appear more than once. The synthetic EWS root counts as one container when scanning from root.

`requestSeconds` sums elapsed saved page-task time, including pacing waits and retries; with multiple workers it is not the wall-clock scan duration. Failed tasks are absent from this aggregate. `records[]` contains the original per-page data, paging status, item errors, fetch time and task duration. `request-attempts.jsonl` also records failed HTTP attempts and their elapsed network time, excluding pacing/backoff waits, so a future timeout tail can be investigated.

Rebuild exports offline at any time, without credentials or controller access:

```powershell
python tools/ews-topology/map_topology.py --output output/building-map --export-only
```

The JSON is compatible with the existing widget grouping preview:

```powershell
npm run widgets:group-preview -- output/building-map/topology.json output/building-preview
```

Open `output/building-preview/grouping-preview.html` to review discovered points grouped into devices. This is a local preview and does not save dashboard widgets. Raw topology also includes histories, alarms and folders without values, which the widget preview does not render.

## Partial results and tuning

- The mapper requests **one EWS page at a time** (`allPages=false`), preserving continuation tokens across restarts. It avoids one middleware call consuming its entire multi-page time budget. A single page is still subject to the middleware's item and timeout limits.
- `--timeout 20` sets the HTTP timeout in seconds. Keep it above the middleware's `EWS_CONTAINER_TIMEOUT_MS` (default 8 seconds). Raising only this script's timeout does not increase the controller budget inside middleware.
- `--retries 0` is the default: a failed request is not automatically repeated. If explicitly enabled, retries cover network failures and HTTP 408/429/500/502/503/504 with 5/10/20/... seconds of backoff, capped at 60 seconds, plus normal pacing. HTTP 401/403 stops the run immediately.
- `--delay 2` is the default. One shared gate covers all workers and retries, enforcing at least this spacing between attempt starts. With one worker there is also at least this idle time after each completed request. Explicit `--workers 2` or higher can still overlap long requests; leave it at one while investigating source-server load. This gate controls only this mapper process, not dashboard requests or other mapper output directories.
- `--max-consecutive-failures 3` stops scheduling after three consecutive page tasks fail transiently or return EWS `TIMEOUT`/`timed out` item errors. A successful response without timeout errors resets the streak. Ordinary `INVALID_REFERENCE` item errors remain partial results and do not trigger this stop. With explicit retries, one page task can contain several HTTP attempts. Pending requests retain their checkpoint state. At most `workers - 1` already active requests can still be in flight at the stop; default one-worker runs have none.
- `--resume --retry-failed` retries the pages marked `error`, preserving earlier pages. Ordinary `--resume` continues pending work and leaves failed folders explicitly marked. Errors reported inside an HTTP 200 response retain readable items, and the folder remains `partial` even if later pages succeed.
- `--metadata` requests optional metadata for future classification. It increases output size and controller work and may be unsupported. It must match the initial scan when resuming.
- `--max-pages-per-container 10000` stops an unsafe/unbounded paging loop. Repeated or missing continuation tokens mark that folder `partial`; other folders continue.
- Older servers may omit paging status. These folders are `unknown`, not silently declared complete. `traversalFinished` means the discovered queue is drained; `completenessConfirmed` is true only when every folder explicitly completed without errors. Neither proves that the controller exposes every physical object in the building.
- A partial/truncated folder or expired cursor should be scanned separately with `--root "EXACT_ID"` and a **new output directory**. A new folder scan starts its paging from the beginning. Snapshots are not automatically merged or imported into dashboard configuration.
- `--export-only` inherits the current scope without modifying pruning. To change scope offline, use `--resume --prune-only --profile catalog` or `full`.

Exit codes: `0` = discovered queue drained without errors/partial folders (legacy `unknown` status is allowed); `2` = pending work, failed/partial folders, or the consecutive-failure stop; `1` = setup/authentication/fatal error; `130` = interrupted. Check `summary.json` even after exit 0 for unconfirmed legacy completeness.

Run the local fixture tests (no real controller required):

```powershell
python -m unittest discover -s tools/ews-topology -p "test_*.py" -v
```
