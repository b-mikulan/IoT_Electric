# Building catalog in SQLite

This is the persistent, offline catalog of the discovered building: containers, point definitions, graph relationships, device groups and recognized functions. It imports the mapper's **SQLite checkpoint directly**, so it does not depend on potentially stale JSON exports. Catalog commands never contact EWS or middleware, read credentials, or poll live values. The `widgets --apply` command explicitly populates dashboard widget files from the saved catalog.

Requires the project's **Node 24+**, using its built-in `node:sqlite` module. No additional packages or database service are required. Node 24 currently prints an experimental-module notice when loading SQLite.

## Import the existing building

From the repository root:

```powershell
npm run catalog -- import --label "03AS001"
```

Defaults:

- Source: `output/ews-topology/checkpoint.sqlite`, opened read-only in a consistent read transaction.
- Catalog: `output/building-catalog/catalog.sqlite`, separate from the mapper's progress database.
- Building key: `default`.

An identical import returns `imported: false` and reuses its snapshot. Changed source data or changed dashboard recognition rules create a new immutable snapshot in one transaction. Failed imports roll back their rows. A catalog cannot overwrite the checkpoint or reuse an unrelated database file.

The source mapper may be stopped or finished. If it is still running, the catalog captures its committed progress, including pending and partial containers. Import again after mapping advances. There is no automatic import or background crawl.

## Inspect and search

```powershell
npm run catalog -- summary
npm run catalog -- devices --type climate
npm run catalog -- devices --search ACX01
npm run catalog -- device --id "03AS001/[Modbus Serial Client A]/ACX01"
npm run catalog -- containers --state error
npm run catalog -- containers --parent "00/03AS001/[Modbus Serial Client A]/ACX01"
npm run catalog -- container --id "00/03AS001/[Modbus Serial Client A]/ACX01/Points"
npm run catalog -- points --native-only --search RmTmp
npm run catalog -- point --id "01/03AS001/[Modbus Serial Client A]/ACX01/Points/Holding Registers/EffSpt"
npm run catalog -- snapshots
npm run catalog -- trends --search AC101
```

Lists return `total`, `limit`, `offset` and `items`. Default page size is 50, maximum 1000; use `--limit 100 --offset 100` to continue. Search matches labels, paths, descriptions or room names, ignoring case and accents. A parent filter uses actual saved links, including additional parents, rather than assuming that IDs form filesystem paths. `--id` for `device` is the exact owner key shown by `devices`; for `point` and `container` it is the exact EWS ID. IDs retain case and whitespace.

To read an older snapshot:

```powershell
npm run catalog -- summary --snapshot 1
npm run catalog -- devices --snapshot 1 --type climate
```

The default view is the most recently **imported distinct snapshot** for that building. A point missing from a newer, partial scan is not declared deleted: earlier observations remain queryable in their original snapshots. Older snapshots are not merged into a new view, and there is no automatic removal or retention policy. Each distinct snapshot stores its full catalog metadata and relationships, so database size grows with retained snapshots; raw EWS pages remain only in the original checkpoint.

## Populate the dashboard with native points

Review the import, then apply it:

```powershell
npm run catalog -- widgets
npm run catalog -- widgets --apply
docker compose up -d --build --no-deps dashboard
```

This exports **all native `01/` points** from one pinned catalog snapshot into `dashboard/config/widgets.json`, plus `catalog-metadata.json` beside it. It replaces the configured point set with those native points, including readings, commands and diagnostics, leaving `11/` references and technical properties in the catalog. Existing native point labels, descriptions, units, precision, group overrides, write flags and visibility are retained. Newly added points are visible and read-only. Existing device-card settings remain in `device-widgets.json` and are not replaced.

Before changing files, it saves the original widget list, any previous descriptor file and an import manifest under `output/building-catalog/widget-backups/<timestamp>/`. The dry run reports points added, retained and removed. Override destinations with `--widgets-file PATH` and `--metadata-file PATH`; both must be JSON files. This is a local configuration export, not a live dashboard API call: restart the dashboard after applying it. The catalog remains the source of the exported definitions.

The dashboard automatically detects `catalog-metadata.json` beside `WIDGETS_FILE`, or accepts an explicit `DEVICE_METADATA_FILE` (`DASHBOARD_DEVICE_METADATA_FILE` in Compose). It uses these saved descriptors and full-path room labels for **all** configured points, without the live metadata client's 2000-point cap and without another EWS structure crawl. Missing descriptions produce a warning instead of triggering controller reads. Re-export and restart after updating the catalog. Reads of live values continue through the ordinary bounded, sequential value batches; displaying an imported point does not enable writes. Any command still performs the existing fresh controller permission/state/enum checks before sending.

The device view supports name/path/room search, device-type filtering and expandable room filters. Filters combine without changing which points are polled or their stored configuration.

## Multiple sources and scan roots

```powershell
npm run catalog -- import --checkpoint output/other-building/checkpoint.sqlite --building building-b --label "Building B"
npm run catalog -- summary --building building-b
```

