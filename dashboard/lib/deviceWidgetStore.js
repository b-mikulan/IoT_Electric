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

  constructor(filePath, { fsImpl = fs, protectedFilePath = "" } = {}) {
    this.#filePath = String(filePath || "").trim();
    this.#fs = fsImpl;
    if (this.#filePath && protectedFilePath && path.resolve(this.#filePath).toLowerCase() === path.resolve(protectedFilePath).toLowerCase()) {
      throw new Error("DEVICE_WIDGETS_FILE must be separate from WIDGETS_FILE.");
    }
  }

  get enabled() { return Boolean(this.#filePath); }

  get devices() { return structuredClone(this.#devices); }

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
      this.#devices = document.devices.map((device) => normalizeSettings(device));
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
      if ((entry.secondaryPointIds || []).some((id) => deriveWidgetGrouping(id).key !== entry.key)) {
        throw invalidSettings("Secondary readings must belong to this device.");
      }
      const { document } = await this.#read();
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
      this.#devices = document.devices.map((device) => normalizeSettings(device));
      return structuredClone(entry);
    });
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
