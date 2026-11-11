const { buildDevices } = require("../../public/devices/deviceModel");
const { deriveWidgetGrouping } = require("../../public/devices/widgetGrouping");

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

function scopeError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

// Manual reads use the same local device model as the cards. Labels and search
// filters never determine membership, so identically named rooms stay separate.
function resolveManualRefreshScope(widgets, options, target, access) {
  if (!target || typeof target !== "object" || Array.isArray(target)
    || Object.keys(target).some(key => !["scope", "id"].includes(key))
    || !["device", "room", "floor"].includes(target.scope)
    || !Object.hasOwn(target, "id")
    || !(typeof target.id === "string" && target.id.trim() && target.id.length <= 4096
      || target.id === null && target.scope !== "device")) {
    throw scopeError("Odaberi uređaj, prostoriju ili kat za osvježavanje.", 400, "INVALID_REFRESH_SCOPE");
  }
  const devices = buildDevices(widgets, options);
  const roomIdentity = device => device.room?.id || device.room?.label || null;
  const candidates = access ? devices.filter(device => access.devices.has(device.key)) : devices;
  const matches = candidates.filter(device => target.scope === "device" ? device.key === target.id
    : target.scope === "room" ? roomIdentity(device) === target.id
      : device.room && (device.room.floorId || null) === target.id);
  if (!matches.length) {
    const organization = access?.settings ?? options;
    const exists = target.scope === "floor" && organization.floors?.some(floor => floor.id === target.id)
      || target.scope === "room" && organization.roomDetails?.some(room => room.id === target.id);
    throw scopeError(exists ? "U odabranom prostoru nema uređaja za osvježavanje." : "Odabrani uređaj ili prostor više nije dostupan.", exists ? 409 : 404, exists ? "EMPTY_REFRESH_SCOPE" : "REFRESH_SCOPE_NOT_FOUND");
  }
  const owners = new Set(matches.map(device => device.key));
  const ids = widgets.filter(widget => owners.has(deriveWidgetGrouping(widget.id).key)
    && (!access || access.points.has(widget.id))).map(widget => widget.id);
  if (!ids.length) throw scopeError("U odabranom prostoru nema uređaja za osvježavanje.", 409, "EMPTY_REFRESH_SCOPE");
  return { ids, deviceCount: new Set(ids.map(id => deriveWidgetGrouping(id).key)).size };
}

module.exports = { resolveRefreshScope, resolveManualRefreshScope };
