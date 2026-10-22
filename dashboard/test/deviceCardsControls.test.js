const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../public/deviceCards");

// A small DOM fixture keeps these interaction tests independent of a browser or controller.
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.className = "";
    this.classList = {
      add: (name) => this.classList.toggle(name, true),
      toggle: (name, enabled) => {
        const classes = new Set(this.className.split(" ").filter(Boolean));
        if (enabled) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(" ");
      },
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
  get childElementCount() { return this.children.length; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.text = ""; this.append(...nodes); }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
  querySelectorAll(tag) { return descendants(this).filter((node) => node.tagName === tag); }
}

function descendants(node) { return node.children.flatMap((child) => [child, ...descendants(child)]); }
function byClass(container, name) { return descendants(container).filter((node) => node.className.split(" ").includes(name)); }
function flush() { return new Promise((resolve) => setImmediate(resolve)); }

function setup(t, initialDevices, onWrite, demo = false, initialReadAt, options = {}) {
  const previousDocument = globalThis.document;
  const previousModel = globalThis.IoTDeviceModel;
  let devices = initialDevices;
  let readAt = initialReadAt;
  globalThis.document = { createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag), activeElement: null };
  globalThis.IoTDeviceModel = options.model || { buildDevices: () => devices };
  const container = new Element("section");
  const view = create({ container, onWrite, onSettings: options.onSettings });
  const update = (next = devices, nextReadAt = readAt, overrides = {}) => { devices = next; readAt = nextReadAt; view.update({ status: "connected", demo, readAt, settingsEnabled: options.settingsEnabled, ...overrides }); };
  update();
  t.after(() => { view.destroy(); globalThis.document = previousDocument; globalThis.IoTDeviceModel = previousModel; });
  return { container, update, view };
}

function point(role, value, options = {}) {
  return {
    id: `01/ES/Device/Values/${role}`, role, value, state: 0, updatedAt: "before",
    controlAvailable: true, writeAllowed: true, liveControlAvailable: true,
    control: { min: 0, max: 100, step: 1, rangeConfirmed: true }, unit: "%", ...options,
  };
}

function device(type, roles) {
  return { key: `ES/${type}`, label: "Test device", type, roles, primary: Object.values(roles), diagnostics: [], other: [], support: [] };
}

test("live slider previews without a write, sends once on change, and separates accepted target from actual feedback", async (t) => {
  let finish;
  const calls = [];
  const set = point("brightnessSet", 40);
  const feedback = point("brightnessStatus", 11, { control: null });
  const light = device("light", { brightnessSet: set, brightnessStatus: feedback });
  const { container, update } = setup(t, [light], (command) => { calls.push(command); return new Promise((resolve) => { finish = resolve; }); });
  const input = byClass(container, "dc-range")[0];
  const toggle = byClass(container, "dc-toggle")[0];
  input.value = "67";
  input.dispatch("input");
  assert.equal(calls.length, 0);
  assert.equal(byClass(container, "dc-metric-value")[0].textContent, "11 %");
  input.dispatch("change");
  assert.deepEqual(calls, [{ widgetId: set.id, value: 67 }]);
  assert.equal(input.disabled, true);
  assert.equal(toggle.disabled, true);
  input.dispatch("change");
  toggle.dispatch("click");
  assert.equal(calls.length, 1);
  finish();
  await flush();
  assert.match(byClass(container, "dc-command-status")[0].textContent, /prihvaćena.*Čekam novo očitanje/);
  assert.equal(byClass(container, "dc-metric-value")[0].textContent, "11 %");
  update([device("light", { brightnessSet: { ...set, value: 67, updatedAt: "after" }, brightnessStatus: { ...feedback, value: 12 } })]);
  assert.match(byClass(container, "dc-command-status")[0].textContent, /potvrđena je novim očitanjem/);
  assert.equal(byClass(container, "dc-metric-value")[0].textContent, "12 %");
  assert.equal(byClass(container, "dc-reset")[0].hidden, true);
});

