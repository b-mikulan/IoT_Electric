const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { WidgetStore } = require("../lib/widgetStore");

test("appends a validated widget without changing existing entries", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "widget-store-"));
  const filePath = path.join(directory, "widgets.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await fs.writeFile(
    filePath,
    `${JSON.stringify([{ id: "existing", label: "Existing", custom: true }], null, 2)}\n`
  );
  const store = new WidgetStore(filePath);

  const added = await store.add({
    id: "building/temperature",
    label: "Temperature",
    description: "Office",
    unit: "°C",
    writable: true,
  });
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));

  assert.equal(store.enabled, true);
  assert.deepEqual(added, {
    id: "building/temperature",
    label: "Temperature",
    description: "Office",
    unit: "°C",
  });
  assert.equal(persisted[0].custom, true);
  assert.deepEqual(persisted[1], added);

  const visibility = await store.setVisibility("existing", false);
  const visibilityPersisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(visibility, { id: "existing", visible: false });
  assert.equal(visibilityPersisted[0].visible, false);
  assert.equal(visibilityPersisted[0].custom, true);
  assert.deepEqual(visibilityPersisted[1], added);

  const updated = await store.updateSettings("existing", {
    label: "Renamed",
    description: "Updated description",
    unit: "kW",
    precision: 2,
    writable: true,
    visible: true,
  });
  const settingsPersisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(updated, {
    id: "existing",
    label: "Renamed",
    description: "Updated description",
    unit: "kW",
    precision: 2,
    writable: true,
    visible: true,
    group: "PLC vrijednosti",
  });
  assert.equal(settingsPersisted[0].custom, true);
  assert.equal(settingsPersisted[0].label, "Renamed");
  assert.equal(settingsPersisted[0].precision, 2);

  await assert.rejects(store.add(added), {
    name: "WidgetStoreError",
    code: "WIDGET_ALREADY_EXISTS",
  });
  await assert.rejects(store.setVisibility("missing", true), {
    name: "WidgetStoreError",
    code: "WIDGET_NOT_FOUND",
  });
});

test("refuses persistence without WIDGETS_FILE", async () => {
  const store = new WidgetStore("");

  assert.equal(store.enabled, false);
  await assert.rejects(store.add({ id: "new" }), {
    name: "WidgetStoreError",
    code: "WIDGET_FILE_UNAVAILABLE",
  });
  await assert.rejects(store.setVisibility("new", false), {
    name: "WidgetStoreError",
    code: "WIDGET_FILE_UNAVAILABLE",
  });
  await assert.rejects(store.updateSettings("new", {}), {
    name: "WidgetStoreError",
    code: "WIDGET_FILE_UNAVAILABLE",
  });
  await assert.rejects(store.remove("new"), { code: "WIDGET_FILE_UNAVAILABLE" });
  await assert.rejects(store.clear(), { code: "WIDGET_FILE_UNAVAILABLE" });
  await assert.rejects(store.removeMany(["new"]), { code: "WIDGET_FILE_UNAVAILABLE" });
});

test("serializes deletion with additions and preserves other widgets, including custom fields", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "widget-delete-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "widgets.json");
  const kept = { id: "keep", custom: { note: "preserve" }, writable: true, visible: false };
  await fs.writeFile(filePath, JSON.stringify([{ id: "delete" }, kept]));
  const store = new WidgetStore(filePath);
  await Promise.all([store.remove("delete"), store.add({ id: "new" })]);
  const widgets = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(widgets[0], kept);
  assert.equal(widgets[1].id, "new");
  await assert.rejects(store.remove("delete"), { status: 404, code: "WIDGET_NOT_FOUND" });
  await store.remove("keep");
  await store.remove("new");
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), []);
  await store.add({ id: "delete" });
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8"))[0].id, "delete");
});

test("bulk discovery saving preserves settings, skips duplicate IDs and validates before changing the file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "widget-bulk-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "widgets.json");
  const existing = { id: "keep", label: "Custom", writable: true, visible: false, precision: 2, custom: true };
  await fs.writeFile(filePath, JSON.stringify([existing]));
  const store = new WidgetStore(filePath);
  const additions = await store.addMany([{ id: "keep", label: "Replace?" }, { id: "new", unit: "°C", writable: true }, { id: "new" }]);
  assert.equal(additions.length, 1);
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(persisted[0], existing);
  assert.equal(persisted[1].writable, undefined);
  const before = await fs.readFile(filePath, "utf8");
  await assert.rejects(store.addMany([{ id: "valid" }, { id: "" }]), { code: "WIDGET_FILE_WRITE_FAILED" });
  assert.equal(await fs.readFile(filePath, "utf8"), before);
  assert.deepEqual(await store.addMany([{ id: "new" }]), []);
});

test("clears saved widgets in order with other changes and supports adding after an empty dashboard", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "widget-clear-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "widgets.json");
  await fs.writeFile(filePath, JSON.stringify([{ id: "initial" }]));
  const store = new WidgetStore(filePath);
  const operations = await Promise.all([
    store.add({ id: "before-clear" }),
    store.clear(),
    store.add({ id: "after-clear", group: "Custom" }),
  ]);
  assert.deepEqual(operations[1], { ids: ["initial", "before-clear"] });
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")).map((widget) => widget.id), ["after-clear"]);
  await store.clear();
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), []);
  assert.deepEqual(await store.clear(), { ids: [] });
});

test("persists groups across additions and old settings clients, and resets empty groups to the parent folder", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "widget-groups-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "widgets.json");
  await fs.writeFile(filePath, "[]");
  const store = new WidgetStore(filePath);
  await store.add({ id: "floor/temperature", group: "Ured" });
  await store.addMany([{ id: "floor/humidity", group: "Ured" }]);
  const settings = { label: "Renamed", description: "Office", unit: "°C", precision: 1, writable: false, visible: true };
  assert.equal((await store.updateSettings("floor/temperature", settings)).group, "Ured");
  assert.equal((await store.updateSettings("floor/temperature", { ...settings, group: "  Prizemlje  " })).group, "Prizemlje");
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8"))[0].group, "Prizemlje");
  assert.equal((await store.updateSettings("floor/temperature", { ...settings, group: " " })).group, "floor");
  const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(Object.hasOwn(saved[0], "group"), false);
  assert.equal(saved[1].group, "Ured");
});

test("bulk selection removal is serialized with additions and retains every raw field of other widgets", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "widget-remove-many-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "widgets.json");
  const kept = { id: "other/temperature", label: "Temperature", group: "Other", custom: { note: "preserve" }, visible: false, writable: true, precision: 4 };
  await fs.writeFile(filePath, JSON.stringify([{ id: "floor/temperature", label: "Temperature", group: "Floor" }, kept]));
  const store = new WidgetStore(filePath);
  const results = await Promise.all([
    store.add({ id: "floor/humidity", group: "Floor" }),
    store.removeMany(["floor/temperature", "floor/humidity"]),
    store.add({ id: "new/value", group: "New" }),
  ]);
  assert.deepEqual(results[1], { ids: ["floor/temperature", "floor/humidity"] });
  const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(saved[0], kept);
  assert.equal(saved[1].id, "new/value");
});
