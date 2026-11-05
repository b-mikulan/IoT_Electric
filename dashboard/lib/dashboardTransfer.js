const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { parseWidgets } = require("./config");
const { parseDeviceDocument, normalizeSettings } = require("./deviceWidgetStore");
const { buildDevices } = require("../public/deviceModel");
const { deriveWidgetGrouping } = require("../public/widgetGrouping");
const { migrateOrganization } = require("./roomOrganization");
const { validateSettings, settingsFromConfig, settingsFile } = require("./dashboardSettings");
const { normalizeHistoryItems } = require("./historyCatalog");

const FORMAT = "iot-electric-dashboard";
const MAX_POINTS = 50_000;
const MAX_BYTES = 16 * 1024 * 1024;
const journalName = ".dashboard-transfer.json";
const names = ["widgets.json", "device-widgets.json", "catalog-metadata.json", "dashboard-settings.json"];
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const digest = value => createHash("sha256").update(value).digest("hex");
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const exists = file => fs.existsSync(file);

class TransferError extends Error {
  constructor(message, status = 400, code = "INVALID_DASHBOARD_IMPORT") {
    super(message); this.status = status; this.code = code;
  }
}
const invalid = message => { throw new TransferError(message); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function text(value, maximum, label, empty = true) {
  if (typeof value !== "string" || value.length > maximum || /[\0\r\n]/.test(value) || !empty && !value.trim()) invalid(`Neispravno polje: ${label}.`);
  return value;
}
function targets(config) {
  if (!config.widgetsFile) return null;
  const root = path.dirname(path.resolve(config.widgetsFile));
  const files = [path.resolve(config.widgetsFile), path.resolve(config.deviceWidgetsFile || path.join(root, names[1])), path.resolve(config.deviceMetadataFile || path.join(root, names[2])), path.resolve(settingsFile(config))];
  if (new Set(files.map(file => file.toLowerCase())).size !== files.length) throw new TransferError("Datoteke pointova, kartica, opisa i općih postavki moraju biti odvojene.", 409, "TRANSFER_UNAVAILABLE");
  return { root, files, journal: path.join(root, journalName) };
}
function atomicWrite(file, data, fsImpl = fs) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fsImpl.writeFileSync(temporary, data, { flag: "wx", flush: true });
    fsImpl.renameSync(temporary, file);
  } finally { if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary); }
}

// Called before loadConfig, so a first deployment needs no manually seeded JSON.
// An interrupted multi-file import is restored before any runtime reads it.
function initializeTransferFiles(env) {
  if (!env.WIDGETS_FILE || String(env.WIDGETS_JSON || "").trim()) return;
  const location = targets({ widgetsFile: env.WIDGETS_FILE, deviceWidgetsFile: env.DEVICE_WIDGETS_FILE, deviceMetadataFile: env.DEVICE_METADATA_FILE });
  if (exists(location.journal)) {
    const record = readJson(location.journal);
    if (!/^[\dTZ.-]+-[a-f0-9-]{36}$/.test(record.id) || !Array.isArray(record.existed) || ![3, 4].includes(record.existed.length)) throw new Error("Invalid dashboard transfer recovery journal.");
    const backup = path.join(location.root, "transfer-backups", record.id);
    if (record.phase !== "committed") {
      for (let i = 0; i < record.existed.length; i++) {
        if (record.existed[i]) atomicWrite(location.files[i], fs.readFileSync(path.join(backup, names[i])));
        else if (exists(location.files[i])) fs.unlinkSync(location.files[i]);
      }
    }
    for (const file of location.files) {
      const stage = `${file}.${record.id}.import`;
      if (exists(stage)) fs.unlinkSync(stage);
    }
    fs.unlinkSync(location.journal);
  }
  if (!exists(location.files[0])) {
    fs.mkdirSync(location.root, { recursive: true });
    fs.writeFileSync(location.files[0], "[]\n", { flag: "wx" });
  }
}

