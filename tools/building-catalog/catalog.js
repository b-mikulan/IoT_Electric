#!/usr/bin/env node
const path = require("node:path");
const { parseArgs } = require("node:util");
const { BuildingCatalog } = require("../../catalog/store");
const { importTopology } = require("../../catalog/importTopology");
const { importWidgets } = require("../../catalog/widgetExport");

const HELP = `Offline building catalog (Node 24+, no additional packages)

  npm run catalog -- import [--checkpoint output/ews-topology/checkpoint.sqlite]
  npm run catalog -- summary
  npm run catalog -- devices [--type climate] [--search ACX01]
  npm run catalog -- device --id "exact device key"
  npm run catalog -- containers [--parent "exact container ID"] [--state error]
  npm run catalog -- container --id "exact container ID"
  npm run catalog -- points [--native-only] [--parent "exact container ID"]
  npm run catalog -- point --id "exact point ID"
  npm run catalog -- snapshots
  npm run catalog -- widgets [--apply] [--widgets-file dashboard/config/widgets.json]

Common options:
  --database PATH    Default: output/building-catalog/catalog.sqlite
  --building KEY     Default: default; separates sources and scan roots
  --snapshot ID      Read a specific imported snapshot (otherwise latest)
  --search TEXT      Search names, paths and descriptions/rooms
  --limit NUMBER     Page size 1..1000 (default 50)
  --offset NUMBER    Number of results to skip (default 0)
  --label TEXT       Building name when importing
  --widgets-file PATH   Widget configuration to populate from native points
  --metadata-file PATH  Saved descriptions (default: catalog-metadata.json beside widgets)
  --apply               Save widget import with a backup; omit for a dry run

All commands use local files. The widgets command changes widget files only with --apply.
No command contacts EWS or reads live values.
`;

function integer(value, name) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be an integer.`);
  return Number(value);
}

function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, database: { type: "string", default: "output/building-catalog/catalog.sqlite" },
    checkpoint: { type: "string", default: "output/ews-topology/checkpoint.sqlite" }, building: { type: "string", default: "default" },
    label: { type: "string" }, snapshot: { type: "string" }, type: { type: "string" }, search: { type: "string" },
    id: { type: "string" }, parent: { type: "string" }, state: { type: "string" },
    limit: { type: "string" }, offset: { type: "string" }, "native-only": { type: "boolean" },
    "widgets-file": { type: "string", default: "dashboard/config/widgets.json" }, "metadata-file": { type: "string" }, apply: { type: "boolean" },
  } });
  if (values.help || !positionals.length) { console.log(HELP); return; }
  if (positionals.length !== 1) throw new Error("Expected one command. Use --help for usage.");
  const command = positionals[0];
  const database = path.resolve(values.database);
  if (command === "import") {
    console.log(JSON.stringify(importTopology({ checkpoint: path.resolve(values.checkpoint), database, building: values.building, label: values.label }), null, 2));
    return;
  }
  const options = { building: values.building, search: values.search, type: values.type, state: values.state, parentId: values.parent,
    nativeOnly: values["native-only"],
    ...(values.snapshot === undefined ? {} : { snapshotId: integer(values.snapshot, "snapshot") }),
    ...(values.limit === undefined ? {} : { limit: integer(values.limit, "limit") }),
    ...(values.offset === undefined ? {} : { offset: integer(values.offset, "offset") }),
  };
  const commands = {
    summary: (catalog) => catalog.summary(options), snapshots: (catalog) => catalog.listSnapshots(options),
    containers: (catalog) => catalog.listContainers(options), points: (catalog) => catalog.listPoints(options), devices: (catalog) => catalog.listDevices(options),
    container: (catalog) => catalog.getContainer(values.id, options), point: (catalog) => catalog.getPoint(values.id, options), device: (catalog) => catalog.getDevice(values.id, options),
    widgets: (catalog) => importWidgets(catalog, { ...options, widgetsFile: values["widgets-file"], metadataFile: values["metadata-file"], apply: values.apply }),
  };
  if (!commands[command]) throw new Error(`Unknown command ${command}. Use --help for usage.`);
  if (["container", "point", "device"].includes(command) && values.id === undefined) throw new Error("--id is required for this command.");
  const catalog = new BuildingCatalog(database);
  try {
    const result = commands[command](catalog);
    if (result === null) throw new Error("Requested item was not found in this snapshot.");
    console.log(JSON.stringify(result, null, 2));
  } finally { catalog.close(); }
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`Catalog: ${error.message}`); process.exitCode = 1; }
}

module.exports = { main };
