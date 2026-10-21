const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { DeviceCommandService } = require("../lib/deviceCommands");
const { DeviceMetadataClient } = require("../lib/deviceMetadata");
const { createApp } = require("../app");

const light = "01/ES/Network/RP31/Application/Items/L1/Values/LtPct";
const climate = "01/ES/Network/RP31/IO Resources/Modbus/AC1/Points/Holding Registers";
const reply = (payload) => ({ ok: true, json: async () => payload });
const itemResponse = (items) => ({ GetItemsItems: { ValueItems: { ValueItem: items } } });

function fixture({ id = light, value = 50, state = 0, metadata = {}, widget = {}, demoMode = false } = {}) {
  const config = { demoMode, widgets: [{ id, writable: true, visible: true, ...widget }] };
  const writes = [];
  const poller = new EventEmitter();
  poller.getSnapshot = () => ({ status: "connected", widgets: config.widgets });
  poller.writeValue = async (pointId, command) => { writes.push({ id: pointId, value: command }); return { success: true }; };
  let reads = 0;
  const fresh = { widget: { id, value, state, error: null }, metadata: { unit: "%", writeable: true, ...metadata } };
  const deviceMetadata = { async readFreshPoint(pointId) { reads += 1; assert.equal(pointId, id); return structuredClone(fresh); } };
  const service = new DeviceCommandService({ poller, config, deviceMetadata });
  return { config, poller, deviceMetadata, service, writes, fresh, reads: () => reads };
}

test("fresh command read bypasses the display cache and retains current state, explicit permission and enum zero", async () => {
  let calls = 0;
  const client = new DeviceMetadataClient({ middlewareUrl: "http://local-middleware", username: "mock-user", password: "mock-private" }, {
    fetchImpl: async (url, options) => {
      calls += 1;
      if (url.endsWith("/api/items/read")) {
        assert.deepEqual(JSON.parse(options.body), { ids: [light], metadata: true });
        return reply(itemResponse({ Id: light, Name: "LtPct", Unit: "%", Writeable: calls === 1 ? 1 : 0, State: calls === 1 ? 0 : 2, Value: calls === 1 ? 50 : 60, EnumId: "~/mode" }));
      }
      assert.deepEqual(JSON.parse(options.body), { ids: ["~/mode"] });
      return reply({ GetEnumsEnums: { Enum: { Id: "", EnumValues: { EnumValue: [{ Value: 0, Text: "Off" }, { Value: 1, Text: "On" }] } } } });
    },
  });
  const cached = await client.read([light]);
  assert.equal(cached.metadataById[light].writeable, true);
  const fresh = await client.readFreshPoint(light);
  assert.equal(fresh.widget.state, 2);
  assert.equal(fresh.widget.value, 60);
  assert.equal(fresh.metadata.writeable, false);
  assert.deepEqual(fresh.metadata.enumValues, [{ value: 0, label: "Off" }, { value: 1, label: "On" }]);
  assert.equal(calls, 4);
  assert.equal((await client.read([light])).metadataById[light].writeable, true);
  assert.equal(calls, 4);
});

test("fresh reads fail closed on duplicate, missing, error, bad enum and missing server permission", async () => {
  for (const payload of [itemResponse([]), itemResponse([{ Id: light }, { Id: light }]), { ...itemResponse({ Id: light }), GetItemsErrorResults: { ErrorResult: { Id: light } } }]) {
    const client = new DeviceMetadataClient({ middlewareUrl: "http://local" }, { fetchImpl: async () => reply(payload) });
    await assert.rejects(client.readFreshPoint(light));
  }
  const client = new DeviceMetadataClient({ middlewareUrl: "http://local" }, { fetchImpl: async () => reply(itemResponse({ Id: light, State: 0, Value: 0 })) });
  assert.equal((await client.readFreshPoint(light)).metadata.writeable, false);
  const brokenEnum = new DeviceMetadataClient({ middlewareUrl: "http://local" }, { fetchImpl: async (url) => reply(url.endsWith("/api/items/read")
    ? itemResponse({ Id: light, EnumId: "~/expected" })
    : { GetEnumsEnums: { Enum: { Id: "~/wrong", EnumValues: { EnumValue: { Value: 0, Text: "Off" } } } } }) });
  await assert.rejects(brokenEnum.readFreshPoint(light));
});

