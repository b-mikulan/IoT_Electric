const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const grouping = require("../public/devices/widgetGrouping");
const deviceModel = require("../public/devices/deviceModel");

// Run the complete browser entry point and its registered handlers. The DOM,
// transport and rendering sink are fixtures; card models use the production
// model, and every request is intercepted without opening a network socket.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.textContent = "";
    this.className = "";
    this.elements = [];
    this.classList = {
      add: () => {}, remove: () => {}, toggle: () => {},
    };
  }
  get options() { return this.children; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name) { return this.listeners.get(name)?.({ target: this, preventDefault() {} }); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  add(child) { this.append(child); }
  replaceChildren(...children) { this.children = [...children]; }
  set innerHTML(value) { if (value === "") this.replaceChildren(); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  toggleAttribute(name, enabled) { if (enabled) this.attributes[name] = ""; else delete this.attributes[name]; }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return !this.validationMessage; }
  reset() {}
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

const owner = "ES/Application/Items/Climate";
const foreignOwner = "ES/Application/Zones/Kitchen/Sensor";
const reading = (name, value, unit = "", device = owner) => ({
  id: `01/${device}/Values/${name}`, label: name, value, unit,
  state: 0, writable: false, visible: true,
});
const temperature = reading("RmTmp", 24.1, "°C");
const humidity = reading("RmRh", 52, "%RH");
const co2 = reading("RmCO2", 580, "ppm");
const mode = reading("SysMdSts", 0);
const setpoint = reading("EffSpt", 22, "°C");
const illuminance = reading("LtLvl", 164, "lx", foreignOwner);
const widgets = [temperature, humidity, co2, mode, setpoint, illuminance];
const automaticEntry = { key: owner, label: null, room: null, primaryPointId: null, primaryUnit: null, secondaryPointIds: null };
const json = (value) => JSON.parse(JSON.stringify(value));
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => json(payload) });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("partial live events retain the full-building freshness and pass fresh point timestamps to device cards", () => {
  const fixture = setup();
  fixture.run(`applyPayload({ syncedAt: "2026-11-05T10:00:00.000Z", widgets: fixtureWidgets });`);
  const before = fixture.node("#last-sync").textContent;
  fixture.run(`applyPayload({ scope: "partial", readAt: "2026-11-05T10:01:00.000Z", widgets: [{ ...fixtureWidgets[0], readAt: "2026-11-05T10:01:00.000Z", value: 25 }] });`);
  assert.equal(fixture.node("#last-sync").textContent, before);
  assert.equal(fixture.run("deviceReadAt"), "2026-11-05T10:00:00.000Z");
  assert.equal(fixture.models().find(device => device.key === owner).roles.temperature.readAt, "2026-11-05T10:01:00.000Z");
});

function setup({ saved = [], enabled = true, editable = true, technical = true } = {}) {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  };
  const requests = [];
  const eventSources = [];
  const logs = [];
  let releaseBoot;
  let requestHandler = (url, options) => options?.method === "POST"
    ? response({ device: JSON.parse(options.body) })
    : response({ devices: saved, enabled });
  let models = [];
  let index;
  let fullUpdates = 0;
  const valueUpdates = [];
  const view = {
    update(input) { fullUpdates++; index = deviceModel.createDeviceIndex(input.widgets, input); models = index.getDevices(); },
    updateValues(input) { valueUpdates.push(json(input)); index.updateValues(input.widgets); models = index.getDevices(); },
    getDevices() { return models.slice(); },
  };
  const context = vm.createContext({
    console: Object.fromEntries(["error", "warn", "info"].map(level => [level, (...args) => logs.push({ level, args: json(args) })])),
    navigator: { onLine: true },
    document: { querySelector: (selector) => !technical && ["#widget-grid", "#widget-template", "#empty-state", "#control-panel", "#write-form", "#write-widget", "#write-value", "#write-value-label", "#write-submit", "#write-status"].includes(selector) ? null : node(selector), createElement: (tag) => new Element(tag) },
    IoTWidgetGrouping: grouping, IoTDeviceModel: deviceModel,
    IoTDeviceCards: { create: options => { view.callbacks = options; return view; } },
    Option: function Option(label, value) { const option = new Element("option"); option.textContent = label; option.value = value; return option; },
    EventSource: class {
      constructor(url) { this.url = url; this.readyState = 1; this.listeners = new Map(); eventSources.push(this); }
      addEventListener(name, callback) { this.listeners.set(name, callback); }
      emit(name, payload) { this.listeners.get(name)?.({ data: JSON.stringify(payload) }); }
    },
    fetch(url, options = {}) {
      requests.push({ url, options });
      if (url === "/api/config") return new Promise((resolve) => { releaseBoot = resolve; });
      if (url === "/api/devices/metadata") return Promise.resolve(response({ metadataById: {}, roomByZone: { "ES/Application/Items": "Office" } }));
      return Promise.resolve(requestHandler(url, options));
    },
    requestAnimationFrame: (callback) => callback(),
    setTimeout: () => 0, clearTimeout: () => {},
    fixtureWidgets: json(widgets), fixtureSaved: json(saved), fixtureView: view,
  });
  const run = (source) => vm.runInContext(source, context);
  run(fs.readFileSync(path.join(__dirname, "../public/dashboard/app.js"), "utf8"));
  run(`widgetEditingEnabled = ${editable}; deviceSettingsEnabled = ${enabled};
    for (const widget of fixtureWidgets) configById.set(widget.id, widget);
    deviceMetadata = { metadataById: {}, roomByZone: { "ES/Application/Items": "Office" } };
    deviceCardView = fixtureView; applyDeviceSettings(fixtureSaved);`);
  const cardNode = (name) => node(`#device-settings-${name}`);
  const open = () => run(`openDeviceCardSettingsDialog(cardSettingsDevices().find((device) => device.key === ${JSON.stringify(owner)}))`);
  const checkbox = (id) => cardNode("secondary-list").children.map((label) => label.children[0]).find((input) => input?.value === id);
  const posts = () => requests.filter((request) => request.options.method === "POST");
  return {
    node, cardNode, context, run, open, checkbox, posts, requests, eventSources, logs,
    models: () => view.getDevices(),
    renders: () => ({ fullUpdates, valueUpdates }),
    setHandler(handler) { requestHandler = handler; },
    boot(config = {}, status = 200) { releaseBoot(response({ widgets: [], intervalMs: 15000, widgetEditingEnabled: editable, deviceSettingsEnabled: enabled, deviceSettings: saved, ...config }, status)); },
    saved: () => json(run("[...deviceSettingsByKey.values()]")),
  };
}

