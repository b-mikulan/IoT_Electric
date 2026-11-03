const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { deriveWidgetGrouping } = require("../public/widgetGrouping");

const fields = ["label", "room", "primaryPointId", "secondaryPointIds"];

class DeviceWidgetStoreError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "DeviceWidgetStoreError";
    this.status = status;
    this.code = code;
  }
}

function invalidSettings(message = "Device card settings are not valid.") {
  return new DeviceWidgetStoreError(message, 400, "INVALID_DEVICE_SETTINGS");
}

function roomName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160) throw invalidSettings("A room name of 1 to 160 characters is required.");
  return value.trim().normalize("NFC");
}

const roomKey = (value) => value.normalize("NFC").toLocaleLowerCase("hr");

function registerRoom(document, name) {
  const normalized = roomName(name);
  const rooms = document.rooms ||= [];
  const known = [...rooms, ...document.devices.map((device) => device.room).filter(Boolean)]
    .find((room) => room.toLocaleLowerCase("hr") === normalized.toLocaleLowerCase("hr"));
  const canonical = known || normalized;
  if (!rooms.includes(canonical)) rooms.push(canonical);
  return canonical;
}

function normalizeSettings(value, { requireFields = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidSettings();
  const key = typeof value.key === "string" ? value.key.trim() : "";
  if (!key || key.length > 4_096) throw invalidSettings("A device key of at most 4096 characters is required.");
  if (requireFields && fields.some((field) => !Object.hasOwn(value, field))) throw invalidSettings();

  const result = { key };
  for (const field of ["label", "room", "primaryPointId"]) {
    const supplied = value[field] ?? null;
    const limit = field === "primaryPointId" ? 4_096 : 160;
    if (supplied !== null && (typeof supplied !== "string" || supplied.trim().length > limit)) throw invalidSettings();
    const normalized = supplied === null ? null : supplied.trim();
    if (field === "primaryPointId" && normalized === "") throw invalidSettings();
    result[field] = field === "label" && normalized === "" ? null : normalized;
  }
  // Optional for older files and clients. Empty means deliberately unitless;
  // null (including an omitted field) preserves automatic display units.
  const primaryUnit = value.primaryUnit ?? null;
  if (primaryUnit !== null && (typeof primaryUnit !== "string" || primaryUnit.trim().length > 40)) throw invalidSettings("The primary display unit must be at most 40 characters.");
  result.primaryUnit = primaryUnit === null ? null : primaryUnit.trim();
  const secondary = value.secondaryPointIds ?? null;
  if (secondary !== null && (!Array.isArray(secondary) || secondary.length > 12)) throw invalidSettings();
  result.secondaryPointIds = secondary === null ? null : secondary.map((id) => {
    if (typeof id !== "string" || !id.trim() || id.trim().length > 4_096) throw invalidSettings();
    return id.trim();
  });
  if (result.secondaryPointIds && (
    new Set(result.secondaryPointIds).size !== result.secondaryPointIds.length ||
    result.secondaryPointIds.includes(result.primaryPointId)
  )) throw invalidSettings("Primary and secondary readings must be distinct.");
  return result;
}

function parseDocument(raw) {
  let document;
  try {
    document = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!document || typeof document !== "object" || Array.isArray(document) || document.version !== 1 || !Array.isArray(document.devices)) throw new Error("Unsupported structure or version.");
    if (document.rooms !== undefined) {
      if (!Array.isArray(document.rooms) || document.rooms.some((room) => roomName(room) !== room)
        || new Set(document.rooms.map((room) => room.toLocaleLowerCase("hr"))).size !== document.rooms.length) throw new Error("Invalid room registry.");
    }
    if (document.roomRules !== undefined && (!Array.isArray(document.roomRules)
      || document.roomRules.some((rule) => !rule || roomName(rule.from) !== rule.from || rule.to !== "" && roomName(rule.to) !== rule.to)
      || new Set(document.roomRules.map((rule) => roomKey(rule.from))).size !== document.roomRules.length)) throw new Error("Invalid room rules.");
    const keys = new Set();
    for (const device of document.devices) {
      const { key } = normalizeSettings(device);
      if (keys.has(key)) throw new Error("Duplicate device key.");
      keys.add(key);
    }
  } catch {
    throw new DeviceWidgetStoreError("Device card configuration is invalid; the existing file was retained.", 500, "INVALID_DEVICE_WIDGET_FILE");
  }
  return document;
}