test("accepts a valid brightness command after a fresh check and writes the native point exactly once", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.write(light, 65), { id: light, success: true, message: "Naredba je prihvaćena; provjerava se stvarno stanje uređaja." });
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.writes, [{ id: light, value: 65 }]);
});

test("rejects demo, hidden, locally disabled, aliases, unknown functions and ambiguous owner roles before any network read", async () => {
  const cases = [
    fixture({ demoMode: true }), fixture({ widget: { visible: false } }), fixture({ widget: { writable: false } }),
    fixture({ id: light.replace(/^01\//, "11/") + "/Value" }),
    fixture({ id: light.replace(/LtPct$/, "DevErr") }), fixture({ id: light.replace(/LtPct$/, "Unknown") }),
  ];
  const ambiguous = fixture();
  ambiguous.config.widgets.push({ id: light.replace(/Values\/LtPct$/, "Points/LtPct"), writable: false });
  cases.push(ambiguous);
  for (const f of cases) {
    await assert.rejects(f.service.write(f.config.widgets[0].id, 20));
    assert.equal(f.reads(), 0);
    assert.equal(f.writes.length, 0);
  }
});

test("rejects fresh Forced, offline, missing state, errors and revoked server permission", async () => {
  for (const state of [2, 3, null, undefined, ""]) {
    const f = fixture({ state });
    if (state === undefined) delete f.fresh.widget.state;
    await assert.rejects(f.service.write(light, 20));
    assert.equal(f.writes.length, 0);
  }
  for (const mutation of [(f) => { f.fresh.metadata.writeable = false; }, (f) => { delete f.fresh.metadata.writeable; }, (f) => { f.fresh.widget.error = "read failed"; }]) {
    const f = fixture(); mutation(f);
    await assert.rejects(f.service.write(light, 20));
    assert.equal(f.writes.length, 0);
  }
});

test("numeric commands reject coercion and out-of-policy values", async () => {
  const f = fixture();
  for (const value of [-1, 101, "50", true, null, {}, NaN, Infinity]) await assert.rejects(f.service.write(light, value));
  assert.equal(f.writes.length, 0);
});

test("blind and slat commands send percentage endpoints and fractional percentages unchanged and reject values outside the confirmed range", async () => {
  for (const name of ["BlndPos", "BlndSlt"]) {
    const id = `01/ES/Network/RP31/Application/Items/B301/Values/${name}`;
    const f = fixture({ id, value: 36, metadata: { unit: "" } });
    for (const value of [0, 36, 100, 36.5]) await f.service.write(id, value);
    assert.deepEqual(f.writes, [{ id, value: 0 }, { id, value: 36 }, { id, value: 100 }, { id, value: 36.5 }]);
    for (const value of [-0.01, 100.01, "36", null, true, {}, NaN, Infinity]) {
      await assert.rejects(f.service.write(id, value));
    }
    assert.equal(f.writes.length, 4);
  }
});

test("confirmed blind and slat ranges do not bypass Forced, server read-only, local permission or native ID requirements", async () => {
  for (const name of ["BlndPos", "BlndSlt"]) {
    const id = `01/ES/Network/RP31/Application/Items/B301/Values/${name}`;
    for (const f of [
      fixture({ id, value: 36, state: 2, metadata: { unit: "" } }),
      fixture({ id, value: 36, metadata: { unit: "", writeable: false } }),
      fixture({ id, value: 36, widget: { writable: false }, metadata: { unit: "" } }),
      fixture({ id: id.replace(/^01\//, "11/") + "/Value", value: 36, metadata: { unit: "" } }),
    ]) {
      await assert.rejects(f.service.write(f.config.widgets[0].id, 50));
      assert.deepEqual(f.writes, []);
    }
  }
});

test("setpoints use the explicit dashboard test policy in the confirmed temperature unit", async () => {
  for (const [unit, min, max] of [["°C", 5, 35], ["°F", 41, 95], ["K", 278.15, 308.15]]) {
    const id = `${climate}/EffSpt`;
    const f = fixture({ id, value: min + 2, metadata: { unit } });
    await f.service.write(id, min);
    await f.service.write(id, max);
    await assert.rejects(f.service.write(id, min - 0.01));
    await assert.rejects(f.service.write(id, max + 0.01));
    assert.equal(f.writes.length, 2);
  }
  const unknown = fixture({ id: `${climate}/EffSpt`, value: 22, metadata: { unit: "" } });
  await assert.rejects(unknown.service.write(unknown.config.widgets[0].id, 23));
});

test("enumeration writes use exact fresh options and preserve canonical zero", async () => {
  const id = `${climate}/OnOffMd`;
  const f = fixture({ id, value: 1, metadata: { unit: "", enumValues: [{ value: 0, label: "Off" }, { value: 1, label: "On" }] } });
  await f.service.write(id, "0");
  assert.deepEqual(f.writes, [{ id, value: 0 }]);
  for (const value of [2, "00", true, null]) await assert.rejects(f.service.write(id, value));
  f.fresh.metadata.enumValues = [];
  await assert.rejects(f.service.write(id, 0));
});

test("configuration and connection are rechecked after a fresh read, and concurrent commands never overlap", async () => {
  const f = fixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.deviceMetadata.readFreshPoint = async () => { await gate; return f.fresh; };
  const first = f.service.write(light, 10);
  await assert.rejects(f.service.write(light, 20), (error) => error.code === "WRITE_IN_PROGRESS");
  f.config.widgets[0].writable = false;
  release();
  await assert.rejects(first, (error) => error.code === "DEVICE_POINT_NOT_ENABLED");
  assert.equal(f.writes.length, 0);

  const disconnected = fixture();
  disconnected.deviceMetadata.readFreshPoint = async () => {
    disconnected.poller.getSnapshot = () => ({ status: "disconnected", widgets: disconnected.config.widgets });
    return disconnected.fresh;
  };
  await assert.rejects(disconnected.service.write(light, 10), (error) => error.code === "POINT_UNAVAILABLE");
  assert.equal(disconnected.writes.length, 0);
});

test("controller and metadata failures return sanitized errors without leaking infrastructure strings", async () => {
  const f = fixture();
  f.deviceMetadata.readFreshPoint = async () => { throw new Error("private-user private-secret http://controller"); };
  await assert.rejects(f.service.write(light, 10), (error) => error.code === "DEVICE_COMMAND_CHECK_FAILED" && !/private|http/.test(error.message));
  f.deviceMetadata.readFreshPoint = async () => f.fresh;
  f.poller.writeValue = async () => { throw Object.assign(new Error("private-user private-secret"), { code: "CONTROLLER_REJECTED" }); };
  await assert.rejects(f.service.write(light, 10), (error) => error.code === "CONTROLLER_REJECTED" && !/private/.test(error.message));
});

async function serve(t, f) {
  const app = createApp({ poller: f.poller, config: f.config, deviceMetadata: f.deviceMetadata });
  const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("both write endpoints enforce fresh device validation; unrelated legacy widgets keep their existing path", async (t) => {
  const f = fixture();
  const base = await serve(t, f);
  const send = (route, widgetId, value) => fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ widgetId, value }) });
  for (const route of ["/api/devices/write", "/api/write"]) {
    assert.equal((await send(route, light, 70)).status, 200);
    assert.equal((await send(route, light, 200)).status, 422);
    f.fresh.widget.state = 2;
    assert.equal((await send(route, light, 30)).status, 422);
    f.fresh.widget.state = 0;
  }
  assert.equal(f.writes.length, 2);
  assert.equal(f.reads(), 6);
  f.config.widgets.push({ id: "legacy-point", writable: true, visible: true });
  assert.equal((await send("/api/write", "legacy-point", "legacy value")).status, 200);
  assert.deepEqual(f.writes.at(-1), { id: "legacy-point", value: "legacy value" });
  assert.equal((await send("/api/devices/write", "legacy-point", 10)).status, 403);
  assert.equal((await fetch(`${base}/api/devices/write`, { method: "POST", body: "bad" })).status, 415);
  assert.equal((await fetch(`${base}/api/devices/write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 400);
});
