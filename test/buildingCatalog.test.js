const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { BuildingCatalog } = require("../catalog/store");
const { importTopology } = require("../catalog/importTopology");
const { prepareWidgetImport, importWidgets } = require("../catalog/widgetExport");
const { historyDefinitions, importHistories } = require("../catalog/historyExport");

const owner = "AS/Zones/Z1/AC01";
const pointsFolder = `00/${owner}/Points`;
const pointId = (name) => `01/${owner}/Points/${name}`;
const hash = (filename) => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");

function fixture(t, { legacy = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iot-building-catalog-"));
  const readers = [];
  t.after(() => {
    for (const reader of readers) reader.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const checkpoint = path.join(directory, "checkpoint.sqlite");
  const database = path.join(directory, "catalog.sqlite");
  const db = new DatabaseSync(checkpoint);
  db.exec(`CREATE TABLE settings(data TEXT);
    CREATE TABLE containers(id TEXT PRIMARY KEY, parent_id TEXT, name TEXT, state TEXT, token TEXT DEFAULT '',
      issue TEXT DEFAULT '', last_error TEXT DEFAULT '', unknown INTEGER DEFAULT 0${legacy ? "" : ", prune_reason TEXT DEFAULT '', resume_state TEXT DEFAULT ''"});
    CREATE TABLE items(kind TEXT, id TEXT, data TEXT, PRIMARY KEY(kind, id));
    CREATE TABLE links(parent_id TEXT, kind TEXT, id TEXT, PRIMARY KEY(parent_id, kind, id));
    CREATE TABLE pages(seq INTEGER PRIMARY KEY, container_id TEXT, request_token TEXT, data TEXT, fetched_at TEXT, seconds REAL);`);
  db.prepare("INSERT INTO settings VALUES (?)").run(JSON.stringify({ url: "http://middleware:3000", rootId: "", schemaVersion: 1,
    startedAt: "2026-10-26T10:00:00Z", metadata: false, discoveryProfile: "catalog" }));
  const addObject = db.prepare("INSERT INTO items VALUES (?, ?, ?)");
  const addLink = db.prepare("INSERT INTO links VALUES (?, ?, ?)");
  const addContainer = db.prepare("INSERT INTO containers(id, parent_id, name, state, unknown) VALUES (?, ?, ?, ?, ?)");
  for (const [id, parent, state] of [["", null, "unknown"], ["00/AS", "", "done"], ["00/AS/Zones/Z1", "00/AS", "done"],
    [`00/${owner}`, "00/AS/Zones/Z1", "done"], [pointsFolder, `00/${owner}`, "partial"],
    ["opaque alias ", "", "done"], ["00/dead", "", "pruned"], ["00/error", "", "error"]]) {
    addContainer.run(id, parent, id || "EWS", state, Number(state === "unknown"));
    addObject.run("container", id, JSON.stringify({ id, name: id || "EWS", description: id === "00/AS/Zones/Z1" ? "Kuhinja Čajna" : "", type: "folder" }));
    if (parent !== null) addLink.run(parent, "container", id);
  }
  addLink.run("opaque alias ", "container", pointsFolder);
  addLink.run(pointsFolder, "container", "00/AS"); // A real cycle, not a path-derived tree.
  db.prepare("UPDATE containers SET last_error = ? WHERE id = ?").run("HTTP 504", "00/error");
  db.prepare("UPDATE containers SET issue = ? WHERE id = ?").run("INVALID_REFERENCE", pointsFolder);
  if (!legacy) db.prepare("UPDATE containers SET prune_reason = ? WHERE id = ?").run("Technical folder: Programs", "00/dead");
  const add = (kind, id, metadata, parent = pointsFolder) => {
    addObject.run(kind, id, JSON.stringify(kind === "container" || kind === "value" ? { id, ...metadata } : { Id: id, ...metadata }));
    addLink.run(parent, kind, id);
  };
  for (const [name, unit, writeable, description] of [["RmTmp", "°C", 0, "Room temperature"], ["EffSpt", "°C", 1, "Setpoint"],
    ["FanSpd", "none", 1, "0=Auto,1=High,2=Low"], ["OnOffMd", "none", 1, "0=Off,1=On"],
    ["SysMdCtrl", "none", 1, "0=Heat,1=Cool"], ["SysMdSts", "none", 0, "0=Heat,1=Cool"]]) {
    add("value", pointId(name), { name, unit, writeable, forceable: 0, type: "double", description });
  }
  add("value", "01/AS2/Zones/Z1/AC01/Points/RmTmp", { name: "RmTmp", unit: "°C", writeable: "unconfirmed" });
  add("value", `11/${owner}/Points/EffSpt/Value`, { name: "Value", writeable: 1 });
  add("value", `11/${owner}/Points/Missing/Value`, { name: "Value", writeable: 1 });
  add("value", `11/${owner}/Status`, { name: "Status", writeable: 1, extra: { nested: [1, 2] } });
  add("history", "03/history-ok", { Name: "Temperature trend", ValueItemId: pointId("RmTmp") });
  add("history", "03/history-missing", { Name: "Unresolved", ValueItemId: "01/not-in-snapshot " });
  add("alarm", "02/alarm", { Name: "Property alarm", ValueItemId: `11/${owner}/Status`, State: "3" });
  const payload = { containers: [], errors: [{ id: "03/missing ", message: "INVALID_REFERENCE" }], status: null, complete: false };
  db.prepare("INSERT INTO pages VALUES (1, ?, '', ?, ?, 0.75)").run(pointsFolder, JSON.stringify(payload), "2026-10-28T18:27:07Z");
  db.close();
  const mutate = (callback) => {
    const source = new DatabaseSync(checkpoint);
    try { callback(source); } finally { source.close(); }
  };
  const open = () => {
    const catalog = new BuildingCatalog(database);
    readers.push(catalog);
    return catalog;
  };
  return { directory, checkpoint, database, mutate, open, run: (extra) => importTopology({ checkpoint, database, ...extra }) };
}

test("imports a catalog without modifying the source, retaining graph aliases, cycles, scope and errors", (t) => {
  const f = fixture(t);
  const before = hash(f.checkpoint);
  const result = f.run();
  assert.equal(result.imported, true);
  assert.equal(hash(f.checkpoint), before);
  const catalog = f.open();
  const summary = catalog.summary();
  assert.deepEqual(summary.objects, { alarm: 1, container: 8, history: 2, value: 10 });
  assert.equal(summary.points.native, 7);
  assert.equal(summary.containerStates.error, 1);
  assert.equal(summary.containerStates.partial, 1);
  assert.equal(summary.containerStates.pruned, 1);
  assert.equal(summary.snapshot.sourceSummary.traversalFinished, true);
  assert.equal(summary.snapshot.sourceSummary.completenessConfirmed, false);
  assert.equal(summary.snapshot.captured_at, "2026-10-28T18:27:07Z");
  assert.deepEqual(catalog.getContainer(pointsFolder).parents, [`00/${owner}`, "opaque alias "]);
  assert.equal(catalog.listContainers({ parentId: "opaque alias " }).items[0].id, pointsFolder);
  assert.equal(catalog.listContainers({ parentId: pointsFolder }).items[0].id, "00/AS");
  assert.equal(catalog.getContainer("00/error").last_error, "HTTP 504");
  assert.equal(catalog.getContainer("00/dead").prune_reason, "Technical folder: Programs");
  assert.equal(catalog.getContainer(pointsFolder).itemErrors[0].item_id, "03/missing ");
  assert.equal(catalog.getContainer("").id, "");
  assert.equal(catalog.getContainer("missing"), null);
});

test("uses dashboard recognition on native points, separates equal names and keeps live controls unavailable", (t) => {
  const f = fixture(t);
  f.run();
  const catalog = f.open();
  const device = catalog.getDevice(owner);
  assert.equal(catalog.listDevices().total, 2);
  assert.equal(device.type, "climate");
  assert.equal(device.container_id, `00/${owner}`);
  assert.equal(device.room_label, "Kuhinja Čajna");
  assert.equal(device.points.length, 6);
  assert.equal(device.points.filter((p) => p.command).length, 4);
  assert.deepEqual(device.roles.temperature, [pointId("RmTmp")]);
  assert.deepEqual(device.points.find((p) => p.role === "fanSpeed").options, [{ value: 0, label: "Auto" }, { value: 1, label: "High" }, { value: 2, label: "Low" }]);
  assert.ok(device.points.every((p) => p.native));
  assert.ok(device.points.every((p) => !Object.hasOwn(p, "writeAllowed") && !Object.hasOwn(p, "value")));
  assert.equal(device.requiresLiveValidation, true);
  const other = catalog.getDevice("AS2/Zones/Z1/AC01");
  assert.equal(other.points[0].writeable, null);
  assert.equal(other.container_id, null); // Do not fabricate a missing container.
  assert.equal(catalog.getPoint(pointId("RmTmp")).writeable, false);
  assert.equal(catalog.getPoint(pointId("EffSpt")).writeable, true);
  assert.equal(catalog.getPoint(`11/${owner}/Status`).devices.length, 0);
});

test("preserves raw metadata and resolves references only when an exact saved target exists", (t) => {
  const f = fixture(t);
  f.run();
  const catalog = f.open();
  assert.deepEqual(catalog.summary().references, { total: 5, resolved: 3 });
  const alias = catalog.getPoint(`11/${owner}/Points/EffSpt/Value`);
  assert.equal(alias.references[0].resolved_point_id, pointId("EffSpt"));
  const missing = catalog.getPoint(`11/${owner}/Points/Missing/Value`);
  assert.equal(missing.references[0].resolved_point_id, null);
  assert.equal(catalog.getPoint(missing.references[0].target_id), null);
  const property = catalog.getPoint(`11/${owner}/Status`);
  assert.deepEqual(property.metadata.extra, { nested: [1, 2] });
  assert.equal(property.references[0].source_kind, "alarm");
  assert.equal(catalog.getPoint(pointId("RmTmp")).references[0].source_kind, "history");
});

test("an identical import is idempotent and changed or incomplete imports keep older snapshots queryable", (t) => {
  const f = fixture(t);
  const first = f.run();
  const repeat = f.run();
  assert.equal(repeat.imported, false);
  assert.equal(repeat.snapshotId, first.snapshotId);
  f.mutate((db) => {
    db.prepare("DELETE FROM links WHERE kind = 'value' AND id = ?").run(pointId("SysMdCtrl"));
    db.prepare("DELETE FROM items WHERE kind = 'value' AND id = ?").run(pointId("SysMdCtrl"));
    db.prepare("UPDATE containers SET state = 'pending' WHERE id = ?").run(pointsFolder);
  });
  const second = f.run();
  assert.equal(second.imported, true);
  assert.notEqual(second.snapshotId, first.snapshotId);
  const catalog = f.open();
  assert.equal(catalog.listSnapshots().total, 2);
  assert.equal(catalog.summary().snapshot.sourceSummary.traversalFinished, false);
  assert.equal(catalog.getPoint(pointId("SysMdCtrl")), null);
  assert.equal(catalog.getPoint(pointId("SysMdCtrl"), { snapshotId: first.snapshotId }).id, pointId("SysMdCtrl"));
  assert.equal(catalog.getDevice(owner, { snapshotId: first.snapshotId }).points.length, 6);
  assert.equal(catalog.getDevice(owner).points.length, 5);
});

test("a failed import rolls back all new rows and keeps the previous snapshot usable", (t) => {
  const f = fixture(t);
  const first = f.run();
  f.mutate((db) => db.prepare("INSERT INTO links VALUES (?, 'value', ?)").run(pointsFolder, "missing-target"));
  assert.throws(() => f.run(), /FOREIGN KEY/);
  const catalog = f.open();
  assert.equal(catalog.snapshot().id, first.snapshotId);
  assert.equal(catalog.listSnapshots().total, 1);
  assert.equal(catalog.listPoints().total, 10);
  assert.deepEqual(catalog.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("separates buildings and scan roots, rejecting accidental mixing within one building", (t) => {
  const f = fixture(t);
  f.run({ building: "building-a", label: "Zgrada A" });
  f.mutate((db) => {
    const settings = JSON.parse(db.prepare("SELECT data FROM settings").get().data);
    settings.url = "http://another-middleware:3000";
    db.prepare("UPDATE settings SET data = ?").run(JSON.stringify(settings));
  });
  assert.throws(() => f.run({ building: "building-a" }), /different source URL or scan root/);
  f.run({ building: "building-b", label: "Zgrada B" });
  const catalog = f.open();
  assert.equal(catalog.listSnapshots({ building: "building-a" }).total, 1);
  assert.equal(catalog.listSnapshots({ building: "building-b" }).total, 1);
  assert.equal(catalog.summary({ building: "building-a" }).building.label, "Zgrada A");
  assert.throws(() => catalog.snapshot({ building: "building-a", snapshotId: catalog.snapshot({ building: "building-b" }).id }), /No imported snapshot/);
  assert.throws(() => catalog.summary(), /No imported snapshot/);
});

test("refuses overwriting a checkpoint or opening an unrelated database as a catalog", (t) => {
  const f = fixture(t);
  const before = hash(f.checkpoint);
  assert.throws(() => f.run({ database: f.checkpoint }), /separate from/);
  assert.equal(hash(f.checkpoint), before);
  assert.throws(() => new BuildingCatalog(f.checkpoint, { readOnly: false }), /not a supported building catalog/);
  assert.equal(hash(f.checkpoint), before);
  assert.throws(() => f.run({ checkpoint: path.join(f.directory, "missing.sqlite") }), /ENOENT/);
  assert.equal(fs.existsSync(f.database), false);
});

test("supports older checkpoint columns and retains duplicate command roles for manual resolution", (t) => {
  const f = fixture(t, { legacy: true });
  const duplicate = `01/${owner}/Points/Another branch/EffSpt`;
  f.mutate((db) => {
    db.prepare("INSERT INTO items VALUES ('value', ?, ?)").run(duplicate, JSON.stringify({ id: duplicate, name: "EffSpt", unit: "°C", writeable: 1 }));
    db.prepare("INSERT INTO links VALUES (?, 'value', ?)").run(pointsFolder, duplicate);
  });
  f.run();
  const catalog = f.open();
  const device = catalog.getDevice(owner);
  assert.equal(device.roles.setpoint.length, 2);
  assert.ok(device.points.filter((p) => p.role === "setpoint").every((p) => p.role_ambiguous));
  assert.equal(catalog.getContainer("00/dead").prune_reason, "");
});

test("queries page and filter results safely, including Croatian labels and literal wildcard characters", (t) => {
  const f = fixture(t);
  f.run();
  const catalog = f.open();
  assert.equal(catalog.listDevices({ search: "CAJNA" }).total, 1);
  assert.equal(catalog.listContainers({ search: "ČAJNA" }).total, 1);
  assert.equal(catalog.listContainers({ state: "error" }).total, 1);
  assert.equal(catalog.listPoints({ nativeOnly: true }).total, 7);
  assert.equal(catalog.listPoints({ parentId: pointsFolder }).total, 10);
  assert.equal(catalog.listPoints({ limit: 3, offset: 3 }).items.length, 3);
  assert.equal(catalog.listPoints({ search: "%' OR 1=1 --" }).total, 0);
  assert.equal(catalog.listDevices({ type: "not-a-type" }).total, 0);
  assert.throws(() => catalog.listDevices({ limit: 0 }), /limit/);
  assert.throws(() => catalog.listPoints({ offset: -1 }), /offset/);
  assert.throws(() => catalog.snapshot({ snapshotId: "1" }), /Invalid snapshot/);
});

test("CLI imports and reads a local catalog, with failures returning a nonzero exit code", (t) => {
  const f = fixture(t);
  const cli = path.join(__dirname, "..", "tools", "building-catalog", "catalog.js");
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, "--database", f.database], { encoding: "utf8" });
  const imported = run("import", "--checkpoint", f.checkpoint);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).imported, true);
  const result = run("device", "--id", owner);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).key, owner);
  const missing = run("point", "--id", "missing");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not found/);
  const invalid = run("devices", "--limit", "-1");
  assert.equal(invalid.status, 1);
});

