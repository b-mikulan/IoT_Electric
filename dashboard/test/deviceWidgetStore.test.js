const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DeviceWidgetStore } = require("../lib/deviceWidgetStore");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "device-widget-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "device-widgets.json") };
}

const automatic = (key) => ({ key, label: null, room: null, primaryPointId: null, primaryUnit: null, secondaryPointIds: null });
const deviceKeys = ["ES/Room/AC309", "ES/Room/B301"];
const temperature = `01/${deviceKeys[0]}/Values/RmTmp`;
const humidity = `01/${deviceKeys[0]}/Values/RmRh`;
const co2 = `01/${deviceKeys[0]}/Values/RmCO2`;
const alias = `11/${deviceKeys[0]}/Values/RmTmp/Value`;
const otherTemperature = `01/${deviceKeys[1]}/Values/RmTmp`;
const context = { deviceKeys, pointIds: [temperature, humidity, co2, alias, otherTemperature] };

test("materializes separate device entries and preserves overrides across restart and point removals", async (t) => {
  const { directory, file } = await fixture(t);
  const rawFile = path.join(directory, "widgets.json");
  const raw = '[{"id":"temperature","writable":false,"custom":"retain"}]\n';
  await fs.writeFile(rawFile, raw);
  const store = new DeviceWidgetStore(file, { protectedFilePath: rawFile });
  assert.deepEqual(await store.synchronize(context.deviceKeys), context.deviceKeys.map(automatic));
  const saved = { key: context.deviceKeys[0], label: "Living room AC", room: "Living room", primaryPointId: otherTemperature, primaryUnit: null, secondaryPointIds: [humidity, co2, alias] };
  assert.deepEqual(await store.save(saved, context), saved);
  const restarted = new DeviceWidgetStore(file);
  assert.deepEqual(await restarted.synchronize([]), [saved, automatic(context.deviceKeys[1])]);
  assert.equal(await fs.readFile(rawFile, "utf8"), raw);
  const reset = { ...automatic(saved.key), room: "", secondaryPointIds: [] };
  await restarted.save(reset, context);
  assert.deepEqual((await new DeviceWidgetStore(file).synchronize(context.deviceKeys))[0], reset);
  assert.throws(() => new DeviceWidgetStore(rawFile, { protectedFilePath: rawFile }), /must be separate/);
});

test("retains unrelated keys and custom file fields and serializes concurrent saves", async (t) => {
  const { file } = await fixture(t);
  const unrelated = { ...automatic("old/controller/device"), custom: { note: "keep" } };
  await fs.writeFile(file, JSON.stringify({ version: 1, custom: ["preserve"], devices: [unrelated] }));
  const store = new DeviceWidgetStore(file);
  await Promise.all([
    store.save({ ...automatic(context.deviceKeys[0]), label: "AC" }, context),
    store.save({ ...automatic(context.deviceKeys[1]), room: "Bedroom" }, context),
  ]);
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(persisted.custom, ["preserve"]);
  assert.deepEqual(persisted.devices[0], unrelated);
  assert.equal(persisted.devices[1].label, "AC");
  assert.equal(persisted.devices[2].room, "Bedroom");
  const before = await fs.readFile(file, "utf8");
  await store.synchronize(context.deviceKeys);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("validates all overrides before changing the file or settings snapshot", async (t) => {
  const { file } = await fixture(t);
  const store = new DeviceWidgetStore(file);
  await store.synchronize(context.deviceKeys);
  const before = await fs.readFile(file, "utf8");
  const valid = automatic(context.deviceKeys[0]);
  for (const change of [
    { label: 1 }, { label: "x".repeat(161) }, { room: "x".repeat(161) },
    { primaryPointId: "" }, { primaryPointId: "missing-or-hidden" },
    { primaryUnit: 1 }, { primaryUnit: {} }, { primaryUnit: "x".repeat(41) },
    { secondaryPointIds: "humidity" }, { secondaryPointIds: [humidity, humidity] },
    { primaryPointId: temperature, secondaryPointIds: [temperature] },
    { secondaryPointIds: [otherTemperature] },
    { secondaryPointIds: Array.from({ length: 13 }, (_, index) => String(index)) },
    { secondaryPointIds: ["missing-or-hidden"] }, { key: "x".repeat(4_097) },
  ]) await assert.rejects(store.save({ ...valid, ...change }, context), { status: 400, code: "INVALID_DEVICE_SETTINGS" });
  await assert.rejects(store.save({ ...valid, key: "not-a-current-device" }, context), { status: 404, code: "DEVICE_NOT_FOUND" });
  await assert.rejects(store.save({ key: valid.key }, context), { status: 400 });
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual(store.devices, context.deviceKeys.map(automatic));
});

test("legacy foreign secondary references are retained on load and can be repaired without changing primary selection", async (t) => {
  const { file } = await fixture(t);
  const legacy = { ...automatic(deviceKeys[0]), primaryPointId: co2, secondaryPointIds: [humidity, otherTemperature] };
  const raw = JSON.stringify({ version: 1, devices: [legacy] });
  await fs.writeFile(file, raw);
  const store = new DeviceWidgetStore(file);
  assert.deepEqual(await store.synchronize([]), [legacy]);
  assert.equal(await fs.readFile(file, "utf8"), raw);
  const repaired = { ...legacy, secondaryPointIds: [humidity, alias] };
  assert.deepEqual(await store.save(repaired, context), repaired);
});

test("primary display units persist custom, unitless and automatic choices across restart and accept older files and clients", async (t) => {
  const { file } = await fixture(t);
  const legacy = { ...automatic(deviceKeys[0]) };
  delete legacy.primaryUnit;
  const raw = JSON.stringify({ version: 1, devices: [legacy] });
  await fs.writeFile(file, raw);
  const store = new DeviceWidgetStore(file);
  assert.deepEqual(await store.synchronize([]), [automatic(deviceKeys[0])]);
  assert.equal(await fs.readFile(file, "utf8"), raw);
  for (const [supplied, expected] of [["  °C  ", "°C"], ["", ""], ["   ", ""], ["x".repeat(40), "x".repeat(40)], [null, null]]) {
    const saved = await store.save({ ...legacy, primaryUnit: supplied }, context);
    assert.equal(saved.primaryUnit, expected);
    const restarted = new DeviceWidgetStore(file);
    assert.equal((await restarted.synchronize([]))[0].primaryUnit, expected);
  }
  await store.save({ ...legacy, primaryUnit: "%" }, context);
  const olderClientSave = await store.save(legacy, context);
  assert.equal(olderClientSave.primaryUnit, null);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).devices[0].primaryUnit, null);
});