test("a failed live command is visible and is never retried by refresh", async (t) => {
  let calls = 0;
  const light = device("light", { brightnessSet: point("brightnessSet", 40) });
  const { container, update } = setup(t, [light], async () => { calls++; throw new Error("Kontroler nije dostupan."); });
  const input = byClass(container, "dc-range")[0];
  document.activeElement = input;
  input.value = "67";
  input.dispatch("change");
  await flush();
  assert.equal(calls, 1);
  assert.match(byClass(container, "dc-command-status")[0].textContent, /Slanje nije potvrđeno: Kontroler nije dostupan/);
  assert.equal(byClass(container, "dc-range")[0].value, "40");
  assert.equal(document.activeElement, input);
  update();
  await flush();
  assert.equal(calls, 1);
  assert.equal(byClass(container, "dc-metric-value")[0].textContent, "40 %");
});

test("a no-op command is confirmed by a fresh successful sync even when updatedAt stays unchanged", async (t) => {
  let finish;
  const calls = [];
  const light = device("light", { brightnessSet: point("brightnessSet", 40) });
  const { container, update } = setup(t, [light], (command) => { calls.push(command); return new Promise((resolve) => { finish = resolve; }); }, false, "initial-read");
  const input = byClass(container, "dc-range")[0];
  input.value = "40";
  input.dispatch("change");
  update([light], "read-during-write");
  finish();
  await flush();
  const status = byClass(container, "dc-command-status")[0];
  assert.match(status.textContent, /Čekam novo očitanje/);
  update([light], "read-during-write");
  assert.match(status.textContent, /Čekam novo očitanje/);
  update([light], "read-after-acceptance");
  assert.match(status.textContent, /potvrđena je novim očitanjem/);
  assert.equal(byClass(container, "dc-draft-line")[0].hidden, true);
  assert.deepEqual(calls, [{ widgetId: light.roles.brightnessSet.id, value: 40 }]);
});

test("a rejected command restores the focused select without blurring or retrying", async (t) => {
  let calls = 0;
  const power = point("power", 0, { unit: "", control: { options: [{ value: 0, label: "Off" }, { value: 1, label: "On" }] } });
  const { container, update } = setup(t, [device("climate", { power })], async () => { calls++; throw new Error("Upis odbijen."); });
  const select = byClass(container, "dc-select")[0];
  document.activeElement = select;
  select.value = "1";
  select.dispatch("change");
  await flush();
  assert.equal(select.value, "0");
  assert.equal(document.activeElement, select);
  assert.match(byClass(container, "dc-command-status")[0].textContent, /Upis odbijen/);
  update();
  assert.equal(calls, 1);
});

test("live controls respect local permission and server health", (t) => {
  const calls = [];
  const forbidden = point("brightnessSet", 40, { writeAllowed: false });
  const light = device("light", { brightnessSet: forbidden });
  const { container, update } = setup(t, [light], (command) => { calls.push(command); });
  assert.equal(byClass(container, "dc-toggle")[0].disabled, true);
  byClass(container, "dc-toggle")[0].dispatch("click");
  update([device("light", { brightnessSet: { ...forbidden, writeAllowed: true, state: 2 } })]);
  assert.equal(byClass(container, "dc-toggle")[0].disabled, true);
  byClass(container, "dc-toggle")[0].dispatch("click");
  assert.deepEqual(calls, []);
});

