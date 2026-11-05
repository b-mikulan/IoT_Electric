const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { parseWidgets } = require("../dashboard/lib/config");
const { historyDefinitions } = require("./historyExport");

function prepareWidgetImport(catalog, { building = "default", snapshotId, existingWidgets = [] } = {}) {
  // Validate the existing configuration before reusing any personal settings.
  parseWidgets(JSON.stringify(existingWidgets), false);
  const existing = new Map(existingWidgets.map((widget) => [widget.id, widget]));
  const snapshot = catalog.snapshot({ building, snapshotId });
  const widgets = [];
  const metadataById = Object.create(null);
  for (let offset = 0; ; offset += 1000) {
    const page = catalog.listPoints({ building, snapshotId: snapshot.id, nativeOnly: true, limit: 1000, offset });
    for (const point of page.items) {
      if (point.id !== point.id.trim()) throw new Error(`Dashboard would alter the exact point ID: ${JSON.stringify(point.id)}.`);
      const previous = existing.get(point.id);
      const widget = {
        id: point.id, label: point.name || point.id, description: point.description,
        unit: /^none$/i.test(point.unit) ? "" : point.unit, writable: false, visible: true,
      };
      for (const key of ["label", "description", "unit", "precision", "group", "writable", "visible"]) {
        if (previous && Object.hasOwn(previous, key)) widget[key] = previous[key];
      }
      widgets.push(widget);
      metadataById[point.id] = {
        id: point.id, name: point.name, description: point.description, type: point.type,
        unit: point.unit, writeable: point.writeable, forceable: point.forceable,
        enumId: point.enum_id,
        ...(point.metadata.enumValues === undefined ? {} : { enumValues: point.metadata.enumValues }),
      };
    }
    if (offset + page.items.length >= page.total) break;
  }
  if (!widgets.length) throw new Error("This catalog snapshot has no native points to import.");
  parseWidgets(JSON.stringify(widgets), false);
  const roomByZone = Object.create(null);
  for (const room of catalog.db.prepare("SELECT DISTINCT room_source, room_label FROM devices WHERE snapshot_id = ? AND room_source IS NOT NULL AND room_label IS NOT NULL").all(snapshot.id)) {
    roomByZone[room.room_source] = room.room_label;
  }
  const ids = new Set(widgets.map((widget) => widget.id));
  const retained = widgets.filter((widget) => existing.has(widget.id)).length;
  const removedIds = existingWidgets.filter((widget) => !ids.has(widget.id)).map((widget) => widget.id);
  return {
    widgets,
    metadata: { schemaVersion: 1, catalog: { buildingKey: building, snapshotId: snapshot.id, capturedAt: snapshot.captured_at }, metadataById, roomByZone,
      ...historyDefinitions(catalog, { building, snapshotId: snapshot.id }) },
    summary: {
      building, snapshotId: snapshot.id, capturedAt: snapshot.captured_at, points: widgets.length,
      added: widgets.length - retained, retained, removed: removedIds.length, removedIds,
      visible: widgets.filter((widget) => widget.visible !== false).length,
      writable: widgets.filter((widget) => widget.writable === true).length,
      deviceGroups: catalog.listDevices({ building, snapshotId: snapshot.id, limit: 1 }).total,
      roomDescriptions: Object.keys(roomByZone).length,
    },
  };
}

function readExisting(filename) {
  try { return fs.readFileSync(filename, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function importWidgets(catalog, { widgetsFile, metadataFile = path.join(path.dirname(widgetsFile), "catalog-metadata.json"), backupDirectory,
  apply = false, ...options } = {}) {
  const files = [widgetsFile, metadataFile].map((filename) => path.resolve(filename));
  if (files.some((filename) => path.extname(filename).toLowerCase() !== ".json")) throw new Error("Widget and metadata targets must be JSON files.");
  if (files[0].toLowerCase() === files[1].toLowerCase()) throw new Error("Widget and metadata files must be separate.");
  const original = files.map(readExisting);
  const prepared = prepareWidgetImport(catalog, { ...options, existingWidgets: original[0] === null ? [] : JSON.parse(original[0].replace(/^\uFEFF/, "")) });
  if (!apply) return { applied: false, widgetsFile: files[0], metadataFile: files[1], ...prepared.summary };
  const backup = path.resolve(backupDirectory || path.join("output", "building-catalog", "widget-backups"), new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8));
  fs.mkdirSync(backup, { recursive: true });
  const saved = ["widgets.json", "catalog-metadata.json"];
  original.forEach((content, index) => { if (content !== null) fs.writeFileSync(path.join(backup, saved[index]), content, { flag: "wx" }); });
  fs.writeFileSync(path.join(backup, "manifest.json"), JSON.stringify({ files, existed: original.map((value) => value !== null), ...prepared.summary }, null, 2) + "\n", { flag: "wx" });
  const payloads = [prepared.widgets, prepared.metadata].map((value) => JSON.stringify(value, null, 2) + "\n");
  const temporary = files.map((filename) => `${filename}.${randomUUID()}.tmp`);
  let replaced = 0;
  try {
    files.forEach((filename, index) => {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(temporary[index], payloads[index], { flag: "wx" });
    });
    // Publish descriptors first; they are safe for the existing smaller config.
    for (const index of [1, 0]) { fs.renameSync(temporary[index], files[index]); replaced += 1; }
  } catch (error) {
    if (replaced) {
      if (original[1] === null) fs.unlinkSync(files[1]);
      else fs.writeFileSync(files[1], original[1]);
    }
    throw error;
  } finally {
    for (const filename of temporary) { if (fs.existsSync(filename)) fs.unlinkSync(filename); }
  }
  return { applied: true, widgetsFile: files[0], metadataFile: files[1], backup, ...prepared.summary };
}

module.exports = { prepareWidgetImport, importWidgets };
