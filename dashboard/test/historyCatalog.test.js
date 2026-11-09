const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter, once } = require("node:events");
const { normalizeHistoryItems, buildHistoryCatalog } = require("../lib/telemetry/historyCatalog");
const { DeviceMetadataClient } = require("../lib/devices/deviceMetadata");
const { loadConfig } = require("../lib/config");
const { createApp } = require("../app");
const { DashboardTransfer } = require("../lib/storage/dashboardTransfer");

const valueId = "01/AS/Zones/Z1/Device/Values/RmTmp";
const historyId = "03/AS/Logs/Temperature";
const items = [{ id: historyId, name: "Temperature", description: "Room temperature", unit: "°C", valueItemId: valueId, parentIds: ["00/opaque-history-folder"] },
  { id: "03/unlinked", name: "Device", description: "A similar name is not a binding", valueItemId: "", unit: "none", parentIds: [] }];

function fixture(t, { legacy = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "trend-list-"));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(directory, "widgets.json"), JSON.stringify([{ id: valueId, label: "Temperature", unit: "°C" }]));
  fs.writeFileSync(path.join(directory, "device-widgets.json"), JSON.stringify({ version: 1, organizationVersion: 1, rooms: ["k1", "k2"], roomDetails: [{ id: "k1", name: "Kitchen", floorId: "f1" }, { id: "k2", name: "Kitchen", floorId: "f2" }],
    floors: [{ id: "f1", name: "1. kat" }, { id: "f2", name: "2. kat" }], devices: [{ key: "AS/Zones/Z1/Device", label: "Room sensor", room: "k1" }] }));
  const metadata = { schemaVersion: 1, metadataById: {}, roomByZone: {}, ...(legacy ? {} : { historyItems: items, historyCatalog: { capturedAt: "2026-10-28T18:00:00Z", snapshotId: 1, buildingKey: "default" } }) };
  fs.writeFileSync(path.join(directory, "catalog-metadata.json"), JSON.stringify(metadata));
  const config = loadConfig({ DEMO_MODE: "false", WIDGETS_FILE: path.join(directory, "widgets.json"), MIDDLEWARE_USER: "fixture", MIDDLEWARE_PASSWORD: "must-stay-private" });
  return { config, metadata, directory };
}

test("history definitions reject duplicate IDs and malformed metadata without inventing links", () => {
  assert.equal(normalizeHistoryItems(items).length, 2);
  for (const invalid of [null, {}, [items[0], items[0]], [{ id: "" }], [{ id: "valid", parentIds: "wrong" }], [{ id: "valid", valueItemId: 42 }]]) assert.throws(() => normalizeHistoryItems(invalid));
  const result = buildHistoryCatalog({ available: true, items: normalizeHistoryItems(items) }, [{ id: valueId }], {});
  assert.equal(result.items[0].device.key, "AS/Zones/Z1/Device");
  assert.equal(result.items[1].device, null);
  assert.deepEqual(result.items[0].parentIds, ["00/opaque-history-folder"]);
});

test("history API reads only saved definitions and reflects current room/floor assignments", async t => {
  const { config } = fixture(t);
  let upstream = 0;
  const metadata = new DeviceMetadataClient(config, { fetchImpl: async () => { upstream++; throw new Error("must not contact EWS"); } });
  const poller = new EventEmitter(); poller.getSnapshot = () => ({ widgets: [], status: "connected" });
  const server = createApp({ config, poller, deviceMetadata: metadata }).listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const first = await (await fetch(base + "/api/history/catalog")).json();
  assert.equal(first.total, 2); assert.equal(first.available, true);
  assert.equal(first.items[0].id, historyId); assert.equal(first.items[0].device.room.floorId, "f1");
  assert.equal(first.items[1].device, null); assert.doesNotMatch(JSON.stringify(first), /must-stay-private/);
  const moved = await fetch(base + "/api/devices/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: ["AS/Zones/Z1/Device"], room: "k2" }) });
  assert.equal(moved.status, 200);
  const after = await (await fetch(base + "/api/history/catalog")).json();
  assert.equal(after.items[0].device.room.floorId, "f2"); assert.equal(after.items[0].device.label, "Room sensor");
  assert.equal(upstream, 0);
});

test("legacy metadata has an explicit unavailable list and demo supplies its own history ID", t => {
  const { config } = fixture(t, { legacy: true });
  assert.equal(new DeviceMetadataClient(config).historyCatalog().available, false);
  const demo = new DeviceMetadataClient({ demoMode: true }, { fetchImpl: () => { throw new Error("no upstream"); } });
  assert.equal(demo.historyCatalog().items[0].id, "demo-history");
});

test("portable backups preserve all history definitions even when their value points are not configured", t => {
  const { config, metadata } = fixture(t);
  const transfer = new DashboardTransfer(config);
  const exported = transfer.export();
  assert.deepEqual(exported.metadata.historyItems, normalizeHistoryItems(items));
  assert.deepEqual(exported.metadata.historyCatalog, metadata.historyCatalog);
  transfer.apply(exported, transfer.prepare(exported).token);
  assert.equal(new DeviceMetadataClient(config).historyCatalog().items.length, 2);
  exported.metadata.historyItems.push({ ...items[0] });
  assert.throws(() => transfer.prepare(exported), error => error.status === 400);
});