test("blind position and slat sliders display percentages and send percentage commands unchanged", async (t) => {
  const calls = [];
  const positionSet = point("positionSet", 36, {
    id: "01/ES/Device/Values/BlndPos", unit: "%",
    control: { kind: "range", min: 0, max: 100, step: 1, rangeConfirmed: true },
  });
  const slatSet = { ...positionSet, id: "01/ES/Device/Values/BlndSlt", role: "slatSet" };
  const { container } = setup(t, [device("blind", { positionSet, slatSet })], async (command) => { calls.push(command); });
  const [input, slatInput] = byClass(container, "dc-range");
  assert.equal(input.min, "0");
  assert.equal(input.max, "100");
  assert.equal(input.step, "1");
  assert.equal(byClass(container, "dc-control-output")[0].textContent, "36 %");
  assert.equal(byClass(container, "dc-control-label")[1].textContent, "Kut lamela");
  assert.equal(byClass(container, "dc-control-hint")[0].textContent, "Raspon 0–100 %");
  input.value = "37";
  input.dispatch("input");
  assert.equal(calls.length, 0);
  assert.equal(byClass(container, "dc-control-output")[0].textContent, "37 %");
  input.dispatch("change");
  await flush();
  assert.equal(slatInput.min, "0");
  assert.equal(slatInput.max, "100");
  assert.equal(slatInput.step, "1");
  slatInput.value = "42";
  slatInput.dispatch("input");
  assert.equal(calls.length, 1);
  assert.equal(byClass(container, "dc-control-output")[1].textContent, "42 %");
  slatInput.dispatch("change");
  await flush();
  assert.deepEqual(calls, [{ widgetId: positionSet.id, value: 37 }, { widgetId: slatSet.id, value: 42 }]);
});

test("demo controls remain local even when a real write callback is provided", async (t) => {
  const calls = [];
  const light = device("light", { brightnessSet: point("brightnessSet", 40, { writeAllowed: false, liveControlAvailable: false }) });
  const { container } = setup(t, [light], (command) => { calls.push(command); }, true);
  const input = byClass(container, "dc-range")[0];
  input.value = "67";
  input.dispatch("input");
  input.dispatch("change");
  byClass(container, "dc-toggle")[0].dispatch("click");
  await flush();
  assert.deepEqual(calls, []);
  assert.equal(byClass(container, "dc-reset")[0].hidden, false);
  assert.match(byClass(container, "dc-simulation-badge")[0].textContent, /Simulacija/);
  assert.equal(byClass(container, "dc-metric-value")[0].textContent, "40 %");
});

test("live enum selection sends the confirmed value and canonical source ID", async (t) => {
  const calls = [];
  const power = point("power", 0, { sourceId: "01/ES/Device/Points/OnOffMd", unit: "", control: { options: [{ value: 0, label: "Off" }, { value: 1, label: "On" }] } });
  const { container } = setup(t, [device("climate", { power })], async (command) => { calls.push(command); });
  const select = byClass(container, "dc-select")[0];
  select.value = "arbitrary";
  select.dispatch("change");
  assert.equal(calls.length, 0);
  select.value = "1";
  select.dispatch("change");
  await flush();
  assert.deepEqual(calls, [{ widgetId: power.sourceId, value: 1 }]);
});

test("temperature stepper respects confirmed bounds and retains fractional Kelvin values", async (t) => {
  const calls = [];
  const setpoint = point("setpoint", 35, { unit: "°C", control: { min: 5, max: 35, step: .5 } });
  const { container, update } = setup(t, [device("climate", { setpoint })], async (command) => { calls.push(command); });
  assert.equal(byClass(container, "dc-step-button")[1].disabled, true);
  byClass(container, "dc-step-button")[1].dispatch("click");
  assert.equal(calls.length, 0);
  update([device("climate", { setpoint: { ...setpoint, value: 298.15, unit: "K", control: { min: 278.15, max: 308.15, step: .5 } } })]);
  byClass(container, "dc-step-button")[1].dispatch("click");
  await flush();
  assert.equal(calls[0].value, 298.65);
});

test("device settings open with the latest model without issuing a controller command", (t) => {
  const writes = [];
  const settings = [];
  const initial = device("light", { brightnessSet: point("brightnessSet", 40) });
  const { container, update } = setup(t, [initial], (command) => writes.push(command), false, undefined, {
    onSettings: (current) => settings.push(current), settingsEnabled: true,
  });
  const button = byClass(container, "dc-settings-button")[0];
  assert.equal(button.hidden, false);
  assert.equal(button.attributes["aria-label"], "Postavke uređaja Test device");
  assert.equal(button.attributes["aria-haspopup"], "dialog");
  button.dispatch("click");
  assert.equal(settings[0], initial);

  const changed = { ...initial, label: "Kitchen light", roles: { brightnessSet: point("brightnessSet", 70, { state: 2, writeAllowed: false }) } };
  update([changed], undefined, { status: "offline" });
  assert.equal(button.attributes["aria-label"], "Postavke uređaja Kitchen light");
  assert.equal(button.hidden, false);
  assert.notEqual(button.disabled, true);
  button.dispatch("click");
  assert.equal(settings[1], changed);
  assert.deepEqual(writes, []);
});

