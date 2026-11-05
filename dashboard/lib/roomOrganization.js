const { randomUUID } = require("node:crypto");

const key = value => value.normalize("NFC").toLocaleLowerCase("hr");
function name(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160 || /[\0\r\n]/.test(value)) throw new Error("Naziv mora imati između 1 i 160 znakova.");
  return value.trim().normalize("NFC");
}
function identifier(value) {
  const result = name(value);
  if (["all", "unknown", "unassigned"].includes(result)) throw new Error("Neispravna oznaka grupe.");
  return result;
}
function validateOrganization(document) {
  if (document.organizationVersion === undefined && document.floors === undefined && document.roomDetails === undefined) return;
  if (document.organizationVersion !== 1 || !Array.isArray(document.floors) || !Array.isArray(document.roomDetails)
    || document.floors.length > 1000 || document.roomDetails.length > 50_000) throw new Error("Neispravna organizacija prostorija.");
  const ids = new Set(), names = new Set();
  for (const floor of document.floors) {
    if (!floor || identifier(floor.id) !== floor.id || name(floor.name) !== floor.name || ids.has(floor.id) || names.has(key(floor.name))) throw new Error("Katovi moraju imati različite oznake i nazive.");
    ids.add(floor.id); names.add(key(floor.name));
  }
  const roomIds = new Set();
  for (const room of document.roomDetails) {
    if (!room || name(room.id) !== room.id || name(room.name) !== room.name
      || room.floorId !== null && !ids.has(room.floorId)) throw new Error("Prostorija mora koristiti postojeći kat ili grupu.");
    if (roomIds.has(room.id)) throw new Error("Prostorije moraju imati različite oznake.");
    roomIds.add(room.id);
  }
}

// Only old documents are interpreted by name. Once organizationVersion is
// present, floor membership always comes from floorId, including on imports.
function legacyFloor(room) {
  const parts = room.split(/\s*·\s*/);
  const matches = parts.map((part, index) => {
    const match = /^(?:(-?\d+)\.\s*kat|etaža\s+(-?\d+))$/i.exec(part);
    return match ? { index, value: Number(match[1] ?? match[2]) } : null;
  }).filter(Boolean);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].value)) return null;
  const floor = matches[0].value;
  const roomName = parts.filter((_, index) => index !== matches[0].index).join(" · ").trim();
  return roomName ? { id: `floor:${floor}`, name: floor > 0 ? `${floor}. kat` : `Etaža ${floor}`, roomName, order: floor } : null;
}
function migrateOrganization(document, roomNames = [], { force = false } = {}) {
  validateOrganization(document);
  const rules = new Map((document.roomRules || []).map(rule => [key(rule.from), rule.to]));
  const known = [...new Set([...(document.rooms || []), ...document.devices.map(d => d.room),
    ...roomNames.map(room => rules.has(key(room)) ? rules.get(key(room)) : room)].filter(Boolean))];
  const structured = document.organizationVersion === 1;
  if (!structured && !force && !known.some(legacyFloor)) return false;
  let changed = !structured;
  if (!structured) {
    document.organizationVersion = 1; document.floors = []; document.roomDetails = [];
  }
  for (const id of known) {
    if (document.roomDetails.some(room => room.id === id)) continue;
    const legacy = structured ? null : legacyFloor(id);
    if (legacy && !document.floors.some(floor => floor.id === legacy.id)) document.floors.push({ id: legacy.id, name: legacy.name });
    document.roomDetails.push({ id, name: legacy?.roomName || id, floorId: legacy?.id || null });
    changed = true;
  }
  if (!structured) document.floors.sort((a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6)));
  validateOrganization(document);
  return changed;
}
function checkFloor(document, floorId) {
  if (floorId !== null && !document.floors.some(floor => floor.id === floorId)) throw new Error("Odabrani kat ili grupa više ne postoji.");
}
function checkRoomName(document, roomName, floorId, exceptId) {
  const normalized = name(roomName);
  if (document.roomDetails.some(room => room.id !== exceptId && room.floorId === floorId && key(room.name) === key(normalized))) throw new Error("Prostorija s tim nazivom već postoji u odabranoj grupi.");
  return normalized;
}
function addRoom(document, roomName, floorId) {
  checkFloor(document, floorId);
  const normalized = checkRoomName(document, roomName, floorId);
  const room = { id: `room-${randomUUID()}`, name: normalized, floorId };
  document.roomDetails.push(room);
  (document.rooms ||= []).push(room.id);
  return room;
}

module.exports = { validateOrganization, migrateOrganization, checkFloor, checkRoomName, addRoom, organizationName: name, organizationKey: key };