test("manual refresh callback checks the server receipt and reports HTTP failures without changing full freshness", async () => {
  const f = setup({ technical: false }); f.boot(); await flush();
  f.setHandler((url, options) => {
    assert.equal(url, "/api/dashboard/refresh-scope");
    return response({ ...JSON.parse(options.body), readAt: "2026-11-06T12:00:00Z", pointCount: 3, errorCount: 0 });
  });
  const before = f.node("#last-sync").textContent;
  const result = await f.run(`fixtureView.callbacks.onRefresh({ scope: "room", id: "kitchen-1" })`);
  assert.equal(result.pointCount, 3);
  assert.deepEqual(JSON.parse(f.posts().at(-1).options.body), { scope: "room", id: "kitchen-1" });
  assert.equal(f.node("#last-sync").textContent, before);
  f.setHandler(() => response({ error: "EWS offline" }, 502));
  await assert.rejects(f.run(`fixtureView.callbacks.onRefresh({ scope: "device", id: "ES/A" })`), /EWS offline/);
  assert.equal(f.logs.at(-1).args[1].source, "manual-refresh");
  f.setHandler(() => response({ readAt: "bad", pointCount: 3 }));
  await assert.rejects(f.run(`fixtureView.callbacks.onRefresh({ scope: "floor", id: "floor-1" })`), /valjana potvrda/);
});

test("refresh diagnostics retain failure context, suppress repeated status redraws and report recovery once", async () => {
  const f = setup({ technical: false });
  f.boot(); await flush();
  const events = f.eventSources[0];
  const syncedAt = "2026-11-06T10:00:00.000Z";
  events.emit("sync", { status: "connected", syncedAt });
  events.emit("status", { status: "error", error: "Middleware request timed out after 30000 ms", syncedAt, privatePayload: "must-not-be-logged" });
  assert.equal(f.node("#error-banner").hidden, false);
  assert.equal(f.logs.length, 1);
  const first = f.logs[0];
  assert.equal(first.level, "error");
  assert.equal(first.args[1].source, "read");
  assert.equal(first.args[1].scope, "all");
  assert.equal(first.args[1].lastSuccessfulFullRead, syncedAt);
  assert.equal(first.args[1].configuredPointCount, widgets.length);
  assert.equal(first.args[1].endpoint, "/api/values/read");
  assert.ok(Number.isFinite(Date.parse(first.args[1].timestamp)));
  assert.doesNotMatch(JSON.stringify(first), /must-not-be-logged/);
  events.emit("status", { status: "error", error: first.args[1].reason });
  f.run('showStatus({ state: "error" }); showStatus({ state: "connecting" });');
  assert.equal(f.logs.length, 1);
  events.emit("sync", { status: "connected", syncedAt: "2026-11-06T10:03:00.000Z" });
  events.emit("sync", { status: "connected", syncedAt: "2026-11-06T10:06:00.000Z" });
  assert.equal(f.node("#error-banner").hidden, true);
  assert.deepEqual(f.logs.map(log => log.level), ["error", "info"]);
  events.emit("status", { status: "error", error: first.args[1].reason });
  events.emit("status", { status: "error", error: "Middleware request failed 503" });
  assert.deepEqual(f.logs.map(log => log.level), ["error", "info", "error", "error"]);
});

test("SSE diagnostics separate connection recovery from a persistent upstream read failure", async () => {
  const f = setup({ technical: false });
  f.boot(); await flush();
  const events = f.eventSources[0];
  events.emit("status", { status: "error", error: "fetch failed" });
  events.readyState = 0;
  events.onerror(); events.onerror();
  assert.deepEqual(f.logs.map(log => log.level), ["error", "warn"]);
  assert.equal(f.logs[1].args[1].source, "events");
  assert.equal(f.logs[1].args[1].readyState, 0);
  assert.equal(f.logs[1].args[1].browserOnline, true);
  assert.equal(f.node("#error-banner").hidden, false);
  events.readyState = 1;
  events.onopen(); events.onopen();
  events.emit("snapshot", { status: "error", error: "fetch failed", widgets: [] });
  assert.deepEqual(f.logs.map(log => log.level), ["error", "warn", "info"]);
  assert.equal(f.logs[2].args[1].source, "events");
  assert.equal(f.node("#error-banner").hidden, false);
});

test("readback diagnostics recover only after failed points are read, or after a successful full sync", async () => {
  const f = setup({ technical: false });
  f.boot(); await flush();
  const events = f.eventSources[0];
  const syncedAt = "2026-11-06T10:00:00.000Z";
  events.emit("sync", { status: "connected", syncedAt });
  const failure = { scope: "partial", pointIds: [temperature.id, humidity.id], error: "Middleware request failed 502" };
  events.emit("refresh-error", failure); events.emit("refresh-error", failure);
  events.emit("refresh-error", { ...failure, pointIds: [co2.id] });
  assert.equal(f.logs.length, 2);
  assert.equal(f.logs[0].args[1].pointCount, 2);
  assert.deepEqual(f.logs[0].args[1].samplePointIds, failure.pointIds);
  assert.equal(f.node("#error-banner").hidden, true);
  for (const pointIds of [[temperature.id], [mode.id]]) events.emit("sync", { scope: "partial", status: "connected", pointIds, readAt: "2026-11-06T10:01:00.000Z" });
  assert.equal(f.logs.length, 2);
  events.emit("sync", { scope: "partial", status: "connected", pointIds: [humidity.id, co2.id], readAt: "2026-11-06T10:02:00.000Z" });
  assert.equal(f.logs[2].level, "info");
  assert.equal(f.logs[2].args[1].source, "readback");
  assert.equal(f.run("deviceReadAt"), syncedAt);
  events.emit("refresh-error", failure);
  events.emit("sync", { status: "error", error: "fetch failed", syncedAt });
  assert.equal(f.logs.filter(log => log.level === "info").length, 1);
  events.emit("sync", { status: "connected", syncedAt: "2026-11-06T10:03:00.000Z" });
  assert.equal(f.logs.filter(log => log.level === "info" && log.args[1].source === "readback").length, 2);
});

test("initial configuration failures are logged with their HTTP status and startup phase", async () => {
  const f = setup({ technical: false });
  f.boot({}, 503); await flush();
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].level, "error");
  assert.equal(f.logs[0].args[1].source, "startup");
  assert.equal(f.logs[0].args[1].phase, "configuration");
  assert.equal(f.logs[0].args[1].endpoint, "/api/config");
  assert.match(f.logs[0].args[1].reason, /503/);
  assert.equal(f.node("#error-banner").hidden, false);
});

