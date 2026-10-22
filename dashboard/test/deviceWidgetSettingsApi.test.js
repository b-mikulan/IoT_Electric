const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../app");
const { loadConfig } = require("../lib/config");
const { buildDevices } = require("../public/deviceModel");

async function start(t, { inline = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "device-widget-api-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const rawFile = path.join(directory, "widgets.json");
  const file = path.join(directory, "device-widgets.json");
  const widgets = [
    { id: "01/ES/Room/AC309/Values/RmTmp", label: "Temperature", unit: "°C", writable: false, custom: "retain" },
    { id: "01/ES/Other/S3201/Values/RmRh", label: "Humidity", visible: true, unit: "%RH" },
    { id: "01/ES/Other/S3201/Values/RmCO2", label: "CO2", visible: false, unit: "ppm" },
    { id: "11/ES/Room/AC309/Values/RmTmp/Value", label: "Temperature reference", unit: "°C" },
  ];
  const raw = `${JSON.stringify(widgets)}\n`;
  await fs.writeFile(rawFile, raw);
  const config = loadConfig({ DEMO_MODE: "false", MIDDLEWARE_USER: "mock-client", MIDDLEWARE_PASSWORD: "never-public", ...(inline ? { WIDGETS_JSON: raw } : { WIDGETS_FILE: rawFile }) });
  const poller = new EventEmitter();
  poller.getSnapshot = () => ({ status: "connected", widgets: config.widgets, syncedAt: null });
  poller.writeValue = () => { throw new Error("Settings must not send controller writes."); };
  const app = createApp({ poller, config });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const save = (body) => fetch(`${baseUrl}/api/devices/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { baseUrl, save, config, poller, file, rawFile, raw };
}

test("public configuration saves cross-device primary readings and same-device secondary aliases with SSE", async (t) => {
  const { baseUrl, save, config, file, rawFile, raw } = await start(t);
  const publicConfig = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(publicConfig.deviceSettingsEnabled, true);
  assert.equal(publicConfig.deviceSettings.length, 2);
  assert.equal(JSON.stringify(publicConfig).includes("never-public"), false);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).devices.length, 2);
  const stream = await fetch(`${baseUrl}/events`);
  const reader = stream.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /event: device-settings/);
  const settings = { key: buildDevices(config.widgets)[0].key, label: "Bedroom air", room: "Bedroom", primaryPointId: config.widgets[1].id, primaryUnit: "custom unit", secondaryPointIds: [config.widgets[0].id, config.widgets[3].id] };
  const response = await save({ ...settings, writable: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { device: settings });
  const update = new TextDecoder().decode((await reader.read()).value);
  assert.match(update, /event: device-settings/);
  assert.match(update, /Bedroom air/);
  await reader.cancel();
  const read = await (await fetch(`${baseUrl}/api/devices/settings`)).json();
  assert.equal(read.enabled, true);
  assert.deepEqual(read.devices.find((entry) => entry.key === settings.key), settings);
  assert.equal(config.widgets[0].writable, false);
  assert.equal(await fs.readFile(rawFile, "utf8"), raw);
});

test("API validates current devices and visible metrics and preserves the saved file on rejected changes", async (t) => {
  const { baseUrl, save, config, file } = await start(t);
  const settings = { key: buildDevices(config.widgets)[0].key, label: null, room: "", primaryPointId: null, secondaryPointIds: [] };
  assert.equal((await save(settings)).status, 200);
  const before = await fs.readFile(file, "utf8");
  for (const change of [{ primaryPointId: config.widgets[2].id }, { room: 12 }, { primaryUnit: true }, { primaryUnit: "x".repeat(41) }, { secondaryPointIds: [config.widgets[1].id] }, { secondaryPointIds: [config.widgets[1].id, config.widgets[1].id] }]) {
    const response = await save({ ...settings, ...change });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_DEVICE_SETTINGS");
  }
  assert.equal((await save({ ...settings, key: "missing" })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/devices/settings`, { method: "POST" })).status, 415);
  assert.equal(await fs.readFile(file, "utf8"), before);
  config.widgets = [];
  assert.equal((await save(settings)).status, 404);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/devices/settings`)).json()).devices, JSON.parse(before).devices);
});

test("API preserves a literal primary unit and supports explicit unitless and legacy automatic saves", async (t) => {
  const { baseUrl, save, config, file } = await start(t);
  const settings = { key: buildDevices(config.widgets)[0].key, label: null, room: null, primaryPointId: null, secondaryPointIds: [] };
  for (const [supplied, expected] of [["  %RH  ", "%RH"], ["", ""], [null, null]]) {
    const response = await save({ ...settings, primaryUnit: supplied });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).device.primaryUnit, expected);
    assert.equal((await (await fetch(`${baseUrl}/api/config`)).json()).deviceSettings[0].primaryUnit, expected);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).devices[0].primaryUnit, expected);
  }
  assert.equal((await save(settings)).status, 200);
  assert.equal((await (await fetch(`${baseUrl}/api/devices/settings`)).json()).devices[0].primaryUnit, null);
});

test("settings synchronization includes newly discovered owners and retains removed owner settings", async (t) => {
  const { baseUrl, config, poller, file } = await start(t);
  await fetch(`${baseUrl}/api/config`);
  const newPoint = { id: "01/ES/New/B302/Values/BlndPos", label: "New blind", visible: true, writable: false };
  poller.emit("config", { widget: newPoint });
  config.widgets.push(newPoint);
  const settings = await (await fetch(`${baseUrl}/api/devices/settings`)).json();
  assert.equal(settings.devices.length, 3);
  assert.ok(settings.devices.some(({ key }) => key === "ES/New/B302"));
  config.widgets = config.widgets.filter((widget) => widget.id !== newPoint.id);
  await fetch(`${baseUrl}/api/config`);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).devices.length, 3);
});

test("malformed settings are reported explicitly and retained while inline mode is disabled", async (t) => {
  const persisted = await start(t);
  await fs.writeFile(persisted.file, "{malformed");
  for (const route of ["/api/config", "/api/devices/settings"]) {
    const response = await fetch(`${persisted.baseUrl}${route}`);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).code, "INVALID_DEVICE_WIDGET_FILE");
  }
  assert.equal(await fs.readFile(persisted.file, "utf8"), "{malformed");
  const inline = await start(t, { inline: true });
  const disabled = await (await fetch(`${inline.baseUrl}/api/devices/settings`)).json();
  assert.deepEqual(disabled, { enabled: false, devices: [] });
  const response = await inline.save({ key: "ES/Room/AC309", label: null, room: null, primaryPointId: null, secondaryPointIds: null });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "DEVICE_WIDGET_FILE_UNAVAILABLE");
});
