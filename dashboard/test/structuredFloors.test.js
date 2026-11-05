const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DeviceWidgetStore } = require("../lib/deviceWidgetStore");
const { DashboardTransfer } = require("../lib/dashboardTransfer");
const { buildDevices, createDeviceIndex } = require("../public/deviceModel");
const { createApp } = require("../app");
const { EventEmitter } = require("node:events");

const first = "ES/Zones/Z101/S101", second = "ES/Zones/Z201/S201";
const widgets = [first, second].map(key => ({ id: `01/${key}/Values/RmTmp`, unit: "°C", value: 20, state: 0, writable: false }));
const legacyRooms = { "ES/Zones/Z101": "Kitchen · 1. kat", "ES/Zones/Z201": "Kitchen · 2. kat" };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "structured-floors-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "device-widgets.json");
  const store = new DeviceWidgetStore(file);
  const context = { deviceKeys: [first, second], pointIds: widgets.map(w => w.id), roomNames: Object.values(legacyRooms) };
  await store.synchronize(context.deviceKeys, context);
  return { directory, file, store, context };
}
const modelOptions = store => ({ roomByZone: legacyRooms, deviceSettings: store.devices, floors: store.floors, roomDetails: store.roomDetails });

test("legacy floor suffixes migrate once into explicit room membership and later names never determine floors", async t => {
  const { file, store, context } = await fixture(t);
  assert.deepEqual(store.floors, [{ id: "floor:1", name: "1. kat" }, { id: "floor:2", name: "2. kat" }]);
  const models = buildDevices(widgets, modelOptions(store));
  assert.deepEqual(models.map(d => [d.room.label, d.room.floorId]), [["Kitchen", "floor:1"], ["Kitchen", "floor:2"]]);
  assert.notEqual(models[0].room.id, models[1].room.id);
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(raw.organizationVersion, 1);
  await store.changeFloor("rename", { id: "floor:1", name: "1. kat A" }, context);
  await store.updateRoom(models[0].room.id, "Laboratory · 9. kat", "floor:1", context);
  const restarted = new DeviceWidgetStore(file); await restarted.synchronize(context.deviceKeys, context);
  const updated = buildDevices(widgets, modelOptions(restarted));
  assert.equal(updated[0].room.label, "Laboratory · 9. kat");
  assert.equal(updated[0].room.floorId, "floor:1");
  assert.equal(updated[0].room.floorLabel, "1. kat A");
  assert.equal(restarted.floors.length, 2);
});

test("custom groups allow equal room names on different groups and moving a room updates every member without changing its ID", async t => {
  const { store, context } = await fixture(t);
  const { floor } = await store.changeFloor("create", { name: "1. kat B" }, context);
  const room = await store.createRoom("Kitchen", { floorId: floor.id });
  await store.assignRoom([first, second], room, context);
  const saved = { ...store.devices[0], label: "Keep name", primaryPointId: widgets[0].id, primaryUnit: "°C", secondaryPointIds: [] };
  await store.save(saved, context);
  await store.updateRoom(room, "Studio", "floor:2", context);
  assert.equal(store.devices[0].room, room);
  assert.equal(store.devices[0].label, "Keep name");
  const devices = buildDevices(widgets, modelOptions(store));
  assert(devices.every(d => d.room.floorId === "floor:2" && d.room.id === room));
  await assert.rejects(store.createRoom("Kitchen", { floorId: "floor:2" }), { code: "INVALID_DEVICE_SETTINGS" });
  await assert.rejects(store.createRoom("Unknown", { floorId: "missing" }), { code: "INVALID_DEVICE_SETTINGS" });
  const empty = await store.createRoom("No floor · 3. kat", { floorId: null });
  assert.equal(store.roomDetails.find(r => r.id === empty).floorId, null);
});

test("deleting a floor preserves distinct same-name rooms, assignments, settings and future unknown membership", async t => {
  const { store, context } = await fixture(t);
  await store.changeFloor("delete", { id: "floor:1" }, context);
  await store.changeFloor("delete", { id: "floor:2" }, context);
  assert.equal(store.floors.length, 0);
  assert.equal(store.roomDetails.length, 2);
  assert(store.roomDetails.every(r => r.name === "Kitchen" && r.floorId === null));
  const models = buildDevices(widgets, modelOptions(store));
  assert.notEqual(models[0].room.id, models[1].room.id);
  assert(models.every(d => d.room.label === "Kitchen" && d.room.floorId === null));
  assert.equal(store.devices.length, 2);
});

