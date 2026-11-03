const test = require("node:test");
const assert = require("node:assert/strict");
const { DeviceMetadataClient } = require("../lib/deviceMetadata");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../lib/config");

const config = { middlewareUrl: "http://middleware:3000/", username: "client", password: "secret", timeoutMs: 500 };
const first = "01/ES/Network/RP31/Application/Zones/Z312/L3307/Values/LtPct";
const second = "01/ES/Network/RP32/Application/Zones/Z312/L3307/Values/LtPct";
const result = (payload) => ({ ok: true, json: async () => payload });
const itemResponse = (items) => ({ GetItemsItems: { ValueItems: { ValueItem: items } }, GetItemsErrorResults: "" });
const item = (id, extra = {}) => ({ Id: id, Name: "LtPct", Description: "Brightness", Type: "double", Unit: "%", Writeable: 1, Forceable: "0", ...extra });

test("catalog display metadata covers more than 2000 configured points without controller reads and still refreshes commands live", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iot-catalog-descriptors-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "catalog-metadata.json");
  const ids = Array.from({ length: 3525 }, (_, index) => `01/ES/Zones/Z1/Light${index}/Values/LtPct`);
  fs.writeFileSync(filename, JSON.stringify({ schemaVersion: 1, catalog: { capturedAt: "2026-10-28T18:27:07Z" },
    metadataById: Object.fromEntries(ids.map((id) => [id, { id, name: "LtPct", writeable: true, unit: "%" }])),
    roomByZone: { "ES/Zones/Z1": "Kitchen", "Other/Zones/Z1": "Unrelated" } }));
  let calls = 0;
  const client = new DeviceMetadataClient({ ...config, deviceMetadataFile: filename }, { fetchImpl: async (url, options) => {
    calls += 1;
    assert.ok(url.endsWith("/api/items/read"));
    assert.deepEqual(JSON.parse(options.body).ids, [ids[0]]);
    return result(itemResponse(item(ids[0], { Writeable: 0, Value: 12, State: 0 })));
  } });
  const displayed = await client.read(ids);
  assert.equal(calls, 0);
  assert.equal(Object.keys(displayed.metadataById).length, 3525);
  assert.deepEqual({ ...displayed.roomByZone }, { "ES/Zones/Z1": "Kitchen" });
  assert.deepEqual(displayed.warnings, []);
  assert.equal(displayed.source, "catalog");
  assert.equal(displayed.capturedAt, "2026-10-28T18:27:07Z");
  displayed.metadataById[ids[0]].writeable = false;
  assert.equal((await client.read([ids[0]])).metadataById[ids[0]].writeable, true);
  const missing = await client.read(["01/unmapped"]);
  assert.equal(Object.keys(missing.metadataById).length, 0);
  assert.equal(missing.warnings.length, 1);
  assert.equal(calls, 0);
  const fresh = await client.readFreshPoint(ids[0]);
  assert.equal(calls, 1);
  assert.equal(fresh.metadata.writeable, false);
  assert.equal(fresh.widget.value, 12);
});

test("detects adjacent catalog metadata, validates files and leaves demo mode independent", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iot-catalog-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const widgetsFile = path.join(directory, "widgets.json");
  const metadataFile = path.join(directory, "catalog-metadata.json");
  fs.writeFileSync(widgetsFile, "[]");
  fs.writeFileSync(metadataFile, "{}");
  const settings = loadConfig({ WIDGETS_FILE: widgetsFile, DEMO_MODE: "false", MIDDLEWARE_USER: "client", MIDDLEWARE_PASSWORD: "secret" });
  assert.equal(settings.deviceMetadataFile, metadataFile);
  assert.throws(() => new DeviceMetadataClient(settings), /Unable to load DEVICE_METADATA_FILE/);
  assert.equal(loadConfig({ DEMO_MODE: "true", WIDGETS_JSON: "[]", DEVICE_METADATA_FILE: "explicit.json" }).deviceMetadataFile, "explicit.json");
  const demo = new DeviceMetadataClient({ demoMode: true, deviceMetadataFile: "missing.json" });
  assert.deepEqual(await demo.read([first]), { metadataById: {}, roomByZone: {}, warnings: [] });
});

