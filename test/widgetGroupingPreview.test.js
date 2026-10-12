const test = require("node:test");
const assert = require("node:assert/strict");
const { extractWidgets, buildPreview, renderPreview } = require("../tools/widget-grouping/preview");

test("offline tree preview combines register branches and excludes controller write permissions", () => {
  const owner = "AS/[BACnet Interface]/IP Network/RP/IO Resources/Modbus/AC";
  const a = { id: `01/${owner}/Points/Input Registers/RmTmp`, name: "Temperature", unit: "°C", writeable: 1 };
  const b = { id: `01/${owner}/Points/Holding Registers/EffSpt`, name: "Setpoint", unit: "°C", writeable: 1 };
  const property = { id: `11/${owner}/Status`, name: "Status" };
  const data = { records: [{ data: { containers: [{ valueItems: [a, b] }] } }, { data: { containers: [{ valueItems: [a, property] }] } }] };
  const preview = buildPreview(extractWidgets(data));
  assert.equal(preview.summary.widgets, 3);
  assert.equal(preview.summary.previousFolderGroups, 3);
  assert.equal(preview.summary.groups, 1);
  assert.equal(preview.groups[0].key, owner);
  assert.deepEqual(preview.groups[0].widgets.map((widget) => widget.id), [a.id, b.id, property.id]);
  assert.ok(preview.groups[0].widgets.every((widget) => widget.writable === false));
});

test("widget-array previews retain custom groups and visibility without changing input", () => {
  const input = [{ id: "01/AS/Zones/Z1/Light/Values/Level", group: "Moja grupa", visible: false, writable: true }];
  const before = JSON.stringify(input);
  const preview = buildPreview(extractWidgets(input));
  assert.equal(preview.groups[0].kind, "custom");
  assert.equal(preview.groups[0].label, "Moja grupa");
  assert.equal(preview.groups[0].widgets[0].visible, false);
  assert.equal(preview.groups[0].widgets[0].writable, true);
  assert.equal(JSON.stringify(input), before);
});

test("standalone preview escapes controller labels and contains no executable controls", () => {
  const html = renderPreview(buildPreview([{ id: "opaque", label: '<script>alert("x")</script>', description: "<img onerror=bad>" }]));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;img onerror=bad&gt;"));
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<form"));
  assert.throws(() => extractWidgets({}), /widget array or a saved EWS/);
});
