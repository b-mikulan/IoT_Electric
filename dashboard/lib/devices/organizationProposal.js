const { createHash } = require("node:crypto");
const { buildDevices, deviceMembership } = require("../../public/devices/deviceModel");

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const roomId = device => device.room?.id || device.room?.label || null;
const nameKey = value => String(value).normalize("NFC").trim().toLocaleLowerCase("hr");
const below = (key, root) => key === root || key.startsWith(`${root}/`);
function fail(message, status = 400, code = "INVALID_ORGANIZATION_PROPOSAL") {
  throw Object.assign(new Error(message), { status, code });
}

// Pure, offline planning. Only configured visible devices are candidates; a
// catalog observation never adds polling, enables writes or proves DALI membership.
function proposeOrganization(configuration, users = [], scope = {}) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) fail("Neispravan odabir grane.");
  const root = scope.root ?? "", targetRoom = scope.roomId ?? "";
  if (typeof root !== "string" || root.length > 4096 || typeof targetRoom !== "string" || targetRoom.length > 160
    || Boolean(root) !== Boolean(targetRoom)) fail("Za odabranu granu odaberi i ciljnu prostoriju.");
  const document = configuration.deviceWidgets;
  const settings = new Map(document.devices.map(entry => [entry.key, entry]));
  const options = { ...configuration.metadata, deviceSettings: document.devices, roomRules: document.roomRules,
    floors: document.floors, roomDetails: document.roomDetails };
  const devices = buildDevices(configuration.widgets, options);
  const floorNames = new Map((document.floors || []).map(floor => [floor.id, floor.name]));
  const rooms = new Map((document.roomDetails || []).map(room => [room.id, {
    ...room, caption: [room.name, floorNames.get(room.floorId)].filter(Boolean).join(" · "),
  }]));
  for (const id of document.rooms || []) if (!rooms.has(id)) rooms.set(id, { id, name: id, floorId: null, caption: id });
  for (const device of devices) if (roomId(device) && !rooms.has(roomId(device))) {
    const id = roomId(device);
    rooms.set(id, { id, name: device.room.label, floorId: device.room.floorId || null, caption: device.room.label });
  }
  const branches = new Set();
  for (const device of devices) {
    const parts = device.key.split("/");
    for (let index = 1; index <= parts.length; index++) branches.add(parts.slice(0, index).join("/"));
  }
  if (root && (!branches.has(root) || !rooms.has(targetRoom))) fail("Grana ili prostorija više nije dostupna.");
  const parents = deviceMembership(devices, document.devices);
  const zones = new Map(devices.filter(device => device.type === "zone" && roomId(device)).map(device => [device.key, device]));
  const groupsByRoom = new Map(), listed = new Set();
  for (const device of devices) if (["zone", "lightGroup"].includes(device.type) && roomId(device)) {
    const key = JSON.stringify([device.type, roomId(device)]);
    if (!groupsByRoom.has(key)) groupsByRoom.set(key, []);
    groupsByRoom.get(key).push(device);
  }
  for (const entry of document.devices) for (const field of ["lightMembers", "sensorMembers"]) {
    for (const member of entry[field] || []) listed.add(member);
  }
  const suppressedZones = Object.entries(configuration.metadata?.roomByZone || {}).filter(([, label]) =>
    document.roomRules?.some(rule => nameKey(rule.from) === nameKey(label) && rule.to === "")).map(([path]) => path);
  const suggestions = [], unresolved = [];
  let protectedRooms = 0;
  const access = (user, room) => ({ read: user.roomIds === null || Boolean(room && user.roomIds?.includes(room)),
    write: Boolean(room && user.writeRoomIds?.includes(room)) });
  const add = suggestion => suggestions.push({ ...suggestion, id: hash(suggestion) });
  for (const device of devices) {
    const previous = roomId(device), entry = settings.get(device.key);
    let target = null, reason;
    if (typeof entry?.room === "string") protectedRooms++;
    else if (root && below(device.key, root)) {
      target = targetRoom;
      reason = `Odabrana grana: ${root}`;
    } else if (!previous && !suppressedZones.some(path => below(device.key, path))) {
      // A complete ancestor path, including server/controller, is evidence.
      // A matching short zone code elsewhere in the building is not.
      let zone;
      const parts = device.key.split("/");
      while (parts.length > 1 && !zone) { parts.pop(); zone = zones.get(parts.join("/")); }
      if (zone && typeof settings.get(zone.key)?.room === "string" && settings.get(zone.key).room) {
        target = roomId(zone);
        reason = `Uređaj pripada punoj putanji zone „${zone.label}”, kojoj je dodijeljena prostorija.`;
      }
    } else if (previous && !document.roomDetails?.some(room => room.id === previous)) {
      const matching = (document.roomDetails || []).filter(room => nameKey(room.name) === nameKey(device.room.label));
      if (matching.length === 1) {
        target = matching[0].id;
        reason = "Naziv prostorije iz kataloga odgovara jednoj registriranoj prostoriji.";
      }
    }
    if (target && target !== previous) {
      const permissions = users.flatMap(user => {
        const before = access(user, previous), after = access(user, target);
        return before.read === after.read && before.write === after.write ? [] : [{ username: user.username, before, after }];
      });
      add({ kind: "room", key: device.key, label: device.label, from: rooms.get(previous)?.caption || "Bez prostorije",
        to: rooms.get(target).caption, roomId: target, reason, review: permissions.length > 0, permissions });
    } else if (!previous && entry?.room !== "") {
      unresolved.push({ key: device.key, label: device.label, reason: "Nema pouzdane dodjele prostorije. Odaberi granu i ciljnu prostoriju ili uredi karticu." });
    }
  }
  const moving = new Set(suggestions.map(item => item.key));
  for (const device of devices) {
    const previous = roomId(device);
    if (!["light", "sensor"].includes(device.type) || parents.has(device.key) || !previous || moving.has(device.key)) continue;
    const type = device.type === "light" ? "lightGroup" : "zone";
    const field = device.type === "light" ? "lightMembers" : "sensorMembers";
    const candidates = groupsByRoom.get(JSON.stringify([type, previous])) || [];
    const parent = candidates.length === 1 ? candidates[0] : null;
    // Saved lists (including empty sensor lists) are deliberate decisions.
    if (listed.has(device.key)) continue;
    if (parent && !moving.has(parent.key) && !Array.isArray(settings.get(parent.key)?.[field])) {
      add({ kind: "members", key: device.key, label: device.label, parentKey: parent.key, field,
        from: "Samostalna kartica", to: parent.label, review: true, permissions: [],
        reason: `Jedina ${type === "zone" ? "zona" : "grupa rasvjete"} u istoj prostoriji. To nije potvrda stvarnog članstva; označi samo ako želiš ovaj prikaz.` });
    } else if (candidates.length > 1) {
      unresolved.push({ key: device.key, label: device.label, reason: "U prostoriji postoji više mogućih grupa. Članstvo odaberi u postavkama kartice." });
    }
  }
  return { token: hash([configuration, users, { root, roomId: targetRoom }]), scope: { root, roomId: targetRoom },
    source: { capturedAt: configuration.metadata?.catalog?.capturedAt || null,
      hasMetadata: Boolean(Object.keys(configuration.metadata?.metadataById || {}).length || Object.keys(configuration.metadata?.roomByZone || {}).length) },
    rooms: [...rooms.values()].sort((a, b) => a.caption.localeCompare(b.caption, "hr", { numeric: true })),
    branches: [...branches].sort(), suggestions, unresolved,
    summary: { devices: devices.length, protectedRooms, grouped: parents.size,
      roomsWithoutFloor: [...rooms.values()].filter(room => !room.floorId).length } };
}

