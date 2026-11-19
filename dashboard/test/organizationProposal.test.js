const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { proposeOrganization, applyOrganizationSelection } = require("../lib/devices/organizationProposal");
const { DeviceWidgetStore } = require("../lib/storage/deviceWidgetStore");
const { createRuntime } = require("../server");

const point = (key, role = "LtPct", extra = {}) => ({ id: `01/${key}/Values/${role}`, label: role, visible: true, writable: false, ...extra });
function fixture() {
  return {
    widgets: [point("ES/Zones/Z1", "LtLvl"), point("ES/Zones/Z1/L1"), point("ES/Zones/Z10/L2"), point("Other/Zones/Z1/L1")],
    metadata: { schemaVersion: 1, metadataById: {}, roomByZone: {} },
    deviceWidgets: { version: 1, organizationVersion: 1, devices: [{ key: "ES/Zones/Z1", room: "r1" }], rooms: ["r1", "r2"],
      roomRules: [], floors: [{ id: "f1", name: "1. kat" }], roomDetails: [{ id: "r1", name: "Ured", floorId: "f1" }, { id: "r2", name: "Dvorana", floorId: null }] },
  };
}
function selected(configuration, predicate = () => true, users = [], scope) {
  const proposal = proposeOrganization(configuration, users, scope);
  return { token: proposal.token, scope: proposal.scope, selectedIds: proposal.suggestions.filter(predicate).map(item => item.id) };
}

test("offline proposals use full zone ancestry and preserve manual assignments, hidden points and unrelated data", () => {
  const config = fixture();
  config.widgets.push(point("ES/Zones/Z1/Hidden", "LtPct", { visible: false }), point("ES/Zones/Z1/Manual"), point("ES/Zones/Z1/Empty"));
  config.deviceWidgets.devices.push({ key: "ES/Zones/Z1/Manual", room: "r2", label: "Ručni naziv" },
    { key: "ES/Zones/Z1/Empty", room: "", lightMembers: [] }, { key: "ES/Absent", room: "r2", primaryUnit: "custom" });
  const original = structuredClone(config);
  const plan = proposeOrganization(config);
  assert.deepEqual(plan.suggestions.map(item => item.key), ["ES/Zones/Z1/L1"]);
  assert.equal(plan.summary.protectedRooms, 3);
  const result = applyOrganizationSelection(config, [], selected(config));
  assert.equal(result.document.devices.find(item => item.key === "ES/Zones/Z1/L1").room, "r1");
  assert.deepEqual(result.document.devices.find(item => item.key === "ES/Absent"), original.deviceWidgets.devices.at(-1));
  assert.deepEqual(config, original);
  assert.equal(proposeOrganization({ ...config, deviceWidgets: result.document }).suggestions.length, 0);
});

test("an explicit branch selection uses path boundaries and never overrides a manual empty room", () => {
  const config = fixture();
  config.deviceWidgets.devices.push({ key: "ES/Zones/Z1/L1", room: "" });
  const scope = { root: "ES/Zones/Z1", roomId: "r2" };
  assert.equal(proposeOrganization(config, [], scope).suggestions.length, 0);
  assert.throws(() => proposeOrganization(config, [], { root: "ES/Unknown", roomId: "r1" }));
  assert.throws(() => proposeOrganization(config, [], { root: "ES" }));
});

test("matching catalog names require a unique room and floor assignments are never guessed", () => {
  const config = fixture();
  config.metadata.roomByZone["ES/Zones/Z10"] = "Ured";
  let plan = proposeOrganization(config);
  assert.equal(plan.suggestions.find(item => item.key === "ES/Zones/Z10/L2").roomId, "r1");
  config.deviceWidgets.roomDetails.push({ id: "r3", name: "Ured", floorId: null });
  plan = proposeOrganization(config);
  assert.equal(plan.suggestions.some(item => item.key === "ES/Zones/Z10/L2"), false);
  assert.equal(plan.summary.roomsWithoutFloor, 3);
});

test("suppressed catalog rooms do not reappear through automatic ancestor suggestions", () => {
  const config = fixture();
  config.metadata.roomByZone["ES/Zones/Z1"] = "Deleted";
  config.deviceWidgets.roomRules.push({ from: "Deleted", to: "" });
  assert.equal(proposeOrganization(config).suggestions.length, 0);
});