class DeviceWidgetStore {
  #filePath;
  #fs;
  #operation = Promise.resolve();
  #devices = [];
  #rooms = [];
  #roomRules = [];

  constructor(filePath, { fsImpl = fs, protectedFilePath = "" } = {}) {
    this.#filePath = String(filePath || "").trim();
    this.#fs = fsImpl;
    if (this.#filePath && protectedFilePath && path.resolve(this.#filePath).toLowerCase() === path.resolve(protectedFilePath).toLowerCase()) {
      throw new Error("DEVICE_WIDGETS_FILE must be separate from WIDGETS_FILE.");
    }
  }

  get enabled() { return Boolean(this.#filePath); }

  get devices() { return structuredClone(this.#devices); }
  get rooms() { return this.#rooms.slice(); }
  get roomRules() { return structuredClone(this.#roomRules); }

  #publish(document) {
    this.#devices = document.devices.map((device) => normalizeSettings(device));
    this.#rooms = [...(document.rooms || [])];
    this.#roomRules = structuredClone(document.roomRules || []);
  }

  synchronize(keys) {
    return this.#enqueue(async () => {
      if (!this.enabled) return [];
      const { document, missing } = await this.#read();
      const known = new Set(document.devices.map((device) => normalizeSettings(device).key));
      let changed = missing;
      for (const key of keys) {
        const entry = normalizeSettings({ key });
        if (known.has(entry.key)) continue;
        document.devices.push(entry);
        known.add(entry.key);
        changed = true;
      }
      if (changed) await this.#write(document);
      this.#publish(document);
      return this.devices;
    });
  }

  save(settings, { deviceKeys, pointIds }) {
    return this.#enqueue(async () => {
      if (!this.enabled) throw new DeviceWidgetStoreError("Device card settings require a writable DEVICE_WIDGETS_FILE or WIDGETS_FILE directory.", 409, "DEVICE_WIDGET_FILE_UNAVAILABLE");
      const entry = normalizeSettings(settings, { requireFields: true });
      if (!new Set(deviceKeys).has(entry.key)) throw new DeviceWidgetStoreError("The device is not present on the dashboard.", 404, "DEVICE_NOT_FOUND");
      const configuredPoints = new Set(pointIds);
      if ([entry.primaryPointId, ...(entry.secondaryPointIds || [])].some((id) => id !== null && !configuredPoints.has(id))) {
        throw invalidSettings("Readings must reference visible, configured dashboard points.");
      }
      if ([entry.primaryPointId, ...(entry.secondaryPointIds || [])].some((id) => id !== null && deriveWidgetGrouping(id).key !== entry.key)) {
        throw invalidSettings("All readings must belong to this device.");
      }
      const { document } = await this.#read();
      if (entry.room) entry.room = registerRoom(document, entry.room);
      const known = new Set(document.devices.map((device) => normalizeSettings(device).key));
      for (const key of deviceKeys) {
        if (!known.has(key)) {
          document.devices.push(normalizeSettings({ key }));
          known.add(key);
        }
      }
      const index = document.devices.findIndex((device) => normalizeSettings(device).key === entry.key);
      if (index < 0) document.devices.push(entry);
      else document.devices[index] = { ...document.devices[index], ...entry };
      await this.#write(document);
      this.#publish(document);
      return structuredClone(entry);
    });
  }

  createRoom(name) {
    return this.#enqueue(async () => {
      this.#assertEnabled();
      const normalized = roomName(name);
      const { document } = await this.#read();
      if ((document.rooms || []).some((room) => room.toLocaleLowerCase("hr") === normalized.toLocaleLowerCase("hr"))) {
        throw new DeviceWidgetStoreError("A room with this name already exists.", 409, "ROOM_ALREADY_EXISTS");
      }
      const room = registerRoom(document, normalized);
      await this.#write(document);
      this.#publish(document);
      return room;
    });
  }

