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
});
