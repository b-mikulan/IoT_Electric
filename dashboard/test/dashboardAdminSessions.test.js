const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRuntime } = require("../server");

test("administrator lists safe session summaries and signs a user out of every session", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-admin-sessions-"));
  const { app, poller } = createRuntime({
    DEMO_MODE: "true", DASHBOARD_USERS_FILE: path.join(directory, "users.json"),
    DASHBOARD_ADMIN_USER: "admin", DASHBOARD_ADMIN_PASSWORD: "test-admin",
    DASHBOARD_LOGIN_USER: "operator", DASHBOARD_LOGIN_PASSWORD: "test-operator",
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    poller.stop();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await once(server, "listening");
  const request = (url, options) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { redirect: "manual", ...options });
  const login = async (username, password) => {
    const response = await request("/login", { method: "POST", body: new URLSearchParams({ username, password }) });
    assert.equal(response.status, 303);
    return { headers: { cookie: response.headers.get("set-cookie").split(";")[0] } };
  };
  const post = (url, body, auth = {}) => request(url, {
    method: "POST", headers: { ...auth.headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  assert.equal((await request("/api/admin/sessions")).status, 401);
  assert.equal((await post("/api/admin/users/revoke", { username: "operator" })).status, 401);
  const admin = await login("admin", "test-admin");
  const secondAdmin = await login("admin", "test-admin");
  const operator = await login("operator", "test-operator");
  const secondOperator = await login("operator", "test-operator");
  assert.equal((await request("/api/admin/sessions", operator)).status, 403);
  assert.equal((await post("/api/admin/users/revoke", { username: "operator" }, operator)).status, 403);
  assert.equal((await post("/api/admin/users", {
    previousUsername: null, username: "other", password: "other-password", roomIds: [],
  }, admin)).status, 201);
  const pending = await login("other", "other-password");
  const activated = await request("/setup-password", {
    ...pending, method: "POST",
    body: new URLSearchParams({ password: "other-personal", confirmation: "other-personal" }),
  });
  assert.equal(activated.headers.get("location"), "/");
  const other = { headers: { cookie: activated.headers.get("set-cookie").split(";")[0] } };

  const summaryResponse = await request("/api/admin/sessions", admin);
  assert.equal(summaryResponse.status, 200);
  assert.equal(summaryResponse.headers.get("cache-control"), "no-store");
  const summary = await summaryResponse.json();
  assert.deepEqual(summary, {
    currentUsername: "admin", total: 5,
    sessions: [
      { username: "admin", role: "admin", count: 2, current: true },
      { username: "operator", role: "user", count: 2, current: false },
      { username: "other", role: "user", count: 1, current: false },
    ],
  });
  for (const body of [{}, { username: [] }, { username: " " }]) {
    assert.equal((await post("/api/admin/users/revoke", body, admin)).status, 400);
  }
  assert.equal((await post("/api/admin/users/revoke", { username: "missing" }, admin)).status, 404);
  assert.equal((await post("/api/admin/users/revoke", { username: "admin" }, admin)).status, 403);
  assert.equal((await post("/api/admin/users/revoke", { username: "operator" }, {
    headers: { ...admin.headers, "Sec-Fetch-Site": "same-site" },
  })).status, 403);

  const stream = await request("/events", { ...operator, signal: AbortSignal.timeout(5000) });
  const reader = stream.body.getReader();
  const revoked = await post("/api/admin/users/revoke", { username: "operator" }, admin);
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { revoked: 2 });
  let events = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    events += new TextDecoder().decode(chunk.value);
  }
  assert.match(events, /event: session-ended/);
  for (const auth of [operator, secondOperator]) assert.equal((await request("/api/config", auth)).status, 401);
  for (const auth of [admin, secondAdmin, other]) assert.equal((await request("/api/config", auth)).status, 200);
  assert.equal((await (await request("/api/admin/sessions", admin)).json()).total, 3);
  assert.deepEqual(await (await post("/api/admin/users/revoke", { username: "operator" }, admin)).json(), { revoked: 0 });
  const signedInAgain = await login("operator", "test-operator");
  assert.equal((await request("/api/config", signedInAgain)).status, 200);
});
