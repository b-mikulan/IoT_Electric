const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRuntime } = require("../server");

async function startDashboard(t, env, { sqlite = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
  const { app, poller, database } = createRuntime({
    DEMO_MODE: "true", DASHBOARD_USERS_FILE: path.join(directory, "dashboard-users.json"),
    ...(sqlite && { DASHBOARD_DB_FILE: path.join(directory, "dashboard.sqlite") }), ...env,
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    poller.stop();
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    database?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { request: (pathname, options) => fetch(baseUrl + pathname, { redirect: "manual", ...options }), poller, database };
}

function login(request, username, password) {
  return request("/login", {
    method: "POST",
    body: new URLSearchParams({ username, password }),
  });
}

test("dashboard sign-in protects pages, API, live streams and the admin role", async (t) => {
  const { request } = await startDashboard(t, {
    DASHBOARD_LOGIN_USER: "operator",
    DASHBOARD_LOGIN_PASSWORD: "test-operator",
    DASHBOARD_ADMIN_USER: "admin",
    DASHBOARD_ADMIN_PASSWORD: "test-admin",
  });

  for (const path of ["/", "/index.html", "/technical.html", "/transfer.html", "/admin"]) {
    const response = await request(path);
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.get("location"), "/login", path);
  }
  for (const path of ["/api/config", "/api/dashboard/events", "/events"]) {
    assert.equal((await request(path)).status, 401, path);
  }
  assert.equal((await request("/api/write", { method: "POST" })).status, 401);
  assert.equal((await request("/health")).status, 200);
  assert.match(await (await request("/login")).text(), /<h1>Prijava<\/h1>/);

  const invalid = await login(request, "operator", "incorrect");
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get("set-cookie"), null);

  const operator = await login(request, "operator", "test-operator");
  assert.equal(operator.status, 303);
  assert.equal(operator.headers.get("location"), "/");
  const sessionCookie = operator.headers.get("set-cookie");
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /SameSite=Strict/);
  const user = { headers: { cookie: sessionCookie.split(";")[0] } };
  assert.match(await (await request("/", user)).text(), /PLC vrijednosti uživo/);
  assert.equal((await (await request("/api/config", user)).json()).isAdmin, false);
  for (const path of ["/admin", "/admin.html"]) {
    assert.equal((await request(path, user)).status, 403, path);
  }
  assert.equal((await request("/%61dmin.html", user)).status, 404);
  assert.equal((await request("/logout", {
    method: "POST",
    headers: { ...user.headers, "Sec-Fetch-Site": "same-site" },
  })).status, 403);

  const stream = await request("/events", { ...user, signal: AbortSignal.timeout(3000) });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  const reader = stream.body.getReader();
  const logout = await request("/logout", { ...user, method: "POST" });
  assert.equal(logout.headers.get("location"), "/login");
  let chunk = await reader.read();
  while (!chunk.done) chunk = await reader.read();
  assert.equal((await request("/api/config", user)).status, 401);

  const admin = await login(request, "admin", "test-admin");
  assert.equal(admin.status, 303);
  const adminSession = { headers: { cookie: admin.headers.get("set-cookie").split(";")[0] } };
  const adminPage = await request("/admin", adminSession);
  assert.equal(adminPage.status, 200);
  const adminHtml = await adminPage.text();
  assert.match(adminHtml, /<h1>Administracija<\/h1>/);
  for (const asset of ["admin.css", "adminApi.js", "adminUsers.js", "adminSystem.js", "dashboardSettings.js"]) {
    assert.ok(adminHtml.includes(`/${asset}`));
    const response = await request(`/${asset}`, adminSession);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get("content-type"), asset.endsWith(".css") ? /text\/css/ : /javascript/, asset);
  }
  assert.equal((await (await request("/api/config", adminSession)).json()).isAdmin, true);
});

test("an unconfigured dashboard requires account setup", async (t) => {
  const { request } = await startDashboard(t, {});
  assert.match(await (await request("/login")).text(), /Računi za prijavu još nisu postavljeni/);
  assert.equal((await login(request, "admin", "admin")).status, 503);
  assert.equal((await request("/api/snapshot")).status, 401);
});

function session(response) {
  assert.equal(response.status, 303);
  return { headers: { cookie: response.headers.get("set-cookie").split(";")[0] } };
}

function setupPassword(request, auth, password, confirmation = password) {
  return request("/setup-password", {
    ...auth, method: "POST", body: new URLSearchParams({ password, confirmation }),
  });
}

async function activateUser(request, username, temporary, password) {
  const signedIn = await login(request, username, temporary);
  assert.equal(signedIn.headers.get("location"), "/setup-password");
  const setup = await setupPassword(request, session(signedIn), password);
  assert.equal(setup.headers.get("location"), "/");
  return session(setup);
}

