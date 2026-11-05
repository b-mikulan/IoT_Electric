const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeHistoryItems } = require("../dashboard/lib/historyCatalog");

function historyDefinitions(catalog, { building = "default", snapshotId } = {}) {
  const snapshot = catalog.snapshot({ building, snapshotId });
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const page = catalog.listHistories({ building, snapshotId: snapshot.id, limit: 1000, offset });
    items.push(...page.items);
    if (offset + page.items.length >= page.total) break;
  }
  return { historyItems: normalizeHistoryItems(items), historyCatalog: { buildingKey: building, snapshotId: snapshot.id, capturedAt: snapshot.captured_at } };
}

function importHistories(catalog, { metadataFile = "dashboard/config/catalog-metadata.json", apply = false, backupDirectory = "output/building-catalog/history-backups", ...options } = {}) {
  const file = path.resolve(metadataFile);
  if (path.extname(file).toLowerCase() !== ".json") throw new Error("History metadata must be a JSON file.");
  const original = fs.readFileSync(file);
  const metadata = JSON.parse(original.toString("utf8").replace(/^\uFEFF/, ""));
  if (metadata?.schemaVersion !== 1 || !metadata.metadataById || !metadata.roomByZone) throw new Error("Export the building descriptors before adding its trend list.");
  const definitions = historyDefinitions(catalog, options);
  if (metadata.catalog?.buildingKey && metadata.catalog.buildingKey !== definitions.historyCatalog.buildingKey) throw new Error("Trend catalog belongs to a different building.");
  const summary = { metadataFile: file, ...definitions.historyCatalog, trends: definitions.historyItems.length,
    explicitPointLinks: definitions.historyItems.filter(item => item.valueItemId).length, applied: false };
  if (!apply) return summary;
  const backup = path.resolve(backupDirectory, `${new Date().toISOString().replace(/:/g, "-")}-${randomUUID()}`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, "catalog-metadata.json"), original, { flag: "wx", flush: true });
    fs.writeFileSync(temporary, `${JSON.stringify({ ...metadata, ...definitions }, null, 2)}\n`, { flag: "wx", flush: true });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { ...summary, applied: true, backup };
}

module.exports = { historyDefinitions, importHistories };