test("failed floor persistence leaves file and published membership unchanged", async t => {
  const { file, store, context } = await fixture(t);
  const before = await fs.readFile(file, "utf8");
  const failing = new DeviceWidgetStore(file, { fsImpl: { ...fs, async rename() { throw new Error("disk full"); } } });
  await failing.synchronize(context.deviceKeys, context);
  await assert.rejects(failing.changeFloor("rename", { id: "floor:1", name: "Not saved" }, context), { code: "DEVICE_WIDGET_FILE_WRITE_FAILED" });
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual(failing.floors, store.floors);
});

test("creating a room before the first config read migrates all known automatic rooms", async t => {
  const { directory, context } = await fixture(t);
  const cold = new DeviceWidgetStore(path.join(directory, "cold.json"));
  await cold.createRoom("New studio", { floorId: null, roomNames: context.roomNames });
  assert.equal(cold.floors.length, 2);
  assert.equal(cold.roomDetails.length, 3);
});

test("new room creation during bulk assignment is atomic and imported structure round-trips with version 2", async t => {
  const { directory, file, store, context } = await fixture(t);
  await store.assignRoom([first, second], "", context, { name: "Shared studio", floorId: "floor:1" });
  const id = store.devices[0].room;
  assert.equal(store.devices[1].room, id);
  const widgetsFile = path.join(directory, "widgets.json"), metadataFile = path.join(directory, "catalog-metadata.json");
  await fs.writeFile(widgetsFile, JSON.stringify(widgets));
  await fs.writeFile(metadataFile, JSON.stringify({ schemaVersion: 1, metadataById: {}, roomByZone: legacyRooms }));
  const transfer = new DashboardTransfer({ widgetsFile, deviceWidgetsFile: file, deviceMetadataFile: metadataFile, demoMode: false });
  const exported = transfer.export();
  assert.equal(exported.version, 2);
  assert.equal(transfer.prepare(exported).summary.floors, 2);
  const preview = transfer.prepare(exported); transfer.apply(exported, preview.token);
  const reloaded = transfer.export();
  assert.deepEqual(reloaded.deviceWidgets, exported.deviceWidgets);
  const broken = structuredClone(exported); broken.deviceWidgets.roomDetails[0].floorId = "does-not-exist";
  assert.throws(() => transfer.prepare(broken), error => error.status === 400);
});

test("incremental values retain explicit arbitrary group names and stable room identity", async t => {
  const { store, context } = await fixture(t);
  await store.changeFloor("rename", { id: "floor:1", name: "North wing" }, context);
  const index = createDeviceIndex(widgets, modelOptions(store));
  const changed = index.updateValues([{ id: widgets[0].id, value: 24 }]);
  assert.equal(changed[0].room.floorLabel, "North wing");
  assert.equal(changed[0].room.id, "Kitchen · 1. kat");
});

test("floor HTTP operations synchronize complete organization to other clients without EWS reads", async t => {
  const f = await fixture(t);
  const poller = new EventEmitter(); poller.getSnapshot = () => ({ widgets, status: "connected" });
  const app = createApp({ poller, config: { demoMode: false, widgets, widgetsFile: path.join(f.directory, "widgets.json"), deviceWidgetsFile: f.file }, deviceWidgetStore: f.store, deviceMetadata: { roomNames: () => Object.values(legacyRooms) } });
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => { const r = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); assert(r.ok); return r.json(); };
  const abort = new AbortController();
  const events = await fetch(base + "/events", { signal: abort.signal }); const reader = events.body.getReader(); await reader.read();
  const created = await post("/api/floors/create", { name: "1. kat A" });
  assert(created.floors.some(f => f.name === "1. kat A"));
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /device-settings/); assert.match(event, /roomDetails/); assert.match(event, /1\. kat A/); abort.abort();
  const room = await post("/api/rooms", { name: "Studio", floorId: created.floor.id });
  assert.equal(room.roomDetails.find(r => r.id === room.room).floorId, created.floor.id);
  await post("/api/rooms/update", { id: room.room, name: "Studio B", floorId: "floor:2" });
  await post("/api/floors/rename", { id: created.floor.id, name: "West wing" });
  await post("/api/floors/delete", { id: created.floor.id });
  const config = await (await fetch(base + "/api/config")).json();
  assert(config.roomDetails.some(r => r.id === room.room && r.name === "Studio B" && r.floorId === "floor:2"));
});