test("card settings save custom identity and device-local secondary readings through the settings endpoint only", async () => {
  const fixture = setup();
  fixture.setHandler((_url, options) => {
    const { newRoom, ...device } = JSON.parse(options.body);
    device.room = "room-living";
    return response({ device, floors: [], roomDetails: [{ id: device.room, name: newRoom.name, floorId: null }] });
  });
  fixture.open();
  assert.equal(fixture.cardNode("dialog").open, true);
  assert.equal(fixture.cardNode("label").placeholder, "Climate");
  fixture.cardNode("label").value = "  Living room climate  ";
  fixture.cardNode("room").value = "new";
  fixture.cardNode("room").dispatch("change");
  assert.equal(fixture.cardNode("new-room-field").hidden, false);
  fixture.cardNode("new-room").value = "  Living room  ";
  fixture.cardNode("primary").value = humidity.id;
  fixture.cardNode("primary").dispatch("change");
  fixture.cardNode("secondary-mode").value = "custom";
  fixture.cardNode("secondary-mode").dispatch("change");
  for (const id of [co2.id, mode.id]) {
    fixture.checkbox(id).checked = false;
    fixture.checkbox(id).dispatch("change");
  }
  assert.equal(fixture.checkbox(illuminance.id), undefined);
  fixture.checkbox(temperature.id).checked = true;
  fixture.checkbox(temperature.id).dispatch("change");
  await fixture.cardNode("form").dispatch("submit");
  const expected = { key: owner, label: "Living room climate", room: "room-living", primaryPointId: humidity.id, primaryUnit: null, secondaryPointIds: [temperature.id] };
  assert.deepEqual(fixture.posts().map((request) => request.url), ["/api/devices/settings"]);
  assert.deepEqual(JSON.parse(fixture.posts()[0].options.body), { ...expected, room: "", newRoom: { name: "Living room", floorId: null } });
  assert.deepEqual(fixture.saved(), [expected]);
  const climate = fixture.models().find((device) => device.key === owner);
  assert.equal(climate.label, expected.label);
  assert.equal(climate.room.label, "Living room");
  assert.equal(climate.room.id, expected.room);
  assert.equal(climate.metrics.primary.id, humidity.id);
  assert.equal(climate.metrics.secondary[0].id, temperature.id);
  assert.equal(climate.roles.setpoint.id, setpoint.id);
  assert.equal(climate.roles.illuminance, undefined);
  assert.match(fixture.cardNode("status").textContent, /spremljeni/);
});

test("dashboard without the technical view retains readings, configuration and visibility across live events", async () => {
  const fixture = setup({ technical: false });
  fixture.boot({ widgets });
  await flush();
  assert.equal(fixture.eventSources.length, 1);
  const stream = fixture.eventSources[0];
  stream.emit("snapshot", { widgets, status: "connected", syncedAt: "first" });
  assert.equal(fixture.run("elementsById.size"), 0);
  assert.equal(fixture.run("visibilityInputsById.size"), 0);
  assert.equal(fixture.run("configById.size"), widgets.length);
  assert.equal(fixture.models().find((entry) => entry.key === owner).metrics.primary.value, temperature.value);
  stream.emit("update", { widgets: [{ ...temperature, value: 26.2 }], syncedAt: "second" });
  assert.equal(fixture.models().find((entry) => entry.key === owner).metrics.primary.value, 26.2);
  stream.emit("visibility", { id: temperature.id, visible: false });
  assert.equal(fixture.run(`configById.get(${JSON.stringify(temperature.id)}).visible`), false);
  assert.notEqual(fixture.models().find((entry) => entry.key === owner).metrics.primary?.id, temperature.id);
  stream.emit("visibility", { id: temperature.id, visible: true });
  stream.emit("removed", { ids: [illuminance.id] });
  assert.equal(fixture.models().length, 1);
  assert.equal(fixture.run("elementsById.size"), 0);
  assert.equal(fixture.run("latestValuesById.size"), widgets.length - 1);
});

test("consecutive live events share one device render per animation frame", async () => {
  const fixture = setup({ technical: false });
  fixture.boot();
  await flush();
  fixture.run("let pendingFrame; let frames = 0; requestAnimationFrame = (callback) => { frames++; pendingFrame = callback; };");
  const stream = fixture.eventSources[0];
  stream.emit("sync", { status: "connected", syncedAt: "new-read" });
  stream.emit("update", { widgets: [{ ...temperature, value: 27.4 }], syncedAt: "new-read" });
  assert.equal(fixture.run("frames"), 1);
  fixture.run("pendingFrame()");
  assert.equal(fixture.models().find((entry) => entry.key === owner).metrics.primary.value, 27.4);
});

test("live event bursts send only their latest changed points without rebuilding structure", async () => {
  const f = setup({ technical: false });
  f.boot();
  await flush();
  const fullBefore = f.renders().fullUpdates;
  f.run("let pendingFrame; requestAnimationFrame = (callback) => { pendingFrame = callback; };");
  const stream = f.eventSources[0];
  stream.emit("sync", { status: "connected", syncedAt: "new" });
  stream.emit("update", { widgets: [{ ...temperature, value: 25 }], syncedAt: "new" });
  stream.emit("update", { widgets: [{ ...temperature, value: 26 }, { ...humidity, value: 55 }], syncedAt: "new" });
  f.run("pendingFrame()");
  assert.equal(f.renders().fullUpdates, fullBefore);
  const updates = f.renders().valueUpdates;
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].widgets.map(({ id, value }) => ({ id, value })), [{ id: temperature.id, value: 26 }, { id: humidity.id, value: 55 }]);
  const unchanged = f.models()[0];
  stream.emit("sync", { status: "connected", syncedAt: "next" });
  f.run("pendingFrame()");
  assert.equal(f.renders().valueUpdates[1].widgets.length, 0);
  assert.equal(f.models()[0], unchanged);
  stream.emit("device-settings", { devices: [{ ...automaticEntry, label: "New name" }], rooms: [] });
  f.run("pendingFrame()");
  assert.equal(f.renders().fullUpdates, fullBefore + 1);
  assert.equal(f.models()[0].label, "New name");
  assert.equal(f.models()[0].roles.temperature.value, 26);
});

test("a queued live update cannot restore a device removed before the next frame", async () => {
  const f = setup({ technical: false });
  f.boot();
  await flush();
  f.run("let pendingFrame; requestAnimationFrame = (callback) => { pendingFrame = callback; };");
  const stream = f.eventSources[0];
  stream.emit("update", { widgets: [{ ...temperature, value: 30 }] });
  stream.emit("removed", { ids: widgets.filter((widget) => grouping.deriveWidgetGrouping(widget.id).key === owner).map((widget) => widget.id) });
  f.run("pendingFrame()");
  assert.equal(f.models().length, 1);
  assert.equal(f.models()[0].key, foreignOwner);
});

