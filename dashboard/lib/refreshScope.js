const { buildDevices } = require("../public/deviceModel");
const { deriveWidgetGrouping } = require("../public/widgetGrouping");

// Resolve against saved room identities, including manual moves and room rules.
// This uses local metadata only; a command never starts a topology traversal.
function resolveRefreshScope(widgets, options, pointId, scope = "room") {
  const owner = deriveWidgetGrouping(pointId).key;
  const owners = new Set([owner]);
  if (scope === "room") {
    const devices = buildDevices(widgets, options);
    const roomId = device => device.room?.id || device.room?.label || null;
    const room = roomId(devices.find(device => device.key === owner) || {});
    if (room) for (const device of devices) if (roomId(device) === room) owners.add(device.key);
  }
  return widgets.filter(widget => owners.has(deriveWidgetGrouping(widget.id).key)).map(widget => widget.id);
}

module.exports = { resolveRefreshScope };