All commands also accept `--database PATH`. A building key is bound to its source middleware URL and scan root. Importing a different URL or root under the same key fails, preventing a small subtree from replacing the view of an entire building. Use a separate key for a targeted subtree. Matching IDs in different buildings remain separate. If a middleware URL changes for the same physical source, use a new key for now; there is no source-rebinding command.

## What is stored

| Table | Content |
| --- | --- |
| `buildings`, `snapshots` | Source identity, capture/import times, discovery profile, recognition hash, completeness summary and import fingerprint |
| `objects` | Exact IDs and original metadata for containers, values, histories and alarm definitions |
| `containers` | First discovered parent, scan state, page count, last page time, errors and pruning reasons |
| `points` | All value definitions, including `01/` native points and `11/` properties; unit, writeability, forceability and enum ID |
| `relations` | Every observed parent/object link; multiple parents and cycles are retained |
| `devices`, `device_points` | Groups from native points, device type, source container when present, rooms, recognized roles, options and ambiguous command roles |
| `point_references` | Value-property aliases and explicit history/alarm value links; unresolved target strings remain explicit |
| `item_errors` | Original item errors from saved pages, with container, affected item and capture time |

Device grouping and function recognition reuse `deviceModel.js` and `widgetGrouping.js` under `dashboard/public/devices/`. The catalog does not create a competing set of AC, blind or light naming rules. Only saved native `01/` points feed the device model; auxiliary properties remain searchable without turning every configuration object into another device. Counts are **recognized groups**, not a verified census of physical equipment. Room labels come from saved zone descriptions where available; they are not guessed from matching short names.

`writeable` is the capability advertised in saved metadata; missing or unrecognized flags remain `null`. A recognized command is a semantic role, not permission to send it. Options may come from saved metadata or from descriptions such as `0=Off,1=On`. Queries return `requiresLiveValidation: true`; the catalog stores no live readings, write permissions, validated operating ranges or executable controls. History and alarm records are definitions captured during mapping, not downloaded trend samples or current active-alarm counts. Any state inside their original metadata belongs to that capture time.

Pruned, failed, partial and legacy paging-unknown containers remain visible with their original states. A finished traversal does not imply complete physical coverage. References resolve only to exact point IDs actually saved in that snapshot; unresolved properties do not fabricate native points.

## Use from application code

The reusable data layer is `catalog/store.js`; the command-line tool wraps it. It opens read-only by default:

```javascript
const { BuildingCatalog } = require("./catalog/store");
const catalog = new BuildingCatalog("output/building-catalog/catalog.sqlite");
try {
  const devices = catalog.listDevices({ building: "default", type: "climate", limit: 100 });
  const ac = catalog.getDevice("03AS001/[Modbus Serial Client A]/ACX01");
} finally {
  catalog.close();
}
```

The dashboard integration currently uses the explicit widget/descriptor export described above; it does not open the catalog database directly. Discovery and live polling retain their existing behavior. Always pin a `snapshotId` when several catalog queries must use the same view while imports run. Data access is synchronous, so bulk imports belong in this CLI or a dedicated worker rather than an HTTP request handler.

## Searchable trend list

The catalog retains EWS HistoryItem definitions independently of live point
widgets. `trends` lists these with their exact history IDs, descriptions, units,
explicit `ValueItemId` links and all observed parent containers. Ordinary
`widgets --apply` exports also include them in `catalog-metadata.json`.

To add the complete saved trend list to an existing dashboard **without
replacing its curated widgets, room assignments or descriptions**:

```powershell
npm run catalog -- trends --apply
docker compose up -d --build --no-deps dashboard
```

This changes only the descriptor file and saves its original under
`output/building-catalog/history-backups/`. It exports the full pinned snapshot,
independently of list pagination/search options. The dashboard's **Trendovi i
alarmi** page reads this local list and offers search, pagination and direct
selection. Device/room labels are added only from explicit point references;
similar names do not establish bindings. The original folder browser remains
available for newly created trends absent from the snapshot. Selecting/searching
a definition does not fetch samples; the chosen history and time range are
queried only when the user presses **Dohvati trend**. Version-2 dashboard backups
retain the list and its capture time, including trends whose source point is not
configured as a widget.

The catalog uses SQLite WAL transactions for atomic imports and concurrent readers, with a five-second busy timeout. For a plain-file backup, close catalog processes first and then copy the database; an active WAL file may contain committed changes and must not be omitted from a backup. Keep the original mapper checkpoint for raw pages and scan resumption. Generated catalog data is covered by the ignored `output/` directory.

## Tests

```powershell
node --test test/buildingCatalog.test.js
npm run test:tools
```

Fixtures cover read-only source access, graph aliases/cycles, native grouping, explicit unresolved references, snapshot deduplication and history, rollback, separate buildings, accidental database reuse, legacy checkpoints, ambiguous command roles, search/pagination and the CLI. No real controller is used.