test("same-room lights are review-only and saved or ambiguous groups are not overwritten", () => {
  const config = fixture();
  config.widgets = [point("ES/Zones/Z1/G1", "GrpPct"), point("ES/Zones/Z1/L1")];
  config.metadata.roomByZone["ES/Zones/Z1"] = "r1";
  const plan = proposeOrganization(config);
  assert.equal(plan.suggestions.length, 1);
  assert.equal(plan.suggestions[0].review, true);
  assert.equal(plan.suggestions[0].field, "lightMembers");
  const result = applyOrganizationSelection(config, [], selected(config));
  assert.deepEqual(result.document.devices.find(item => item.key.endsWith("G1")).lightMembers, ["ES/Zones/Z1/L1"]);
  assert.equal(proposeOrganization({ ...config, deviceWidgets: result.document }).suggestions.length, 0);
  config.deviceWidgets.devices.push({ key: "ES/Zones/Z1/G1", lightMembers: [] });
  assert.equal(proposeOrganization(config).suggestions.length, 0);
  config.deviceWidgets.devices.pop();
  config.widgets.push(point("ES/Zones/Z1/G2", "GrpPct"));
  assert.equal(proposeOrganization(config).suggestions.length, 0);
  assert.equal(proposeOrganization(config).unresolved.length, 1);
});

test("automatic sensors stay automatic; adding a reviewed sensor retains existing automatic members", () => {
  const config = fixture();
  const zone = "ES/Zones/Z1", auto = "ES/Net/RP1/Application/Zones/Z1/S1", extra = "ES/Hall/S2";
  config.widgets = [point(zone, "LtLvl"), point(auto, "LtLvl"), point(extra, "RmTmp")];
  config.deviceWidgets.devices.push({ key: auto, room: "r1" }, { key: extra, room: "r1" });
  const plan = proposeOrganization(config);
  assert.equal(plan.summary.grouped, 1);
  assert.deepEqual(plan.suggestions.map(item => item.key), [extra]);
  const result = applyOrganizationSelection(config, [], selected(config));
  assert.deepEqual(new Set(result.document.devices.find(item => item.key === zone).sensorMembers), new Set([auto, extra]));
  config.deviceWidgets.devices[0].sensorMembers = [];
  assert.equal(proposeOrganization(config).suggestions.length, 0);
});

test("room moves report actual grants and changes to grants or metadata invalidate preview", () => {
  const config = fixture();
  const users = [{ username: "viewer", roomIds: ["r1"], writeRoomIds: ["r1"] }, { username: "all", roomIds: null, writeRoomIds: [] }];
  const proposal = proposeOrganization(config, users);
  assert.deepEqual(proposal.suggestions[0].permissions, [{ username: "viewer", before: { read: false, write: false }, after: { read: true, write: true } }]);
  assert.equal(proposal.suggestions[0].review, true);
  const selection = selected(config, undefined, users);
  assert.throws(() => applyOrganizationSelection(config, [], selection), { code: "ORGANIZATION_PREVIEW_CHANGED" });
  const changed = structuredClone(config); changed.metadata.roomByZone.X = "New";
  assert.throws(() => applyOrganizationSelection(changed, users, selection), { code: "ORGANIZATION_PREVIEW_CHANGED" });
  assert.throws(() => applyOrganizationSelection(config, users, { ...selection, selectedIds: ["forged"] }));
  assert.throws(() => applyOrganizationSelection(config, users, { ...selection, selectedIds: [...selection.selectedIds, ...selection.selectedIds] }));
});

