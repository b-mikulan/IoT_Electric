const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { DashboardSettingsStore } = require("../lib/dashboardSettings");
const { resolveRefreshScope } = require("../lib/refreshScope");
const { PointPoller } = require("../lib/pointPoller");
const { loadConfig } = require("../lib/config");
const { createApp } = require("../app");
const { DashboardTransfer, initializeTransferFiles } = require("../lib/dashboardTransfer");

const defaults = { intervalMs: 180_000, readBatchSize: 128, readBatchDelayMs: 1000, timeoutMs: 30_000, afterWriteScope: "room" };
const json = body => ({ ok: true, json: async () => body });
const tick = () => new Promise(resolve => setImmediate(resolve));
const point = (device, name = "LtPct") => ({ id: `01/ES/Zones/${device}/Values/${name}`, label: name, visible: true, writable: true, unit: "%" });

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-general-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

function poller(options = {}) {
  return new PointPoller({ middlewareUrl: "http://fake-middleware", widgets: [point("L101"), point("L102"), point("L201")], ...defaults,
    fetchImpl: async (_url, init) => json({ values: JSON.parse(init.body).ids.map(id => ({ id, value: 30, state: 0 })) }), ...options });
}

test("general settings persist atomically, override environment defaults on restart, and contain no credentials", t => {
  const directory = temporary(t);
  const widgetsFile = path.join(directory, "widgets.json");
  fs.writeFileSync(widgetsFile, "[]");
  const config = { ...defaults, widgetsFile, password: "must-never-be-saved" };
  const store = new DashboardSettingsStore(config);
  store.save({ intervalMs: 240_000, afterWriteScope: "device" });
  const text = fs.readFileSync(store.filePath, "utf8");
  assert.doesNotMatch(text, /must-never-be-saved/);
  assert.equal(new DashboardSettingsStore(config).values.intervalMs, 240_000);
  const restarted = loadConfig({ DEMO_MODE: "false", WIDGETS_FILE: widgetsFile, MIDDLEWARE_USER: "fixture", MIDDLEWARE_PASSWORD: "never-persist", POLL_INTERVAL_MS: "10000" });
  assert.equal(restarted.intervalMs, 240_000);
  assert.equal(restarted.afterWriteScope, "device");
  for (const settings of [{ intervalMs: 0 }, { readBatchSize: 501 }, { readBatchDelayMs: -1 }, { timeoutMs: "1000" }, { afterWriteScope: "building" }, { password: "bad" }, null]) {
    assert.throws(() => store.save(settings), error => error.code === "INVALID_DASHBOARD_SETTINGS");
  }
  assert.equal(fs.readFileSync(store.filePath, "utf8"), text);
});

test("a failed general-settings save retains the active values and original file", t => {
  const directory = temporary(t);
  const store = new DashboardSettingsStore({ ...defaults, widgetsFile: path.join(directory, "widgets.json") });
  store.save({ intervalMs: 200_000 });
  const original = fs.readFileSync(store.filePath, "utf8");
  const broken = new DashboardSettingsStore({ ...defaults, widgetsFile: path.join(directory, "missing", "widgets.json") });
  assert.throws(() => broken.save({ intervalMs: 300_000 }), /Spremanje/);
  assert.equal(broken.values.intervalMs, defaults.intervalMs);
  assert.equal(fs.readFileSync(store.filePath, "utf8"), original);
});

test("room refresh uses stable room IDs across floors, manual moves and hidden point definitions", () => {
  const widgets = [point("L101"), point("L101", "LtSts"), point("L102"), point("L201"), { ...point("L102", "LtSts"), visible: false }, point("Loose")];
  const options = { deviceSettings: [
    { key: "ES/Zones/L101", room: "kitchen-a" }, { key: "ES/Zones/L102", room: "kitchen-a" }, { key: "ES/Zones/L201", room: "kitchen-b" },
  ], floors: [{ id: "a", name: "1. kat A" }, { id: "b", name: "1. kat B" }],
  roomDetails: [{ id: "kitchen-a", name: "Kitchen", floorId: "a" }, { id: "kitchen-b", name: "Kitchen", floorId: "b" }] };
  assert.deepEqual(resolveRefreshScope(widgets, options, widgets[0].id), [widgets[0].id, widgets[1].id, widgets[2].id, widgets[4].id]);
  assert.deepEqual(resolveRefreshScope(widgets, options, widgets[0].id, "device"), widgets.slice(0, 2).map(w => w.id));
  assert.deepEqual(resolveRefreshScope(widgets, options, widgets[5].id), [widgets[5].id]);
  options.deviceSettings[1].room = "kitchen-b";
  assert.deepEqual(resolveRefreshScope(widgets, options, widgets[0].id), widgets.slice(0, 2).map(w => w.id));
});

