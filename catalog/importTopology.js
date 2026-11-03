const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { BuildingCatalog } = require("./store");
const { buildDevices } = require("../dashboard/public/deviceModel");
const { deriveWidgetGrouping } = require("../dashboard/public/widgetGrouping");

const KINDS = new Set(["container", "value", "history", "alarm"]);
const text = (value) => value === null || value === undefined ? "" : String(value);
const field = (data, name) => data[name] ?? data[name[0].toUpperCase() + name.slice(1)];
const triFlag = (value) => [true, 1, "1", "true"].includes(value) ? 1 : [false, 0, "0", "false"].includes(value) ? 0 : null;

function objectJson(raw, context) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Invalid object in ${context}.`);
  return data;
}

function recognizerHash() {
  const hash = createHash("sha256");
  for (const filename of ["deviceModel.js", "widgetGrouping.js"]) hash.update(fs.readFileSync(path.join(__dirname, "..", "dashboard", "public", filename)));
  return hash.digest("hex");
}

// A read transaction captures a consistent checkpoint, including when a mapper
// has committed more pages since the last JSON export. This connection never writes.
function readCheckpoint(filename) {
  if (!fs.statSync(filename).isFile()) throw new Error("Checkpoint must be a SQLite file.");
  const source = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
  try {
    source.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN;");
    const settingsRows = source.prepare("SELECT data FROM settings").all();
    if (settingsRows.length !== 1) throw new Error("Expected exactly one mapper settings record.");
    const settings = objectJson(settingsRows[0].data, "checkpoint settings");
    if (settings.schemaVersion !== 1 || typeof settings.url !== "string" || typeof settings.rootId !== "string") throw new Error("Unsupported topology checkpoint settings.");
    const containers = source.prepare("SELECT * FROM containers ORDER BY id").all();
    if (!containers.some((c) => c.id === settings.rootId)) throw new Error("Checkpoint root is missing.");
    const items = source.prepare("SELECT kind, id, data FROM items ORDER BY kind, id").all().map((row) => {
      if (!KINDS.has(row.kind) || typeof row.id !== "string" || (!row.id && row.kind !== "container")) throw new Error("Invalid checkpoint item kind or ID.");
      const data = objectJson(row.data, `item ${row.id}`);
      if (field(data, "id") !== row.id) throw new Error(`Item ID mismatch for ${row.id}.`);
      return { ...row, metadata: data };
    });
    const links = source.prepare("SELECT parent_id, kind, id FROM links ORDER BY parent_id, kind, id").all();
    const hash = createHash("sha256");
    const feed = (value) => hash.update(JSON.stringify(value) + "\n");
    const modelHash = recognizerHash();
    // The format version also identifies this importer's interpretation of data.
    feed({ catalogImportVersion: 1, modelHash, settings });
    containers.forEach(feed);
    items.forEach((row) => feed([row.kind, row.id, row.data]));
    links.forEach(feed);
    const pageStats = new Map();
    const errors = [];
    let capturedAt = null;
    let pages = 0;
    let seconds = 0;
    for (const page of source.prepare("SELECT seq, container_id, request_token, data, fetched_at, seconds FROM pages ORDER BY seq").iterate()) {
      feed(page);
      const payload = objectJson(page.data, `page ${page.seq}`);
      if (!Array.isArray(payload.containers) || !Array.isArray(payload.errors || [])) throw new Error(`Invalid topology page ${page.seq}.`);
      const stats = pageStats.get(page.container_id) || { pages: 0, lastFetchedAt: null };
      stats.pages += 1;
      if (!stats.lastFetchedAt || page.fetched_at > stats.lastFetchedAt) stats.lastFetchedAt = page.fetched_at;
      pageStats.set(page.container_id, stats);
      if (!capturedAt || page.fetched_at > capturedAt) capturedAt = page.fetched_at;
      for (const [ordinal, error] of (payload.errors || []).entries()) {
        errors.push({ containerId: page.container_id, seq: page.seq, ordinal, fetchedAt: page.fetched_at, data: error });
      }
      pages += 1;
      seconds += page.seconds || 0;
    }
    const states = {};
    for (const container of containers) states[container.state] = (states[container.state] || 0) + 1;
    const kinds = {};
    for (const item of items) kinds[item.kind] = (kinds[item.kind] || 0) + 1;
    const summary = {
      containers: containers.length, states, items: kinds, pages,
      requestSeconds: Math.round(seconds * 1000) / 1000,
      discoveryProfile: settings.discoveryProfile || "full",
      traversalFinished: !states.pending,
      completenessConfirmed: !["pending", "error", "partial", "unknown", "pruned"].some((state) => states[state]),
    };
    return { settings, containers, items, links, pageStats, errors, capturedAt, summary, modelHash, fingerprint: hash.digest("hex") };
  } finally {
    source.close();
  }
}

function deviceModels(data) {
  const metadataById = Object.create(null);
  const roomByZone = Object.create(null);
  const widgets = [];
  for (const item of data.items) {
    if (item.kind === "container" && item.id.startsWith("00/") && /\/Zones\/[^/]+$/.test(item.id)) {
      const description = text(field(item.metadata, "description"));
      if (description) roomByZone[item.id.slice(3)] = description;
    }
    if (item.kind !== "value" || !item.id.startsWith("01/")) continue;
    const metadata = {};
    for (const key of ["name", "description", "unit", "type", "writeable", "forceable", "enumId", "enumValues"]) {
      const value = field(item.metadata, key);
      if (value !== undefined) metadata[key] = value;
    }
    metadataById[item.id] = metadata;
    // Offline definitions do not provide live state or permission to write.
    widgets.push({ id: item.id, label: text(metadata.name) || item.id, description: text(metadata.description), unit: text(metadata.unit), writable: false });
  }
  return buildDevices(widgets, { metadataById, roomByZone });
}

function sameFile(first, second) {
  if (path.resolve(first) === path.resolve(second)) return true;
  if (!fs.existsSync(second)) return false;
  const a = fs.statSync(first);
  const b = fs.statSync(second);
  return fs.realpathSync(first) === fs.realpathSync(second) || (a.ino !== 0 && a.dev === b.dev && a.ino === b.ino);
}

function importTopology({ checkpoint, database, building = "default", label } = {}) {
  if (!checkpoint || !database) throw new Error("checkpoint and database paths are required.");
  if (typeof building !== "string" || !building.trim()) throw new Error("A non-empty building key is required.");
  if (label !== undefined && (typeof label !== "string" || !label.trim())) throw new Error("Building label must be non-empty.");
  if (sameFile(checkpoint, database)) throw new Error("The catalog database must be separate from the mapper checkpoint.");
  const data = readCheckpoint(checkpoint);
  const models = deviceModels(data);
  fs.mkdirSync(path.dirname(path.resolve(database)), { recursive: true });
  const catalog = new BuildingCatalog(database, { readOnly: false });
  try {
    return catalog.transaction(() => {
      const existing = catalog.db.prepare("SELECT * FROM buildings WHERE key = ?").get(building);
      if (existing && (existing.source_url !== data.settings.url || existing.root_id !== data.settings.rootId)) {
        throw new Error("This building key belongs to a different source URL or scan root. Choose a separate --building key.");
      }
      catalog.db.prepare(`INSERT INTO buildings(key, label, source_url, root_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET label = excluded.label`).run(building, label || existing?.label || building, data.settings.url, data.settings.rootId);
      const previous = catalog.db.prepare("SELECT id FROM snapshots WHERE building_key = ? AND fingerprint = ?").get(building, data.fingerprint);
      if (previous) return { imported: false, snapshotId: previous.id, summary: catalog.summary({ building, snapshotId: previous.id }) };
      const inserted = catalog.db.prepare(`INSERT INTO snapshots(building_key, fingerprint, imported_at, captured_at, started_at,
        discovery_profile, metadata_requested, recognizer_hash, source_summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        building, data.fingerprint, new Date().toISOString(), data.capturedAt, data.settings.startedAt || null,
        data.summary.discoveryProfile, Number(Boolean(data.settings.metadata)), data.modelHash, JSON.stringify(data.summary));
      const snapshotId = Number(inserted.lastInsertRowid);
      saveObjects(catalog.db, snapshotId, data);
      saveDevices(catalog.db, snapshotId, data, models);
      return { imported: true, snapshotId, summary: catalog.summary({ building, snapshotId }) };
    });
  } finally {
    catalog.close();
  }
}

