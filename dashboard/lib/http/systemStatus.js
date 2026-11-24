const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { middlewareRequest } = require("../middlewareClient");

function connection(config, fetchImpl) {
  return { fetchImpl, middlewareUrl: config.middlewareUrl, username: config.username, password: config.password,
    timeoutMs: Math.min(config.timeoutMs || 10_000, 10_000) };
}

// Uses only the middleware's public /health, so it never contacts the controller.
async function middlewareHealth(config, fetchImpl) {
  try {
    const { ok, status, payload } = await middlewareRequest(connection(config, fetchImpl), "/health");
    if (!ok) return { reachable: false, error: `Middleware je odgovorio statusom ${status}.` };
    return { reachable: true, version: typeof payload?.version === "string" ? payload.version : null };
  } catch (error) {
    return { reachable: false, error: error.timedOut ? "Middleware nije odgovorio na vrijeme." : "Middleware nije dostupan." };
  }
}

// One explicit, read-only controller call (GetWebServiceInformation) that
// separates a wrong middleware password from a controller fault.
async function controllerCheck(config, fetchImpl) {
  try {
    const { ok, status, payload } = await middlewareRequest(connection(config, fetchImpl), "/api/info");
    if (ok && !payload?.soapFault && !payload?.error) return { state: "connected", message: "Middleware i kontroler odgovaraju." };
    if (status === 401) return { state: "auth", message: "Middleware je odbio vjerodajnice dashboarda." };
    if (status === 429) return { state: "middleware", message: "Middleware privremeno ograničava prijave. Pokušaj ponovno za minutu." };
    const detail = payload?.soapFault?.reason || payload?.error;
    return { state: "controller", message: `Middleware radi, ali kontroler nije odgovorio ispravno${detail ? `: ${String(detail).slice(0, 200)}` : "."}` };
  } catch (error) {
    return { state: "middleware", message: error.timedOut ? "Middleware nije odgovorio na vrijeme." : "Middleware nije dostupan." };
  }
}

// Hints only: they compare the deployment's settings with how this request arrived.
function connectionHints(request, { secureCookies, trustProxy }) {
  const hints = [];
  const forwarded = Boolean(request.get("x-forwarded-for") || request.get("x-forwarded-proto"));
  if (request.secure && !secureCookies) hints.push("Dashboard se otvara preko HTTPS-a, ali DASHBOARD_SECURE_COOKIES nije uključen.");
  if (forwarded && !trustProxy) hints.push("Zahtjev dolazi preko reverse proxyja, ali DASHBOARD_TRUST_PROXY nije postavljen; ograničenje prijava tada vidi samo adresu proxyja.");
  return hints;
}

async function systemStatus({ request, config, fetchImpl = globalThis.fetch, version, secureCookies, pointCount, database }) {
  const middleware = config.demoMode ? { reachable: null } : await middlewareHealth(config, fetchImpl);
  return {
    dashboardVersion: version || null,
    demoMode: Boolean(config.demoMode),
    middleware,
    versionMismatch: Boolean(version && middleware.version && version !== middleware.version),
    pointCount,
    backupAvailable: Boolean(database),
    hints: connectionHints(request, { secureCookies, trustProxy: config.trustProxy }),
  };
}

// A consistent SQLite copy in a private temporary file that is always removed.
async function sendDatabaseBackup(response, database) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-backup-"));
  const file = path.join(directory, `${randomUUID()}.sqlite`);
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    await database.backup(file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    cleanup();
    throw error;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  response.set("Cache-Control", "no-store");
  response.download(file, `dashboard-backup-${stamp}.sqlite`, cleanup);
}

module.exports = { controllerCheck, connectionHints, systemStatus, sendDatabaseBackup };