  assignRoom(keys, room, { deviceKeys }) {
    return this.#enqueue(async () => {
      this.#assertEnabled();
      if (!Array.isArray(keys) || keys.length < 1 || keys.length > 1000 || keys.some((key) => typeof key !== "string" || !key.trim() || key.length > 4096)
        || new Set(keys).size !== keys.length) throw invalidSettings("Select 1 to 1000 distinct devices.");
      if (room !== null && room !== "") roomName(room);
      const current = new Set(deviceKeys);
      if (keys.some((key) => !current.has(key))) throw new DeviceWidgetStoreError("A selected device is no longer present on the dashboard.", 404, "DEVICE_NOT_FOUND");
      const { document } = await this.#read();
      const target = room ? registerRoom(document, room) : room;
      const entries = new Map(document.devices.map((device) => [normalizeSettings(device).key, device]));
      for (const key of keys) {
        if (!entries.has(key)) {
          const entry = normalizeSettings({ key });
          document.devices.push(entry);
          entries.set(key, entry);
        }
        entries.get(key).room = target;
      }
      await this.#write(document);
      this.#publish(document);
      return { moved: keys.length, room: target };
    });
  }

  renameRoom(name, newName, context = {}) {
    return this.#changeRoom(name, newName, context);
  }

  deleteRoom(name, context = {}) {
    return this.#changeRoom(name, "", context, true);
  }

  #changeRoom(name, target, { roomNames = [] }, deleting = false) {
    return this.#enqueue(async () => {
      this.#assertEnabled();
      const requested = roomName(name);
      if (!deleting) target = roomName(target);
      const { document } = await this.#read();
      const rules = document.roomRules ||= [];
      const ruleMap = new Map(rules.map((rule) => [roomKey(rule.from), rule.to]));
      const automaticRooms = roomNames.map((room) => ruleMap.has(roomKey(room)) ? ruleMap.get(roomKey(room)) : room);
      const available = [...(document.rooms || []), ...document.devices.map((device) => device.room), ...automaticRooms].filter(Boolean);
      const previousName = available.find((room) => roomKey(room) === roomKey(requested));
      if (!previousName) throw new DeviceWidgetStoreError("Prostorija više ne postoji. Osvježi popis prostorija.", 404, "ROOM_NOT_FOUND");
      const previousKey = roomKey(previousName);
      if (target && roomKey(target) !== previousKey && available.some((room) => roomKey(room) === roomKey(target))) {
        throw new DeviceWidgetStoreError("Prostorija s tim nazivom već postoji.", 409, "ROOM_ALREADY_EXISTS");
      }
      // Preserve every other card preference, including settings for devices
      // temporarily absent from the dashboard.
      for (const device of document.devices) if (device.room && roomKey(device.room) === previousKey) device.room = target;
      document.rooms = (document.rooms || []).filter((room) => roomKey(room) !== previousKey);
      for (const rule of rules) if (rule.to && roomKey(rule.to) === previousKey) rule.to = target;
      const sourceRule = rules.find((rule) => roomKey(rule.from) === previousKey);
      if (sourceRule) sourceRule.to = target;
      else rules.push({ from: previousName, to: target });
      if (target) registerRoom(document, target);
      await this.#write(document);
      this.#publish(document);
      return { previousName, room: target };
    });
  }

  #assertEnabled() {
    if (!this.enabled) throw new DeviceWidgetStoreError("Room settings require a writable device configuration file.", 409, "DEVICE_WIDGET_FILE_UNAVAILABLE");
  }

  #enqueue(operation) {
    const result = this.#operation.then(operation);
    this.#operation = result.catch(() => {});
    return result;
  }

  async #read() {
    let raw;
    try {
      raw = await this.#fs.readFile(this.#filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { document: { version: 1, devices: [] }, missing: true };
      throw new DeviceWidgetStoreError("Unable to read device card configuration.", 500, "DEVICE_WIDGET_FILE_READ_FAILED");
    }
    return { document: parseDocument(raw), missing: false };
  }

  async #write(document) {
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.#fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await this.#fs.rename(temporaryPath, this.#filePath);
    } catch {
      throw new DeviceWidgetStoreError("Unable to save device card configuration; previous settings were retained.", 500, "DEVICE_WIDGET_FILE_WRITE_FAILED");
    } finally {
      await this.#fs.unlink(temporaryPath).catch(() => {});
    }
  }
}

module.exports = { DeviceWidgetStore, DeviceWidgetStoreError };