test("technical value view lives on its own page instead of the main dashboard", () => {
  const main = fs.readFileSync(path.join(__dirname, "../public/pages/index.html"), "utf8");
  const technical = fs.readFileSync(path.join(__dirname, "../public/pages/technical.html"), "utf8");
  assert.doesNotMatch(main, /id="(?:raw-widgets-panel|widget-grid|widget-template|write-form)"/);
  assert.match(technical, /id="widget-grid"/);
  assert.match(technical, /id="widget-template"/);
  assert.match(technical, /href="\/">Natrag na uređaje/);
  assert.doesNotMatch(technical, /id="device-cards-section"/);
});

test("secondary choices exclude other devices, including legacy selections and search results", async () => {
  const entry = { ...automaticEntry, secondaryPointIds: [co2.id, illuminance.id] };
  const fixture = setup({ saved: [entry] });
  fixture.open();
  assert.equal(fixture.cardNode("primary").options.some((option) => option.value === illuminance.id), false);
  assert.equal(fixture.checkbox(illuminance.id), undefined);
  assert.equal(fixture.checkbox(co2.id).checked, true);
  assert.equal(fixture.cardNode("secondary-count").textContent.startsWith("1 / 12"), true);
  fixture.cardNode("search").value = "Kitchen";
  fixture.cardNode("search").dispatch("input");
  assert.equal(fixture.checkbox(illuminance.id), undefined);
  assert.match(fixture.cardNode("secondary-list").children[0].textContent, /Nema očitanja/);
  fixture.cardNode("primary").value = illuminance.id;
  fixture.cardNode("primary").dispatch("change");
  await fixture.cardNode("form").dispatch("submit");
  assert.equal(fixture.posts().length, 0);
  assert.match(fixture.cardNode("status").textContent, /ovog uređaja/);
  fixture.cardNode("primary").value = humidity.id;
  await fixture.cardNode("form").dispatch("submit");
  const saved = JSON.parse(fixture.posts()[0].options.body);
  assert.equal(saved.primaryPointId, humidity.id);
  assert.deepEqual(saved.secondaryPointIds, [co2.id]);
});

test("reset remains a draft until saved and sends null for every automatic setting", async () => {
  const saved = [{ key: owner, label: "Custom climate", room: "Bedroom", primaryPointId: humidity.id, primaryUnit: "custom", secondaryPointIds: [] }];
  const fixture = setup({ saved });
  fixture.open();
  fixture.cardNode("reset").dispatch("click");
  assert.equal(fixture.cardNode("label").value, "");
  assert.equal(fixture.cardNode("room").value, "auto");
  assert.equal(fixture.cardNode("primary").value, "auto");
  assert.equal(fixture.cardNode("unit-mode").value, "auto");
  assert.equal(fixture.cardNode("secondary-mode").value, "auto");
  assert.deepEqual(fixture.saved(), saved);
  assert.equal(fixture.models()[0].label, "Custom climate");
  assert.equal(fixture.posts().length, 0);
  await fixture.cardNode("form").dispatch("submit");
  assert.deepEqual(JSON.parse(fixture.posts()[0].options.body), automaticEntry);
  assert.equal(fixture.models()[0].label, "Climate");
  assert.equal(fixture.models()[0].room.label, "Office");
  assert.equal(fixture.models()[0].metrics.primary.id, temperature.id);
  assert.deepEqual(fixture.models()[0].metrics.secondary.map((point) => point.id), [humidity.id, co2.id, mode.id]);
});

test("display unit choices save and hydrate automatic, hidden and literal suffixes without changing readings or controls", async () => {
  for (const [unitMode, input, persisted, displayed] of [["custom", "  °F  ", "°F", "°F"], ["none", "", "", ""], ["auto", "", null, "°C"]]) {
    const fixture = setup({ saved: [{ ...automaticEntry, primaryUnit: "%" }] });
    fixture.open();
    fixture.cardNode("unit-mode").value = unitMode;
    fixture.cardNode("unit-mode").dispatch("change");
    assert.equal(fixture.cardNode("unit-field").hidden, unitMode !== "custom");
    fixture.cardNode("unit").value = input;
    await fixture.cardNode("form").dispatch("submit");
    assert.equal(JSON.parse(fixture.posts()[0].options.body).primaryUnit, persisted);
    const climate = fixture.models().find((device) => device.key === owner);
    assert.equal(climate.metrics.primary.unit, displayed);
    assert.equal(climate.metrics.primary.value, temperature.value);
    assert.equal(climate.roles.temperature.unit, "°C");
    assert.equal(climate.roles.setpoint.unit, "°C");
    assert.equal(climate.metrics.secondary[0].unit, "%RH");
    fixture.open();
    assert.equal(fixture.cardNode("unit-mode").value, unitMode);
    assert.equal(fixture.cardNode("unit").value, persisted || "");
    assert.deepEqual(fixture.posts().map((request) => request.url), ["/api/devices/settings"]);
  }
});

test("automatic unit follows the selected primary while a custom suffix remains a user choice", () => {
  const fixture = setup();
  fixture.open();
  const automaticOption = () => fixture.cardNode("unit-mode").options.find((option) => option.value === "auto").textContent;
  assert.match(automaticOption(), /°C/);
  fixture.cardNode("unit-mode").value = "custom";
  fixture.cardNode("unit-mode").dispatch("change");
  fixture.cardNode("unit").value = "m²";
  fixture.cardNode("primary").value = humidity.id;
  fixture.cardNode("primary").dispatch("change");
  assert.match(automaticOption(), /%/);
  assert.equal(fixture.cardNode("unit-mode").value, "custom");
  assert.equal(fixture.cardNode("unit").value, "m²");
  fixture.cardNode("primary").value = co2.id;
  fixture.cardNode("primary").dispatch("change");
  assert.match(automaticOption(), /ppm/);
});

test("empty and oversized custom unit drafts are rejected before posting", async () => {
  const fixture = setup();
  fixture.open();
  fixture.cardNode("unit-mode").value = "custom";
  fixture.cardNode("unit-mode").dispatch("change");
  for (const unit of ["   ", "x".repeat(41)]) {
    fixture.cardNode("unit").value = unit;
    await fixture.cardNode("form").dispatch("submit");
    assert.match(fixture.cardNode("unit").validationMessage, /40 znakova/);
    assert.equal(fixture.posts().length, 0);
    assert.equal(fixture.models()[0].metrics.primary.unit, "°C");
  }
});