function directory(t, beforeCleanup = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iot-organization-"));
  t.after(async () => {
    await beforeCleanup();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("iot-organization-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("file storage retains a complete backup and a failed backup cannot change configuration", async t => {
  const dir = directory(t), file = path.join(dir, "devices.json");
  const config = fixture();
  fs.writeFileSync(file, JSON.stringify(config.deviceWidgets));
  const store = new DeviceWidgetStore(file);
  const plan = current => ({ ...applyOrganizationSelection({ ...config, deviceWidgets: current }, [], selected(config)),
    backup: { format: "iot-electric-dashboard", version: 2, ...config } });
  const result = await store.applyOrganization(plan);
  assert.deepEqual((await store.organizationBackup(result.backupId)).deviceWidgets, config.deviceWidgets);
  assert.equal(store.devices.find(item => item.key.endsWith("/L1")).room, "r1");
  await assert.rejects(store.organizationBackup("../../private"), { status: 404 });
  const failing = new DeviceWidgetStore(file, { fsImpl: { ...require("node:fs/promises"), writeFile: async () => { throw new Error("disk full"); } } });
  const before = fs.readFileSync(file, "utf8");
  await assert.rejects(failing.applyOrganization(document => ({ document, backup: config, count: 1 })), { code: "ORGANIZATION_BACKUP_FAILED" });
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("admin API applies selected changes atomically, broadcasts and restores SQLite backup without controller calls", async t => {
  let runtime, server;
  const dir = directory(t, async () => {
    runtime?.poller.stop();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    runtime?.database.close();
  }), config = fixture();
  const write = (name, data) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(data)); return file; };
  runtime = createRuntime({ DEMO_MODE: "false", WIDGETS_FILE: write("widgets.json", config.widgets),
    DEVICE_WIDGETS_FILE: write("devices.json", config.deviceWidgets), DEVICE_METADATA_FILE: write("metadata.json", config.metadata),
    DASHBOARD_DB_FILE: path.join(dir, "dashboard.sqlite"), MIDDLEWARE_URL: "http://127.0.0.1:1",
    MIDDLEWARE_USER: "fixture", MIDDLEWARE_PASSWORD: "fixture-password", DASHBOARD_ADMIN_USER: "admin", DASHBOARD_ADMIN_PASSWORD: "fixture-password",
    DASHBOARD_LOGIN_USER: "viewer", DASHBOARD_LOGIN_PASSWORD: "viewer-password" });
  server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => (await fetch(`${base}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ username, password }) })).headers.get("set-cookie").split(";")[0];
  const cookie = await login("admin", "fixture-password"), viewer = await login("viewer", "viewer-password");
  const post = (route, body, session = cookie) => fetch(base + route, { method: "POST", headers: { cookie: session, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const preview = () => post("/api/admin/organization/preview", {});
  assert.equal((await post("/api/admin/organization/preview", {}, "")).status, 401);
  assert.equal((await post("/api/admin/organization/preview", {}, viewer)).status, 403);
  const before = runtime.database.readConfiguration();
  const plan = await (await preview()).json();
  assert.ok(plan.token, JSON.stringify(plan));
  assert.deepEqual(runtime.database.readConfiguration(), before, "preview does not persist settings");
  const stream = await fetch(`${base}/events`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  const reader = stream.body.getReader();
  await reader.read();
  // Preview again after opening the stream, before applying the selection.
  const current = await (await preview()).json();
  const preFailure = runtime.database.readConfiguration();
  const saveDocument = runtime.database.saveDocument;
  runtime.database.saveDocument = function(name, document) {
    if (name === "devices") throw new Error("simulated disk failure");
    return saveDocument.call(this, name, document);
  };
  try {
    const failed = await post("/api/admin/organization/apply", { token: current.token, scope: current.scope, selectedIds: current.suggestions.map(item => item.id) });
    assert.equal(failed.status, 500);
    assert.deepEqual(runtime.database.readConfiguration(), preFailure);
    assert.equal(runtime.deviceWidgetStore.devices.find(item => item.key === "ES/Zones/Z1/L1")?.room ?? null, null);
  } finally { runtime.database.saveDocument = saveDocument; }
  const response = await post("/api/admin/organization/apply", { token: current.token, scope: current.scope, selectedIds: current.suggestions.map(item => item.id) });
  const applied = await response.json();
  assert.equal(response.status, 200, JSON.stringify(applied));
  let events = "";
  while (!events.includes("event: device-settings")) events += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.equal(runtime.deviceWidgetStore.devices.find(item => item.key === "ES/Zones/Z1/L1").room, "r1");
  assert.deepEqual(runtime.database.readWidgets(), before.widgets);
  const backup = await (await fetch(base + applied.backupUrl, { headers: { cookie } })).json();
  assert.equal(backup.deviceWidgets.devices.find(item => item.key === "ES/Zones/Z1/L1")?.room ?? null, null);
  assert.equal((await fetch(base + applied.backupUrl, { headers: { cookie: viewer } })).status, 403);
  assert.equal((await post("/api/admin/organization/apply", { token: current.token, scope: current.scope, selectedIds: current.suggestions.map(item => item.id) })).status, 409);
  assert.equal((await (await preview()).json()).suggestions.length, 0);
  const importPreview = await (await post("/api/dashboard-transfer/preview", { document: backup })).json();
  const restore = await post("/api/dashboard-transfer/import", { document: backup, token: importPreview.token });
  assert.equal(restore.status, 200, await restore.text());
  assert.equal(runtime.deviceWidgetStore.devices.find(item => item.key === "ES/Zones/Z1/L1")?.room ?? null, null);
});

test("without a stored catalog, preview uses the live rooms that decide access and flags lost access", async t => {
  let runtime, server, upstream;
  const dir = directory(t, async () => {
    runtime?.poller.stop();
    for (const item of [server, upstream]) if (item) await new Promise(resolve => { item.close(resolve); item.closeAllConnections(); });
    runtime?.database.close();
  });
  upstream = require("node:http").createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/containers") {
      const id = url.searchParams.get("id");
      return response.end(JSON.stringify({ containers: [{ id, name: "Z1", description: "Soba A" }], errors: [] }));
    }
    return response.end("{}");
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const write = (name, data) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(data)); return file; };
  runtime = createRuntime({ DEMO_MODE: "false", WIDGETS_FILE: write("widgets.json", [point("ES/Zones/Z1/L1")]),
    DEVICE_WIDGETS_FILE: write("devices.json", { version: 1, organizationVersion: 1, devices: [], rooms: ["rB"], roomRules: [], floors: [],
      roomDetails: [{ id: "rB", name: "Soba B", floorId: null }] }),
    DASHBOARD_DB_FILE: path.join(dir, "dashboard.sqlite"), MIDDLEWARE_URL: `http://127.0.0.1:${upstream.address().port}`,
    MIDDLEWARE_USER: "fixture", MIDDLEWARE_PASSWORD: "fixture-password", DASHBOARD_ADMIN_USER: "admin", DASHBOARD_ADMIN_PASSWORD: "fixture-password",
    DASHBOARD_LOGIN_USER: "viewer", DASHBOARD_LOGIN_PASSWORD: "viewer-password" });
  runtime.poller.setPaused(true);
  assert.equal(runtime.database.readDocument("metadata"), null);
  server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ username: "admin", password: "fixture-password" }) })).headers.get("set-cookie").split(";")[0];
  const post = (route, body) => fetch(base + route, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const { rooms } = await (await fetch(`${base}/api/admin/users`, { headers: { cookie } })).json();
  const roomA = rooms.find(room => room.name === "Soba A")?.id;
  assert.ok(roomA, "room access sees the live room");
  assert.equal((await post("/api/admin/users", { previousUsername: "viewer", username: "viewer", roomIds: [roomA], writeRoomIds: [roomA] })).status, 200);
  const plan = await (await post("/api/admin/organization/preview", { scope: { root: "ES/Zones/Z1", roomId: "rB" } })).json();
  const move = plan.suggestions.find(item => item.key === "ES/Zones/Z1/L1");
  assert.equal(move.from, "Soba A");
  assert.equal(move.review, true);
  assert.deepEqual(move.permissions, [{ username: "viewer", before: { read: true, write: true }, after: { read: false, write: false } }]);
  const applied = await post("/api/admin/organization/apply", { token: plan.token, scope: plan.scope, selectedIds: [move.id] });
  assert.equal(applied.status, 200, await applied.clone().text());
  const backup = await (await fetch(base + (await applied.json()).backupUrl, { headers: { cookie } })).json();
  assert.equal(backup.metadata, null, "the backup keeps the stored configuration");
});

