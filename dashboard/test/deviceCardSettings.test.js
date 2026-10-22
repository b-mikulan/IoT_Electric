const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const grouping = require("../public/widgetGrouping");
const deviceModel = require("../public/deviceModel");

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

function setup({ saved = [], enabled = true, editable = true } = {}) {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  };
  const requests = [];
  const eventSources = [];
  let releaseBoot;
  let requestHandler = (url, options) => options?.method === "POST"
    ? response({ device: JSON.parse(options.body) })
    : response({ devices: saved, enabled });
  let models = [];
  const view = {
    update(input) { models = deviceModel.buildDevices(input.widgets, input); },
    getDevices() { return models.slice(); },
  };
  const context = vm.createContext({
    document: { querySelector: node, createElement: (tag) => new Element(tag) },
    IoTWidgetGrouping: grouping, IoTDeviceModel: deviceModel,
    IoTDeviceCards: { create: () => view },
    Option: function Option(label, value) { const option = new Element("option"); option.textContent = label; option.value = value; return option; },
    EventSource: class {
      constructor(url) { this.url = url; this.listeners = new Map(); eventSources.push(this); }
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
  run(fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8"));
  run(`widgetEditingEnabled = ${editable}; deviceSettingsEnabled = ${enabled};
    for (const widget of fixtureWidgets) configById.set(widget.id, widget);
    deviceMetadata = { metadataById: {}, roomByZone: { "ES/Application/Items": "Office" } };
    deviceCardView = fixtureView; applyDeviceSettings(fixtureSaved);`);
  const cardNode = (name) => node(`#device-settings-${name}`);
  const open = () => run(`openDeviceCardSettingsDialog(cardSettingsDevices().find((device) => device.key === ${JSON.stringify(owner)}))`);
  const checkbox = (id) => cardNode("secondary-list").children.map((label) => label.children[0]).find((input) => input?.value === id);
  const posts = () => requests.filter((request) => request.options.method === "POST");
  return {
    node, cardNode, context, run, open, checkbox, posts, requests, eventSources,
    models: () => view.getDevices(),
    setHandler(handler) { requestHandler = handler; },
    boot(config = {}) { releaseBoot(response({ widgets: [], intervalMs: 15000, widgetEditingEnabled: editable, deviceSettingsEnabled: enabled, deviceSettings: saved, ...config })); },
    saved: () => json(run("[...deviceSettingsByKey.values()]")),
  };
}

test("card settings save custom identity and device-local secondary readings through the settings endpoint only", async () => {
  const fixture = setup();
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
  const expected = { key: owner, label: "Living room climate", room: "Living room", primaryPointId: humidity.id, primaryUnit: null, secondaryPointIds: [temperature.id] };
  assert.deepEqual(fixture.posts().map((request) => request.url), ["/api/devices/settings"]);
  assert.deepEqual(JSON.parse(fixture.posts()[0].options.body), expected);
  assert.deepEqual(fixture.saved(), [expected]);
  const climate = fixture.models().find((device) => device.key === owner);
  assert.equal(climate.label, expected.label);
  assert.equal(climate.room.label, expected.room);
  assert.equal(climate.metrics.primary.id, humidity.id);
  assert.equal(climate.metrics.secondary[0].id, temperature.id);
  assert.equal(climate.roles.setpoint.id, setpoint.id);
  assert.equal(climate.roles.illuminance, undefined);
  assert.match(fixture.cardNode("status").textContent, /spremljeni/);
});

test("secondary choices exclude other devices, including legacy selections and search results", async () => {
  const entry = { ...automaticEntry, secondaryPointIds: [co2.id, illuminance.id] };
  const fixture = setup({ saved: [entry] });
  fixture.open();
  assert.equal(fixture.cardNode("primary").options.some((option) => option.value === illuminance.id), true);
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
  const saved = JSON.parse(fixture.posts()[0].options.body);
  assert.equal(saved.primaryPointId, illuminance.id);
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
  fixture.cardNode("primary").value = illuminance.id;
  fixture.cardNode("primary").dispatch("change");
  assert.match(automaticOption(), /lx/);
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