test("retains malformed files and prior runtime settings and recovers after repair", async (t) => {
  const { file } = await fixture(t);
  const store = new DeviceWidgetStore(file);
  await store.synchronize(context.deviceKeys);
  const previous = store.devices;
  for (const raw of ["{oops", '{"version":2,"devices":[]}', '{"version":1,"devices":[{"key":"same"},{"key":"same"}]}']) {
    await fs.writeFile(file, raw);
    await assert.rejects(store.synchronize(context.deviceKeys), { code: "INVALID_DEVICE_WIDGET_FILE" });
    await assert.rejects(store.save(automatic(context.deviceKeys[0]), context), { code: "INVALID_DEVICE_WIDGET_FILE" });
    assert.equal(await fs.readFile(file, "utf8"), raw);
    assert.deepEqual(store.devices, previous);
  }
  await fs.writeFile(file, JSON.stringify({ version: 1, devices: previous }));
  await store.save({ ...previous[0], label: "Repaired" }, context);
  assert.equal(store.devices[0].label, "Repaired");
});

test("failed atomic replacement retains the original file and runtime snapshot and cleans temporary files", async (t) => {
  const { directory, file } = await fixture(t);
  let rejectRename = false;
  const store = new DeviceWidgetStore(file, { fsImpl: { ...fs, async rename(...args) {
    if (rejectRename) throw Object.assign(new Error("disk unavailable"), { code: "EACCES" });
    return fs.rename(...args);
  } } });
  await store.synchronize(context.deviceKeys);
  const before = await fs.readFile(file, "utf8");
  const previous = store.devices;
  rejectRename = true;
  await assert.rejects(store.save({ ...previous[0], label: "Unsaved" }, context), { code: "DEVICE_WIDGET_FILE_WRITE_FAILED" });
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual(store.devices, previous);
  assert.deepEqual(await fs.readdir(directory), ["device-widgets.json"]);
  rejectRename = false;
  await store.save({ ...previous[0], label: "Saved" }, context);
  assert.equal(store.devices[0].label, "Saved");
});

test("disabled persistence never writes and reports an explicit save error", async () => {
  const store = new DeviceWidgetStore("");
  assert.equal(store.enabled, false);
  assert.deepEqual(await store.synchronize(context.deviceKeys), []);
  await assert.rejects(store.save(automatic(context.deviceKeys[0]), context), { status: 409, code: "DEVICE_WIDGET_FILE_UNAVAILABLE" });
});