test("native widget export keeps personal settings and raw capability metadata without enabling new writes", (t) => {
  const f = fixture(t);
  f.run();
  const catalog = f.open();
  const prepared = prepareWidgetImport(catalog, { existingWidgets: [
    { id: pointId("EffSpt"), label: "My setpoint", precision: 1, writable: true, visible: false, unit: "°C", group: "Kitchen" },
    { id: `11/${owner}/Points/EffSpt/Value`, label: "Old alias" },
  ] });
  assert.equal(prepared.widgets.length, 7);
  assert.equal(prepared.summary.retained, 1);
  assert.equal(prepared.summary.removed, 1);
  assert.equal(prepared.summary.added, 6);
  const previous = prepared.widgets.find((w) => w.id === pointId("EffSpt"));
  assert.equal(previous.label, "My setpoint");
  assert.equal(previous.group, "Kitchen");
  assert.equal(previous.visible, false);
  assert.equal(previous.writable, true);
  assert.ok(prepared.widgets.filter((w) => w.id !== previous.id).every((w) => w.writable === false));
  assert.ok(prepared.widgets.every((w) => w.id.startsWith("01/")));
  assert.equal(prepared.metadata.metadataById[previous.id].writeable, true);
  assert.equal(prepared.metadata.metadataById[previous.id].description, "Setpoint");
  assert.equal(prepared.metadata.roomByZone["AS/Zones/Z1"], "Kuhinja Čajna");
  assert.equal(prepared.metadata.catalog.capturedAt, "2026-10-28T18:27:07Z");
});

