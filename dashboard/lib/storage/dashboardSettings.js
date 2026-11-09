const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const limits = {
  intervalMs: [1_000, 86_400_000],
  readBatchSize: [1, 500],
  readBatchDelayMs: [0, 60_000],
  timeoutMs: [100, 120_000],
};

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: "INVALID_DASHBOARD_SETTINGS" });
}

function validateSettings(value, previous = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Postavke nisu valjane.");
  if (Object.keys(value).some(key => !Object.hasOwn(limits, key) && key !== "afterWriteScope")) throw invalid("Nepoznata postavka dashboarda.");
  const settings = { ...previous, ...value };
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max) throw invalid(`${key}: dopušten je cijeli broj od ${min} do ${max}.`);
  }
  if (!["room", "device"].includes(settings.afterWriteScope)) throw invalid("Odaberi prostoriju ili uređaj za osvježavanje nakon naredbe.");
  return settings;
}

function settingsFromConfig(config) {
  return validateSettings({
    intervalMs: config.intervalMs ?? 15_000,
    readBatchSize: config.readBatchSize ?? 500,
    readBatchDelayMs: config.readBatchDelayMs ?? 0,
    timeoutMs: config.timeoutMs ?? 10_000,
    afterWriteScope: config.afterWriteScope ?? "room",
  });
}

function settingsFile(config) {
  return config.dashboardSettingsFile || (config.widgetsFile ? path.join(path.dirname(config.widgetsFile), "dashboard-settings.json") : "");
}

function readSavedSettings(config) {
  const file = settingsFile(config);
  if (!file || !fs.existsSync(file)) return settingsFromConfig(config);
  try {
    const document = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (document.version !== 1) throw new Error("Unsupported version");
    return validateSettings(document.settings, settingsFromConfig(config));
  } catch { throw new Error("Datoteka dashboard-settings.json nije valjana; postojeće postavke su sačuvane."); }
}

class DashboardSettingsStore {
  constructor(config, { database } = {}) {
    this.database = database;
    this.filePath = database ? "" : settingsFile(config);
    this.values = database ? database.readDocument("settings") ?? settingsFromConfig(config) : readSavedSettings(config);
  }

  get persisted() { return Boolean(this.database || this.filePath); }

  save(value) {
    const next = validateSettings(value, this.values);
    if (this.persisted) {
      const temporary = this.database ? null : `${this.filePath}.${randomUUID()}.tmp`;
      try {
        if (this.database) this.database.saveDocument("settings", next);
        else {
          fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, settings: next }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
          fs.renameSync(temporary, this.filePath);
        }
      } catch (error) {
        if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
        throw Object.assign(new Error("Spremanje općih postavki nije uspjelo. Prethodne postavke su sačuvane."), { code: "DASHBOARD_SETTINGS_SAVE_FAILED" });
      }
    }
    this.values = next;
    return { ...next };
  }
}

module.exports = { DashboardSettingsStore, validateSettings, settingsFromConfig, settingsFile, readSavedSettings };