test("first login requires password setup before granting access and persists completion in SQLite", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-password-setup-"));
  try {
    const databaseFile = path.join(directory, "dashboard.sqlite");
    const env = {
      DASHBOARD_ADMIN_USER: "admin", DASHBOARD_ADMIN_PASSWORD: "test-admin", DASHBOARD_DB_FILE: databaseFile,
    };
    const { DashboardDatabase } = require("../lib/storage/dashboardDatabase");
    const { DashboardUsers } = require("../lib/auth/dashboardUsers");
    const { DatabaseSync } = require("node:sqlite");
    const oldDatabase = new DashboardDatabase(databaseFile);
    new DashboardUsers(path.join(directory, "users.json"), {
      ...env, DASHBOARD_LOGIN_USER: "existing", DASHBOARD_LOGIN_PASSWORD: "existing-password",
    }, { database: oldDatabase });
    oldDatabase.close();
    const oldSchema = new DatabaseSync(databaseFile);
    oldSchema.exec(`
      ALTER TABLE dashboard_users DROP COLUMN must_change_password;
      ALTER TABLE dashboard_users DROP COLUMN can_edit_device_settings;
      ALTER TABLE dashboard_room_grants DROP COLUMN can_write;
      PRAGMA user_version = 1;
    `);
    oldSchema.prepare("UPDATE dashboard_users SET all_rooms = 0 WHERE username = ?").run("existing");
    oldSchema.prepare("INSERT INTO dashboard_room_grants VALUES (?, ?)").run("existing", "Existing room");
    oldSchema.close();

    const { request, database } = await startDashboard(t, env);
    assert.deepEqual(database.readUsers()[0].roomIds, ["Existing room"]);
    assert.deepEqual(database.readUsers()[0].writeRoomIds, []);
    assert.equal(database.readUsers()[0].canEditDeviceSettings, false);
    assert.equal((await login(request, "existing", "existing-password")).headers.get("location"), "/");
    const admin = session(await login(request, "admin", "test-admin"));
    const create = await request("/api/admin/users", {
      method: "POST", headers: { ...admin.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ previousUsername: null, username: "new-user", password: "temporary-password", roomIds: [] }),
    });
    assert.equal(create.status, 201);
    assert.equal((await create.json()).user.mustChangePassword, true);
    assert.equal((await setupPassword(request, {}, "personal-password")).headers.get("location"), "/login");

    const signedIn = await login(request, "new-user", "temporary-password");
    assert.equal(signedIn.headers.get("location"), "/setup-password");
    const pending = session(signedIn);
    const secondPending = session(await login(request, "new-user", "temporary-password"));
    assert.match(await (await request("/setup-password", pending)).text(), /Postavi svoju lozinku/);
    for (const url of ["/", "/technical.html", "/admin", "/login"]) {
      assert.equal((await request(url, pending)).headers.get("location"), "/setup-password");
    }
    for (const url of ["/api/config", "/api/snapshot", "/events"]) {
      const blocked = await request(url, pending);
      assert.equal(blocked.status, 403);
      assert.equal((await blocked.json()).code, "PASSWORD_SETUP_REQUIRED");
    }
    assert.equal((await setupPassword(request, pending, "kratko")).status, 400);
    assert.equal((await setupPassword(request, pending, "personal-password", "different-password")).status, 400);
    assert.equal((await setupPassword(request, pending, "temporary-password")).status, 400);
    const completed = await setupPassword(request, pending, "personal-password");
    assert.equal(completed.headers.get("location"), "/");
    const active = session(completed);
    assert.deepEqual((await (await request("/api/config", active)).json()).widgets, []);
    assert.equal((await request("/trends.html", active)).status, 200);
    assert.ok((await (await request("/api/history/catalog", active)).json()).items.length);
    for (const [route, body] of [
      ["/api/history/browse", {}], ["/api/alarms/query", {}],
      ["/api/history/query", { historyItemId: "demo-history", timeFrom: "2026-01-01T00:00:00Z", timeTo: "2026-01-02T00:00:00Z" }],
    ]) {
      const response = await request(route, {
        method: "POST", headers: { ...active.headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, route);
    }
    assert.equal((await request("/api/dashboard/settings", active)).status, 403);
    for (const auth of [pending, secondPending]) {
      assert.equal((await request("/api/config", auth)).status, 401);
    }
    const { request: restarted } = await startDashboard(t, env);
    assert.equal((await login(restarted, "new-user", "temporary-password")).status, 401);
    assert.equal((await login(restarted, "new-user", "personal-password")).headers.get("location"), "/");
  } finally {
    t.after(() => {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      return fs.rm(directory, { recursive: true, force: true });
    });
  }
});