test("widget import has a dry run and saves a backup before publishing widget and descriptor files", (t) => {
  const f = fixture(t);
  f.run();
  const catalog = f.open();
  const widgetsFile = path.join(f.directory, "widgets.json");
  const previous = JSON.stringify([{ id: pointId("RmTmp"), label: "Custom temperature" }]);
  fs.writeFileSync(widgetsFile, previous);
  const options = { widgetsFile, backupDirectory: path.join(f.directory, "backups") };
  const dry = importWidgets(catalog, options);
  assert.equal(dry.applied, false);
  assert.equal(fs.readFileSync(widgetsFile, "utf8"), previous);
  assert.equal(fs.existsSync(dry.metadataFile), false);
  const saved = importWidgets(catalog, { ...options, apply: true });
  assert.equal(saved.applied, true);
  assert.equal(fs.readFileSync(path.join(saved.backup, "widgets.json"), "utf8"), previous);
  assert.equal(JSON.parse(fs.readFileSync(widgetsFile)).length, 7);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(saved.metadataFile)).metadataById).length, 7);
  assert.equal(JSON.parse(fs.readFileSync(path.join(saved.backup, "manifest.json"))).retained, 1);
  assert.throws(() => importWidgets(catalog, { ...options, metadataFile: widgetsFile }), /must be separate/);
  assert.throws(() => importWidgets(catalog, { ...options, metadataFile: f.database }), /must be JSON/);
});