test("applying an organization blocks automatic discovery while it reads room metadata", async t => {
  let runtime, server, upstream, releaseRooms;
  const dir = directory(t, async () => {
    releaseRooms?.();
    runtime?.poller.stop();
    for (const item of [server, upstream]) if (item) await new Promise(resolve => { item.close(resolve); item.closeAllConnections(); });
    runtime?.database.close();
  });
  let roomsRequested;
  const requested = new Promise(resolve => { roomsRequested = resolve; });
  upstream = require("node:http").createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url.startsWith("/api/containers?id=00%2FES%2FZones%2FZ1")) {
      roomsRequested();
      releaseRooms = () => response.end(JSON.stringify({ containers: [{ id: "00/ES/Zones/Z1", name: "Z1", description: "Soba A" }], errors: [] }));
      return;
    }
    return response.end(JSON.stringify({ containers: [], errors: [] }));
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const write = (name, data) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(data)); return file; };
  runtime = createRuntime({ DEMO_MODE: "false", WIDGETS_FILE: write("widgets.json", [point("ES/Zones/Z1/L1")]),
    DEVICE_WIDGETS_FILE: write("devices.json", { version: 1, organizationVersion: 1, devices: [], rooms: [], roomRules: [], floors: [], roomDetails: [] }),
    DASHBOARD_DB_FILE: path.join(dir, "dashboard.sqlite"), MIDDLEWARE_URL: `http://127.0.0.1:${upstream.address().port}`,
    MIDDLEWARE_USER: "fixture", MIDDLEWARE_PASSWORD: "fixture-password", DASHBOARD_ADMIN_USER: "admin", DASHBOARD_ADMIN_PASSWORD: "fixture-password" });
  runtime.poller.setPaused(true);
  server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ username: "admin", password: "fixture-password" }) })).headers.get("set-cookie").split(";")[0];
  const post = (route, body) => fetch(base + route, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const apply = post("/api/admin/organization/apply", { token: "stale", scope: {}, selectedIds: ["stale"] });
  await requested;
  const discovery = await post("/api/discovery/auto", { containerId: "" });
  assert.equal(discovery.status, 409);
  assert.equal((await discovery.json()).code, "TRANSFER_IN_PROGRESS");
  releaseRooms();
  assert.equal((await (await apply).json()).code, "ORGANIZATION_PREVIEW_CHANGED");
});