test("automatic room labels and saved rename/delete rules also determine command refresh scope", () => {
  const widgets = [point("L101"), point("L102"), point("L201")];
  const options = { roomByZone: { "ES/Zones/L101": "Office", "ES/Zones/L102": "Other", "ES/Zones/L201": "Kitchen" }, roomRules: [{ from: "Other", to: "Office" }] };
  assert.deepEqual(resolveRefreshScope(widgets, options, widgets[0].id), widgets.slice(0, 2).map(w => w.id));
  options.roomRules[0].to = "";
  assert.deepEqual(resolveRefreshScope(widgets, options, widgets[1].id), [widgets[1].id]);
});

test("partial reads preserve other rooms and full-building sync time, and prove an unchanged point was read", async () => {
  let time = 0;
  const reads = [];
  const service = poller({ now: () => new Date(time++ * 1000), fetchImpl: async (_url, init) => {
    const ids = JSON.parse(init.body).ids; reads.push(ids);
    return json({ values: ids.map(id => ({ id, value: 30, state: 0 })) });
  } });
  const before = await service.poll();
  const events = []; service.on("update", event => events.push(event));
  const after = await service.refreshPoints([point("L101").id]);
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[1], [point("L101").id]);
  assert.deepEqual(after.widgets[1], before.widgets[1]);
  assert.equal(after.syncedAt, before.syncedAt);
  assert.equal(after.widgets[0].updatedAt, before.widgets[0].updatedAt);
  assert.notEqual(after.widgets[0].readAt, before.widgets[0].readAt);
  assert.equal(events[0].scope, "partial");
  assert.equal(events[0].syncedAt, undefined);
  assert.equal(events[0].widgets.length, 1);
});

test("a command read interrupts a long full refresh between batches without overlapping requests or publishing stale values", async () => {
  let release, entered;
  let gate = false, active = 0, maximum = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const reads = [];
  const service = poller({ readBatchSize: 1, readBatchDelayMs: 0, fetchImpl: async (_url, init) => {
    active++; maximum = Math.max(maximum, active);
    const ids = JSON.parse(init.body).ids; reads.push(ids);
    if (gate) { gate = false; entered(); await new Promise(resolve => { release = resolve; }); }
    active--;
    return json({ values: ids.map(id => ({ id, value: reads.length, state: 0 })) });
  } });
  await service.poll();
  const previous = service.getSnapshot();
  reads.length = 0; gate = true;
  const full = service.poll(); await ready;
  const target = service.refreshPoints([point("L102").id]);
  release(); await Promise.all([full, target]);
  assert.deepEqual(reads, [[point("L101").id], [point("L102").id]]);
  assert.equal(maximum, 1);
  assert.deepEqual(service.getSnapshot().widgets[0], previous.widgets[0]);
  assert.equal(service.getSnapshot().syncedAt, previous.syncedAt);
});

test("pause skips remaining batches and automatic polls; manual reads and command readback still work while paused", async t => {
  const reads = [];
  const service = poller({ fetchImpl: async (_url, init) => {
    const ids = JSON.parse(init.body).ids; reads.push(ids);
    return json({ values: ids.map(id => ({ id, value: 30, state: 0 })) });
  } });
  service.setPaused(true);
  await service.poll(); assert.equal(reads.length, 0);
  await service.poll({ manual: true }); assert.equal(reads.length, 1);
  assert.equal(service.getPollingState().paused, true);
  await service.refreshPoints([point("L101").id]); assert.equal(reads.length, 2);
  await service.poll(); assert.equal(reads.length, 2);
  service.setPaused(false); await service.poll(); assert.equal(reads.length, 3);
  service.stop();
});