test("explicitly unassigned room and empty secondary list survive hydration and save", async () => {
  const entry = { ...automaticEntry, room: "", secondaryPointIds: [] };
  const fixture = setup({ saved: [entry] });
  fixture.open();
  assert.equal(fixture.cardNode("room").value, "unassigned");
  assert.equal(fixture.cardNode("secondary-mode").value, "custom");
  assert.equal(fixture.cardNode("secondary-count").textContent.startsWith("0 / 12"), true);
  assert.equal(fixture.models()[0].room, null);
  assert.deepEqual(fixture.models()[0].metrics.secondary, []);
  await fixture.cardNode("form").dispatch("submit");
  assert.deepEqual(JSON.parse(fixture.posts()[0].options.body), entry);
  assert.deepEqual(fixture.saved(), [entry]);
});

test("a failed save keeps persisted state and rendered card unchanged while retaining the editable draft", async () => {
  const entry = { ...automaticEntry, label: "Saved climate", room: "Office" };
  const fixture = setup({ saved: [entry] });
  fixture.setHandler(() => response({ error: "Disk is read-only" }, 500));
  fixture.open();
  fixture.cardNode("label").value = "Unsaved name";
  await fixture.cardNode("form").dispatch("submit");
  assert.equal(fixture.models()[0].label, "Saved climate");
  assert.deepEqual(fixture.saved(), [entry]);
  assert.equal(fixture.cardNode("dialog").open, true);
  assert.equal(fixture.cardNode("label").value, "Unsaved name");
  assert.equal(fixture.cardNode("close").disabled, false);
  assert.equal(fixture.cardNode("status").className.includes("is-error"), true);
  assert.match(fixture.cardNode("status").textContent, /Disk is read-only/);
  assert.deepEqual(fixture.posts().map((request) => request.url), ["/api/devices/settings"]);
});

test("cancel discards the form draft without changing saved card settings or writing to the controller", () => {
  const entry = { ...automaticEntry, label: "Saved climate" };
  const fixture = setup({ saved: [entry] });
  fixture.open();
  fixture.cardNode("label").value = "Draft name";
  fixture.cardNode("cancel").dispatch("click");
  assert.equal(fixture.cardNode("dialog").open, false);
  assert.deepEqual(fixture.saved(), [entry]);
  assert.equal(fixture.models()[0].label, "Saved climate");
  assert.equal(fixture.posts().length, 0);
  fixture.open();
  assert.equal(fixture.cardNode("label").value, "Saved climate");
});

test("choosing a primary reading removes it from custom secondaries before saving", async () => {
  const fixture = setup({ saved: [{ ...automaticEntry, secondaryPointIds: [humidity.id, co2.id] }] });
  fixture.open();
  assert.equal(fixture.checkbox(humidity.id).checked, true);
  fixture.cardNode("primary").value = humidity.id;
  fixture.cardNode("primary").dispatch("change");
  assert.equal(fixture.checkbox(humidity.id).checked, false);
  assert.equal(fixture.checkbox(humidity.id).disabled, true);
  assert.equal(fixture.checkbox(co2.id).checked, true);
  await fixture.cardNode("form").dispatch("submit");
  assert.deepEqual(JSON.parse(fixture.posts()[0].options.body).secondaryPointIds, [co2.id]);
});

test("disabled card persistence falls back to existing function settings and respects disabled raw editing", () => {
  const editable = setup({ enabled: false });
  editable.open();
  assert.equal(editable.cardNode("dialog").open, false);
  assert.equal(editable.node("#settings-dialog").open, true);
  assert.equal(editable.node("#settings-id").value, setpoint.id);
  assert.equal(editable.posts().length, 0);
  const readOnly = setup({ enabled: false, editable: false });
  readOnly.open();
  assert.equal(readOnly.cardNode("dialog").open, false);
  assert.equal(readOnly.node("#settings-dialog").open, false);
  assert.equal(readOnly.posts().length, 0);
});

test("boot hydration and newer SSE settings take precedence over an older reconnect fetch", async () => {
  const initial = { ...automaticEntry, label: "Boot name" };
  const fixture = setup();
  assert.equal(fixture.models()[0].label, "Climate");
  fixture.boot({ deviceSettings: [initial] });
  await flush();
  assert.equal(fixture.eventSources.length, 1);
  assert.equal(fixture.models()[0].label, "Boot name");
  let finishReconnect;
  fixture.setHandler(() => new Promise((resolve) => { finishReconnect = resolve; }));
  fixture.eventSources[0].onopen();
  const incoming = { ...automaticEntry, label: "SSE name", room: "Bedroom" };
  fixture.eventSources[0].emit("device-settings", { devices: [incoming] });
  finishReconnect(response({ enabled: true, devices: [{ ...automaticEntry, label: "Stale reconnect name" }] }));
  await flush();
  assert.deepEqual(fixture.saved(), [incoming]);
  assert.equal(fixture.models()[0].label, "SSE name");
  assert.equal(fixture.models()[0].room.label, "Bedroom");
  assert.equal(fixture.posts().length, 0);
  fixture.eventSources[0].emit("device-settings-error", {});
  assert.equal(fixture.models()[0].label, "SSE name");
  assert.match(fixture.run("deviceSettingsWarning"), /nije moguće spremiti/);
});

test("a successful settings POST invalidates a reconnect GET started before the save", async () => {
  const fixture = setup();
  fixture.boot();
  await flush();
  let finishReconnect;
  fixture.setHandler((url, options) => {
    assert.equal(url, "/api/devices/settings");
    return options.method === "POST"
      ? response({ device: JSON.parse(options.body) })
      : new Promise((resolve) => { finishReconnect = resolve; });
  });
  fixture.eventSources[0].onopen();
  fixture.open();
  fixture.cardNode("label").value = "Saved from form";
  await fixture.cardNode("form").dispatch("submit");
  assert.equal(fixture.models()[0].label, "Saved from form");
  finishReconnect(response({ enabled: true, devices: [{ ...automaticEntry, label: "Stale reconnect value" }] }));
  await flush();
  assert.equal(fixture.models()[0].label, "Saved from form");
  assert.equal(fixture.saved()[0].label, "Saved from form");
  assert.deepEqual(fixture.posts().map((request) => request.url), ["/api/devices/settings"]);
});