function applyOrganizationSelection(configuration, users, { token, scope, selectedIds } = {}) {
  const proposal = proposeOrganization(configuration, users, scope);
  if (token !== proposal.token) fail("Podaci ili ovlasti promijenili su se nakon pregleda. Ponovno pripremi prijedlog.", 409, "ORGANIZATION_PREVIEW_CHANGED");
  if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 50000
    || selectedIds.some(id => typeof id !== "string") || new Set(selectedIds).size !== selectedIds.length) fail("Odaberi promjene za primjenu.");
  const available = new Map(proposal.suggestions.map(item => [item.id, item]));
  if (selectedIds.some(id => !available.has(id))) fail("Odabrana promjena nije dio prijedloga.");
  const document = structuredClone(configuration.deviceWidgets);
  const entries = new Map(document.devices.map(entry => [entry.key, entry]));
  const ensure = key => {
    if (!entries.has(key)) { const entry = { key }; entries.set(key, entry); document.devices.push(entry); }
    return entries.get(key);
  };
  for (const id of selectedIds) {
    const item = available.get(id);
    if (item.kind === "room") {
      ensure(item.key).room = item.roomId;
      if (!(document.rooms ||= []).includes(item.roomId)) document.rooms.push(item.roomId);
    } else {
      const list = ensure(item.parentKey)[item.field] ||= [];
      if (!list.includes(item.key)) list.push(item.key);
      if (list.length > 500) fail("Jedna kartica može sadržavati najviše 500 članova.");
    }
  }
  // A room move can change automatic sensor pairing. Pinning an explicit list
  // must retain every sensor already shown in that zone, even in a subset apply.
  const beforeModels = buildDevices(configuration.widgets, { ...configuration.metadata, deviceSettings: configuration.deviceWidgets.devices,
    roomRules: document.roomRules, floors: document.floors, roomDetails: document.roomDetails });
  for (const [member, parents] of deviceMembership(beforeModels, configuration.deviceWidgets.devices)) {
    for (const parent of parents) {
      const entry = entries.get(parent);
      if (Array.isArray(entry?.sensorMembers) && !entry.sensorMembers.includes(member)) {
        entry.sensorMembers.push(member);
        if (entry.sensorMembers.length > 500) fail("Jedna zona može sadržavati najviše 500 senzora.");
      }
    }
  }
  return { document, count: selectedIds.length };
}

module.exports = { proposeOrganization, applyOrganizationSelection };