test("a failed widget publication restores the existing descriptor file and leaves the widget list unchanged", (t) => {
  const f = fixture(t);
  f.run();
  const catalog = f.open();
  const widgetsFile = path.join(f.directory, "widgets.json");
  const metadataFile = path.join(f.directory, "descriptors.json");
  const previous = JSON.stringify([{ id: pointId("RmTmp"), label: "Custom temperature" }]);
  fs.writeFileSync(widgetsFile, previous);
  fs.writeFileSync(metadataFile, "previous metadata");
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === widgetsFile) throw new Error("Simulated file replacement failure"); return rename(from, to); };
  try {
    assert.throws(() => importWidgets(catalog, { widgetsFile, metadataFile, apply: true, backupDirectory: path.join(f.directory, "backups") }), /replacement failure/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(widgetsFile, "utf8"), previous);
  assert.equal(fs.readFileSync(metadataFile, "utf8"), "previous metadata");
  assert.equal(fs.readdirSync(f.directory).some((name) => name.endsWith(".tmp")), false);
});

test("saved histories are searchable and retain exact IDs, explicit point references and observed parents", t => {
  const f = fixture(t); f.run(); const catalog = f.open();
  const histories = catalog.listHistories({ limit: 1 });
  assert.equal(histories.total, 2); assert.equal(histories.items.length, 1);
  const item = catalog.listHistories({ search: "TEMPERATURE" }).items[0];
  assert.equal(item.id, "03/history-ok"); assert.equal(item.valueItemId, pointId("RmTmp"));
  assert.deepEqual(item.parentIds, [pointsFolder]);
  assert.equal(catalog.listHistories({ parentId: "opaque alias " }).total, 0, "only actual history parent links count");
  const definitions = historyDefinitions(catalog);
  assert.equal(definitions.historyItems.length, 2);
  assert.equal(definitions.historyItems.find(item => item.id === "03/history-missing").valueItemId, "01/not-in-snapshot ");
  assert.equal(prepareWidgetImport(catalog).metadata.historyItems.length, 2);
});