test("a delayed POST cannot overwrite newer SSE settings and reconciles with a fresh guarded GET", async () => {
  const fixture = setup();
  fixture.boot();
  await flush();
  let finishSave;
  let finishLatestRead;
  fixture.setHandler((url, options) => {
    assert.equal(url, "/api/devices/settings");
    return options.method === "POST"
      ? new Promise((resolve) => { finishSave = resolve; })
      : new Promise((resolve) => { finishLatestRead = resolve; });
  });
  fixture.open();
  fixture.cardNode("label").value = "Earlier submitted name";
  const saving = fixture.cardNode("form").dispatch("submit");
  const newer = { ...automaticEntry, label: "Newer SSE name", room: "Bedroom" };
  fixture.eventSources[0].emit("device-settings", { devices: [newer] });
  assert.equal(fixture.models()[0].label, "Newer SSE name");
  finishSave(response({ device: { ...automaticEntry, label: "Earlier submitted name" } }));
  await flush();
  // Keep the newest rendered model while the authoritative follow-up read is
  // pending; an old POST acknowledgement must never appear as a newer state.
  assert.equal(fixture.models()[0].label, "Newer SSE name");
  assert.equal(fixture.saved()[0].label, "Newer SSE name");
  assert.equal(typeof finishLatestRead, "function");
  const latest = { ...automaticEntry, label: "Current database name", room: "Living room" };
  finishLatestRead(response({ enabled: true, devices: [latest] }));
  await saving;
  assert.deepEqual(fixture.saved(), [latest]);
  assert.equal(fixture.models()[0].label, "Current database name");
  assert.equal(fixture.models()[0].room.label, "Living room");
  assert.equal(fixture.cardNode("title").textContent, "Postavke kartice Current database name");
  assert.deepEqual(fixture.posts().map((request) => request.url), ["/api/devices/settings"]);
});

test("legacy foreign primary selection is excluded from the picker and its display unit resets to automatic", () => {
  const fixture = setup({ saved: [{ ...automaticEntry, primaryPointId: illuminance.id, primaryUnit: "lx" }] });
  fixture.open();
  assert.equal(fixture.cardNode("primary").value, "auto");
  assert.equal(fixture.cardNode("primary").options.some((option) => option.value === illuminance.id), false);
  assert.equal(fixture.cardNode("unit-mode").value, "auto");
  assert.equal(fixture.models().find((d) => d.key === owner).metrics.primary.id, temperature.id);
});

test("creates a persistent empty room and offers it in individual card settings", async () => {
  const fixture = setup();
  fixture.setHandler(() => response({ room: "New office", rooms: ["New office"] }, 201));
  fixture.run("openRoomsDialog()");
  fixture.node("#rooms-name").value = " New office ";
  await fixture.node("#rooms-form").dispatch("submit");
  assert.deepEqual(fixture.posts().map((request) => request.url), ["/api/rooms"]);
  assert.deepEqual(JSON.parse(fixture.posts()[0].options.body), { name: "New office", floorId: null });
  assert.deepEqual(json(fixture.run("storedRooms")), ["New office"]);
  fixture.open();
  assert.ok(fixture.cardNode("room").options.some((option) => option.value === "room:New office"));
});

function selectRoom(fixture, name) {
  const row = fixture.node("#rooms-list").children.find((entry) => entry.children[0].children[0].textContent === name);
  assert.ok(row, `Room ${name} is available`);
  row.children[0].dispatch("click");
}

test("users can create arbitrary floor groups and choose one independently when creating an empty room", async () => {
  const f = setup();
  let floors = [], roomDetails = [];
  f.setHandler((url, options) => {
    const body = JSON.parse(options.body);
    if (url === "/api/floors/create") { floors = [{ id: "floor-a", name: body.name }]; return response({ floor: floors[0], floors, roomDetails }); }
    if (url === "/api/rooms") { roomDetails = [{ id: "room-studio", name: body.name, floorId: body.floorId }]; return response({ room: "room-studio", rooms: ["room-studio"], floors, roomDetails }); }
    if (url === "/api/floors/rename") { floors[0].name = body.name; return response({ floor: floors[0], floors, roomDetails }); }
    throw new Error("Unexpected request");
  });
  f.run("openRoomsDialog()");
  f.node("#floors-name").value = "1. kat A";
  await f.node("#floors-form").dispatch("submit");
  assert.equal(f.node("#rooms-floor").value, "floor-a");
  assert(f.node("#rooms-floor").options.some(option => option.value === "floor-a" && option.textContent === "1. kat A"));
  f.node("#rooms-name").value = "Studio";
  await f.node("#rooms-form").dispatch("submit");
  assert.deepEqual(JSON.parse(f.posts()[1].options.body), { name: "Studio", floorId: "floor-a" });
  assert.equal(f.run('roomDisplayName("room-studio")'), "Studio · 1. kat A");
  f.node("#floors-rename-name").value = "1. kat B";
  await f.node("#floors-rename-form").dispatch("submit");
  assert.equal(f.run('roomDisplayName("room-studio")'), "Studio · 1. kat B");
  assert.equal(f.run('roomDefinition("room-studio").floorId'), "floor-a");
});

test("editing a room changes its explicit group without renaming its identity or touching the points", async () => {
  const f = setup();
  const floors = [{ id: "a", name: "1. kat A" }, { id: "b", name: "1. kat B" }];
  const details = [{ id: "Office", name: "Office", floorId: "a" }];
  f.run(`applyDeviceSettings([], [], [], ${JSON.stringify(floors)}, ${JSON.stringify(details)})`);
  f.setHandler((_url, options) => { const body = JSON.parse(options.body); return response({ room: body.id, floors, roomDetails: [{ id: body.id, name: body.name, floorId: body.floorId }] }); });
  f.run("openRoomsDialog()"); selectRoom(f, "Office · 1. kat A");
  f.node("#rooms-edit-floor").value = "b";
  await f.node("#rooms-rename-form").dispatch("submit");
  assert.equal(f.posts()[0].url, "/api/rooms/update");
  assert.deepEqual(JSON.parse(f.posts()[0].options.body), { id: "Office", name: "Office", floorId: "b" });
  const climate = f.models().find(device => device.key === owner);
  assert.equal(climate.room.id, "Office"); assert.equal(climate.room.floorId, "b");
  assert.equal(climate.roles.setpoint.id, setpoint.id);
});

test("deleting a floor requires confirmation and keeps its rooms and devices", async () => {
  const f = setup();
  const floor = { id: "a", name: "North wing" };
  f.run(`applyDeviceSettings([], [], [], [${JSON.stringify(floor)}], [{id:"Office",name:"Office",floorId:"a"}])`);
  f.setHandler(() => response({ floors: [], roomDetails: [{ id: "Office", name: "Office", floorId: null }] }));
  f.run("openRoomsDialog()");
  f.node("#floors-list").children[0].children[0].dispatch("click");
  f.node("#floors-delete").dispatch("click");
  assert.equal(f.posts().length, 0);
  assert.equal(f.node("#floors-delete-confirmation").hidden, false);
  await f.node("#floors-delete-confirm").dispatch("click");
  assert.equal(f.posts()[0].url, "/api/floors/delete");
  const climate = f.models().find(device => device.key === owner);
  assert.equal(climate.room.id, "Office"); assert.equal(climate.room.floorId, null);
  assert.equal(f.models().length, 2);
});