test("reads only configured IDs, preserves exact enum zero and derives rooms from the full controller path", async () => {
  const calls = [];
  const client = new DeviceMetadataClient(config, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    const body = options.body && JSON.parse(options.body);
    if (parsed.pathname === "/api/items/read") return result(itemResponse([item(first, { EnumId: "~/mode" }), item(second), item("unrequested")]));
    if (parsed.pathname === "/api/enums/read") {
      assert.deepEqual(body, { ids: ["~/mode"] });
      return result({ GetEnumsEnums: { Enum: { Id: "", EnumValues: { EnumValue: [{ Value: 0, Text: "Off" }, { Value: 4, Text: "Auto" }] } } } });
    }
    const id = parsed.searchParams.get("id");
    assert.equal(parsed.searchParams.get("metadata"), "true");
    assert.equal(parsed.searchParams.get("allPages"), "false");
    return result({ containers: [{ id, description: id.includes("RP31") ? "Kitchen" : "Bedroom", name: "Z312" }], errors: [] });
  } });
  const metadata = await client.read([{ id: first }, { id: first }, { id: second }]);
  assert.equal(calls.length, 4);
  assert.deepEqual(JSON.parse(calls[0].options.body), { ids: [first, second], metadata: true });
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from("client:secret").toString("base64")}`);
  assert.equal(metadata.metadataById[first].writeable, true);
  assert.equal(metadata.metadataById[first].forceable, false);
  assert.deepEqual(metadata.metadataById[first].enumValues, [{ value: 0, label: "Off" }, { value: 4, label: "Auto" }]);
  assert.equal(metadata.metadataById.unrequested, undefined);
  assert.deepEqual(metadata.roomByZone, { "ES/Network/RP31/Application/Zones/Z312": "Kitchen", "ES/Network/RP32/Application/Zones/Z312": "Bedroom" });
  assert.deepEqual(metadata.warnings, []);
  const publicResult = JSON.stringify(metadata);
  assert.equal(publicResult.includes("secret"), false);
  assert.equal(publicResult.includes("Authorization"), false);
});

test("deduplicates concurrent and reordered reads, clones cached data, invalidates on configured ID changes", async () => {
  let calls = 0;
  const client = new DeviceMetadataClient(config, { fetchImpl: async (_url, options) => {
    calls += 1;
    const { ids } = JSON.parse(options.body);
    await Promise.resolve();
    return result(itemResponse(ids.map((id) => item(id))));
  } });
  const ids = ["01/ES/Values/A", "01/ES/Values/B"];
  const [left, right] = await Promise.all([client.read(ids), client.read([...ids].reverse())]);
  assert.equal(calls, 1);
  left.metadataById[ids[0]].name = "changed";
  assert.equal(right.metadataById[ids[0]].name, "LtPct");
  assert.equal((await client.read(ids)).metadataById[ids[0]].name, "LtPct");
  await client.read([ids[0]]);
  assert.equal(calls, 2);
});

test("real installation paths assign Kitchen to RP32 lighting without assigning AC309 or B301 a room", async () => {
  const root = "03AS001/[BACnet Interface]/IP Network";
  const zone = `${root}/RP32/Application/Zones/Z312`;
  const light = `01/${zone}/L3307/Values/LtPct`;
  const alias = `11/${zone}/L3307/Values/LtPct/Value`;
  const ac = `01/${root}/RP31/IO Resources/Modbus/AC309/Points/Holding Registers/SysMdCtrl`;
  const blind = `01/${root}/RP32/Application/Blinds/B301/Values/BlPosCtrl`;
  const zones = [];
  const client = new DeviceMetadataClient(config, { fetchImpl: async (url, options) => {
    if (url.endsWith("/api/items/read")) return result(itemResponse(JSON.parse(options.body).ids.map((id) => item(id))));
    const id = new URL(url).searchParams.get("id");
    zones.push(id);
    return result({ containers: [{ id: `00/${zone}`, name: "Z312", description: "Kitchen", type: "folder", containerItems: [] }], errors: [], status: null, complete: null, pagesRead: 1 });
  } });
  const metadata = await client.read([light, alias, ac, blind]);
  assert.deepEqual(zones, [`00/${zone}`]);
  assert.deepEqual(metadata.roomByZone, { [zone]: "Kitchen" });
  assert.equal(Object.keys(metadata.metadataById).length, 4);
});

test("returns usable partial metadata and safe warnings for item errors, unrelated enums and failed rooms", async () => {
  const sensitive = "http://user:secret@controller/?token=hidden";
  const client = new DeviceMetadataClient(config, { fetchImpl: async (url) => {
    if (url.endsWith("/api/items/read")) return result({ ...itemResponse(item(first, { EnumId: "~/wanted" })), GetItemsErrorResults: { ErrorResult: { Id: second, Message: sensitive } } });
    if (url.endsWith("/api/enums/read")) return result({ GetEnumsEnums: { Enum: { Id: "~/wrong", EnumValues: { EnumValue: { Value: 0, Text: "Wrong" } } } } });
    throw new Error(sensitive);
  } });
  const metadata = await client.read([first, second]);
  assert.equal(metadata.metadataById[first].type, "double");
  assert.deepEqual(metadata.metadataById[first].enumValues, []);
  assert.equal(metadata.metadataById[second], undefined);
  assert.deepEqual(metadata.roomByZone, {});
  assert.ok(metadata.warnings.length >= 3);
  assert.equal(JSON.stringify(metadata).includes("hidden"), false);
  assert.equal(JSON.stringify(metadata).includes("secret"), false);
});

test("does not treat navigation placeholders, controller names or sibling descriptions as room labels", async () => {
  const client = new DeviceMetadataClient(config, { fetchImpl: async (url, options) => {
    if (url.endsWith("/api/items/read")) return result(itemResponse(item(first)));
    const id = new URL(url).searchParams.get("id");
    return result({ containers: [{ id, name: "Z312", description: "Placeholder object used for navigation", containerItems: [{ id: `${id}/child`, description: "Kitchen" }] }] });
  } });
  const metadata = await client.read([first]);
  assert.deepEqual(metadata.roomByZone, {});
  assert.equal(metadata.warnings.length, 1);
});

test("refresh after TTL preserves previously known descriptors, enum options and room names on failures", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    let failing = false;
    let calls = 0;
    const client = new DeviceMetadataClient(config, { fetchImpl: async (url) => {
      calls += 1;
      if (failing) return { ok: false, status: 504 };
      if (url.endsWith("/api/items/read")) return result(itemResponse(item(first, { EnumId: "~/mode" })));
      if (url.endsWith("/api/enums/read")) return result({ GetEnumsEnums: { Enum: { Id: "~/mode", EnumValues: { EnumValue: { Value: 0, Text: "Off" } } } } });
      return result({ containers: [{ id: `00${first.slice(2).split("/L3307")[0]}`, name: "Z312", description: "Kitchen" }] });
    } });
    const initial = await client.read([first]);
    assert.equal(calls, 3);
    now += 59_999;
    await client.read([first]);
    assert.equal(calls, 3);
    failing = true;
    now += 2;
    const refreshed = await client.read([first]);
    assert.equal(calls, 6);
    assert.deepEqual(refreshed.metadataById, initial.metadataById);
    assert.deepEqual(refreshed.roomByZone, initial.roomByZone);
    assert.equal(refreshed.warnings.length, 3);
  } finally {
    Date.now = originalNow;
  }
});

test("reports SOAP faults and timeout without exposing middleware errors", async () => {
  for (const fetchImpl of [async () => result({ soapFault: { reason: "secret" } }), async () => { throw Object.assign(new Error("secret"), { name: "TimeoutError" }); }]) {
    const client = new DeviceMetadataClient(config, { fetchImpl });
    const metadata = await client.read(["01/ES/Values/A"]);
    assert.deepEqual(metadata.metadataById, {});
    assert.equal(metadata.warnings.length, 1);
    assert.equal(JSON.stringify(metadata).includes("secret"), false);
  }
});

test("bounded read batches and demo metadata never contact a controller", async () => {
  let calls = 0;
  const demo = new DeviceMetadataClient({ ...config, demoMode: true }, { fetchImpl: async () => { calls += 1; throw new Error("Unexpected request"); } });
  assert.deepEqual(await demo.read([first]), { metadataById: {}, roomByZone: {}, warnings: [] });
  assert.equal(calls, 0);
  const client = new DeviceMetadataClient(config, { fetchImpl: async (url, options) => {
    calls += 1;
    assert.ok(url.endsWith("/api/items/read"));
    const body = JSON.parse(options.body);
    assert.ok(body.ids.length <= 32);
    assert.equal(body.metadata, true);
    assert.ok(options.signal);
    return result(itemResponse(body.ids.map((id) => item(id))));
  } });
  const metadata = await client.read(Array.from({ length: 2001 }, (_, index) => `01/ES/Values/P${index}`));
  assert.equal(calls, 63);
  assert.equal(Object.keys(metadata.metadataById).length, 2000);
  assert.equal(metadata.warnings.length, 1);
});
