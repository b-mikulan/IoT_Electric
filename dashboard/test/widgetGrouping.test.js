const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { deriveWidgetGrouping, deriveWidgetGroup, widgetGroup, describeWidgetGroup } = require("../public/widgetGrouping");
const { parseWidgets } = require("../lib/config");

const rp = (controller) => `AS/[BACnet Interface]/IP Network/${controller}`;
const light = `${rp("RP32")}/Application/Zones/Z312/L3307`;
const blind = `${rp("RP31")}/Application/Items/B301`;
const ac = `${rp("RP31")}/IO Resources/Modbus/AC309`;

test("combines a device's point folders and property references without changing point IDs", () => {
  const ids = [`01/${light}/Values/LtPct`, `01/${light}/Points/DevSta`, `11/${light}/Values/LtPct/Value`, `11/${light}/Alarms/DevSta/EventState`, `11/${light}/Logs/Trend Logs/LtVal/TotalRecordCount`];
  const widgets = parseWidgets(JSON.stringify(ids.map((id) => ({ id }))), false);
  assert.deepEqual(widgets.map((w) => w.group), ids.map(() => light));
  assert.deepEqual(widgets.map((w) => w.id), ids);
  assert.ok(widgets.every((w) => w.writable === false && w.visible === true));
  assert.deepEqual(deriveWidgetGrouping(ids[0]), { key: light, label: "L3307", context: "AS · RP32 · Z312", kind: "device" });
  assert.equal(deriveWidgetGroup(`01/${blind}/Points/BlndBtnUp`), deriveWidgetGroup(`01/${blind}/Values/BlndPos`));
});

test("combines Modbus register subfolders, device properties and diagnostics", () => {
  const ids = [`01/${ac}/Points/Input Registers/RmTmp`, `01/${ac}/Points/Holding Registers/EffSpt`, `01/${ac}/Points/Coils/FilAlm`, `01/${ac}/Values/ScrnCol`, `11/${ac}/DeviceVendorName`, `11/${ac}/Status`, `11/${ac}/Logs/Trend Logs/RmTmp/TotalRecordCount`];
  assert.deepEqual(ids.map(deriveWidgetGroup), ids.map(() => ac));
  assert.equal(deriveWidgetGrouping(ids[0]).kind, "device");
});

test("keeps equal device names on different controllers and external bindings separate", () => {
  const first = `01/${rp("RP31")}/Application/Zones/Z312/S3201/Values/OccSts`;
  const second = `01/${rp("RP32")}/Application/Zones/Z312/S3201/External Bindings/OccSts`;
  const a = deriveWidgetGrouping(first), b = deriveWidgetGrouping(second);
  assert.notEqual(a.key, b.key);
  assert.equal(a.label, b.label);
  assert.notEqual(a.context, b.context);
});

test("keeps zone summary points together without calling them a physical device", () => {
  const zone = "AS/Zones/Z312";
  assert.deepEqual(deriveWidgetGrouping(`01/${zone}/Values/LtLvl`), { key: zone, label: "Zona Z312", context: "AS · Z312", kind: "zone" });
  assert.notEqual(deriveWidgetGroup(`01/${zone}/Values/LtLvl`), deriveWidgetGroup(`01/${light}/Values/LtPct`));
});

test("preserves custom group overrides and the old fallback for unknown identifiers", () => {
  const widget = { id: `01/${light}/Values/LtPct`, group: "  Moja rasvjeta  " };
  assert.equal(widgetGroup(widget), "Moja rasvjeta");
  assert.deepEqual(describeWidgetGroup(widget), { key: "Moja rasvjeta", label: "Moja rasvjeta", context: "", kind: "custom" });
  assert.equal(widgetGroup({ ...widget, group: " " }), light);
  const generic = ["01/ES/Office/Temperature", "01/ES/Power", "opaque", "demo-room-temperature", "40https://brickschema.org/schema/Brick#Class", "01/ES//Values/Bad"];
  assert.deepEqual(generic.map(deriveWidgetGroup), ["01/ES/Office", "01/ES", "PLC vrijednosti", "PLC vrijednosti", "40https://brickschema.org/schema", "01/ES//Values"]);
});

test("the browser uses the same grouping rules as the server", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../public/widgetGrouping"), "utf8"), context);
  const id = `11/${ac}/Points/Input Registers/RmTmp/Reliability`;
  assert.equal(context.IoTWidgetGrouping.deriveWidgetGroup(id), deriveWidgetGroup(id));
  assert.equal(context.IoTWidgetGrouping.widgetGroup({ id, group: "Custom" }), "Custom");
});
