require("dotenv").config({ quiet: true });

const fs = require("node:fs");
const path = require("node:path");
const { createApp } = require("./app");
const { loadConfig, readWidgetConfiguration } = require("./lib/config");
const { PointPoller } = require("./lib/telemetry/pointPoller");
const { WidgetStore } = require("./lib/storage/widgetStore");
const { DeviceWidgetStore, parseDeviceDocument } = require("./lib/storage/deviceWidgetStore");
const { DashboardTransfer, initializeTransferFiles } = require("./lib/storage/dashboardTransfer");
const { DashboardSettingsStore, settingsFromConfig } = require("./lib/storage/dashboardSettings");
const { DeviceMetadataClient, readCatalog } = require("./lib/devices/deviceMetadata");
const { createDashboardAuth } = require("./lib/auth/dashboardAuth");
const { DashboardUsers } = require("./lib/auth/dashboardUsers");

const configDirectory = path.join(__dirname, "config");

function legacyWidgetFile(env) {
  return env.WIDGETS_JSON?.trim() ? "" : env.WIDGETS_FILE?.trim() || "";
}

function loadRuntimeState(env, database, usersFile) {
  const storedSettings = database?.readDocument("settings");
  if (storedSettings !== undefined) {
    const widgets = database.readWidgets();
    const rawWidgets = widgets.length ? JSON.stringify(widgets) : "";
    return { config: loadConfig(env, { rawWidgets, storedSettings, allowEmptyWidgets: true }),
      users: new DashboardUsers(usersFile, env, { database }) };
  }

  initializeTransferFiles(env, { createMissing: !database });
  const rawWidgets = readWidgetConfiguration(env, { allowMissing: Boolean(database) });
  const config = loadConfig(env, { rawWidgets, allowEmptyWidgets: Boolean(database) });
  const users = new DashboardUsers(usersFile, env, { database });
  if (database) {
    const deviceWidgets = config.deviceWidgetsFile && fs.existsSync(config.deviceWidgetsFile)
      ? parseDeviceDocument(fs.readFileSync(config.deviceWidgetsFile, "utf8")) : { version: 1, devices: [] };
    database.saveConfiguration({
      widgets: rawWidgets ? JSON.parse(rawWidgets) : [],
      deviceWidgets,
      metadata: config.deviceMetadataFile ? readCatalog(config.deviceMetadataFile) : null,
      dashboardSettings: config.dashboardSettingsFile && fs.existsSync(config.dashboardSettingsFile) ? settingsFromConfig(config) : null,
    });
  }
  return { config, users };
}

function createRuntime(env = process.env, { databaseFile = env.DASHBOARD_DB_FILE?.trim() } = {}) {
  const widgetsFile = legacyWidgetFile(env);
  const root = widgetsFile ? path.dirname(path.resolve(widgetsFile)) : configDirectory;
  const usersFile = path.resolve(env.DASHBOARD_USERS_FILE?.trim() || path.join(
    root, "dashboard-users.json"
  ));
  const legacyFiles = [
    widgetsFile, env.DEVICE_WIDGETS_FILE?.trim() || path.join(root, "device-widgets.json"),
    env.DEVICE_METADATA_FILE?.trim() || path.join(root, "catalog-metadata.json"), path.join(root, "dashboard-settings.json"),
  ].filter(Boolean).map(file => path.resolve(file).toLowerCase());
  if (legacyFiles.includes(usersFile.toLowerCase())) {
    throw new Error("DASHBOARD_USERS_FILE must be separate from other dashboard configuration files.");
  }
  const publicDirectory = path.join(__dirname, "public").toLowerCase() + path.sep;
  if (usersFile.toLowerCase().startsWith(publicDirectory)) throw new Error("DASHBOARD_USERS_FILE must be outside the public directory.");
  let database;
  if (databaseFile) {
    const filename = path.resolve(databaseFile);
    const target = filename.toLowerCase();
    if (target.startsWith(publicDirectory) || target === usersFile.toLowerCase() || legacyFiles.includes(target)) {
      throw new Error("DASHBOARD_DB_FILE must be outside the public directory and separate from legacy configuration files.");
    }
    const { DashboardDatabase } = require("./lib/storage/dashboardDatabase");
    database = new DashboardDatabase(filename);
  }
  try {
    const { config, users } = database
      ? database.transaction(() => loadRuntimeState(env, database, usersFile))
      : loadRuntimeState(env, undefined, usersFile);
    return startRuntime(env, config, users, database);
  } catch (error) {
    database?.close();
    throw error;
  }
}

function startRuntime(env, config, users, database) {
  const dashboardAuth = createDashboardAuth(env, users);
  const poller = new PointPoller({
    middlewareUrl: config.middlewareUrl,
    username: config.username,
    password: config.password,
    widgets: config.widgets,
    intervalMs: config.intervalMs,
    timeoutMs: config.timeoutMs,
    readBatchSize: config.readBatchSize,
    readBatchDelayMs: config.readBatchDelayMs,
    demoMode: config.demoMode,
  });
  const writableDatabase = config.demoMode ? undefined : database;
  const widgetStore = new WidgetStore(config.demoMode ? "" : config.widgetsFile, { database: writableDatabase });
  const deviceWidgetStore = new DeviceWidgetStore(config.demoMode ? "" : config.deviceWidgetsFile, {
    protectedFilePath: config.widgetsFile, database: writableDatabase,
  });
  const dashboardSettings = new DashboardSettingsStore(config, { database });
  const dashboardTransfer = new DashboardTransfer(config, { database });
  const deviceMetadata = new DeviceMetadataClient(config, { catalog: database?.readDocument("metadata") });
  const app = createApp({ poller, config, dashboardAuth, widgetStore, deviceWidgetStore, dashboardSettings, dashboardTransfer, deviceMetadata });

  return { app, config, poller, widgetStore, deviceWidgetStore, database };
}

if (require.main === module) {
  const widgetsFile = legacyWidgetFile(process.env);
  const databaseFile = process.env.DASHBOARD_DB_FILE?.trim() || path.join(widgetsFile ? path.dirname(path.resolve(widgetsFile)) : configDirectory, "dashboard.sqlite");
  const { app, config, poller, database } = createRuntime(process.env, { databaseFile });
  let shuttingDown = false;
  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`PLC dashboard listening on port ${config.port}`);
    poller.start();
  });

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    poller.stop();
    server.close(() => {
      database.close();
      process.exit(0);
    });

    const forceCloseTimer = setTimeout(() => {
      server.closeAllConnections?.();
    }, 1_000);
    forceCloseTimer.unref();
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

module.exports = {
  createRuntime,
};
