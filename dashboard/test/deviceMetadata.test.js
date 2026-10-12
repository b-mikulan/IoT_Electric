const test = require("node:test");
const assert = require("node:assert/strict");
const { DeviceMetadataClient } = require("../lib/deviceMetadata");

const config = { middlewareUrl: "http://middleware:3000/", username: "client", password: "secret", timeoutMs: 500 };
const first = "01/ES/Network/RP31/Application/Zones/Z312/L3307/Values/LtPct";
const second = "01/ES/Network/RP32/Application/Zones/Z312/L3307/Values/LtPct";
const result = (payload) => ({ ok: true, json: async () => payload });
const itemResponse = (items) => ({ GetItemsItems: { ValueItems: { ValueItem: items } }, GetItemsErrorResults: "" });
const item = (id, extra = {}) => ({ Id: id, Name: "LtPct", Description: "Brightness", Type: "double", Unit: "%", Writeable: 1, Forceable: "0", ...extra });

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