function normalizeWidgets(values) {
  if (!Array.isArray(values) || values.length > MAX_POINTS) invalid(`Datoteka mora sadržavati najviše ${MAX_POINTS} pointova.`);
  for (const point of values) {
    if (!object(point)) invalid("Svaki point mora biti objekt.");
    text(point.id, 4096, "ID pointa", false);
    for (const [field, max] of [["label", 500], ["description", 2000], ["unit", 40], ["group", 1024]]) if (point[field] !== undefined) text(point[field], max, field);
  }
  try { return parseWidgets(JSON.stringify(values), false); }
  catch { return invalid("Pointovi sadrže neispravne postavke ili ponovljene ID-jeve."); }
}

function normalizeDevices(document, widgets) {
  if (!object(document) || !Array.isArray(document.devices) || document.devices.length > MAX_POINTS) invalid("Nedostaju valjane postavke kartica.");
  let parsed;
  try { parsed = parseDeviceDocument(JSON.stringify(document)); }
  catch { return invalid("Postavke kartica ili prostorija nisu valjane."); }
  const owners = new Set(widgets.map(w => deriveWidgetGrouping(w.id).key));
  const devices = parsed.devices.map(device => normalizeSettings(device)).filter(device => owners.has(device.key));
  for (const device of devices) for (const id of [device.primaryPointId, ...(device.secondaryPointIds || [])].filter(Boolean)) {
    // Retain a missing own reading as unavailable, just like the settings UI.
    if (deriveWidgetGrouping(id).key !== device.key) invalid("Odabrano očitanje mora pripadati istom uređaju.");
    text(id, 4096, "ID očitanja", false);
  }
  return { version: 1, devices, rooms: parsed.rooms || [], roomRules: parsed.roomRules || [],
    ...(parsed.organizationVersion === 1 ? { organizationVersion: 1, floors: parsed.floors, roomDetails: parsed.roomDetails } : {}) };
}

function normalizeMetadata(document, widgets) {
  if (document === null) return null;
  if (!object(document) || document.schemaVersion !== 1 || !object(document.metadataById) || !object(document.roomByZone)) invalid("Opisi uređaja nisu valjani.");
  const metadataById = Object.create(null), roomByZone = Object.create(null);
  for (const { id } of widgets) {
    if (!Object.hasOwn(document.metadataById, id)) continue;
    const source = document.metadataById[id];
    if (!object(source) || source.id !== id) invalid("Opis pointa ne odgovara njegovu ID-ju.");
    const entry = { id };
    for (const [field, max] of [["name", 500], ["description", 4000], ["type", 120], ["unit", 40], ["enumId", 4096]]) {
      if (source[field] !== undefined) entry[field] = text(source[field], max, field);
    }
    for (const field of ["writeable", "forceable"]) if (source[field] !== undefined) {
      if (typeof source[field] !== "boolean") invalid("Dopuštenja u opisu pointa moraju biti logičke vrijednosti.");
      entry[field] = source[field];
    }
    for (const field of ["min", "max", "step"]) if (source[field] !== undefined) {
      if (!Number.isFinite(source[field])) invalid("Neispravan raspon pointa.");
      entry[field] = source[field];
    }
    if (source.enumValues !== undefined) {
      if (!Array.isArray(source.enumValues) || source.enumValues.length > 1000) invalid("Previše opcija pointa.");
      entry.enumValues = source.enumValues.map(option => {
        if (!object(option) || !["string", "number", "boolean"].includes(typeof option.value) || typeof option.value === "number" && !Number.isFinite(option.value)) invalid("Neispravna opcija pointa.");
        return { value: typeof option.value === "string" ? text(option.value, 500, "opcija") : option.value, label: text(option.label, 500, "naziv opcije") };
      });
    }
    metadataById[id] = entry;
  }
  if (Object.keys(document.roomByZone).length > MAX_POINTS) invalid("Previše prostorija u opisima.");
  for (const [zone, room] of Object.entries(document.roomByZone)) {
    text(zone, 4096, "putanja zone", false); roomByZone[zone] = text(room, 160, "naziv prostorije", false);
  }
  const result = { schemaVersion: 1, metadataById, roomByZone };
  if (document.historyItems !== undefined) {
    try { result.historyItems = normalizeHistoryItems(document.historyItems); }
    catch { invalid("Popis trendova u opisima nije valjan."); }
  }
  if (object(document.historyCatalog)) {
    result.historyCatalog = {};
    for (const field of ["buildingKey", "capturedAt"]) if (typeof document.historyCatalog[field] === "string") result.historyCatalog[field] = text(document.historyCatalog[field], 500, field);
    if (Number.isSafeInteger(document.historyCatalog.snapshotId)) result.historyCatalog.snapshotId = document.historyCatalog.snapshotId;
  }
  if (object(document.catalog)) {
    result.catalog = {};
    for (const field of ["buildingKey", "capturedAt"]) if (typeof document.catalog[field] === "string") result.catalog[field] = text(document.catalog[field], 500, field);
    if (Number.isSafeInteger(document.catalog.snapshotId)) result.catalog.snapshotId = document.catalog.snapshotId;
  }
  return result;
}