test("selecting and renaming an automatic room updates its cards, choices and selected editor", async () => {
  const f = setup();
  f.run("openRoomsDialog()");
  selectRoom(f, "Office");
  assert.equal(f.node("#rooms-editor").hidden, false);
  assert.equal(f.node("#rooms-selected").textContent, "Office");
  assert.match(f.node("#rooms-summary").textContent, /Uređaja u prostoriji: 1/);
  f.node("#rooms-rename-name").value = "New office";
  f.setHandler(() => response({ room: "New office", rooms: ["New office"], devices: [], roomRules: [{ from: "Office", to: "New office" }] }));
  await f.node("#rooms-rename-form").dispatch("submit");
  assert.deepEqual(f.posts().map((request) => request.url), ["/api/rooms/rename"]);
  assert.deepEqual(JSON.parse(f.posts()[0].options.body), { name: "Office", newName: "New office" });
  assert.equal(f.models()[0].room.label, "New office");
  assert.equal(f.node("#rooms-selected").textContent, "New office");
  assert.equal(f.node("#rooms-list").children.length, 1);
  assert.equal(f.node("#rooms-rename").disabled, false);
  f.open();
  assert.ok(f.cardNode("room").options.some((option) => option.value === "room:New office"));
  assert.ok(!f.cardNode("room").options.some((option) => option.value === "room:Office"));
});

test("room deletion requires confirmation and suppresses automatic reassignment without deleting cards", async () => {
  const f = setup();
  f.run("openRoomsDialog()");
  selectRoom(f, "Office");
  f.node("#rooms-delete").dispatch("click");
  assert.equal(f.node("#rooms-delete-confirmation").hidden, false);
  assert.match(f.node("#rooms-delete-message").textContent, /Bez prostorije/);
  assert.equal(f.posts().length, 0);
  f.node("#rooms-delete-cancel").dispatch("click");
  assert.equal(f.node("#rooms-delete-confirmation").hidden, true);
  f.node("#rooms-delete").dispatch("click");
  f.setHandler(() => response({ room: "", rooms: [], devices: [], roomRules: [{ from: "Office", to: "" }] }));
  await f.node("#rooms-delete-confirm").dispatch("click");
  assert.deepEqual(f.posts().map((request) => request.url), ["/api/rooms/delete"]);
  assert.equal(f.models().length, 2);
  assert.equal(f.models()[0].room, null);
  assert.equal(f.node("#rooms-editor").hidden, true);
  assert.equal(f.node("#rooms-list").children.length, 0);
});

test("failed room changes retain the selected room and editable draft", async () => {
  const f = setup();
  f.run("openRoomsDialog()");
  selectRoom(f, "Office");
  f.node("#rooms-rename-name").value = "Unwritten room";
  f.setHandler(() => response({ error: "Disk unavailable" }, 500));
  await f.node("#rooms-rename-form").dispatch("submit");
  assert.equal(f.models()[0].room.label, "Office");
  assert.equal(f.node("#rooms-rename-name").value, "Unwritten room");
  assert.equal(f.node("#rooms-selected").textContent, "Office");
  assert.match(f.node("#rooms-status").textContent, /Disk unavailable/);
  f.node("#rooms-delete").dispatch("click");
  await f.node("#rooms-delete-confirm").dispatch("click");
  assert.equal(f.node("#rooms-delete-confirmation").hidden, false);
  assert.equal(f.node("#rooms-delete-confirm").disabled, false);
  assert.equal(f.models()[0].room.label, "Office");
});

test("conflicting or empty room rename drafts are rejected before saving", async () => {
  const f = setup();
  f.run("storedRooms = ['Office', 'Taken']; openRoomsDialog()");
  selectRoom(f, "Office");
  for (const name of ["TAKEN", " ", "x".repeat(161)]) {
    f.node("#rooms-rename-name").value = name;
    await f.node("#rooms-rename-form").dispatch("submit");
    assert.ok(f.node("#rooms-status").textContent);
  }
  assert.equal(f.posts().length, 0);
});

test("bulk room form sends selected device keys in one update and preserves their other card settings", async () => {
  const saved = [{ ...automaticEntry, label: "My climate", primaryPointId: humidity.id }];
  const fixture = setup({ saved });
  fixture.setHandler((_url, options) => {
    const body = JSON.parse(options.body);
    const room = body.newRoom ? "room-conference" : body.room;
    const devices = [saved[0], { ...automaticEntry, key: foreignOwner }].map((entry) => ({ ...entry, room }));
    return response({ moved: body.keys.length, devices, rooms: [room], floors: [], roomDetails: [{ id: room, name: body.newRoom?.name || room, floorId: null }] });
  });
  fixture.run("openBulkRoomDialog(cardSettingsDevices())");
  fixture.node("#device-room-floor").value = "unknown";
  fixture.node("#device-room-floor").dispatch("change");
  fixture.node("#device-room-target").value = "new";
  fixture.node("#device-room-target").dispatch("change");
  fixture.node("#device-room-new").value = "Conference room";
  await fixture.node("#device-room-form").dispatch("submit");
  assert.deepEqual(fixture.posts().map((request) => request.url), ["/api/devices/rooms"]);
  assert.deepEqual(JSON.parse(fixture.posts()[0].options.body), { keys: [owner, foreignOwner], room: "", newRoom: { name: "Conference room", floorId: null } });
  assert.ok(fixture.models().every((device) => device.room.label === "Conference room"));
  assert.equal(fixture.models()[0].label, "My climate");
  assert.equal(fixture.models()[0].metrics.primary.id, humidity.id);
  assert.equal(fixture.node("#device-room-dialog").open, false);
});

test("failed bulk room save leaves cards unchanged and keeps the room dialog available", async () => {
  const fixture = setup({ saved: [{ ...automaticEntry, room: "Existing room" }] });
  fixture.setHandler(() => response({ error: "Disk unavailable" }, 500));
  fixture.run("openBulkRoomDialog(cardSettingsDevices())");
  fixture.node("#device-room-floor").value = "unknown";
  fixture.node("#device-room-floor").dispatch("change");
  fixture.node("#device-room-target").value = "new";
  fixture.node("#device-room-new").value = "Unwritten room";
  await fixture.node("#device-room-form").dispatch("submit");
  assert.equal(fixture.models()[0].room.label, "Existing room");
  assert.equal(fixture.node("#device-room-dialog").open, true);
  assert.match(fixture.node("#device-room-status").textContent, /Disk unavailable/);
});

