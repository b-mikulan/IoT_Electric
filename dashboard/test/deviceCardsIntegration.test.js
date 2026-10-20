const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createApp } = require("../app");
const { buildDevices } = require("../public/deviceModel");

async function serve(t, config, deviceMetadata) {
  const poller = new EventEmitter();
  poller.getSnapshot = () => ({ widgets: config.widgets, status: "connected" });
  poller.writeValue = () => { throw new Error("Unexpected controller write"); };
  const app = createApp({ poller, config, deviceMetadata });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("demo dashboard keeps existing value widgets and supplies four synthetic device cards without controller access", async (t) => {
  const config = { demoMode: true, widgets: [{ id: "original-point", label: "Existing value" }], intervalMs: 1000 };
  const base = await serve(t, config, { read() { throw new Error("Demo must not contact middleware"); } });
  const metadata = await (await fetch(`${base}/api/devices/metadata`)).json();
  const devices = buildDevices(metadata.demoWidgets, metadata);
  assert.equal(devices.length, 4);
  assert.deepEqual(new Set(devices.map((device) => device.type)), new Set(["light", "climate", "blind", "sensor"]));
  assert.equal(devices.find((device) => device.type === "light").room.label, "Kuhinja · demo");
  assert.equal(devices.find((device) => device.type === "climate").room, null);
  assert.ok(devices.find((device) => device.type === "light").roles.brightnessSet.controlAvailable);
  assert.equal(devices.find((device) => device.type === "light").roles.brightnessSet.writeAllowed, false);
  assert.equal(metadata.demoWidgets.every((widget) => widget.id.startsWith("01/Demo/")), true);
  const publicConfig = await (await fetch(`${base}/api/config`)).json();
  assert.equal(publicConfig.widgets.length, 1);
  assert.equal(publicConfig.widgets[0].id, "original-point");
  const html = await (await fetch(base)).text();
  assert.ok(html.indexOf('id="device-cards-section"') < html.indexOf('id="raw-widgets-panel"'));
  for (const resource of ["deviceModel.js", "deviceCards.js", "deviceCards.css"]) assert.equal((await fetch(`${base}/${resource}`)).status, 200);
});

test("live metadata endpoint reads exactly the configured widgets and returns sanitized failure responses", async (t) => {
  const widgets = [{ id: "01/ES/Device/Values/LtPct", writable: false }];
  const config = { demoMode: false, widgets, username: "private-user", password: "private-secret", intervalMs: 1000 };
  let calls = 0;
  const base = await serve(t, config, { async read(received) {
    assert.equal(received, widgets);
    if (++calls === 2) throw new Error("private-user private-secret");
    return { metadataById: { [widgets[0].id]: { writeable: true } }, roomByZone: {}, warnings: [] };
  } });
  const first = await fetch(`${base}/api/devices/metadata`);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal((await first.json()).metadataById[widgets[0].id].writeable, true);
  const failed = await fetch(`${base}/api/devices/metadata`);
  assert.equal(failed.status, 502);
  const body = await failed.text();
  assert.equal(body.includes("private-secret"), false);
  assert.equal(body.includes("private-user"), false);
  assert.equal(JSON.parse(body).code, "DEVICE_METADATA_FAILED");
});
