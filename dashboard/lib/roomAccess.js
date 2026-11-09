const { buildDevices } = require("../public/deviceModel");
const { deriveWidgetGrouping } = require("../public/widgetGrouping");

function createRoomIndex(widgets, options, roomNames = []) {
  const rooms = new Map(roomNames.map(id => [id, { id, name: id, floorId: null }]));
  for (const room of options.roomDetails) rooms.set(room.id, room);
  const devices = new Map();
  for (const device of buildDevices(widgets, options)) {
    const room = device.room;
    const id = room?.id || room?.label || null;
    devices.set(device.key, id);
    if (id && !rooms.has(id)) rooms.set(id, { id, name: room.label, floorId: room.floorId ?? null });
  }
  const points = new Map(widgets.filter(widget => widget.visible !== false).map(widget => [widget.id, deriveWidgetGrouping(widget.id).key]));
  return { rooms, devices, points, floors: options.floors, deviceSettings: options.deviceSettings };
}

function scopeRooms(index, roomIds) {
  const allowed = new Set(roomIds);
  const seesRoom = id => roomIds === null || allowed.has(id);
  const rooms = [...index.rooms.values()].filter(room => seesRoom(room.id));
  const devices = new Map([...index.devices].filter(([, room]) => seesRoom(room)));
  const points = new Set([...index.points].filter(([, owner]) => devices.has(owner)).map(([id]) => id));
  const floorIds = new Set(rooms.map(room => room.floorId));
  const saved = new Map(index.deviceSettings.map(device => [device.key, device]));
  const settings = [...devices].map(([key, room]) => {
    const device = saved.get(key);
    const ownPoint = id => points.has(id) && index.points.get(id) === key;
    return {
      key, room: room ?? "", label: device?.label ?? null,
      primaryUnit: device?.primaryUnit ?? null,
      primaryPointId: ownPoint(device?.primaryPointId) ? device.primaryPointId : null,
      secondaryPointIds: device?.secondaryPointIds?.filter(ownPoint) ?? null,
    };
  });
  return {
    points,
    settings: { enabled: false, devices: settings, rooms: rooms.map(room => room.id), roomRules: [],
      roomDetails: rooms, floors: index.floors.filter(floor => floorIds.has(floor.id)) },
  };
}

module.exports = { createRoomIndex, scopeRooms };
