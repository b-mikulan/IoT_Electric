const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDevices, createDeviceIndex } = require("../public/devices/deviceModel");

const owner = (index) => `ES/Application/Items/AC${index}`;
const reading = (index, name, value) => ({ id: `01/${owner(index)}/Values/${name}`, label: name, value, state: 0, error: null, updatedAt: "initial", visible: true, writable: false });

test("one changed point rebuilds only its owner and retains every unrelated device model", () => {
  const widgets = Array.from({ length: 642 }, (_, index) => [reading(index, "RmTmp", 22), reading(index, "RmRh", 50)]).flat();
  const original = JSON.stringify(widgets);
  const index = createDeviceIndex(widgets);
  const before = index.getDevices();
  const changed = index.updateValues([{ id: widgets[500].id, value: 23.5, updatedAt: "new" }]);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].key, owner(250));
  assert.equal(changed[0].roles.temperature.value, 23.5);
  const after = index.getDevices();
  for (let position = 0; position < before.length; position++) {
    if (position !== 250) assert.equal(after[position], before[position]);
  }
  assert.equal(JSON.stringify(widgets), original);
  assert.deepEqual(index.updateValues([{ id: widgets[500].id, value: 23.5, updatedAt: "new" }]), []);
  assert.deepEqual(index.updateValues([{ id: "not-configured", value: 7 }]), []);
});

test("incremental reads match a full build for aliases, states, missing data and saved card settings", () => {
  const native = reading(1, "RmTmp", 22);
  const alias = { ...native, id: `11/${owner(1)}/Values/RmTmp/Value`, value: 21 };
  let widgets = [native, alias, reading(1, "EffSpt", 23), reading(1, "RmRh", 50), reading(2, "LtVal", 30)];
  const options = {
    metadataById: { [native.id]: { unit: "°C" }, [widgets[2].id]: { writeable: 1, min: 16, max: 30 } },
    deviceSettings: [{ key: owner(1), primaryPointId: alias.id, secondaryPointIds: [widgets[3].id], primaryUnit: "custom", room: "My room" }],
    roomByZone: { ES: "Old room" }, roomRules: [{ from: "Old room", to: "New room" }],
  };
  const index = createDeviceIndex(widgets, options);
  for (const changes of [
    [{ id: alias.id, value: 24, updatedAt: "alias" }],
    [{ id: native.id, state: 2, updatedAt: "forced" }, { id: widgets[4].id, value: null, error: "Unavailable", state: null }],
    [{ id: native.id, error: "Offline", value: null }, { id: widgets[3].id, value: "51.5" }],
    [{ id: native.id, error: null, value: 25, state: 0, updatedAt: "recovered" }],
  ]) {
    const before = JSON.stringify(changes);
    index.updateValues(changes);
    widgets = widgets.map((widget) => ({ ...widget, ...(changes.find((change) => change.id === widget.id) || {}) }));
    assert.deepEqual(index.getDevices(), buildDevices(widgets, options));
    assert.equal(JSON.stringify(changes), before);
  }
});

test("legacy cross-owner property and value references refresh their source context together", () => {
  const native = { id: "01/ES/Device/LtVal", value: 40, state: 0, unit: "%" };
  const alias = { id: "11/ES/Device/LtVal/Value", value: 41, state: 0 };
  const property = { id: "11/ES/Device/LtVal/Status", value: 0, state: 0 };
  const unrelated = reading(9, "RmTmp", 20);
  let widgets = [native, alias, property, unrelated];
  const index = createDeviceIndex(widgets);
  const untouched = index.getDevices().find((device) => device.key === owner(9));
  for (const change of [{ id: property.id, value: 3 }, { id: native.id, value: 50 }, { id: alias.id, value: 55 }]) {
    const updated = index.updateValues([change]);
    assert.equal(updated.length, 2);
    widgets = widgets.map((widget) => widget.id === change.id ? { ...widget, ...change } : widget);
    assert.deepEqual(index.getDevices(), buildDevices(widgets));
    assert.equal(index.getDevices().find((device) => device.key === owner(9)), untouched);
  }
});

test("read messages cannot change permissions, owner grouping, card visibility or display settings", () => {
  const widget = reading(1, "EffSpt", 23);
  const index = createDeviceIndex([widget]);
  index.updateValues([{ ...widget, value: 24, writable: true, visible: false, label: "Injected label", group: "Other owner", unit: "K" }]);
  assert.deepEqual(index.getDevices(), buildDevices([{ ...widget, value: 24 }]));
});