test("pausing a running batch prevents additional reads, and resuming immediately performs a new full read", async () => {
  let release;
  const reads = [];
  let block = true;
  const service = poller({ readBatchSize: 1, readBatchDelayMs: 0, fetchImpl: async (_url, init) => {
    const ids = JSON.parse(init.body).ids; reads.push(ids);
    if (block) { block = false; await new Promise(resolve => { release = resolve; }); }
    return json({ values: ids.map(id => ({ id, value: 30, state: 0 })) });
  } });
  const current = service.poll();
  service.setPaused(true); release(); await current;
  assert.equal(reads.length, 1);
  assert.equal(service.getSnapshot().syncedAt, null);
  service.setPaused(false); await service.poll();
  assert.equal(reads.length, 4);
  service.stop();
});

test("successful writes coalesce for two seconds and read only resolved room points even during pause", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reads = [];
  const service = poller({ fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/write")) return json({ results: body.items.map(item => ({ id: item.id, success: true })) });
    reads.push(body.ids); return json({ values: body.ids.map(id => ({ id, value: 30, state: 0 })) });
  } });
  service.setWriteRefreshResolver(() => [point("L101").id, point("L102").id]);
  await service.poll(); service.setPaused(true); reads.length = 0;
  await service.writeValue(point("L101").id, 40);
  await service.writeValue(point("L102").id, 50);
  t.mock.timers.tick(1999); await tick(); assert.equal(reads.length, 0);
  t.mock.timers.tick(1); await tick();
  assert.deepEqual(reads, [[point("L101").id, point("L102").id]]);
  service.stop();
});

test("a failed partial read leaves cached room values and full freshness intact and reports a scoped error", async () => {
  let failed = false;
  const service = poller({ fetchImpl: async (_url, init) => {
    if (failed) throw new Error("room unavailable");
    return json({ values: JSON.parse(init.body).ids.map(id => ({ id, value: 30, state: 0 })) });
  } });
  const before = await service.poll(); failed = true;
  const error = once(service, "refresh-error");
  await service.refreshPoints([point("L101").id]);
  assert.deepEqual(service.getSnapshot(), before);
  assert.equal((await error)[0].error, "room unavailable");
});

test("settings API changes are shared with SSE clients and survive restart; pause and manual refresh are explicit", async t => {
  const directory = temporary(t);
  const widgetsFile = path.join(directory, "widgets.json");
  fs.writeFileSync(widgetsFile, JSON.stringify([point("L101")]));
  const config = loadConfig({ DEMO_MODE: "false", WIDGETS_FILE: widgetsFile, MIDDLEWARE_USER: "fixture", MIDDLEWARE_PASSWORD: "hidden" });
  const service = poller({ widgets: config.widgets }); t.after(() => service.stop());
  const app = createApp({ poller: service, config });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const stream = await fetch(base + "/events"); const reader = stream.body.getReader();
  await reader.read();
  const lightStream = await fetch(base + "/api/dashboard/events"); const lightReader = lightStream.body.getReader();
  const initialSettings = new TextDecoder().decode((await lightReader.read()).value);
  assert.match(initialSettings, /event: dashboard-settings/);
  assert.doesNotMatch(initialSettings, /snapshot|widgets|LtPct/);
  const response = await post("/api/dashboard/settings", defaults); assert.equal(response.status, 200);
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /event: dashboard-settings/); assert.doesNotMatch(event, /hidden/);
  assert.equal((await (await fetch(base + "/api/config")).json()).dashboardSettings.intervalMs, defaults.intervalMs);
  assert.equal(new DashboardSettingsStore(config).values.readBatchSize, 128);
  assert.equal((await post("/api/dashboard/settings", { readBatchSize: 1000 })).status, 400);
  assert.equal((await post("/api/dashboard/pause", { paused: "true" })).status, 400);
  assert.equal((await post("/api/dashboard/pause", { paused: true })).status, 200);
  assert.equal(service.getPollingState().paused, true);
  assert.equal((await post("/api/dashboard/refresh", {})).status, 202);
  await service.poll({ manual: true }); assert.equal(service.getPollingState().paused, true);
  await reader.cancel();
  await lightReader.cancel();
});