test("device settings are hidden and inert when editing is unavailable", (t) => {
  const settings = [];
  const light = device("light", { brightnessSet: point("brightnessSet", 40) });
  const { container, update } = setup(t, [light], undefined, false, undefined, { onSettings: (current) => settings.push(current) });
  const button = byClass(container, "dc-settings-button")[0];
  assert.equal(button.hidden, true);
  button.dispatch("click");
  assert.deepEqual(settings, []);
  update([light], undefined, { settingsEnabled: true });
  assert.equal(button.hidden, false);
  update([light], undefined, { settingsEnabled: false });
  assert.equal(button.hidden, true);
  button.dispatch("click");
  assert.deepEqual(settings, []);
});

test("device settings remain hidden without a settings callback", (t) => {
  const light = device("light", { brightnessSet: point("brightnessSet", 40) });
  const { container } = setup(t, [light], undefined, false, undefined, { settingsEnabled: true });
  const button = byClass(container, "dc-settings-button")[0];
  assert.equal(button.hidden, true);
  button.dispatch("click");
});

test("persisted card title, room and cross-device metrics update without changing the controlled point", async (t) => {
  const model = require("../public/deviceModel");
  const owner = "ES/Room/L1";
  const set = { id: `01/${owner}/Values/LtPct`, value: 40, state: 0, writable: true };
  const feedback = { id: `01/${owner}/Values/LtVal`, value: 11, state: 0 };
  const temperature = { id: "01/ES/AC/Values/RmTmp", value: 24.1, state: 0, unit: "°C" };
  const writes = [];
  const { container, update, view } = setup(t, [], async (command) => writes.push(command), false, "first", { model });
  const state = {
    widgets: [set, feedback, temperature], metadataById: { [set.id]: { writeable: 1 } }, roomByZone: { "ES/Room": "Kitchen" },
    deviceSettings: [{ key: owner, label: "Dining light", room: "Dining room", primaryPointId: temperature.id, secondaryPointIds: [feedback.id] }],
  };
  update([], "first", state);
  assert.equal(byClass(container, "dc-card-title")[0].textContent, "Dining light");
  assert.equal(byClass(container, "dc-room")[0].textContent, "Dining room");
  const main = byClass(container, "dc-metric-main")[0];
  assert.equal(byClass(main, "dc-metric-value")[0].textContent, "24,1 °C");
  assert.equal(byClass(main, "dc-metric-label")[0].textContent, "Temperatura");
  assert.equal(byClass(container, "dc-metric-value")[1].textContent, "11");
  const filters = byClass(container, "dc-room-filter");
  const dining = filters.find((entry) => entry.textContent === "Dining room");
  dining.dispatch("click");
  assert.equal(byClass(container, "dc-card")[0].hidden, false);
  assert.equal(byClass(container, "dc-card")[1].hidden, true);
  const slider = byClass(container, "dc-range")[0];
  slider.value = "67";
  slider.dispatch("change");
  await flush();
  assert.deepEqual(writes, [{ widgetId: set.id, value: 67 }]);
  assert.equal(view.getDevices()[0].key, owner);
  assert.equal(view.getDevices()[0].metrics.primary.id, temperature.id);

  update([], "second", { ...state, deviceSettings: [{ key: owner, room: "Bedroom", primaryPointId: null, secondaryPointIds: [] }] });
  assert.equal(byClass(container, "dc-card-title")[0].textContent, "L1");
  assert.equal(byClass(container, "dc-room")[0].textContent, "Bedroom");
  assert.equal(byClass(byClass(container, "dc-card")[0], "dc-metric-value").length, 1);
  assert.equal(byClass(container, "dc-metric-value")[0].textContent, "11");
  assert.equal(byClass(container, "dc-room-filter").some((entry) => entry.textContent === "Dining room"), false);
  assert.equal(byClass(container, "dc-room-filter").some((entry) => entry.textContent === "Bedroom"), true);
  assert.equal(byClass(container, "dc-room-filter")[0].attributes["aria-pressed"], "true");
});

