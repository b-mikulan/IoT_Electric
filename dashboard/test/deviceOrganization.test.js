const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../app");
const { loadConfig } = require("../lib/config");
const { PointPoller } = require("../lib/telemetry/pointPoller");
const { WidgetStore } = require("../lib/storage/widgetStore");
const { DeviceWidgetStore } = require("../lib/storage/deviceWidgetStore");
const { deriveWidgetGrouping } = require("../public/devices/widgetGrouping");

const first = "ES/RP1/Application/Items/AC1";
const second = "ES/RP2/Application/Items/AC1";
const technical = "01/ES/RP1/Application/Extrernal Bindings Pro";

async function start(t, roomByZone = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "device-organization-"));
  const widgetsFile = path.join(directory, "widgets.json");
  const settingsFile = path.join(directory, "device-widgets.json");
  const widgets = [
    { id: `01/${first}/Values/RmTmp`, group: "Shared", unit: "°C" },
    { id: `01/${first}/Values/EffSpt`, group: "Shared", unit: "°C" },
    { id: `01/${first}/Values/IduAlm`, visible: false },
    { id: `01/${second}/Values/RmTmp`, group: "Shared", unit: "°C" },
    { id: `${technical}/Count`, group: "Shared" },
    { id: `${technical}/Enabled`, visible: false },
  ];
  const raw = JSON.stringify(widgets);
  await fs.writeFile(widgetsFile, raw);
  const config = loadConfig({ WIDGETS_FILE: widgetsFile, DEMO_MODE: "false", MIDDLEWARE_USER: "fixture", MIDDLEWARE_PASSWORD: "fixture" });
  const reads = [];
  const poller = new PointPoller({ middlewareUrl: "http://fixture", widgets: config.widgets, fetchImpl: async (_url, options) => {
    const { ids } = JSON.parse(options.body); reads.push(ids);
    return { ok: true, json: async () => ({ values: ids.map((id) => ({ id, value: 1, state: 0 })) }) };
  } });
  const widgetStore = new WidgetStore(widgetsFile);
  const deviceWidgetStore = new DeviceWidgetStore(settingsFile);
  let metadataReads = 0;
  const app = createApp({ poller, config, widgetStore, deviceWidgetStore, deviceMetadata: { async read() { metadataReads++; return { roomByZone, metadataById: {} }; } } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    poller.stop();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await deviceWidgetStore.synchronize([]);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, method = "POST") => fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await fetch(base + "/api/config");
  return { base, request, widgetsFile, settingsFile, raw, config, widgetStore, deviceWidgetStore, poller, reads, metadataReads: () => metadataReads };
}

test("automatic rooms can be renamed and deleted without controller reads or removing any devices", async (t) => {
  const f = await start(t, { [first]: "Server room" });
  await fetch(f.base + "/api/devices/metadata");
  const renamed = await f.request("/api/rooms/rename", { name: "Server room", newName: "Office" });
  assert.equal(renamed.status, 200);
  assert.deepEqual((await renamed.json()).roomRules, [{ from: "Server room", to: "Office" }]);
  const deleted = await f.request("/api/rooms/delete", { name: "Office" });
  assert.equal(deleted.status, 200);
  const payload = await deleted.json();
  assert.deepEqual(payload.rooms, []);
  assert.deepEqual(payload.roomRules, [{ from: "Server room", to: "" }, { from: "Office", to: "" }]);
  assert.equal(payload.devices.length, 3);
  assert.equal(await fs.readFile(f.widgetsFile, "utf8"), f.raw);
  assert.equal(f.reads.length, 0);
  assert.equal(f.metadataReads(), 1);
  const configuration = await (await fetch(f.base + "/api/config")).json();
  assert.deepEqual(configuration.roomRules, payload.roomRules);
  assert.equal(configuration.widgets.length, 6);
});

test("room rename and deletion reject conflicts and failed saves without partial changes", async (t) => {
  const f = await start(t);
  await f.request("/api/rooms", { name: "Office" });
  await f.request("/api/rooms", { name: "Taken" });
  const before = await fs.readFile(f.settingsFile, "utf8");
  assert.equal((await f.request("/api/rooms/rename", { name: "Office", newName: "taken" })).status, 409);
  assert.equal((await f.request("/api/rooms/rename", { name: "Office", newName: "" })).status, 400);
  assert.equal((await f.request("/api/rooms/delete", { name: "Missing" })).status, 404);
  assert.equal(await fs.readFile(f.settingsFile, "utf8"), before);
  f.deviceWidgetStore.deleteRoom = async () => { throw new Error("fixture failure"); };
  assert.equal((await f.request("/api/rooms/delete", { name: "Office" })).status, 500);
  assert.equal(await fs.readFile(f.settingsFile, "utf8"), before);
});