test("adding a trend list preserves curated widgets, device preferences and room metadata and backs up the descriptor file", t => {
  const f = fixture(t); f.run(); const catalog = f.open();
  const widgetsFile = path.join(f.directory, "widgets.json"), metadataFile = path.join(f.directory, "catalog-metadata.json");
  const before = { schemaVersion: 1, catalog: { buildingKey: "default" }, metadataById: { [pointId("RmTmp")]: { id: pointId("RmTmp"), description: "custom" } }, roomByZone: { "AS/Zones/Z1": "Kitchen · 3. kat" } };
  fs.writeFileSync(widgetsFile, JSON.stringify([{ id: pointId("RmTmp"), label: "Keep curated list" }]));
  fs.writeFileSync(metadataFile, JSON.stringify(before));
  const original = fs.readFileSync(metadataFile), widgetsHash = hash(widgetsFile);
  const options = { metadataFile, backupDirectory: path.join(f.directory, "backups") };
  assert.equal(importHistories(catalog, options).applied, false);
  assert.deepEqual(fs.readFileSync(metadataFile), original);
  const saved = importHistories(catalog, { ...options, apply: true });
  const after = JSON.parse(fs.readFileSync(metadataFile));
  assert.equal(after.historyItems.length, 2);
  assert.deepEqual(after.metadataById, before.metadataById); assert.deepEqual(after.roomByZone, before.roomByZone);
  assert.equal(hash(widgetsFile), widgetsHash);
  assert.deepEqual(fs.readFileSync(path.join(saved.backup, "catalog-metadata.json")), original);
});