test("SQLite configuration backups are downloadable by the administrator and exclude accounts", async t => {
  const { request, database } = await startDashboard(t, {
    DEMO_MODE: "false", MIDDLEWARE_URL: "http://127.0.0.1:1",
    MIDDLEWARE_USER: "middleware", MIDDLEWARE_PASSWORD: "test-middleware",
    DASHBOARD_ADMIN_USER: "admin", DASHBOARD_ADMIN_PASSWORD: "test-admin",
  }, { sqlite: true });
  const admin = session(await login(request, "admin", "test-admin"));
  const post = (url, body) => request(url, {
    method: "POST", headers: { ...admin.headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const create = await post("/api/admin/users", { previousUsername: null, username: "viewer", password: "test-viewer", roomIds: [] });
  assert.equal(create.status, 201);
  assert.deepEqual(database.readUsers().map(user => user.username), ["viewer"]);
  const viewer = await activateUser(request, "viewer", "test-viewer", "viewer-personal");
  const document = [{ id: "new-widget" }];
  const { token } = await (await post("/api/dashboard-transfer/preview", { document })).json();
  const imported = await post("/api/dashboard-transfer/import", { document, token });
  assert.equal(imported.status, 200);
  const { backupUrl } = await imported.json();
  assert.equal((await request(backupUrl, viewer)).status, 403);
  const backup = await request(backupUrl, admin);
  assert.equal(backup.status, 200);
  const payload = await backup.json();
  assert.deepEqual(payload.widgets, []);
  assert.doesNotMatch(JSON.stringify(payload), /test-viewer|scrypt|username/);
  assert.deepEqual(database.readWidgets().map(widget => widget.id), ["new-widget"]);
});

test("admin manages persistent users and room permissions apply to all dashboard reads", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-room-access-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const widgetsFile = path.join(directory, "widgets.json");
  const usersFile = path.join(directory, "dashboard-users.json");
  const metadataFile = path.join(directory, "catalog-metadata.json");
  const firstZone = "ES/Zones/Z101", secondZone = "ES/Zones/Z201";
  const widgets = [firstZone, secondZone].map((zone, index) => ({
    id: `01/${zone}/S1/Values/RmTmp`, label: `Čitanje ${index + 1}`, value: 22 + index,
  }));
  await fs.writeFile(widgetsFile, JSON.stringify(widgets));
  await fs.writeFile(metadataFile, JSON.stringify({
    schemaVersion: 1, metadataById: Object.fromEntries(widgets.map(widget => [widget.id, { id: widget.id }])),
    roomByZone: { [firstZone]: "Kuhinja · 1. kat", [secondZone]: "Kuhinja · 2. kat" },
  }));
  const env = {
    DEMO_MODE: "false", WIDGETS_FILE: widgetsFile, DEVICE_METADATA_FILE: metadataFile, DASHBOARD_USERS_FILE: usersFile,
    MIDDLEWARE_USER: "middleware", MIDDLEWARE_PASSWORD: "test-middleware",
    DASHBOARD_ADMIN_USER: "admin", DASHBOARD_ADMIN_PASSWORD: "test-admin",
  };
  const { request, poller } = await startDashboard(t, env);
  const admin = session(await login(request, "admin", "test-admin"));
  const list = await (await request("/api/admin/users", admin)).json();
  const rooms = list.rooms.sort((a, b) => a.floor.localeCompare(b.floor));
  assert.deepEqual(rooms.map(room => room.name), ["Kuhinja", "Kuhinja"]);
  assert.notEqual(rooms[0].id, rooms[1].id);
  const post = (url, body, auth = admin) => request(url, {
    method: "POST", headers: { ...auth.headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const createUser = (username, roomIds, canEditDeviceSettings = false) => post("/api/admin/users", {
    previousUsername: null, username, password: "viewer-pass", roomIds, canEditDeviceSettings,
  });
  assert.equal((await createUser("viewer", ["missing"])).status, 400);
  assert.equal((await createUser("viewer", [rooms[0].id])).status, 201);
  assert.equal((await createUser("second", [rooms[1].id], true)).status, 201);
  assert.equal((await createUser("admin", null)).status, 409);

  const viewer = await activateUser(request, "viewer", "viewer-pass", "viewer-personal");
  const second = await activateUser(request, "second", "viewer-pass", "second-personal");
  assert.equal((await request("/api/admin/users", viewer)).status, 403);
  for (const url of ["/api/dashboard-transfer/export", "/api/discovery/auto", "/api/dashboard/events"]) {
    assert.equal((await request(url, viewer)).status, 403, url);
  }
  assert.equal((await post("/api/devices/write", { widgetId: widgets[0].id, value: 1 }, viewer)).status, 403);
  assert.equal((await post("/api/dashboard/refresh", {}, viewer)).status, 403);

  const read = async (url, auth = viewer) => {
    const response = await request(url, auth);
    assert.equal(response.status, 200, url);
    return response.json();
  };
  assert.deepEqual((await read("/api/config")).widgets.map(widget => widget.id), [widgets[0].id]);
  assert.deepEqual((await read("/api/config", second)).widgets.map(widget => widget.id), [widgets[1].id]);
  assert.deepEqual((await read("/api/snapshot")).widgets.map(widget => widget.id), [widgets[0].id]);
  assert.deepEqual((await read("/api/devices/settings")).rooms, [rooms[0].id]);
  assert.deepEqual(Object.keys((await read("/api/devices/metadata")).metadataById), [widgets[0].id]);
  assert.equal((await read("/api/config")).cardSettingsEnabled, false);
  assert.equal((await read("/api/config", second)).cardSettingsEnabled, true);
  const refreshed = [];
  poller.refreshScope = async ids => {
    refreshed.push(ids);
    return { readAt: "2026-01-01T00:00:00Z", pointCount: ids.length, errorCount: 0 };
  };
  for (const target of [{ scope: "device", id: `${firstZone}/S1` }, { scope: "room", id: rooms[0].id }]) {
    assert.equal((await post("/api/dashboard/refresh-scope", target, viewer)).status, 200);
  }
  for (const target of [{ scope: "device", id: `${secondZone}/S1` }, { scope: "room", id: rooms[1].id }]) {
    assert.equal((await post("/api/dashboard/refresh-scope", target, viewer)).status, 404);
  }
  assert.deepEqual(refreshed, [[widgets[0].id], [widgets[0].id]]);
  const card = { key: `${secondZone}/S1`, label: "Uređena kartica", primaryPointId: widgets[1].id, primaryUnit: "°C", secondaryPointIds: [] };
  assert.equal((await post("/api/devices/settings", card, viewer)).status, 403);
  assert.equal((await post("/api/devices/settings", { ...card, key: `${firstZone}/S1` }, second)).status, 403);
  assert.equal((await post("/api/devices/settings", { ...card, room: rooms[0].id }, second)).status, 403);
  assert.equal((await post("/api/devices/settings", { ...card, primaryPointId: widgets[0].id }, second)).status, 400);
  const saved = await post("/api/devices/settings", card, second);
  assert.equal(saved.status, 200);
  const edited = await saved.json();
  assert.equal(edited.device.label, card.label);
  assert.equal(edited.device.room, rooms[1].id);
  assert.deepEqual(edited.rooms, [rooms[1].id]);
  assert.equal((await post("/api/devices/rooms", { keys: [card.key], room: "" }, second)).status, 403);

  const stream = await request("/events", { ...viewer, signal: AbortSignal.timeout(6000) });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let events = "";
  async function readThrough(marker) {
    while (!events.includes(marker)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      events += decoder.decode(chunk.value, { stream: true });
    }
  }
  await readThrough("event: device-settings");
  poller.emit("update", { pointIds: widgets.map(widget => widget.id), widgets });
  await readThrough("event: update");
  assert.ok(events.includes(widgets[0].id));
  assert.ok(!events.includes(widgets[1].id));

  const moved = await post("/api/devices/rooms", { keys: [`${firstZone}/S1`], room: "" });
  assert.equal(moved.status, 200);
  await readThrough("event: dashboard-imported");
  assert.deepEqual((await read("/api/config")).widgets, []);

  const updated = await post("/api/admin/users", {
    previousUsername: "viewer", username: "renamed", password: "updated-pass", roomIds: [rooms[1].id],
  });
  assert.equal(updated.status, 200);
  await readThrough("event: session-ended");
  assert.equal((await request("/api/config", viewer)).status, 401);
  assert.equal((await login(request, "viewer", "viewer-pass")).status, 401);
  const raw = await fs.readFile(usersFile, "utf8");
  assert.match(raw, /scrypt:/);
  assert.doesNotMatch(raw, /viewer-pass|updated-pass|test-admin/);

  const { request: restarted } = await startDashboard(t, env);
  assert.equal((await login(restarted, "renamed", "viewer-pass")).status, 401);
  const restored = await activateUser(restarted, "renamed", "updated-pass", "updated-personal");
  const savedConfig = await (await restarted("/api/config", restored)).json();
  assert.deepEqual(savedConfig.widgets.map(widget => widget.id), [widgets[1].id]);
  const adminAfterRestart = session(await login(restarted, "admin", "test-admin"));
  const deleted = await restarted("/api/admin/users/delete", {
    method: "POST", headers: { ...adminAfterRestart.headers, "Content-Type": "application/json" }, body: JSON.stringify({ username: "renamed" }),
  });
  assert.equal(deleted.status, 204);
  assert.equal((await restarted("/api/config", restored)).status, 401);
  assert.equal((await login(restarted, "renamed", "updated-personal")).status, 401);
});