test("portable backups include general settings and legacy imports preserve the destination settings", t => {
  const directory = temporary(t), widgetsFile = path.join(directory, "widgets.json");
  fs.writeFileSync(widgetsFile, JSON.stringify([point("L101")]));
  const config = { ...defaults, demoMode: false, widgetsFile, widgets: [point("L101")] };
  const store = new DashboardSettingsStore(config); store.save({ afterWriteScope: "device" });
  const transfer = new DashboardTransfer(config), exported = transfer.export();
  assert.equal(exported.version, 2); assert.equal(exported.dashboardSettings.afterWriteScope, "device");
  exported.dashboardSettings.intervalMs = 300_000;
  transfer.apply(exported, transfer.prepare(exported).token);
  assert.equal(new DashboardSettingsStore(config).values.intervalMs, 300_000);
  delete exported.dashboardSettings;
  transfer.apply(exported, transfer.prepare(exported).token);
  assert.equal(new DashboardSettingsStore(config).values.intervalMs, 300_000);
});

test("an interrupted four-file import restores general settings alongside the existing configuration", t => {
  const directory = temporary(t), widgetsFile = path.join(directory, "widgets.json");
  fs.writeFileSync(widgetsFile, "[]");
  const store = new DashboardSettingsStore({ ...defaults, widgetsFile }); store.save({ intervalMs: 200_000 });
  const id = `2026-11-05T10-00-00.000Z-${require("node:crypto").randomUUID()}`;
  const backup = path.join(directory, "transfer-backups", id); fs.mkdirSync(backup, { recursive: true });
  fs.copyFileSync(widgetsFile, path.join(backup, "widgets.json"));
  fs.copyFileSync(store.filePath, path.join(backup, "dashboard-settings.json"));
  store.save({ intervalMs: 500_000 });
  fs.writeFileSync(path.join(directory, ".dashboard-transfer.json"), JSON.stringify({ id, existed: [true, false, false, true], phase: "prepared" }));
  initializeTransferFiles({ WIDGETS_FILE: widgetsFile });
  assert.equal(new DashboardSettingsStore({ ...defaults, widgetsFile }).values.intervalMs, 200_000);
});

test("failure replacing the final settings file rolls back all four files", t => {
  const directory = temporary(t), widgetsFile = path.join(directory, "widgets.json");
  fs.writeFileSync(widgetsFile, JSON.stringify([point("L101")]));
  const config = { ...defaults, demoMode: false, widgetsFile, widgets: [point("L101")] };
  const store = new DashboardSettingsStore(config); store.save(defaults);
  const exported = new DashboardTransfer(config).export(); exported.dashboardSettings.intervalMs = 500_000;
  const transfer = new DashboardTransfer(config, { fsImpl: { ...fs, renameSync(from, to) {
    if (to === store.filePath && from.endsWith(".import")) throw new Error("Fixture disk failure");
    return fs.renameSync(from, to);
  } } });
  const before = transfer.location.files.map(file => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  assert.throws(() => transfer.apply(exported, transfer.prepare(exported).token), error => error.code === "TRANSFER_SAVE_FAILED");
  assert.deepEqual(transfer.location.files.map(file => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null), before);
});

test("resuming before an interrupted request completes still starts a fresh full read without overlap", async () => {
  let release, count = 0, active = 0, maximum = 0;
  const service = poller({ fetchImpl: async (_url, init) => {
    count++; active++; maximum = Math.max(maximum, active);
    if (count === 1) await new Promise(resolve => { release = resolve; });
    active--;
    return json({ values: JSON.parse(init.body).ids.map(id => ({ id, value: 30, state: 0 })) });
  } });
  const old = service.poll(); service.setPaused(true); service.setPaused(false);
  release(); await old; await tick();
  assert.equal(count, 2); assert.equal(maximum, 1);
  assert.equal(service.getSnapshot().status, "connected");
  service.stop();
});

test("a full refresh started by resume can be paused again between requests", async () => {
  let release, reads = 0;
  const service = poller({ readBatchSize: 1, readBatchDelayMs: 0, fetchImpl: async (_url, init) => {
    reads++;
    await new Promise(resolve => { release = resolve; });
    return json({ values: JSON.parse(init.body).ids.map(id => ({ id, value: 30, state: 0 })) });
  } });
  service.setPaused(true); service.setPaused(false);
  assert.equal(service.getPollingState().manual, false);
  service.setPaused(true); release(); await tick();
  assert.equal(reads, 1); service.stop();
});