function saveObjects(db, snapshotId, data) {
  const object = db.prepare("INSERT INTO objects VALUES (?, ?, ?, ?, ?, ?, ?)");
  const point = db.prepare("INSERT INTO points(snapshot_id, id, native, unit, writeable, forceable, enum_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const container = db.prepare(`INSERT INTO containers(snapshot_id, id, parent_id, state, issue, last_error, prune_reason,
    resume_state, paging_unknown, pages, last_fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const relation = db.prepare("INSERT INTO relations VALUES (?, ?, ?, ?)");
  const reference = db.prepare("INSERT INTO point_references VALUES (?, ?, ?, ?, ?, ?)");
  const itemError = db.prepare("INSERT INTO item_errors VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const pointIds = new Set(data.items.filter((i) => i.kind === "value").map((i) => i.id));
  for (const { kind, id, metadata, data: raw } of data.items) {
    object.run(snapshotId, kind, id, text(field(metadata, "name")), text(field(metadata, "description")), text(field(metadata, "type")), raw);
    if (kind === "value") point.run(snapshotId, id, Number(id.startsWith("01/")), text(field(metadata, "unit")), triFlag(field(metadata, "writeable") ?? field(metadata, "writable")), triFlag(field(metadata, "forceable")), text(field(metadata, "enumId")));
  }
  for (const row of data.containers) {
    const stats = data.pageStats.get(row.id);
    container.run(snapshotId, row.id, row.parent_id, row.state, row.issue || "", row.last_error || "", row.prune_reason || "", row.resume_state || "", Number(Boolean(row.unknown)), stats?.pages || 0, stats?.lastFetchedAt || null);
  }
  for (const link of data.links) relation.run(snapshotId, link.parent_id, link.kind, link.id);
  for (const { kind, id, metadata } of data.items) {
    if (kind === "value" && id.startsWith("11/") && id.endsWith("/Value")) {
      const target = `01/${id.slice(3, -6)}`;
      reference.run(snapshotId, kind, id, "value-property", target, pointIds.has(target) ? target : null);
    }
    const target = field(metadata, "valueItemId");
    if ((kind === "history" || kind === "alarm") && typeof target === "string" && target) {
      reference.run(snapshotId, kind, id, "value-item", target, pointIds.has(target) ? target : null);
    }
  }
  for (const error of data.errors) {
    itemError.run(snapshotId, error.containerId, error.seq, error.ordinal, typeof error.data?.id === "string" ? error.data.id : typeof error.data?.Id === "string" ? error.data.Id : null,
      text(error.data?.message ?? error.data?.Message ?? error.data ?? "EWS item error"), error.fetchedAt, JSON.stringify(error.data));
  }
}

function saveDevices(db, snapshotId, data, models) {
  const containerIds = new Set(data.containers.map((c) => c.id));
  const device = db.prepare("INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const devicePoint = db.prepare("INSERT INTO device_points VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const model of models) {
    const points = [...model.primary, ...model.diagnostics, ...model.other];
    const grouping = deriveWidgetGrouping(points[0]?.id);
    const candidate = `00/${model.key.replace(/^01\//, "")}`;
    device.run(snapshotId, model.key, model.label, model.type, grouping.kind, model.context, model.room?.label || null,
      model.room?.source || null, containerIds.has(candidate) ? candidate : null, model.reason, model.pointsCount);
    for (const point of points) {
      devicePoint.run(snapshotId, model.key, point.id, point.role, point.importance, point.label, point.reason,
        Number(point.command), Number(Boolean(point.roleAmbiguous)), JSON.stringify(point.metadata.enumValues || []));
    }
  }
}

module.exports = { importTopology, readCheckpoint };