function bulkFloorFixture(sameFloor = false) {
  const fixture = setup({ saved: [{ ...automaticEntry, room: "kitchen-1" }, { ...automaticEntry, key: foreignOwner, room: sameFloor ? "kitchen-1" : "kitchen-2" }] });
  const floors = [{ id: "floor:1", name: "1. kat A" }, { id: "floor:2", name: "1. kat B" }];
  const rooms = [{ id: "kitchen-1", name: "Kitchen", floorId: "floor:1" }, { id: "kitchen-2", name: "Kitchen", floorId: "floor:2" }, { id: "empty-2", name: "Storage", floorId: "floor:2" }, { id: "unknown-room", name: "Hall", floorId: null }];
  fixture.run(`applyDeviceSettings(fixtureSaved, ${JSON.stringify(rooms.map(room => room.id))}, [], ${JSON.stringify(floors)}, ${JSON.stringify(rooms)}); openBulkRoomDialog(cardSettingsDevices());`);
  return fixture;
}

test("bulk move filters identical room names by stored floor ID and clears an incompatible previous target", async () => {
  const fixture = bulkFloorFixture();
  assert.equal(fixture.node("#device-room-floor").value, "all");
  fixture.node("#device-room-target").value = "room:kitchen-1";
  fixture.node("#device-room-floor").value = "floor:floor:2";
  fixture.node("#device-room-floor").dispatch("change");
  assert.equal(fixture.node("#device-room-target").value, "");
  const choices = fixture.node("#device-room-target").options.map(option => option.value);
  assert(choices.includes("room:kitchen-2")); assert(choices.includes("room:empty-2"));
  assert(!choices.includes("room:kitchen-1")); assert(!choices.includes("room:unknown-room"));
  assert.equal(fixture.node("#device-room-target").options.find(option => option.value === "room:kitchen-2").textContent, "Kitchen");
  fixture.node("#device-room-target").value = "room:kitchen-2";
  fixture.setHandler((_url, options) => response({ moved: 2, devices: fixture.saved().map(device => ({ ...device, room: JSON.parse(options.body).room })) }));
  await fixture.node("#device-room-form").dispatch("submit");
  assert.deepEqual(JSON.parse(fixture.posts()[0].options.body), { keys: [owner, foreignOwner], room: "kitchen-2" });
  assert(fixture.models().every(device => device.room.floorId === "floor:2"));
});

test("bulk move preselects the common source floor and can atomically create its destination room on another group", async () => {
  const fixture = bulkFloorFixture(true);
  assert.equal(fixture.node("#device-room-floor").value, "floor:floor:1");
  fixture.node("#device-room-floor").value = "floor:floor:2";
  fixture.node("#device-room-floor").dispatch("change");
  fixture.node("#device-room-target").value = "new";
  fixture.node("#device-room-target").dispatch("change");
  fixture.node("#device-room-new").value = "Studio";
  assert.match(fixture.node("#device-room-hint").textContent, /1\. kat B/);
  await fixture.node("#device-room-form").dispatch("submit");
  assert.equal(fixture.posts().length, 1);
  assert.deepEqual(JSON.parse(fixture.posts()[0].options.body), { keys: [owner, foreignOwner], room: "", newRoom: { name: "Studio", floorId: "floor:2" } });
});

test("bulk new-room creation requires an explicit group or the unknown-floor option and preserves the draft", async () => {
  const fixture = bulkFloorFixture();
  fixture.node("#device-room-target").value = "new";
  fixture.node("#device-room-target").dispatch("change");
  fixture.node("#device-room-new").value = "New room";
  await fixture.node("#device-room-form").dispatch("submit");
  assert.equal(fixture.posts().length, 0);
  assert.match(fixture.node("#device-room-status").textContent, /odaberi kat/);
  fixture.node("#device-room-floor").value = "unknown";
  fixture.node("#device-room-floor").dispatch("change");
  assert.equal(fixture.node("#device-room-new").value, "New room");
  assert.equal(fixture.node("#device-room-target").value, "new");
  assert.equal(fixture.node("#device-room-floor").validationMessage, "");
  await fixture.node("#device-room-form").dispatch("submit");
  assert.equal(JSON.parse(fixture.posts()[0].options.body).newRoom.floorId, null);
});

test("bulk unknown-floor filter keeps unknown and legacy rooms, and unassigning clears both room and inherited floor", async () => {
  const fixture = bulkFloorFixture();
  fixture.node("#device-room-floor").value = "unknown";
  fixture.node("#device-room-floor").dispatch("change");
  const choices = fixture.node("#device-room-target").options.map(option => option.value);
  assert(choices.includes("room:unknown-room")); assert(choices.includes("room:Office"));
  assert(!choices.includes("room:kitchen-1")); assert(choices.includes("auto"));
  fixture.node("#device-room-target").value = "unassigned";
  fixture.node("#device-room-target").dispatch("change");
  assert.match(fixture.node("#device-room-hint").textContent, /bez dodijeljenog kata/);
  await fixture.node("#device-room-form").dispatch("submit");
  assert.equal(JSON.parse(fixture.posts()[0].options.body).room, "");
});

test("a live room move to a different floor invalidates an open bulk destination without losing the selected devices", async () => {
  const fixture = bulkFloorFixture(true);
  fixture.node("#device-room-target").value = "room:kitchen-1";
  fixture.run(`applyDeviceSettings([...deviceSettingsByKey.values()], storedRooms, storedRoomRules, storedFloors, storedRoomDetails.map(room => room.id === 'kitchen-1' ? { ...room, floorId: 'floor:2' } : room));`);
  assert.equal(fixture.node("#device-room-target").value, "");
  assert.equal(fixture.node("#device-room-dialog").open, true);
  assert.deepEqual(json(fixture.run("moveKeys")), [owner, foreignOwner]);
  await fixture.node("#device-room-form").dispatch("submit");
  assert.equal(fixture.posts().length, 0);
});

test("device removal requires confirmation and removes only the confirmed card's point configuration", async () => {
  const fixture = setup();
  fixture.open();
  fixture.cardNode("remove").dispatch("click");
  assert.equal(fixture.cardNode("remove-confirmation").hidden, false);
  assert.equal(fixture.requests.filter((request) => request.options.method === "DELETE").length, 0);
  fixture.cardNode("remove-cancel").dispatch("click");
  assert.equal(fixture.cardNode("remove-confirmation").hidden, true);
  fixture.setHandler((_url, options) => response({ key: JSON.parse(options.body).key, ids: widgets.filter((w) => grouping.deriveWidgetGrouping(w.id).key === owner).map((w) => w.id) }));
  fixture.cardNode("remove").dispatch("click");
  await fixture.cardNode("remove-confirm").dispatch("click");
  const deletes = fixture.requests.filter((request) => request.options.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].url, "/api/devices");
  assert.deepEqual(JSON.parse(deletes[0].options.body), { key: owner });
  assert.equal(fixture.models().some((device) => device.key === owner), false);
  assert.equal(fixture.models().some((device) => device.key === foreignOwner), true);
});
