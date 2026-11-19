const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once, EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { BuildingScan } = require("../lib/catalog/buildingScan");
const { PointPoller } = require("../lib/telemetry/pointPoller");
const { createRuntime } = require("../server");

function directory(t, beforeRemove = async () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-scan-test-"));
  t.after(async () => { await beforeRemove(); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const config = { middlewareUrl: "http://fixture.invalid", username: "fixture-user", password: "fixture-secret", timeoutMs: 1000, demoMode: false };
async function listen(t, server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("scan holds active reads, rejects manual refresh, defers readback and restores prior pause", async () => {
  let finish, reads = 0;
  const poller = new PointPoller({ middlewareUrl: "http://fixture", widgets: [{ id: "point" }], fetchImpl: async () => {
    reads++;
    if (reads === 1) await new Promise(resolve => { finish = resolve; });
    return { ok: true, json: async () => ({ values: [{ id: "point", value: 1 }] }) };
  } });
  const first = poller.poll();
  let acquired = false;
  const hold = poller.holdForCatalogScan().then(release => { acquired = true; return release; });
  assert.equal(acquired, false);
  assert.equal(poller.getPollingState().catalogScan, true);
  assert.throws(() => poller.setPaused(false), { code: "CATALOG_SCAN_ACTIVE" });
  await assert.rejects(poller.poll({ manual: true }), { code: "CATALOG_SCAN_ACTIVE" });
  await assert.rejects(poller.refreshScope(["point"]), { code: "CATALOG_SCAN_ACTIVE" });
  finish(); await first;
  const release = await hold;
  await poller.refreshPoints(["point"]);
  assert.equal(reads, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(reads > 1);
  assert.equal(poller.getPollingState().paused, false);
  assert.equal(poller.getPollingState().catalogScan, undefined);
  poller.setPaused(true);
  const releasePaused = await poller.holdForCatalogScan();
  releasePaused();
  assert.equal(poller.getPollingState().paused, true);
  poller.stop();
});

test("worker credentials stay in stdin; pause drains child, persists recovery and restricts files", async t => {
  const dir = directory(t);
  let command, args, options, input = "", released = false, held = false;
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.stdin.on("data", chunk => { input += chunk; });
  const scan = new BuildingScan({ directory: dir, config, poller: { holdForCatalogScan: async () => { held = true; return () => { released = true; }; } },
    spawnImpl: (...values) => { [command, args, options] = values; return child; } });
  assert.throws(() => scan.start({}), { status: 400 });
  const job = scan.start({ confirmPause: true, maxRequests: 1 });
  const done = scan.active.done;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(held, true);
  assert.throws(() => scan.start({ confirmPause: true }), { status: 409 });
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.equal(options.env.MIDDLEWARE_PASSWORD, undefined);
  assert.equal(options.env.DASHBOARD_ADMIN_PASSWORD, undefined);
  assert.ok(!JSON.stringify([command, args, options, scan.status()]).includes(config.password));
  assert.equal(JSON.parse(input).password, config.password);
  fs.writeFileSync(path.join(dir, job.id, "checkpoint.sqlite"), "fixture");
  scan.pause(job.id); scan.pause(job.id);
  assert.match(input, /stop\n$/); assert.equal(released, false);
  child.stdout.write(JSON.stringify({ event: "finished", summary: { pages: 0, states: { pending: 1 } }, requests: 1 }) + "\n");
  child.emit("close", 130); await done;
  assert.equal(released, true); assert.equal(scan.busy, false);
  assert.equal(scan.read(job.id).state, "paused");
  assert.equal(scan.read(job.id).canResume, true);
  assert.throws(() => scan.download(job.id, "job.json"), { status: 404 });
  assert.throws(() => scan.download("../", "checkpoint.sqlite"), { status: 404 });
  assert.ok(!fs.readFileSync(path.join(dir, job.id, "job.json"), "utf8").includes(config.password));
  const recovered = new BuildingScan({ directory: dir, config, poller: {} });
  assert.equal(recovered.status().jobs[0].canResume, true);
  const changed = new BuildingScan({ directory: dir, config: { ...config, middlewareUrl: "http://other.invalid" }, poller: {} });
  assert.equal(changed.read(job.id).canResume, false);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, job.id, "job.json")));
  stored.state = "running"; fs.writeFileSync(path.join(dir, job.id, "job.json"), JSON.stringify(stored));
  assert.equal(recovered.read(job.id).state, "interrupted");
});

test("missing Python releases polling and reports a safe failure", async t => {
  let released = false;
  const scan = new BuildingScan({ directory: directory(t), config, poller: { holdForCatalogScan: async () => () => { released = true; } },
    spawnImpl: () => { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); process.nextTick(() => child.emit("error", new Error("private failure"))); return child; } });
  const job = scan.start({ confirmPause: true });
  await scan.active.done;
  assert.equal(scan.read(job.id).state, "failed");
  assert.match(scan.read(job.id).message, /Python/);
  assert.ok(!JSON.stringify(scan.status()).includes("private failure"));
  assert.equal(released, true);
});

test("admin API runs Python scan, budgets and resumes pages, indexes catalog, protects operations and downloads", { timeout: 30000 }, async t => {
  let runtime;
  const dir = directory(t, async () => { if (runtime) { await runtime.buildingScan.shutdown(); runtime.poller.stop(); runtime.database.close(); } }), calls = [];
  let respond;
  const upstream = await listen(t, http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/health") return res.end('{"status":"ok"}');
    assert.equal(req.headers.authorization, `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`);
    assert.equal(url.pathname, "/api/containers");
    const root = url.searchParams.get("id"); calls.push(root);
    assert.equal(url.searchParams.get("allPages"), "false");
    assert.equal(url.searchParams.get("metadata"), "false");
    const send = () => res.end(JSON.stringify({ containers: [{ containerItems: root ? [] : [{ id: "00/A", name: "Room" }], valueItems: [{ id: root ? "01/A/temperature" : "01/root", name: "Temperature", unit: "°C" }] }], errors: [], status: { moreDataAvailable: false }, complete: true }));
    if (calls.length === 1) respond = send; else send();
  }));
  runtime = createRuntime({ DEMO_MODE: "false", MIDDLEWARE_URL: upstream, MIDDLEWARE_USER: config.username, MIDDLEWARE_PASSWORD: config.password,
    DASHBOARD_ADMIN_USER: "admin", DASHBOARD_ADMIN_PASSWORD: "fixture-admin", DASHBOARD_LOGIN_USER: "user", DASHBOARD_LOGIN_PASSWORD: "fixture-user-password",
    DASHBOARD_USERS_FILE: path.join(dir, "users.json"), DASHBOARD_DB_FILE: path.join(dir, "dashboard.sqlite"), WIDGETS_JSON: "[]" });
  runtime.buildingScan.delay = 0;
  runtime.poller.setPaused(true);
  const base = await listen(t, http.createServer(runtime.app));
  const request = (url, options = {}) => fetch(base + url, { redirect: "manual", ...options });
  const login = async (username, password) => (await request("/login", { method: "POST", body: new URLSearchParams({ username, password }) })).headers.get("set-cookie").split(";")[0];
  const cookie = await login("admin", "fixture-admin"), userCookie = await login("user", "fixture-user-password");
  const get = (url, session = cookie) => request(url, { headers: { cookie: session } });
  const post = (url, body, session = cookie) => request(url, { method: "POST", headers: { cookie: session, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await request("/api/admin/catalog/status")).status, 401);
  assert.equal((await get("/api/admin/catalog/status", userCookie)).status, 403);
  assert.equal((await post("/api/admin/catalog/start", { confirmPause: true }, userCookie)).status, 403);
  assert.equal((await post("/api/admin/catalog/start", {})).status, 400);
  const started = await post("/api/admin/catalog/start", { confirmPause: true, maxRequests: 1, profile: "full" });
  assert.equal(started.status, 202, await started.clone().text());
  const job = await started.json(), done = runtime.buildingScan.active.done;
  try {
    const deadline = Date.now() + 5000;
    while (!respond && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(respond, "Python worker reached fixture server");
    assert.equal((await post("/api/write", { id: "point", value: 1 })).status, 409);
    assert.equal((await post("/api/dashboard/refresh", {})).status, 409);
    assert.equal((await post("/api/dashboard/settings", {})).status, 409);
    assert.equal((await post("/api/admin/organization/apply", {})).status, 409);
    assert.equal((await post("/api/admin/users", {})).status, 409);
    assert.equal((await get("/api/devices/metadata")).status, 200);
    assert.equal((await get(`/api/admin/catalog/${job.id}/files/checkpoint.sqlite`)).status, 404);
  } finally { respond?.(); }
  await done;
  const status = await (await get("/api/admin/catalog/status")).json();
  assert.equal(status.busy, false);
  assert.equal(status.jobs[0].state, "paused", JSON.stringify(status));
  assert.equal(status.jobs[0].catalog.points, 1);
  assert.ok(!JSON.stringify(status).includes(config.password));
  assert.equal(runtime.poller.getPollingState().paused, true);
  const workerImpl = runtime.buildingScan.workerImpl;
  let releaseRead, enteredRead;
  const readStarted = new Promise(resolve => { enteredRead = resolve; });
  const readBlocked = new Promise(resolve => { releaseRead = resolve; });
  runtime.buildingScan.workerImpl = async data => { enteredRead(); await readBlocked; return workerImpl(data); };
  const activeRead = get(`/api/admin/catalog/${job.id}/devices`);
  await readStarted;
  try {
    assert.equal((await post("/api/admin/catalog/start", { resumeId: job.id, confirmPause: true })).status, 409);
  } finally { releaseRead(); await activeRead; runtime.buildingScan.workerImpl = workerImpl; }
  const resumed = await post("/api/admin/catalog/start", { resumeId: job.id, confirmPause: true, maxRequests: 500 });
  assert.equal(resumed.status, 202, await resumed.clone().text());
  await runtime.buildingScan.active.done;
  const completed = runtime.buildingScan.read(job.id);
  assert.equal(completed.state, "completed", JSON.stringify(completed));
  assert.deepEqual(calls, ["", "00/A"]);
  assert.equal(completed.catalog.points, 2);
  const devices = await get(`/api/admin/catalog/${job.id}/devices`);
  assert.equal(devices.status, 200);
  assert.ok(Array.isArray((await devices.json()).items));
  const download = await get(`/api/admin/catalog/${job.id}/files/inventory.csv`);
  assert.equal(download.status, 200); assert.match(await download.text(), /01\/A\/temperature/);
  assert.equal((await get(`/api/admin/catalog/${job.id}/files/inventory.csv`, userCookie)).status, 403);
  assert.equal((await get(`/api/admin/catalog/${job.id}/files/job.json`)).status, 404);
  assert.deepEqual(runtime.config.widgets, []);
});

test("a controller read keeps the scan from starting after its browser disconnects", async t => {
  let runtime, release, readStarted;
  const dir = directory(t, async () => { if (runtime) { await runtime.buildingScan.shutdown(); runtime.poller.stop(); runtime.database.close(); } });
  const started = new Promise(resolve => { readStarted = resolve; });
  const upstream = await listen(t, http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/api/items/read")) {
      readStarted();
      release = () => res.end("{}");
      return;
    }
    res.end(JSON.stringify({ containers: [], errors: [] }));
  }));
  runtime = createRuntime({ DEMO_MODE: "false", MIDDLEWARE_URL: upstream, MIDDLEWARE_USER: config.username, MIDDLEWARE_PASSWORD: config.password,
    DASHBOARD_ADMIN_USER: "admin", DASHBOARD_ADMIN_PASSWORD: "fixture-admin", DASHBOARD_USERS_FILE: path.join(dir, "users.json"),
    DASHBOARD_DB_FILE: path.join(dir, "dashboard.sqlite"), WIDGETS_JSON: JSON.stringify([{ id: "01/A/Zones/Z1/L1/Values/LtPct", label: "L1" }]) });
  runtime.poller.setPaused(true);
  // No Python: the fake worker reports a pause as soon as it is asked to stop.
  runtime.buildingScan.spawnImpl = () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.stdin.on("finish", () => setImmediate(() => child.emit("close", 130)));
    return child;
  };
  const base = await listen(t, http.createServer(runtime.app));
  const cookie = (await fetch(`${base}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ username: "admin", password: "fixture-admin" }) })).headers.get("set-cookie").split(";")[0];
  const start = () => fetch(`${base}/api/admin/catalog/start`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ confirmPause: true }) });
  const abort = new AbortController();
  const read = fetch(`${base}/api/devices/metadata`, { headers: { cookie }, signal: abort.signal }).catch(error => error.name);
  await started;
  abort.abort();
  assert.equal(await read, "AbortError");
  await new Promise(resolve => setTimeout(resolve, 50));
  const blocked = await start();
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, "WIDGET_OPERATION_IN_PROGRESS");
  assert.equal(runtime.buildingScan.busy, false);
  release();
  let accepted;
  for (let attempt = 0; attempt < 50 && accepted?.status !== 202; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    accepted = await start();
  }
  assert.equal(accepted.status, 202);
  runtime.buildingScan.pause((await accepted.json()).id);
  await runtime.buildingScan.active?.done;
});

test("a request that reaches the controller only after a scan started is refused", async t => {
  let runtime, releaseRooms;
  const dir = directory(t, async () => { if (runtime) { runtime.buildingScan.active = null; runtime.poller.stop(); runtime.database.close(); } });
  const browsed = [];
  const upstream = await listen(t, http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (new URL(req.url, "http://fixture").searchParams.get("id") === "trend-probe") browsed.push(req.url);
    res.end(JSON.stringify({ containers: [], errors: [] }));
  }));
  runtime = createRuntime({ DEMO_MODE: "false", MIDDLEWARE_URL: upstream, MIDDLEWARE_USER: config.username, MIDDLEWARE_PASSWORD: config.password,
    DASHBOARD_ADMIN_USER: "admin", DASHBOARD_ADMIN_PASSWORD: "fixture-admin", DASHBOARD_LOGIN_USER: "user", DASHBOARD_LOGIN_PASSWORD: "fixture-user-password",
    DASHBOARD_USERS_FILE: path.join(dir, "users.json"), DASHBOARD_DB_FILE: path.join(dir, "dashboard.sqlite"), WIDGETS_JSON: "[]" });
  runtime.poller.setPaused(true);
  // Hold the user's room preparation, which runs after the scan gate and
  // before the trend handler calls the controller.
  let roomsHeld;
  const held = new Promise(resolve => { roomsHeld = resolve; });
  const synchronize = runtime.deviceWidgetStore.synchronize.bind(runtime.deviceWidgetStore);
  runtime.deviceWidgetStore.synchronize = async (...args) => {
    roomsHeld();
    await new Promise(resolve => { releaseRooms = resolve; });
    return synchronize(...args);
  };
  const base = await listen(t, http.createServer(runtime.app));
  const user = (await fetch(`${base}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ username: "user", password: "fixture-user-password" }) })).headers.get("set-cookie").split(";")[0];
  const browse = fetch(`${base}/api/history/browse`, { method: "POST", headers: { cookie: user, "Content-Type": "application/json" }, body: JSON.stringify({ containerId: "trend-probe" }) });
  await held;
  // A scan becomes active meanwhile, as it can after an earlier client disconnected.
  runtime.buildingScan.active = { job: { id: "fixture" } };
  releaseRooms();
  const response = await browse;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "CATALOG_SCAN_ACTIVE");
  assert.deepEqual(browsed, [], "the trend handler must not reach the middleware during the scan");
});

test("dashboard image ships every local Python module the scan worker imports", () => {
  const root = path.resolve(__dirname, "../..");
  const mapper = path.join(root, "tools/ews-topology");
  const dockerfile = fs.readFileSync(path.join(root, "dashboard/Dockerfile"), "utf8");
  const ignore = fs.readFileSync(path.join(root, "dashboard/Dockerfile.dockerignore"), "utf8").split(/\r?\n/);
  const required = new Set(["admin_scan.py"]);
  for (const file of required) {
    for (const [, name] of fs.readFileSync(path.join(mapper, file), "utf8").matchAll(/^(?:from|import)\s+(\w+)/gm)) {
      if (fs.existsSync(path.join(mapper, `${name}.py`))) required.add(`${name}.py`);
    }
  }
  assert.ok(required.has("map_topology.py") && required.has("pruning.py"));
  for (const file of required) {
    assert.ok(dockerfile.includes(`tools/ews-topology/${file}`), `Dockerfile copies ${file}`);
    assert.ok(ignore.includes(`!tools/ews-topology/${file}`), `dockerignore allows ${file}`);
  }
});
