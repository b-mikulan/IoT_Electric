const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DashboardTransfer, initializeTransferFiles, FORMAT } = require("../lib/storage/dashboardTransfer");
const { createRuntime } = require("../server");
const { createApp } = require("../app");
const { PointPoller } = require("../lib/telemetry/pointPoller");
const { WidgetStore } = require("../lib/storage/widgetStore");
const { DeviceWidgetStore } = require("../lib/storage/deviceWidgetStore");
const { DeviceMetadataClient } = require("../lib/devices/deviceMetadata");
const { DashboardUsers } = require("../lib/auth/dashboardUsers");

const point = "01/ES/Zones/Z1/AC1/Values/RmTmp";
const owner = "ES/Zones/Z1/AC1";
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function fixture(t, { empty = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-transfer-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith("dashboard-transfer-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const config = { demoMode: false, widgetsFile: path.join(directory, "widgets.json"), deviceWidgetsFile: path.join(directory, "device-widgets.json"), deviceMetadataFile: path.join(directory, "catalog-metadata.json"), username: "secret-user", password: "secret-password", middlewareUrl: "http://middleware", intervalMs: 180000, readBatchSize: 128 };
  write(config.widgetsFile, empty ? [] : [{ id: "old-point", label: "Old", writable: false }]);
  write(config.deviceWidgetsFile, { version: 1, devices: [], rooms: ["Old empty room"] });
  write(config.deviceMetadataFile, { schemaVersion: 1, metadataById: {}, roomByZone: {} });
  config.widgets = read(config.widgetsFile);
  return { directory, config, transfer: new DashboardTransfer(config) };
}
function bundle() {
  return { format: FORMAT, version: 1, widgets: [{ id: point, label: "AC reading", writable: true, value: 12345, state: 0, updatedAt: "old-value-time", password: "discard-this" }],
    deviceWidgets: { version: 1, devices: [{ key: owner, label: "Kitchen AC", room: "Kitchen", primaryPointId: point, primaryUnit: "°C", secondaryPointIds: [] }], rooms: ["Empty room"], roomRules: [{ from: "Old Kitchen", to: "Kitchen" }] },
    metadata: { schemaVersion: 1, metadataById: { [point]: { id: point, name: "RmTmp", type: "double", unit: "°C", writeable: true, forceable: false } }, roomByZone: { "ES/Zones/Z1": "Old Kitchen" } } };
}

test("SQLite migrates existing configuration and accounts once and commits imports with a restorable backup", async t => {
  const { directory, config } = fixture(t);
  const data = bundle();
  write(config.widgetsFile, data.widgets);
  write(config.deviceWidgetsFile, data.deviceWidgets);
  write(config.deviceMetadataFile, data.metadata);
  const settingsFile = path.join(directory, "dashboard-settings.json");
  write(settingsFile, { version: 1, settings: { intervalMs: 45_000 } });
  const usersFile = path.join(directory, "dashboard-users.json");
  const legacyUsers = new DashboardUsers(usersFile, {});
  legacyUsers.save(null, { username: "viewer", password: "migration-password", roomIds: ["Kitchen"] }, new Set(["Kitchen"]));
  const legacyFiles = [config.widgetsFile, config.deviceWidgetsFile, config.deviceMetadataFile, settingsFile, usersFile];
  const originals = legacyFiles.map(file => fs.readFileSync(file, "utf8"));
  const env = {
    DEMO_MODE: "false", WIDGETS_FILE: config.widgetsFile, DEVICE_METADATA_FILE: config.deviceMetadataFile,
    MIDDLEWARE_USER: "middleware", MIDDLEWARE_PASSWORD: "test-middleware",
    DASHBOARD_ADMIN_USER: "admin", DASHBOARD_ADMIN_PASSWORD: "test-admin",
    DASHBOARD_DB_FILE: path.join(directory, "dashboard.sqlite"),
  };
  const runtime = createRuntime(env);
  const { database } = runtime;
  try {
    assert.equal(runtime.config.intervalMs, 45_000);
    assert.equal(runtime.config.widgets[0].id, point);
    assert.equal(database.readUsers()[0].passwordHash, read(usersFile).users[0].passwordHash);
    assert.deepEqual(database.readUsers()[0].roomIds, ["Kitchen"]);
    assert.deepEqual(database.readDocument("metadata"), data.metadata);
    await runtime.deviceWidgetStore.synchronize([owner], { roomNames: ["Kitchen"] });
    assert.equal(runtime.deviceWidgetStore.devices[0].room, "Kitchen");

    const transfer = new DashboardTransfer(runtime.config, { database });
    const replacement = [{ id: "replacement" }];
    const stale = transfer.prepare(replacement).token;
    await runtime.widgetStore.setVisibility(point, false);
    assert.throws(() => transfer.apply(replacement, stale), { code: "TRANSFER_PREVIEW_CHANGED" });
    assert.equal(database.readWidgets()[0].visible, false);

    const prepared = transfer.prepare(replacement);
    const result = transfer.apply(replacement, prepared.token);
    assert.deepEqual(database.readWidgets().map(widget => widget.id), ["replacement"]);
    assert.deepEqual(database.readUsers()[0].roomIds, ["Kitchen"]);
    const backup = transfer.exportBackup(result.backupId);
    assert.equal(backup.widgets[0].visible, false);
    assert.equal(backup.deviceWidgets.devices[0].room, "Kitchen");
    assert.equal(backup.dashboardSettings.intervalMs, 45_000);
    assert.doesNotMatch(JSON.stringify(backup), /password|scrypt|12345/);
    assert.deepEqual(legacyFiles.map(file => fs.readFileSync(file, "utf8")), originals);
  } finally {
    database.close();
  }

  for (const file of legacyFiles) fs.writeFileSync(file, "invalid legacy file");
  const restarted = createRuntime(env);
  try {
    assert.deepEqual(restarted.config.widgets.map(widget => widget.id), ["replacement"]);
    assert.equal(restarted.config.intervalMs, 45_000);
    assert.deepEqual(restarted.database.readUsers()[0].roomIds, ["Kitchen"]);
  } finally {
    restarted.database.close();
  }
});

test("a failed SQLite migration can retry from intact JSON and a new live database needs no widget file", t => {
  const { directory, config } = fixture(t);
  const env = {
    DEMO_MODE: "false", MIDDLEWARE_USER: "middleware", MIDDLEWARE_PASSWORD: "test-middleware",
    DASHBOARD_DB_FILE: path.join(directory, "dashboard.sqlite"),
  };
  fs.writeFileSync(config.deviceWidgetsFile, "invalid device document");
  assert.throws(() => createRuntime({ ...env, WIDGETS_FILE: config.widgetsFile }), /configuration is invalid/);
  assert.equal(read(config.widgetsFile)[0].id, "old-point");
  write(config.deviceWidgetsFile, { version: 1, devices: [] });
  const migrated = createRuntime({ ...env, WIDGETS_FILE: config.widgetsFile });
  assert.equal(migrated.config.widgets[0].id, "old-point");
  migrated.database.close();

  const fresh = createRuntime({ ...env, DASHBOARD_DB_FILE: path.join(directory, "fresh.sqlite") });
  assert.deepEqual(fresh.config.widgets, []);
  assert.equal(fresh.widgetStore.enabled, true);
  fresh.database.close();
});

test("portable export/import retains room assignments, empty rooms, units, write flags and metadata without runtime values or credentials", t => {
  const { config, transfer } = fixture(t);
  const data = bundle();
  const preview = transfer.prepare(data);
  assert.deepEqual(preview.summary, { points: 1, devices: 1, rooms: 2, writablePoints: 1, added: 1, removed: 1, metadataPoints: 1, legacy: false, warnings: [] });
  assert.equal(read(config.widgetsFile)[0].id, "old-point", "preview must not write");
  const imported = transfer.apply(data, preview.token);
  const exported = transfer.export();
  assert.equal(exported.deviceWidgets.devices[0].primaryUnit, "°C");
  assert.equal(exported.deviceWidgets.devices[0].room, "Kitchen");
  assert.deepEqual(exported.deviceWidgets.rooms, ["Empty room"]);
  assert.deepEqual(exported.deviceWidgets.roomRules, data.deviceWidgets.roomRules);
  assert.equal(exported.widgets[0].writable, true);
  assert.deepEqual(JSON.parse(JSON.stringify(exported.metadata)), data.metadata);
  assert.doesNotMatch(JSON.stringify(exported), /secret-|discard-this|old-value-time|12345/);
  assert.equal(read(path.join(path.dirname(config.widgetsFile), "transfer-backups", imported.backupId, "widgets.json"))[0].id, "old-point");
  assert(!fs.existsSync(path.join(path.dirname(config.widgetsFile), ".dashboard-transfer.json")));
});

test("invalid and duplicate points, foreign readings, invalid rooms and invalid metadata cannot change existing files", t => {
  const { config, transfer } = fixture(t);
  const before = fs.readFileSync(config.widgetsFile, "utf8");
  const invalid = [null, {}, { ...bundle(), version: 3 }, { ...bundle(), widgets: [{ id: point }, { id: point }] }, { ...bundle(), widgets: [{ id: "bad\npoint" }] }];
  const foreign = bundle(); foreign.deviceWidgets.devices[0].primaryPointId = "01/ES/Zones/Z2/Other/Values/RmTmp"; invalid.push(foreign);
  const room = bundle(); room.deviceWidgets.rooms = ["Kitchen", "kitchen"]; invalid.push(room);
  const metadata = bundle(); metadata.metadata.metadataById[point].id = "foreign"; invalid.push(metadata);
  for (const value of invalid) assert.throws(() => transfer.prepare(value), error => error.status === 400);
  assert.equal(fs.readFileSync(config.widgetsFile, "utf8"), before);
});

test("plain widgets.json retains matching saved card preferences and reports absent descriptions", t => {
  const { config, transfer } = fixture(t);
  const data = bundle(); transfer.apply(data, transfer.prepare(data).token);
  const preview = transfer.prepare([{ id: point }, { id: "new-unknown-point" }]);
  assert.equal(preview.summary.legacy, true);
  assert.equal(preview.summary.warnings.length, 2);
  assert.equal(preview.payload.deviceWidgets.devices[0].label, "Kitchen AC");
  assert.equal(preview.payload.metadata.metadataById[point].unit, "°C");
  transfer.apply([{ id: point }, { id: "new-unknown-point" }], preview.token);
  assert.equal(read(config.widgetsFile).length, 2);
});

test("changed upload or destination invalidates the preview token", t => {
  const { config, transfer } = fixture(t);
  const data = bundle(), token = transfer.prepare(data).token;
  const changed = bundle(); changed.widgets[0].label = "Changed";
  assert.throws(() => transfer.apply(changed, token), error => error.code === "TRANSFER_PREVIEW_CHANGED");
  write(config.deviceWidgetsFile, { version: 1, devices: [], rooms: ["New room"] });
  assert.throws(() => transfer.apply(data, token), error => error.code === "TRANSFER_PREVIEW_CHANGED");
  assert.equal(read(config.widgetsFile)[0].id, "old-point");
});

test("failure while replacing the second file rolls back all three files and retains a backup", t => {
  const { directory, config } = fixture(t);
  const originals = [config.widgetsFile, config.deviceWidgetsFile, config.deviceMetadataFile].map(file => fs.readFileSync(file, "utf8"));
  const transfer = new DashboardTransfer(config, { fsImpl: { ...fs, renameSync(from, to) {
    if (to === config.deviceWidgetsFile && from.endsWith(".import")) throw new Error("Disk failure");
    return fs.renameSync(from, to);
  } } });
  const data = bundle();
  assert.throws(() => transfer.apply(data, transfer.prepare(data).token), error => error.code === "TRANSFER_SAVE_FAILED");
  assert.deepEqual([config.widgetsFile, config.deviceWidgetsFile, config.deviceMetadataFile].map(file => fs.readFileSync(file, "utf8")), originals);
  assert.equal(fs.readdirSync(path.join(directory, "transfer-backups")).length, 1);
});

test("startup restores an interrupted import before reading configuration", t => {
  const { directory, config } = fixture(t);
  const id = `2026-11-04T10-00-00.000Z-${randomUUID()}`, backup = path.join(directory, "transfer-backups", id);
  fs.mkdirSync(backup, { recursive: true });
  for (const name of ["widgets.json", "device-widgets.json", "catalog-metadata.json"]) fs.copyFileSync(path.join(directory, name), path.join(backup, name));
  write(config.widgetsFile, bundle().widgets);
  write(path.join(directory, ".dashboard-transfer.json"), { id, existed: [true, true, true], phase: "prepared" });
  initializeTransferFiles({ WIDGETS_FILE: config.widgetsFile });
  assert.equal(read(config.widgetsFile)[0].id, "old-point");
});

test("fresh persistent deployment starts empty and can import descriptions without a restart", t => {
  const { config } = fixture(t);
  fs.unlinkSync(config.widgetsFile);
  const runtime = createRuntime({ DEMO_MODE: "false", WIDGETS_FILE: config.widgetsFile, MIDDLEWARE_USER: "user", MIDDLEWARE_PASSWORD: "password" });
  t.after(() => runtime.poller.stop());
  assert.deepEqual(runtime.config.widgets, []);
  assert(runtime.widgetStore.enabled);
  const client = new DeviceMetadataClient({ ...config, demoMode: false });
  client.replaceCatalog(bundle().metadata);
  return client.read(bundle().widgets).then(value => assert.equal(value.metadataById[point].unit, "°C"));
});

test("plain import without metadata survives restart", t => {
  const { config, transfer } = fixture(t);
  fs.unlinkSync(config.deviceMetadataFile);
  const preview = transfer.prepare([{ id: point }]);
  transfer.apply([{ id: point }], preview.token);
  assert.equal(read(config.deviceMetadataFile), null);
  assert.doesNotThrow(() => createRuntime({ DEMO_MODE: "false", WIDGETS_FILE: config.widgetsFile, MIDDLEWARE_USER: "user", MIDDLEWARE_PASSWORD: "password" }));
});

async function serve(t) {
  let cleanup;
  const fixtureValue = fixture({ after(fn) { cleanup = fn; } });
  const { config } = fixtureValue;
  const reads = [];
  const poller = new PointPoller({ ...config, fetchImpl: async (url, options) => { const ids = JSON.parse(options.body).ids; reads.push(ids); return { ok: true, json: async () => ({ values: ids.map(id => ({ id, value: 22, state: 0 })), errors: [] }) }; } });
  const widgetStore = new WidgetStore(config.widgetsFile);
  const deviceWidgetStore = new DeviceWidgetStore(config.deviceWidgetsFile);
  const app = createApp({ config, poller, widgetStore, deviceWidgetStore });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { try { poller.stop(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await deviceWidgetStore.synchronize([]); } finally { cleanup(); } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ...fixtureValue, base, post, poller, reads, widgetStore, deviceWidgetStore };
}

test("HTTP import applies the complete bundle live, publishes an event and persists across restart", async t => {
  const { base, post, config, reads, deviceWidgetStore } = await serve(t);
  const events = new AbortController();
  const stream = await fetch(base + "/events", { signal: events.signal });
  const reader = stream.body.getReader();
  const data = bundle();
  const preview = await (await post("/api/dashboard-transfer/preview", { document: data })).json();
  const response = await post("/api/dashboard-transfer/import", { document: data, token: preview.token });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert(result.backupId);
  let received = "";
  while (!received.includes("dashboard-imported")) received += new TextDecoder().decode((await reader.read()).value);
  events.abort();
  assert.equal(config.widgets[0].id, point);
  assert.equal(deviceWidgetStore.devices[0].room, "Kitchen");
  const metadata = await (await fetch(base + "/api/devices/metadata")).json();
  assert.equal(metadata.metadataById[point].unit, "°C");
  assert(reads.every(ids => ids.includes(point)));
  const exported = await (await fetch(base + "/api/dashboard-transfer/export")).json();
  assert.doesNotMatch(JSON.stringify(exported), /secret-user|secret-password|12345/);
  const runtime = createRuntime({ DEMO_MODE: "false", WIDGETS_FILE: config.widgetsFile, MIDDLEWARE_USER: "user", MIDDLEWARE_PASSWORD: "password" });
  assert.equal(runtime.config.widgets[0].id, point);
  assert.equal(runtime.config.deviceMetadataFile, config.deviceMetadataFile);
});

test("an import blocks concurrent imports and room changes while waiting for persistence", async t => {
  const { post, widgetStore } = await serve(t);
  const data = bundle();
  const { token } = await (await post("/api/dashboard-transfer/preview", { document: data })).json();
  const original = widgetStore.withExclusive.bind(widgetStore);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  widgetStore.withExclusive = fn => original(async () => { entered(); await gate; return fn(); });
  const first = post("/api/dashboard-transfer/import", { document: data, token });
  await waiting;
  try {
    const competing = await post("/api/dashboard-transfer/import", { document: data, token });
    assert.equal(competing.status, 409);
    assert.equal((await competing.json()).code, "TRANSFER_IN_PROGRESS");
    assert.equal((await post("/api/rooms", { name: "Concurrent room" })).status, 409);
  } finally { release(); }
  assert.equal((await first).status, 200);
});

test("import validation returns structured errors and transfer page is served", async t => {
  const { base, post } = await serve(t);
  assert.equal((await post("/api/dashboard-transfer/preview", { document: {} })).status, 400);
  assert.equal((await post("/api/dashboard-transfer/import", { document: bundle() })).status, 409);
  const page = await (await fetch(base + "/transfer.html")).text();
  assert.match(page, /Prijenos postavki/);
  assert.match(page, /id="transfer-confirm"/);
  const malformed = await fetch(base + "/api/dashboard-transfer/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
});

test("replacing a dashboard during a pending read discards old values and errors, then reads only the imported points", async () => {
  let resolveOld;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const batches = [], updates = [];
  const poller = new PointPoller({ middlewareUrl: "http://middleware", widgets: [{ id: "old" }], fetchImpl: async (url, options) => {
    const ids = JSON.parse(options.body).ids; batches.push(ids);
    if (ids[0] === "old") return old;
    return { ok: true, json: async () => ({ values: [{ id: point, value: 25, state: 0 }] }) };
  } });
  poller.on("update", value => updates.push(value));
  const pending = poller.poll();
  poller.replaceWidgets([{ id: point }]);
  resolveOld({ ok: false, status: 500 });
  await pending;
  await poller.poll();
  assert.deepEqual(batches, [["old"], [point]]);
  assert.equal(poller.getSnapshot().widgets[0].value, 25);
  assert.equal(poller.getSnapshot().status, "connected");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].widgets[0].id, point);
  poller.stop();
});
