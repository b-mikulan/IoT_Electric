const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRuntime } = require("../server");
const { DashboardDatabase } = require("../lib/storage/dashboardDatabase");

// A stand-in middleware: /health is public, /api/info needs the right password.
async function fakeMiddleware(t, { version = "0.15.0", infoStatus = 200 } = {}) {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push(request.url);
    const authorized = request.headers.authorization === `Basic ${Buffer.from("iot-electric:secret").toString("base64")}`;
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") return response.end(JSON.stringify({ status: "ok", version }));
    if (!authorized) { response.statusCode = 401; return response.end(JSON.stringify({ error: "Authentication required." })); }
    response.statusCode = infoStatus;
    return response.end(JSON.stringify(infoStatus === 200 ? { version: "EWS" } : { error: "fetch failed" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

async function startDashboard(t, env) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-admin-system-"));
  const previousVersion = process.env.APP_VERSION;
  process.env.APP_VERSION = "0.15.0";
  let runtime;
  try {
    runtime = createRuntime({
      DEMO_MODE: "false", WIDGETS_JSON: "[]", DASHBOARD_USERS_FILE: path.join(directory, "users.json"),
      DASHBOARD_ADMIN_USER: "admin", DASHBOARD_ADMIN_PASSWORD: "test-admin",
      DASHBOARD_LOGIN_USER: "operator", DASHBOARD_LOGIN_PASSWORD: "test-operator",
      MIDDLEWARE_USER: "iot-electric", MIDDLEWARE_PASSWORD: "secret", ...env,
    }, { databaseFile: path.join(directory, "dashboard.sqlite") });
  } finally {
    if (previousVersion === undefined) delete process.env.APP_VERSION; else process.env.APP_VERSION = previousVersion;
  }
  const server = runtime.app.listen(0, "127.0.0.1");
  t.after(async () => {
    runtime.poller.stop();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    runtime.database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await once(server, "listening");
  const request = (url, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { redirect: "manual", ...options });
  const login = async (username, password) => {
    const response = await request("/login", { method: "POST", body: new URLSearchParams({ username, password }) });
    assert.equal(response.status, 303);
    return response.headers.get("set-cookie").split(";")[0];
  };
  return { request, login, directory };
}

test("shows installation status without contacting the controller and checks it only on request", async t => {
  const middleware = await fakeMiddleware(t, { version: "0.14.0" });
  const { request, login } = await startDashboard(t, { MIDDLEWARE_URL: middleware.url });
  const admin = { cookie: await login("admin", "test-admin") };
  const operator = { cookie: await login("operator", "test-operator") };

  for (const [url, method] of [["/api/admin/system", "GET"], ["/api/admin/system/controller-check", "POST"], ["/api/admin/backup", "GET"]]) {
    const options = { method, headers: { ...operator, "Content-Type": "application/json" }, ...(method === "POST" && { body: "{}" }) };
    assert.equal((await request(url, options)).status, 403, url);
  }
  assert.equal(middleware.calls.length, 0);

  const response = await request("/api/admin/system", { headers: admin });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const status = await response.json();
  assert.deepEqual({ ...status, hints: undefined }, {
    dashboardVersion: "0.15.0", demoMode: false, middleware: { reachable: true, version: "0.14.0" },
    versionMismatch: true, pointCount: 0, backupAvailable: true, hints: undefined,
  });
  assert.deepEqual(middleware.calls, ["/health"]);

  const check = await request("/api/admin/system/controller-check", { method: "POST", headers: { ...admin, "Content-Type": "application/json" }, body: "{}" });
  assert.deepEqual(await check.json(), { state: "connected", message: "Middleware i kontroler odgovaraju." });
  assert.deepEqual(middleware.calls, ["/health", "/api/info"]);
});

test("separates a rejected middleware password, a controller fault and an unreachable middleware", async t => {
  const failing = await fakeMiddleware(t, { infoStatus: 500 });
  const wrongPassword = await startDashboard(t, { MIDDLEWARE_URL: failing.url, MIDDLEWARE_PASSWORD: "wrong" });
  const controllerFault = await startDashboard(t, { MIDDLEWARE_URL: failing.url });
  const unreachable = await startDashboard(t, { MIDDLEWARE_URL: "http://127.0.0.1:9" });
  const check = async ({ request, login }) => {
    const cookie = await login("admin", "test-admin");
    const response = await request("/api/admin/system/controller-check", { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}" });
    return (await response.json()).state;
  };
  assert.equal(await check(wrongPassword), "auth");
  assert.equal(await check(controllerFault), "controller");
  assert.equal(await check(unreachable), "middleware");
  const cookie = await unreachable.login("admin", "test-admin");
  const status = await (await unreachable.request("/api/admin/system", { headers: { cookie } })).json();
  assert.equal(status.middleware.reachable, false);
});

test("hints at missing HTTPS and proxy settings once the proxy is trusted", async t => {
  const middleware = await fakeMiddleware(t);
  const untrusted = await startDashboard(t, { MIDDLEWARE_URL: middleware.url });
  const trusted = await startDashboard(t, { MIDDLEWARE_URL: middleware.url, TRUST_PROXY: "1" });
  const hints = async ({ request, login }) => {
    const cookie = await login("admin", "test-admin");
    const headers = { cookie, "X-Forwarded-For": "203.0.113.7", "X-Forwarded-Proto": "https" };
    return (await (await request("/api/admin/system", { headers })).json()).hints;
  };
  assert.deepEqual((await hints(untrusted)).map(text => text.split(",")[0]), ["Zahtjev dolazi preko reverse proxyja"]);
  // TRUST_PROXY=1 is a hop count, so the forwarded HTTPS protocol is believed.
  assert.deepEqual((await hints(trusted)).map(text => text.split(",")[0]), ["Dashboard se otvara preko HTTPS-a"]);
});

test("downloads a consistent database copy that opens as a dashboard database", async t => {
  const middleware = await fakeMiddleware(t);
  const { request, login, directory } = await startDashboard(t, { MIDDLEWARE_URL: middleware.url });
  const cookie = await login("admin", "test-admin");
  const response = await request("/api/admin/backup", { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-disposition"), /dashboard-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.sqlite/);
  const copy = path.join(directory, "restored.sqlite");
  await fs.writeFile(copy, Buffer.from(await response.arrayBuffer()));
  const restored = new DashboardDatabase(copy);
  try { assert.deepEqual(restored.readUsers().map(user => user.username), ["operator"]); }
  finally { restored.close(); }
  const leftovers = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith("dashboard-backup-"));
  assert.deepEqual(leftovers, []);
});