class DashboardTransfer {
  constructor(config, { fsImpl = fs } = {}) { this.config = config; this.location = targets(config); this.fs = fsImpl; }
  get enabled() { return !this.config.demoMode && Boolean(this.location); }
  fingerprint() {
    return digest(JSON.stringify(this.location?.files.map(file => this.fs.existsSync(file) ? digest(this.fs.readFileSync(file)) : null) || []));
  }
  current() {
    if (!this.location) return { widgets: this.config.widgets, deviceWidgets: { version: 1, devices: [] }, metadata: null, dashboardSettings: settingsFromConfig(this.config) };
    const [widgetsFile, devicesFile, metadataFile, settingsPath] = this.location.files;
    return { widgets: normalizeWidgets(readJson(widgetsFile)), deviceWidgets: exists(devicesFile) ? readJson(devicesFile) : { version: 1, devices: [] }, metadata: exists(metadataFile) ? readJson(metadataFile) : null,
      dashboardSettings: exists(settingsPath) ? readJson(settingsPath).settings : settingsFromConfig(this.config) };
  }
  prepare(document) {
    if (Buffer.byteLength(JSON.stringify(document) || "") > MAX_BYTES) invalid("Datoteka je prevelika (najviše 16 MB).");
    const legacy = Array.isArray(document), current = this.current();
    if (!legacy && (!object(document) || document.format !== FORMAT || ![1, 2].includes(document.version) || !Object.hasOwn(document, "metadata"))) invalid("Odaberi dashboard-backup.json ili izvorni widgets.json.");
    const widgets = normalizeWidgets(legacy ? document : document.widgets);
    const metadata = normalizeMetadata(legacy ? current.metadata : document.metadata, widgets);
    const suppliedSettings = structuredClone(legacy ? current.deviceWidgets : document.deviceWidgets);
    try { migrateOrganization(suppliedSettings, Object.values(metadata?.roomByZone || {})); }
    catch { invalid("Katovi ili prostorije nisu valjani."); }
    const deviceWidgets = normalizeDevices(suppliedSettings, widgets);
    let dashboardSettings;
    try { dashboardSettings = validateSettings(!legacy && Object.hasOwn(document, "dashboardSettings") ? document.dashboardSettings : current.dashboardSettings); }
    catch { invalid("Opće postavke dashboarda nisu valjane."); }
    const payload = { widgets, deviceWidgets, metadata, dashboardSettings };
    const models = buildDevices(widgets, { ...(metadata || {}), deviceSettings: deviceWidgets.devices, roomRules: deviceWidgets.roomRules, floors: deviceWidgets.floors, roomDetails: deviceWidgets.roomDetails });
    const currentIds = new Set(current.widgets.map(w => w.id)), ids = new Set(widgets.map(w => w.id));
    const roomNames = new Set([...deviceWidgets.rooms, ...(deviceWidgets.roomDetails || []).map(room => room.id), ...models.map(d => d.room?.id || d.room?.label).filter(Boolean)]);
    const warnings = [];
    if (legacy) warnings.push("widgets.json prenosi samo pointove. Zadržavaju se postojeće postavke kartica i dostupni opisi; za cijeli prikaz koristi dashboard-backup.json.");
    const missingMetadata = widgets.length - Object.keys(metadata?.metadataById || {}).length;
    if (missingMetadata) warnings.push(`Za ${missingMetadata} pointova nisu preneseni opisi uređaja.`);
    const summary = { points: widgets.length, devices: models.length, rooms: roomNames.size, writablePoints: widgets.filter(w => w.writable).length,
      added: widgets.filter(w => !currentIds.has(w.id)).length, removed: current.widgets.filter(w => !ids.has(w.id)).length, metadataPoints: widgets.length - missingMetadata, legacy, warnings };
    if (deviceWidgets.organizationVersion === 1) summary.floors = deviceWidgets.floors.length;
    return { payload, summary, token: digest(JSON.stringify(payload) + this.fingerprint()) };
  }
  export() {
    const current = this.current();
    const normalized = this.prepare({ format: FORMAT, version: 1, ...current }).payload;
    return { format: FORMAT, version: 2, exportedAt: new Date().toISOString(), ...normalized };
  }
  apply(document, token) {
    if (!this.enabled) throw new TransferError("Za uvoz uključi stvarni način rada i trajnu datoteku WIDGETS_FILE.", 409, "TRANSFER_UNAVAILABLE");
    const prepared = this.prepare(document);
    if (typeof token !== "string" || token !== prepared.token) throw new TransferError("Postavke ili datoteka promijenile su se nakon pregleda. Ponovno pregledaj uvoz.", 409, "TRANSFER_PREVIEW_CHANGED");
    const { root, files, journal } = this.location;
    const id = `${new Date().toISOString().replace(/[:]/g, '-')}-${randomUUID()}`;
    const backup = path.join(root, "transfer-backups", id), existed = files.map(file => this.fs.existsSync(file));
    const originals = files.map((file, i) => existed[i] ? this.fs.readFileSync(file) : null);
    const stage = files.map(file => `${file}.${id}.import`);
    const documents = [prepared.payload.widgets, prepared.payload.deviceWidgets, prepared.payload.metadata, { version: 1, settings: prepared.payload.dashboardSettings }];
    let journalCreated = false;
    try {
      this.fs.mkdirSync(backup, { recursive: true });
      for (let i = 0; i < files.length; i++) {
        if (existed[i]) this.fs.writeFileSync(path.join(backup, names[i]), originals[i], { flag: "wx", flush: true });
        this.fs.writeFileSync(stage[i], json(documents[i]), { flag: "wx", flush: true });
      }
      this.fs.writeFileSync(path.join(backup, "manifest.json"), json({ id, existed, importedAt: new Date().toISOString() }), { flag: "wx", flush: true });
      atomicWrite(journal, json({ id, existed, phase: "prepared" }), this.fs);
      journalCreated = true;
      for (let i = 0; i < files.length; i++) this.fs.renameSync(stage[i], files[i]);
      atomicWrite(journal, json({ id, existed, phase: "committed" }), this.fs);
      // A leftover committed journal is safe: startup keeps the new files.
      try { this.fs.unlinkSync(journal); } catch { /* Retry cleanup on startup. */ }
    } catch {
      if (journalCreated) {
        try {
          for (let i = 0; i < files.length; i++) {
            if (existed[i]) atomicWrite(files[i], originals[i], this.fs);
            else if (this.fs.existsSync(files[i])) this.fs.unlinkSync(files[i]);
          }
          this.fs.unlinkSync(journal);
        } catch { throw new TransferError("Uvoz nije dovršen. Prethodno stanje spremljeno je u sigurnosnoj kopiji; ponovno pokreni dashboard radi oporavka.", 500, "TRANSFER_RECOVERY_REQUIRED"); }
      }
      throw new TransferError("Uvoz nije spremljen. Prethodne postavke su zadržane; provjeri može li servis pisati u mapu konfiguracije.", 500, "TRANSFER_SAVE_FAILED");
    } finally { for (const file of stage) { try { if (this.fs.existsSync(file)) this.fs.unlinkSync(file); } catch { /* Startup also cleans staged files. */ } } }
    return { ...prepared, backupId: id, metadataFile: files[2] };
  }
}

module.exports = { DashboardTransfer, TransferError, initializeTransferFiles, MAX_BYTES, FORMAT };