test("a missing chosen metric displays an unavailable placeholder instead of owner feedback", (t) => {
  const model = require("../public/deviceModel");
  const owner = "ES/Room/L1";
  const { container, update } = setup(t, [], undefined, false, undefined, { model });
  const widgets = [
    { id: `01/${owner}/Values/LtPct`, value: 40, state: 0 },
    { id: `01/${owner}/Values/LtVal`, value: 11, state: 0 },
  ];
  update([], undefined, { widgets, deviceSettings: [{ key: owner, primaryPointId: "01/deleted", secondaryPointIds: [] }] });
  assert.equal(byClass(container, "dc-metric-value")[0].textContent, "—");
  assert.equal(byClass(container, "dc-metric-label")[0].textContent, "Odabrano očitanje nije dostupno");
  assert.equal(byClass(container, "dc-metric-value")[0].title, "Nedostupno");
  assert.equal(byClass(container, "dc-metric")[0].className.includes("dc-reading-warning"), true);
  assert.equal(byClass(container, "dc-range").length, 1);
});

test("primary display units update between automatic, literal and unitless without altering secondary units or controls", async (t) => {
  const model = require("../public/deviceModel");
  const owner = "ES/Room/Group1";
  const set = { id: `01/${owner}/Values/GrpPct`, value: 80, state: 0, writable: true, unit: "None" };
  const secondary = { id: `01/${owner}/Values/RmCO2`, value: 580, state: 0, unit: "ppm" };
  const writes = [];
  const { container, update } = setup(t, [], async (command) => writes.push(command), false, undefined, { model });
  const state = { widgets: [set, secondary], metadataById: { [set.id]: { writeable: 1 } } };
  for (const [primaryUnit, expected] of [[null, "80 %"], ["", "80"], [" custom ", "80 custom"], [null, "80 %"]]) {
    update([], undefined, { ...state, deviceSettings: [{ key: owner, primaryUnit, secondaryPointIds: [secondary.id] }] });
    assert.equal(byClass(container, "dc-metric-value")[0].textContent, expected);
    assert.equal(byClass(container, "dc-metric-value")[1].textContent, "580 ppm");
    assert.equal(byClass(container, "dc-range")[0].min, "0");
    assert.equal(byClass(container, "dc-range")[0].max, "100");
    assert.equal(byClass(container, "dc-control-output")[0].textContent, "80 %");
  }
  assert.deepEqual(writes, []);
  update([], undefined, { ...state, deviceSettings: [{ key: owner, primaryUnit: "arbitrary label", secondaryPointIds: [secondary.id] }] });
  const slider = byClass(container, "dc-range")[0];
  slider.value = "55";
  slider.dispatch("change");
  await flush();
  assert.deepEqual(writes, [{ widgetId: set.id, value: 55 }]);
});

test("an explicit humidity display unit remains literal instead of applying the automatic RH abbreviation", (t) => {
  const model = require("../public/deviceModel");
  const owner = "ES/Room/Sensor1";
  const humidity = { id: `01/${owner}/Values/RmRh`, value: 52, state: 0, unit: "%RH" };
  const { container, update } = setup(t, [], undefined, false, undefined, { model });
  for (const [primaryUnit, expected] of [[null, "52 %"], ["%RH", "52 %RH"], ["", "52"]]) {
    update([], undefined, { widgets: [humidity], deviceSettings: [{ key: owner, primaryPointId: humidity.id, primaryUnit }] });
    assert.equal(byClass(container, "dc-metric-value")[0].textContent, expected);
  }
});