test("renaming and deleting a room synchronize preferences and automatic rules to other clients", async (t) => {
  const f = await start(t);
  await f.request("/api/devices/rooms", { keys: [first, second], room: "Office" });
  const stream = await fetch(f.base + "/events", { signal: AbortSignal.timeout(2000) });
  const reader = stream.body.getReader();
  await reader.read();
  assert.equal((await f.request("/api/rooms/rename", { name: "Office", newName: "Lab" })).status, 200);
  const renameEvent = new TextDecoder().decode((await reader.read()).value);
  assert.match(renameEvent, /event: device-settings/);
  assert.match(renameEvent, /"roomRules":\[\{"from":"Office","to":"Lab"\}\]/);
  assert.equal((await f.request("/api/rooms/delete", { name: "Lab" })).status, 200);
  const deleteEvent = new TextDecoder().decode((await reader.read()).value);
  assert.match(deleteEvent, /"room":""/);
  assert.match(deleteEvent, /"from":"Office","to":""/);
  await reader.cancel();
});

test("rooms can be created empty and a bulk move changes only selected device room settings", async (t) => {
  const f = await start(t);
  const created = await f.request("/api/rooms", { name: "Empty room" });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).rooms, ["Empty room"]);
  const original = { key: first, label: "My AC", room: null, primaryPointId: `01/${first}/Values/RmTmp`, primaryUnit: "custom", secondaryPointIds: [] };
  assert.equal((await f.request("/api/devices/settings", original)).status, 200);
  const moved = await f.request("/api/devices/rooms", { keys: [first, second], room: "Office" });
  assert.equal(moved.status, 200);
  const result = await moved.json();
  assert.equal(result.moved, 2);
  assert.deepEqual(result.devices.find((d) => d.key === first), { ...original, room: "Office" });
  assert.equal(result.devices.find((d) => d.key === second).room, "Office");
  assert.equal(result.devices.find((d) => d.key === technical).room, null);
  assert.deepEqual((await (await fetch(f.base + "/api/config")).json()).rooms, ["Empty room", "Office"]);
  assert.equal(await fs.readFile(f.widgetsFile, "utf8"), f.raw);
  assert.equal(f.reads.length, 0);
});

test("room endpoints reject invalid or stale selections without changing any stored assignments", async (t) => {
  const f = await start(t);
  const before = await fs.readFile(f.settingsFile, "utf8");
  for (const body of [{ keys: [first, "missing"], room: "New" }, { keys: [first, first], room: "New" }, { keys: [], room: "New" }, { keys: [first], room: 7 }]) {
    const response = await f.request("/api/devices/rooms", body);
    assert.ok([400, 404].includes(response.status));
  }
  assert.equal((await f.request("/api/rooms", { name: " " })).status, 400);
  assert.equal(await fs.readFile(f.settingsFile, "utf8"), before);
});

test("removing a technical card removes all its points including hidden ones and leaves equal names and raw groups alone", async (t) => {
  const f = await start(t);
  const response = await f.request("/api/devices", { key: technical }, "DELETE");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.removed, 2);
  assert.ok(result.ids.every((id) => deriveWidgetGrouping(id).key === technical));
  const persisted = JSON.parse(await fs.readFile(f.widgetsFile, "utf8"));
  assert.equal(persisted.length, 4);
  assert.ok(persisted.some((w) => w.id === `01/${second}/Values/RmTmp`));
  assert.ok(persisted.some((w) => w.id === `01/${first}/Values/RmTmp`));
  await f.poller.poll();
  assert.equal(f.reads.flat().length, 4);
  assert.ok(f.reads.flat().every((id) => !result.ids.includes(id)));
  const restarted = loadConfig({ WIDGETS_FILE: f.widgetsFile, DEMO_MODE: "false", MIDDLEWARE_USER: "fixture", MIDDLEWARE_PASSWORD: "fixture" });
  assert.equal(restarted.widgets.length, 4);
  assert.equal((await f.request("/api/devices", { key: technical }, "DELETE")).status, 404);
});

test("a failed device removal retains the file, active points and card configuration", async (t) => {
  const f = await start(t);
  f.widgetStore.removeMany = async () => { throw new Error("Simulated storage failure"); };
  const response = await f.request("/api/devices", { key: first }, "DELETE");
  assert.equal(response.status, 500);
  assert.equal(await fs.readFile(f.widgetsFile, "utf8"), f.raw);
  assert.equal(f.config.widgets.length, 6);
  assert.equal(f.poller.getSnapshot().widgets.length, 6);
});

test("device removal is disabled in demo mode even if a writable store is injected", async (t) => {
  const f = await start(t);
  f.config.demoMode = true;
  assert.equal((await f.request("/api/devices", { key: first }, "DELETE")).status, 409);
  assert.equal(await fs.readFile(f.widgetsFile, "utf8"), f.raw);
});

test("room creation synchronizes the registry to an already open dashboard connection", async (t) => {
  const f = await start(t);
  const stream = await fetch(f.base + "/events", { signal: AbortSignal.timeout(2000) });
  const reader = stream.body.getReader();
  await reader.read();
  assert.equal((await f.request("/api/rooms", { name: "Conference room" })).status, 201);
  const update = new TextDecoder().decode((await reader.read()).value);
  assert.match(update, /event: device-settings/);
  assert.match(update, /"rooms":\["Conference room"\]/);
  await reader.cancel();
});
