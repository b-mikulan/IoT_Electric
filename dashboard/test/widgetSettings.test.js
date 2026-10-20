const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const grouping = require("../public/widgetGrouping");
const deviceModel = require("../public/deviceModel");

// Evaluate the actual browser entry point. Only boot's initial fetch is paused;
// settings code, helper imports and registered event handlers run unmodified.
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
  }
  get options() { return this.children; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name) { return this.listeners.get(name)?.({ target: this, preventDefault() {} }); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = [...children]; }
  set innerHTML(value) { if (value === "") this.replaceChildren(); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  setCustomValidity(message) { this.validationMessage = message; }
  reset() {}
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function setup(widgets) {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: node, createElement: (tag) => new Element(tag) },
    IoTWidgetGrouping: grouping,
    IoTDeviceModel: deviceModel,
    fetch: () => new Promise(() => {}),
    requestAnimationFrame: (callback) => callback(),
    fixtureWidgets: structuredClone(widgets),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8"), context);
  vm.runInContext("widgetEditingEnabled = true; for (const widget of fixtureWidgets) configById.set(widget.id, widget);", context);
  return { node, context, run: (source) => vm.runInContext(source, context) };
}

const owner = "ES/Application/Items/Climate";
const reading = { id: `01/${owner}/Values/RmTmp`, label: "Room temperature", description: "Measured temperature", unit: "°C", precision: 1, writable: false, visible: true, value: 22.4, state: 0 };
const command = { id: `01/${owner}/Values/EffSpt`, label: "Target temperature", description: "Effective setpoint", unit: "°C", precision: 1, writable: false, visible: true, value: 23, state: 0 };

test("raw settings gear opens the actual modal with the automatic group and saved point settings", () => {
  const { node, run } = setup([command]);
  assert.doesNotThrow(() => run(`openSettingsDialog(${JSON.stringify(command.id)})`));
  assert.equal(node("#settings-dialog").open, true);
  assert.equal(node("#settings-id").value, command.id);
  assert.equal(node("#settings-label").value, command.label);
  assert.equal(node("#settings-group").placeholder, grouping.deriveWidgetGroup(command.id));
  assert.equal(node("#settings-writable").checked, false);
  assert.equal(node("#settings-writable").disabled, false);
  assert.equal(node("#settings-point-field").hidden, true);
});

test("device settings select a command first and hydrate readings without enabling them as controls", () => {
  const alias = { ...command, id: `11/${command.id.slice(3)}/Value`, label: "Value" };
  const { node, run, context } = setup([reading, command, alias]);
  const [device] = deviceModel.buildDevices([reading, command, alias]);
  context.fixtureDevice = device;
  run("openDeviceSettingsDialog(fixtureDevice)");
  assert.equal(node("#settings-dialog").open, true);
  assert.equal(node("#settings-point-field").hidden, false);
  assert.equal(node("#settings-id").value, command.id);
  assert.equal(node("#settings-point").options[0].value, command.id);
  assert.equal(node("#settings-point").options.some((option) => option.value === alias.id), false);
  assert.equal(node("#settings-writable").disabled, false);
  assert.equal(node("#settings-context").hidden, false);

  node("#settings-point").value = reading.id;
  node("#settings-point").dispatch("change");
  assert.equal(node("#settings-id").value, reading.id);
  assert.equal(node("#settings-label").value, reading.label);
  assert.equal(node("#settings-description").value, reading.description);
  assert.equal(node("#settings-unit").value, "°C");
  assert.equal(node("#settings-writable").disabled, true);
});

test("device function selection refuses a point outside the selected card", () => {
  const unrelated = { ...command, id: "01/ES/Application/Items/Other/Values/EffSpt", label: "Other target" };
  const { node, run, context } = setup([reading, command, unrelated]);
  context.fixtureDevice = deviceModel.buildDevices([reading, command])[0];
  run("openDeviceSettingsDialog(fixtureDevice)");
  node("#settings-point").value = unrelated.id;
  node("#settings-point").dispatch("change");
  assert.equal(node("#settings-id").value, command.id);
  assert.notEqual(node("#settings-status").textContent, "");
});

test("device settings with no editable configured functions do not open an unrelated point", () => {
  const { node, run, context } = setup([command]);
  context.fixtureDevice = { key: "ES/missing", label: "Missing device", primary: [{ id: "01/ES/missing/Values/EffSpt", command: true }], diagnostics: [], other: [] };
  run("openDeviceSettingsDialog(fixtureDevice)");
  assert.equal(node("#settings-dialog").open, false);
  assert.equal(node("#settings-id").value, "");
  run("openSettingsDialog('01/ES/missing/Values/EffSpt')");
  assert.equal(node("#settings-dialog").open, false);
});

test("disabled widget editing prevents opening either settings entry point", () => {
  const { node, run, context } = setup([command]);
  context.fixtureDevice = deviceModel.buildDevices([command])[0];
  run("widgetEditingEnabled = false; openSettingsDialog(fixtureWidgets[0].id); openDeviceSettingsDialog(fixtureDevice);");
  assert.equal(node("#settings-dialog").open, false);
});
